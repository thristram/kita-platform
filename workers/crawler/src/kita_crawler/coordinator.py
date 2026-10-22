from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Protocol
from uuid import UUID, uuid4

from .connectors.base import SourceConnector
from .engine import WebFetchBackend
from .models import CrawlRequest, ExtractionBatch, FetchedDocument, PageType, SourcePolicy
from .safety import stable_key
from .storage import ObjectStore
from .storage_keys import raw_document_key


class CrawlEvidenceSink(Protocol):
    async def persist(self, document: FetchedDocument, batch: ExtractionBatch, bucket: str) -> None: ...


@dataclass
class CrawlSummary:
    crawl_run_id: UUID
    pages_scheduled: int = 0
    pages_fetched: int = 0
    pages_failed: int = 0
    bytes_downloaded: int = 0
    discoveries: int = 0
    documents: list[FetchedDocument] = field(default_factory=list)


class CrawlCoordinator:
    """Bounded multi-page coordinator that depends only on KitaCon contracts."""

    def __init__(self, backend: WebFetchBackend, connector: SourceConnector, store: ObjectStore, sink: CrawlEvidenceSink):
        self.backend = backend
        self.connector = connector
        self.store = store
        self.sink = sink

    async def crawl(self, policy: SourcePolicy, *, crawl_run_id: UUID | None = None) -> CrawlSummary:
        run_id = crawl_run_id or uuid4()
        pending = await self.connector.seed_requests(policy)
        seen: set[str] = set()
        summary = CrawlSummary(crawl_run_id=run_id, pages_scheduled=len(pending))
        while pending and summary.pages_fetched + summary.pages_failed < policy.max_pages_per_run:
            request = pending.pop(0)
            if request.canonical_url in seen or request.depth > policy.max_depth:
                continue
            seen.add(request.canonical_url)
            try:
                plan = await self.connector.select_fetch_plan(request, policy)
                result = await self.backend.fetch(request, plan, policy)
                content_hash = hashlib.sha256(result.body).hexdigest()
                raw_id, fetch_id = uuid4(), uuid4()
                key = raw_document_key(policy.source_id, run_id, raw_id, result.content_type, result.fetched_at)
                stored = await self.store.put_bytes(key=key, body=result.body, content_type=result.content_type, metadata={"crawl-run-id": str(run_id), "raw-document-id": str(raw_id)})
                document = FetchedDocument(raw_document_id=raw_id,source_id=policy.source_id,crawl_run_id=run_id,fetch_attempt_id=fetch_id,requested_url=result.requested_url,final_url=result.final_url,status_code=result.status_code,fetch_mode_used=result.mode,content_type=result.content_type,encoding=result.encoding,content_length=len(result.body),body_r2_key=key,fetched_at=result.fetched_at,duration_ms=result.duration_ms,etag=result.etag,last_modified=result.last_modified,content_sha256=content_hash,page_type=request.page_type,depth=request.depth,root_event_id=policy.root_event_id,body=result.body)
                batch = await self.connector.extract(document, policy) if "html" in result.content_type else ExtractionBatch(connector_key=self.connector.key,connector_version=self.connector.version,raw_document_id=raw_id)
                await self.sink.persist(document, batch, stored.bucket)
                summary.documents.append(document)
                summary.pages_fetched += 1
                summary.bytes_downloaded += len(result.body)
                summary.discoveries += len(batch.discovered_links)
                remaining = policy.max_pages_per_run - len(seen) - len(pending)
                for child in batch.outbound_links:
                    if child.canonical_url not in seen and child.depth <= policy.max_depth and remaining > 0:
                        pending.append(child)
                        summary.pages_scheduled += 1
                        remaining -= 1
                for media in batch.media_candidates:
                    if media.classification_score < 0 or media.resolved_url in seen or remaining <= 0:
                        continue
                    pending.append(CrawlRequest(source_id=policy.source_id,url=media.resolved_url,canonical_url=media.resolved_url,page_type=PageType.OTHER,depth=request.depth + 1,dedupe_key=stable_key(str(policy.source_id),media.resolved_url),expected_content_types=["image/*"],metadata={"media_category": media.category}))
                    summary.pages_scheduled += 1
                    remaining -= 1
            except Exception:
                summary.pages_failed += 1
        return summary
