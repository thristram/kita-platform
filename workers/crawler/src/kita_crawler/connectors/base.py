from __future__ import annotations

from typing import Protocol

from ..models import CrawlRequest, ExtractionBatch, FetchPlan, FetchedDocument, SourcePolicy


class SourceConnector(Protocol):
    key: str
    version: str

    async def seed_requests(self, policy: SourcePolicy) -> list[CrawlRequest]: ...
    async def select_fetch_plan(self, request: CrawlRequest, policy: SourcePolicy) -> FetchPlan: ...
    async def extract(self, document: FetchedDocument, policy: SourcePolicy) -> ExtractionBatch: ...

