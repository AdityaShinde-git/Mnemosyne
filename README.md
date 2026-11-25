# Mnemosyne

**A local-first knowledge workspace for capturing, connecting, and revisiting what you learn.**

Mnemosyne turns notes, decisions, and documents into searchable items in a navigable
knowledge graph. Its focus is preserving context and relationships over time, rather
than managing tasks or answering questions through a chat interface.

> **Project status:** working personal-knowledge MVP. The local Docker setup and core
> workflows are implemented, but this is not a hardened multi-user or public-hosting
> product.

## What you can do

- Keep work in separate **spaces**, each with its own notes, documents, decisions, and links.
- Capture a thought, then either build its map yourself or ask an optional AI service to
  suggest nodes and connections. Review and edit the map before saving it.
- Search by exact words, vector similarity, or a hybrid of both.
- Connect notes manually or with `[[wiki links]]`; review related notes and older,
  unconnected ideas.
- Import Markdown, plain text, and PDF files, or queue public web pages and folders for
  ingestion.
- Record decisions with their rationale, outcome, and revisit date; follow changes in a
  timeline.
- Use the web interface, HTTP API, or `mnemo` command-line tool.

## Quickstart (Windows)

Requirements: Docker Desktop with Docker Compose.

From the repository root:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --build -d
docker compose ps
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Interactive API documentation is
at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

Compose starts PostgreSQL with pgvector, applies migrations, and runs the API and worker.
The database, including uploaded original files, uses a named Docker volume and survives
ordinary container restarts and rebuilds. `docker compose down -v` removes that volume and
**deletes the stored database and uploaded files**.

### Optional settings

Edit the untracked `.env` file before starting Compose:

| Variable | Purpose |
|---|---|
| `API_KEY` | Optional shared key required on `/api/*` requests when set. |
| `OPENROUTER_API_KEY` | Enables AI-assisted notepad previews. Manual map building does not need it. |
| `EMBEDDING_PROVIDER` | `hash` (default, offline) or `ollama` (local semantic model). |
| `EMBEDDING_MODEL` | Embedding model name; the configured provider must produce 384-dimensional vectors. |
| `OLLAMA_URL` | Ollama endpoint; Compose defaults to `http://host.docker.internal:11434`. |

Never commit `.env`, API keys, database URLs, or private notes. `.env.example` contains
the local development defaults. When using Ollama or changing the embedding provider or
model, ensure both the API and worker use the same settings; run `mnemo reindex` after a
provider or model change.

## How the notepad works

1. Write a thought in your own words.
2. Choose **Build manually** to start with just the main note, or **Shape into a map** to
   request an AI-generated draft.
3. Edit the map graphically or in its **Details** form. Add, remove, and connect nodes.
4. Choose **Add to graph** only when the map is ready.

In manual mode, the first non-empty line is the initial main-note title; edit the title
and content in **Details**.

The AI path is optional and best-effort: it can misunderstand text, and free-model
availability or rate limits can change. Review its output and any evidence warnings
before saving. Evidence that does not match the paragraph is cleared and flagged rather
than presented as a verified quote. AI-generated drafts are capped at 20 new nodes and
24 connections.

**Privacy:** notes and search data are stored in the configured PostgreSQL database.
The default hash embedding provider runs locally and makes no model API calls. When
using AI preview, the paragraph and titles of up to 100 nodes in the current space are
sent to OpenRouter for interpretation. The configured models are free-tier models with
a zero-dollar price cap, but that does not make the request private. Use manual mode or
do not submit sensitive text if you are not comfortable with that data handling. Ollama
embeddings can run locally.

## Search and graph behavior

- **Text** search uses PostgreSQL full-text search.
- **Vector** search compares stored embeddings.
- **Hybrid** combines text and vector rankings with Reciprocal Rank Fusion (RRF).
- The default hash embedding is a deterministic lexical baseline, not a trained
  semantic model. Ollama is an optional local semantic embedding provider.
- Solid graph lines are saved connections. Dashed lines are similarity suggestions and
  are not saved until accepted.
- The Connections view lists saved links and candidate links between notes captured at
  least 30 days apart that are not already connected.

## CLI

Install the package in a Python environment, configure `DATABASE_URL`, and apply
migrations before using the CLI:

```powershell
mnemo add "A useful thought" --title "Example"
mnemo search "what did I decide about local storage" --mode hybrid
mnemo ingest .\notes\design.md
mnemo ingest https://example.com/article
mnemo watch .\ObsidianVault
mnemo worker
mnemo-eval
```

`mnemo watch` polls a folder for Markdown, text, and PDF changes. The worker must be
running to process queued imports and indexing jobs.

## API overview

| Route | Purpose |
|---|---|
| `GET/POST /api/spaces`, `PATCH/DELETE /api/spaces/{id}` | Manage isolated spaces. |
| `GET/POST /api/items`, `GET/PATCH/DELETE /api/items/{id}` | Capture and manage items. |
| `POST/PATCH/DELETE /api/items/{item_id}/links/{target_item_id}` | Create or manage a saved graph connection. |
| `GET /api/search` (`mode=text`, `mode=vector`, or `mode=hybrid`) | Search the current space. |
| `GET /api/graph`, `GET /api/timeline` | Read graph and timeline data. |
| `GET /api/items/{id}/related`, `GET /api/connections/forgotten` | Find related or distant connections. |
| `POST /api/drafts` | Request an AI-assisted graph draft; requires `OPENROUTER_API_KEY`. |
| `POST /api/ingest/file`, `POST /api/ingest/url`, `GET /api/jobs/{id}` | Import sources and inspect jobs. |
| `GET/POST /api/decisions`, `PATCH /api/decisions/{id}` | Manage the decision log. |
| `GET /health`, `GET /health/db` | Check application and database health. |

When `API_KEY` is configured, send it as `X-API-Key` for `/api/*` routes. The web UI's
**Connection settings** dialog stores this shared key in that browser's local storage.
This is a convenience for a personal deployment, not user accounts or production-grade
authorization. Keep the service on localhost unless it is protected by HTTPS and an
appropriate access-control layer.

## Local Python development

Use Docker for PostgreSQL, then run the API and worker from a virtual environment. In
PowerShell:

```powershell
docker compose up -d db
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
$env:DATABASE_URL = "postgresql+asyncpg://mnemosyne:mnemosyne@localhost:5432/mnemosyne"
alembic upgrade head
```

Start `mnemo worker` in one terminal and the API in another (with the environment
activated and `DATABASE_URL` set in both):

```powershell
uvicorn mnemosyne.api.app:app --reload --app-dir src
```

For hosted PostgreSQL such as Supabase, use its direct PostgreSQL connection string in
`DATABASE_URL`; Mnemosyne uses SQLAlchemy/asyncpg and does not require the Supabase SDK.
Review the target schema and take a backup before applying migrations to an existing
database. Hosted connectivity and production deployment should be validated separately.

## Development checks

```powershell
ruff check .
ruff format --check .
mypy src/mnemosyne --ignore-missing-imports
pytest
mnemo-eval
```

The bundled retrieval evaluation contains only four labelled queries. It is a smoke
fixture, not a representative benchmark or evidence that one search mode is generally
better. See [Contributing](CONTRIBUTING.md), [Architecture](docs/architecture.md),
[architecture decisions](docs/decisions/), [implementation plan](plan.md), and
[Changelog](CHANGELOG.md).

## Known limitations and next work

- Retrieval quality needs a larger, representative, non-sensitive labelled evaluation
  set and repeated comparisons across text, vector, and hybrid search.
- AI extraction is not guaranteed to be correct; it needs human review and depends on
  an external free-tier provider when enabled.
- The API key is a single shared secret. There are no user accounts, roles, or
  multi-user isolation controls.
- There is no application-level encryption, key rotation, or polished backup/restore
  workflow. Protect the database and Docker volumes as private data.
- Performance has not been benchmarked with large spaces or large document collections.
- Folder watching is polling-based, and public URL ingestion is intended for a personal
  deployment rather than an unrestricted public service.

Good next investments are a reliable export/backup-and-restore path, broader retrieval
and AI-draft evaluation, accessibility and end-to-end UI tests, and stronger
authentication before any multi-user or public deployment. Benchmark graph and search
performance on realistic datasets before scaling up. Choose and add a project license
before presenting the repository as open source.
