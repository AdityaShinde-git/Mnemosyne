import json

import pytest

from mnemosyne.config import Settings
from mnemosyne.schemas import DraftNode, GraphDraftResponse, GraphDraftResult
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


def test_graph_draft_schema_supports_twenty_nodes_and_rejects_node_twenty_one() -> None:
    nodes = [
        DraftNode(
            id=f"n{index}",
            title=f"Node {index}",
            kind="topic",
            description=f"Explicitly named node {index}.",
            evidence=[f"Node {index}"],
        )
        for index in range(1, 21)
    ]

    draft = GraphDraftResponse(
        title="Mnemosyne",
        nodes=nodes,
        relationships=[
            {
                "source": "root",
                "target": node.id,
                "label": "about",
                "evidence": node.evidence[0],
                "confidence": "high",
            }
            for node in nodes
        ],
        questions=[],
    )

    assert len(draft.nodes) == 20
    assert len(draft.relationships) == 20

    with pytest.raises(ValueError):
        DraftNode(
            id="n21",
            title="Node 21",
            kind="topic",
            description="Outside the supported range.",
            evidence=["Node 21"],
        )


def test_graph_draft_accepts_custom_node_types_and_rejects_blank_or_oversized_types() -> None:
    node = DraftNode(
        id="n1",
        title="Python",
        kind="programming language",
        description="A programming language.",
        evidence=["Python"],
    )
    assert node.kind == "programming language"

    for kind in (" ", "x" * 65):
        with pytest.raises(ValueError):
            DraftNode(
                id="n1",
                title="Python",
                kind=kind,
                description="A programming language.",
                evidence=["Python"],
            )


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
async def test_graph_draft_accepts_evidence_with_punctuation_and_case_differences(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    formatted_draft = json.loads(json.dumps(VALID_DRAFT))
    formatted_draft["nodes"][0]["evidence"] = ["START — A COMMUNITY, GARDEN!"]
    formatted_draft["relationships"][0]["evidence"] = "start—a community garden"
    FakeAsyncClient.response = FakeResponse(json.dumps(formatted_draft))
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

    assert draft.nodes[0].evidence == ["START — A COMMUNITY, GARDEN!"]


@pytest.mark.asyncio
async def test_graph_draft_expands_counted_software_groups_into_named_examples(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    examples = [
        ("JavaScript", "programming language"),
        ("Python", "programming language"),
        ("TypeScript", "programming language"),
        ("React", "library"),
        ("Node.js", "runtime"),
        ("MongoDB", "database"),
        ("Next.js", "framework"),
        ("MySQL", "database"),
        ("PHP", "programming language"),
        ("VS Code", "developer tool"),
        ("C++", "programming language"),
        ("Git", "version control"),
        ("Linux", "operating system"),
        ("Java", "programming language"),
        ("Docker", "developer tool"),
    ]
    paragraph = (
        "topic [decision] mnemosyne have multiple nodes like 10-20 nodes connected to the "
        "topic mnemosyne and the connection is about and the nodes are just names and "
        "software languages"
    )
    FakeAsyncClient.response = FakeResponse(
        json.dumps(
            {
                "title": "Mnemosyne",
                "nodes": [
                    {
                        "id": f"n{index}",
                        "title": title,
                        "kind": kind,
                        "description": f"Proposed {kind} example related to Mnemosyne.",
                        "evidence": [
                            "software languages"
                            if kind == "programming language"
                            else "names"
                        ],
                    }
                    for index, (title, kind) in enumerate(examples, start=1)
                ],
                "relationships": [
                    {
                        "source": "root",
                        "target": f"n{index}",
                        "label": "about",
                        "evidence": "connected to the topic mnemosyne",
                        "confidence": "medium",
                    }
                    for index in range(1, len(examples) + 1)
                ],
                "questions": [],
            }
        )
    )
    FakeAsyncClient.responses = []
    FakeAsyncClient.requests = []
    monkeypatch.setattr(
        graph_drafts,
        "get_settings",
        lambda: Settings(openrouter_api_key="test-key"),
    )
    monkeypatch.setattr(graph_drafts.httpx, "AsyncClient", FakeAsyncClient)

    draft = await graph_drafts.create_graph_draft(paragraph, "Personal", [])

    assert draft.title == "Mnemosyne"
    assert [node.title for node in draft.nodes] == [title for title, _ in examples]
    assert all(
        relationship.source == "root" and relationship.label == ""
        for relationship in draft.relationships
    )
    schema = FakeAsyncClient.request_data["response_format"]["json_schema"]["schema"]
    assert schema["properties"]["nodes"]["minItems"] == 10
    assert schema["properties"]["relationships"]["minItems"] == 10
    system_prompt = FakeAsyncClient.request_data["messages"][0]["content"].casefold()
    assert "representative, commonly known examples" in system_prompt
    assert "leave each connection label empty" in system_prompt
    assert (
        "do not create separate nodes titled 'decision', 'names', or 'software languages'"
        in system_prompt
    )


@pytest.mark.asyncio
async def test_graph_draft_retries_underfilled_result_with_free_backup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    content = "Make 10-20 nodes connected to Mnemosyne."
    expanded_draft = {
        "title": "Mnemosyne",
        "nodes": [
            {
                "id": f"n{index}",
                "title": f"Example {index}",
                "kind": "software",
                "description": "A proposed software example.",
                "evidence": ["nodes"],
            }
            for index in range(1, 11)
        ],
        "relationships": [
            {
                "source": "root",
                "target": f"n{index}",
                "label": "about",
                "evidence": "connected to Mnemosyne",
                "confidence": "medium",
            }
            for index in range(1, 11)
        ],
        "questions": [],
    }
    FakeAsyncClient.response = FakeResponse(json.dumps(VALID_DRAFT))
    FakeAsyncClient.responses = [
        FakeResponse(json.dumps(VALID_DRAFT)),
        FakeResponse(json.dumps(expanded_draft)),
    ]
    FakeAsyncClient.requests = []
    monkeypatch.setattr(
        graph_drafts,
        "get_settings",
        lambda: Settings(openrouter_api_key="test-key"),
    )
    monkeypatch.setattr(graph_drafts.httpx, "AsyncClient", FakeAsyncClient)

    draft = await graph_drafts.create_graph_draft(content, "Personal", [])

    assert draft.model == graph_drafts.OPENROUTER_FREE_FALLBACK_MODEL
    assert len(draft.nodes) == 10
    assert len(draft.relationships) == 10
    assert all(relationship.label == "" for relationship in draft.relationships)
    assert [request["model"] for request in FakeAsyncClient.requests] == [
        graph_drafts.OPENROUTER_MODEL,
        graph_drafts.OPENROUTER_FREE_FALLBACK_MODEL,
    ]


@pytest.mark.asyncio
async def test_graph_draft_keeps_an_explicitly_named_connection_label(
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
        "I want to start a community garden; name the connection 'describes'.",
        "Personal",
        [],
    )

    assert draft.relationships[0].label == "describes"


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
async def test_graph_draft_retries_unverifiable_evidence_with_free_backup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    invalid_draft = json.loads(json.dumps(VALID_DRAFT))
    invalid_draft["nodes"][0]["evidence"] = ["a thriving garden"]
    FakeAsyncClient.response = FakeResponse(json.dumps(VALID_DRAFT))
    FakeAsyncClient.responses = [
        FakeResponse(json.dumps(invalid_draft)),
        FakeResponse(json.dumps(VALID_DRAFT)),
    ]
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
    assert "contiguous verbatim excerpt" in FakeAsyncClient.requests[1]["messages"][-1]["content"]


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
