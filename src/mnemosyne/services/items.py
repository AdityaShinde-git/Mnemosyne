import hashlib
from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from mnemosyne.db.models import Chunk, Item, ItemRevision, Job, Space
from mnemosyne.ingest.chunking import split_text
from mnemosyne.schemas import ItemCreate, ItemUpdate

DEFAULT_SPACE_ID = UUID("00000000-0000-0000-0000-000000000001")


def content_digest(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def add_chunks(session: AsyncSession, item_id: UUID, content: str) -> None:
    for index, chunk_text in enumerate(split_text(content)):
        session.add(Chunk(item_id=item_id, chunk_index=index, text=chunk_text))


def enqueue_index_job(session: AsyncSession, item_id: UUID) -> None:
    session.add(
        Job(
            id=uuid4(),
            kind="index_item",
            payload={"item_id": str(item_id)},
            status="pending",
        )
    )


async def resolve_space(session: AsyncSession, space_id: UUID | None = None) -> Space:
    if space_id is not None:
        space = await session.get(Space, space_id)
        if space is None:
            raise ValueError("Space not found")
        return space

    space = await session.get(Space, DEFAULT_SPACE_ID)
    if space is None:
        space = Space(id=DEFAULT_SPACE_ID, name="Personal")
        session.add(space)
        await session.flush()
    return space


async def create_item(session: AsyncSession, data: ItemCreate) -> tuple[Item, bool]:
    space = await resolve_space(session, data.space_id)
    content_hash = content_digest(data.content)
    existing = await session.scalar(
        select(Item).where(Item.content_hash == content_hash, Item.space_id == space.id)
    )
    if existing is not None:
        return existing, False

    item = Item(
        space_id=space.id,
        type=data.type,
        title=data.title,
        source_uri=data.source_uri,
        content=data.content,
        content_hash=content_hash,
        item_metadata=data.metadata,
    )
    session.add(item)
    await session.flush()
    session.add(
        ItemRevision(
            item_id=item.id,
            version=1,
            title=item.title,
            content=item.content,
            item_metadata=item.item_metadata,
        )
    )
    add_chunks(session, item.id, item.content)
    enqueue_index_job(session, item.id)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        existing = await session.scalar(
            select(Item).where(Item.content_hash == content_hash, Item.space_id == space.id)
        )
        if existing is None:
            raise
        return existing, False
    await session.refresh(item)
    return item, True


async def update_item(
    session: AsyncSession, item_id: UUID, data: ItemUpdate, commit: bool = True
) -> tuple[Item | None, bool]:
    item = await session.get(Item, item_id)
    if item is None:
        return None, False

    changes = data.model_dump(exclude_unset=True)
    changed_content = "content" in changes and changes["content"] != item.content
    if changed_content:
        new_hash = content_digest(changes["content"])
        duplicate = await session.scalar(
            select(Item.id).where(
                Item.content_hash == new_hash,
                Item.id != item_id,
                Item.space_id == item.space_id,
            )
        )
        if duplicate is not None:
            return item, False
        item.content_hash = new_hash

    for field, value in changes.items():
        setattr(item, "item_metadata" if field == "metadata" else field, value)
    item.updated_at = datetime.now(UTC)

    version = await session.scalar(
        select(func.max(ItemRevision.version)).where(ItemRevision.item_id == item_id)
    )
    session.add(
        ItemRevision(
            item_id=item.id,
            version=(version or 0) + 1,
            title=item.title,
            content=item.content,
            item_metadata=item.item_metadata,
        )
    )
    if changed_content:
        await session.execute(delete(Chunk).where(Chunk.item_id == item_id))
        add_chunks(session, item.id, item.content)
        enqueue_index_job(session, item.id)

    if commit:
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            return item, False
        await session.refresh(item)
    return item, True
