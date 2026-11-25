# Architecture

Mnemosyne is a local-first knowledge application. The API, command-line client, folder
watcher, and background worker share one PostgreSQL database; the web UI is served by
FastAPI from the application package.

## Components

- **FastAPI (`src/mnemosyne/api`)** serves the static UI and JSON API. API routes use an
  async SQLAlchemy session; setting `API_KEY` enables `X-API-Key` authentication on
  `/api/*`.
- **CLI (`src/mnemosyne/cli`)** captures, searches, imports, watches folders, and starts
  the worker.
- **PostgreSQL + pgvector** stores spaces, source items, revisions, chunks, embeddings,
  graph edges, decisions, and the worker queue. SQLite is used by tests for
  database-level application behavior; it is not the deployment database.
- **Worker (`src/mnemosyne/worker.py`)** claims ready jobs with `FOR UPDATE SKIP LOCKED`,
  performs ingestion or indexing, and retries failed jobs with bounded exponential
  backoff. Indexing chunks content, embeds it, and refreshes explicit wiki-link edges.
- **Embedding providers (`src/mnemosyne/embeddings`)** expose a shared 384-dimensional
  interface. The offline hash provider requires no model service; Ollama is optional.

## Data flow

1. A note is captured in a space through the API or CLI, or queued from a file, folder
   watcher, or public URL.
2. `items` stores the current content. Edits preserve prior content in
   `item_revisions`; a SHA-256 content hash prevents duplicate captures.
3. An `index_item` job is queued. The worker splits the content into chunks and stores
   vectors in `chunks`; it also resolves `[[wiki links]]` into `edges`.
4. Search combines PostgreSQL full-text and vector rankings with Reciprocal Rank Fusion
   (RRF). Search can also be restricted to either retrieval mode.
5. Graph, timeline, related-note, forgotten-connection, and decision views query the
   same database.

## Graph drafting

The notepad has two paths. Manual building starts an empty editable map and makes no
model request. AI-assisted drafting is optional and requires `OPENROUTER_API_KEY`; it
sends the paragraph and current-space node titles to the configured OpenRouter free
models. The result remains a draft until a person reviews and saves it. Model output is
not treated as verified evidence when its quoted text does not match the source.

## Database and migrations

Alembic migrations are under `migrations/`. The initial schema stores items; the next
migration enables the pgvector extension and creates the indexing, revision, graph,
decision, and job tables and indexes. The vector extension is not removed on downgrade
because it may be shared by other applications in the database.

Use the Compose stack for a disposable local development database. For Supabase, use
its direct PostgreSQL connection string through `DATABASE_URL`; inspect the target
schema and back it up before applying migrations. A successful application startup
does not imply that a remote database is migrated.

## Configuration and deployment

`DATABASE_URL`, `API_KEY`, `OPENROUTER_API_KEY`, `EMBEDDING_PROVIDER`,
`EMBEDDING_MODEL`, `OLLAMA_URL`, and `JOB_MAX_ATTEMPTS` are environment settings. The
local Compose stack provides PostgreSQL/pgvector, a one-shot migration service, API,
and worker. The API and worker must use the same database and embedding model. Uploaded
originals are stored with their document records in PostgreSQL, which also makes uploads
available across serverless API instances. Compose persists the database in a named volume.

The Compose database credentials are development defaults, not production credentials.
Do not expose the service publicly without HTTPS and a production authentication and
authorization design. The API key is a single shared key, not multi-user access control.
Database/storage encryption does not provide application-level content encryption.

## Known boundaries

- The hash embedding provider is a deterministic lexical baseline, not a semantic model.
- The bundled retrieval fixture is a smoke benchmark only.
- Folder watching is polling-based and intended for personal workflows.
- URL ingestion rejects redirects and non-public destinations, but should be reviewed
  again before operating as a public multi-tenant service.
- There is no multi-user identity system, client-side encryption/key rotation, or hosted
  deployment configuration.
