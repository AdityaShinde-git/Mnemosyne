import json

import pytest

from mnemosyne.config import Settings
from mnemosyne.schemas import GraphDraftResponse, GraphDraftResult
from mnemosyne.services import graph_drafts
from mnemosyne.services.graph_drafts import (
    GraphDraftError,
    GraphDraftNotConfigured,
    GraphDraftRateLimited,
)

VALID_DRAFT = {
    "title": "Community garden planning",
    "nodes": [
        {
            "id": "n1",
            "title": "Community garden",
            "kind": "project",
            "description": "A project to start a community garden.",
            "evidence": ["start a community garden"],
        }
    ],
    "relationships": [
        {
            "source": "root",
            "target": "n1",
            "label": "describes",
            "evidence": "start a community garden",
            "confidence": "high",
        }
    ],
    "questions": [],
}


class FakeResponse:
    def __init__(
        self, content: object = "", *, status_code: int = 200, error: dict | None = None
    ) -> None:
        self.content = content
        self.status_code = status_code
        self.is_error = status_code >= 400
        self.error = error

    def json(self) -> dict:
        if self.error is not None:
            return {"error": self.error}
        return {"choices": [{"message": {"content": self.content}}]}


class FakeAsyncClient:
    response: FakeResponse
    request_data: dict
    responses: list[FakeResponse] = []
    requests: list[dict] = []

    def __init__(self, *, timeout: int) -> None:
        assert timeout == 60

    async def __aenter__(self) -> "FakeAsyncClient":
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def post(self, *args: object, **kwargs: object) -> FakeResponse:
        FakeAsyncClient.request_data = kwargs["json"]
        FakeAsyncClient.requests.append(kwargs["json"])
        if FakeAsyncClient.responses:
            return FakeAsyncClient.responses.pop(0)
        return self.response


@pytest.mark.asyncio
async def test_graph_draft_requires_openrouter_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(graph_drafts, "get_settings", lambda: Settings(openrouter_api_key=None))

    with pytest.raises(GraphDraftNotConfigured, match="OPENROUTER_API_KEY"):
        await graph_drafts.create_graph_draft("A paragraph.", "Personal", [])


@pytest.mark.asyncio
async def test_graph_draft_checks_evidence_and_relationship_endpoints(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeAsyncClient.response = FakeResponse(json.dumps(VALID_DRAFT))
    FakeAsyncClient.responses = []
    FakeAsyncClient.requests = []
    monkeypatch.setattr(
        graph_drafts,
        "get_settings",
        lambda: Settings(openrouter_api_key="test-key"),
    )
    monkeypatch.setattr(graph_drafts.httpx, "AsyncClient", FakeAsyncClient)

    draft = await graph_drafts.create_graph_draft(
        "I want to start a community garden.",
        "Personal",
        [],
    )

    assert isinstance(draft, GraphDraftResult)
    assert isinstance(draft, GraphDraftResponse)
    assert draft.nodes[0].kind == "project"
    assert draft.model == graph_drafts.OPENROUTER_MODEL
    assert FakeAsyncClient.request_data["model"] == graph_drafts.OPENROUTER_MODEL
    assert FakeAsyncClient.request_data["provider"]["max_price"] == {
        "prompt": 0,
        "completion": 0,
    }
    assert FakeAsyncClient.request_data["provider"]["allow_fallbacks"] is False
    assert FakeAsyncClient.request_data["response_format"]["json_schema"]["strict"] is True
    assert FakeAsyncClient.request_data["reasoning"] == {"effort": "none"}


@pytest.mark.asyncio
async def test_graph_draft_accepts_openrouter_text_content_blocks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeAsyncClient.response = FakeResponse([{"type": "text", "text": json.dumps(VALID_DRAFT)}])
    FakeAsyncClient.responses = []
    FakeAsyncClient.requests = []
    monkeypatch.setattr(
        graph_drafts,
        "get_settings",
        lambda: Settings(openrouter_api_key="test-key"),
    )
    monkeypatch.setattr(graph_drafts.httpx, "AsyncClient", FakeAsyncClient)

    draft = await graph_drafts.create_graph_draft(
        "I want to start a community garden.",
        "Personal",
        [],
    )

    assert draft.title == "Community garden planning"


@pytest.mark.asyncio
async def test_graph_draft_rejects_unverifiable_evidence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invalid_draft = {**VALID_DRAFT, "nodes": [dict(VALID_DRAFT["nodes"][0])]}
    invalid_draft["nodes"][0]["evidence"] = ["create a moon base"]
    FakeAsyncClient.response = FakeResponse(json.dumps(invalid_draft))
    FakeAsyncClient.responses = []
    FakeAsyncClient.requests = []
    monkeypatch.setattr(
        graph_drafts,
        "get_settings",
        lambda: Settings(openrouter_api_key="test-key"),
    )
    monkeypatch.setattr(graph_drafts.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(GraphDraftError, match="evidence"):
        await graph_drafts.create_graph_draft(
            "I want to start a community garden.",
            "Personal",
            [],
        )


@pytest.mark.asyncio
async def test_graph_draft_reports_shared_free_provider_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    FakeAsyncClient.response = FakeResponse(
        status_code=429,
        error={
            "message": "Provider returned error",
            "metadata": {
                "provider_name": "Ant Digital",
                "provider_error_code": "rpm_limit_exceeded",
            },
        },
    )
    FakeAsyncClient.responses = []
    FakeAsyncClient.requests = []
    monkeypatch.setattr(
        graph_drafts,
        "get_settings",
        lambda: Settings(openrouter_api_key="test-key"),
    )
    monkeypatch.setattr(graph_drafts.httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(GraphDraftRateLimited, match="Both free models"):
        await graph_drafts.create_graph_draft("A paragraph.", "Personal", [])
    assert [request["model"] for request in FakeAsyncClient.requests] == [
        graph_drafts.OPENROUTER_MODEL,
        graph_drafts.OPENROUTER_FREE_FALLBACK_MODEL,
    ]
    assert all(
        request["provider"]["max_price"] == {"prompt": 0, "completion": 0}
        and request["provider"]["allow_fallbacks"] is False
        for request in FakeAsyncClient.requests
    )


@pytest.mark.asyncio
async def test_graph_draft_uses_free_backup_when_primary_pool_is_limited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    limited = FakeResponse(
        status_code=429,
        error={
            "message": "Provider returned error",
            "metadata": {
                "provider_name": "Ant Digital",
                "provider_error_code": "rpm_limit_exceeded",
            },
        },
    )
    FakeAsyncClient.responses = [limited, FakeResponse(json.dumps(VALID_DRAFT))]
    FakeAsyncClient.requests = []
    monkeypatch.setattr(
        graph_drafts,
        "get_settings",
        lambda: Settings(openrouter_api_key="test-key"),
    )
    monkeypatch.setattr(graph_drafts.httpx, "AsyncClient", FakeAsyncClient)

    draft = await graph_drafts.create_graph_draft(
        "I want to start a community garden.",
        "Personal",
        [],
    )

    assert draft.model == graph_drafts.OPENROUTER_FREE_FALLBACK_MODEL
    assert [request["model"] for request in FakeAsyncClient.requests] == [
        graph_drafts.OPENROUTER_MODEL,
        graph_drafts.OPENROUTER_FREE_FALLBACK_MODEL,
    ]
