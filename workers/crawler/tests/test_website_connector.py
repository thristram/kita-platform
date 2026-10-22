from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from kita_crawler.connectors import OfficialWebsiteConnector
from kita_crawler.models import FetchMode, FetchedDocument, PageType, SourcePolicy

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


@pytest.mark.asyncio
async def test_duplicate_navigation_links_do_not_consume_page_budget() -> None:
    body = b"<html><body><a href='/guests'>Guests</a><a href='/guests'>All Guests</a><a href='/schedule'>Schedule</a></body></html>"
    base = document("no-logo.html")
    live_document = base.model_copy(update={"body": body, "content_length": len(body)})
    policy = source_policy().model_copy(update={"max_pages_per_run": 3})
    batch = await OfficialWebsiteConnector().extract(live_document, policy)
    assert {item.url for item in batch.outbound_links} == {
        "https://www.anime-expo.org/guests",
        "https://www.anime-expo.org/schedule",
    }


@pytest.mark.asyncio
async def test_structured_media_without_url_is_ignored() -> None:
    body = b"""<html><head><script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Event","name":"Anime Expo","image":{"@type":"ImageObject"}}
    </script></head><body><h1>Anime Expo</h1></body></html>"""
    base = document("no-logo.html")
    live_document = base.model_copy(update={"body": body, "content_length": len(body)})
    batch = await OfficialWebsiteConnector().extract(live_document, source_policy())
    assert not [item for item in batch.media_candidates if item.resolved_url.endswith("/None")]


@pytest.mark.asyncio
async def test_extracts_schedule_and_exhibitor_records_for_event_content_bundle() -> None:
    schedule_body = b"""<html><body><main>
      <article class='schedule-item' data-room='Main Events Hall'>
        <h2>Frieren Symphony Showcase</h2><time datetime='2027-07-02T10:30:00-07:00'></time>
        <p>A live orchestral performance.</p>
      </article></main></body></html>"""
    exhibitor_body = b"""<html><body><main>
      <article class='exhibitor-card' data-booth='E-301'><h2>Good Smile Company</h2><p>Figures and collectibles.</p></article>
    </main></body></html>"""
    base = document("no-logo.html")
    schedule = base.model_copy(update={"body": schedule_body, "content_length": len(schedule_body), "page_type": PageType.SCHEDULE})
    exhibitors = base.model_copy(update={"body": exhibitor_body, "content_length": len(exhibitor_body), "page_type": PageType.EXHIBITORS})

    schedule_batch = await OfficialWebsiteConnector().extract(schedule, source_policy())
    exhibitor_batch = await OfficialWebsiteConnector().extract(exhibitors, source_policy())
    schedule_records = next(item.value for item in schedule_batch.assertions if item.field_path == "content.sessions")
    exhibitor_records = next(item.value for item in exhibitor_batch.assertions if item.field_path == "content.exhibitors")

    assert schedule_records[0]["title"] == "Frieren Symphony Showcase"
    assert schedule_records[0]["room"] == "Main Events Hall"
    assert exhibitor_records[0]["name"] == "Good Smile Company"
    assert exhibitor_records[0]["booth"] == "E-301"
