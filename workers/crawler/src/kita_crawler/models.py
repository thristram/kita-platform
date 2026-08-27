from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", use_enum_values=True)


class FetchMode(StrEnum):
    HTTP = "HTTP"
    DYNAMIC = "DYNAMIC"
    STEALTH = "STEALTH"


class FetchModeHint(StrEnum):
    AUTO = "AUTO"
    HTTP = "HTTP"
    DYNAMIC = "DYNAMIC"
    STEALTH = "STEALTH"


class PageType(StrEnum):
    LISTING = "LISTING"
    EVENT = "EVENT"
    ORGANIZATION = "ORGANIZATION"
    VENUE = "VENUE"
    PRESS = "PRESS"
    MEDIA_KIT = "MEDIA_KIT"
    OTHER = "OTHER"


class SourcePolicy(StrictModel):
    source_id: UUID
    name: str
    base_url: str
    connector_key: str = "website"
    connector_version: str = "1.0.0"
    enabled: bool = False
    robots_mode: str = "ENFORCE"
    terms_review_status: str = "UNKNOWN"
    contact_identity: str | None = None
    allowed_domains: list[str] = Field(default_factory=list)
    allowed_path_prefixes: list[str] = Field(default_factory=lambda: ["/"])
    denied_path_prefixes: list[str] = Field(default_factory=list)
    max_depth: int = 2
    max_pages_per_run: int = 100
    max_bytes_per_run: int = 262_144_000
    max_runtime_seconds: int = 1800
    http_requests_per_minute: int = 30
    http_concurrency_per_domain: int = 2
    browser_requests_per_minute: int = 6
    browser_concurrency_per_domain: int = 1
    default_fetch_mode: FetchMode = FetchMode.HTTP
    allow_stealth: bool = False
    allow_authenticated_session: bool = False
    store_html: bool = True
    store_screenshot_policy: str = "ON_FAILURE"
    timezone: str = "UTC"
    configuration: dict[str, Any] = Field(default_factory=dict)


class CrawlRequest(StrictModel):
    request_id: UUID = Field(default_factory=uuid4)
    source_id: UUID
    url: str
    canonical_url: str
    page_type: PageType = PageType.OTHER
    parent_request_id: UUID | None = None
    depth: int = 0
    method: str = "GET"
    headers: dict[str, str] = Field(default_factory=dict)
    body: bytes | None = None
    dedupe_key: str
    expected_content_types: list[str] = Field(default_factory=lambda: ["text/html"])
    fetch_mode_hint: FetchModeHint = FetchModeHint.AUTO
    render_wait: str = "DOM_CONTENT_LOADED"
    render_selector: str | None = None
    capture_xhr_patterns: list[str] = Field(default_factory=list)
    locale_hint: str | None = None
    not_before: datetime | None = None
    priority: str = "NORMAL"
    metadata: dict[str, Any] = Field(default_factory=dict)


class FetchPlan(StrictModel):
    mode: FetchMode
    escalation_reason: str | None = None
    timeout_seconds: int = 30


class FetchResult(StrictModel):
    requested_url: str
    final_url: str
    status_code: int
    mode: FetchMode
    request_headers_redacted: dict[str, str] = Field(default_factory=dict)
    response_headers_redacted: dict[str, str] = Field(default_factory=dict)
    content_type: str = "application/octet-stream"
    encoding: str | None = None
    body: bytes
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    duration_ms: int
    etag: str | None = None
    last_modified: str | None = None
    blocked_reason: str | None = None
    screenshot: bytes | None = None
    captured_xhr: list[dict[str, Any]] = Field(default_factory=list)


class FetchedDocument(StrictModel):
    raw_document_id: UUID
    source_id: UUID
    crawl_run_id: UUID
    fetch_attempt_id: UUID
    requested_url: str
    final_url: str
    status_code: int
    fetch_mode_used: FetchMode
    content_type: str
    encoding: str | None = None
    content_length: int
    body_r2_key: str
    screenshot_r2_key: str | None = None
    xhr_manifest_r2_key: str | None = None
    fetched_at: datetime
    duration_ms: int
    etag: str | None = None
    last_modified: str | None = None
    content_sha256: str
    blocked_reason: str | None = None
    body: bytes = Field(exclude=True)


class Assertion(StrictModel):
    subject_external_key: str
    field_path: str
    value: Any
    normalized_value: Any = None
    confidence: float = 0.8
    evidence_locator: str
    evidence_excerpt: str = ""
    observed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    valid_from: datetime | None = None
    valid_until: datetime | None = None


class MediaCandidate(StrictModel):
    source_url: str
    resolved_url: str
    owner_hint_type: str = "UNKNOWN"
    owner_hint_external_key: str | None = None
    category: str = "OTHER"
    storage_mode: str = "REMOTE"
    usage_scope: str = "INTERNAL"
    license_status: str = "UNKNOWN"
    mime_type: str | None = None
    width: int | None = None
    height: int | None = None
    byte_size: int | None = None
    aspect_ratio: float | None = None
    has_alpha: bool | None = None
    sha256: str | None = None
    perceptual_hash: str | None = None
    source_signals: dict[str, Any] = Field(default_factory=dict)
    classification_score: float = 0
    classification_reasons: list[str] = Field(default_factory=list)
    attribution: str | None = None


class ExtractionBatch(StrictModel):
    connector_key: str
    connector_version: str
    schema_version: str = "1.0.0"
    raw_document_id: UUID
    source_records: list[dict[str, Any]] = Field(default_factory=list)
    assertions: list[Assertion] = Field(default_factory=list)
    outbound_links: list[CrawlRequest] = Field(default_factory=list)
    media_candidates: list[MediaCandidate] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    quality_signals: dict[str, Any] = Field(default_factory=dict)

