# Mnemosyne implementation plan

## Product goal

Build a private, local-first knowledge engine that makes personal notes easier to capture, retrieve, connect, and revisit. The differentiator is the retrieval and memory pipeline—not a chat wrapper.

## Phase status

### 1. Foundation — implemented

- FastAPI application, SQLAlchemy async models, Alembic migrations, and Typer CLI.
- PostgreSQL/pgvector Docker Compose stack with a migration service.
- Item CRUD, SHA-256 deduplication, append-only revisions, metadata, and API-key option.
- Pytest, Ruff, mypy, and GitHub Actions CI.

### 2. Search — implemented

- Text chunking, PostgreSQL full-text GIN index, pgvector HNSW cosine index, and embedding model recorded per chunk.
- Text-only, vector-only, and hybrid search; hybrid uses Reciprocal Rank Fusion.
- Offline deterministic hashed lexical vectors work without a model service. Ollama can provide 384-dimensional local semantic embeddings.
- A small labelled evaluation runner reports recall@5 and MRR. Its sample set is only a smoke benchmark; it is not evidence of production-quality retrieval.

### 3. Ingestion — implemented

- PostgreSQL job queue claimed with `FOR UPDATE SKIP LOCKED`, stale-job recovery, bounded retries, and exponential backoff.
- Markdown, plain text, PDF, and public HTML/text imports.
- Polling folder sync for Markdown, text, and PDF changes.
- URL ingestion blocks non-public addresses and redirects, enforces HTTP(S), and limits content size.

### 4. Memory — implemented

- `[[wiki links]]` and backlinks, vector-suggested graph edges, related notes, and explainable forgotten connections.
- Timeline endpoint and first-class decision log with revisit date and outcome.

### 5. UI and release basics — implemented

- Dark graph-inspired web UI based on `Mnemosyne.jpg`, with capture, search modes, graph, timeline, connections, decisions, and API-key settings.
- Local-first fonts/assets; no third-party analytics or font requests.
- README, architecture notes, ADRs, contribution guide, changelog, evaluation fixture, and container build.

## Architecture

```text
Markdown / text / PDF / public URL / quick capture
                    |
             FastAPI / CLI / watcher
                    |
     PostgreSQL: items, revisions, jobs, decisions
                    |
    worker: parse -> chunk -> embed -> link -> store
                    |
       chunks: pgvector HNSW + full-text GIN
                    |
    hybrid search / timeline / graph / decisions
                    |
              dark web UI + CLI
```

## Deliberate decisions

- **PostgreSQL + pgvector:** notes, FTS, vectors, graph edges, and jobs share one database; Supabase is a supported Postgres host, not a core SDK dependency.
- **Postgres job queue:** `SKIP LOCKED` avoids an additional Redis service and keeps retries observable.
- **RRF:** text and vector lists are fused by rank, without assuming their raw scores are calibrated to each other.
- **Embedding interface:** offline hash embeddings are the no-service baseline; Ollama is the local semantic provider. Store model name per chunk and reindex when changing models.
- **Credential handling:** use `.env` locally; never check in `.env` or `creds.txt`. The supplied Supabase URI is configured only in the ignored local `.env`.

## Remaining validation / production work

The application tests, Ruff, mypy, JavaScript syntax check, retrieval fixture, and offline Alembic SQL generation are expected to run locally. A real PostgreSQL migration and live Supabase connectivity still need to be verified in an environment that can resolve/reach the supplied database; no remote migration should be applied until that succeeds.

Before calling this production-ready:

1. Run `docker compose up --build` and verify migration, API, worker, and CRUD against local pgvector.
2. Verify the Supabase DNS/network route, inspect the target schema, back up data, then apply Alembic migrations.
3. Use a larger labelled retrieval set and compare text-only/vector-only/hybrid across several queries and notes.
4. Add multi-user authentication, app-level encryption/key rotation if required, and HTTPS before exposing the service publicly.
5. Choose a project license with the repository owner before publishing an open-source release.
6. Record a real UI demo and publish a tagged release only after those checks pass.
