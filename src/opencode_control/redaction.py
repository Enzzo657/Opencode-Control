from __future__ import annotations

import re
import urllib.parse

REDACTED = "[REDACTED]"

_SECRET_MARKERS = (
    "apikey",
    "authorization",
    "clientsecret",
    "cookie",
    "credential",
    "password",
    "privatekey",
    "secret",
    "sessionkey",
    "token",
)
_URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
_AUTH = re.compile(
    r"(?i)\b(authorization\s*[:=]\s*)(?:basic|bearer)\s+[^\s,;\]}]+"
)
_COOKIE = re.compile(r"(?im)\b((?:set-)?cookie\s*:\s*)[^\r\n]+")
_KEY_VALUE = re.compile(
    r"(?i)(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|credential|password|private[_-]?key|secret|session[_-]?token|token)\b\s*[:=]\s*)([\"']?)([^\s,;}\]]+)"
)
_KNOWN_TOKEN = re.compile(
    r"(?i)\b(?:sk-[a-z0-9_-]{12,}|gh[opsu]_[a-z0-9_]{12,}|github_pat_[a-z0-9_]{12,}|pencil_cli_[a-z0-9_-]{12,}|AKIA[A-Z0-9]{16})\b"
)


def redact_text(value: str) -> str:
    text = _COOKIE.sub(rf"\1{REDACTED}", value)
    text = _AUTH.sub(rf"\1{REDACTED}", text)
    text = _KEY_VALUE.sub(rf"\1{REDACTED}", text)
    text = _KNOWN_TOKEN.sub(REDACTED, text)
    return _URL.sub(_redact_url_match, text)


def secret_name(value: str | None) -> bool:
    if value is None:
        return False
    normalized = re.sub(r"[^a-z0-9]", "", value.lower())
    return any(marker in normalized for marker in _SECRET_MARKERS)


def _redact_url_match(match: re.Match[str]) -> str:
    raw = match.group(0)
    trailing = ""
    while raw and raw[-1] in ".),":
        trailing = raw[-1] + trailing
        raw = raw[:-1]
    try:
        parsed = urllib.parse.urlsplit(raw)
        hostname = parsed.hostname
        if not hostname:
            return match.group(0)
        port = f":{parsed.port}" if parsed.port is not None else ""
        userinfo = f"{REDACTED}@" if parsed.username is not None else ""
        host = f"[{hostname}]" if ":" in hostname else hostname
        query = urllib.parse.urlencode(
            [
                (key, REDACTED)
                for key, _ in urllib.parse.parse_qsl(
                    parsed.query, keep_blank_values=True
                )
            ]
        )
        safe = urllib.parse.urlunsplit(
            (parsed.scheme, f"{userinfo}{host}{port}", parsed.path, query, "")
        )
        return safe + trailing
    except ValueError:
        return REDACTED + trailing
