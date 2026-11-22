FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
COPY migrations ./migrations
COPY alembic.ini ./

RUN python -m pip install --no-cache-dir .

RUN useradd --create-home --uid 10001 mnemosyne \
    && chown -R mnemosyne:mnemosyne /app
USER mnemosyne

EXPOSE 8000
CMD ["uvicorn", "mnemosyne.api.app:app", "--host", "0.0.0.0", "--port", "8000"]
