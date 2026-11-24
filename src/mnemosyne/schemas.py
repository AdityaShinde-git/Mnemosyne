from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ItemType = Literal["note", "document", "bookmark", "decision"]
SearchMode = Literal["hybrid", "text", "vector"]


def _validate_source_uri(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https", "file"}:
        raise ValueError("Source URI must use HTTP, HTTPS, or file")
    if parsed.scheme in {"http", "https"} and not parsed.hostname:
        raise ValueError("Web source URI must include a hostname")
    if parsed.username or parsed.password:
        raise ValueError("Credentials are not allowed in source URIs")
    return value


def _require_text(value: str | None) -> str | None:
    if value is not None and not value.strip():
        raise ValueError("Text cannot be blank")
    return value


class ItemCreate(BaseModel):
    type: ItemType = "note"
    space_id: UUID | None = None
    title: str = Field(min_length=1, max_length=500)
    content: str = Field(min_length=1, max_length=2_000_000)
    source_uri: str | None = Field(default=None, max_length=2048)
    metadata: dict[str, Any] = Field(default_factory=dict)

    _validate_title = field_validator("title")(_require_text)
    _validate_content = field_validator("content")(_require_text)
    _validate_source = field_validator("source_uri")(_validate_source_uri)


class ItemUpdate(BaseModel):
    type: ItemType | None = None
    title: str | None = Field(default=None, min_length=1, max_length=500)
    content: str | None = Field(default=None, min_length=1, max_length=2_000_000)
    source_uri: str | None = Field(default=None, max_length=2048)
    metadata: dict[str, Any] | None = None

    _validate_title = field_validator("title")(_require_text)
    _validate_content = field_validator("content")(_require_text)
    _validate_source = field_validator("source_uri")(_validate_source_uri)

    @model_validator(mode="after")
    def validate_changes(self) -> "ItemUpdate":
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        for field in ("type", "title", "content", "metadata"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class ItemRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    space_id: UUID
    type: ItemType
    title: str
    source_uri: str | None
    content: str
    created_at: datetime
    captured_at: datetime
    updated_at: datetime
    metadata: dict[str, Any] = Field(validation_alias="item_metadata")


class SearchHit(BaseModel):
    item: ItemRead
    score: float
    matched_by: list[str]


class DecisionCreate(BaseModel):
    space_id: UUID | None = None
    question: str = Field(min_length=1, max_length=1000)
    choice: str = Field(min_length=1)
    rationale: str = ""
    revisit_at: datetime | None = None


class DecisionUpdate(BaseModel):
    question: str | None = Field(default=None, min_length=1, max_length=1000)
    choice: str | None = Field(default=None, min_length=1)
    rationale: str | None = None
    status: Literal["active", "completed", "reversed"] | None = None
    outcome: str | None = None
    revisit_at: datetime | None = None

    @model_validator(mode="after")
    def validate_changes(self) -> "DecisionUpdate":
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        for field in ("question", "choice", "rationale", "status"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class DecisionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    item_id: UUID
    question: str
    choice: str
    rationale: str
    status: Literal["active", "completed", "reversed"]
    revisit_at: datetime | None
    outcome: str | None
    created_at: datetime
    updated_at: datetime


class IngestUrl(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    space_id: UUID | None = None


class SpaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)

    _validate_name = field_validator("name")(_require_text)


class SpaceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    created_at: datetime
    item_count: int = 0
    last_activity: datetime | None = None


class GraphDraftRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)

    _validate_content = field_validator("content")(_require_text)


class DraftNode(BaseModel):
    id: str = Field(pattern=r"^n([1-9]|1[0-9]|20)$")
    title: str = Field(min_length=1, max_length=120)
    kind: str = Field(min_length=1, max_length=64)
    description: str = Field(min_length=1, max_length=800)
    evidence: list[str] = Field(min_length=1, max_length=3)

    _validate_title = field_validator("title")(_require_text)
    _validate_kind = field_validator("kind")(_require_text)
    _validate_description = field_validator("description")(_require_text)


class DraftRelationship(BaseModel):
    source: str = Field(min_length=1, max_length=64)
    target: str = Field(min_length=1, max_length=64)
    label: str = Field(max_length=120)
    evidence: str = Field(min_length=1, max_length=240)
    confidence: Literal["high", "medium", "low"]

    _validate_evidence = field_validator("evidence")(_require_text)


class DraftQuestion(BaseModel):
    question: str = Field(min_length=1, max_length=400)
    evidence: str | None = Field(max_length=240)

    _validate_question = field_validator("question")(_require_text)


class GraphDraftResponse(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    nodes: list[DraftNode] = Field(max_length=20)
    relationships: list[DraftRelationship] = Field(max_length=24)
    questions: list[DraftQuestion] = Field(max_length=5)

    _validate_title = field_validator("title")(_require_text)


class GraphDraftResult(GraphDraftResponse):
    model: str


class EdgeUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=120)

    @field_validator("label")
    @classmethod
    def normalize_label(cls, value: str | None) -> str | None:
        if value is None:
            return None
        clean = value.strip()
        return clean or None

    @model_validator(mode="after")
    def validate_changes(self) -> "EdgeUpdate":
        if not self.model_fields_set:
            raise ValueError("At least one field must be provided")
        return self


class JobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    kind: str
    status: Literal["pending", "running", "done", "failed"]
    attempts: int
    run_at: datetime
    last_error: str | None
    created_at: datetime
