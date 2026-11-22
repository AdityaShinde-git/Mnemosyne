import pytest

from mnemosyne.ingest.chunking import split_text
from mnemosyne.ingest.sources import fetch_url, parse_file


def test_chunking_preserves_content_with_overlap() -> None:
    text = "word " * 700
    chunks = split_text(text, chunk_size=200, overlap=30)

    assert len(chunks) > 1
    assert all(len(chunk) <= 200 for chunk in chunks)
    assert chunks[0][-20:] in chunks[1]


def test_markdown_file_parser(tmp_path) -> None:
    path = tmp_path / "note.md"
    path.write_text("# A note\n\nRemember the observatory.", encoding="utf-8")

    title, content, uri = parse_file(str(path))

    assert title == "note"
    assert "observatory" in content
    assert uri.startswith("file:")


@pytest.mark.asyncio
async def test_url_import_rejects_loopback_before_fetching() -> None:
    with pytest.raises(ValueError, match="public IP"):
        await fetch_url("http://127.0.0.1/private")
