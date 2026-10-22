from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest

from kita_crawler.connectors import AnimeConsConnector
from kita_crawler.models import FetchMode, FetchedDocument, SourcePolicy


@pytest.mark.asyncio
async def test_animecons_fixture_emits_candidate_provenance_and_official_site() -> None:
    body = (Path(__file__).parent / "fixtures" / "animecons-event.html").read_bytes()
    source_id,run_id = uuid4(),uuid4()
    policy = SourcePolicy(source_id=source_id,name="AnimeCons",base_url="https://animecons.com/events/info/26503/fan-expo-canada-2026",connector_key="animecons",enabled=True,terms_review_status="REVIEWED_ALLOWED",allowed_domains=["animecons.com"])
    document = FetchedDocument(raw_document_id=uuid4(),source_id=source_id,crawl_run_id=run_id,fetch_attempt_id=uuid4(),requested_url=policy.base_url,final_url=policy.base_url,status_code=200,fetch_mode_used=FetchMode.HTTP,content_type="text/html",encoding="utf-8",content_length=len(body),body_r2_key="fixture",fetched_at=datetime.now(timezone.utc),duration_ms=1,content_sha256="fixture",body=body)
    batch = await AnimeConsConnector().extract(document,policy)
    record = batch.source_records[0]
    assertions = {item.field_path:item.value for item in batch.assertions}
    assert record["external_event_id"] == "26503"
    assert record["name"] == "Fan Expo Canada 2026"
    assert assertions["start_at"] == "2026-08-21"
    assert assertions["venue"] == "Metro Toronto Convention Centre"
    assert record["official_website"] == "https://fanexpohq.com/fanexpocanada/"
    assert batch.discovered_links[0].link_kind == "OFFICIAL_SITE"
    assert batch.discovered_links[0].decision == "REVIEW_REQUIRED"
    assert batch.document_chunks


@pytest.mark.asyncio
async def test_animecons_listing_fans_out_to_bounded_event_details() -> None:
    body = (Path(__file__).parent / "fixtures" / "animecons-listing.html").read_bytes()
    source_id,run_id = uuid4(),uuid4()
    policy = SourcePolicy(
        source_id=source_id,
        name="AnimeCons discovery",
        base_url="https://animecons.com/events/",
        connector_key="animecons",
        enabled=True,
        terms_review_status="REVIEWED_ALLOWED",
        allowed_domains=["animecons.com"],
        max_depth=2,
        max_pages_per_run=10,
        configuration={"discover_linked_events": True, "follow_official_sites": True},
    )
    document = FetchedDocument(raw_document_id=uuid4(),source_id=source_id,crawl_run_id=run_id,fetch_attempt_id=uuid4(),requested_url=policy.base_url,final_url=policy.base_url,status_code=200,fetch_mode_used=FetchMode.HTTP,content_type="text/html",encoding="utf-8",content_length=len(body),body_r2_key="fixture",fetched_at=datetime.now(timezone.utc),duration_ms=1,content_sha256="fixture",page_type="LISTING",body=body)
    batch = await AnimeConsConnector().extract(document,policy)
    assert batch.source_records[0]["record_type"] == "EVENT_LISTING"
    assert len(batch.outbound_links) == 2
    assert {request.page_type for request in batch.outbound_links} == {"EVENT"}
    assert all(request.metadata["auto_approve_official_site"] for request in batch.outbound_links)
    assert {link.metadata["external_event_id"] for link in batch.discovered_links} == {"26503", "28001"}


@pytest.mark.asyncio
async def test_animecons_event_detail_does_not_recursively_enqueue_sibling_events() -> None:
    body = b"""<html><body><h1>Fan Expo Canada 2026</h1>
    <a href='/events/info/28001/another-convention'>Another convention</a>
    </body></html>"""
    source_id, run_id = uuid4(), uuid4()
    policy = SourcePolicy(
        source_id=source_id,
        name="AnimeCons discovery",
        base_url="https://animecons.com/events/",
        connector_key="animecons",
        enabled=True,
        terms_review_status="REVIEWED_ALLOWED",
        allowed_domains=["animecons.com"],
        configuration={"discover_linked_events": True},
    )
    url = "https://animecons.com/events/info/26503/fan-expo-canada-2026"
    document = FetchedDocument(raw_document_id=uuid4(),source_id=source_id,crawl_run_id=run_id,fetch_attempt_id=uuid4(),requested_url=url,final_url=url,status_code=200,fetch_mode_used=FetchMode.HTTP,content_type="text/html",encoding="utf-8",content_length=len(body),body_r2_key="fixture",fetched_at=datetime.now(timezone.utc),duration_ms=1,content_sha256="fixture",page_type="EVENT",depth=1,body=body)
    batch = await AnimeConsConnector().extract(document, policy)
    assert batch.outbound_links == []
    assert all(link.normalized_url != "https://animecons.com/events/info/28001/another-convention" for link in batch.discovered_links)


@pytest.mark.asyncio
async def test_animecons_explicit_follow_policy_marks_official_site_fetchable() -> None:
    body = (Path(__file__).parent / "fixtures" / "animecons-event.html").read_bytes()
    source_id,run_id = uuid4(),uuid4()
    policy = SourcePolicy(source_id=source_id,name="AnimeCons",base_url="https://animecons.com/events/info/26503/fan-expo-canada-2026",connector_key="animecons",enabled=True,terms_review_status="REVIEWED_ALLOWED",allowed_domains=["animecons.com"],configuration={"follow_official_sites": True, "discover_linked_events": False})
    document = FetchedDocument(raw_document_id=uuid4(),source_id=source_id,crawl_run_id=run_id,fetch_attempt_id=uuid4(),requested_url=policy.base_url,final_url=policy.base_url,status_code=200,fetch_mode_used=FetchMode.HTTP,content_type="text/html",encoding="utf-8",content_length=len(body),body_r2_key="fixture",fetched_at=datetime.now(timezone.utc),duration_ms=1,content_sha256="fixture",body=body)
    batch = await AnimeConsConnector().extract(document,policy)
    official = next(link for link in batch.discovered_links if link.link_kind == "OFFICIAL_SITE")
    assert official.decision == "FETCH"
    assert official.metadata["inherited_policy_approval"] is True
