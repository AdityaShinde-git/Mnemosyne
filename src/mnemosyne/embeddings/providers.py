import hashlib
import math
import re
from collections import Counter
from typing import Protocol

import httpx

from mnemosyne.config import get_settings

DIMENSIONS = 384
_TOKEN_PATTERN = re.compile(r"\w+", re.UNICODE)


class EmbeddingProvider(Protocol):
    model_name: str

    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class HashEmbeddingProvider:
    model_name = "mnemosyne-hash-384"

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    @staticmethod
    def _embed_one(text: str) -> list[float]:
        tokens = [token.casefold() for token in _TOKEN_PATTERN.findall(text)]
        features = tokens + [
            f"{left}_{right}" for left, right in zip(tokens, tokens[1:], strict=False)
        ]
        counts = Counter(features)
        vector = [0.0] * DIMENSIONS
        for feature, count in counts.items():
            digest = hashlib.blake2b(feature.encode("utf-8"), digest_size=8).digest()
            index = int.from_bytes(digest[:4], "big") % DIMENSIONS
            sign = 1.0 if digest[4] & 1 else -1.0
            vector[index] += sign * (1.0 + math.log(count))
        magnitude = math.sqrt(sum(value * value for value in vector))
        if magnitude:
            vector = [value / magnitude for value in vector]
        return vector


class OllamaEmbeddingProvider:
    def __init__(self, base_url: str, model_name: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.model_name = model_name

    async def embed(self, texts: list[str]) -> list[list[float]]:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.post(
                f"{self.base_url}/api/embed",
                json={"model": self.model_name, "input": texts},
            )
            response.raise_for_status()
            payload = response.json()

        embeddings = payload.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise RuntimeError("Ollama returned an unexpected embedding response")
        if any(not isinstance(vector, list) or len(vector) != DIMENSIONS for vector in embeddings):
            raise RuntimeError(f"Ollama model must return {DIMENSIONS}-dimension embeddings")
        return embeddings


def get_embedding_provider() -> EmbeddingProvider:
    settings = get_settings()
    if settings.embedding_provider == "hash":
        return HashEmbeddingProvider()
    if settings.embedding_provider == "ollama":
        return OllamaEmbeddingProvider(settings.ollama_url, settings.embedding_model)
    raise ValueError(f"Unsupported embedding provider: {settings.embedding_provider}")
