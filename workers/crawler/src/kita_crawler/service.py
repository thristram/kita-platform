from __future__ import annotations

import asyncio
import hashlib
import json
from uuid import UUID

from .config import Settings
from .connectors import OfficialWebsiteConnector
from .engine import ScraplingEngine
from .models import CrawlRequest, FetchMode, FetchPlan, FetchedDocument, SourcePolicy
from .repository import CrawlerRepository
from .safety import stable_key
from .storage import ArtifactStore


class CrawlerService:
    def __init__(self, settings: Settings, repository: CrawlerRepository, artifacts: ArtifactStore):
        self.settings = settings
        self.repository = repository
        self.artifacts = artifacts
        self.engine = ScraplingEngine(settings)
        self.connector = OfficialWebsiteConnector()

    def enqueue_source(self, source_id: UUID, idempotency_key: str | None = None) -> tuple[UUID, UUID]:
        policy = self.repository.get_source(source_id)
        if not policy.enabled:
            raise RuntimeError("Source is disabled. Review its policy and enable it before crawling.")
        if policy.terms_review_status not in {"REVIEWED_ALLOWED"}:
            raise RuntimeError("Source terms must be REVIEWED_ALLOWED before crawling.")
        requests = asyncio.run(self.connector.seed_requests(policy))
        if not requests:
            raise RuntimeError("Source has no seed URL")
        return self.repository.enqueue_source(policy, requests[0], self.settings.worker_version, idempotency_key)

    async def process_job(self, job: dict) -> dict:
        try:
            request = CrawlRequest.model_validate(job["payload"])
            policy = self.repository.get_source(job["source_id"])
            plan = await self.connector.select_fetch_plan(request, policy)
            result = await self.engine.fetch(request, plan, policy)
            if result.blocked_reason:
                raise RuntimeError(result.blocked_reason)
            suffix = "html" if "html" in result.content_type else "bin"
            content_hash = hashlib.sha256(result.body).hexdigest()
            key = f"runs/{job['crawl_run_id']}/{content_hash}.{suffix}"
            await self.artifacts.put(key, result.body, result.content_type)

            async def extract(document: FetchedDocument):
                return await self.connector.extract(document, policy)

            holder = {}
            def batch_factory(document: FetchedDocument):
                batch = asyncio.run(extract(document)) if not _has_running_loop() else None
                if batch is None:
                    raise RuntimeError("Unexpected running event loop in persistence boundary")
                holder["batch"] = batch
                return batch

            document, batch = await asyncio.to_thread(self.repository.persist_success, job, result, key, batch_factory)
            return {"job_id": str(job["id"]), "raw_document_id": str(document.raw_document_id), "assertions": len(batch.assertions), "media": len(batch.media_candidates)}
        except Exception as error:
            await asyncio.to_thread(self.repository.fail_job, job, error)
            raise

    async def inspect(self, url: str, mode: FetchMode = FetchMode.HTTP) -> dict:
        from urllib.parse import urlsplit
        from uuid import uuid4

        host = urlsplit(url).hostname or ""
        policy = SourcePolicy(
            source_id=uuid4(),
            name="inspect",
            base_url=url,
            enabled=True,
            terms_review_status="REVIEWED_ALLOWED",
            allowed_domains=[host],
            allow_stealth=mode == FetchMode.STEALTH,
        )
        request = CrawlRequest(source_id=policy.source_id, url=url, canonical_url=url, dedupe_key=stable_key(url))
        result = await self.engine.fetch(request, FetchPlan(mode=mode), policy)
        content_hash = hashlib.sha256(result.body).hexdigest()
        document = FetchedDocument(
            raw_document_id=uuid4(), source_id=policy.source_id, crawl_run_id=uuid4(), fetch_attempt_id=uuid4(),
            requested_url=result.requested_url, final_url=result.final_url, status_code=result.status_code,
            fetch_mode_used=result.mode, content_type=result.content_type, encoding=result.encoding,
            content_length=len(result.body), body_r2_key="no-persist", fetched_at=result.fetched_at,
            duration_ms=result.duration_ms, content_sha256=content_hash, blocked_reason=result.blocked_reason,
            body=result.body,
        )
        batch = await self.connector.extract(document, policy)
        return {
            "fetch": {"url": result.final_url, "status": result.status_code, "mode": result.mode, "bytes": len(result.body), "sha256": content_hash, "blocked_reason": result.blocked_reason},
            "extraction": batch.model_dump(mode="json", exclude={"outbound_links": {"__all__": {"body"}}}),
        }

    async def replay(self, raw_document_id: UUID) -> dict:
        row = await asyncio.to_thread(self.repository.get_raw_document, raw_document_id)
        body = await self.artifacts.get(row["r2_key"])
        policy = await asyncio.to_thread(self.repository.get_source, row["source_id"])
        document = FetchedDocument(
            raw_document_id=row["id"], source_id=row["source_id"], crawl_run_id=row["crawl_run_id"],
            fetch_attempt_id=row["fetch_attempt_id"], requested_url=row["canonical_url"], final_url=row["canonical_url"],
            status_code=200, fetch_mode_used=(row["metadata"] or {}).get("fetch_mode", "HTTP"),
            content_type=row["mime_type"], content_length=len(body), body_r2_key=row["r2_key"],
            fetched_at=row["fetched_at"], duration_ms=0, content_sha256=row["content_hash"], body=body,
        )
        batch = await self.connector.extract(document, policy)
        return {"raw_document_id": str(raw_document_id), "assertions": len(batch.assertions), "media": len(batch.media_candidates), "warnings": batch.warnings}


def _has_running_loop() -> bool:
    try:
        asyncio.get_running_loop()
        return True
    except RuntimeError:
        return False

