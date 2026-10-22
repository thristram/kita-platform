from __future__ import annotations

import re
from datetime import datetime, timezone
from uuid import UUID


def _extension(content_type: str) -> str:
    mime = content_type.split(";", 1)[0].lower()
    return {
        "text/html": "html",
        "application/json": "json",
        "application/ld+json": "json",
        "application/pdf": "pdf",
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/gif": "gif",
        "image/svg+xml": "svg",
        "text/plain": "txt",
    }.get(mime, "bin")


def raw_document_key(source_id: UUID, crawl_run_id: UUID, raw_document_id: UUID, content_type: str, fetched_at: datetime | None = None) -> str:
    moment = fetched_at or datetime.now(timezone.utc)
    mime = content_type.lower()
    kind = "pages" if "html" in mime else "json" if "json" in mime else "pdf" if "pdf" in mime else "media" if mime.startswith("image/") else "documents"
    return f"websites/{source_id}/{crawl_run_id}/{kind}/{moment:%Y-%m-%d}/{raw_document_id}/original.{_extension(content_type)}"


def animecons_document_key(external_event_id: str, raw_document_id: UUID, content_type: str, fetched_at: datetime | None = None) -> str:
    moment = fetched_at or datetime.now(timezone.utc)
    safe_id = re.sub(r"[^a-zA-Z0-9_-]", "_", external_event_id)
    return f"animecons/events/{safe_id}/{moment:%Y-%m-%d}/{raw_document_id}/page.{_extension(content_type)}"
