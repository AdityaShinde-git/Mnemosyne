# ADR 0002: Reciprocal Rank Fusion for hybrid search

- **Status:** Accepted

## Context

Full-text and vector search return scores with different scales. Directly adding those
scores would require calibration and could make the result sensitive to a provider's
score range.

## Decision

Support text, vector, and hybrid retrieval modes. Hybrid retrieval combines the ranked
lists using Reciprocal Rank Fusion (RRF), rather than summing raw scores.

## Consequences

- No score calibration is required between retrieval modes.
- Search results expose how they matched for inspection.
- RRF constants and candidate limits may need tuning against a larger labelled corpus;
  the small bundled fixture is only a smoke test.
