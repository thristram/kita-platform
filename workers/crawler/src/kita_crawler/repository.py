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

    def register_object_write(self, job: dict[str, Any], *, bucket: str, key: str, content_hash: str, content_type: str, byte_size: int) -> None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """INSERT INTO ingestion.object_write_intent(job_id,crawl_run_id,source_id,bucket,object_key,content_sha256,content_type,byte_size,status,last_error,updated_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,'PENDING',NULL,now())
                ON CONFLICT (bucket,object_key) DO UPDATE SET job_id=EXCLUDED.job_id,crawl_run_id=EXCLUDED.crawl_run_id,
                content_sha256=EXCLUDED.content_sha256,content_type=EXCLUDED.content_type,byte_size=EXCLUDED.byte_size,status='PENDING',last_error=NULL,updated_at=now()""",
                (job["id"], job["crawl_run_id"], job["source_id"], bucket, key, content_hash, content_type, byte_size),
            )
            connection.commit()

    def commit_object_write(self, *, bucket: str, key: str, raw_document_id: UUID, media_asset_id: UUID | None = None) -> None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "UPDATE ingestion.object_write_intent SET status='COMMITTED',raw_document_id=%s,media_asset_id=%s,last_error=NULL,updated_at=now() WHERE bucket=%s AND object_key=%s",
                (raw_document_id, media_asset_id, bucket, key),
            )
            connection.commit()

    def reconciliation_candidates(self, older_than_minutes: int = 30, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """SELECT i.*,j.status AS job_status FROM ingestion.object_write_intent i
                LEFT JOIN ingestion.job j ON j.id=i.job_id
                WHERE i.status='PENDING' AND i.updated_at < now()-(%s || ' minutes')::interval
                ORDER BY i.updated_at LIMIT %s""",
                (max(1, older_than_minutes), max(1, min(limit, 1000))),
            )
            return list(cursor.fetchall())

    def reconcile_object_write(self, intent_id: UUID, *, status: str, raw_document_id: UUID | None = None, error: str | None = None) -> None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "UPDATE ingestion.object_write_intent SET status=%s,raw_document_id=COALESCE(%s,raw_document_id),last_error=%s,updated_at=now() WHERE id=%s",
                (status, raw_document_id, error, intent_id),
            )
            connection.commit()

    def artifact_reference(self, bucket: str, key: str) -> dict[str, Any] | None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT id FROM ingestion.raw_document WHERE r2_bucket=%s AND r2_key=%s LIMIT 1", (bucket, key))
            row = cursor.fetchone()
            return row

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
            root_event_id=(row["config"] or {}).get("root_event_id"),
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
                  worker_version, policy_snapshot, status, pages_scheduled,
                  root_event_id,root_url,config_snapshot
                ) VALUES (%s,%s,'MANUAL',%s,%s,%s,%s::jsonb,'QUEUED',1,%s,%s,%s::jsonb)
                """,
                (run_id, policy.source_id, policy.connector_key, policy.connector_version, worker_version, policy.model_dump_json(), policy.root_event_id, request.canonical_url, json.dumps(policy.configuration)),
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
            cursor.execute("UPDATE ingestion.crawl_run SET job_id=%s WHERE id=%s", (job_id, run_id))
            if policy.root_event_id:
                cursor.execute(
                    """INSERT INTO ingestion.event_source(event_id,source_id,relation_type,confidence)
                    VALUES (%s,%s,'SEED',1) ON CONFLICT (event_id,source_id,relation_type) DO UPDATE SET updated_at=now()""",
                    (policy.root_event_id, policy.source_id),
                )
            connection.commit()
        return result["crawl_run_id"], result["id"]

    def run_budget_stop_reason(self, crawl_run_id: UUID) -> str | None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """SELECT pages_fetched,pages_unchanged,pages_failed,pages_blocked,bytes_fetched,started_at,policy_snapshot
                FROM ingestion.crawl_run WHERE id=%s""",
                (crawl_run_id,),
            )
            row = cursor.fetchone()
        if not row:
            return "RUN_NOT_FOUND"
        policy = row["policy_snapshot"] or {}
        if int(row["pages_fetched"] or 0) + int(row["pages_unchanged"] or 0) + int(row["pages_failed"] or 0) + int(row["pages_blocked"] or 0) >= int(policy.get("max_pages_per_run", 100)):
            return "MAX_PAGES_REACHED"
        if int(row["bytes_fetched"] or 0) >= int(policy.get("max_bytes_per_run", 262_144_000)):
            return "MAX_BYTES_REACHED"
        if row["started_at"]:
            elapsed = (datetime.now(timezone.utc) - row["started_at"]).total_seconds()
            if elapsed >= int(policy.get("max_runtime_seconds", 1800)):
                return "MAX_RUNTIME_REACHED"
        return None

    def run_remaining_bytes(self, crawl_run_id: UUID) -> int:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT bytes_fetched,policy_snapshot FROM ingestion.crawl_run WHERE id=%s", (crawl_run_id,))
            row = cursor.fetchone()
        if not row:
            return 0
        maximum = int((row["policy_snapshot"] or {}).get("max_bytes_per_run", 262_144_000))
        return max(0, maximum - int(row["bytes_fetched"] or 0))

    @staticmethod
    def _ensure_animecons_event(cursor, batch: ExtractionBatch, source_id: UUID) -> UUID | None:
        record = next((item for item in batch.source_records if item.get("record_type") == "EVENT_CANDIDATE"), None)
        if not record or not record.get("external_event_id") or not record.get("name"):
            return None
        external_id = str(record["external_event_id"])
        metadata = {
            "animecons_event_id": external_id,
            "animecons_url": record.get("source_url"),
            "discovered_venue": record.get("venue"),
            "discovered_location": record.get("location"),
            "discovered_by": "animecons",
        }
        cursor.execute("SELECT id FROM event.event WHERE metadata->>'animecons_event_id'=%s LIMIT 1", (external_id,))
        existing = cursor.fetchone()
        if existing:
            event_id = existing["id"]
            cursor.execute(
                """UPDATE event.event SET
                  start_at=COALESCE(start_at,NULLIF(%s,'')::timestamptz),
                  end_at=COALESCE(end_at,NULLIF(%s,'')::timestamptz),
                  official_url=COALESCE(NULLIF(official_url,''),NULLIF(%s,'')),
                  metadata=metadata || %s::jsonb,
                  enrichment_state=CASE WHEN NULLIF(%s,'') IS NOT NULL THEN 'OFFICIAL_SITE_PENDING' ELSE enrichment_state END,
                  updated_at=now()
                WHERE id=%s""",
                (record.get("start_date"), record.get("end_date"), record.get("official_website"), json.dumps(metadata), record.get("official_website"), event_id),
            )
        else:
            event_id = uuid4()
            cursor.execute(
                """INSERT INTO event.event(
                  id,event_type,canonical_name,start_at,end_at,timezone,official_url,status,metadata,data_origin,enrichment_state
                ) VALUES (
                  %s,'CONVENTION',%s,NULLIF(%s,'')::timestamptz,NULLIF(%s,'')::timestamptz,'UTC',NULLIF(%s,''),'ACTIVE',%s::jsonb,'LIVE',%s
                )""",
                (event_id, record["name"], record.get("start_date"), record.get("end_date"), record.get("official_website"), json.dumps(metadata), "OFFICIAL_SITE_PENDING" if record.get("official_website") else "DISCOVERED"),
            )
        cursor.execute(
            """INSERT INTO event.event_text(event_id,locale,field_type,value,provider,confidence,is_primary)
            SELECT %s,'en','TITLE',%s,'ANIMECONS',0.99,true
            WHERE NOT EXISTS (SELECT 1 FROM event.event_text WHERE event_id=%s AND field_type='TITLE' AND value=%s)""",
            (event_id, record["name"], event_id, record["name"]),
        )
        cursor.execute(
            """INSERT INTO event.event_link(event_id,link_type,provider,url,active)
            SELECT %s,'SOURCE','ANIMECONS',%s,true
            WHERE NOT EXISTS (SELECT 1 FROM event.event_link WHERE event_id=%s AND provider='ANIMECONS' AND url=%s)""",
            (event_id, record.get("source_url"), event_id, record.get("source_url")),
        )
        cursor.execute(
            """INSERT INTO ingestion.event_source(event_id,source_id,relation_type,confidence)
            VALUES (%s,%s,'DISCOVERY',1)
            ON CONFLICT (event_id,source_id,relation_type) DO UPDATE SET updated_at=now()""",
            (event_id, source_id),
        )
        return event_id

    def skip_job_for_budget(self, job: dict[str, Any], reason: str) -> int:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """WITH skipped AS (
                  UPDATE ingestion.job SET status='SUCCEEDED',completed_at=now(),finished_at=now(),
                    lease_expires_at=NULL,last_error_code=%s
                  WHERE crawl_run_id=%s
                    AND (id=%s OR (status IN ('QUEUED','RETRY_WAIT') AND (%s <> 'MAX_PAGES_REACHED' OR job_type <> 'MEDIA_FETCH')))
                  RETURNING id
                ) SELECT count(*)::integer AS count FROM skipped""",
                (reason, job["crawl_run_id"], job["id"], reason),
            )
            skipped_count = int(cursor.fetchone()["count"])
            cursor.execute(
                """UPDATE ingestion.crawl_run SET budget_stop_reason=%s,
                status=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN 'RUNNING' ELSE CASE WHEN pages_fetched>0 THEN 'PARTIAL' ELSE 'COMPLETED' END END,
                finished_at=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN NULL ELSE now() END
                WHERE id=%s""",
                (reason, job["crawl_run_id"], job["id"], job["crawl_run_id"], job["id"], job["crawl_run_id"]),
            )
            connection.commit()
            return skipped_count

    def register_worker(self, worker_name: str, worker_version: str) -> UUID:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO ingestion.worker(worker_name, worker_type, capabilities, status, last_heartbeat_at, metadata)
                VALUES (%s,'INGESTION','["SCRAPLING_HTTP","SCRAPLING_BROWSER","R2_WRITE","HTML_PARSE","PDF_TEXT_EXTRACT"]'::jsonb,'ONLINE',now(),jsonb_build_object('version',%s::text))
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
                  WHERE job_type IN ('SOURCE_DISCOVERY','URL_FETCH','DOCUMENT_EXTRACT','MEDIA_FETCH','MEDIA_ANALYZE','SOURCE_REPLAY','SOURCE_HEALTH_CHECK')
                    AND (
                      (status IN ('QUEUED','RETRY_WAIT') AND COALESCE(not_before, available_at) <= now())
                      OR (status='RUNNING' AND lease_expires_at < now())
                    )
                  ORDER BY CASE priority WHEN 'REALTIME' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'NORMAL' THEN 2 ELSE 3 END, created_at
                  FOR UPDATE SKIP LOCKED
                  LIMIT 1
                )
                UPDATE ingestion.job j
                SET status='RUNNING', lease_owner=%s,
                    lease_expires_at=now()+(%s || ' seconds')::interval,
                    started_at=COALESCE(started_at,now()), attempt_count=attempt_count+1
                FROM next_job
                WHERE j.id=next_job.id
                RETURNING j.*
                """,
                (worker_name, lease_seconds),
            )
            row = cursor.fetchone()
            if row:
                cursor.execute("UPDATE ingestion.crawl_run SET status='RUNNING',started_at=COALESCE(started_at,now()) WHERE id=%s", (row["crawl_run_id"],))
            connection.commit()
            return row

    def find_document_version(self, source_id: UUID, canonical_url: str, content_hash: str) -> dict[str, Any] | None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT * FROM ingestion.raw_document WHERE source_id=%s AND canonical_url=%s AND content_hash=%s ORDER BY fetched_at DESC LIMIT 1",
                (source_id, canonical_url, content_hash),
            )
            return cursor.fetchone()

    def find_media_asset(self, content_hash: str) -> dict[str, Any] | None:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT id,r2_bucket,r2_key FROM media.asset WHERE sha256=%s AND r2_bucket IS NOT NULL AND r2_key IS NOT NULL LIMIT 1", (content_hash,))
            return cursor.fetchone()

    def persist_media_unchanged(self, job: dict[str, Any], result, existing: dict[str, Any], asset: dict[str, Any], *, width: int | None, height: int | None, perceptual_hash: str | None) -> dict[str, Any]:
        payload = job["payload"]
        root_event_id, category = payload.get("root_event_id"), payload.get("category", "OTHER")
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """INSERT INTO ingestion.fetch_attempt(crawl_run_id,source_id,requested_url,final_url,status_code,fetch_mode_used,content_type,content_length,body_r2_key,fetched_at,duration_ms,content_sha256)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                (job["crawl_run_id"], job["source_id"], result.requested_url, result.final_url, result.status_code, result.mode, result.content_type, len(result.body), asset["r2_key"], result.fetched_at, result.duration_ms, existing["content_hash"]),
            )
            cursor.execute(
                """UPDATE ingestion.media_candidate SET storage_mode='R2_RAW',r2_bucket=%s,r2_key=%s,fetch_status='FETCHED',mime_type=%s,width=%s,height=%s,byte_size=%s,sha256=%s,perceptual_hash=%s WHERE id=%s""",
                (asset["r2_bucket"], asset["r2_key"], result.content_type, width, height, len(result.body), existing["content_hash"], perceptual_hash, payload.get("media_candidate_id")),
            )
            if root_event_id:
                cursor.execute(
                    """INSERT INTO media.assignment(asset_id,event_id,role,is_default_internal,is_primary_public,pinned,priority_score,metadata)
                    VALUES (%s,%s,%s,false,false,false,%s,%s::jsonb) ON CONFLICT DO NOTHING""",
                    (asset["id"], root_event_id, category, {"EVENT_HERO": 90, "EVENT_POSTER": 80, "EVENT_LOGO": 60, "MAP": 20}.get(category, 30), json.dumps({"crawl_run_id": str(job["crawl_run_id"]), "deduplicated": True})),
                )
                cursor.execute("SELECT asset_id FROM media.assignment WHERE event_id=%s AND pinned AND is_default_internal ORDER BY priority_score DESC NULLS LAST LIMIT 1", (root_event_id,))
                pinned = cursor.fetchone()
                if pinned:
                    selected = pinned["asset_id"]
                else:
                    cursor.execute("SELECT asset_id FROM media.assignment WHERE event_id=%s ORDER BY CASE role WHEN 'EVENT_HERO' THEN 1 WHEN 'EVENT_POSTER' THEN 2 WHEN 'EVENT_LOGO' THEN 3 ELSE 9 END,priority_score DESC NULLS LAST,created_at LIMIT 1", (root_event_id,))
                    selected = cursor.fetchone()["asset_id"]
                    cursor.execute("UPDATE media.assignment SET is_default_internal=(asset_id=%s),updated_at=now() WHERE event_id=%s AND NOT pinned", (selected, root_event_id))
                cursor.execute("UPDATE event.event SET internal_cover_asset_id=%s,enrichment_state='ENRICHED',updated_at=now() WHERE id=%s", (selected, root_event_id))
            cursor.execute("UPDATE ingestion.job SET status='SUCCEEDED',completed_at=now(),finished_at=now(),lease_expires_at=NULL WHERE id=%s", (job["id"],))
            cursor.execute(
                """UPDATE ingestion.crawl_run SET media_discovered=media_discovered+1,bytes_fetched=bytes_fetched+%s,
                status=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN 'RUNNING' ELSE 'COMPLETED' END,
                finished_at=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN NULL ELSE now() END WHERE id=%s""",
                (len(result.body), job["crawl_run_id"], job["id"], job["crawl_run_id"], job["id"], job["crawl_run_id"]),
            )
            connection.commit()
        return {"raw_document_id": existing["id"], "asset_id": asset["id"]}

    def persist_unchanged(self, job: dict[str, Any], result, existing: dict[str, Any]) -> None:
        fetch_attempt_id = uuid4()
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO ingestion.fetch_attempt(
                  id,crawl_run_id,source_id,requested_url,final_url,status_code,fetch_mode_used,
                  request_headers_redacted,response_headers_redacted,content_type,encoding,content_length,
                  body_r2_key,fetched_at,duration_ms,etag,last_modified,content_sha256
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (fetch_attempt_id, job["crawl_run_id"], job["source_id"], result.requested_url, result.final_url,
                 result.status_code, result.mode, json.dumps(result.request_headers_redacted), json.dumps(result.response_headers_redacted),
                 result.content_type, result.encoding, len(result.body), existing["r2_key"], result.fetched_at,
                 result.duration_ms, result.etag, result.last_modified, existing["content_hash"]),
            )
            cursor.execute("UPDATE ingestion.discovered_url SET fetched_raw_document_id=%s,decision='ALREADY_KNOWN',decision_reason='content hash unchanged' WHERE crawl_run_id=%s AND normalized_url=%s", (existing["id"], job["crawl_run_id"], result.final_url))
            cursor.execute("UPDATE ingestion.job SET status='SUCCEEDED',completed_at=now(),finished_at=now(),lease_expires_at=NULL WHERE id=%s", (job["id"],))
            cursor.execute("""UPDATE ingestion.crawl_run SET status=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN 'RUNNING' ELSE 'COMPLETED' END,
                started_at=COALESCE(started_at,now()),finished_at=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN NULL ELSE now() END,pages_unchanged=pages_unchanged+%s WHERE id=%s""", (job["crawl_run_id"], job["id"], job["crawl_run_id"], job["id"], 1 if job["job_type"] == "URL_FETCH" else 0, job["crawl_run_id"]))
            cursor.execute(
                """INSERT INTO ingestion.source_sync_state(source_id,last_fetch_at,last_success_at,last_content_hash,status,updated_at)
                VALUES (%s,now(),now(),%s,'IDLE',now()) ON CONFLICT (source_id) DO UPDATE SET
                last_fetch_at=now(),last_success_at=now(),last_content_hash=EXCLUDED.last_content_hash,status='IDLE',updated_at=now()""",
                (job["source_id"], existing["content_hash"]),
            )
            connection.commit()

    def persist_document_success(
        self,
        job: dict[str, Any],
        result,
        document: FetchedDocument,
        batch: ExtractionBatch,
        *,
        bucket: str,
        reused: bool = False,
    ) -> tuple[FetchedDocument, ExtractionBatch]:
        document_type = "HTML" if "html" in result.content_type else "JSON" if "json" in result.content_type else "PDF" if "pdf" in result.content_type else "IMAGE" if result.content_type.startswith("image/") else "TEXT" if result.content_type.startswith("text/") else "OTHER"
        # The same content may be observed in multiple runs. Each run needs a
        # distinct extraction row even when the object-store blob is shared.
        external_document_id = hashlib.sha256(f"{result.final_url}\x1f{document.content_sha256}\x1f{job['crawl_run_id']}".encode()).hexdigest()
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT root_event_id,pages_scheduled,policy_snapshot FROM ingestion.crawl_run WHERE id=%s FOR UPDATE",
                (job["crawl_run_id"],),
            )
            run = cursor.fetchone()
            root_event_id = run["root_event_id"]
            max_pages = int((run["policy_snapshot"] or {}).get("max_pages_per_run", 100))
            remaining_page_slots = max(0, max_pages - int(run["pages_scheduled"] or 0))
            if batch.connector_key == "animecons":
                root_event_id = self._ensure_animecons_event(cursor, batch, job["source_id"]) or root_event_id
                if root_event_id:
                    document = document.model_copy(update={"root_event_id": root_event_id})
            cursor.execute(
                """
                INSERT INTO ingestion.fetch_attempt(
                  id,crawl_run_id,source_id,requested_url,final_url,status_code,fetch_mode_used,
                  request_headers_redacted,response_headers_redacted,content_type,encoding,content_length,
                  body_r2_key,fetched_at,duration_ms,etag,last_modified,content_sha256,blocked_reason
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (document.fetch_attempt_id, job["crawl_run_id"], job["source_id"], result.requested_url, result.final_url,
                 result.status_code, result.mode, json.dumps(result.request_headers_redacted), json.dumps(result.response_headers_redacted),
                 result.content_type, result.encoding, len(result.body), document.body_r2_key, result.fetched_at,
                 result.duration_ms, result.etag, result.last_modified, document.content_sha256, result.blocked_reason),
            )
            cursor.execute(
                """
                INSERT INTO ingestion.raw_document(
                  id,source_id,external_document_id,document_type,canonical_url,title,text_preview,fetched_at,
                  content_hash,mime_type,r2_key,r2_bucket,metadata,processing_status,crawl_run_id,fetch_attempt_id,
                  connector_key,connector_version,extraction_version,root_event_id,page_type,language,charset,
                  http_status,byte_size,etag,last_modified
                ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,'PROCESSING',%s,%s,%s,%s,'1.0.0',%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (document.raw_document_id, job["source_id"], external_document_id, document_type, result.final_url,
                 next((str(record.get("title")) for record in batch.source_records if record.get("title")), None),
                 (batch.document_chunks[0].content[:500] if batch.document_chunks else ""), result.fetched_at,
                 document.content_sha256, result.content_type, document.body_r2_key, bucket,
                 json.dumps({"status_code": result.status_code, "fetch_mode": result.mode, "depth": document.depth, "quality_signals": batch.quality_signals, "warnings": batch.warnings, "captured_xhr": result.captured_xhr, "reused_object": reused}),
                 job["crawl_run_id"], document.fetch_attempt_id, batch.connector_key, batch.connector_version,
                 root_event_id, str(document.page_type), None, result.encoding, result.status_code, len(result.body),
                 result.etag, result.last_modified),
            )
            for chunk in batch.document_chunks:
                cursor.execute(
                    """INSERT INTO ingestion.document_chunk(raw_document_id,root_event_id,source_id,chunk_index,heading_path,content,language,char_start,char_end,metadata)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""",
                    (document.raw_document_id, root_event_id, job["source_id"], chunk.chunk_index, chunk.heading_path,
                     chunk.content, chunk.language, chunk.char_start, chunk.char_end, json.dumps(chunk.metadata)),
                )
            cursor.execute(
                """INSERT INTO ingestion.candidate(candidate_type,raw_document_id,job_id,payload,confidence,status,published_event_id,reviewed_at)
                VALUES (%s,%s,%s,%s::jsonb,%s,CASE WHEN %s::uuid IS NULL THEN 'PENDING' ELSE 'APPROVED' END,%s::uuid,CASE WHEN %s::uuid IS NULL THEN NULL ELSE now() END)""",
                ("ANIMECONS_EVENT" if batch.connector_key == "animecons" else "DOCUMENT_EXTRACTION", document.raw_document_id, job["id"], batch.model_dump_json(), batch.quality_signals.get("completeness", 0), root_event_id, root_event_id, root_event_id),
            )
            for assertion in batch.assertions:
                cursor.execute(
                    """INSERT INTO ingestion.assertion(subject_type,subject_id,subject_external_key,field_path,value_json,normalized_value_json,source_id,raw_document_id,crawl_run_id,confidence,observed_at,valid_from,valid_to,status,content_hash,evidence_locator,evidence_excerpt)
                    VALUES ('EVENT',%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,'ACTIVE',%s,%s,%s)""",
                    (root_event_id, assertion.subject_external_key, assertion.field_path, json.dumps(assertion.value), json.dumps(assertion.normalized_value),
                     job["source_id"], document.raw_document_id, job["crawl_run_id"], assertion.confidence, assertion.observed_at,
                     assertion.valid_from, assertion.valid_until, hashlib.sha256(assertion.model_dump_json().encode()).hexdigest(),
                     assertion.evidence_locator, assertion.evidence_excerpt),
                )
            scheduled_links = 0
            for link in batch.discovered_links:
                cursor.execute(
                    """INSERT INTO ingestion.discovered_url(crawl_run_id,source_id,root_event_id,parent_raw_document_id,discovered_url,normalized_url,anchor_text,link_kind,page_hint,priority_score,decision,decision_reason,metadata)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
                    ON CONFLICT (crawl_run_id,normalized_url) DO UPDATE SET priority_score=GREATEST(ingestion.discovered_url.priority_score,EXCLUDED.priority_score),decision=EXCLUDED.decision,decision_reason=EXCLUDED.decision_reason
                    RETURNING id""",
                    (job["crawl_run_id"], job["source_id"], root_event_id, document.raw_document_id, link.url, link.normalized_url,
                     link.anchor_text, str(link.link_kind), str(link.page_hint), link.priority_score, str(link.decision), link.decision_reason, json.dumps(link.metadata)),
                )
                discovered_id = cursor.fetchone()["id"]
                if str(link.link_kind) in {"OFFICIAL_SITE", "X", "INSTAGRAM", "TICKETING", "VENUE", "ORGANIZER"}:
                    cursor.execute(
                        """INSERT INTO ingestion.source_candidate(crawl_run_id,root_event_id,discovered_url_id,candidate_type,url,display_name,confidence,status,evidence)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,'PENDING',%s::jsonb) ON CONFLICT DO NOTHING""",
                        (job["crawl_run_id"], root_event_id, discovered_id, str(link.link_kind), link.normalized_url, link.anchor_text or None,
                         min(1, max(0, link.priority_score / 100)), json.dumps({"parent_raw_document_id": str(document.raw_document_id), "reason": link.decision_reason})),
                    )
                if str(link.link_kind) == "OFFICIAL_SITE":
                    auto_approve = bool((job.get("payload") or {}).get("metadata", {}).get("auto_approve_official_site", False))
                    cursor.execute("SELECT id,enabled,terms_review_status,config FROM ingestion.source WHERE lower(base_url)=lower(%s) LIMIT 1", (link.normalized_url,))
                    official_source = cursor.fetchone()
                    if official_source and auto_approve and (not official_source.get("enabled") or official_source.get("terms_review_status") != "REVIEWED_ALLOWED"):
                        cursor.execute(
                            """UPDATE ingestion.source SET enabled=true,terms_review_status='REVIEWED_ALLOWED',terms_reviewed_at=now(),
                            terms_review_note='Inherited explicit approval from AnimeCons seed workflow',updated_at=now() WHERE id=%s
                            RETURNING id,enabled,terms_review_status,config""",
                            (official_source["id"],),
                        )
                        official_source = cursor.fetchone()
                    if not official_source:
                        source_id = uuid4()
                        host = __import__("urllib.parse", fromlist=["urlsplit"]).urlsplit(link.normalized_url).hostname or ""
                        cursor.execute(
                            """INSERT INTO ingestion.source(id,name,source_type,connector_key,base_url,trust_level,priority,enabled,config,officiality,robots_mode,terms_review_status,terms_review_note,allowed_domains,default_fetch_mode,data_origin)
                            VALUES (%s,%s,'OFFICIAL_WEBSITE','website',%s,'OFFICIAL','HIGH',%s,%s::jsonb,'FIRST_PARTY','ENFORCE',%s,%s,%s,'HTTP','LIVE')""",
                            (source_id, f"Official site · {host}", link.normalized_url, auto_approve,
                             json.dumps({"seed_urls": [link.normalized_url], "root_event_id": str(root_event_id) if root_event_id else None}),
                             "REVIEWED_ALLOWED" if auto_approve else "UNKNOWN", "Inherited explicit approval from seed workflow" if auto_approve else "Discovered from AnimeCons; policy review required", [host]),
                        )
                        official_source = {"id": source_id, "enabled": auto_approve, "terms_review_status": "REVIEWED_ALLOWED" if auto_approve else "UNKNOWN", "config": {"seed_urls": [link.normalized_url], "root_event_id": str(root_event_id) if root_event_id else None}}
                    cursor.execute("UPDATE ingestion.source_candidate SET created_source_id=%s WHERE crawl_run_id=%s AND candidate_type='OFFICIAL_SITE' AND url=%s", (official_source["id"], job["crawl_run_id"], link.normalized_url))
                    if root_event_id:
                        cursor.execute("INSERT INTO ingestion.event_source(event_id,source_id,relation_type,discovered_url_id,confidence) VALUES (%s,%s,'OFFICIAL_WEBSITE',%s,1) ON CONFLICT DO NOTHING", (root_event_id, official_source["id"], discovered_id))
                    if root_event_id and official_source.get("enabled") and official_source.get("terms_review_status") == "REVIEWED_ALLOWED":
                        follow_run_id, follow_job_id = uuid4(), uuid4()
                        follow_dedupe = f"official-follow:{job['crawl_run_id']}:{official_source['id']}:{root_event_id}"
                        follow_payload = {
                            "source_id": str(official_source["id"]), "url": link.normalized_url, "canonical_url": link.normalized_url,
                            "page_type": "OVERVIEW", "depth": 0, "dedupe_key": hashlib.sha256(f"{official_source['id']}:{link.normalized_url}".encode()).hexdigest(), "priority": "HIGH",
                        }
                        cursor.execute(
                            """INSERT INTO ingestion.crawl_run(id,source_id,trigger,connector_key,connector_version,worker_version,policy_snapshot,status,pages_scheduled,root_event_id,root_url,config_snapshot,job_id)
                            VALUES (%s,%s,'DISCOVERY','website','1.0.0','discovery-follow-on',%s::jsonb,'QUEUED',1,%s,%s,%s::jsonb,%s)
                            ON CONFLICT DO NOTHING""",
                            (follow_run_id, official_source["id"], json.dumps({"enabled": True, "terms_review_status": "REVIEWED_ALLOWED", "max_pages_per_run": 100, "max_bytes_per_run": 262144000, "max_runtime_seconds": 1800}), root_event_id, link.normalized_url, json.dumps(official_source.get("config") or {}), follow_job_id),
                        )
                        cursor.execute(
                            """INSERT INTO ingestion.job(id,job_type,required_capability,status,priority,dedupe_key,payload,source_id,crawl_run_id,available_at,not_before,max_attempts)
                            VALUES (%s,'URL_FETCH','INGESTION','QUEUED','HIGH',%s,%s::jsonb,%s,%s,now(),now(),4)
                            ON CONFLICT (dedupe_key) DO NOTHING""",
                            (follow_job_id, follow_dedupe, json.dumps(follow_payload), official_source["id"], follow_run_id),
                        )
            for outbound in batch.outbound_links:
                if remaining_page_slots <= 0:
                    cursor.execute(
                        """UPDATE ingestion.discovered_url SET decision='DEFER',decision_reason='run page budget exhausted before scheduling'
                        WHERE crawl_run_id=%s AND normalized_url=%s AND fetched_raw_document_id IS NULL""",
                        (job["crawl_run_id"], outbound.canonical_url),
                    )
                    continue
                cursor.execute(
                    """INSERT INTO ingestion.job(id,job_type,required_capability,status,priority,dedupe_key,payload,source_id,crawl_run_id,available_at,not_before,max_attempts)
                    VALUES (%s,'URL_FETCH','INGESTION','QUEUED',%s,%s,%s::jsonb,%s,%s,now(),now(),4) ON CONFLICT (dedupe_key) DO NOTHING""",
                    (uuid4(), outbound.priority, f"crawl:{job['crawl_run_id']}:{outbound.dedupe_key}", outbound.model_dump_json(), job["source_id"], job["crawl_run_id"]),
                )
                scheduled_links += cursor.rowcount
                remaining_page_slots -= cursor.rowcount
            for media in batch.media_candidates:
                cursor.execute(
                    """INSERT INTO ingestion.media_candidate(raw_document_id,source_id,crawl_run_id,root_event_id,source_url,resolved_url,owner_hint_type,owner_hint_external_key,category,storage_mode,usage_scope,license_status,source_signals,classification_score,classification_reasons,attribution)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'REMOTE','INTERNAL_ONLY','UNKNOWN',%s::jsonb,%s,%s,%s)
                    ON CONFLICT (raw_document_id,resolved_url,category) DO UPDATE SET classification_score=EXCLUDED.classification_score RETURNING id""",
                    (document.raw_document_id, job["source_id"], job["crawl_run_id"], root_event_id, media.source_url, media.resolved_url,
                     media.owner_hint_type, media.owner_hint_external_key, media.category, json.dumps(media.source_signals), media.classification_score,
                     media.classification_reasons, media.attribution),
                )
                media_id = cursor.fetchone()["id"]
                if media.classification_score >= 0 and media.category != "SITE_ICON":
                    media_payload = {"url": media.resolved_url, "canonical_url": media.resolved_url, "source_id": str(job["source_id"]), "media_candidate_id": str(media_id), "category": media.category, "root_event_id": str(root_event_id) if root_event_id else None, "parent_raw_document_id": str(document.raw_document_id)}
                    cursor.execute(
                        """INSERT INTO ingestion.job(id,job_type,required_capability,status,priority,dedupe_key,payload,source_id,crawl_run_id,raw_document_id,available_at,not_before,max_attempts)
                        VALUES (%s,'MEDIA_FETCH','INGESTION','QUEUED','NORMAL',%s,%s::jsonb,%s,%s,%s,now(),now(),3) ON CONFLICT (dedupe_key) DO NOTHING""",
                        (uuid4(), f"media:{job['crawl_run_id']}:{hashlib.sha256(media.resolved_url.encode()).hexdigest()}", json.dumps(media_payload), job["source_id"], job["crawl_run_id"], document.raw_document_id),
                    )
            logo_status = batch.quality_signals.get("logo_discovery_status", "NOT_FOUND")
            cursor.execute("UPDATE ingestion.raw_document SET processing_status='EXTRACTED' WHERE id=%s", (document.raw_document_id,))
            cursor.execute("UPDATE ingestion.discovered_url SET fetched_raw_document_id=%s WHERE crawl_run_id=%s AND normalized_url=%s", (document.raw_document_id, job["crawl_run_id"], result.final_url))
            cursor.execute("UPDATE ingestion.job SET status='SUCCEEDED',completed_at=now(),finished_at=now(),lease_expires_at=NULL WHERE id=%s", (job["id"],))
            cursor.execute(
                """UPDATE ingestion.crawl_run SET status=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN 'RUNNING' ELSE 'COMPLETED' END,
                started_at=COALESCE(started_at,now()),finished_at=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN NULL ELSE now() END,
                pages_fetched=pages_fetched+%s,pages_unchanged=pages_unchanged+%s,pages_scheduled=pages_scheduled+%s,bytes_fetched=bytes_fetched+%s,documents_created=documents_created+1,
                assertions_emitted=assertions_emitted+%s,candidates_emitted=candidates_emitted+1,media_discovered=media_discovered+%s,
                logos_discovered=logos_discovered+%s,warnings_count=warnings_count+%s,logo_discovery_status=%s WHERE id=%s""",
                (job["crawl_run_id"], job["id"], job["crawl_run_id"], job["id"], 0 if reused else 1, 1 if reused else 0, scheduled_links, len(result.body), len(batch.assertions),
                 len(batch.media_candidates), sum(1 for item in batch.media_candidates if item.category.endswith("LOGO")), len(batch.warnings), logo_status, job["crawl_run_id"]),
            )
            cursor.execute("""INSERT INTO ingestion.source_sync_state(source_id,last_fetch_at,last_success_at,last_changed_at,last_content_hash,status,last_error,updated_at)
                VALUES (%s,now(),now(),CASE WHEN %s THEN NULL ELSE now() END,%s,'IDLE',NULL,now()) ON CONFLICT (source_id) DO UPDATE SET last_fetch_at=now(),last_success_at=now(),last_changed_at=CASE WHEN %s THEN ingestion.source_sync_state.last_changed_at ELSE now() END,last_content_hash=EXCLUDED.last_content_hash,status='IDLE',last_error=NULL,updated_at=now()""", (job["source_id"], reused, document.content_sha256, reused))
            if root_event_id:
                cursor.execute("UPDATE event.event SET enrichment_state=CASE WHEN %s='animecons' THEN 'OFFICIAL_SITE_PENDING' ELSE 'OFFICIAL_SITE_CRAWLING' END,updated_at=now() WHERE id=%s", (batch.connector_key, root_event_id))
            connection.commit()
        return document, batch

    def persist_media_success(self, job: dict[str, Any], result, *, raw_document_id: UUID, fetch_attempt_id: UUID, bucket: str, key: str, sha256: str, perceptual_hash: str | None, width: int | None, height: int | None) -> dict[str, Any]:
        payload = job["payload"]
        root_event_id = payload.get("root_event_id")
        category = payload.get("category", "OTHER")
        external_document_id = hashlib.sha256(f"{result.final_url}\x1f{sha256}".encode()).hexdigest()
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("""INSERT INTO ingestion.fetch_attempt(id,crawl_run_id,source_id,requested_url,final_url,status_code,fetch_mode_used,content_type,content_length,body_r2_key,fetched_at,duration_ms,content_sha256)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (fetch_attempt_id, job["crawl_run_id"], job["source_id"], result.requested_url, result.final_url, result.status_code, result.mode, result.content_type, len(result.body), key, result.fetched_at, result.duration_ms, sha256))
            cursor.execute("""INSERT INTO ingestion.raw_document(id,source_id,external_document_id,document_type,canonical_url,fetched_at,content_hash,mime_type,r2_key,r2_bucket,processing_status,crawl_run_id,fetch_attempt_id,connector_key,connector_version,extraction_version,root_event_id,page_type,http_status,byte_size)
                VALUES (%s,%s,%s,'IMAGE',%s,%s,%s,%s,%s,%s,'EXTRACTED',%s,%s,'media','1.0.0','1.0.0',%s,%s,%s,%s)""", (raw_document_id, job["source_id"], external_document_id, result.final_url, result.fetched_at, sha256, result.content_type, key, bucket, job["crawl_run_id"], fetch_attempt_id, root_event_id, category, result.status_code, len(result.body)))
            cursor.execute("""INSERT INTO media.asset(source_id,raw_document_id,origin,source_url,r2_bucket,r2_key,mime_type,byte_size,width,height,sha256,perceptual_hash,detected_category,classification_confidence,usage_scope,rights_status,retention_policy,owner_type,owner_id,metadata,data_origin)
                VALUES (%s,%s,'CRAWLED',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,0.8,'INTERNAL_ONLY','UNKNOWN','KEEP',%s,%s,%s::jsonb,'LIVE')
                ON CONFLICT (sha256) DO UPDATE SET updated_at=now() RETURNING id""", (job["source_id"], raw_document_id, result.final_url, bucket, key, result.content_type, len(result.body), width, height, sha256, perceptual_hash, category, "EVENT" if root_event_id else None, root_event_id, json.dumps({"crawl_run_id": str(job["crawl_run_id"])})))
            asset_id = cursor.fetchone()["id"]
            cursor.execute("UPDATE ingestion.media_candidate SET storage_mode='R2_RAW',r2_bucket=%s,r2_key=%s,fetch_status='FETCHED',mime_type=%s,width=%s,height=%s,byte_size=%s,sha256=%s,perceptual_hash=%s WHERE id=%s", (bucket, key, result.content_type, width, height, len(result.body), sha256, perceptual_hash, payload.get("media_candidate_id")))
            if root_event_id:
                cursor.execute("""INSERT INTO media.assignment(asset_id,event_id,role,is_default_internal,is_primary_public,pinned,priority_score,metadata)
                    VALUES (%s,%s,%s,false,false,false,%s,%s::jsonb) ON CONFLICT DO NOTHING""", (asset_id, root_event_id, category, {"EVENT_HERO": 90, "EVENT_POSTER": 80, "EVENT_LOGO": 60, "MAP": 20}.get(category, 30), json.dumps({"crawl_run_id": str(job["crawl_run_id"])})))
                cursor.execute("SELECT asset_id FROM media.assignment WHERE event_id=%s AND pinned AND is_default_internal ORDER BY priority_score DESC NULLS LAST LIMIT 1", (root_event_id,))
                pinned = cursor.fetchone()
                if pinned:
                    selected = pinned["asset_id"]
                else:
                    cursor.execute("""SELECT asset_id FROM media.assignment WHERE event_id=%s ORDER BY CASE role WHEN 'EVENT_HERO' THEN 1 WHEN 'EVENT_POSTER' THEN 2 WHEN 'EVENT_LOGO' THEN 3 ELSE 9 END,priority_score DESC NULLS LAST,created_at LIMIT 1""", (root_event_id,))
                    selected = cursor.fetchone()["asset_id"]
                    cursor.execute("UPDATE media.assignment SET is_default_internal=(asset_id=%s),updated_at=now() WHERE event_id=%s AND NOT pinned", (selected, root_event_id))
                cursor.execute("UPDATE event.event SET internal_cover_asset_id=%s,enrichment_state='ENRICHED',updated_at=now() WHERE id=%s", (selected, root_event_id))
            cursor.execute("UPDATE ingestion.job SET status='SUCCEEDED',completed_at=now(),finished_at=now(),lease_expires_at=NULL WHERE id=%s", (job["id"],))
            cursor.execute("""UPDATE ingestion.crawl_run SET media_discovered=media_discovered+1,bytes_fetched=bytes_fetched+%s,documents_created=documents_created+1,
                status=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN 'RUNNING' ELSE 'COMPLETED' END,
                finished_at=CASE WHEN EXISTS(SELECT 1 FROM ingestion.job WHERE crawl_run_id=%s AND id<>%s AND job_type IN ('URL_FETCH','MEDIA_FETCH') AND status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')) THEN NULL ELSE now() END WHERE id=%s""",
                (len(result.body), job["crawl_run_id"], job["id"], job["crawl_run_id"], job["id"], job["crawl_run_id"]))
            connection.commit()
            return {"raw_document_id": raw_document_id, "asset_id": asset_id}

    def persist_auxiliary_document(self, job: dict[str, Any], url: str, status_code: int, content_type: str, body: bytes, raw_document_id: UUID, bucket: str, key: str, content_hash: str, chunks, assertions=(), page_type="OTHER", *, reused: bool = False) -> None:
        document_type = "JSON" if "json" in content_type else "TEXT" if content_type.startswith("text/") else "OTHER"
        external_document_id = hashlib.sha256(f"{url}\x1f{content_hash}\x1f{job['crawl_run_id']}".encode()).hexdigest()
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT root_event_id FROM ingestion.crawl_run WHERE id=%s", (job["crawl_run_id"],))
            root_event_id = cursor.fetchone()["root_event_id"]
            cursor.execute(
                """INSERT INTO ingestion.raw_document(id,source_id,external_document_id,document_type,canonical_url,text_preview,fetched_at,content_hash,mime_type,r2_key,r2_bucket,metadata,processing_status,crawl_run_id,connector_key,connector_version,extraction_version,root_event_id,page_type,http_status,byte_size)
                VALUES (%s,%s,%s,%s,%s,%s,now(),%s,%s,%s,%s,%s::jsonb,'EXTRACTED',%s,'captured_xhr','1.0.0','1.0.0',%s,%s,%s,%s)""",
                (raw_document_id, job["source_id"], external_document_id, document_type, url, body[:500].decode("utf-8", errors="replace"), content_hash, content_type, key, bucket, json.dumps({"captured_xhr": True, "structured_assertions": len(assertions), "reused_object": reused}), job["crawl_run_id"], root_event_id, str(page_type), status_code, len(body)),
            )
            for chunk in chunks:
                cursor.execute("INSERT INTO ingestion.document_chunk(raw_document_id,root_event_id,source_id,chunk_index,heading_path,content,language,char_start,char_end,metadata) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)", (raw_document_id, root_event_id, job["source_id"], chunk.chunk_index, chunk.heading_path, chunk.content, chunk.language, chunk.char_start, chunk.char_end, json.dumps({"captured_xhr": True})))
            for assertion in assertions:
                cursor.execute(
                    """INSERT INTO ingestion.assertion(subject_type,subject_id,subject_external_key,field_path,value_json,normalized_value_json,source_id,raw_document_id,crawl_run_id,confidence,observed_at,valid_from,valid_to,status,content_hash,evidence_locator,evidence_excerpt)
                    VALUES ('EVENT',%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s,%s,%s,%s,'ACTIVE',%s,%s,%s)""",
                    (root_event_id, assertion.subject_external_key, assertion.field_path, json.dumps(assertion.value), json.dumps(assertion.normalized_value), job["source_id"], raw_document_id, job["crawl_run_id"], assertion.confidence, assertion.observed_at, assertion.valid_from, assertion.valid_until, hashlib.sha256(assertion.model_dump_json().encode()).hexdigest(), assertion.evidence_locator, assertion.evidence_excerpt),
                )
            cursor.execute("UPDATE ingestion.crawl_run SET documents_created=documents_created+1,bytes_fetched=bytes_fetched+%s WHERE id=%s", (len(body), job["crawl_run_id"]))
            connection.commit()

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
            scheduled_links = 0
            for outbound in batch.outbound_links:
                child_job_id = uuid4()
                cursor.execute(
                    """
                    INSERT INTO ingestion.job(
                      id,job_type,required_capability,status,priority,dedupe_key,payload,
                      source_id,crawl_run_id,available_at,not_before,max_attempts
                    ) VALUES (%s,'URL_FETCH','INGESTION','QUEUED',%s,%s,%s::jsonb,%s,%s,now(),now(),4)
                    ON CONFLICT (dedupe_key) DO NOTHING
                    """,
                    (
                        child_job_id,
                        outbound.priority,
                        f"crawl:{job['crawl_run_id']}:{outbound.dedupe_key}",
                        outbound.model_dump_json(),
                        job["source_id"],
                        job["crawl_run_id"],
                    ),
                )
                scheduled_links += cursor.rowcount
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
                UPDATE ingestion.crawl_run r SET
                  status=CASE WHEN EXISTS (
                    SELECT 1 FROM ingestion.job pending
                    WHERE pending.crawl_run_id=r.id AND pending.id<>%s
                      AND pending.job_type IN ('URL_FETCH','MEDIA_FETCH')
                      AND pending.status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')
                  ) THEN 'RUNNING' ELSE 'SUCCEEDED' END,
                  started_at=COALESCE(started_at,now()),
                  finished_at=CASE WHEN EXISTS (
                    SELECT 1 FROM ingestion.job pending
                    WHERE pending.crawl_run_id=r.id AND pending.id<>%s
                      AND pending.job_type IN ('URL_FETCH','MEDIA_FETCH')
                      AND pending.status IN ('QUEUED','RETRY_WAIT','LEASED','RUNNING')
                  ) THEN NULL ELSE now() END,
                  pages_fetched=pages_fetched+1, bytes_fetched=bytes_fetched+%s,
                  assertions_emitted=assertions_emitted+%s, candidates_emitted=candidates_emitted+1,
                  media_discovered=media_discovered+%s, logos_discovered=logos_discovered+%s,
                  warnings_count=warnings_count+%s, logo_discovery_status=%s
                WHERE id=%s
                """,
                (job["id"], job["id"], len(result.body), len(batch.assertions), len(batch.media_candidates), sum(1 for item in batch.media_candidates if item.category.endswith("LOGO")), len(batch.warnings), logo_status, job["crawl_run_id"]),
            )
            if scheduled_links:
                cursor.execute(
                    "UPDATE ingestion.crawl_run SET pages_scheduled=pages_scheduled+%s WHERE id=%s",
                    (scheduled_links, job["crawl_run_id"]),
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
        permanent = str(error) in {"HTTP_404", "HTTP_410"} or isinstance(error, (KeyError, ValueError))
        terminal = permanent or job["attempt_count"] >= job["max_attempts"]
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
            cursor.execute("""UPDATE ingestion.crawl_run SET status=CASE WHEN %s THEN CASE WHEN pages_fetched>0 THEN 'PARTIAL' ELSE 'FAILED' END ELSE 'RUNNING' END,
                pages_failed=pages_failed+1,warnings_count=warnings_count+1,finished_at=CASE WHEN %s THEN now() ELSE finished_at END,
                error_summary=error_summary || jsonb_build_object(%s::text,jsonb_build_object('class',%s::text,'message',%s::text)) WHERE id=%s""",
                (terminal, terminal, str(job["id"]), type(error).__name__, str(error)[:500], job["crawl_run_id"]),
            )
            connection.commit()

    def get_raw_document(self, raw_document_id: UUID) -> dict[str, Any]:
        with self.connect() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT * FROM ingestion.raw_document WHERE id=%s", (raw_document_id,))
            row = cursor.fetchone()
        if not row:
            raise KeyError(f"Raw document not found: {raw_document_id}")
        return row
