from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row

from .models import CrawlRequest, ExtractionBatch, FetchedDocument, SourcePolicy


class CrawlerRepository:
    def __init__(self, database_url: str):
        self.database_url = database_url

    def connect(self):
        return psycopg.connect(self.database_url, row_factory=dict_row)

    def ping(self) -> dict[str, Any]:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT current_database() AS database, current_schema() AS schema")
            return cursor.fetchone()

    def get_source(self, source_id: UUID) -> SourcePolicy:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT id, name, base_url, connector_key, enabled, robots_mode,
                       terms_review_status, contact_identity, allowed_domains,
                       allowed_path_prefixes, denied_path_prefixes, max_depth,
                       max_pages_per_run, max_bytes_per_run, max_runtime_seconds,
                       http_requests_per_minute, http_concurrency_per_domain,
                       browser_requests_per_minute, browser_concurrency_per_domain,
                       default_fetch_mode, allow_stealth, allow_authenticated_session,
                       store_html, store_screenshot_policy, timezone, config
                FROM ingestion.source
                WHERE id = %s
                """,
                (source_id,),
            )
            row = cursor.fetchone()
        if not row:
            raise KeyError(f"Source not found: {source_id}")
        return SourcePolicy(
            source_id=row["id"],
            name=row["name"],
            base_url=row["base_url"],
            connector_key=row["connector_key"],
            enabled=row["enabled"],
            robots_mode=row["robots_mode"],
            terms_review_status=row["terms_review_status"],
            contact_identity=row["contact_identity"],
            allowed_domains=row["allowed_domains"] or [],
            allowed_path_prefixes=row["allowed_path_prefixes"] or ["/"],
            denied_path_prefixes=row["denied_path_prefixes"] or [],
            max_depth=row["max_depth"],
            max_pages_per_run=row["max_pages_per_run"],
            max_bytes_per_run=row["max_bytes_per_run"],
            max_runtime_seconds=row["max_runtime_seconds"],
            http_requests_per_minute=row["http_requests_per_minute"],
            http_concurrency_per_domain=row["http_concurrency_per_domain"],
            browser_requests_per_minute=row["browser_requests_per_minute"],
            browser_concurrency_per_domain=row["browser_concurrency_per_domain"],
            default_fetch_mode=row["default_fetch_mode"],
            allow_stealth=row["allow_stealth"],
            allow_authenticated_session=row["allow_authenticated_session"],
            store_html=row["store_html"],
            store_screenshot_policy=row["store_screenshot_policy"],
            timezone=row["timezone"],
            configuration=row["config"] or {},
        )

    def enqueue_source(self, policy: SourcePolicy, request: CrawlRequest, worker_version: str, idempotency_key: str | None = None) -> tuple[UUID, UUID]:
        run_id = uuid4()
        job_id = uuid4()
        dedupe = idempotency_key or f"source-run:{policy.source_id}:{run_id}"
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT crawl_run_id, id FROM ingestion.job WHERE dedupe_key = %s", (dedupe,))
            existing = cursor.fetchone()
            if existing:
                return existing["crawl_run_id"], existing["id"]
            cursor.execute(
                """
                INSERT INTO ingestion.crawl_run(
                  id, source_id, trigger, connector_key, connector_version,
                  worker_version, policy_snapshot, status, pages_scheduled
                ) VALUES (%s,%s,'MANUAL',%s,%s,%s,%s::jsonb,'QUEUED',1)
                """,
                (run_id, policy.source_id, policy.connector_key, policy.connector_version, worker_version, policy.model_dump_json()),
            )
            cursor.execute(
                """
                INSERT INTO ingestion.job(
                  id, job_type, required_capability, status, priority, dedupe_key,
                  payload, source_id, crawl_run_id, available_at, not_before, max_attempts
                ) VALUES (%s,'URL_FETCH','INGESTION','QUEUED',%s,%s,%s::jsonb,%s,%s,now(),now(),4)
                RETURNING id, crawl_run_id
                """,
                (job_id, request.priority, dedupe, request.model_dump_json(), policy.source_id, run_id),
            )
            result = cursor.fetchone()
            connection.commit()
        return result["crawl_run_id"], result["id"]

    def register_worker(self, worker_name: str, worker_version: str) -> UUID:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO ingestion.worker(worker_name, worker_type, capabilities, status, last_heartbeat_at, metadata)
                VALUES (%s,'CRAWLER','["INGESTION"]'::jsonb,'ONLINE',now(),jsonb_build_object('version',%s))
                ON CONFLICT (worker_name) DO UPDATE
                  SET status='ONLINE', last_heartbeat_at=now(),
                      metadata=EXCLUDED.metadata, updated_at=now()
                RETURNING id
                """,
                (worker_name, worker_version),
            )
            row = cursor.fetchone()
            if not row:
                cursor.execute("SELECT id FROM ingestion.worker WHERE worker_name = %s ORDER BY created_at DESC LIMIT 1", (worker_name,))
                row = cursor.fetchone()
            connection.commit()
            return row["id"]

    def heartbeat(self, worker_id: UUID) -> None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("UPDATE ingestion.worker SET last_heartbeat_at=now(), status='ONLINE', updated_at=now() WHERE id=%s", (worker_id,))
            connection.commit()

    def lease_job(self, worker_name: str, lease_seconds: int = 120) -> dict[str, Any] | None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                WITH next_job AS (
                  SELECT id FROM ingestion.job
                  WHERE status IN ('QUEUED','RETRY_WAIT')
                    AND job_type IN ('SOURCE_DISCOVERY','URL_FETCH','DOCUMENT_EXTRACT','MEDIA_FETCH','MEDIA_ANALYZE','SOURCE_REPLAY','SOURCE_HEALTH_CHECK')
                    AND COALESCE(not_before, available_at) <= now()
                    AND (lease_expires_at IS NULL OR lease_expires_at < now())
                  ORDER BY CASE priority WHEN 'REALTIME' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, created_at
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1
                )
                UPDATE ingestion.job j
                SET status='LEASED', lease_owner=%s,
                    lease_expires_at=now()+(%s || ' seconds')::interval,
                    started_at=COALESCE(started_at,now()), attempt_count=attempt_count+1
                FROM next_job
                WHERE j.id=next_job.id
                RETURNING j.*
                """,
                (worker_name, lease_seconds),
            )
            row = cursor.fetchone()
            connection.commit()
            return row

    def persist_success(self, job: dict[str, Any], result, body_key: str, batch_factory) -> tuple[FetchedDocument, ExtractionBatch]:
        body_hash = hashlib.sha256(result.body).hexdigest()
        raw_document_id = uuid4()
        fetch_attempt_id = uuid4()
        external_document_id = hashlib.sha256(f"{result.final_url}\x1f{body_hash}".encode()).hexdigest()
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO ingestion.fetch_attempt(
                  id,crawl_run_id,source_id,requested_url,final_url,status_code,fetch_mode_used,
                  request_headers_redacted,response_headers_redacted,content_type,encoding,content_length,
                  body_r2_key,fetched_at,duration_ms,etag,last_modified,content_sha256,blocked_reason
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    fetch_attempt_id, job["crawl_run_id"], job["source_id"], result.requested_url,
                    result.final_url, result.status_code, result.mode, json.dumps(result.request_headers_redacted),
                    json.dumps(result.response_headers_redacted), result.content_type, result.encoding, len(result.body),
                    body_key, result.fetched_at, result.duration_ms, result.etag, result.last_modified, body_hash,
                    result.blocked_reason,
                ),
            )
            cursor.execute(
                """
                INSERT INTO ingestion.raw_document(
                  id,source_id,external_document_id,document_type,canonical_url,text_preview,fetched_at,
                  content_hash,mime_type,r2_key,metadata,processing_status,crawl_run_id,fetch_attempt_id,
                  connector_key,connector_version,extraction_version
                ) VALUES (%s,%s,%s,'HTML',%s,%s,%s,%s,%s,%s,%s::jsonb,'PROCESSING',%s,%s,'website','1.0.0','1.0.0')
                ON CONFLICT (source_id,external_document_id) DO UPDATE
                  SET fetched_at=EXCLUDED.fetched_at, fetch_attempt_id=EXCLUDED.fetch_attempt_id
                RETURNING id
                """,
                (
                    raw_document_id, job["source_id"], external_document_id, result.final_url,
                    result.body[:500].decode(result.encoding or "utf-8", errors="replace"), result.fetched_at,
                    body_hash, result.content_type, body_key,
                    json.dumps({"status_code": result.status_code, "fetch_mode": result.mode}),
                    job["crawl_run_id"], fetch_attempt_id,
                ),
            )
            raw_document_id = cursor.fetchone()["id"]
            document = FetchedDocument(
                raw_document_id=raw_document_id,
                source_id=job["source_id"],
                crawl_run_id=job["crawl_run_id"],
                fetch_attempt_id=fetch_attempt_id,
                requested_url=result.requested_url,
                final_url=result.final_url,
                status_code=result.status_code,
                fetch_mode_used=result.mode,
                content_type=result.content_type,
                encoding=result.encoding,
                content_length=len(result.body),
                body_r2_key=body_key,
                fetched_at=result.fetched_at,
                duration_ms=result.duration_ms,
                etag=result.etag,
                last_modified=result.last_modified,
                content_sha256=body_hash,
                blocked_reason=result.blocked_reason,
                body=result.body,
            )
            batch = batch_factory(document)
            cursor.execute(
                """
                INSERT INTO ingestion.candidate(candidate_type,raw_document_id,job_id,payload,confidence,status)
                VALUES ('EVENT_EXTRACTION',%s,%s,%s::jsonb,%s,'PENDING')
                """,
                (raw_document_id, job["id"], batch.model_dump_json(), batch.quality_signals.get("completeness", 0)),
            )
            for assertion in batch.assertions:
                cursor.execute(
                    """
                    INSERT INTO ingestion.assertion(
                      subject_type,subject_id,subject_external_key,field_path,value_json,normalized_value_json,
                      source_id,raw_document_id,crawl_run_id,confidence,observed_at,valid_from,valid_to,status,
                      content_hash,evidence_locator,evidence_excerpt
                    ) VALUES ('EVENT',NULL,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,'ACTIVE',%s,%s,%s)
                    """,
                    (
                        assertion.subject_external_key, assertion.field_path, json.dumps(assertion.value),
                        json.dumps(assertion.normalized_value), job["source_id"], raw_document_id,
                        job["crawl_run_id"], assertion.confidence, assertion.observed_at, assertion.valid_from,
                        assertion.valid_until, hashlib.sha256(assertion.model_dump_json().encode()).hexdigest(),
                        assertion.evidence_locator, assertion.evidence_excerpt,
                    ),
                )
            for media in batch.media_candidates:
                cursor.execute(
                    """
                    INSERT INTO ingestion.media_candidate(
                      raw_document_id,source_id,crawl_run_id,source_url,resolved_url,owner_hint_type,
                      owner_hint_external_key,category,storage_mode,usage_scope,license_status,mime_type,
                      width,height,byte_size,aspect_ratio,has_alpha,sha256,perceptual_hash,source_signals,
                      classification_score,classification_reasons,attribution
                    ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s)
                    ON CONFLICT (raw_document_id,resolved_url,category) DO UPDATE
                      SET classification_score=EXCLUDED.classification_score,
                          classification_reasons=EXCLUDED.classification_reasons
                    """,
                    (
                        raw_document_id, job["source_id"], job["crawl_run_id"], media.source_url,
                        media.resolved_url, media.owner_hint_type, media.owner_hint_external_key, media.category,
                        media.storage_mode, media.usage_scope, media.license_status, media.mime_type, media.width,
                        media.height, media.byte_size, media.aspect_ratio, media.has_alpha, media.sha256,
                        media.perceptual_hash, json.dumps(media.source_signals), media.classification_score,
                        media.classification_reasons, media.attribution,
                    ),
                )
            logo_status = batch.quality_signals.get("logo_discovery_status", "LOGO_NOT_FOUND")
            cursor.execute("UPDATE ingestion.raw_document SET processing_status='EXTRACTED' WHERE id=%s", (raw_document_id,))
            cursor.execute("UPDATE ingestion.job SET status='SUCCEEDED', completed_at=now(), finished_at=now(), lease_expires_at=NULL WHERE id=%s", (job["id"],))
            cursor.execute(
                """
                UPDATE ingestion.crawl_run SET status='SUCCEEDED', started_at=COALESCE(started_at,now()), finished_at=now(),
                  pages_fetched=pages_fetched+1, bytes_fetched=bytes_fetched+%s,
                  assertions_emitted=assertions_emitted+%s, candidates_emitted=candidates_emitted+1,
                  media_discovered=media_discovered+%s, logos_discovered=logos_discovered+%s,
                  warnings_count=warnings_count+%s, logo_discovery_status=%s
                WHERE id=%s
                """,
                (len(result.body), len(batch.assertions), len(batch.media_candidates), sum(1 for item in batch.media_candidates if item.category.endswith("LOGO")), len(batch.warnings), logo_status, job["crawl_run_id"]),
            )
            cursor.execute(
                """
                INSERT INTO ingestion.source_sync_state(
                  source_id,last_fetch_at,last_success_at,last_content_hash,status,last_error,updated_at
                ) VALUES (%s,now(),now(),%s,'IDLE',NULL,now())
                ON CONFLICT (source_id) DO UPDATE SET
                  last_fetch_at=EXCLUDED.last_fetch_at,
                  last_success_at=EXCLUDED.last_success_at,
                  last_content_hash=EXCLUDED.last_content_hash,
                  status='IDLE',last_error=NULL,updated_at=now()
                """,
                (job["source_id"], body_hash),
            )
            connection.commit()
        return document, batch

    def fail_job(self, job: dict[str, Any], error: Exception) -> None:
        terminal = job["attempt_count"] >= job["max_attempts"]
        status = "DEAD" if terminal else "RETRY_WAIT"
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE ingestion.job SET status=%s, lease_expires_at=NULL,
                  not_before=now()+(LEAST(900,power(2,attempt_count)*2)::text || ' seconds')::interval,
                  last_error_class=%s,last_error_message_redacted=%s,last_error=%s,
                  finished_at=CASE WHEN %s THEN now() ELSE finished_at END
                WHERE id=%s
                """,
                (status, type(error).__name__, str(error)[:500], str(error)[:500], terminal, job["id"]),
            )
            cursor.execute("UPDATE ingestion.crawl_run SET status=%s,pages_failed=pages_failed+1,warnings_count=warnings_count+1,finished_at=CASE WHEN %s THEN now() ELSE finished_at END WHERE id=%s", (status, terminal, job["crawl_run_id"]))
            connection.commit()

    def get_raw_document(self, raw_document_id: UUID) -> dict[str, Any]:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT * FROM ingestion.raw_document WHERE id=%s", (raw_document_id,))
            row = cursor.fetchone()
        if not row:
            raise KeyError(f"Raw document not found: {raw_document_id}")
        return row
