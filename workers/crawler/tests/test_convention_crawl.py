from __future__ import annotations

import functools
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

from kita_crawler.config import load_settings
from kita_crawler.connectors import OfficialWebsiteConnector
from kita_crawler.coordinator import CrawlCoordinator
from kita_crawler.engine import ScraplingEngine
from kita_crawler.models import ExtractionBatch, FetchedDocument, SourcePolicy
from kita_crawler.storage import LocalObjectStore


class MemorySink:
    def __init__(self): self.records: list[tuple[FetchedDocument,ExtractionBatch,str]] = []
    async def persist(self, document, batch, bucket): self.records.append((document,batch,bucket))


@pytest.mark.asyncio
async def test_scrapling_bounded_multi_page_convention_fixture(tmp_path: Path) -> None:
    fixture = Path(__file__).parent / "fixtures" / "convention-site"
    handler = functools.partial(SimpleHTTPRequestHandler,directory=str(fixture))
    try:
        server = ThreadingHTTPServer(("127.0.0.1",0),handler)
    except PermissionError:
        pytest.skip("local socket binding is unavailable in this sandbox")
    thread = threading.Thread(target=server.serve_forever,daemon=True); thread.start()
    try:
        base = f"http://127.0.0.1:{server.server_port}/"
        settings = load_settings().model_copy(update={"allow_private_network":True})
        policy = SourcePolicy(source_id=uuid4(),name="Fixture convention",base_url=base,enabled=True,terms_review_status="REVIEWED_ALLOWED",allowed_domains=["127.0.0.1"],max_depth=2,max_pages_per_run=20)
        sink = MemorySink(); store = LocalObjectStore(tmp_path / "raw",bucket="kita-raw")
        summary = await CrawlCoordinator(ScraplingEngine(settings),OfficialWebsiteConnector(),store,sink).crawl(policy)
        fetched = {Path(urlsplit(document.final_url).path).name or "index.html" for document,_,_ in sink.records}
        assert {"index.html","schedule.html","guests.html","exhibitors.html","tickets.html","news.html","map.pdf","logo.svg","hero.svg"} <= fetched
        assert summary.pages_fetched <= policy.max_pages_per_run
        root_batch = next(batch for document,batch,_ in sink.records if document.final_url == base)
        kinds = {str(link.link_kind) for link in root_batch.discovered_links}
        assert {"X","INSTAGRAM","PDF"} <= kinds
        assert root_batch.document_chunks
        assert any(candidate.category.endswith("LOGO") for candidate in root_batch.media_candidates)
        for document,_,bucket in sink.records:
            assert bucket == "kita-raw" and await store.head(document.body_r2_key)
    finally:
        server.shutdown(); thread.join(timeout=2)
