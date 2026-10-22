from __future__ import annotations

import re
from types import SimpleNamespace
from uuid import uuid4

import pytest

from kita_crawler.config import load_settings
from kita_crawler.dynamic_content import DEFAULT_XHR_PATTERN
from kita_crawler.engine import ScraplingEngine, _capture_xhr_regex
from kita_crawler.models import CrawlRequest, FetchMode, FetchPlan, SourcePolicy


@pytest.mark.asyncio
async def test_cloudflare_verification_page_is_reported_as_blocked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("socket.getaddrinfo", lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))])
    response = SimpleNamespace(
        body=b"<html><title>Just a moment...</title><h1>Performing security verification</h1><p>This website verifies you are not a bot.</p></html>",
        headers={"content-type": "text/html; charset=utf-8"},
        url="https://animecons.com/events/info/26503/fan-expo-canada-2026",
        status=403,
        encoding="utf-8",
        captured_xhr=[],
    )
    monkeypatch.setattr("kita_crawler.engine.Fetcher.get", lambda *_args, **_kwargs: response)
    source_id = uuid4()
    policy = SourcePolicy(source_id=source_id,name="AnimeCons",base_url=response.url,enabled=True,terms_review_status="REVIEWED_ALLOWED",allowed_domains=["animecons.com"])
    request = CrawlRequest(source_id=source_id,url=response.url,canonical_url=response.url,dedupe_key="blocked-fixture")
    result = await ScraplingEngine(load_settings()).fetch(request, FetchPlan(mode=FetchMode.HTTP), policy)
    assert result.status_code == 403
    assert result.blocked_reason == "BLOCKED_ACCESS_CONTROL"


@pytest.mark.asyncio
async def test_embedded_recaptcha_script_does_not_block_normal_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("socket.getaddrinfo", lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))])
    response = SimpleNamespace(
        body=b"""<html><head><title>Anime Expo 2027</title>
        <script src="https://www.gstatic.com/recaptcha/releases/version/recaptcha__en.js"></script>
        </head><body><main><h1>Anime Expo 2027</h1><p>July 2-5, 2027</p></main></body></html>""",
        headers={"content-type": "text/html; charset=utf-8"},
        url="https://www.anime-expo.org/",
        status=200,
        encoding="utf-8",
        captured_xhr=[],
    )
    monkeypatch.setattr("kita_crawler.engine.Fetcher.get", lambda *_args, **_kwargs: response)
    source_id = uuid4()
    policy = SourcePolicy(source_id=source_id,name="Anime Expo",base_url=response.url,enabled=True,terms_review_status="REVIEWED_ALLOWED",allowed_domains=["www.anime-expo.org"])
    request = CrawlRequest(source_id=source_id,url=response.url,canonical_url=response.url,dedupe_key="recaptcha-fixture")
    result = await ScraplingEngine(load_settings()).fetch(request, FetchPlan(mode=FetchMode.HTTP), policy)
    assert result.status_code == 200
    assert result.blocked_reason is None


@pytest.mark.asyncio
async def test_dynamic_fetch_passes_valid_case_insensitive_xhr_regex(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("socket.getaddrinfo", lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))])
    url = "https://jax.wasabicon.com/guests/"
    response = SimpleNamespace(body=b"<html><h1>Guests</h1></html>", headers={"content-type": "text/html"},
                               url=url, status=200, encoding="utf-8", captured_xhr=[])
    captured_options: dict = {}

    def fetch(_url, **options):
        captured_options.update(options)
        return response

    monkeypatch.setattr("kita_crawler.engine.DynamicFetcher.fetch", fetch)
    source_id = uuid4()
    policy = SourcePolicy(source_id=source_id, name="WasabiCon", base_url=url, enabled=True,
                          terms_review_status="REVIEWED_ALLOWED", allowed_domains=["jax.wasabicon.com"])
    request = CrawlRequest(source_id=source_id, url=url, canonical_url=url, dedupe_key="guests-fixture",
                           capture_xhr_patterns=[DEFAULT_XHR_PATTERN, r"(?i)custom-api"])

    result = await ScraplingEngine(load_settings()).fetch(request, FetchPlan(mode=FetchMode.DYNAMIC), policy)

    assert result.status_code == 200
    assert re.search(captured_options["capture_xhr"], "https://jax.wasabicon.com/API/GUESTS")
    assert re.search(captured_options["capture_xhr"], "https://jax.wasabicon.com/CUSTOM-API")


def test_invalid_xhr_regex_is_rejected_before_browser_starts() -> None:
    with pytest.raises(ValueError, match="Invalid capture_xhr_patterns regex"):
        _capture_xhr_regex(["schedule", "["])
