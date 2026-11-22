import math

import pytest

from mnemosyne.embeddings.providers import HashEmbeddingProvider


@pytest.mark.asyncio
async def test_hash_embeddings_are_deterministic_and_normalized() -> None:
    provider = HashEmbeddingProvider()
    embeddings = await provider.embed(["local knowledge graph", "local knowledge graph"])

    assert embeddings[0] == embeddings[1]
    assert math.sqrt(sum(value * value for value in embeddings[0])) == pytest.approx(1.0)
    assert len(embeddings[0]) == 384
