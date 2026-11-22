import math
import re
from collections import Counter, defaultdict
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from mnemosyne.db.models import Chunk, Item
from mnemosyne.embeddings.providers import get_embedding_provider

_TOKEN = re.compile(r"\w+", re.UNICODE)
_RRF_K = 60


def _tokens(text: str) -> list[str]:
    return [token.casefold() for token in _TOKEN.findall(text)]


def _cosine(left: list[float], right: list[float]) -> float:
    denominator = math.sqrt(sum(x * x for x in left) * sum(y * y for y in right))
    return sum(x * y for x, y in zip(left, right, strict=True)) / denominator if denominator else 0


async def _lexical_ranks(
    session: AsyncSession, query: str, limit: int, space_id: UUID | None
) -> list[UUID]:
    if session.bind is not None and session.bind.dialect.name == "postgresql":
        ts_query = func.plainto_tsquery("english", query)
        document = func.to_tsvector("english", Chunk.text)
        chunk_result = await session.execute(
            select(Item.id, func.max(func.ts_rank_cd(document, ts_query)).label("rank"))
            .join(Chunk, Chunk.item_id == Item.id)
            .where(
                document.op("@@")(ts_query),
                *([Item.space_id == space_id] if space_id is not None else []),
            )
            .group_by(Item.id)
            .order_by(func.max(func.ts_rank_cd(document, ts_query)).desc())
            .limit(limit)
        )
        title_document = func.to_tsvector("english", Item.title)
        title_result = await session.execute(
            select(Item.id, func.ts_rank_cd(title_document, ts_query).label("rank"))
            .where(
                title_document.op("@@")(ts_query),
                *([Item.space_id == space_id] if space_id is not None else []),
            )
            .order_by(func.ts_rank_cd(title_document, ts_query).desc())
            .limit(limit)
        )
        merged: dict[UUID, float] = {}
        for item_id, score in list(chunk_result) + list(title_result):
            merged[item_id] = max(merged.get(item_id, 0), float(score))
        return [
            item_id
            for item_id, _ in sorted(merged.items(), key=lambda entry: entry[1], reverse=True)[
                :limit
            ]
        ]

    item_statement = select(Item)
    if space_id is not None:
        item_statement = item_statement.where(Item.space_id == space_id)
    items = list(await session.scalars(item_statement))
    item_ids = [item.id for item in items]
    chunks = (
        list(await session.scalars(select(Chunk).where(Chunk.item_id.in_(item_ids))))
        if item_ids
        else []
    )
    content_by_item: dict[UUID, list[str]] = defaultdict(list)
    for chunk in chunks:
        content_by_item[chunk.item_id].append(chunk.text)
    query_counts = Counter(_tokens(query))
    ranked: list[tuple[UUID, float]] = []
    for item in items:
        content_counts = Counter(_tokens(f"{item.title} {' '.join(content_by_item[item.id])}"))
        overlap = sum(min(count, content_counts[token]) for token, count in query_counts.items())
        if overlap:
            length_norm = math.sqrt(max(sum(content_counts.values()), 1))
            ranked.append((item.id, overlap / length_norm))
    ranked.sort(key=lambda entry: entry[1], reverse=True)
    return [item_id for item_id, _ in ranked[:limit]]


async def _vector_ranks(
    session: AsyncSession,
    query_embedding: list[float],
    limit: int,
    model_name: str,
    space_id: UUID | None,
) -> list[UUID]:
    if session.bind is not None and session.bind.dialect.name == "postgresql":
        distance = Chunk.embedding.cosine_distance(query_embedding)
        statement = (
            select(Chunk.item_id, distance.label("distance"))
            .join(Item, Item.id == Chunk.item_id)
            .where(
                Chunk.embedding.is_not(None),
                Chunk.embedding_model == model_name,
            )
        )
        if space_id is not None:
            statement = statement.where(Item.space_id == space_id)
        result = await session.execute(statement.order_by(distance).limit(min(limit * 10, 1000)))
        ranked: list[UUID] = []
        seen: set[UUID] = set()
        for item_id, _ in result:
            if item_id not in seen:
                ranked.append(item_id)
                seen.add(item_id)
                if len(ranked) == limit:
                    break
        return ranked

    statement = select(Chunk).where(
        Chunk.embedding.is_not(None), Chunk.embedding_model == model_name
    )
    if space_id is not None:
        statement = statement.join(Item, Item.id == Chunk.item_id).where(Item.space_id == space_id)
    chunks = list(await session.scalars(statement))
    best: dict[UUID, float] = {}
    for chunk in chunks:
        assert chunk.embedding is not None
        score = _cosine(query_embedding, chunk.embedding)
        best[chunk.item_id] = max(best.get(chunk.item_id, -1.0), score)
    return [
        item_id
        for item_id, _ in sorted(best.items(), key=lambda entry: entry[1], reverse=True)[:limit]
    ]


async def search_items(
    session: AsyncSession,
    query: str,
    limit: int = 20,
    mode: str = "hybrid",
    space_id: UUID | None = None,
) -> list[tuple[Item, float, list[str]]]:
    clean_query = query.strip()
    if not clean_query:
        return []
    if mode not in {"hybrid", "text", "vector"}:
        raise ValueError("Search mode must be hybrid, text, or vector")

    candidate_limit = min(max(limit * 4, 20), 100)
    lexical = (
        await _lexical_ranks(session, clean_query, candidate_limit, space_id)
        if mode in {"hybrid", "text"}
        else []
    )
    semantic: list[UUID] = []
    if mode in {"hybrid", "vector"}:
        provider = get_embedding_provider()
        query_embedding = (await provider.embed([clean_query]))[0]
        semantic = await _vector_ranks(
            session, query_embedding, candidate_limit, provider.model_name, space_id
        )

    scores: dict[UUID, float] = defaultdict(float)
    sources: dict[UUID, list[str]] = defaultdict(list)
    for source, ranked_ids in (("text", lexical), ("vector", semantic)):
        for rank, item_id in enumerate(ranked_ids, start=1):
            scores[item_id] += 1 / (_RRF_K + rank) if mode == "hybrid" else 1 / rank
            sources[item_id].append(source)

    if not scores:
        return []
    item_statement = select(Item).where(Item.id.in_(scores))
    if space_id is not None:
        item_statement = item_statement.where(Item.space_id == space_id)
    items = await session.scalars(item_statement)
    item_by_id = {item.id: item for item in items}
    ordered = sorted(scores, key=lambda item_id: scores[item_id], reverse=True)[:limit]
    return [
        (item_by_id[item_id], scores[item_id], sources[item_id])
        for item_id in ordered
        if item_id in item_by_id
    ]
