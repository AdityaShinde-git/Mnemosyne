import asyncio
import json
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from mnemosyne.db.base import Base
from mnemosyne.db.models import Chunk, Item
from mnemosyne.embeddings.providers import get_embedding_provider
from mnemosyne.ingest.chunking import split_text
from mnemosyne.services.items import content_digest
from mnemosyne.services.search import search_items


def recall_at_k(retrieved: list[str], relevant: set[str], k: int) -> float:
    if not relevant:
        return 0.0
    return len(set(retrieved[:k]) & relevant) / len(relevant)


def mean_reciprocal_rank(retrieved: list[str], relevant: set[str]) -> float:
    for rank, title in enumerate(retrieved, start=1):
        if title in relevant:
            return 1 / rank
    return 0.0


async def evaluate() -> dict[str, dict[str, float]]:
    data: dict[str, Any] = json.loads(
        (Path(__file__).with_name("eval_data.json")).read_text(encoding="utf-8")
    )
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    factory = async_sessionmaker(engine, expire_on_commit=False)
    modes = ("text", "vector", "hybrid")
    totals = {mode: {"recall@5": 0.0, "mrr": 0.0} for mode in modes}
    try:
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with factory() as session:
            for record in data["items"]:
                item = Item(
                    type="note",
                    title=record["title"],
                    content=record["content"],
                    content_hash=content_digest(record["content"]),
                    item_metadata={},
                )
                session.add(item)
                await session.flush()
                for index, chunk_text in enumerate(split_text(item.content)):
                    session.add(Chunk(item_id=item.id, chunk_index=index, text=chunk_text))
            await session.flush()
            chunks = list(await session.scalars(select(Chunk)))
            provider = get_embedding_provider()
            vectors = await provider.embed([chunk.text for chunk in chunks])
            for chunk, vector in zip(chunks, vectors, strict=True):
                chunk.embedding = vector
                chunk.embedding_model = provider.model_name
            await session.commit()

            for query_case in data["queries"]:
                relevant = set(query_case["relevant_titles"])
                for mode in modes:
                    hits = await search_items(session, query_case["query"], 5, mode)
                    retrieved = [item.title for item, _, _ in hits]
                    totals[mode]["recall@5"] += recall_at_k(retrieved, relevant, 5)
                    totals[mode]["mrr"] += mean_reciprocal_rank(retrieved, relevant)
    finally:
        await engine.dispose()

    query_count = len(data["queries"])
    return {
        mode: {metric: value / query_count for metric, value in metrics.items()}
        for mode, metrics in totals.items()
    }


def main() -> None:
    results = asyncio.run(evaluate())
    print("Retrieval evaluation (small labelled sample)")
    for mode, metrics in results.items():
        print(f"{mode:>6}: recall@5={metrics['recall@5']:.3f} MRR={metrics['mrr']:.3f}")


if __name__ == "__main__":
    main()
