# Mnemosyne

**A private, local-first memory for the things you learn, notice, and decide.**

Mnemosyne stores notes in PostgreSQL, indexes them for full-text and vector retrieval, and connects them into a navigable knowledge graph. It includes a FastAPI API, a Typer CLI, a PostgreSQL-backed worker, and a small dark web interface inspired by the supplied graph-view reference.

## What works today

- Capture, list, update, and delete notes; content hashes make repeated captures idempotent.
- Append-only item revisions and automatic text chunking.
- Hybrid search that fuses PostgreSQL full-text and vector rankings with Reciprocal Rank Fusion (RRF).
- Offline hash embeddings by default; optional local Ollama semantic embeddings.
- A `SKIP LOCKED` worker queue with retry/backoff for indexing and source ingestion.
- Markdown, plain-text, PDF, and public HTML/text URL imports; incremental folder polling.
- Browser uploads keep original files in the ignored `documents/` folder and index extracted text.
- Manual graph links, `[[wiki links]]`, semantic suggestions, related notes, and forgotten connections.
- Isolated graph spaces with a neural-galaxy selector, an approval-first notepad, and editable/deletable nodes and connections.
- Timeline and first-class decision log.
- API-key protection when configured, plus a graph-inspired capture/search/timeline UI.

## Quickstart (Windows PowerShell)

Requirements: Docker Desktop and Docker Compose.

```powershell
cd C:\code\python\mnemosyne
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --build -d
docker compose ps
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). API documentation is at `/docs`.
The Compose stack applies migrations, starts PostgreSQL/pgvector, and runs the API and worker.

For development from a local Python environment instead:

```powershell
docker compose up -d db
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
```

In the worker terminal, use the local database URL and apply migrations before starting
the worker:

```powershell
$env:DATABASE_URL = "postgresql+asyncpg://mnemosyne:mnemosyne@localhost:5432/mnemosyne"
alembic upgrade head
mnemo worker
```

In a second terminal, activate the environment and set the same database URL before
starting the API:

```powershell
$env:DATABASE_URL = "postgresql+asyncpg://mnemosyne:mnemosyne@localhost:5432/mnemosyne"
uvicorn mnemosyne.api.app:app --reload --app-dir src
```

The local default embedding provider is a deterministic, lightweight hashed lexical vector. For stronger local semantic embeddings, install/run Ollama, download a 384-dimensional model such as `all-minilm`, then set:

```dotenv
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=all-minilm
OLLAMA_URL=http://127.0.0.1:11434
```

After changing the provider/model, queue existing notes for re-indexing with `mnemo reindex`.

## Supabase

Supabase is supported as hosted PostgreSQL; the core does not use the Supabase SDK. Put its direct PostgreSQL connection string in `DATABASE_URL` in the untracked `.env`. Mnemosyne adapts the standard `postgresql://` scheme and `sslmode` parameter for SQLAlchemy/asyncpg. The migration enables pgvector and adds the application tables/indexes; review your target schema and take a backup before applying it to an existing database.

The supplied `creds.txt` and `.env` are gitignored. Never paste the connection string into source control, issues, or chat. If a password has been exposed, rotate it in Supabase.

## CLI

```powershell
mnemo add "A useful thought" --title "Example"
mnemo search "what did I decide about local storage" --mode hybrid
mnemo ingest .\notes\design.md
mnemo ingest https://example.com/article
mnemo watch .\ObsidianVault
mnemo worker
mnemo-eval
```

`mnemo watch` polls a folder for changed Markdown, text, and PDF files. The worker must be running to process queued imports and embeddings.

## API

| Route | Purpose |
|---|---|
| `POST/GET /api/items`, `GET/PATCH/DELETE /api/items/{id}` | Note CRUD |
| `POST /api/items/{id}/links/{target_id}` | Connect two notes in the graph |
| `GET /api/items/{id}/revisions` | Note history |
| `POST /api/ingest/file` | Store and queue a Markdown, text, or PDF upload |
| `GET /api/search?q=...&mode=hybrid` | `hybrid`, `text`, or `vector` retrieval |
| `GET /api/graph`, `/api/timeline` | Graph and chronology |
| `POST /api/drafts` | Interpret a paragraph as an editable graph draft |
| `GET /api/items/{id}/related`, `/api/connections/forgotten` | Related and distant connections |
| `POST/GET /api/decisions`, `PATCH /api/decisions/{id}` | Decision log |
| `POST /api/ingest/url`, `GET /api/jobs/{id}` | Queue and inspect web imports |
| `GET /health`, `/health/db` | Liveness and database checks |

Set a long random `API_KEY` in `.env` to require `X-API-Key` on `/api/*`; the UI prompts for it and stores it in that browser's local storage. Keep the service bound to localhost unless it is behind HTTPS and a suitable access-control layer.

URL ingestion accepts only HTTP(S), rejects non-public DNS addresses and redirects, and enforces a response-size limit. The default hash embedder makes no outbound network requests. Ollama requests go only to the configured local endpoint.

The app opens to **Choose a space** each time. The last-opened space is marked **Continue**;
search or select another card to enter a space. Inside one, use the sidebar switcher to return to
the list. Each space has its own nodes, decisions, documents, and connections.

Use **Open notepad** to write freely, then choose **Preview map**. Mnemosyne sends the paragraph
and titles of up to 100 nodes in the current space to OpenRouter's
`inclusionai/ling-3.2-flash:free` model for interpretation. If Ling is rate-limited, Mnemosyne
tries `nvidia/nemotron-3.5-super-vl:free`. Add `OPENROUTER_API_KEY` to your untracked local `.env`
to enable it. Both models are explicitly free, requests require structured output, disable paid
provider fallbacks, and set a zero-dollar price cap. Free-model availability and rate limits are
controlled by OpenRouter and may change. The
model can still misunderstand text: review and edit the main title, topics, evidence, and named
connections, and resolve or ignore clarification questions. Nothing is written to the graph until
you select **Add to graph**. Do not send sensitive notes if you are not comfortable with the
OpenRouter/provider data handling.

The interpreter is designed to work with informal, fragmented, or self-correcting wording and can
draft up to 20 new nodes and 24 direct connections. It follows explicitly stated group sizes and
connection labels. When explicitly asked for a counted brainstorm from broad categories, it
proposes representative examples as individual nodes; for factual notes, it does not invent
missing group members. Review proposed examples before adding them to the graph.
The preview opens as an interactive graph: select a node or connection to edit it in the inspector,
edit node types as free text with suggestions and recently used labels, drag nodes to arrange the
map, or switch to **Details** for the complete form-based editor. Nodes appear as dots with their
labels beside them. Draft connections are unlabeled by default; add a name in the inspector if you
want one. Incomplete selected draft nodes and their connections are skipped during saving; the
remaining valid map is saved and the skipped items are reported. Scroll to zoom and drag empty canvas
space to pan in both the preview and main graph. The notepad keeps the source text editable while
you move between writing and preview.

To connect nodes, select one, choose **Connect to node**, and click the target directly on the
graph. You can optionally name the connection. Click a saved connection line to rename or
delete it. Click a suggested semantic line to accept it as a named connection or dismiss it;
deleting a `[[wiki link]]` also removes that link syntax from the source note.
Select a node to edit or delete it. Decision nodes have their own editor for the topic, choice,
reasoning, status, outcome, and revisit date.

Use **Add document** to upload Markdown, plain-text, or PDF files. The original file is
kept in the local `documents/` folder while extracted text is indexed in the database.
The saved document opens in a reader with related notes from the current space; select a
document node later and choose **Preview** to open it again.
Drag a node to arrange the graph; its position is saved in that browser.

## Evaluation

Run `mnemo-eval` to compare text-only, vector-only, and hybrid retrieval against the small labelled sample in `eval_data.json`. The current sample run reports:

| Mode | Recall@5 | MRR |
|---|---:|---:|
| Text | 1.000 | 0.875 |
| Vector (hashed lexical baseline) | 1.000 | 0.875 |
| Hybrid (RRF) | 1.000 | 0.875 |

This is a four-query smoke/evaluation fixture, not a representative benchmark and not evidence that hybrid improves retrieval. Add a larger labelled set from your own non-sensitive sample data before making quality claims.

## Development

```powershell
python -m pip install -e ".[dev]"
alembic upgrade head
ruff check .
ruff format --check .
mypy src/mnemosyne --ignore-missing-imports
pytest
```

See [docs/architecture.md](docs/architecture.md), [docs/decisions](docs/decisions), and [CONTRIBUTING.md](CONTRIBUTING.md).

## Current boundaries

The application-level API key is intended for a local/personal deployment; production multi-user authentication, app-level content encryption/key rotation, remote deployment, and a broad real-world retrieval benchmark remain follow-up work. Supabase provides encryption at rest at the storage layer, but that is not client-side encryption.
#   M n e m o s y n e  
 