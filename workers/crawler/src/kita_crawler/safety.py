from __future__ import annotations

import hashlib
import ipaddress
import socket
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .models import SourcePolicy

SENSITIVE_QUERY_KEYS = {"access_token", "api_key", "auth", "key", "secret", "signature", "sig", "token"}
SENSITIVE_HEADERS = {"authorization", "cookie", "proxy-authorization", "set-cookie", "x-api-key"}


class PolicyViolation(ValueError):
    pass


def canonicalize_url(url: str) -> str:
    parsed = urlsplit(url.strip())
    scheme = parsed.scheme.lower()
    host = (parsed.hostname or "").encode("idna").decode("ascii").lower()
    port = parsed.port
    if (scheme == "https" and port == 443) or (scheme == "http" and port == 80):
        port = None
    netloc = host if port is None else f"{host}:{port}"
    path = parsed.path or "/"
    safe_query = urlencode(sorted(parse_qsl(parsed.query, keep_blank_values=True)))
    return urlunsplit((scheme, netloc, path, safe_query, ""))


def validate_url(url: str, policy: SourcePolicy, *, allow_private_network: bool = False) -> str:
    normalized = canonicalize_url(url)
    parsed = urlsplit(normalized)
    if parsed.scheme not in {"https", "http"}:
        raise PolicyViolation("Only HTTP and HTTPS URLs are permitted")
    if parsed.username or parsed.password:
        raise PolicyViolation("Embedded URL credentials are forbidden")
    if parsed.port not in {None, 80, 443}:
        raise PolicyViolation("Non-standard ports require explicit implementation review")
    host = parsed.hostname or ""
    if not any(host == allowed or host.endswith(f".{allowed}") for allowed in policy.allowed_domains):
        raise PolicyViolation(f"Host is outside the source allowlist: {host}")
    if policy.allowed_path_prefixes and not any(parsed.path.startswith(prefix) for prefix in policy.allowed_path_prefixes):
        raise PolicyViolation("Path is outside the source allowlist")
    if any(parsed.path.startswith(prefix) for prefix in policy.denied_path_prefixes):
        raise PolicyViolation("Path is denied by source policy")
    if not allow_private_network:
        for result in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM):
            address = ipaddress.ip_address(result[4][0])
            if any((address.is_private, address.is_loopback, address.is_link_local, address.is_multicast, address.is_reserved, address.is_unspecified)):
                raise PolicyViolation(f"Host resolves to a non-public address: {address}")
    return normalized


def redact_headers(headers: dict[str, str]) -> dict[str, str]:
    return {key: "[REDACTED]" if key.lower() in SENSITIVE_HEADERS else value for key, value in headers.items()}


def redact_url(url: str) -> str:
    parsed = urlsplit(url)
    query = [(key, "[REDACTED]" if key.lower() in SENSITIVE_QUERY_KEYS else value) for key, value in parse_qsl(parsed.query, keep_blank_values=True)]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))


def stable_key(*parts: str) -> str:
    return hashlib.sha256("\x1f".join(parts).encode()).hexdigest()

