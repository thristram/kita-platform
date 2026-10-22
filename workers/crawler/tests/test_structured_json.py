from __future__ import annotations

import json

from kita_crawler.models import PageType
from kita_crawler.structured_json import extract_json_assertions


def test_recovers_nested_graphql_schedule_records() -> None:
    body = json.dumps({"data": {"event": {"sessions": [
        {"sessionId": "s1", "name": "Opening Ceremony", "startTime": "2026-10-09T09:00:00-04:00", "roomName": "Main Stage", "description": "Welcome"},
        {"sessionId": "s2", "title": "Cosplay Contest", "start": "2026-10-09T14:00:00-04:00", "location": "Ballroom"},
    ]}}}).encode()
    assertions = extract_json_assertions(body, PageType.SCHEDULE, "event", "https://api.example.test/graphql")
    assert len(assertions) == 1
    assert assertions[0].field_path == "content.sessions"
    assert [record["title"] for record in assertions[0].value] == ["Opening Ceremony", "Cosplay Contest"]


def test_does_not_guess_sessions_on_unrelated_page() -> None:
    body = json.dumps({"items": [{"name": "Opening Ceremony", "start": "tomorrow"}]}).encode()
    assert extract_json_assertions(body, PageType.OTHER, "event", "https://api.example.test/data") == []
