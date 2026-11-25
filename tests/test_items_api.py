from collections.abc import AsyncIterator
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from mnemosyne.api.app import app
from mnemosyne.db.base import Base
from mnemosyne.db.models import Item  # noqa: F401
from mnemosyne.db.session import get_session
from mnemosyne.schemas import GraphDraftResult


@pytest.fixture
async def client(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[AsyncClient]:
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)

    async def override_session() -> AsyncIterator[AsyncSession]:
        async with session_factory() as session:
            yield session

    monkeypatch.setattr("mnemosyne.worker.SessionFactory", session_factory)
    app.dependency_overrides[get_session] = override_session
    try:
        async with AsyncClient(
            transport=ASGITransport(app=app), base_url="http://test"
        ) as test_client:
            yield test_client
    finally:
        app.dependency_overrides.clear()
        await engine.dispose()


@pytest.mark.asyncio
async def test_item_crud_and_duplicate_capture(client: AsyncClient) -> None:
    payload = {"title": "First note", "content": "remember this", "metadata": {"tag": "work"}}
    created = await client.post("/api/items", json=payload)

    assert created.status_code == 201
    body = created.json()
    assert body["title"] == "First note"
    assert body["metadata"] == {"tag": "work"}

    duplicate = await client.post(
        "/api/items", json={"title": "Different title", "content": "remember this"}
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["id"] == body["id"]

    listing = await client.get("/api/items")
    assert [item["id"] for item in listing.json()] == [body["id"]]

    fetched = await client.get(f"/api/items/{body['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["id"] == body["id"]

    updated = await client.patch(f"/api/items/{body['id']}", json={"title": "Updated note"})
    assert updated.status_code == 200
    assert updated.json()["title"] == "Updated note"
    revisions = await client.get(f"/api/items/{body['id']}/revisions")
    assert [revision["version"] for revision in revisions.json()] == [2, 1]

    deleted = await client.delete(f"/api/items/{body['id']}")
    assert deleted.status_code == 204
    assert (await client.get(f"/api/items/{body['id']}")).status_code == 404


@pytest.mark.asyncio
async def test_missing_item_returns_404(client: AsyncClient) -> None:
    response = await client.get("/api/items/00000000-0000-0000-0000-000000000001")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_manual_links_appear_in_graph_and_are_idempotent(client: AsyncClient) -> None:
    first = await client.post("/api/items", json={"title": "First", "content": "first note"})
    second = await client.post("/api/items", json={"title": "Second", "content": "second note"})
    first_id = first.json()["id"]
    second_id = second.json()["id"]

    linked = await client.post(f"/api/items/{first_id}/links/{second_id}")
    assert linked.status_code == 201
    assert linked.json()["created"] is True

    repeated = await client.post(f"/api/items/{second_id}/links/{first_id}")
    assert repeated.status_code == 200
    assert repeated.json()["created"] is False

    graph = await client.get("/api/graph")
    assert len(graph.json()["edges"]) == 1
    assert graph.json()["edges"][0]["kind"] == "manual"


@pytest.mark.asyncio
async def test_manual_link_rejects_self_and_missing_notes(client: AsyncClient) -> None:
    created = await client.post("/api/items", json={"title": "Only", "content": "one note"})
    item_id = created.json()["id"]

    self_link = await client.post(f"/api/items/{item_id}/links/{item_id}")
    missing = await client.post(f"/api/items/{item_id}/links/{uuid4()}")

    assert self_link.status_code == 400
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_spaces_isolate_nodes_and_named_connections_are_editable(
    client: AsyncClient,
) -> None:
    first = await client.post(
        "/api/items",
        json={"title": "Personal thought", "content": "shared words"},
    )
    personal_space = first.json()["space_id"]
    new_space = await client.post("/api/spaces", json={"name": "Project Atlas"})
    assert new_space.status_code == 201
    project_space = new_space.json()["id"]

    project_item = await client.post(
        f"/api/items?space_id={project_space}",
        json={"title": "Project thought", "content": "shared words"},
    )
    assert project_item.status_code == 201
    assert project_item.json()["id"] != first.json()["id"]

    second = await client.post(
        "/api/items?space_id=" + personal_space,
        json={"title": "Another personal node", "content": "different words"},
    )
    assert second.status_code == 201
    link = await client.post(
        f"/api/items/{first.json()['id']}/links/{second.json()['id']}?space_id={personal_space}&label=inspired%20by"
    )
    assert link.status_code == 201

    personal_graph = await client.get(f"/api/graph?space_id={personal_space}")
    project_graph = await client.get(f"/api/graph?space_id={project_space}")
    assert {node["id"] for node in personal_graph.json()["nodes"]} == {
        first.json()["id"],
        second.json()["id"],
    }
    assert [node["id"] for node in project_graph.json()["nodes"]] == [project_item.json()["id"]]
    assert personal_graph.json()["edges"][0]["label"] == "inspired by"

    cross_space_link = await client.post(
        f"/api/items/{first.json()['id']}/links/{project_item.json()['id']}?space_id={personal_space}"
    )
    assert cross_space_link.status_code == 404

    edited = await client.patch(
        f"/api/items/{first.json()['id']}/links/{second.json()['id']}?space_id={personal_space}",
        json={"label": "supports"},
    )
    assert edited.status_code == 200
    assert edited.json()["label"] == "supports"

    deleted = await client.delete(
        f"/api/items/{first.json()['id']}/links/{second.json()['id']}?space_id={personal_space}"
    )
    assert deleted.status_code == 204
    assert (await client.get(f"/api/graph?space_id={personal_space}")).json()["edges"] == []


@pytest.mark.asyncio
async def test_graph_draft_uses_current_space_context_without_saving(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    space = await client.post("/api/spaces", json={"name": "Atlas"})
    space_id = space.json()["id"]
    existing = await client.post(
        f"/api/items?space_id={space_id}",
        json={"title": "Community garden", "content": "A shared planting project"},
    )
    calls: list[tuple[str, str, list[dict[str, str]]]] = []

    async def fake_create_draft(
        content: str, space_name: str, existing_nodes: list[dict[str, str]]
    ) -> GraphDraftResult:
        calls.append((content, space_name, existing_nodes))
        return GraphDraftResult(
            model="inclusionai/ling-3.2-flash:free",
            title="Garden planning",
            nodes=[],
            relationships=[],
            questions=[],
        )

    monkeypatch.setattr("mnemosyne.api.routes.create_graph_draft", fake_create_draft)

    response = await client.post(
        f"/api/drafts?space_id={space_id}",
        json={"content": "I want to expand the garden."},
    )
    items = await client.get(f"/api/items?space_id={space_id}")
    spaces = await client.get("/api/spaces")
    atlas = next(entry for entry in spaces.json() if entry["id"] == space_id)

    assert response.status_code == 200
    assert response.json()["title"] == "Garden planning"
    assert response.json()["model"] == "inclusionai/ling-3.2-flash:free"
    assert calls == [
        (
            "I want to expand the garden.",
            "Atlas",
            [
                {
                    "id": existing.json()["id"],
                    "title": "Community garden",
                    "type": "note",
                }
            ],
        )
    ]
    assert [item["id"] for item in items.json()] == [existing.json()["id"]]
    assert atlas["item_count"] == 1
    assert atlas["last_activity"] is not None


@pytest.mark.asyncio
async def test_suggested_connections_can_be_accepted_or_dismissed(client: AsyncClient) -> None:
    source = await client.post("/api/items", json={"title": "Source", "content": "source text"})
    target = await client.post("/api/items", json={"title": "Target", "content": "target text"})
    source_id = source.json()["id"]
    target_id = target.json()["id"]

    accepted = await client.patch(
        f"/api/items/{source_id}/links/{target_id}?kind=semantic",
        json={"label": "supports"},
    )
    assert accepted.status_code == 200
    assert accepted.json()["kind"] == "manual"
    assert (await client.get("/api/graph")).json()["edges"][0]["label"] == "supports"

    assert (await client.delete(f"/api/items/{source_id}/links/{target_id}")).status_code == 204
    dismissed = await client.delete(f"/api/items/{source_id}/links/{target_id}?kind=semantic")
    assert dismissed.status_code == 204
    assert (await client.get("/api/graph")).json()["edges"] == []


@pytest.mark.asyncio
async def test_document_upload_is_stored_and_processed(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    documents_dir = tmp_path / "documents"
    monkeypatch.setattr("mnemosyne.api.routes.DOCUMENTS_DIR", documents_dir)
    content = b"# Meeting\nDiscussed the observatory."

    response = await client.post(
        "/api/ingest/file",
        files={
            "file": ("meeting-notes.md", content, "text/markdown")
        },
    )

    assert response.status_code == 202
    job = response.json()
    assert job["kind"] == "ingest_file"
    assert job["status"] == "pending"
    assert not documents_dir.exists()

    from mnemosyne.worker import run_once

    assert await run_once()
    items = (await client.get("/api/items")).json()
    document = next(
        item
        for item in items
        if item["title"] == "meeting-notes" and item["type"] == "document"
    )
    preview = await client.get(f"/api/items/{document['id']}/file")
    assert preview.status_code == 200
    assert preview.content == content
    assert preview.headers["content-type"] == "text/markdown; charset=utf-8"


@pytest.mark.asyncio
async def test_document_upload_rejects_unsupported_file(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    documents_dir = tmp_path / "documents"
    monkeypatch.setattr("mnemosyne.api.routes.DOCUMENTS_DIR", documents_dir)

    response = await client.post(
        "/api/ingest/file",
        files={"file": ("archive.zip", b"not supported", "application/zip")},
    )

    assert response.status_code == 415
    assert not documents_dir.exists()


@pytest.mark.asyncio
async def test_document_preview_only_serves_files_from_documents_directory(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, tmp_path
) -> None:
    documents_dir = tmp_path / "documents"
    documents_dir.mkdir()
    monkeypatch.setattr("mnemosyne.api.routes.DOCUMENTS_DIR", documents_dir)
    stored_file = documents_dir / "preview.pdf"
    stored_file.write_bytes(b"%PDF-1.4 preview")
    outside_file = tmp_path / "outside.pdf"
    outside_file.write_bytes(b"%PDF-1.4 outside")

    item = await client.post(
        "/api/items",
        json={
            "type": "document",
            "title": "Preview",
            "content": "Extracted document text",
            "source_uri": stored_file.as_uri(),
        },
    )
    outside = await client.post(
        "/api/items",
        json={
            "type": "document",
            "title": "Outside",
            "content": "Not served",
            "source_uri": outside_file.as_uri(),
        },
    )

    preview = await client.get(f"/api/items/{item.json()['id']}/file")
    blocked = await client.get(f"/api/items/{outside.json()['id']}/file")

    assert preview.status_code == 200
    assert preview.content == b"%PDF-1.4 preview"
    assert preview.headers["content-disposition"] == "inline"
    assert blocked.status_code == 404


@pytest.mark.asyncio
async def test_web_app_and_timeline_are_served(client: AsyncClient) -> None:
    page = await client.get("/")
    asset = await client.get("/static/styles.css")
    timeline = await client.get("/api/timeline")

    assert page.status_code == 200
    assert "Memory graph" in page.text
    assert asset.status_code == 200
    assert timeline.json() == []


@pytest.mark.asyncio
async def test_database_health_reports_network_errors(client: AsyncClient, monkeypatch) -> None:
    class UnavailableEngine:
        def connect(self) -> None:
            raise OSError("DNS lookup failed")

    monkeypatch.setattr("mnemosyne.api.app.engine", UnavailableEngine())

    response = await client.get("/health/db")

    assert response.status_code == 503
    assert response.json() == {"detail": "Database unavailable"}


@pytest.mark.asyncio
async def test_update_rejects_duplicate_content(client: AsyncClient) -> None:
    first = await client.post("/api/items", json={"title": "One", "content": "first content"})
    second = await client.post("/api/items", json={"title": "Two", "content": "second content"})

    assert first.status_code == 201
    assert second.status_code == 201
    response = await client.patch(
        f"/api/items/{second.json()['id']}", json={"content": "first content"}
    )
    assert response.status_code == 409


@pytest.mark.asyncio
async def test_worker_indexes_notes_and_extracts_wiki_links(client: AsyncClient) -> None:
    source = await client.post(
        "/api/items",
        json={"title": "Field notes", "content": "Observing [[Night sky]]"},
    )
    target = await client.post(
        "/api/items",
        json={"title": "Night sky", "content": "The quartz telescope tracks distant stars"},
    )

    from mnemosyne.worker import run_once

    assert await run_once()
    assert await run_once()

    graph = await client.get("/api/graph")
    assert any(edge["kind"] == "explicit_link" for edge in graph.json()["edges"])
    results = await client.get("/api/search?q=quartz+telescope")
    assert results.status_code == 200
    assert results.json()[0]["item"]["title"] == "Night sky"
    assert set(results.json()[0]["matched_by"]) == {"text", "vector"}
    text_results = await client.get("/api/search?q=quartz+telescope&mode=text")
    assert text_results.json()[0]["matched_by"] == ["text"]

    deleted = await client.delete(
        f"/api/items/{source.json()['id']}/links/{target.json()['id']}?kind=explicit_link"
    )
    assert deleted.status_code == 204
    assert await run_once()
    graph_without_link = await client.get("/api/graph")
    assert not any(edge["kind"] == "explicit_link" for edge in graph_without_link.json()["edges"])
    edited_source = await client.get(f"/api/items/{source.json()['id']}")
    assert "Observing Night sky" in edited_source.json()["content"]


@pytest.mark.asyncio
async def test_decision_log_round_trip(client: AsyncClient) -> None:
    created = await client.post(
        "/api/decisions",
        json={
            "question": "Which database should I use?",
            "choice": "Postgres",
            "rationale": "It supports pgvector and full-text search.",
        },
    )
    assert created.status_code == 201
    decision_id = created.json()["id"]

    updated = await client.patch(
        f"/api/decisions/{decision_id}",
        json={
            "question": "Which database should power the app?",
            "choice": "Postgres with pgvector",
            "rationale": "It supports search and semantic vectors.",
            "status": "completed",
            "outcome": "The migration worked.",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["status"] == "completed"
    assert updated.json()["question"] == "Which database should power the app?"
    decision_item = await client.get(f"/api/items/{updated.json()['item_id']}")
    assert decision_item.json()["title"] == updated.json()["question"]
    assert "Postgres with pgvector" in decision_item.json()["content"]
    assert len((await client.get("/api/decisions?status=completed")).json()) == 1
