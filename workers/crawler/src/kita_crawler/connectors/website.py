from __future__ import annotations

import json
import re
from collections.abc import Iterable
from urllib.parse import urljoin, urlsplit

from scrapling.parser import Selector

from ..models import (
    Assertion,
    CrawlRequest,
    ExtractionBatch,
    FetchMode,
    FetchModeHint,
    FetchPlan,
    FetchedDocument,
    MediaCandidate,
    PageType,
    SourcePolicy,
)
from ..safety import canonicalize_url, stable_key


def _first(values: Iterable[str | None]) -> str | None:
    return next((value.strip() for value in values if value and value.strip()), None)


def _jsonld_nodes(selector: Selector) -> list[dict]:
    nodes: list[dict] = []
    for raw in selector.css('script[type="application/ld+json"]::text').getall():
        try:
            value = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        candidates = value if isinstance(value, list) else value.get("@graph", [value]) if isinstance(value, dict) else []
        nodes.extend(item for item in candidates if isinstance(item, dict))
    return nodes


def _types(node: dict) -> set[str]:
    value = node.get("@type", [])
    return {str(item) for item in (value if isinstance(value, list) else [value])}


class OfficialWebsiteConnector:
    key = "website"
    version = "1.0.0"

    async def seed_requests(self, policy: SourcePolicy) -> list[CrawlRequest]:
        seeds = policy.configuration.get("seed_urls") or [policy.base_url]
        return [
            CrawlRequest(
                source_id=policy.source_id,
                url=str(url),
                canonical_url=canonicalize_url(str(url)),
                page_type=PageType.LISTING,
                dedupe_key=stable_key(str(policy.source_id), canonicalize_url(str(url))),
                render_selector=policy.configuration.get("render_selector"),
                capture_xhr_patterns=policy.configuration.get("capture_xhr_patterns", []),
                locale_hint=policy.configuration.get("locale", "en-US"),
            )
            for url in seeds
        ]

    async def select_fetch_plan(self, request: CrawlRequest, policy: SourcePolicy) -> FetchPlan:
        if request.fetch_mode_hint == FetchModeHint.STEALTH:
            return FetchPlan(mode=FetchMode.STEALTH, escalation_reason="connector_requested_stealth")
        if request.fetch_mode_hint == FetchModeHint.DYNAMIC or policy.default_fetch_mode == FetchMode.DYNAMIC:
            return FetchPlan(mode=FetchMode.DYNAMIC, escalation_reason="source_dynamic_contract")
        return FetchPlan(mode=FetchMode.HTTP)

    async def extract(self, document: FetchedDocument, policy: SourcePolicy) -> ExtractionBatch:
        selector = Selector(document.body.decode(document.encoding or "utf-8", errors="replace"), url=document.final_url)
        jsonld = _jsonld_nodes(selector)
        event_node = next((node for node in jsonld if "Event" in _types(node)), None)
        organization_node = next((node for node in jsonld if {"Organization", "Brand"} & _types(node)), None)
        og_title = selector.css('meta[property="og:title"]::attr(content)').get()
        title = _first([
            str(event_node.get("name")) if event_node and event_node.get("name") else None,
            og_title,
            selector.css("title::text").get(),
            selector.css("h1::text").get(),
        ])
        subject_key = canonicalize_url(document.final_url)
        assertions: list[Assertion] = []
        if title:
            assertions.append(Assertion(subject_external_key=subject_key, field_path="title", value=title, normalized_value=title.strip(), confidence=0.98 if event_node else 0.82, evidence_locator="jsonld:Event.name" if event_node else "meta[property=og:title]"))
        description = _first([
            str(event_node.get("description")) if event_node and event_node.get("description") else None,
            selector.css('meta[property="og:description"]::attr(content)').get(),
            selector.css('meta[name="description"]::attr(content)').get(),
        ])
        if description:
            assertions.append(Assertion(subject_external_key=subject_key, field_path="description", value=description, normalized_value=description.strip(), confidence=0.88, evidence_locator="structured-description", evidence_excerpt=description[:240]))
        for field in ("startDate", "endDate"):
            if event_node and event_node.get(field):
                assertions.append(Assertion(subject_external_key=subject_key, field_path="start_at" if field == "startDate" else "end_at", value=event_node[field], normalized_value=event_node[field], confidence=0.96, evidence_locator=f"jsonld:Event.{field}"))
        if event_node and event_node.get("location"):
            assertions.append(Assertion(subject_external_key=subject_key, field_path="location", value=event_node["location"], normalized_value=event_node["location"], confidence=0.90, evidence_locator="jsonld:Event.location"))

        media: list[MediaCandidate] = []
        seen: set[tuple[str, str]] = set()

        def add_media(raw_url: str | None, category: str, score: int, reason: str, signals: dict | None = None) -> None:
            if not raw_url:
                return
            resolved = urljoin(document.final_url, raw_url)
            key = (resolved, category)
            if key in seen:
                return
            seen.add(key)
            media.append(MediaCandidate(
                source_url=raw_url,
                resolved_url=resolved,
                owner_hint_type="EVENT" if event_node else "ORGANIZATION" if organization_node else "UNKNOWN",
                owner_hint_external_key=subject_key,
                category=category,
                classification_score=score,
                classification_reasons=[reason],
                source_signals=signals or {},
            ))

        for node in jsonld:
            node_types = _types(node)
            logo = node.get("logo")
            if logo:
                logo_url = logo.get("url") if isinstance(logo, dict) else logo
                add_media(str(logo_url), "EVENT_LOGO" if "Event" in node_types else "ORGANIZATION_LOGO", 100, "first-party structured logo field", {"jsonld_types": sorted(node_types)})
            image = node.get("image")
            images = image if isinstance(image, list) else [image] if image else []
            for item in images:
                image_url = item.get("url") if isinstance(item, dict) else item
                add_media(str(image_url), "EVENT_HERO" if "Event" in node_types else "OTHER", 70, "structured image field", {"jsonld_types": sorted(node_types)})
        add_media(selector.css('meta[property="og:image"]::attr(content)').get(), "EVENT_HERO", 45, "OpenGraph image")
        for element in selector.css("header img, nav img, img[class*=logo], img[id*=logo]"):
            src = element.attrib.get("src") or element.attrib.get("data-src")
            alt = element.attrib.get("alt", "")
            score = 60 + (25 if "logo" in f"{src} {alt}".lower() else 0)
            add_media(src, "ORGANIZATION_LOGO", score, "header brand context", {"alt": alt})
        for link in selector.css('link[rel~="icon"]::attr(href), link[rel="apple-touch-icon"]::attr(href)').getall():
            add_media(link, "SITE_ICON", -40, "favicon-only signal")

        outbound: list[CrawlRequest] = []
        patterns = re.compile(r"/(event|events|news|press|media|program|schedule)/", re.I)
        host = urlsplit(document.final_url).hostname
        if document.status_code < 400:
            for href in selector.css("a::attr(href)").getall():
                resolved = canonicalize_url(urljoin(document.final_url, href))
                if urlsplit(resolved).hostname == host and patterns.search(urlsplit(resolved).path):
                    outbound.append(CrawlRequest(source_id=policy.source_id, url=resolved, canonical_url=resolved, page_type=PageType.EVENT if "/event" in resolved else PageType.OTHER, parent_request_id=None, depth=1, dedupe_key=stable_key(str(policy.source_id), resolved)))
                if len(outbound) >= min(policy.max_pages_per_run - 1, 24):
                    break
        completeness = len({item.field_path for item in assertions} & {"title", "start_at", "location"}) / 3
        warnings = []
        if not title:
            warnings.append("missing_event_identity")
        if document.blocked_reason:
            warnings.append(document.blocked_reason)
        return ExtractionBatch(
            connector_key=self.key,
            connector_version=self.version,
            raw_document_id=document.raw_document_id,
            source_records=[{"external_key": subject_key, "page_type": "EVENT" if event_node else "OTHER", "title": title}],
            assertions=assertions,
            outbound_links=outbound,
            media_candidates=media,
            warnings=warnings,
            quality_signals={
                "event_jsonld": bool(event_node),
                "completeness": completeness,
                "logo_discovery_status": "LOGO_FOUND" if any(item.category.endswith("LOGO") for item in media) else "LOGO_NOT_FOUND",
            },
        )

