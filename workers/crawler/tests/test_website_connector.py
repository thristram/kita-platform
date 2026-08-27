from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from kita_crawler.connectors import OfficialWebsiteConnector
from kita_crawler.models import FetchMode, FetchedDocument, SourcePolicy

FIXTURES = Path(__file__).parent / "fixtures"


def source_policy() -> SourcePolicy:
    return SourcePolicy(
        source_id=uuid4(),
        name="Anime Expo fixture",
        base_url="https://www.anime-expo.org/",
        enabled=True,
        terms_review_status="REVIEWED_ALLOWED",
        allowed_domains=["www.anime-expo.org", "anime-expo.org"],
    )


def document(name: str) -> FetchedDocument:
    body = (FIXTURES / name).read_bytes()
    return FetchedDocument(
        raw_document_id=uuid4(),
        source_id=uuid4(),
        crawl_run_id=uuid4(),
        fetch_attempt_id=uuid4(),
        requested_url="https://www.anime-expo.org/",
        final_url="https://www.anime-expo.org/",
        status_code=200,
        fetch_mode_used=FetchMode.HTTP,
        content_type="text/html",
        encoding="utf-8",
        content_length=len(body),
        body_r2_key="fixtures/official-event.html",
        fetched_at=datetime.now(timezone.utc),
        duration_ms=10,
        content_sha256="fixture",
        body=body,
    )


@pytest.mark.asyncio
async def test_extracts_event_assertions_media_and_links() -> None:
    batch = await OfficialWebsiteConnector().extract(document("official-event.html"), source_policy())
    assertions = {item.field_path: item.value for item in batch.assertions}
    categories = {item.category for item in batch.media_candidates}

    assert assertions["title"] == "Anime Expo 2027"
    assert assertions["start_at"] == "2027-07-02T09:00:00-07:00"
    assert assertions["location"]["name"] == "Los Angeles Convention Center"
    assert {"EVENT_LOGO", "ORGANIZATION_LOGO", "EVENT_HERO"} <= categories
    assert [item.url for item in batch.outbound_links] == [
        "https://www.anime-expo.org/events/industry-registration"
    ]
    assert batch.quality_signals["logo_discovery_status"] == "LOGO_FOUND"


@pytest.mark.asyncio
async def test_reports_explicit_no_logo_outcome() -> None:
    batch = await OfficialWebsiteConnector().extract(document("no-logo.html"), source_policy())
    assert batch.quality_signals["logo_discovery_status"] == "LOGO_NOT_FOUND"
    assert not [item for item in batch.media_candidates if item.category.endswith("LOGO")]
