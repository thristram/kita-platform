from __future__ import annotations

import re
from dataclasses import dataclass

from .models import ExtractionBatch, PageType


DEFAULT_XHR_PATTERN = r"(?i:graphql|api|ajax|json|data|schedule|session|event|agenda|program|exhibitor|vendor|guest)"


_CONTENT_FIELDS = {
    PageType.SCHEDULE: "content.sessions",
    PageType.PROGRAMMING: "content.sessions",
    PageType.EXHIBITORS: "content.exhibitors",
    PageType.VENDORS: "content.exhibitors",
    PageType.ARTIST_ALLEY: "content.exhibitors",
    PageType.GUESTS: "content.guests",
    PageType.NEWS: "content.updates",
    PageType.ANNOUNCEMENTS: "content.updates",
}

_PROVIDER_MARKERS = {
    "aloompa": (r"aloompa(?:-embed|\.com|_)", "aloompa-embed, [id^='aloompa-']"),
    "sched": (r"(?:sched\.com|sched-embed|data-sched)", "#sched-content, .sched-container, [data-sched]"),
    "eventeny": (r"(?:eventeny\.com|eventeny-widget)", "[class*='eventeny'], [id*='eventeny']"),
    "whova": (r"(?:whova\.com|whova-widget)", "[class*='whova'], [id*='whova']"),
}


@dataclass(frozen=True)
class DynamicAssessment:
    should_escalate: bool
    score: int
    reasons: tuple[str, ...]
    provider: str | None = None
    wait_selector: str | None = None


def assess_dynamic_content(body: bytes, page_type: PageType, batch: ExtractionBatch, url: str) -> DynamicAssessment:
    """Detect an HTML shell or embedded client-side data source without knowing a convention.

    The decision deliberately combines platform markers with extraction completeness. A
    single script tag is not enough to start a browser; a content page that produced no
    matching structured records is a strong signal.
    """
    html = body[:2_000_000].decode("utf-8", errors="replace")
    folded = html.casefold()
    score = 0
    reasons: list[str] = []
    provider = None
    wait_selector = None

    for name, (pattern, selector) in _PROVIDER_MARKERS.items():
        if re.search(pattern, folded):
            provider = name
            wait_selector = selector
            score += 5
            reasons.append(f"embedded_provider:{name}")
            break

    expected_field = _CONTENT_FIELDS.get(page_type)
    fields = {assertion.field_path for assertion in batch.assertions}
    if expected_field and expected_field not in fields:
        score += 4
        reasons.append(f"missing_expected_records:{expected_field}")

    semantic_url = re.search(r"/(schedule|program(?:ming)?|agenda|sessions|exhibitors?|vendors?|guests?|artists?)(?:/|$|[?#])", url, re.I)
    if semantic_url and not any(field.startswith("content.") for field in fields):
        score += 3
        reasons.append("semantic_page_without_structured_content")

    shell_markers = (
        "id=\"__next\"", "id='__next'", "id=\"app\"", "id='app'", "id=\"root\"", "id='root'",
        "data-reactroot", "__next_data__", "__nuxt__", "ng-version", "loading...", "loading&hellip;",
    )
    visible_text = re.sub(r"<script\b[^>]*>.*?</script>|<style\b[^>]*>.*?</style>|<[^>]+>", " ", folded, flags=re.S)
    visible_text = re.sub(r"\s+", " ", visible_text).strip()
    script_count = len(re.findall(r"<script\b", folded))
    if any(marker in folded for marker in shell_markers) and len(visible_text) < 1_200 and script_count >= 3:
        score += 3
        reasons.append("javascript_shell_with_low_visible_text")

    if re.search(r"<(?:[a-z0-9]+-){1,}[a-z0-9-]+\b", folded) and len(visible_text) < 1_500:
        score += 1
        reasons.append("custom_element_shell")

    if re.search(r"<(?:iframe)[^>]+(?:schedule|agenda|program|event)", folded, re.I):
        score += 3
        reasons.append("embedded_schedule_frame")

    return DynamicAssessment(
        should_escalate=score >= 4,
        score=score,
        reasons=tuple(dict.fromkeys(reasons)),
        provider=provider,
        wait_selector=wait_selector,
    )
