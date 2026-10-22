from __future__ import annotations

import json
from collections.abc import Iterable

from .models import Assertion, PageType
from .safety import stable_key


def _first(record: dict, keys: Iterable[str]):
    for key in keys:
        value = record.get(key)
        if value not in (None, "", [], {}):
            return value
    return None


def _text(value: object) -> str:
    if isinstance(value, dict):
        value = _first(value, ("name", "title", "label", "value"))
    return str(value or "").strip()


def _arrays(value: object, path: str = "$"):
    if isinstance(value, list):
        yield path, value
        for index, item in enumerate(value[:2_000]):
            yield from _arrays(item, f"{path}[{index}]")
    elif isinstance(value, dict):
        for key, item in list(value.items())[:500]:
            yield from _arrays(item, f"{path}.{key}")


def _session(record: dict, base_url: str) -> dict | None:
    title = _text(_first(record, ("title", "name", "eventName", "sessionName", "activityName", "label")))
    start = _first(record, ("startDate", "start_date", "startTime", "start_time", "startsAt", "start", "begin", "from"))
    room = _text(_first(record, ("room", "roomName", "location", "locationName", "venue", "venueName", "track")))
    if not title or not (start or room):
        return None
    external = _text(_first(record, ("id", "uuid", "externalId", "eventId", "sessionId", "slug"))) or stable_key(title, _text(start), room)
    return {
        "externalKey": external, "title": title,
        "description": _text(_first(record, ("description", "summary", "details", "body", "abstract"))),
        "startDate": start, "endDate": _first(record, ("endDate", "end_date", "endTime", "end_time", "endsAt", "end", "to")),
        "venueName": _text(_first(record, ("venueName", "venue"))), "room": room,
        "url": _first(record, ("url", "link", "permalink")),
        "imageUrl": _first(record, ("imageUrl", "image", "thumbnail", "photo")),
        "organizationNames": [], "participantNames": [], "sourceUrl": base_url,
    }


def _exhibitor(record: dict, base_url: str) -> dict | None:
    name = _text(_first(record, ("name", "title", "companyName", "exhibitorName", "vendorName", "organization")))
    booth = _text(_first(record, ("booth", "boothNumber", "booth_number", "location", "stand")))
    website = _first(record, ("websiteUrl", "website", "url", "link"))
    if not name or not (booth or website or _first(record, ("categories", "category", "description"))):
        return None
    external = _text(_first(record, ("id", "uuid", "externalId", "exhibitorId", "vendorId", "slug"))) or stable_key(name, booth, str(website or ""))
    categories = _first(record, ("categories", "category", "tags")) or []
    if not isinstance(categories, list):
        categories = [categories]
    return {
        "externalKey": external, "name": name,
        "description": _text(_first(record, ("description", "summary", "details", "bio"))),
        "booth": booth, "categories": [_text(item) for item in categories if _text(item)],
        "featured": bool(_first(record, ("featured", "isFeatured")) or False), "websiteUrl": website,
        "logoUrl": _first(record, ("logoUrl", "logo", "imageUrl", "image")), "sourceUrl": base_url,
    }


def extract_json_assertions(body: bytes, page_type: PageType, subject_external_key: str, source_url: str) -> list[Assertion]:
    """Recover repeated schedule/exhibitor records from arbitrary XHR/GraphQL JSON.

    This is schema-tolerant rather than event-specific: nested arrays are inspected for
    common record shapes and the original JSON remains the source of truth.
    """
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return []
    wanted_sessions = page_type in {PageType.SCHEDULE, PageType.PROGRAMMING}
    wanted_exhibitors = page_type in {PageType.EXHIBITORS, PageType.VENDORS, PageType.ARTIST_ALLEY}
    sessions: dict[str, dict] = {}
    exhibitors: dict[str, dict] = {}
    for path, values in _arrays(payload):
        if len(values) < 1:
            continue
        for item in values[:2_000]:
            if not isinstance(item, dict):
                continue
            if wanted_sessions:
                record = _session(item, source_url)
                if record:
                    record["jsonPath"] = path
                    sessions.setdefault(str(record["externalKey"]), record)
            if wanted_exhibitors:
                record = _exhibitor(item, source_url)
                if record:
                    record["jsonPath"] = path
                    exhibitors.setdefault(str(record["externalKey"]), record)
    assertions: list[Assertion] = []
    for field, records in (("content.sessions", list(sessions.values())), ("content.exhibitors", list(exhibitors.values()))):
        if records:
            assertions.append(Assertion(
                subject_external_key=subject_external_key,
                field_path=field,
                value=records,
                normalized_value=records,
                confidence=0.88,
                evidence_locator="captured-xhr:json-shape",
                evidence_excerpt=f"Recovered {len(records)} {field.rsplit('.', 1)[-1]} records from captured JSON",
            ))
    return assertions
