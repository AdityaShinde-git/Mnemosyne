import mimetypes
import re
from datetime import datetime
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit
from urllib.request import url2pathname
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from mnemosyne.api.auth import require_api_key
from mnemosyne.db.models import Decision, DocumentFile, Edge, Item, ItemRevision, Job, Space
from mnemosyne.db.session import get_session
from mnemosyne.ingest.sources import MAX_SOURCE_BYTES
from mnemosyne.schemas import (
    DecisionCreate,
    DecisionRead,
    DecisionUpdate,
    EdgeUpdate,
    GraphDraftRequest,
    GraphDraftResult,
    IngestUrl,
    ItemCreate,
    ItemRead,
    ItemUpdate,
    JobRead,
    SearchHit,
    SearchMode,
    SpaceCreate,
    SpaceRead,
)
from mnemosyne.services.graph_drafts import (
    GraphDraftError,
    GraphDraftNotConfigured,
    GraphDraftRateLimited,
    create_graph_draft,
)
from mnemosyne.services.items import DEFAULT_SPACE_ID, create_item, resolve_space
from mnemosyne.services.items import update_item as update_note
from mnemosyne.services.memory import (
    create_decision,
    forgotten_connections,
    graph_data,
    list_decisions,
    related_items,
    timeline_data,
    update_decision,
)
from mnemosyne.services.search import search_items

router = APIRouter(prefix="/api", dependencies=[Depends(require_api_key)])
SessionDep = Annotated[AsyncSession, Depends(get_session)]
DOCUMENTS_DIR = Path(__file__).resolve().parents[3] / "documents"
SUPPORTED_DOCUMENT_SUFFIXES = {".md", ".markdown", ".txt", ".pdf"}


async def _active_space(session: AsyncSession, space_id: UUID | None) -> Space:
    try:
        space = await resolve_space(session, space_id)
    except ValueError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    if space_id is None and space.id == DEFAULT_SPACE_ID:
        await session.commit()
    return space


async def _space_item(session: AsyncSession, item_id: UUID, space_id: UUID) -> Item | None:
    return await session.scalar(select(Item).where(Item.id == item_id, Item.space_id == space_id))


@router.get("/spaces", response_model=list[SpaceRead])
async def get_spaces(session: SessionDep) -> list[SpaceRead]:
    await _active_space(session, None)
    item_count = select(func.count(Item.id)).where(Item.space_id == Space.id).scalar_subquery()
    last_activity = (
        select(func.max(Item.updated_at)).where(Item.space_id == Space.id).scalar_subquery()
    )
    rows = await session.execute(
        select(Space, item_count, last_activity).order_by(Space.created_at, Space.name)
    )
    return [
        SpaceRead(
            id=space.id,
            name=space.name,
            created_at=space.created_at,
            item_count=count,
            last_activity=activity,
        )
        for space, count, activity in rows
    ]


@router.post("/spaces", response_model=SpaceRead, status_code=201)
async def add_space(data: SpaceCreate, session: SessionDep) -> Space:
    name = data.name.strip()
    existing = await session.scalar(select(Space).where(func.lower(Space.name) == name.lower()))
    if existing is not None:
        raise HTTPException(status_code=409, detail="A space with that name already exists")
    space = Space(name=name)
    session.add(space)
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise HTTPException(
            status_code=409, detail="A space with that name already exists"
        ) from error
    await session.refresh(space)
    return space


@router.patch("/spaces/{space_id}", response_model=SpaceRead)
async def rename_space(space_id: UUID, data: SpaceCreate, session: SessionDep) -> Space:
    space = await session.get(Space, space_id)
    if space is None:
        raise HTTPException(status_code=404, detail="Space not found")
    name = data.name.strip()
    existing = await session.scalar(
        select(Space).where(func.lower(Space.name) == name.lower(), Space.id != space_id)
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="A space with that name already exists")
    space.name = name
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        raise HTTPException(
            status_code=409, detail="A space with that name already exists"
        ) from error
    await session.refresh(space)
    return space


@router.delete("/spaces/{space_id}", status_code=204)
async def delete_space(space_id: UUID, session: SessionDep) -> Response:
    space = await session.get(Space, space_id)
    if space is None:
        raise HTTPException(status_code=404, detail="Space not found")
    if space_id == DEFAULT_SPACE_ID:
        raise HTTPException(status_code=400, detail="The Personal space cannot be deleted")
    item_count = await session.scalar(
        select(func.count()).select_from(Item).where(Item.space_id == space_id)
    )
    if item_count:
        raise HTTPException(
            status_code=409, detail="Move or delete its nodes before deleting this space"
        )
    await session.delete(space)
    await session.commit()
    return Response(status_code=204)


@router.post("/items", response_model=ItemRead, status_code=201)
async def add_item(
    data: ItemCreate,
    response: Response,
    session: SessionDep,
    space_id: UUID | None = None,
) -> Item:
    space = await _active_space(session, space_id or data.space_id)
    data = data.model_copy(update={"space_id": space.id})
    item, created = await create_item(session, data)
    if not created:
        response.status_code = 200
    return item


@router.get("/items", response_model=list[ItemRead])
async def list_items(
    session: SessionDep,
    space_id: UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[Item]:
    space = await _active_space(session, space_id)
    result = await session.scalars(
        select(Item)
        .where(Item.space_id == space.id)
        .order_by(Item.captured_at.desc(), Item.id)
        .offset(offset)
        .limit(limit)
    )
    return list(result)


@router.get("/items/{item_id}", response_model=ItemRead)
async def get_item(item_id: UUID, session: SessionDep, space_id: UUID | None = None) -> Item:
    space = await _active_space(session, space_id)
    item = await _space_item(session, item_id, space.id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    return item


@router.get("/items/{item_id}/file")
async def get_item_file(
    item_id: UUID, session: SessionDep, space_id: UUID | None = None
) -> Response:
    space = await _active_space(session, space_id)
    item = await _space_item(session, item_id, space.id)
    if item is None or item.type != "document" or not item.source_uri:
        raise HTTPException(status_code=404, detail="Document file not found")
    document_file = await session.get(DocumentFile, item.id)
    if document_file is not None:
        return Response(
            content=document_file.data,
            media_type=document_file.content_type,
            headers={
                "Content-Disposition": "inline",
                "X-Content-Type-Options": "nosniff",
            },
        )
    parsed = urlsplit(item.source_uri)
    if parsed.scheme != "file":
        raise HTTPException(status_code=404, detail="Document file not found")
    try:
        document_path = Path(url2pathname(parsed.path)).resolve(strict=True)
        document_root = DOCUMENTS_DIR.resolve(strict=True)
        document_path.relative_to(document_root)
    except (OSError, ValueError) as error:
        raise HTTPException(status_code=404, detail="Document file not found") from error
    if not document_path.is_file():
        raise HTTPException(status_code=404, detail="Document file not found")
    return FileResponse(
        document_path,
        media_type=mimetypes.guess_type(document_path.name)[0] or "application/octet-stream",
        headers={"Content-Disposition": "inline", "X-Content-Type-Options": "nosniff"},
    )


@router.post("/items/{item_id}/links/{target_item_id}", status_code=201)
async def link_items(
    item_id: UUID,
    target_item_id: UUID,
    response: Response,
    session: SessionDep,
    space_id: UUID | None = None,
    label: Annotated[str | None, Query(max_length=120)] = None,
) -> dict[str, str | bool]:
    if item_id == target_item_id:
        raise HTTPException(status_code=400, detail="A note cannot be linked to itself")
    space = await _active_space(session, space_id)
    if (
        await _space_item(session, item_id, space.id) is None
        or await _space_item(session, target_item_id, space.id) is None
    ):
        raise HTTPException(status_code=404, detail="Item not found")

    source_id, target_id = sorted((item_id, target_item_id), key=lambda value: value.int)
    edge = await session.get(Edge, (source_id, target_id, "manual"))
    if edge is not None:
        response.status_code = 200
        if label is not None:
            edge.label = label.strip() or None
            await session.commit()
        return {"source": str(source_id), "target": str(target_id), "created": False}

    session.add(
        Edge(
            src_item_id=source_id,
            dst_item_id=target_id,
            kind="manual",
            score=1.0,
            label=label.strip() or None if label is not None else None,
        )
    )
    await session.commit()
    return {"source": str(source_id), "target": str(target_id), "created": True}


@router.patch("/items/{item_id}/links/{target_item_id}")
async def patch_link(
    item_id: UUID,
    target_item_id: UUID,
    data: EdgeUpdate,
    session: SessionDep,
    space_id: UUID | None = None,
    kind: Annotated[str, Query(max_length=32)] = "manual",
) -> dict[str, str | None]:
    if item_id == target_item_id:
        raise HTTPException(status_code=400, detail="A node cannot connect to itself")
    space = await _active_space(session, space_id)
    if (
        await _space_item(session, item_id, space.id) is None
        or await _space_item(session, target_item_id, space.id) is None
    ):
        raise HTTPException(status_code=404, detail="Connection not found")
    source_id, target_id = (
        sorted((item_id, target_item_id), key=lambda value: value.int)
        if kind in {"manual", "semantic"}
        else (item_id, target_item_id)
    )
    if kind == "semantic":
        hidden = await session.get(Edge, (source_id, target_id, "suppressed_semantic"))
        if hidden is not None:
            await session.delete(hidden)
        edge = await session.get(Edge, (source_id, target_id, "manual"))
        if edge is None:
            edge = Edge(
                src_item_id=source_id,
                dst_item_id=target_id,
                kind="manual",
                score=1.0,
            )
            session.add(edge)
        edge.label = data.label
        await session.commit()
        return {
            "source": str(source_id),
            "target": str(target_id),
            "kind": "manual",
            "label": edge.label,
        }
    edge = await session.get(Edge, (source_id, target_id, kind))
    if edge is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    edge.label = data.label
    await session.commit()
    return {"source": str(source_id), "target": str(target_id), "kind": kind, "label": edge.label}


@router.delete("/items/{item_id}/links/{target_item_id}", status_code=204)
async def delete_link(
    item_id: UUID,
    target_item_id: UUID,
    session: SessionDep,
    space_id: UUID | None = None,
    kind: Annotated[str, Query(max_length=32)] = "manual",
) -> Response:
    if item_id == target_item_id:
        raise HTTPException(status_code=400, detail="A node cannot connect to itself")
    space = await _active_space(session, space_id)
    if (
        await _space_item(session, item_id, space.id) is None
        or await _space_item(session, target_item_id, space.id) is None
    ):
        raise HTTPException(status_code=404, detail="Connection not found")
    source_id, target_id = (
        sorted((item_id, target_item_id), key=lambda value: value.int)
        if kind in {"manual", "semantic"}
        else (item_id, target_item_id)
    )
    if kind == "semantic":
        hidden = await session.get(Edge, (source_id, target_id, "suppressed_semantic"))
        if hidden is None:
            session.add(
                Edge(
                    src_item_id=source_id,
                    dst_item_id=target_id,
                    kind="suppressed_semantic",
                    score=0.0,
                )
            )
        await session.commit()
        return Response(status_code=204)
    edge = await session.get(Edge, (source_id, target_id, kind))
    if edge is None:
        raise HTTPException(status_code=404, detail="Connection not found")
    await session.delete(edge)
    if kind == "explicit_link":
        source_item = await session.get(Item, source_id)
        target_item = await session.get(Item, target_id)
        if source_item is not None and target_item is not None:
            title_pattern = re.escape(target_item.title)
            content = re.sub(
                rf"\[\[\s*{title_pattern}\s*\]\]",
                target_item.title,
                source_item.content,
                flags=re.IGNORECASE,
            )
            updated_item, updated = await update_note(
                session, source_id, ItemUpdate(content=content)
            )
            if updated_item is None or not updated:
                raise HTTPException(
                    status_code=409,
                    detail="Could not remove the link from the node content",
                )
    await session.commit()
    return Response(status_code=204)


@router.patch("/items/{item_id}", response_model=ItemRead)
async def update_item(
    item_id: UUID, data: ItemUpdate, session: SessionDep, space_id: UUID | None = None
) -> Item:
    space = await _active_space(session, space_id)
    if await _space_item(session, item_id, space.id) is None:
        raise HTTPException(status_code=404, detail="Item not found")
    item, updated = await update_note(session, item_id, data)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    if not updated:
        raise HTTPException(status_code=409, detail="Another item already has this content")
    return item


@router.delete("/items/{item_id}", status_code=204)
async def delete_item(item_id: UUID, session: SessionDep, space_id: UUID | None = None) -> Response:
    space = await _active_space(session, space_id)
    item = await _space_item(session, item_id, space.id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found")
    await session.delete(item)
    await session.commit()
    return Response(status_code=204)


@router.get("/items/{item_id}/revisions")
async def list_revisions(
    item_id: UUID, session: SessionDep, space_id: UUID | None = None
) -> list[dict]:
    space = await _active_space(session, space_id)
    if await _space_item(session, item_id, space.id) is None:
        raise HTTPException(status_code=404, detail="Item not found")
    revisions = await session.scalars(
        select(ItemRevision)
        .where(ItemRevision.item_id == item_id)
        .order_by(ItemRevision.version.desc())
    )
    return [
        {
            "id": str(revision.id),
            "version": revision.version,
            "title": revision.title,
            "content": revision.content,
            "metadata": revision.item_metadata,
            "created_at": revision.created_at,
        }
        for revision in revisions
    ]


@router.get("/search", response_model=list[SearchHit])
async def search(
    session: SessionDep,
    q: Annotated[str, Query(min_length=1, max_length=512)],
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    mode: SearchMode = "hybrid",
    space_id: UUID | None = None,
) -> list[SearchHit]:
    space = await _active_space(session, space_id)
    hits = await search_items(session, q, limit, mode, space.id)
    return [
        SearchHit(item=ItemRead.model_validate(item), score=score, matched_by=matched_by)
        for item, score, matched_by in hits
    ]


@router.get("/graph")
async def get_graph(
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    space_id: UUID | None = None,
) -> dict[str, list[dict]]:
    space = await _active_space(session, space_id)
    return await graph_data(session, limit, space.id)


@router.post("/drafts", response_model=GraphDraftResult)
async def interpret_graph_draft(
    data: GraphDraftRequest,
    session: SessionDep,
    space_id: UUID | None = None,
) -> GraphDraftResult:
    space = await _active_space(session, space_id)
    result = await session.execute(
        select(Item.id, Item.title, Item.type)
        .where(Item.space_id == space.id)
        .order_by(Item.captured_at.desc(), Item.id)
        .limit(100)
    )
    existing_nodes = [
        {"id": str(item_id), "title": title, "type": item_type}
        for item_id, title, item_type in result
    ]
    try:
        return await create_graph_draft(data.content.strip(), space.name, existing_nodes)
    except GraphDraftNotConfigured as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except GraphDraftRateLimited as error:
        raise HTTPException(status_code=429, detail=str(error)) from error
    except GraphDraftError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


@router.get("/timeline")
async def get_timeline(
    session: SessionDep,
    start: datetime | None = None,
    end: datetime | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    space_id: UUID | None = None,
) -> list[dict]:
    space = await _active_space(session, space_id)
    return await timeline_data(session, start, end, limit, space.id)


@router.get("/connections/forgotten")
async def get_forgotten_connections(
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
    min_days: Annotated[int, Query(ge=1, le=3650)] = 30,
    space_id: UUID | None = None,
) -> list[dict]:
    space = await _active_space(session, space_id)
    return await forgotten_connections(session, limit, min_days, space.id)


@router.get("/items/{item_id}/related", response_model=list[SearchHit])
async def get_related_items(
    item_id: UUID,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=20)] = 8,
    space_id: UUID | None = None,
) -> list[SearchHit]:
    space = await _active_space(session, space_id)
    if await _space_item(session, item_id, space.id) is None:
        raise HTTPException(status_code=404, detail="Item not found")
    results = await related_items(session, item_id, limit, space.id)
    return [
        SearchHit(item=ItemRead.model_validate(item), score=score, matched_by=matched_by)
        for item, score, matched_by in results
    ]


@router.post("/ingest/url", response_model=JobRead, status_code=202)
async def ingest_url(data: IngestUrl, session: SessionDep, space_id: UUID | None = None) -> Job:
    space = await _active_space(session, space_id or data.space_id)
    job = Job(
        kind="ingest_url",
        payload={"url": data.url, "space_id": str(space.id)},
        status="pending",
    )
    session.add(job)
    await session.commit()
    await session.refresh(job)
    return job


@router.post("/ingest/file", response_model=JobRead, status_code=202)
async def ingest_file(
    file: Annotated[UploadFile, File()],
    session: SessionDep,
    space_id: UUID | None = None,
) -> Job:
    space = await _active_space(session, space_id)
    if not file.filename:
        raise HTTPException(status_code=400, detail="A filename is required")
    original_name = Path(file.filename).name
    suffix = Path(original_name).suffix.casefold()
    if suffix not in SUPPORTED_DOCUMENT_SUFFIXES:
        raise HTTPException(
            status_code=415,
            detail="Supported file types are Markdown, text, and PDF",
        )

    safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", original_name).strip(" .")[:255]
    if not safe_name:
        safe_name = f"document{suffix}"
    try:
        uploaded_data = bytearray()
        size = 0
        while chunk := await file.read(64 * 1024):
            size += len(chunk)
            if size > MAX_SOURCE_BYTES:
                raise HTTPException(
                    status_code=413,
                    detail="File exceeds the 20 MB upload limit",
                )
            uploaded_data.extend(chunk)
        if size == 0:
            raise HTTPException(status_code=422, detail="The uploaded file is empty")

        job_id = uuid4()
        job = Job(
            id=job_id,
            kind="ingest_file",
            payload={
                "title": Path(safe_name).stem[:500],
                "filename": safe_name,
                "content_type": mimetypes.guess_type(safe_name)[0]
                or "application/octet-stream",
                "space_id": str(space.id),
            },
            source_data=bytes(uploaded_data),
            status="pending",
        )
        session.add(job)
        await session.commit()
        await session.refresh(job)
        return job
    finally:
        await file.close()


@router.get("/jobs/{job_id}", response_model=JobRead)
async def get_job(job_id: UUID, session: SessionDep, space_id: UUID | None = None) -> Job:
    space = await _active_space(session, space_id)
    job = await session.get(Job, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    job_space_id = job.payload.get("space_id")
    if job_space_id is None and job.payload.get("item_id"):
        job_item = await session.get(Item, UUID(job.payload["item_id"]))
        job_space_id = str(job_item.space_id) if job_item is not None else None
    if job_space_id is None:
        job_space_id = str(DEFAULT_SPACE_ID)
    if job_space_id != str(space.id):
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.post("/decisions", response_model=DecisionRead, status_code=201)
async def add_decision(
    data: DecisionCreate, session: SessionDep, space_id: UUID | None = None
) -> Decision:
    space = await _active_space(session, space_id or data.space_id)
    data = data.model_copy(update={"space_id": space.id})
    return await create_decision(session, data)


@router.get("/decisions", response_model=list[DecisionRead])
async def get_decisions(
    session: SessionDep,
    status: Annotated[str | None, Query(pattern="^(active|completed|reversed)$")] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
    space_id: UUID | None = None,
) -> list[Decision]:
    space = await _active_space(session, space_id)
    return await list_decisions(session, status, limit, space.id)


@router.patch("/decisions/{decision_id}", response_model=DecisionRead)
async def patch_decision(
    decision_id: UUID,
    data: DecisionUpdate,
    session: SessionDep,
    space_id: UUID | None = None,
) -> Decision:
    space = await _active_space(session, space_id)
    decision = await session.scalar(
        select(Decision)
        .join(Item, Decision.item_id == Item.id)
        .where(Decision.id == decision_id, Item.space_id == space.id)
    )
    if decision is None:
        raise HTTPException(status_code=404, detail="Decision not found")
    try:
        decision = await update_decision(session, decision_id, data)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if decision is None:
        raise HTTPException(status_code=404, detail="Decision not found")
    return decision
