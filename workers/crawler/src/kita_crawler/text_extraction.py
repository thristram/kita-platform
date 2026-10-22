from __future__ import annotations

import io
import re
from html.parser import HTMLParser

from .models import DocumentChunk


class _StructuredTextParser(HTMLParser):
    SKIP = {"script", "style", "noscript", "nav", "footer", "form"}
    BLOCKS = {"p", "li", "td", "th", "blockquote", "figcaption", "dd", "dt"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip_depth = 0
        self.heading = ""
        self.current_tag = ""
        self.buffer: list[str] = []
        self.sections: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in self.SKIP:
            self.skip_depth += 1
        self.current_tag = tag
        if tag in self.BLOCKS or re.fullmatch(r"h[1-6]", tag):
            self.buffer = []

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self.skip_depth:
            self.skip_depth -= 1
        if self.skip_depth:
            return
        text = re.sub(r"\s+", " ", " ".join(self.buffer)).strip()
        if re.fullmatch(r"h[1-6]", tag) and text:
            self.heading = text
        elif tag in self.BLOCKS and len(text) >= 20:
            self.sections.append((self.heading, text))
        self.buffer = []

    def handle_data(self, data: str) -> None:
        if not self.skip_depth and data.strip():
            self.buffer.append(data.strip())


def _chunk_sections(sections: list[tuple[str, str]], *, max_chars: int = 1_400) -> list[DocumentChunk]:
    chunks: list[DocumentChunk] = []
    content_parts: list[str] = []
    heading = ""
    char_cursor = 0
    for section_heading, text in sections:
        projected = "\n".join(content_parts + [text])
        if content_parts and len(projected) > max_chars:
            content = "\n".join(content_parts)
            chunks.append(DocumentChunk(chunk_index=len(chunks), heading_path=heading or None, content=content, char_start=char_cursor, char_end=char_cursor + len(content)))
            char_cursor += len(content)
            content_parts = []
        if section_heading:
            heading = section_heading
        content_parts.append(text)
    if content_parts:
        content = "\n".join(content_parts)
        chunks.append(DocumentChunk(chunk_index=len(chunks), heading_path=heading or None, content=content, char_start=char_cursor, char_end=char_cursor + len(content)))
    return chunks


def extract_html_chunks(body: bytes, encoding: str = "utf-8") -> list[DocumentChunk]:
    parser = _StructuredTextParser()
    parser.feed(body.decode(encoding, errors="replace"))
    return _chunk_sections(parser.sections)


def extract_pdf_chunks(body: bytes) -> list[DocumentChunk]:
    from pypdf import PdfReader

    reader = PdfReader(io.BytesIO(body))
    sections = [(f"Page {index + 1}", page.extract_text() or "") for index, page in enumerate(reader.pages)]
    return _chunk_sections([(heading, text) for heading, text in sections if text.strip()], max_chars=2_000)


def extract_text_chunks(body: bytes, content_type: str, encoding: str | None = None) -> list[DocumentChunk]:
    mime = content_type.split(";", 1)[0].lower()
    if mime == "text/html":
        return extract_html_chunks(body, encoding or "utf-8")
    if mime == "application/pdf":
        return extract_pdf_chunks(body)
    if mime.startswith("text/") or "json" in mime:
        text = body.decode(encoding or "utf-8", errors="replace")
        return _chunk_sections([("", text)], max_chars=2_000)
    return []
