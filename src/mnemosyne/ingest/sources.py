import asyncio
import ipaddress
from html.parser import HTMLParser
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from pypdf import PdfReader

MAX_SOURCE_BYTES = 20 * 1024 * 1024


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.title_parts: list[str] = []
        self._in_title = False
        self._ignored_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript", "svg"}:
            self._ignored_depth += 1
        elif tag == "title":
            self._in_title = True

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript", "svg"} and self._ignored_depth:
            self._ignored_depth -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        value = " ".join(data.split())
        if not value or self._ignored_depth:
            return
        self.parts.append(value)
        if self._in_title:
            self.title_parts.append(value)


def parse_file(path_value: str) -> tuple[str, str, str]:
    path = Path(path_value).expanduser().resolve(strict=True)
    if not path.is_file() or path.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("Source must be a file smaller than 20 MB")

    return parse_uploaded_file(path.name, path.read_bytes(), path.as_uri())


def parse_uploaded_file(
    filename: str, data: bytes, source_uri: str
) -> tuple[str, str, str]:
    if len(data) > MAX_SOURCE_BYTES:
        raise ValueError("Source must be a file smaller than 20 MB")

    path = Path(filename)
    suffix = path.suffix.casefold()
    if suffix == ".pdf":
        reader = PdfReader(BytesIO(data))
        content = "\n".join(page.extract_text() or "" for page in reader.pages)
    elif suffix in {".md", ".markdown", ".txt"}:
        content = data.decode("utf-8")
    else:
        raise ValueError("Supported file types are Markdown, text, and PDF")

    if not content.strip():
        raise ValueError("The source file contains no extractable text")
    return path.stem, content, source_uri

async def fetch_url(url: str) -> tuple[str, str, str]:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username:
        raise ValueError("Only public HTTP or HTTPS URLs are accepted")
    if parsed.port and parsed.port not in {80, 443}:
        raise ValueError("Only standard HTTP and HTTPS ports are accepted")

    addresses = await asyncio.get_running_loop().getaddrinfo(
        parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
    )
    if not addresses or any(
        not ipaddress.ip_address(address[4][0]).is_global for address in addresses
    ):
        raise ValueError("The URL must resolve only to public IP addresses")

    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=15,
        headers={"User-Agent": "Mnemosyne/0.1"},
        trust_env=False,
    ) as client:
        async with client.stream("GET", url) as response:
            response.raise_for_status()
            content_type = response.headers.get("content-type", "").casefold()
            if not any(kind in content_type for kind in ("text/html", "text/plain")):
                raise ValueError("URL imports currently support HTML and plain text")
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > MAX_SOURCE_BYTES:
                    raise ValueError("URL content exceeds the 20 MB limit")

    parser = _TextExtractor()
    parser.feed(body.decode(response.encoding or "utf-8", errors="replace"))
    content = "\n".join(parser.parts)
    title = " ".join(parser.title_parts).strip() or parsed.hostname
    if not content.strip():
        raise ValueError("The URL contains no extractable text")
    return title[:500], content, url
