from __future__ import annotations

import json
import re
from urllib.parse import urljoin, urlsplit

from scrapling.parser import Selector

from ..discovery import enforce_budget
from ..models import Assertion, CrawlRequest, DiscoveryDecision, DiscoveredLink, ExtractionBatch, FetchMode, FetchPlan, FetchedDocument, LinkKind, PageType, SourcePolicy
from ..safety import canonicalize_url, stable_key
from ..text_extraction import extract_text_chunks


def _text(selector: Selector, *queries: str) -> str | None:
    for query in queries:
        values = selector.css(query).getall()
        value = " ".join(str(item).strip() for item in values if str(item).strip())
        if value:
            return re.sub(r"\s+", " ", value).strip()
    return None


class AnimeConsConnector:
    key = "animecons"
    version = "1.1.1"

    async def seed_requests(self, policy: SourcePolicy):
        seeds = policy.configuration.get("seed_urls") or [policy.base_url]
        follow_official_sites = bool(policy.configuration.get("follow_official_sites", False))
        discover_linked_events = bool(policy.configuration.get("discover_linked_events", True))
        return [
            CrawlRequest(
                source_id=policy.source_id,
                url=url,
                canonical_url=canonicalize_url(url),
                page_type=PageType.EVENT if re.search(r"/events/info/\d+", str(url)) else PageType.LISTING,
                dedupe_key=stable_key(str(policy.source_id), canonicalize_url(url)),
                metadata={
                    "auto_approve_official_site": follow_official_sites,
                    "discover_linked_events": discover_linked_events,
                },
            )
            for url in seeds
        ]

    async def select_fetch_plan(self, request, policy):
        del request
        if policy.default_fetch_mode == FetchMode.STEALTH and policy.allow_stealth:
            return FetchPlan(mode=FetchMode.STEALTH, escalation_reason="approved_animecons_source_profile")
        if policy.default_fetch_mode == FetchMode.DYNAMIC:
            return FetchPlan(mode=FetchMode.DYNAMIC, escalation_reason="animecons_source_profile")
        return FetchPlan(mode=FetchMode.HTTP)

    async def extract(self, document: FetchedDocument, policy: SourcePolicy) -> ExtractionBatch:
        selector = Selector(document.body.decode(document.encoding or "utf-8", errors="replace"), url=document.final_url)
        match = re.search(r"/events/info/(\d+)", document.final_url)
        external_id = match.group(1) if match else _text(selector, "[data-event-id]::attr(data-event-id)")
        discover_linked_events = bool(policy.configuration.get("discover_linked_events", True)) and document.depth == 0
        follow_official_sites = bool(policy.configuration.get("follow_official_sites", False))

        event_discoveries: list[DiscoveredLink] = []
        if discover_linked_events:
            seen_event_urls: set[str] = set()
            for anchor in selector.css("a[href]"):
                href = anchor.attrib.get("href", "")
                try:
                    resolved = canonicalize_url(urljoin(document.final_url, href))
                except (ValueError, UnicodeError):
                    continue
                event_match = re.search(r"/events/info/(\d+)(?:/|$)", resolved)
                if not event_match or resolved == canonicalize_url(document.final_url) or resolved in seen_event_urls:
                    continue
                if "animecons.com" not in (urlsplit(resolved).hostname or ""):
                    continue
                seen_event_urls.add(resolved)
                label = " ".join(anchor.css("::text").getall()).strip()
                event_discoveries.append(DiscoveredLink(
                    url=resolved,
                    normalized_url=resolved,
                    anchor_text=label,
                    link_kind=LinkKind.INTERNAL_PAGE,
                    page_hint=PageType.EVENT,
                    priority_score=95,
                    decision=DiscoveryDecision.FETCH,
                    decision_reason="AnimeCons event detail discovered from seed page",
                    metadata={"external_event_id": event_match.group(1), "source_role": "DISCOVERY_EVENT"},
                ))
        event_discoveries = enforce_budget(
            event_discoveries,
            current_depth=document.depth,
            max_depth=policy.max_depth,
            remaining_pages=max(0, policy.max_pages_per_run - 1),
        )
        outbound = [
            CrawlRequest(
                source_id=policy.source_id,
                url=link.normalized_url,
                canonical_url=link.normalized_url,
                page_type=PageType.EVENT,
                depth=document.depth + 1,
                dedupe_key=stable_key(str(policy.source_id), link.normalized_url),
                priority="HIGH",
                metadata={
                    "auto_approve_official_site": follow_official_sites,
                    "discover_linked_events": discover_linked_events,
                    "external_event_id": link.metadata.get("external_event_id"),
                },
            )
            for link in event_discoveries
            if link.decision == DiscoveryDecision.FETCH
        ]

        if not external_id:
            title = _text(selector, "h1::text", "title::text")
            return ExtractionBatch(
                connector_key=self.key,
                connector_version=self.version,
                raw_document_id=document.raw_document_id,
                source_records=[{"record_type": "EVENT_LISTING", "source_url": document.final_url, "title": title, "events_discovered": len(event_discoveries)}],
                outbound_links=outbound,
                discovered_links=event_discoveries,
                document_chunks=extract_text_chunks(document.body, document.content_type, document.encoding),
                quality_signals={"listing": True, "events_discovered": len(event_discoveries), "completeness": 1 if event_discoveries else 0},
                warnings=[] if event_discoveries else ["animecons_event_links_not_found"],
            )
        jsonld = None
        for raw in selector.css('script[type="application/ld+json"]::text').getall():
            try:
                parsed = json.loads(raw)
            except Exception:
                continue
            nodes = parsed.get("@graph", [parsed]) if isinstance(parsed, dict) else parsed if isinstance(parsed, list) else []
            jsonld = next((node for node in nodes if isinstance(node, dict) and "Event" in ([node.get("@type")] if isinstance(node.get("@type"), str) else node.get("@type", []))), None)
            if jsonld:
                break
        title = str(jsonld.get("name")) if jsonld and jsonld.get("name") else _text(selector, "h1::text", ".event-name::text", "title::text")
        start_date = str(jsonld.get("startDate")) if jsonld and jsonld.get("startDate") else _text(selector, "time[itemprop=startDate]::attr(datetime)", "[data-field=start-date]::text")
        end_date = str(jsonld.get("endDate")) if jsonld and jsonld.get("endDate") else _text(selector, "time[itemprop=endDate]::attr(datetime)", "[data-field=end-date]::text")
        venue = _text(selector, "[itemprop=location] [itemprop=name]::text", ".venue::text", "[data-field=venue]::text")
        location = _text(selector, ".event-location::text", "[data-field=location]::text", "[itemprop=address]::text")
        official_url = None
        for anchor in selector.css("a[href]"):
            href = anchor.attrib.get("href", "")
            label = " ".join(anchor.css("::text").getall()).strip().lower()
            resolved = canonicalize_url(urljoin(document.final_url, href)) if href.startswith(("http", "/")) else ""
            host = urlsplit(resolved).hostname or ""
            if resolved and "animecons.com" not in host and ("official" in label or "website" in label or anchor.attrib.get("itemprop") == "url"):
                official_url = resolved
                break
        subject_key = f"animecons:event:{external_id}"
        assertions: list[Assertion] = []
        for field, value, confidence in (("title", title, 0.99), ("start_at", start_date, 0.97), ("end_at", end_date, 0.97), ("venue", venue, 0.9), ("location", location, 0.9), ("official_url", official_url, 0.95)):
            if value:
                assertions.append(Assertion(subject_external_key=subject_key, field_path=field, value=value, normalized_value=value, confidence=confidence, evidence_locator=f"animecons:{field}", evidence_excerpt=str(value)[:240]))
        discoveries = list(event_discoveries)
        if official_url:
            discoveries.append(DiscoveredLink(
                url=official_url,
                normalized_url=official_url,
                anchor_text="Official website",
                link_kind=LinkKind.OFFICIAL_SITE,
                page_hint=PageType.OVERVIEW,
                priority_score=100,
                decision=DiscoveryDecision.FETCH if follow_official_sites else DiscoveryDecision.REVIEW_REQUIRED,
                decision_reason="official website approved for bounded follow-on crawl" if follow_official_sites else "official website discovered by AnimeCons; approval required",
                metadata={"external_event_id": external_id, "source_role": "FIRST_PARTY_EVENT", "inherited_policy_approval": follow_official_sites},
            ))
        return ExtractionBatch(
            connector_key=self.key,
            connector_version=self.version,
            raw_document_id=document.raw_document_id,
            source_records=[{"record_type": "EVENT_CANDIDATE", "external_event_id": external_id, "source_url": document.final_url, "name": title, "title": title, "start_date": start_date, "end_date": end_date, "venue": venue, "location": location, "official_website": official_url}],
            assertions=assertions,
            outbound_links=outbound,
            discovered_links=discoveries,
            document_chunks=extract_text_chunks(document.body, document.content_type, document.encoding),
            quality_signals={"external_event_id": external_id, "official_website_discovered": bool(official_url), "completeness": len([value for value in (title, start_date, location, official_url) if value]) / 4},
            warnings=[] if official_url else ["official_website_not_found"],
        )
