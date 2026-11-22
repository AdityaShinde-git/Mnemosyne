import asyncio
from pathlib import Path
from typing import Annotated, Any

import typer
from sqlalchemy import select

from mnemosyne.db.models import Item, Job
from mnemosyne.db.session import SessionFactory
from mnemosyne.schemas import ItemCreate, ItemType, SearchMode
from mnemosyne.services.items import create_item
from mnemosyne.services.search import search_items
from mnemosyne.worker import run_worker

app = typer.Typer(help="Capture and manage your Mnemosyne items.")
ITEM_TYPE_OPTION = typer.Option("note", "--type", help="note, document, bookmark, or decision.")
SEARCH_MODE_OPTION = typer.Option("hybrid", "--mode")


@app.command()
def add(
    content: str = typer.Argument(..., help="Text to capture."),
    title: str | None = typer.Option(None, help="Item title."),
    item_type: ItemType = ITEM_TYPE_OPTION,
    source_uri: str | None = typer.Option(None, help="Optional source URI."),
) -> None:
    """Capture a new item, or report the existing item for duplicate content."""
    data = ItemCreate(
        type=item_type,
        title=title or content[:80],
        content=content,
        source_uri=source_uri,
    )
    item, created = asyncio.run(_create(data))
    state = "Added" if created else "Already captured"
    typer.echo(f"{state}: {item.id} — {item.title}")


async def _create(data: ItemCreate):
    async with SessionFactory() as session:
        return await create_item(session, data)


@app.command()
def search(
    query: str,
    limit: int = typer.Option(10, min=1, max=50),
    mode: SearchMode = SEARCH_MODE_OPTION,
) -> None:
    """Search captured notes using hybrid text and vector retrieval."""
    for item, score, matched_by in asyncio.run(_search(query, limit, mode)):
        typer.echo(f"{score:.4f} [{','.join(matched_by)}] {item.title} ({item.id})")


async def _search(query: str, limit: int, mode: SearchMode):
    async with SessionFactory() as session:
        return await search_items(session, query, limit, mode)


@app.command()
def ingest(source: str) -> None:
    """Queue a local Markdown, text, or PDF file, or a public web URL."""
    asyncio.run(_queue_source(source))


async def _queue_source(source: str) -> None:
    kind: str
    payload: dict[str, Any]
    if source.startswith(("https://", "http://")):
        kind, payload = "ingest_url", {"url": source}
    else:
        path = Path(source).expanduser().resolve(strict=True)
        if not path.is_file():
            raise typer.BadParameter("Source must be a file")
        kind, payload = "ingest_file", {"path": str(path), "mtime_ns": path.stat().st_mtime_ns}
    async with SessionFactory() as session:
        job = Job(kind=kind, payload=payload, status="pending")
        session.add(job)
        await session.commit()
        typer.echo(f"Queued {kind} job {job.id}")


@app.command()
def worker() -> None:
    """Run the background worker and process queued ingestion/indexing jobs."""
    asyncio.run(run_worker())


@app.command()
def reindex() -> None:
    """Queue embedding jobs for every saved item using the configured provider."""
    count = asyncio.run(_queue_reindex())
    typer.echo(f"Queued {count} item(s) for re-indexing")


async def _queue_reindex() -> int:
    async with SessionFactory() as session:
        items = list(await session.scalars(select(Item)))
        active_jobs = await session.scalars(
            select(Job).where(
                Job.kind == "index_item",
                Job.status.in_(("pending", "running")),
            )
        )
        queued_ids = {job.payload.get("item_id") for job in active_jobs}
        queued = 0
        for item in items:
            if str(item.id) not in queued_ids:
                session.add(
                    Job(
                        kind="index_item",
                        payload={"item_id": str(item.id)},
                        status="pending",
                    )
                )
                queued += 1
        await session.commit()
        return queued


@app.command()
def watch(
    folder: Annotated[Path, typer.Argument(exists=True, file_okay=False, dir_okay=True)],
    interval: float = typer.Option(3.0, min=0.5, max=60),
) -> None:
    """Watch a folder and queue changed Markdown, text, and PDF files."""
    asyncio.run(_watch(folder.resolve(), interval))


async def _watch(folder: Path, interval: float) -> None:
    supported = {".md", ".markdown", ".txt", ".pdf"}
    typer.echo(f"Watching {folder}")
    while True:
        async with SessionFactory() as session:
            active_jobs = await session.scalars(
                select(Job).where(
                    Job.status.in_(("pending", "running")),
                    Job.kind == "ingest_file",
                )
            )
            pending_paths = {job.payload.get("path") for job in active_jobs}
            for path in folder.rglob("*"):
                if not path.is_file() or path.suffix.casefold() not in supported:
                    continue
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                resolved = path.resolve()
                source_uri = resolved.as_uri()
                existing = await session.scalar(select(Item).where(Item.source_uri == source_uri))
                if (
                    existing is not None
                    and existing.item_metadata.get("file_mtime_ns") == stat.st_mtime_ns
                ):
                    continue
                resolved_path = str(resolved)
                if resolved_path not in pending_paths:
                    session.add(
                        Job(
                            kind="ingest_file",
                            payload={"path": resolved_path, "mtime_ns": stat.st_mtime_ns},
                            status="pending",
                        )
                    )
                    pending_paths.add(resolved_path)
            await session.commit()
        await asyncio.sleep(interval)
