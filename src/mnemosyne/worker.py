import asyncio
import logging
import re
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from mnemosyne.config import get_settings
from mnemosyne.db.models import Chunk, Edge, Item, Job
from mnemosyne.db.session import SessionFactory
from mnemosyne.embeddings.providers import DIMENSIONS, get_embedding_provider
from mnemosyne.ingest.chunking import split_text
from mnemosyne.ingest.sources import fetch_url, parse_file
from mnemosyne.schemas import ItemCreate, ItemUpdate
from mnemosyne.services.items import create_item, update_item

logger = logging.getLogger("mnemosyne.worker")
_WIKILINK = re.compile(r"\[\[([^\]]+)\]\]")


async def _claim_job() -> UUID | None:
    now = datetime.now(UTC)
    stale_before = now - timedelta(minutes=5)
    async with SessionFactory() as session:
        statement = (
            select(Job)
            .where(
                or_(
                    and_(Job.status == "pending", Job.run_at <= now),
                    and_(Job.status == "running", Job.locked_at <= stale_before),
                )
            )
            .order_by(Job.run_at, Job.created_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        job = await session.scalar(statement)
        if job is None:
            return None
        job.status = "running"
        job.attempts += 1
        job.locked_at = now
        await session.commit()
        return job.id


async def _index_item(session: AsyncSession, item_id: UUID) -> None:
    item = await session.get(Item, item_id)
    if item is None:
        return
    chunks = list(
        await session.scalars(
            select(Chunk).where(Chunk.item_id == item_id).order_by(Chunk.chunk_index)
        )
    )
    if not chunks:
        for index, chunk_text in enumerate(split_text(item.content)):
            chunk = Chunk(item_id=item_id, chunk_index=index, text=chunk_text)
            session.add(chunk)
            chunks.append(chunk)
        await session.flush()
    if chunks:
        provider = get_embedding_provider()
        embeddings = await provider.embed([chunk.text for chunk in chunks])
        for chunk, embedding in zip(chunks, embeddings, strict=True):
            if len(embedding) != DIMENSIONS:
                raise ValueError(f"Embedding provider must return {DIMENSIONS} values")
            chunk.embedding = embedding
            chunk.embedding_model = provider.model_name

    existing_links = list(
        await session.scalars(
            select(Edge).where(Edge.src_item_id == item_id, Edge.kind == "explicit_link")
        )
    )
    labels = {edge.dst_item_id: edge.label for edge in existing_links}
    await session.execute(
        delete(Edge).where(Edge.src_item_id == item_id, Edge.kind == "explicit_link")
    )
    titles = await session.execute(
        select(Item.id, Item.title).where(Item.space_id == item.space_id)
    )
    by_title = {title.casefold(): other_id for other_id, title in titles}
    for link_title in _WIKILINK.findall(item.content):
        target_id = by_title.get(link_title.strip().casefold())
        if target_id is not None and target_id != item_id:
            session.add(
                Edge(
                    src_item_id=item_id,
                    dst_item_id=target_id,
                    kind="explicit_link",
                    score=1.0,
                    label=labels.get(target_id),
                )
            )


async def _process(session: AsyncSession, job: Job) -> None:
    if job.kind == "index_item":
        await _index_item(session, UUID(job.payload["item_id"]))
    elif job.kind in {"ingest_file", "ingest_url"}:
        if job.kind == "ingest_file":
            title, content, source_uri = parse_file(job.payload["path"])
            if isinstance(job.payload.get("title"), str):
                title = job.payload["title"]
        else:
            title, content, source_uri = await fetch_url(job.payload["url"])
        space_id = UUID(job.payload["space_id"]) if job.payload.get("space_id") else None
        existing_statement = select(Item).where(Item.source_uri == source_uri)
        if space_id is not None:
            existing_statement = existing_statement.where(Item.space_id == space_id)
        existing = await session.scalar(existing_statement)
        if existing is None:
            metadata = {"ingested_by": "worker"}
            if "mtime_ns" in job.payload:
                metadata["file_mtime_ns"] = job.payload["mtime_ns"]
            await create_item(
                session,
                ItemCreate(
                    type="document" if job.kind == "ingest_file" else "bookmark",
                    title=title,
                    content=content,
                    source_uri=source_uri,
                    metadata=metadata,
                    space_id=space_id,
                ),
            )
        else:
            metadata = {**existing.item_metadata, "ingested_by": "worker"}
            if "mtime_ns" in job.payload:
                metadata["file_mtime_ns"] = job.payload["mtime_ns"]
            await update_item(
                session,
                existing.id,
                ItemUpdate(title=title, content=content, metadata=metadata),
            )
    else:
        raise ValueError(f"Unsupported job kind: {job.kind}")


async def run_once() -> bool:
    job_id = await _claim_job()
    if job_id is None:
        return False

    try:
        async with SessionFactory() as session:
            job = await session.get(Job, job_id)
            if job is None:
                return True
            await _process(session, job)
            job.status = "done"
            job.locked_at = None
            job.last_error = None
            job.updated_at = datetime.now(UTC)
            await session.commit()
    except Exception as error:
        logger.error("Job %s failed with %s", job_id, type(error).__name__)
        async with SessionFactory() as session:
            job = await session.get(Job, job_id)
            if job is not None:
                job.locked_at = None
                job.last_error = type(error).__name__
                if job.attempts >= get_settings().job_max_attempts:
                    job.status = "failed"
                else:
                    job.status = "pending"
                    job.run_at = datetime.now(UTC) + timedelta(seconds=min(2**job.attempts, 300))
                await session.commit()
    return True


async def run_worker(poll_seconds: float = 1.0) -> None:
    logger.info("Mnemosyne worker started")
    while True:
        found_job = await run_once()
        if not found_job:
            await asyncio.sleep(poll_seconds)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_worker())
