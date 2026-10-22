from __future__ import annotations

from pathlib import Path
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from PIL import Image

from kita_crawler.discovery import classify_link, classify_page, enforce_budget
from kita_crawler.media import CoverCandidate, inspect_media, resolve_internal_cover
from kita_crawler.config import load_settings
from kita_crawler.models import CapturedArtifact, CrawlRequest, DiscoveryDecision, FetchMode, FetchResult, PageType, SourcePolicy
from kita_crawler.safety import canonicalize_url, stable_key
from kita_crawler.service import CrawlerService
from kita_crawler.storage import LocalObjectStore
from kita_crawler.storage_keys import raw_document_key


def policy() -> SourcePolicy:
    return SourcePolicy(source_id=uuid4(),name="Fixture",base_url="https://con.example/",enabled=True,terms_review_status="REVIEWED_ALLOWED",allowed_domains=["con.example"],max_depth=2,max_pages_per_run=3)


def test_normalization_classifier_scoring_and_budget() -> None:
    assert canonicalize_url("HTTPS://Con.Example:443/schedule?utm_source=x&day=2#top") == "https://con.example/schedule?day=2"
    assert classify_page("https://con.example/guests", "Voice actors")[0] == PageType.GUESTS
    links = [classify_link("https://con.example/", path, label, policy()) for path, label in (("/schedule", "Schedule"),("/guests", "Guests"),("/privacy", "Privacy"),("https://x.com/con", "X"))]
    discoveries = [item for item in links if item]
    limited = enforce_budget(discoveries,current_depth=0,max_depth=2,remaining_pages=1)
    assert sum(item.decision == DiscoveryDecision.FETCH for item in limited) == 1
    assert next(item for item in limited if "privacy" in item.normalized_url).decision == DiscoveryDecision.IGNORE
    assert next(item for item in limited if "x.com" in item.normalized_url).decision == DiscoveryDecision.REVIEW_REQUIRED


@pytest.mark.asyncio
async def test_object_store_contract_and_stable_keys(tmp_path: Path) -> None:
    store = LocalObjectStore(tmp_path, bucket="kita-raw")
    key = raw_document_key(uuid4(),uuid4(),uuid4(),"text/html")
    first = await store.put_bytes(key=key,body=b"<h1>KitaCon</h1>",content_type="text/html",metadata={"kind":"fixture"})
    assert first.bucket == "kita-raw"
    assert (await store.head(key)).byte_size == 16
    assert await store.get_bytes(key) == b"<h1>KitaCon</h1>"
    assert (await store.create_signed_get_url(key)).startswith("file:")
    await store.delete(key)
    assert await store.head(key) is None


def test_media_hashing_and_pinned_default_protection(tmp_path: Path) -> None:
    image_path = tmp_path / "hero.png"
    Image.new("RGB",(320,180),(112,71,235)).save(image_path)
    inspection = inspect_media(image_path.read_bytes(),"image/png")
    assert (inspection.width,inspection.height) == (320,180)
    assert len(inspection.sha256) == 64 and len(inspection.perceptual_hash or "") == 16
    hero,poster,pinned = uuid4(),uuid4(),uuid4()
    assert resolve_internal_cover([CoverCandidate(poster,"EVENT_POSTER",99),CoverCandidate(hero,"EVENT_HERO",50)]) == hero
    assert resolve_internal_cover([CoverCandidate(hero,"EVENT_HERO",100),CoverCandidate(pinned,"EVENT_POSTER",1,True)],current_asset_id=pinned) == pinned
    assert stable_key("MEDIA_FETCH",inspection.sha256) == stable_key("MEDIA_FETCH",inspection.sha256)


class RepeatRepository:
    def __init__(self, source_policy: SourcePolicy):
        self.policy = source_policy
        self.documents: dict[tuple[object, str, str], dict] = {}
        self.unchanged = 0
        self.saved_runs: list[tuple[object, bool, list[str]]] = []
        self.auxiliary_runs: list[tuple[object, bool, int]] = []

    def run_budget_stop_reason(self, _run_id): return None
    def run_remaining_bytes(self, _run_id): return 262_144_000
    def register_object_write(self, *_args, **_kwargs): return None
    def commit_object_write(self, *_args, **_kwargs): return None
    def get_source(self, _source_id): return self.policy
    def find_document_version(self, source_id, url, content_hash): return self.documents.get((source_id, url, content_hash))
    def persist_document_success(self, job, result, document, batch, *, bucket, reused=False):
        self.documents[(job["source_id"], result.final_url, document.content_sha256)] = {"id": document.raw_document_id, "r2_key": document.body_r2_key, "r2_bucket": bucket, "content_hash": document.content_sha256, "crawl_run_id": job["crawl_run_id"]}
        self.saved_runs.append((job["crawl_run_id"], reused, [link.canonical_url for link in batch.outbound_links]))
        return document, batch
    def persist_unchanged(self, _job, _result, _existing): self.unchanged += 1
    def persist_auxiliary_document(self, job, url, _status, _type, _body, document_id, bucket, key, content_hash, _chunks, assertions, _page_type, *, reused=False):
        self.documents[(job["source_id"], url, content_hash)] = {"id": document_id, "r2_key": key, "r2_bucket": bucket,
                                                               "content_hash": content_hash, "crawl_run_id": job["crawl_run_id"]}
        self.auxiliary_runs.append((job["crawl_run_id"], reused, len(assertions)))
    def fail_job(self, _job, error): raise error


class FixedBackend:
    async def fetch(self, request, _plan, _policy):
        body = b'<html><head><title>Repeat Convention</title></head><body><main><h1>Repeat Convention</h1><a href="/schedule">Schedule</a></main></body></html>'
        return FetchResult(requested_url=request.url,final_url=request.canonical_url,status_code=200,mode=FetchMode.HTTP,content_type="text/html",encoding="utf-8",body=body,fetched_at=datetime.now(timezone.utc),duration_ms=3)


@pytest.mark.asyncio
async def test_repeat_unchanged_fetch_creates_one_raw_version(tmp_path: Path) -> None:
    source_id, run_id = uuid4(), uuid4()
    source_policy = SourcePolicy(source_id=source_id,name="Repeat fixture",base_url="https://con.example/",enabled=True,terms_review_status="REVIEWED_ALLOWED",allowed_domains=["con.example"])
    repository = RepeatRepository(source_policy)
    raw_store = LocalObjectStore(tmp_path / "raw", bucket="kita-raw")
    service = CrawlerService(load_settings(), repository, raw_store, LocalObjectStore(tmp_path / "media", bucket="kita-media"))  # type: ignore[arg-type]
    service.engine = FixedBackend()  # type: ignore[assignment]
    request = CrawlRequest(source_id=source_id,url="https://con.example/",canonical_url="https://con.example/",dedupe_key="repeat")
    base_job = {"job_type": "URL_FETCH", "payload": request.model_dump(mode="json"), "source_id": source_id, "crawl_run_id": run_id, "attempt_count": 1, "max_attempts": 4}
    first = await service.process_job({**base_job, "id": uuid4()})
    second = await service.process_job({**base_job, "id": uuid4()})
    assert first.get("unchanged") is None and second["unchanged"] is True
    assert len(repository.documents) == 1 and repository.unchanged == 1
    assert len([path for path in (tmp_path / "raw").rglob("*") if path.is_file()]) == 1


@pytest.mark.asyncio
async def test_repeat_run_reuses_blob_but_extracts_and_discovers_again(tmp_path: Path) -> None:
    source_id, first_run, second_run = uuid4(), uuid4(), uuid4()
    source_policy = SourcePolicy(source_id=source_id, name="Repeat fixture", base_url="https://con.example/", enabled=True,
                                 terms_review_status="REVIEWED_ALLOWED", allowed_domains=["con.example"])
    repository = RepeatRepository(source_policy)
    raw_store = LocalObjectStore(tmp_path / "raw", bucket="kita-raw")
    service = CrawlerService(load_settings(), repository, raw_store)  # type: ignore[arg-type]
    service.engine = FixedBackend()  # type: ignore[assignment]
    request = CrawlRequest(source_id=source_id, url="https://con.example/", canonical_url="https://con.example/", dedupe_key="repeat")
    job = {"job_type": "URL_FETCH", "payload": request.model_dump(mode="json"), "source_id": source_id,
           "attempt_count": 1, "max_attempts": 4}
    first = await service.process_job({**job, "id": uuid4(), "crawl_run_id": first_run})
    second = await service.process_job({**job, "id": uuid4(), "crawl_run_id": second_run})

    assert first.get("unchanged") is None
    assert second["unchanged"] is True and second["discoveries"] >= 1
    assert first["raw_document_id"] != second["raw_document_id"]
    assert repository.saved_runs == [
        (first_run, False, ["https://con.example/schedule"]),
        (second_run, True, ["https://con.example/schedule"]),
    ]
    assert len([path for path in (tmp_path / "raw").rglob("*") if path.is_file()]) == 1


@pytest.mark.asyncio
async def test_repeat_run_retains_captured_json_evidence_without_reupload(tmp_path: Path) -> None:
    source_policy = policy()
    repository = RepeatRepository(source_policy)
    store = LocalObjectStore(tmp_path / "raw", bucket="kita-raw")
    service = CrawlerService(load_settings(), repository, store)  # type: ignore[arg-type]
    artifact = CapturedArtifact(url="https://con.example/api/schedule", content_type="application/json",
                                body=b'{"sessions":[{"title":"Opening panel","startDate":"2026-10-09T10:00:00-04:00"}]}')
    first_run, second_run = uuid4(), uuid4()
    for run_id in (first_run, second_run):
        await service._persist_captured_artifact({"id": uuid4(), "source_id": source_policy.source_id, "crawl_run_id": run_id},
                                                 source_policy, artifact, PageType.SCHEDULE, "https://con.example/schedule")

    assert repository.auxiliary_runs == [(first_run, False, 1), (second_run, True, 1)]
    assert len([path for path in (tmp_path / "raw").rglob("*") if path.is_file()]) == 1
