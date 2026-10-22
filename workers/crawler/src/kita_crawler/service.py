from __future__ import annotations

import asyncio
import hashlib
import json
import re
from urllib.parse import urlsplit
from uuid import NAMESPACE_URL, UUID, uuid4, uuid5

from .config import Settings
from .connectors import AnimeConsConnector, OfficialWebsiteConnector
from .engine import ScraplingEngine
from .dynamic_content import DEFAULT_XHR_PATTERN, assess_dynamic_content
from .media import inspect_media
from .models import CrawlRequest, ExtractionBatch, FetchMode, FetchPlan, FetchedDocument, PageType, SourcePolicy
from .repository import CrawlerRepository
from .safety import stable_key
from .storage import ArtifactStore
from .storage_keys import animecons_document_key, raw_document_key
from .structured_json import extract_json_assertions
from .text_extraction import extract_text_chunks


class CrawlerService:
    def __init__(self, settings: Settings, repository: CrawlerRepository, artifacts: ArtifactStore, media_artifacts: ArtifactStore | None = None):
        self.settings = settings
        self.repository = repository
        self.artifacts = artifacts
        self.media_artifacts = media_artifacts or artifacts
        self.engine = ScraplingEngine(settings)
        self.connectors = {"website": OfficialWebsiteConnector(), "animecons": AnimeConsConnector()}

    def _connector(self, policy: SourcePolicy):
        return self.connectors.get(policy.connector_key, self.connectors["website"])

    def enqueue_source(self, source_id: UUID, idempotency_key: str | None = None) -> tuple[UUID, UUID]:
        policy = self.repository.get_source(source_id)
        if not policy.enabled:
            raise RuntimeError("Source is disabled. Review its policy and enable it before crawling.")
        if policy.terms_review_status not in {"REVIEWED_ALLOWED"}:
            raise RuntimeError("Source terms must be REVIEWED_ALLOWED before crawling.")
        requests = asyncio.run(self._connector(policy).seed_requests(policy))
        if not requests:
            raise RuntimeError("Source has no seed URL")
        return self.repository.enqueue_source(policy, requests[0], self.settings.worker_version, idempotency_key)

    async def process_job(self, job: dict) -> dict:
        try:
            budget_stop = await asyncio.to_thread(self.repository.run_budget_stop_reason, job["crawl_run_id"])
            if budget_stop == "MAX_PAGES_REACHED" and job["job_type"] == "MEDIA_FETCH":
                budget_stop = None
            if budget_stop:
                skipped_jobs = await asyncio.to_thread(self.repository.skip_job_for_budget, job, budget_stop)
                return {"job_id": str(job["id"]), "skipped": True, "skipped_jobs": skipped_jobs, "budget_stop_reason": budget_stop}
            if job["job_type"] == "MEDIA_FETCH":
                return await self._process_media_job(job)
            request = CrawlRequest.model_validate(job["payload"])
            remaining_bytes = await asyncio.to_thread(self.repository.run_remaining_bytes, job["crawl_run_id"])
            request = request.model_copy(update={"metadata": {**request.metadata, "max_response_bytes": min(int(request.metadata.get("max_response_bytes", remaining_bytes or 1)), remaining_bytes or 1)}})
            policy = self.repository.get_source(job["source_id"])
            connector = self._connector(policy)
            plan = await connector.select_fetch_plan(request, policy)
            result = await self.engine.fetch(request, plan, policy)
            if result.blocked_reason:
                raise RuntimeError(result.blocked_reason)
            if result.status_code >= 400:
                raise RuntimeError(f"HTTP_{result.status_code}")
            probe_id = uuid4()
            content_hash = hashlib.sha256(result.body).hexdigest()
            fetch_attempt_id = uuid4()
            document = FetchedDocument(
                raw_document_id=probe_id, source_id=policy.source_id, crawl_run_id=job["crawl_run_id"], fetch_attempt_id=fetch_attempt_id,
                requested_url=result.requested_url, final_url=result.final_url, status_code=result.status_code, fetch_mode_used=result.mode,
                content_type=result.content_type, encoding=result.encoding, content_length=len(result.body), body_r2_key="adaptive-probe",
                fetched_at=result.fetched_at, duration_ms=result.duration_ms, etag=result.etag, last_modified=result.last_modified,
                content_sha256=content_hash, blocked_reason=result.blocked_reason, page_type=request.page_type, depth=request.depth,
                root_event_id=policy.root_event_id, body=result.body,
            )
            if "html" in result.content_type:
                batch = await connector.extract(document, policy)
                adaptive_enabled = bool((policy.configuration or {}).get("adaptive_dynamic", True)) and bool(request.metadata.get("adaptive_dynamic", True))
                assessment = assess_dynamic_content(result.body, request.page_type, batch, result.final_url)
                if plan.mode == FetchMode.HTTP and request.fetch_mode_hint != "HTTP" and adaptive_enabled and assessment.should_escalate:
                    dynamic_request = request.model_copy(update={
                        "render_wait": "NETWORK_IDLE",
                        "render_selector": request.render_selector or assessment.wait_selector,
                        "capture_xhr_patterns": request.capture_xhr_patterns or [DEFAULT_XHR_PATTERN],
                        "metadata": {**request.metadata, "dynamic_escalation_reasons": list(assessment.reasons), "dynamic_provider": assessment.provider},
                    })
                    result = await self.engine.fetch(dynamic_request, FetchPlan(mode=FetchMode.DYNAMIC, escalation_reason=",".join(assessment.reasons), timeout_seconds=max(plan.timeout_seconds, 45)), policy)
                    if result.blocked_reason:
                        raise RuntimeError(result.blocked_reason)
                    if result.status_code >= 400:
                        raise RuntimeError(f"HTTP_{result.status_code}")
                    content_hash = hashlib.sha256(result.body).hexdigest()
                    fetch_attempt_id = uuid4()
                    document = document.model_copy(update={
                        "fetch_attempt_id": fetch_attempt_id, "requested_url": result.requested_url, "final_url": result.final_url,
                        "status_code": result.status_code, "fetch_mode_used": result.mode, "content_type": result.content_type,
                        "encoding": result.encoding, "content_length": len(result.body), "fetched_at": result.fetched_at,
                        "duration_ms": result.duration_ms, "etag": result.etag, "last_modified": result.last_modified,
                        "content_sha256": content_hash, "body": result.body,
                    })
                    batch = await connector.extract(document, policy)
                    batch = batch.model_copy(update={
                        "warnings": [*batch.warnings, "http_probe_escalated_to_dynamic"],
                        "quality_signals": {**batch.quality_signals, "dynamic_escalation": {"score": assessment.score, "reasons": list(assessment.reasons), "provider": assessment.provider, "captured_artifacts": len(result.captured_artifacts)}},
                    })
            else:
                batch = ExtractionBatch(connector_key=connector.key, connector_version=connector.version, raw_document_id=probe_id, document_chunks=extract_text_chunks(result.body, result.content_type, result.encoding), quality_signals={"artifact_type": result.content_type})

            # Persist captured APIs before completing the parent job. Resolution is
            # triggered when crawler work becomes quiescent, so completing the page
            # first would create a race where the aggregate misses its XHR evidence.
            for artifact in result.captured_artifacts:
                await self._persist_captured_artifact(job, policy, artifact, request.page_type, result.final_url)

            existing = await asyncio.to_thread(self.repository.find_document_version, job["source_id"], result.final_url, content_hash)
            if existing and existing["crawl_run_id"] == job["crawl_run_id"]:
                await asyncio.to_thread(self.repository.persist_unchanged, job, result, existing)
                return {"job_id": str(job["id"]), "raw_document_id": str(existing["id"]), "unchanged": True, "fetch_mode": str(result.mode)}
            raw_document_id = uuid5(NAMESPACE_URL, f"kitacon:raw:{job['id']}:{content_hash}:{result.final_url}")
            document = document.model_copy(update={"raw_document_id": raw_document_id})
            batch = batch.model_copy(update={"raw_document_id": raw_document_id})
            if existing:
                # A previous run's blob can be reused, but this run still needs its
                # own extracted document and child jobs for resolution and discovery.
                document = document.model_copy(update={"body_r2_key": existing["r2_key"]})
                document, batch = await asyncio.to_thread(
                    self.repository.persist_document_success, job, result, document, batch,
                    bucket=existing["r2_bucket"], reused=True,
                )
                return {"job_id": str(job["id"]), "raw_document_id": str(document.raw_document_id), "unchanged": True,
                        "fetch_mode": str(result.mode), "discoveries": len(batch.discovered_links)}
            animecons_match = re.search(r"/events/info/(\d+)", result.final_url)
            animecons_external_id = request.metadata.get("external_event_id") or (animecons_match.group(1) if animecons_match else None) or (policy.configuration or {}).get("external_event_id", "listing")
            key = animecons_document_key(str(animecons_external_id), raw_document_id, result.content_type, result.fetched_at) if policy.connector_key == "animecons" else raw_document_key(policy.source_id, job["crawl_run_id"], raw_document_id, result.content_type, result.fetched_at)
            document = document.model_copy(update={"body_r2_key": key})
            await asyncio.to_thread(self.repository.register_object_write, job, bucket=self.artifacts.bucket, key=key, content_hash=content_hash, content_type=result.content_type, byte_size=len(result.body))
            stored = await self.artifacts.put_bytes(key=key, body=result.body, content_type=result.content_type, metadata={"source-id": str(policy.source_id), "crawl-run-id": str(job["crawl_run_id"]), "raw-document-id": str(raw_document_id)})
            document, batch = await asyncio.to_thread(self.repository.persist_document_success, job, result, document, batch, bucket=stored.bucket)
            await asyncio.to_thread(self.repository.commit_object_write, bucket=stored.bucket, key=key, raw_document_id=document.raw_document_id)
            return {"job_id": str(job["id"]), "raw_document_id": str(document.raw_document_id), "assertions": len(batch.assertions), "chunks": len(batch.document_chunks), "media": len(batch.media_candidates), "discoveries": len(batch.discovered_links)}
        except Exception as error:
            await asyncio.to_thread(self.repository.fail_job, job, error)
            raise

    async def _persist_captured_artifact(self, job: dict, policy: SourcePolicy, artifact, page_type: PageType, subject_url: str) -> None:
        body_hash = hashlib.sha256(artifact.body).hexdigest()
        existing = await asyncio.to_thread(self.repository.find_document_version, policy.source_id, artifact.url, body_hash)
        if existing and existing["crawl_run_id"] == job["crawl_run_id"]:
            return
        document_id = uuid5(NAMESPACE_URL, f"kitacon:xhr:{job['id']}:{body_hash}:{artifact.url}")
        key = existing["r2_key"] if existing else raw_document_key(policy.source_id, job["crawl_run_id"], document_id, artifact.content_type)
        if not existing:
            await asyncio.to_thread(self.repository.register_object_write, job, bucket=self.artifacts.bucket, key=key, content_hash=body_hash, content_type=artifact.content_type, byte_size=len(artifact.body))
            stored = await self.artifacts.put_bytes(key=key, body=artifact.body, content_type=artifact.content_type, metadata={"captured-xhr": "true", "crawl-run-id": str(job["crawl_run_id"])})
        bucket = existing["r2_bucket"] if existing else stored.bucket
        assertions = extract_json_assertions(artifact.body, page_type, subject_url, artifact.url) if "json" in artifact.content_type else []
        await asyncio.to_thread(self.repository.persist_auxiliary_document, job, artifact.url, artifact.status_code, artifact.content_type, artifact.body, document_id, bucket, key, body_hash, extract_text_chunks(artifact.body, artifact.content_type), assertions, page_type, reused=bool(existing))
        if not existing:
            await asyncio.to_thread(self.repository.commit_object_write, bucket=bucket, key=key, raw_document_id=document_id)

    async def _process_media_job(self, job: dict) -> dict:
        payload = job["payload"]
        policy = self.repository.get_source(job["source_id"])
        host = urlsplit(payload["url"]).hostname or ""
        media_policy = policy.model_copy(update={"allowed_domains": sorted(set(policy.allowed_domains + [host])), "allowed_path_prefixes": ["/"]})
        remaining_bytes = await asyncio.to_thread(self.repository.run_remaining_bytes, job["crawl_run_id"])
        request = CrawlRequest(source_id=policy.source_id, url=payload["url"], canonical_url=payload["canonical_url"], page_type=PageType.OTHER, dedupe_key=stable_key(str(policy.source_id), payload["canonical_url"]), expected_content_types=["image/*"], metadata={"max_response_bytes": min(50 * 1024 * 1024, remaining_bytes or 1)})
        result = await self.engine.fetch(request, FetchPlan(mode=FetchMode.HTTP), media_policy)
        if result.status_code >= 400 or not result.content_type.startswith("image/"):
            raise RuntimeError(f"MEDIA_FETCH_INVALID_{result.status_code}_{result.content_type}")
        inspection = inspect_media(result.body, result.content_type)
        existing = await asyncio.to_thread(self.repository.find_document_version, policy.source_id, result.final_url, inspection.sha256)
        existing_asset = await asyncio.to_thread(self.repository.find_media_asset, inspection.sha256)
        if existing:
            if existing_asset:
                persisted = await asyncio.to_thread(self.repository.persist_media_unchanged, job, result, existing, existing_asset, width=inspection.width, height=inspection.height, perceptual_hash=inspection.perceptual_hash)
                return {"job_id": str(job["id"]), "raw_document_id": str(persisted["raw_document_id"]), "asset_id": str(persisted["asset_id"]), "unchanged": True}
            await asyncio.to_thread(self.repository.persist_unchanged, job, result, existing)
            return {"job_id": str(job["id"]), "raw_document_id": str(existing["id"]), "unchanged": True}
        raw_document_id, fetch_attempt_id = uuid5(NAMESPACE_URL, f"kitacon:media:{job['id']}:{inspection.sha256}:{result.final_url}"), uuid4()
        key = raw_document_key(policy.source_id, job["crawl_run_id"], raw_document_id, result.content_type, result.fetched_at)
        if existing_asset:
            persisted = await asyncio.to_thread(self.repository.persist_media_success, job, result, raw_document_id=raw_document_id, fetch_attempt_id=fetch_attempt_id, bucket=existing_asset["r2_bucket"], key=existing_asset["r2_key"], sha256=inspection.sha256, perceptual_hash=inspection.perceptual_hash, width=inspection.width, height=inspection.height)
        else:
            await asyncio.to_thread(self.repository.register_object_write, job, bucket=self.media_artifacts.bucket, key=key, content_hash=inspection.sha256, content_type=result.content_type, byte_size=len(result.body))
            stored = await self.media_artifacts.put_bytes(key=key, body=result.body, content_type=result.content_type, metadata={"media-category": payload.get("category", "OTHER"), "crawl-run-id": str(job["crawl_run_id"])})
            persisted = await asyncio.to_thread(self.repository.persist_media_success, job, result, raw_document_id=raw_document_id, fetch_attempt_id=fetch_attempt_id, bucket=stored.bucket, key=key, sha256=inspection.sha256, perceptual_hash=inspection.perceptual_hash, width=inspection.width, height=inspection.height)
            await asyncio.to_thread(self.repository.commit_object_write, bucket=stored.bucket, key=key, raw_document_id=persisted["raw_document_id"], media_asset_id=persisted["asset_id"])
        return {"job_id": str(job["id"]), "raw_document_id": str(persisted["raw_document_id"]), "asset_id": str(persisted["asset_id"])}

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
        batch = await self._connector(policy).extract(document, policy)
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
        batch = await self._connector(policy).extract(document, policy)
        return {"raw_document_id": str(raw_document_id), "assertions": len(batch.assertions), "media": len(batch.media_candidates), "warnings": batch.warnings}
