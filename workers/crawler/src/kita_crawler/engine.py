from __future__ import annotations

import asyncio
import json
import re
import time
from typing import Protocol

from scrapling.fetchers import DynamicFetcher, Fetcher, StealthyFetcher

from .config import Settings
from .models import CapturedArtifact, CrawlRequest, FetchMode, FetchPlan, FetchResult, SourcePolicy
from .safety import PolicyViolation, redact_headers, validate_url


class WebFetchBackend(Protocol):
    async def fetch(self, request: CrawlRequest, plan: FetchPlan, policy: SourcePolicy) -> FetchResult: ...


CrawlerEngine = WebFetchBackend


_LEADING_REGEX_FLAGS = re.compile(r"^\(\?([aiLmsux]+)\)")


def _capture_xhr_regex(patterns: list[str]) -> str | None:
    if not patterns:
        return None
    branches = []
    for original in patterns:
        pattern = original
        flags = []
        while match := _LEADING_REGEX_FLAGS.match(pattern):
            flags.append(match.group(1))
            pattern = pattern[match.end():]
        for flag in reversed(flags):
            pattern = f"(?{flag}:{pattern})"
        branches.append(f"(?:{pattern})")
    combined = "|".join(branches)
    try:
        re.compile(combined)
    except re.error as error:
        raise ValueError(f"Invalid capture_xhr_patterns regex: {error}") from error
    return combined


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
            capture_xhr = _capture_xhr_regex(request.capture_xhr_patterns)
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
                "capture_xhr": capture_xhr,
                "block_ads": True,
            }
            if plan.mode == FetchMode.STEALTH:
                options.update({"solve_cloudflare": False, "block_webrtc": True, "allow_webgl": False})
            response = await asyncio.to_thread(fetcher.fetch, url, **options)
        duration_ms = round((time.perf_counter() - started) * 1000)
        body = _response_body(response)
        max_response_bytes = int(request.metadata.get("max_response_bytes", 50 * 1024 * 1024 if request.expected_content_types != ["text/html"] else 15 * 1024 * 1024))
        if len(body) > min(max_response_bytes, policy.max_bytes_per_run):
            raise PolicyViolation("Response exceeds the configured size limit")
        response_headers = _response_headers(response)
        content_type = response_headers.get("content-type", "text/html").split(";", 1)[0]
        lower = body[:250_000].lower()
        blocked = None
        if any(marker in lower for marker in (
            b"access denied",
            b"login required",
            b"performing security verification",
            b"verifies you are not a bot",
            b"verify you are human",
            b"complete the captcha",
            b"solve the captcha",
            b"<title>captcha",
            b"cf-chl-",
        )):
            blocked = "BLOCKED_ACCESS_CONTROL"
        captured = []
        captured_artifacts = []
        captured_bytes = 0
        max_captured_artifacts = int(request.metadata.get("max_captured_artifacts", 64))
        max_captured_bytes = int(request.metadata.get("max_captured_bytes", 25 * 1024 * 1024))
        for xhr in getattr(response, "captured_xhr", []) or []:
            xhr_url = str(getattr(xhr, "url", ""))
            xhr_status = int(getattr(xhr, "status", 200))
            xhr_type = _response_headers(xhr).get("content-type", "application/octet-stream").split(";", 1)[0]
            if len(captured) < max_captured_artifacts:
                captured.append({"url": xhr_url, "status": xhr_status, "content_type": xhr_type})
            xhr_body = _response_body(xhr)
            if (
                xhr_body
                and ("json" in xhr_type or xhr_type.startswith("text/"))
                and len(captured_artifacts) < max_captured_artifacts
                and captured_bytes + len(xhr_body) <= max_captured_bytes
            ):
                captured_artifacts.append(CapturedArtifact(url=xhr_url, status_code=xhr_status, content_type=xhr_type, body=xhr_body))
                captured_bytes += len(xhr_body)
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
            captured_artifacts=captured_artifacts,
        )
