# ADR 0003: PostgreSQL-backed job queue

- **Status:** Accepted

## Context

File and URL ingestion and note indexing should happen outside interactive API requests.
A separate queue service would add deployment and maintenance work.

## Decision

Store jobs in PostgreSQL and claim them with `FOR UPDATE SKIP LOCKED`. Persist attempt
count, status, next run time, lock time, and the last error type. Retry failures with
bounded exponential backoff.

## Consequences

- The worker has no broker dependency and can run as a separate process or container.
- Multiple workers can claim different jobs concurrently.
- Queue throughput is bounded by the database and is suitable for the intended
  personal/local workload, not assumed to be a high-volume distributed queue.
