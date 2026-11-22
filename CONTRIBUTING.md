# Contributing

## Development setup

Use Python 3.11 or newer and Docker Compose. Follow the [README quickstart](README.md)
to start the local PostgreSQL/pgvector database and configure a Python environment.
For local development, set `DATABASE_URL` to the host-mapped Compose database in every
terminal that runs the app.

## Changes

- Keep changes focused and follow existing formatting and typing conventions.
- Add focused tests for behavior introduced or fixed.
- Never commit `.env`, `creds.txt`, or private notes, credentials, or database exports.
- Do not apply migrations to a shared database without inspecting and backing it up.
- Update the README or architecture docs when user-facing behavior or setup changes.

## Validation

Run these checks before opening a change:

```powershell
ruff check .
ruff format --check .
mypy src/mnemosyne --ignore-missing-imports
pytest
mnemo-eval
```

PostgreSQL-specific changes should also be checked against a local pgvector instance
with `alembic upgrade head`. The CI workflow runs migrations and the Python checks
against PostgreSQL.
