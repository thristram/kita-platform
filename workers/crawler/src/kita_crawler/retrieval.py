from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

import psycopg
from psycopg.rows import dict_row

from .storage import ObjectStore


class EvidenceRetrievalService:
    """Bounded retrieval over indexed evidence. This service never lists object-store keys."""

    def __init__(self, database_url: str, raw_store: ObjectStore, media_store: ObjectStore | None = None):
        self.database_url = database_url
        self.raw_store = raw_store
        self.media_store = media_store or raw_store

    def _query(self, statement: str, params: tuple = ()) -> list[dict[str, Any]]:
        with psycopg.connect(self.database_url, row_factory=dict_row) as connection, connection.cursor() as cursor:
            cursor.execute(statement, params)
            return list(cursor.fetchall())

    def search_event_documents(self, event_id: UUID, query: str, *, page_types: list[str] | None = None, source_types: list[str] | None = None, top_k: int = 20) -> list[dict[str, Any]]:
        top_k = max(1, min(top_k, 50))
        return self._query(
            """SELECT c.id AS chunk_id,c.raw_document_id,c.heading_path,c.content,d.canonical_url,d.page_type,d.fetched_at,s.source_type,
            ts_rank_cd(c.search_vector,websearch_to_tsquery('simple',%s)) AS rank
            FROM ingestion.document_chunk c JOIN ingestion.raw_document d ON d.id=c.raw_document_id JOIN ingestion.source s ON s.id=c.source_id
            WHERE c.root_event_id=%s AND c.search_vector @@ websearch_to_tsquery('simple',%s)
              AND (%s::text[] IS NULL OR d.page_type=ANY(%s::text[])) AND (%s::text[] IS NULL OR s.source_type=ANY(%s::text[]))
            ORDER BY rank DESC,d.fetched_at DESC LIMIT %s""",
            (query, event_id, query, page_types, page_types, source_types, source_types, top_k),
        )

    def list_event_documents(self, event_id: UUID, *, page_type: str | None = None, changed_since: datetime | None = None) -> list[dict[str, Any]]:
        return self._query("""SELECT d.id,d.canonical_url,d.document_type,d.page_type,d.title,d.fetched_at,d.content_hash,d.mime_type,d.byte_size,s.name AS source_name
            FROM ingestion.raw_document d JOIN ingestion.source s ON s.id=d.source_id WHERE d.root_event_id=%s
            AND (%s IS NULL OR d.page_type=%s) AND (%s IS NULL OR d.fetched_at>=%s) ORDER BY d.fetched_at DESC LIMIT 500""", (event_id, page_type, page_type, changed_since, changed_since))

    def get_document_metadata(self, raw_document_id: UUID) -> dict[str, Any] | None:
        rows = self._query("""SELECT d.*,s.name AS source_name,r.status AS crawl_status FROM ingestion.raw_document d JOIN ingestion.source s ON s.id=d.source_id LEFT JOIN ingestion.crawl_run r ON r.id=d.crawl_run_id WHERE d.id=%s""", (raw_document_id,))
        return rows[0] if rows else None

    def get_document_chunks(self, raw_document_id: UUID, *, start: int = 0, limit: int = 50) -> list[dict[str, Any]]:
        return self._query("SELECT id,chunk_index,heading_path,content,language,char_start,char_end,metadata FROM ingestion.document_chunk WHERE raw_document_id=%s AND chunk_index>=%s ORDER BY chunk_index LIMIT %s", (raw_document_id, max(0, start), max(1, min(limit, 100))))

    async def get_raw_artifact_url(self, raw_document_id: UUID, ttl_seconds: int = 900) -> str:
        metadata = self.get_document_metadata(raw_document_id)
        if not metadata:
            raise KeyError(f"Raw document not found: {raw_document_id}")
        if metadata["r2_bucket"] != self.raw_store.bucket:
            raise ValueError("Artifact belongs to a storage bucket not available to this service")
        return await self.raw_store.create_signed_get_url(metadata["r2_key"], ttl_seconds)

    def list_event_media(self, event_id: UUID, *, categories: list[str] | None = None, include_inherited: bool = False) -> list[dict[str, Any]]:
        del include_inherited
        return self._query("""SELECT a.id,a.detected_category,a.source_url,a.r2_bucket,a.r2_key,a.mime_type,a.width,a.height,a.usage_scope,a.rights_status,ma.role,ma.is_default_internal,ma.pinned
            FROM media.assignment ma JOIN media.asset a ON a.id=ma.asset_id WHERE ma.event_id=%s AND (%s::text[] IS NULL OR a.detected_category=ANY(%s::text[]))
            ORDER BY ma.pinned DESC,ma.is_default_internal DESC,ma.priority_score DESC NULLS LAST""", (event_id, categories, categories))

    async def get_media_artifact_url(self, media_asset_id: UUID, ttl_seconds: int = 900) -> str:
        rows = self._query("SELECT r2_bucket,r2_key FROM media.asset WHERE id=%s", (media_asset_id,))
        if not rows or not rows[0]["r2_key"]:
            raise KeyError(f"Media asset not found: {media_asset_id}")
        if rows[0]["r2_bucket"] != self.media_store.bucket:
            raise ValueError("Media belongs to a storage bucket not available to this service")
        return await self.media_store.create_signed_get_url(rows[0]["r2_key"], ttl_seconds)

    def list_event_sources(self, event_id: UUID) -> list[dict[str, Any]]:
        return self._query("""SELECT s.id,s.name,s.source_type,s.base_url,s.trust_level,s.enabled,es.relation_type,es.confidence,es.status
            FROM ingestion.event_source es JOIN ingestion.source s ON s.id=es.source_id WHERE es.event_id=%s ORDER BY es.confidence DESC,s.name""", (event_id,))

    def get_source_graph(self, event_id: UUID) -> list[dict[str, Any]]:
        return self._query("""SELECT d.id,d.parent_raw_document_id,d.discovered_url,d.normalized_url,d.anchor_text,d.link_kind,d.page_hint,d.priority_score,d.decision,d.decision_reason,d.fetched_raw_document_id,d.metadata
            FROM ingestion.discovered_url d WHERE d.root_event_id=%s ORDER BY d.discovered_at,d.priority_score DESC""", (event_id,))

    def get_canonical_event_context(self, event_id: UUID) -> dict[str, Any] | None:
        rows = self._query("""SELECT e.id,e.canonical_name,e.event_type,e.start_at,e.end_at,e.timezone,e.official_url,e.status,e.enrichment_state,e.internal_cover_asset_id,v.name AS venue,v.city,v.region,v.country_code
            FROM event.event e LEFT JOIN event.venue v ON v.id=e.venue_id WHERE e.id=%s""", (event_id,))
        return rows[0] if rows else None

    def find_entity_candidates(self, query: str, *, types: list[str] | None = None, top_k: int = 20) -> list[dict[str, Any]]:
        return self._query("""SELECT id,entity_type,canonical_name,summary,similarity(canonical_name,%s) AS score FROM core.entity
            WHERE (%s::text[] IS NULL OR entity_type=ANY(%s::text[])) AND canonical_name %% %s ORDER BY score DESC LIMIT %s""", (query, types, types, query, max(1, min(top_k, 50))))
