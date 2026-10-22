from __future__ import annotations

from uuid import uuid4

from kita_crawler.dynamic_content import assess_dynamic_content
from kita_crawler.models import Assertion, ExtractionBatch, PageType


def batch(*fields: str) -> ExtractionBatch:
    return ExtractionBatch(
        connector_key="website",
        connector_version="1.0.0",
        raw_document_id=uuid4(),
        assertions=[Assertion(subject_external_key="event", field_path=field, value=[], evidence_locator="fixture") for field in fields],
    )


def test_aloompa_schedule_shell_escalates_to_browser() -> None:
    body = b"""<html><body><main><aloompa-embed event-id='123'></aloompa-embed></main>
    <script src='https://cdn.aloompa.com/embed.js'></script></body></html>"""
    result = assess_dynamic_content(body, PageType.SCHEDULE, batch("title"), "https://example.com/schedule/")
    assert result.should_escalate is True
    assert result.provider == "aloompa"
    assert "missing_expected_records:content.sessions" in result.reasons


def test_complete_static_schedule_does_not_escalate() -> None:
    body = b"<html><body><main><article><h2>Opening Ceremony</h2></article></main></body></html>"
    result = assess_dynamic_content(body, PageType.SCHEDULE, batch("content.sessions"), "https://example.com/schedule/")
    assert result.should_escalate is False


def test_generic_react_shell_on_semantic_url_escalates() -> None:
    body = b"<html><body><div id='root'>Loading...</div><script src='1.js'></script><script src='2.js'></script><script src='3.js'></script></body></html>"
    result = assess_dynamic_content(body, PageType.OTHER, batch("title"), "https://example.com/programming")
    assert result.should_escalate is True
    assert "semantic_page_without_structured_content" in result.reasons
