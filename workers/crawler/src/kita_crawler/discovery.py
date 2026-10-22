from __future__ import annotations

import re
from urllib.parse import urljoin, urlsplit

from .models import DiscoveryDecision, DiscoveredLink, LinkKind, PageType, SourcePolicy
from .safety import canonicalize_url

HIGH_VALUE: list[tuple[PageType, tuple[str, ...]]] = [
    (PageType.SCHEDULE, ("schedule", "timetable")),
    (PageType.PROGRAMMING, ("program", "programming", "panel", "stage", "workshop", "screening")),
    (PageType.GUESTS, ("guest", "voice-actor", "voice_actor", "seiyuu", "performer", "creator")),
    (PageType.EXHIBITORS, ("exhibitor", "dealer")),
    (PageType.VENDORS, ("vendor", "sponsor")),
    (PageType.ARTIST_ALLEY, ("artist-alley", "artist_alley")),
    (PageType.TICKETS, ("ticket", "badge")),
    (PageType.REGISTRATION, ("registration", "register")),
    (PageType.MAP, ("floor-map", "floor_map", "map", "directions")),
    (PageType.ACCESSIBILITY, ("accessibility",)),
    (PageType.FAQ, ("faq", "hours")),
    (PageType.NEWS, ("news", "announcement", "update")),
    (PageType.PRESS, ("press", "media-kit", "brand-kit")),
    (PageType.ABOUT, ("about", "venue")),
]
LOW_VALUE = ("privacy", "terms", "cookie", "login", "sign-in", "account", "cart", "checkout", "password", "career", "share", "print")
TICKET_HOST_TOKENS = ("ticketmaster", "eventbrite", "showclix", "leapevent", "universe.com", "tickets")


def classify_page(url: str, anchor_text: str = "") -> tuple[PageType, float]:
    haystack = f"{urlsplit(url).path} {anchor_text}".lower().replace(" ", "-")
    for page_type, tokens in HIGH_VALUE:
        if any(token in haystack for token in tokens):
            return page_type, 80.0 if page_type in {PageType.SCHEDULE, PageType.GUESTS, PageType.EXHIBITORS, PageType.TICKETS, PageType.MAP} else 65.0
    return PageType.OVERVIEW if urlsplit(url).path in {"", "/"} else PageType.OTHER, 40.0


def classify_link(base_url: str, href: str, anchor_text: str, policy: SourcePolicy) -> DiscoveredLink | None:
    if not href or href.startswith(("mailto:", "tel:", "javascript:", "data:")):
        return None
    try:
        normalized = canonicalize_url(urljoin(base_url, href))
    except (ValueError, UnicodeError):
        return None
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"http", "https"}:
        return None
    current_host = (urlsplit(base_url).hostname or "").lower()
    host = (parsed.hostname or "").lower()
    page_hint, score = classify_page(normalized, anchor_text)
    haystack = f"{parsed.path} {anchor_text}".lower()
    if any(token in haystack for token in LOW_VALUE):
        return DiscoveredLink(url=urljoin(base_url, href), normalized_url=normalized, anchor_text=anchor_text, link_kind=LinkKind.INTERNAL_PAGE if host == current_host else LinkKind.OTHER_EXTERNAL, page_hint=page_hint, priority_score=-100, decision=DiscoveryDecision.IGNORE, decision_reason="low-value or unsafe workflow")
    if parsed.path.lower().endswith(".pdf"):
        return DiscoveredLink(url=urljoin(base_url, href), normalized_url=normalized, anchor_text=anchor_text, link_kind=LinkKind.PDF, page_hint=PageType.MAP if "map" in haystack else page_hint, priority_score=max(score, 85), decision=DiscoveryDecision.FETCH if host == current_host or host in policy.allowed_domains else DiscoveryDecision.REVIEW_REQUIRED, decision_reason="high-value PDF artifact")
    if host in {"x.com", "twitter.com", "www.x.com", "www.twitter.com"}:
        return DiscoveredLink(url=urljoin(base_url, href), normalized_url=normalized, anchor_text=anchor_text, link_kind=LinkKind.X, page_hint=PageType.OTHER, priority_score=75, decision=DiscoveryDecision.REVIEW_REQUIRED, decision_reason="social account linked by official site")
    if host in {"instagram.com", "www.instagram.com"}:
        return DiscoveredLink(url=urljoin(base_url, href), normalized_url=normalized, anchor_text=anchor_text, link_kind=LinkKind.INSTAGRAM, page_hint=PageType.OTHER, priority_score=75, decision=DiscoveryDecision.REVIEW_REQUIRED, decision_reason="social account linked by official site")
    if any(token in host for token in TICKET_HOST_TOKENS):
        return DiscoveredLink(url=urljoin(base_url, href), normalized_url=normalized, anchor_text=anchor_text, link_kind=LinkKind.TICKETING, page_hint=PageType.TICKETS, priority_score=85, decision=DiscoveryDecision.REVIEW_REQUIRED, decision_reason="ticket provider linked by official site")
    internal = any(host == allowed or host.endswith(f".{allowed}") for allowed in policy.allowed_domains)
    if internal:
        decision = DiscoveryDecision.FETCH if page_hint != PageType.OTHER or score >= 40 else DiscoveryDecision.DEFER
        return DiscoveredLink(url=urljoin(base_url, href), normalized_url=normalized, anchor_text=anchor_text, link_kind=LinkKind.INTERNAL_PAGE, page_hint=page_hint, priority_score=score, decision=decision, decision_reason="allowed first-party page")
    return DiscoveredLink(url=urljoin(base_url, href), normalized_url=normalized, anchor_text=anchor_text, link_kind=LinkKind.OTHER_EXTERNAL, page_hint=page_hint, priority_score=10, decision=DiscoveryDecision.IGNORE, decision_reason="unscoped external link")


def enforce_budget(discoveries: list[DiscoveredLink], *, current_depth: int, max_depth: int, remaining_pages: int) -> list[DiscoveredLink]:
    if current_depth >= max_depth or remaining_pages <= 0:
        return [item.model_copy(update={"decision": DiscoveryDecision.DEFER, "decision_reason": "crawl budget reached"}) if item.decision == DiscoveryDecision.FETCH else item for item in discoveries]
    ranked = sorted(discoveries, key=lambda item: (-item.priority_score, item.normalized_url))
    fetches = 0
    output: list[DiscoveredLink] = []
    for item in ranked:
        if item.decision == DiscoveryDecision.FETCH:
            fetches += 1
            if fetches > remaining_pages:
                item = item.model_copy(update={"decision": DiscoveryDecision.DEFER, "decision_reason": "page budget reached"})
        output.append(item)
    return output
