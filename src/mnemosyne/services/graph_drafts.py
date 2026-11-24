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


class GraphDraftCountMismatch(GraphDraftError):
    pass


def _normalized_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def _requested_node_minimum(content: str) -> int | None:
    text = content.casefold()
    range_match = re.search(
        r"\b(\d+)\s*(?:-|[\u2013\u2014]|\bto\b)\s*(\d+)\s+nodes?\b",
        text,
    )
    if range_match:
        minimum, maximum = map(int, range_match.groups())
        if minimum > 0 and maximum >= minimum:
            return min(minimum, 20)
        return None
    exact_match = re.search(r"\b(\d+)\s+nodes?\b", text)
    if exact_match:
        return min(int(exact_match.group(1)), 20)
    return None


def _requests_connections(content: str) -> bool:
    return re.search(
        r"\b(?:connect(?:ed|ing)?|connections?|links?|relationships?)\b",
        content.casefold(),
    ) is not None


def _explicitly_names_connection_label(content: str) -> bool:
    text = _normalized_text(content)
    return re.search(
        r"\b(?:label|name|call|use)\b.{0,48}\b(?:connections?|relationships?|links?)\b"
        r"|\b(?:connections?|relationships?|links?)\s+(?:label|name)\b",
        text,
    ) is not None


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


def _validate_requested_quantity(draft: GraphDraftResponse, content: str) -> None:
    minimum_nodes = _requested_node_minimum(content)
    if minimum_nodes is None:
        return

    distinct_nodes = len({_normalized_text(node.title) for node in draft.nodes})
    minimum_connections = minimum_nodes if _requests_connections(content) else 0
    if distinct_nodes >= minimum_nodes and len(draft.relationships) >= minimum_connections:
        return

    returned = []
    if distinct_nodes < minimum_nodes:
        returned.append(f"{distinct_nodes} distinct nodes (at least {minimum_nodes} requested)")
    if len(draft.relationships) < minimum_connections:
        returned.append(
            f"{len(draft.relationships)} connections (at least {minimum_connections} requested)"
        )
    raise GraphDraftCountMismatch(
        f"The model returned fewer than requested: {', '.join(returned)}. Retry the draft."
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
                "Interpret the user's paragraph as natural, possibly tangled speech, not as a "
                "formal specification. Silently handle typos, fragments, repetitions, and "
                "self-corrections. First identify the intended subject/root, any requested node "
                "groups or kinds, relationship meaning, and requested quantity; then draft only "
                "what the paragraph supports. A later explicit correction (for example, 'actually' "
                "or 'I mean') overrides the earlier wording. Separate instructions about how to "
                "organize the graph from facts to put in it. Use the paragraph as the only source "
                "of facts; the space name and existing titles are context, never evidence. The "
                "root note has id 'root'. If the user names its topic, use that as the title; "
                "otherwise give it a short title derived from the paragraph. Extract up to 20 "
                "distinct concepts or entities, assigning ids n1 through n20. Respect an "
                "explicitly requested quantity; for a range, choose a reasonable count within it "
                "(for example, about 15 for '10-20'). When the user explicitly asks for a "
                "brainstorm, list, or counted set from categories but does not name every member, "
                "generate representative, commonly known examples from general knowledge. Make "
                "one node per concrete example, use the category as its type, and describe it as a "
                "proposed example rather than a fact stated in the paragraph. Use the exact source "
                "phrase naming the category as evidence for those suggestions. Do not create "
                "placeholder nodes named after the category (for example, 'names' or 'software "
                "languages'). This invitation to suggest examples applies only when the user "
                "explicitly asks for a brainstorm, list, or quantity; otherwise do not invent "
                "members and ask a concise clarification if the missing members are essential. "
                "For example, interpret a request like 'topic [decision] Mnemosyne, 10-20 nodes "
                "connected to Mnemosyne with the connection about, nodes are names and software "
                "languages' as a map titled 'Mnemosyne' with about 15 concrete proposed examples "
                "such as Python, JavaScript, TypeScript, React, Node.js, MongoDB, Next.js, MySQL, "
                "PHP, VS Code, C++, Git, Linux, Java, and Docker. Connect each example from the "
                "root and leave each connection label empty; do not create separate nodes titled "
                "'decision', 'names', or 'software languages', or a duplicate 'Mnemosyne' topic "
                "node. Treat "
                "bracketed type hints such as '[decision]' as metadata, not as node titles. Do not "
                "turn incidental mentions, ordinary actions, or every noun into nodes. Give each "
                "node a concise, accurate type label based on the paragraph; "
                "use familiar labels such as 'topic', 'concept', 'person', or 'programming "
                "language' when they fit, but do not force a fixed taxonomy. Use 'project' only "
                "for an explicitly described project; a plan or action is usually a topic. A "
                "person mentioned once without a role is not a standalone node. For phrases like "
                "'with Maya', do not infer membership, "
                "ownership, or responsibility; ask what the person's role is and omit that person "
                "node until clarified. Descriptions must be concise and faithful. Evidence must be "
                "the shortest exact phrase copied from the paragraph. Add at most 24 direct "
                "relationships, not every possible pair, and only when clearly stated or strongly "
                "implied. Leave connection labels empty unless the user specifically asks to label "
                "or name a connection. Phrases such as 'connected to' or 'the connection is about' "
                "describe the graph, not its label; do not fill in generic labels such as 'about' "
                "or 'related'. When explicitly requested, use the exact label. Endpoints must "
                "be 'root', a new node id, or an exact existing-node id from the space context. "
                "Prefer reusing a matching existing node. If wording could reasonably mean more "
                "than one thing, ask a concise clarification question and omit the disputed node "
                "or relationship. Return only the requested JSON schema."
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
                        "New nodes use n1 through n20. Existing endpoints use their supplied id."
                    ),
                },
                ensure_ascii=False,
            ),
        },
    ]

    incomplete_draft: GraphDraftCountMismatch | None = None
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
            if incomplete_draft is not None:
                raise GraphDraftError(
                    "The first free model returned too few nodes or connections, and the "
                    "backup model is temporarily rate-limited. Retry shortly."
                ) from error
            raise GraphDraftRateLimited(
                "Both free models are temporarily rate-limited. Retry shortly; "
                "no paid fallback was used."
            ) from error
        except GraphDraftCountMismatch as error:
            if model == OPENROUTER_MODEL:
                incomplete_draft = error
                continue
            if incomplete_draft is not None:
                raise GraphDraftCountMismatch(
                    "Both free models returned fewer nodes or connections than requested. "
                    f"{error}"
                ) from error
            raise
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
    minimum_nodes = _requested_node_minimum(content)
    if minimum_nodes is not None:
        schema["properties"]["nodes"]["minItems"] = minimum_nodes
        if _requests_connections(content):
            schema["properties"]["relationships"]["minItems"] = minimum_nodes
    request_data = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
        "reasoning": {"effort": "none"},
        "max_tokens": 6000,
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

    _validate_requested_quantity(draft, content)
    _validate_draft_evidence(draft, content)
    _validate_relationship_endpoints(draft, existing_node_ids)
    if not _explicitly_names_connection_label(content):
        for relationship in draft.relationships:
            relationship.label = ""
    return draft
