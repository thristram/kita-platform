from __future__ import annotations

import asyncio
import json
import time
from typing import Protocol

from scrapling.fetchers import DynamicFetcher, Fetcher, StealthyFetcher

from .config import Settings
from .models import CrawlRequest, FetchMode, FetchPlan, FetchResult, SourcePolicy
from .safety import PolicyViolation, redact_headers, validate_url


class CrawlerEngine(Protocol):
    async def fetch(self, request: CrawlRequest, plan: FetchPlan, policy: SourcePolicy) -> FetchResult: ...


def _response_body(response: object) -> bytes:
    body = getattr(response, "body", None)
    if isinstance(body, bytes):
        return body
    if body is not None:
        return bytes(body)
    html = getattr(response, "html_content", None) or getattr(response, "text", "")
    return str(html).encode(getattr(response, "encoding", None) or "utf-8", errors="replace")


def _response_headers(response: object) -> dict[str, str]:
    headers = getattr(response, "headers", {}) or {}
    try:
        return {str(k): str(v) for k, v in dict(headers).items()}
    except (TypeError, ValueError):
        return {}


class ScraplingEngine:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def fetch(self, request: CrawlRequest, plan: FetchPlan, policy: SourcePolicy) -> FetchResult:
        if request.method != "GET":
            raise PolicyViolation("Crawler requests are GET-only by default")
        url = validate_url(request.url, policy, allow_private_network=self.settings.allow_private_network)
        if plan.mode == FetchMode.STEALTH and not policy.allow_stealth:
            raise PolicyViolation("STEALTH mode is disabled for this source")
        headers = {"User-Agent": self.settings.user_agent, "Accept-Language": request.locale_hint or "en-US,en;q=0.8", **request.headers}
        started = time.perf_counter()
        if plan.mode == FetchMode.HTTP:
            response = await asyncio.to_thread(
                Fetcher.get,
                url,
                headers=headers,
                timeout=plan.timeout_seconds,
                follow_redirects="safe",
                max_redirects=5,
                retries=0,
            )
        else:
            fetcher = DynamicFetcher if plan.mode == FetchMode.DYNAMIC else StealthyFetcher
            options = {
                "headless": True,
                "disable_resources": False,
                "network_idle": request.render_wait == "NETWORK_IDLE",
                "wait_selector": request.render_selector,
                "wait_selector_state": "visible",
                "timeout": plan.timeout_seconds * 1000,
                "extra_headers": headers,
                "locale": request.locale_hint or "en-US",
                "timezone_id": policy.timezone,
                "capture_xhr": request.capture_xhr_patterns[0] if request.capture_xhr_patterns else None,
                "block_ads": True,
            }
            if plan.mode == FetchMode.STEALTH:
                options.update({"solve_cloudflare": False, "block_webrtc": True, "allow_webgl": False})
            response = await asyncio.to_thread(fetcher.fetch, url, **options)
        duration_ms = round((time.perf_counter() - started) * 1000)
        body = _response_body(response)
        if len(body) > 15 * 1024 * 1024:
            raise PolicyViolation("Response exceeds the 15 MB text limit")
        response_headers = _response_headers(response)
        content_type = response_headers.get("content-type", "text/html").split(";", 1)[0]
        lower = body[:250_000].lower()
        blocked = None
        if b"captcha" in lower or b"access denied" in lower or b"login required" in lower:
            blocked = "BLOCKED_ACCESS_CONTROL"
        captured = []
        for xhr in getattr(response, "captured_xhr", []) or []:
            captured.append({
                "url": str(getattr(xhr, "url", "")),
                "status": int(getattr(xhr, "status", 200)),
                "content_type": _response_headers(xhr).get("content-type"),
            })
        return FetchResult(
            requested_url=url,
            final_url=str(getattr(response, "url", url)),
            status_code=int(getattr(response, "status", getattr(response, "status_code", 200))),
            mode=plan.mode,
            request_headers_redacted=redact_headers(headers),
            response_headers_redacted=redact_headers(response_headers),
            content_type=content_type,
            encoding=getattr(response, "encoding", None),
            body=body,
            duration_ms=duration_ms,
            etag=response_headers.get("etag"),
            last_modified=response_headers.get("last-modified"),
            blocked_reason=blocked,
            captured_xhr=json.loads(json.dumps(captured)),
        )

