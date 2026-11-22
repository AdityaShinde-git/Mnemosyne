# ADR 0004: Local-first embedding providers

- **Status:** Accepted

## Context

Search should work without requiring an external model API or transmitting private
notes to a third party.

## Decision

Provide a deterministic offline hashed lexical vector baseline and an optional local
Ollama provider. Both use a fixed 384-dimensional interface. Store the provider model
name with each chunk and provide a reindex command for provider/model changes.

## Consequences

- Basic indexing and search work without a model server.
- Hash vectors do not represent semantic understanding and should not be described as
  semantic embeddings.
- Ollama must use a model that returns the configured dimension; changing models
  requires reindexing existing notes.
