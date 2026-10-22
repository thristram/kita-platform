from __future__ import annotations

import json
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
from ..discovery import classify_link, enforce_budget
from ..dynamic_content import DEFAULT_XHR_PATTERN
from ..safety import canonicalize_url, stable_key
from ..text_extraction import extract_text_chunks


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


def _structured_name(value: object) -> str:
    if isinstance(value, dict):
        return str(value.get("name") or "").strip()
    return str(value or "").strip()


def _structured_url(value: object, base_url: str) -> str | None:
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("url") or value.get("@id")
    return urljoin(base_url, str(value)) if value else None


def _record_key(kind: str, name: str, url: str) -> str:
    return stable_key(kind, name.casefold(), url)


def _jsonld_content(jsonld: list[dict], base_url: str, page_type: PageType) -> dict[str, list[dict]]:
    content: dict[str, list[dict]] = {"sessions": [], "exhibitors": [], "guests": [], "updates": [], "ticket_offers": []}
    for node in jsonld:
        node_types = _types(node)
        name = _structured_name(node.get("name") or node.get("headline"))
        node_url = _structured_url(node.get("url") or node.get("@id"), base_url)
        description = str(node.get("description") or "").strip()
        if "Event" in node_types and name and page_type in {PageType.SCHEDULE, PageType.PROGRAMMING, PageType.EVENT, PageType.OTHER}:
            location = node.get("location")
            offers = node.get("offers")
            performers = node.get("performer") or node.get("performers") or []
            organizers = node.get("organizer") or []
            content["sessions"].append({
                "externalKey": _record_key("session", name, node_url or base_url), "title": name,
                "description": description, "startDate": node.get("startDate"), "endDate": node.get("endDate"),
                "venueName": _structured_name(location), "room": "", "url": node_url,
                "imageUrl": _structured_url(node.get("image"), base_url),
                "organizationNames": [_structured_name(item) for item in (organizers if isinstance(organizers, list) else [organizers]) if _structured_name(item)],
                "participantNames": [_structured_name(item) for item in (performers if isinstance(performers, list) else [performers]) if _structured_name(item)],
            })
            offer_values = offers if isinstance(offers, list) else [offers] if offers else []
            for offer in offer_values:
                if not isinstance(offer, dict):
                    continue
                offer_name = _structured_name(offer.get("name")) or f"{name} tickets"
                content["ticket_offers"].append({
                    "externalKey": _record_key("ticket", offer_name, str(offer.get("url") or base_url)), "name": offer_name,
                    "description": str(offer.get("description") or ""), "purchaseUrl": _structured_url(offer.get("url"), base_url),
                    "priceText": " ".join(str(item) for item in (offer.get("price"), offer.get("priceCurrency")) if item),
                    "availability": str(offer.get("availability") or "").rsplit("/", 1)[-1].upper(),
                    "validFrom": offer.get("validFrom"), "validThrough": offer.get("validThrough"),
                })
        if {"Organization", "Brand"} & node_types and name and page_type in {PageType.EXHIBITORS, PageType.VENDORS, PageType.ARTIST_ALLEY}:
            content["exhibitors"].append({
                "externalKey": _record_key("exhibitor", name, node_url or base_url), "name": name,
                "description": description, "booth": str(node.get("location") or node.get("identifier") or ""),
                "categories": [], "featured": False, "websiteUrl": node_url,
                "logoUrl": _structured_url(node.get("logo") or node.get("image"), base_url),
            })
        if "Person" in node_types and name and page_type in {PageType.GUESTS, PageType.PROGRAMMING, PageType.EVENT}:
            content["guests"].append({
                "externalKey": _record_key("guest", name, node_url or base_url), "name": name,
                "description": description, "role": str(node.get("jobTitle") or ""), "organizationNames": [], "url": node_url,
                "imageUrl": _structured_url(node.get("image"), base_url),
            })
        if {"NewsArticle", "Article", "BlogPosting"} & node_types and name:
            content["updates"].append({
                "externalKey": _record_key("update", name, node_url or base_url), "title": name,
                "summary": description, "publishedAt": node.get("datePublished"), "sourceName": _structured_name(node.get("publisher")),
                "sourceUrl": node_url, "imageUrl": _structured_url(node.get("image"), base_url),
            })
    return content


def _dom_cards(selector: Selector, base_url: str, page_type: PageType) -> list[dict]:
    kind_selectors = {
        PageType.SCHEDULE: "article, [class*=session], [class*=schedule-item], [data-session-id]",
        PageType.PROGRAMMING: "article, [class*=session], [class*=program-item], [data-session-id]",
        PageType.EXHIBITORS: "article, [class*=exhibitor], [class*=vendor], [data-exhibitor-id]",
        PageType.VENDORS: "article, [class*=vendor], [class*=exhibitor], [data-vendor-id]",
        PageType.ARTIST_ALLEY: "article, [class*=artist], [data-artist-id]",
        PageType.GUESTS: "article, [class*=guest], [class*=speaker], [data-guest-id]",
        PageType.NEWS: "article, [class*=news-item], [class*=post-card]",
        PageType.ANNOUNCEMENTS: "article, [class*=announcement], [class*=post-card]",
    }
    card_selector = kind_selectors.get(page_type)
    if not card_selector:
        return []
    records: list[dict] = []
    seen: set[str] = set()
    for element in selector.css(card_selector):
        name = _first(element.css("h1::text, h2::text, h3::text, h4::text, [class*=title]::text, [class*=name]::text").getall())
        if not name:
            continue
        href = element.css("a[href]::attr(href)").get()
        record_url = urljoin(base_url, href) if href else None
        key = _record_key(str(page_type), name, record_url or base_url)
        if key in seen:
            continue
        seen.add(key)
        all_text = " ".join(value.strip() for value in element.css("*::text").getall() if value.strip())
        start = element.css("time::attr(datetime), [data-start]::attr(data-start), [data-start-time]::attr(data-start-time)").get()
        end = element.css("[data-end]::attr(data-end), [data-end-time]::attr(data-end-time)").get()
        image = element.css("img::attr(src), img::attr(data-src)").get()
        records.append({
            "externalKey": key, "name": name, "title": name, "description": all_text[:2000],
            "url": record_url, "startDate": start, "endDate": end,
            "booth": str(element.attrib.get("data-booth") or ""), "room": str(element.attrib.get("data-room") or ""),
            "imageUrl": urljoin(base_url, image) if image else None,
        })
        if len(records) >= 500:
            break
    return records


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

        structured_content = _jsonld_content(jsonld, document.final_url, document.page_type)
        if document.page_type == PageType.EVENT and len(structured_content["sessions"]) == 1:
            structured_content["sessions"] = []
        dom_records = _dom_cards(selector, document.final_url, document.page_type)
        if document.page_type in {PageType.SCHEDULE, PageType.PROGRAMMING}:
            structured_content["sessions"].extend(dom_records)
        elif document.page_type in {PageType.EXHIBITORS, PageType.VENDORS, PageType.ARTIST_ALLEY}:
            structured_content["exhibitors"].extend(dom_records)
        elif document.page_type == PageType.GUESTS:
            structured_content["guests"].extend(dom_records)
        elif document.page_type in {PageType.NEWS, PageType.ANNOUNCEMENTS}:
            structured_content["updates"].extend(dom_records)
        for content_type, records in structured_content.items():
            if records:
                assertions.append(Assertion(
                    subject_external_key=subject_key,
                    field_path=f"content.{content_type}",
                    value=records,
                    normalized_value=records,
                    confidence=0.94 if any(node for node in jsonld if node.get("@type")) else 0.72,
                    evidence_locator=f"structured:{content_type}",
                    evidence_excerpt=f"Extracted {len(records)} {content_type.replace('_', ' ')} records from {document.final_url}",
                ))

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
                if logo_url:
                    add_media(str(logo_url), "EVENT_LOGO" if "Event" in node_types else "ORGANIZATION_LOGO", 100, "first-party structured logo field", {"jsonld_types": sorted(node_types)})
            image = node.get("image")
            images = image if isinstance(image, list) else [image] if image else []
            for item in images:
                image_url = item.get("url") if isinstance(item, dict) else item
                if image_url:
                    add_media(str(image_url), "EVENT_HERO" if "Event" in node_types else "OTHER", 70, "structured image field", {"jsonld_types": sorted(node_types)})
        add_media(selector.css('meta[property="og:image"]::attr(content)').get(), "EVENT_HERO", 45, "OpenGraph image")
        for element in selector.css("header img, nav img, img[class*=logo], img[id*=logo]"):
            src = element.attrib.get("src") or element.attrib.get("data-src")
            alt = element.attrib.get("alt", "")
            score = 60 + (25 if "logo" in f"{src} {alt}".lower() else 0)
            add_media(src, "ORGANIZATION_LOGO", score, "header brand context", {"alt": alt})
        for link in selector.css('link[rel~="icon"]::attr(href), link[rel="apple-touch-icon"]::attr(href)').getall():
            add_media(link, "SITE_ICON", -40, "favicon-only signal")
        for element in selector.css("main img, article img, picture img"):
            src = element.attrib.get("src") or element.attrib.get("data-src")
            alt = element.attrib.get("alt", "")
            signal = f"{src} {alt} {element.attrib.get('class', '')}".lower()
            category = "EVENT_LOGO" if "logo" in signal else "MAP" if "map" in signal or "floor" in signal else "EVENT_POSTER" if "poster" in signal else "EVENT_HERO" if "hero" in signal or "banner" in signal else "OTHER"
            score = 82 if category.endswith("LOGO") else 72 if category != "OTHER" else 25
            add_media(src, category, score, "semantic image context", {"alt": alt})
            srcset = element.attrib.get("srcset", "")
            if srcset:
                largest = srcset.split(",")[-1].strip().split(" ")[0]
                add_media(largest, category, score + 2, "largest srcset candidate", {"alt": alt})

        outbound: list[CrawlRequest] = []
        discovered = []
        if document.status_code < 400:
            for element in selector.css("a[href]"):
                link = classify_link(document.final_url, element.attrib.get("href", ""), " ".join(element.css("::text").getall()).strip(), policy)
                if link:
                    discovered.append(link)
            unique_discoveries = {}
            for link in discovered:
                current = unique_discoveries.get(link.normalized_url)
                if current is None or link.priority_score > current.priority_score:
                    unique_discoveries[link.normalized_url] = link
            discovered = list(unique_discoveries.values())
            discovered = enforce_budget(discovered, current_depth=document.depth, max_depth=policy.max_depth, remaining_pages=max(0, policy.max_pages_per_run - 1))
            depth = document.depth + 1
            for link in discovered:
                if link.decision == "FETCH":
                    outbound.append(CrawlRequest(
                        source_id=policy.source_id,
                        url=link.normalized_url,
                        canonical_url=link.normalized_url,
                        page_type=link.page_hint,
                        parent_request_id=None,
                        depth=depth,
                        dedupe_key=stable_key(str(policy.source_id), link.normalized_url),
                        priority="HIGH" if link.priority_score >= 75 else "NORMAL",
                        expected_content_types=["application/pdf"] if link.link_kind == "PDF" else ["text/html"],
                        fetch_mode_hint=FetchModeHint.AUTO,
                        render_wait="NETWORK_IDLE" if link.page_hint in {PageType.SCHEDULE, PageType.PROGRAMMING, PageType.EXHIBITORS, PageType.VENDORS, PageType.ARTIST_ALLEY, PageType.GUESTS} else "DOM_CONTENT_LOADED",
                        capture_xhr_patterns=[DEFAULT_XHR_PATTERN] if link.page_hint in {PageType.SCHEDULE, PageType.PROGRAMMING, PageType.EXHIBITORS, PageType.VENDORS, PageType.ARTIST_ALLEY, PageType.GUESTS} else [],
                        metadata={"anchor_text": link.anchor_text, "link_kind": link.link_kind, "adaptive_dynamic": True},
                    ))
        content_links = []
        link_types = {
            PageType.TICKETS: "TICKETS", PageType.REGISTRATION: "TICKETS", PageType.SCHEDULE: "SCHEDULE",
            PageType.PROGRAMMING: "SCHEDULE", PageType.EXHIBITORS: "EXHIBITORS", PageType.VENDORS: "EXHIBITORS",
            PageType.ARTIST_ALLEY: "EXHIBITORS", PageType.MAP: "MAP", PageType.NEWS: "UPDATES",
            PageType.ANNOUNCEMENTS: "UPDATES", PageType.POLICIES: "POLICY",
        }
        for link in discovered:
            link_type = link_types.get(link.page_hint)
            if link_type:
                content_links.append({"type": link_type, "label": link.anchor_text, "url": link.normalized_url})
        if content_links:
            assertions.append(Assertion(
                subject_external_key=subject_key, field_path="content.links", value=content_links, normalized_value=content_links,
                confidence=0.86, evidence_locator="dom:navigation-links", evidence_excerpt=f"Extracted {len(content_links)} event content links",
            ))
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
            source_records=[{"external_key": subject_key, "page_type": str(document.page_type), "title": title}],
            assertions=assertions,
            outbound_links=outbound,
            discovered_links=discovered,
            document_chunks=extract_text_chunks(document.body, document.content_type, document.encoding),
            media_candidates=media,
            warnings=warnings,
            quality_signals={
                "event_jsonld": bool(event_node),
                "completeness": completeness,
                "logo_discovery_status": "LOGO_FOUND" if any(item.category.endswith("LOGO") for item in media) else "LOGO_NOT_FOUND",
            },
        )
