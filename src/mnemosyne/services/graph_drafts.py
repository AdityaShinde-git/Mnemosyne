import json
import re
from typing import Any

import httpx
from pydantic import ValidationError

from mnemosyne.config import get_settings
from mnemosyne.schemas import GraphDraftResponse, GraphDraftResult

OPENROUTER_MODEL = "inclusionai/ling-3.2-flash:free"
OPENROUTER_FREE_FALLBACK_MODEL = "nvidia/nemotron-3.5-super-vl:free"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class GraphDraftError(RuntimeError):
    pass


class GraphDraftNotConfigured(GraphDraftError):
    pass


class GraphDraftRateLimited(GraphDraftError):
    pass


def _normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def _response_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [
            item["text"]
            for item in content
            if isinstance(item, dict)
            and item.get("type") in {"text", "output_text"}
            and isinstance(item.get("text"), str)
        ]
        if parts:
            return "".join(parts)
    raise TypeError("Graph draft content is not text")


def _validate_draft_evidence(draft: GraphDraftResponse, content: str) -> None:
    source = _normalized_text(content)
    evidence = [phrase for node in draft.nodes for phrase in node.evidence]
    evidence.extend(link.evidence for link in draft.relationships)
    evidence.extend(
        question.evidence for question in draft.questions if question.evidence is not None
    )
    if any(_normalized_text(phrase) not in source for phrase in evidence):
        raise GraphDraftError(
            "The model returned evidence that was not in your paragraph. Try again."
        )


def _validate_relationship_endpoints(
    draft: GraphDraftResponse, existing_node_ids: set[str]
) -> None:
    draft_node_ids = [node.id for node in draft.nodes]
    if len(draft_node_ids) != len(set(draft_node_ids)):
        raise GraphDraftError("The model returned duplicate node ids. Try again.")
    valid_ids = {"root", *draft_node_ids, *existing_node_ids}
    for relationship in draft.relationships:
        if (
            relationship.source not in valid_ids
            or relationship.target not in valid_ids
            or relationship.source == relationship.target
        ):
            raise GraphDraftError(
                "The model returned a connection with an unknown endpoint. Try again."
            )


async def create_graph_draft(
    content: str,
    space_name: str,
    existing_nodes: list[dict[str, str]],
) -> GraphDraftResult:
    settings = get_settings()
    if settings.openrouter_api_key is None:
        raise GraphDraftNotConfigured(
            "Add OPENROUTER_API_KEY to your local .env to interpret notes."
        )

    node_context = [
        {"id": node["id"], "title": node["title"], "type": node["type"]}
        for node in existing_nodes[:100]
    ]
    messages = [
        {
            "role": "system",
            "content": (
                "Turn the user's paragraph into a cautious, reviewable knowledge-graph draft. "
                "Use the paragraph as the only source of facts; the space name and existing titles "
                "are context, never evidence. The root note is identified by id 'root'. Give it a "
                "short title derived only from the paragraph. Extract up to 5 distinct concepts "
                "central to the paragraph, assigning ids n1, n2, and so on. Do not turn incidental "
                "mentions, ordinary actions, or every noun into separate nodes. Use kind 'project' "
                "only for an explicitly described project; a plan or action is usually a topic. "
                "A person mentioned once without a role is not a standalone node. For phrases "
                "like 'with Maya', do not infer membership, ownership, or responsibility; ask what "
                "the person's role is and omit that person node until clarified. Descriptions must "
                "be concise and faithful. Evidence must be the shortest exact phrase copied from "
                "the paragraph. Add at most 8 direct relationships, not every possible pair, and "
                "only when clearly stated or strongly implied. Use a short verb phrase and exact "
                "evidence. Endpoints must be 'root', a new node id, or an exact existing-node id "
                "from the space context. Prefer reusing a matching existing node. If wording could "
                "reasonably mean more than one thing, do not guess: ask one concise clarification "
                "question and omit the disputed node or relationship. Return only the requested "
                "JSON schema."
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "space": space_name,
                    "existing_nodes": node_context,
                    "paragraph": content,
                    "node_id_rules": (
                        "New nodes use n1 through n8. Existing endpoints use their supplied id."
                    ),
                },
                ensure_ascii=False,
            ),
        },
    ]

    for model in (OPENROUTER_MODEL, OPENROUTER_FREE_FALLBACK_MODEL):
        try:
            draft = await _request_draft(
                model,
                messages,
                settings.openrouter_api_key.get_secret_value(),
                content,
                {node["id"] for node in existing_nodes},
            )
        except GraphDraftRateLimited as error:
            if model == OPENROUTER_MODEL:
                continue
            raise GraphDraftRateLimited(
                "Both free models are temporarily rate-limited. Retry shortly; "
                "no paid fallback was used."
            ) from error
        return GraphDraftResult(model=model, **draft.model_dump())

    raise GraphDraftRateLimited(
        "Both free models are temporarily rate-limited. Retry shortly; no paid fallback was used."
    )


async def _request_draft(
    model: str,
    messages: list[dict[str, str]],
    api_key: str,
    content: str,
    existing_node_ids: set[str],
) -> GraphDraftResponse:
    schema: dict[str, Any] = GraphDraftResponse.model_json_schema()
    request_data = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "reasoning": {"effort": "none"},
        "max_tokens": 3000,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "mnemosyne_graph_draft",
                "strict": True,
                "schema": schema,
            },
        },
        "provider": {
            "require_parameters": True,
            "allow_fallbacks": False,
            "max_price": {"prompt": 0, "completion": 0},
        },
    }

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            response = await client.post(
                OPENROUTER_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json=request_data,
            )
    except httpx.TimeoutException as error:
        raise GraphDraftError(
            "OpenRouter timed out while interpreting the paragraph. Try again."
        ) from error
    except httpx.RequestError as error:
        raise GraphDraftError(
            "Could not reach OpenRouter. Check your connection and try again."
        ) from error

    if response.is_error:
        detail = "request rejected"
        try:
            body = response.json()
            upstream_error = body.get("error", {})
            metadata = upstream_error.get("metadata", {})
            if metadata.get("provider_error_code") == "rpm_limit_exceeded":
                provider = metadata.get("provider_name", "The free provider")
                raise GraphDraftRateLimited(
                    f"{provider} is temporarily rate-limited by its shared free pool. "
                    "Retry shortly; no paid fallback was used."
                )
            detail = upstream_error.get("message", detail)
        except (ValueError, AttributeError):
            pass
        if response.status_code == 429:
            raise GraphDraftRateLimited(
                "OpenRouter rate-limited the request. Retry shortly; no paid fallback was used."
            )
        raise GraphDraftError(f"OpenRouter returned HTTP {response.status_code}: {detail}")

    try:
        body = response.json()
        raw_draft = _response_text(body["choices"][0]["message"]["content"])
        draft = GraphDraftResponse.model_validate_json(raw_draft)
    except ValidationError as error:
        invalid_fields = sorted(
            {
                ".".join(str(part) for part in issue["loc"])
                for issue in error.errors(include_input=False)
            }
        )
        field_summary = ", ".join(invalid_fields) or "response shape"
        raise GraphDraftError(
            f"OpenRouter returned a draft with invalid fields ({field_summary}). Try again."
        ) from error
    except (ValueError, KeyError, IndexError, TypeError) as error:
        raise GraphDraftError("OpenRouter returned an invalid graph draft. Try again.") from error

    _validate_draft_evidence(draft, content)
    _validate_relationship_endpoints(draft, existing_node_ids)
    return draft
