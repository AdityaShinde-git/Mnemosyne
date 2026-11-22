import math
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from mnemosyne.db.models import Chunk, Decision, Edge, Item
from mnemosyne.embeddings.providers import get_embedding_provider
from mnemosyne.schemas import DecisionCreate, DecisionUpdate, ItemCreate, ItemUpdate
from mnemosyne.services.items import create_item, update_item
from mnemosyne.services.search import search_items


async def graph_data(
    session: AsyncSession, limit: int = 200, space_id: UUID | None = None
) -> dict[str, list[dict]]:
    statement = select(Item)
    if space_id is not None:
        statement = statement.where(Item.space_id == space_id)
    items = list(await session.scalars(statement.order_by(Item.captured_at.desc()).limit(limit)))
    item_ids = [item.id for item in items]
    if not item_ids:
        return {"nodes": [], "edges": []}

    stored_edges = list(
        await session.scalars(
            select(Edge).where(Edge.src_item_id.in_(item_ids), Edge.dst_item_id.in_(item_ids))
        )
    )
    edges = [edge for edge in stored_edges if edge.kind != "suppressed_semantic"]
    existing = {(edge.src_item_id, edge.dst_item_id) for edge in stored_edges} | {
        (edge.dst_item_id, edge.src_item_id) for edge in stored_edges
    }
    vector_rows = await session.execute(
        select(Chunk.item_id, Chunk.embedding).where(
            Chunk.item_id.in_(item_ids),
            Chunk.embedding.is_not(None),
            Chunk.embedding_model == get_embedding_provider().model_name,
        )
    )
    vectors: dict[UUID, list[list[float]]] = {}
    for item_id, vector in vector_rows:
        if vector is not None:
            vectors.setdefault(item_id, []).append(vector)
    centers = {
        item_id: [
            sum(vector[index] for vector in item_vectors) / len(item_vectors)
            for index in range(len(item_vectors[0]))
        ]
        for item_id, item_vectors in vectors.items()
    }
    similarities: list[tuple[UUID, UUID, float]] = []
    vector_ids = list(centers)
    for index, left_id in enumerate(vector_ids):
        for right_id in vector_ids[index + 1 :]:
            if (left_id, right_id) in existing:
                continue
            score = _cosine(centers[left_id], centers[right_id])
            if score >= 0.3:
                similarities.append((left_id, right_id, score))
    similarities.sort(key=lambda link: link[2], reverse=True)
    degree: dict[UUID, int] = {}
    semantic_edges = []
    for left_id, right_id, score in similarities:
        if degree.get(left_id, 0) >= 3 or degree.get(right_id, 0) >= 3:
            continue
        semantic_edges.append(
            {
                "source": str(left_id),
                "target": str(right_id),
                "kind": "semantic",
                "score": round(score, 4),
            }
        )
        degree[left_id] = degree.get(left_id, 0) + 1
        degree[right_id] = degree.get(right_id, 0) + 1
    return {
        "nodes": [
            {
                "id": str(item.id),
                "title": item.title,
                "type": item.type,
                "captured_at": item.captured_at.isoformat(),
                "excerpt": item.content[:180],
            }
            for item in items
        ],
        "edges": [
            {
                "source": str(edge.src_item_id),
                "target": str(edge.dst_item_id),
                "kind": edge.kind,
                "score": edge.score,
                "label": edge.label,
            }
            for edge in edges
        ]
        + semantic_edges,
    }


async def timeline_data(
    session: AsyncSession,
    start: datetime | None = None,
    end: datetime | None = None,
    limit: int = 100,
    space_id: UUID | None = None,
) -> list[dict]:
    statement = select(Item)
    if space_id is not None:
        statement = statement.where(Item.space_id == space_id)
    if start is not None:
        statement = statement.where(Item.captured_at >= start)
    if end is not None:
        statement = statement.where(Item.captured_at < end)
    items = list(await session.scalars(statement.order_by(Item.captured_at.desc()).limit(limit)))
    return [
        {
            "id": str(item.id),
            "title": item.title,
            "type": item.type,
            "captured_at": item.captured_at.isoformat(),
            "excerpt": item.content[:220],
        }
        for item in items
    ]


def _cosine(left: list[float], right: list[float]) -> float:
    denominator = math.sqrt(sum(x * x for x in left) * sum(y * y for y in right))
    if not denominator:
        return 0
    return sum(x * y for x, y in zip(left, right, strict=True)) / denominator


def _as_utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


async def forgotten_connections(
    session: AsyncSession, limit: int = 20, min_days: int = 30, space_id: UUID | None = None
) -> list[dict]:
    statement = (
        select(Item, Chunk.embedding)
        .join(Chunk, Chunk.item_id == Item.id)
        .where(
            Chunk.embedding.is_not(None),
            Chunk.embedding_model == get_embedding_provider().model_name,
        )
    )
    if space_id is not None:
        statement = statement.where(Item.space_id == space_id)
    rows = await session.execute(statement.order_by(Item.captured_at.desc()).limit(1000))
    vectors: dict[UUID, tuple[Item, list[list[float]]]] = {}
    for item, vector in rows:
        if vector is not None:
            vectors.setdefault(item.id, (item, []))[1].append(vector)

    ids = list(vectors)
    if len(ids) < 2:
        return []
    links = await session.execute(select(Edge.src_item_id, Edge.dst_item_id))
    existing = {(left, right) for left, right in links}
    existing |= {(right, left) for left, right in existing}
    candidates: list[dict] = []
    for index, left_id in enumerate(ids):
        left_item, left_chunks = vectors[left_id]
        left_vector = [
            sum(vector[i] for vector in left_chunks) / len(left_chunks)
            for i in range(len(left_chunks[0]))
        ]
        for right_id in ids[index + 1 :]:
            if (left_id, right_id) in existing:
                continue
            right_item, right_chunks = vectors[right_id]
            days = abs((_as_utc(left_item.captured_at) - _as_utc(right_item.captured_at)).days)
            if days < min_days:
                continue
            right_vector = [
                sum(vector[i] for vector in right_chunks) / len(right_chunks)
                for i in range(len(right_chunks[0]))
            ]
            similarity = _cosine(left_vector, right_vector)
            if similarity < 0.25:
                continue
            earlier_id, earlier_item, later_id, later_item = (
                (left_id, left_item, right_id, right_item)
                if left_item.captured_at <= right_item.captured_at
                else (right_id, right_item, left_id, left_item)
            )
            candidates.append(
                {
                    "left": {"id": str(earlier_id), "title": earlier_item.title},
                    "right": {"id": str(later_id), "title": later_item.title},
                    "similarity": round(similarity, 4),
                    "days_apart": days,
                    "explanation": (
                        f"These notes share related language and were captured "
                        f"{days} days apart, with no existing link."
                    ),
                }
            )
    candidates.sort(
        key=lambda pair: pair["similarity"] * math.log1p(pair["days_apart"]), reverse=True
    )
    return candidates[:limit]


async def related_items(
    session: AsyncSession, item_id: UUID, limit: int = 8, space_id: UUID | None = None
) -> list[tuple[Item, float, list[str]]]:
    item = await session.get(Item, item_id)
    if item is None or (space_id is not None and item.space_id != space_id):
        return []
    query = f"{item.title}\n{item.content[:2000]}"
    results = await search_items(session, query, limit + 1, space_id=space_id)
    return [result for result in results if result[0].id != item_id][:limit]


async def create_decision(session: AsyncSession, data: DecisionCreate) -> Decision:
    content = f"Question: {data.question}\nChoice: {data.choice}\nRationale: {data.rationale}"
    item, _ = await create_item(
        session,
        ItemCreate(
            type="decision",
            title=data.question,
            content=content,
            space_id=data.space_id,
        ),
    )
    decision = Decision(
        item_id=item.id,
        question=data.question,
        choice=data.choice,
        rationale=data.rationale,
        status="active",
        revisit_at=data.revisit_at,
    )
    session.add(decision)
    await session.commit()
    await session.refresh(decision)
    return decision


async def update_decision(
    session: AsyncSession, decision_id: UUID, data: DecisionUpdate
) -> Decision | None:
    decision = await session.get(Decision, decision_id)
    if decision is None:
        return None
    changes = data.model_dump(exclude_unset=True)
    if {"question", "choice", "rationale"} & changes.keys():
        item = await session.get(Item, decision.item_id)
        if item is None:
            return None
        question = changes.get("question", decision.question)
        choice = changes.get("choice", decision.choice)
        rationale = changes.get("rationale", decision.rationale)
        updated_item, updated = await update_item(
            session,
            item.id,
            ItemUpdate(
                title=question,
                content=f"Question: {question}\nChoice: {choice}\nRationale: {rationale}",
            ),
            commit=False,
        )
        if updated_item is None or not updated:
            raise ValueError("Another node already has this content")
    for field, value in changes.items():
        setattr(decision, field, value)
    decision.updated_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(decision)
    return decision


async def list_decisions(
    session: AsyncSession,
    status: str | None = None,
    limit: int = 100,
    space_id: UUID | None = None,
) -> list[Decision]:
    statement = (
        select(Decision)
        .join(Item, Decision.item_id == Item.id)
        .order_by(Decision.created_at.desc())
        .limit(limit)
    )
    if space_id is not None:
        statement = statement.where(Item.space_id == space_id)
    if status is not None:
        statement = statement.where(Decision.status == status)
    return list(await session.scalars(statement))
