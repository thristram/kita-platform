from __future__ import annotations

from uuid import uuid4

import pytest

from kita_crawler.models import SourcePolicy
from kita_crawler.safety import PolicyViolation, canonicalize_url, redact_headers, redact_url, validate_url


def policy(**overrides) -> SourcePolicy:
    values = {
        "source_id": uuid4(),
        "name": "fixture",
        "base_url": "https://events.example.com/",
        "enabled": True,
        "terms_review_status": "REVIEWED_ALLOWED",
        "allowed_domains": ["events.example.com"],
        "allowed_path_prefixes": ["/events", "/news"],
        "denied_path_prefixes": ["/events/private"],
    }
    values.update(overrides)
    return SourcePolicy(**values)


def test_canonical_url_removes_fragment_default_port_and_sorts_query() -> None:
    assert canonicalize_url("HTTPS://Events.Example.com:443/events/?z=2&a=1#now") == (
        "https://events.example.com/events/?a=1&z=2"
    )


def test_url_policy_rejects_disallowed_host_before_dns_lookup() -> None:
    with pytest.raises(PolicyViolation, match="outside the source allowlist"):
        validate_url("https://169.254.169.254/latest/meta-data", policy())


def test_url_policy_rejects_denied_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("socket.getaddrinfo", lambda *_args, **_kwargs: [(2, 1, 6, "", ("93.184.216.34", 443))])
    with pytest.raises(PolicyViolation, match="denied"):
        validate_url("https://events.example.com/events/private/guest-list", policy())


def test_url_and_header_redaction() -> None:
    assert redact_url("https://events.example.com/events?id=1&token=secret").endswith("id=1&token=%5BREDACTED%5D")
    assert redact_headers({"Cookie": "secret", "Accept": "text/html"}) == {
        "Cookie": "[REDACTED]",
        "Accept": "text/html",
    }
