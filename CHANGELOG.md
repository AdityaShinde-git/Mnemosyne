# Changelog

Notable project changes are recorded here. Dates are intentionally omitted until a
release is published.

## Unreleased — MVP

- Added a FastAPI API, `mnemo` CLI, PostgreSQL/pgvector storage, and Alembic migrations.
- Added isolated spaces, note revisions, deduplicated capture, full-text/vector/hybrid
  search, and an asynchronous ingestion/indexing worker.
- Added Markdown, plain-text, PDF, guarded public URL, and polling-folder ingestion.
- Added a zoomable graph UI with saved and suggested connections, notepad-based AI and
  manual map building, a timeline, and a decision log.
- Added local Docker Compose storage, optional Ollama embeddings, optional OpenRouter
  graph drafts, API-key protection, CI, and a small retrieval smoke fixture.
- Documented that the retrieval fixture is not a representative benchmark and that
  production authentication, encryption, and deployment hardening remain future work.
