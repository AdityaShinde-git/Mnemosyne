# ADR 0001: PostgreSQL and pgvector

- **Status:** Accepted

## Context

Mnemosyne needs durable note storage, full-text retrieval, vector similarity, graph
relations, and a background queue. Keeping these features in separate services would
increase setup and operational overhead for a personal knowledge tool.

## Decision

Use PostgreSQL as the system of record and pgvector for embeddings. Use GIN indexes for
full-text search and HNSW for vector search. Keep SQLite as a test-only dialect for
application behavior that does not require PostgreSQL-specific features.

## Consequences

- One database hosts notes, revisions, chunks, edges, decisions, and jobs.
- Supabase can be used as hosted PostgreSQL without adding a provider-specific SDK.
- Production migrations and vector search require PostgreSQL with pgvector available.
- The vector extension is not dropped by the downgrade migration because it may be
  shared by other schemas.
