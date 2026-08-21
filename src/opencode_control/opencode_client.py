from __future__ import annotations

import base64
import http.client
import ipaddress
import json
import math
import os
import re
import time
import urllib.parse
from collections.abc import Callable
from contextlib import AbstractContextManager, nullcontext
from pathlib import Path
from typing import Any

from opencode_control.redaction import redact_text

_STATUSLESS_ACTIVE_TTL_MS = 15 * 60 * 1000


class OpenCodeError(RuntimeError):
    pass


class OpenCodeResponseTooLarge(OpenCodeError):
    pass


class OpenCodeHTTPError(OpenCodeError):
    def __init__(self, status: int) -> None:
        self.status = status
        super().__init__(f"OpenCode request failed with status {status}")


class OpenCodeClient:
    def __init__(
        self,
        endpoint: str,
        directory: str | None,
        *,
        timeout: float = 10.0,
        password: str | None = None,
        guard: Callable[[], AbstractContextManager[None]] | None = None,
    ) -> None:
        try:
            parsed = urllib.parse.urlsplit(endpoint)
            port = parsed.port
        except ValueError as error:
            raise OpenCodeError("OpenCode endpoint is malformed") from error
        if (
            parsed.scheme != "http"
            or parsed.hostname is None
            or port is None
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise OpenCodeError("OpenCode endpoint must be a plain loopback HTTP origin")
        try:
            address = ipaddress.ip_address(parsed.hostname)
        except ValueError as error:
            raise OpenCodeError("OpenCode endpoint must use an IP literal") from error
        if not address.is_loopback:
            raise OpenCodeError("OpenCode endpoint must be loopback-only")
        self.host = parsed.hostname
        self.port = port
        self.endpoint = endpoint.rstrip("/")
        self.directory = directory
        self.timeout = timeout
        self.password = password
        self.guard = guard

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        directory: bool = True,
        query: dict[str, str | int] | None = None,
        max_response_bytes: int = 8 * 1024 * 1024,
        timeout: float | None = None,
    ) -> Any:
        context = self.guard() if self.guard else nullcontext()
        with context:
            return self._request(
                method,
                path,
                body=body,
                directory=directory,
                query=query,
                max_response_bytes=max_response_bytes,
                timeout=timeout,
            )

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        directory: bool = True,
        query: dict[str, str | int] | None = None,
        max_response_bytes: int = 8 * 1024 * 1024,
        timeout: float | None = None,
    ) -> Any:
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
            raise OpenCodeError("unsupported OpenCode method")
        if not path.startswith("/") or ".." in path or "?" in path or "#" in path:
            raise OpenCodeError("unsafe OpenCode API path")
        parameters = dict(query or {})
        if directory and self.directory:
            parameters["directory"] = self.directory
        encoded_query = urllib.parse.urlencode(parameters)
        target = f"{path}?{encoded_query}" if encoded_query else path
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        connection = http.client.HTTPConnection(
            self.host, self.port, timeout=self.timeout if timeout is None else timeout
        )
        try:
            headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Connection": "close",
                "User-Agent": "opencode-control/0.1",
            }
            if self.password:
                credentials = base64.b64encode(
                    f"opencode:{self.password}".encode()
                ).decode("ascii")
                headers["Authorization"] = f"Basic {credentials}"
            connection.request(
                method,
                target,
                body=payload,
                headers=headers,
            )
            response = connection.getresponse()
            if 300 <= response.status < 400:
                raise OpenCodeError("OpenCode redirect rejected")
            raw = response.read(max_response_bytes + 1)
            if len(raw) > max_response_bytes:
                raise OpenCodeResponseTooLarge("OpenCode response is too large")
            if not 200 <= response.status < 300:
                raise OpenCodeHTTPError(response.status)
            if not raw or response.status == 204:
                return None
            return json.loads(raw.decode("utf-8"), parse_constant=_reject_constant)
        except (OSError, http.client.HTTPException, UnicodeDecodeError, ValueError) as error:
            if isinstance(error, OpenCodeError):
                raise
            raise OpenCodeError("OpenCode server is unavailable") from error
        finally:
            connection.close()

    def snapshot(self) -> dict[str, Any]:
        raw: dict[str, Any] = {}
        errors: list[str] = []
        for key, path, default in (
            ("health", "/global/health", {}),
            ("sessions", "/session", []),
            ("statuses", "/session/status", {}),
            ("agents", "/agent", []),
            ("mcp", "/mcp", {}),
            ("providers", "/provider", {}),
            ("config", "/config", {}),
        ):
            try:
                raw[key] = self.request("GET", path, directory=path != "/global/health")
            except OpenCodeError:
                raw[key] = default
                errors.append(f"{key}_unavailable")
        sessions = _sessions(raw["sessions"], self.directory)
        session_ids = {str(item["id"]) for item in sessions}
        statuses = {
            session_id: status
            for session_id, status in _statuses(raw["statuses"]).items()
            if session_id in session_ids
        }
        observed_at = time.time() * 1000
        sessions_by_id = {str(item["id"]): item for item in sessions}
        checked_stale: set[str] = set()
        active_states = {"busy", "dispatching", "in_progress", "pending", "queued", "running"}
        for session_id, status in list(statuses.items()):
            session = sessions_by_id.get(session_id)
            raw_time = session.get("time") if isinstance(session, dict) else None
            updated_at = raw_time.get("updated") if isinstance(raw_time, dict) else None
            value = status.get("type") or status.get("status")
            if (
                value not in active_states
                or not isinstance(updated_at, (int, float))
                or observed_at - float(updated_at) <= _STATUSLESS_ACTIVE_TTL_MS
            ):
                continue
            try:
                latest = self.request(
                    "GET",
                    f"/session/{_segment(session_id)}/message",
                    query={"limit": 1},
                    max_response_bytes=1024 * 1024,
                )
            except OpenCodeError:
                continue
            checked_stale.add(session_id)
            message_status, message_error = _latest_message_status(latest)
            if message_status == "busy":
                if _latest_message_has_active_tool(latest):
                    continue
                statuses[session_id] = {
                    "type": "stalled",
                    "status": None,
                    "error": "OpenCode session has no message progress for more than 15 minutes",
                }
            elif message_status == "failed":
                statuses[session_id] = {
                    "type": "failed",
                    "status": None,
                    "error": message_error or "OpenCode session failed",
                }
            else:
                statuses.pop(session_id, None)
        statusless = sorted(
            (
                item
                for item in sessions
                if item["id"] not in statuses
                and item["id"] not in checked_stale
                and isinstance(item.get("time"), dict)
                and isinstance(item["time"].get("updated"), (int, float))
            ),
            key=lambda item: item["time"]["updated"],
            reverse=True,
        )
        for session in statusless[:5]:
            try:
                latest = self.request(
                    "GET",
                    f"/session/{_segment(str(session['id']))}/message",
                    query={"limit": 1},
                    max_response_bytes=1024 * 1024,
                )
            except OpenCodeError:
                continue
            message_status, message_error = _latest_message_status(latest)
            if message_status == "failed":
                statuses[str(session["id"])] = {
                    "type": "failed",
                    "status": None,
                    "error": message_error or "OpenCode session failed",
                }
            elif message_status == "busy":
                updated_at = float(session["time"]["updated"])
                stale = observed_at - updated_at > _STATUSLESS_ACTIVE_TTL_MS
                if stale and not _latest_message_has_active_tool(latest):
                    statuses[str(session["id"])] = {
                        "type": "stalled",
                        "status": None,
                        "error": (
                            "OpenCode session has no message progress for more than 15 minutes"
                        ),
                    }
                else:
                    statuses[str(session["id"])] = {"type": "busy", "status": None}
        return {
            "state": "connected" if not errors else "degraded",
            "errors": errors,
            "health": _health(raw["health"]),
            "sessions": sessions,
            "statuses": statuses,
            "agents": _agents(raw["agents"]),
            "mcp": _mcp(raw["mcp"]),
            "providers": _providers(raw["providers"]),
            "config": _config(raw["config"]),
        }

    def create_session(self, title: str | None = None) -> dict[str, Any]:
        body = {"title": title} if title else {}
        value = self.request("POST", "/session", body=body)
        if not isinstance(value, dict) or not isinstance(value.get("id"), str):
            raise OpenCodeError("OpenCode returned an invalid session")
        return value

    def sessions(self) -> list[dict[str, Any]]:
        value = self.request("GET", "/session", query={"limit": 500})
        return _sessions(value, self.directory)

    def provider_auth_catalog(self) -> list[dict[str, Any]]:
        providers = self.request("GET", "/provider")
        methods = self.request("GET", "/provider/auth")
        return _provider_auth_catalog(providers, methods)

    def set_provider_api_key(
        self, provider_id: str, key: str, metadata: dict[str, str] | None = None
    ) -> None:
        body: dict[str, Any] = {"type": "api", "key": key}
        if metadata:
            body["metadata"] = metadata
        self.request(
            "PUT",
            f"/auth/{_segment(provider_id)}",
            body=body,
            directory=False,
        )

    def authorize_provider_oauth(
        self, provider_id: str, method: int, inputs: dict[str, str]
    ) -> dict[str, Any]:
        value = self.request(
            "POST",
            f"/provider/{_segment(provider_id)}/oauth/authorize",
            body={"method": method, "inputs": inputs},
            directory=False,
        )
        if not isinstance(value, dict) or not isinstance(value.get("url"), str):
            raise OpenCodeError("OpenCode returned an invalid authorization response")
        url = str(value["url"])
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and _is_loopback_hostname(parsed.hostname)
        ):
            raise OpenCodeError("OpenCode returned an unsafe authorization URL")
        return {
            "url": url,
            "method": value.get("method") if value.get("method") in {"auto", "code"} else "auto",
            "instructions": value.get("instructions")
            if isinstance(value.get("instructions"), str)
            else None,
        }

    def complete_provider_oauth(
        self, provider_id: str, method: int, code: str | None
    ) -> None:
        body: dict[str, Any] = {"method": method}
        if code:
            body["code"] = code
        value = self.request(
            "POST",
            f"/provider/{_segment(provider_id)}/oauth/callback",
            body=body,
            directory=False,
        )
        if value is not True:
            raise OpenCodeError("OpenCode did not confirm provider authorization")

    def ensure_session_directory(self, session_id: str, *, missing_ok: bool = False) -> bool:
        try:
            value = self.request("GET", f"/session/{_segment(session_id)}")
        except OpenCodeHTTPError as error:
            if missing_ok and error.status == 404:
                return False
            raise
        if not isinstance(value, dict) or not isinstance(value.get("directory"), str):
            raise OpenCodeError("OpenCode returned an invalid session identity")
        if not self.directory or not _within_directory(value["directory"], self.directory):
            raise OpenCodeError("session belongs to a different project directory")
        return True

    def delete_session(self, session_id: str, *, missing_ok: bool = False) -> None:
        try:
            self.request("DELETE", f"/session/{_segment(session_id)}")
        except OpenCodeHTTPError as error:
            if not missing_ok or error.status != 404:
                raise

    def session_messages(self, session_id: str) -> list[dict[str, Any]]:
        value = self.request(
            "GET",
            f"/session/{_segment(session_id)}/message",
            max_response_bytes=128 * 1024 * 1024,
        )
        return _messages(value)

    def commands(self) -> list[dict[str, Any]]:
        value = self.request("GET", "/command")
        if not isinstance(value, list):
            raise OpenCodeError("OpenCode returned an invalid command list")
        result: list[dict[str, Any]] = []
        for item in value[:500]:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                continue
            template = item.get("template")
            description = item.get("description")
            agent = item.get("agent")
            model = item.get("model")
            result.append(
                {
                    "id": item["name"][:128],
                    "description": description[:1000] if isinstance(description, str) else None,
                    "agent": agent[:128] if isinstance(agent, str) else None,
                    "model": model[:256] if isinstance(model, str) else None,
                    "subtask": item.get("subtask") is True,
                    "content": template[:200_000] if isinstance(template, str) else "",
                }
            )
        return result

    def run_command(
        self,
        session_id: str,
        command: str,
        arguments: str,
        *,
        agent: str | None = None,
        model: str | None = None,
        variant: str | None = None,
    ) -> None:
        body = {"command": command, "arguments": arguments}
        if agent:
            body["agent"] = agent
        if model:
            provider, separator, model_id = model.partition("/")
            if not separator or not provider or not model_id:
                raise OpenCodeError("model must use provider/model format")
            body["model"] = model
        if variant:
            body["variant"] = variant
        self.request(
            "POST",
            f"/session/{_segment(session_id)}/command",
            body=body,
            max_response_bytes=128 * 1024 * 1024,
            timeout=60 * 60,
        )

    def session_todos(self, session_id: str) -> list[dict[str, str]]:
        value = self.request("GET", f"/session/{_segment(session_id)}/todo")
        if not isinstance(value, list):
            return []
        result: list[dict[str, str]] = []
        for item in value:
            if not isinstance(item, dict) or not isinstance(item.get("content"), str):
                continue
            status = item.get("status")
            priority = item.get("priority")
            result.append(
                {
                    "content": item["content"][:2000],
                    "status": status
                    if isinstance(status, str)
                    and status in {"pending", "in_progress", "completed", "cancelled"}
                    else "pending",
                    "priority": priority
                    if isinstance(priority, str) and priority in {"high", "medium", "low"}
                    else "medium",
                }
            )
            if len(result) >= 200:
                break
        return result

    def session_permissions(self, session_id: str) -> list[dict[str, Any]]:
        value = self.request("GET", "/permission")
        if isinstance(value, dict):
            value = value.get("data") or value.get("permissions") or []
        if not isinstance(value, list):
            return []
        result: list[dict[str, Any]] = []
        for item in value:
            if (
                not isinstance(item, dict)
                or (item.get("sessionID") or item.get("session_id")) != session_id
                or not isinstance(item.get("id") or item.get("requestID"), str)
                or not isinstance(item.get("permission") or item.get("action"), str)
            ):
                continue
            request_id = str(item.get("id") or item.get("requestID"))
            permission = str(item.get("permission") or item.get("action"))
            patterns = item.get("patterns") or item.get("resources")
            result.append(
                {
                    "id": request_id,
                    "permission": permission[:200],
                    "patterns": [value[:1000] for value in patterns[:50] if isinstance(value, str)]
                    if isinstance(patterns, list)
                    else [],
                }
            )
            if len(result) >= 200:
                break
        return result

    def reply_permission(self, session_id: str, permission_id: str, reply: str) -> None:
        if not any(item["id"] == permission_id for item in self.session_permissions(session_id)):
            raise OpenCodeError("permission request does not belong to this session")
        self.request(
            "POST",
            f"/permission/{_segment(permission_id)}/reply",
            body={"reply": reply},
        )

    def prompt_async(
        self,
        session_id: str,
        prompt: str,
        *,
        agent: str | None = None,
        model: str | None = None,
        variant: str | None = None,
        attachments: list[dict[str, str]] | None = None,
        mentions: list[str] | None = None,
    ) -> None:
        parts: list[dict[str, Any]] = []
        if prompt:
            parts.append({"type": "text", "text": prompt})
        for name in dict.fromkeys(mentions or []):
            value = f"@{name}"
            start = prompt.find(value)
            if start < 0:
                continue
            parts.append(
                {
                    "type": "agent",
                    "name": name,
                    "source": {"value": value, "start": start, "end": start + len(value)},
                }
            )
        for attachment in attachments or []:
            parts.append(
                {
                    "type": "file",
                    "mime": attachment["mime"],
                    "filename": attachment["filename"],
                    "url": attachment["data_url"],
                }
            )
        body: dict[str, Any] = {"parts": parts}
        if agent:
            body["agent"] = agent
        if model:
            provider, separator, model_id = model.partition("/")
            if not separator:
                raise OpenCodeError("model must use provider/model format")
            body["model"] = {"providerID": provider, "modelID": model_id}
        if variant:
            body["variant"] = variant
        self.request("POST", f"/session/{_segment(session_id)}/prompt_async", body=body)


def _segment(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _reject_constant(value: str) -> Any:
    raise ValueError(f"non-standard JSON constant: {value}")


def _health(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    return {
        "healthy": raw.get("healthy") is True,
        "version": raw.get("version") if isinstance(raw.get("version"), str) else None,
    }


def _sessions(raw: Any, directory: str | None) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    result: list[dict[str, Any]] = []
    for item in raw[:500]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        item_directory = item.get("directory")
        if directory and (
            not isinstance(item_directory, str)
            or not _within_directory(item_directory, directory)
        ):
            continue
        result.append(
            {
                key: item.get(key)
                for key in (
                    "id",
                    "title",
                    "parentID",
                    "agent",
                    "model",
                    "time",
                    "tokens",
                    "cost",
                )
            }
        )
    return result


def _within_directory(candidate: str, root: str) -> bool:
    try:
        candidate_path = Path(candidate).expanduser().resolve(strict=False)
        root_path = Path(root).expanduser().resolve(strict=False)
        return candidate_path == root_path or candidate_path.is_relative_to(root_path)
    except (OSError, RuntimeError, ValueError):
        return False


def _statuses(raw: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        return {}
    result: dict[str, dict[str, Any]] = {}
    for session_id, value in raw.items():
        if isinstance(session_id, str) and isinstance(value, dict):
            result[session_id] = {
                "type": value.get("type") if isinstance(value.get("type"), str) else None,
                "status": value.get("status") if isinstance(value.get("status"), str) else None,
            }
            if isinstance(value.get("error"), str):
                result[session_id]["error"] = value["error"][:4000]
    return result


def _latest_message_status(raw: Any) -> tuple[str | None, str]:
    if not isinstance(raw, list) or not raw:
        return None, ""
    entry = raw[-1]
    if not isinstance(entry, dict) or not isinstance(entry.get("info"), dict):
        return None, ""
    info = entry["info"]
    role = info.get("role")
    if role == "user":
        return "busy", ""
    if role != "assistant":
        return None, ""
    if info.get("error") is not None:
        return "failed", _message_error(info["error"])
    message_time = info.get("time")
    if isinstance(message_time, dict) and isinstance(
        message_time.get("completed"), (int, float)
    ):
        return None, ""
    parts = entry.get("parts")
    if isinstance(parts, list):
        for part in parts:
            if not isinstance(part, dict) or part.get("type") != "tool":
                continue
            state = part.get("state")
            if isinstance(state, dict) and state.get("status") in {"pending", "running"}:
                return "busy", ""
    if isinstance(message_time, dict) and isinstance(message_time.get("created"), (int, float)):
        return "busy", ""
    return None, ""


def _latest_message_has_active_tool(raw: Any) -> bool:
    if not isinstance(raw, list) or not raw:
        return False
    entry = raw[-1]
    if not isinstance(entry, dict) or not isinstance(entry.get("parts"), list):
        return False
    for part in entry["parts"]:
        if not isinstance(part, dict) or part.get("type") != "tool":
            continue
        state = part.get("state")
        if isinstance(state, dict) and state.get("status") in {"pending", "running"}:
            return True
    return False


def _messages(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    result: list[dict[str, Any]] = []
    remaining = 128 * 1024 * 1024
    turn_started_at: float | None = None
    for entry in raw:
        if not isinstance(entry, dict) or remaining <= 0:
            continue
        info = entry.get("info")
        parts = entry.get("parts")
        synthetic_continuation = isinstance(parts, list) and any(
            isinstance(part, dict)
            and part.get("synthetic") is True
            and isinstance(part.get("metadata"), dict)
            and part["metadata"].get("compaction_continue") is True
            for part in parts
        )
        internal_compaction = (
            isinstance(info, dict)
            and info.get("role") == "user"
            and isinstance(parts, list)
            and bool(parts)
            and all(isinstance(part, dict) and part.get("type") == "compaction" for part in parts)
        )
        if isinstance(info, dict) and (
            info.get("mode") == "compaction"
            or info.get("summary") is True
            or synthetic_continuation
            or internal_compaction
        ):
            continue
        entry_time = info.get("time") if isinstance(info, dict) else None
        if (
            isinstance(info, dict)
            and info.get("role") == "user"
            and isinstance(entry_time, dict)
            and isinstance(entry_time.get("created"), (int, float))
        ):
            turn_started_at = float(entry_time["created"])
        message_completed = (
            float(entry_time["completed"])
            if isinstance(entry_time, dict)
            and isinstance(entry_time.get("completed"), (int, float))
            else None
        )
        safe_info = {
            "id": info.get("id") if isinstance(info, dict) else None,
            "role": info.get("role") if isinstance(info, dict) else None,
        }
        if isinstance(info, dict):
            for key in ("agent", "modelID", "providerID", "variant", "finish"):
                value = info.get(key)
                if isinstance(value, str) and value:
                    safe_info[key] = value[:256]
            model = info.get("model")
            if isinstance(model, dict):
                for key in ("modelID", "providerID"):
                    value = model.get(key)
                    if isinstance(value, str) and value:
                        safe_info[key] = value[:256]
            error = _message_error(info.get("error"))
            if error:
                safe_info["error"] = error
            cost = info.get("cost")
            if isinstance(cost, (int, float)) and math.isfinite(cost) and cost >= 0:
                safe_info["cost"] = cost
            tokens = _message_tokens(info.get("tokens"))
            if tokens:
                safe_info["tokens"] = tokens
            raw_time = info.get("time")
            if isinstance(raw_time, dict):
                safe_time = {
                    key: value
                    for key in ("created", "completed")
                    if isinstance((value := raw_time.get(key)), (int, float))
                    and math.isfinite(value)
                    and value >= 0
                }
                if safe_time:
                    safe_info["time"] = safe_time
        safe_parts: list[dict[str, Any]] = []
        if isinstance(parts, list):
            for part in parts:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "file" and isinstance(part.get("mime"), str):
                    safe_parts.append(
                        {
                            "type": "file",
                            "mime": str(part["mime"])[:255],
                            "filename": str(part.get("filename") or "file")[:255],
                        }
                    )
                    continue
                if part.get("type") == "step-start":
                    safe_parts.append({"type": "step-start"})
                    continue
                if part.get("type") == "step-finish":
                    safe_step: dict[str, Any] = {"type": "step-finish"}
                    if isinstance(part.get("reason"), str):
                        safe_step["reason"] = part["reason"][:200]
                    tokens = _message_tokens(part.get("tokens"))
                    if tokens:
                        safe_step["tokens"] = tokens
                    cost = part.get("cost")
                    if isinstance(cost, (int, float)) and math.isfinite(cost) and cost >= 0:
                        safe_step["cost"] = cost
                    if (
                        part.get("reason") != "tool-calls"
                        and message_completed is not None
                        and turn_started_at is not None
                    ):
                        safe_step["duration"] = max(0, message_completed - turn_started_at)
                    safe_parts.append(safe_step)
                    continue
                if part.get("type") in {"reasoning", "subtask"}:
                    raw_text = part.get("text")
                    if part.get("type") == "subtask":
                        raw_text = part.get("description") or part.get("prompt")
                    if not isinstance(raw_text, str) or not raw_text:
                        continue
                    text, consumed = _bounded_text(raw_text, remaining, remaining)
                    remaining -= consumed
                    safe_part: dict[str, Any] = {"type": part["type"], "text": text}
                    if isinstance(part.get("agent"), str):
                        safe_part["agent"] = part["agent"][:200]
                    raw_time = part.get("time")
                    if isinstance(raw_time, dict):
                        safe_time = {
                            key: value
                            for key in ("start", "end")
                            if isinstance((value := raw_time.get(key)), (int, float))
                            and math.isfinite(value)
                            and value >= 0
                        }
                        if safe_time:
                            safe_part["time"] = safe_time
                    safe_parts.append(safe_part)
                    continue
                if part.get("type") == "patch" and isinstance(part.get("files"), list):
                    files = [
                        str(value)[:1000]
                        for value in part["files"][:100]
                        if isinstance(value, str)
                    ]
                    safe_parts.append({"type": "patch", "files": files})
                    continue
                if part.get("type") == "agent" and isinstance(part.get("name"), str):
                    safe_parts.append({"type": "agent", "name": part["name"][:200]})
                    continue
                if part.get("type") == "retry":
                    safe_retry: dict[str, Any] = {"type": "retry"}
                    attempt = part.get("attempt")
                    if isinstance(attempt, int) and attempt >= 0:
                        safe_retry["attempt"] = attempt
                    raw_error = part.get("error")
                    if isinstance(raw_error, dict):
                        raw_error = raw_error.get("message") or raw_error.get("name")
                    if isinstance(raw_error, str):
                        text, consumed = _bounded_text(raw_error, remaining, 4000)
                        remaining -= consumed
                        safe_retry["error"] = text
                    safe_parts.append(safe_retry)
                    continue
                if part.get("type") in {"compaction", "snapshot"}:
                    safe_parts.append({"type": part["type"]})
                    continue
                if part.get("type") == "tool" and isinstance(part.get("tool"), str):
                    state = part.get("state")
                    if not isinstance(state, dict):
                        continue
                    status = state.get("status")
                    if status not in {"pending", "running", "completed", "error"}:
                        continue
                    safe_state: dict[str, Any] = {"status": status}
                    for key in ("title", "error"):
                        value = state.get(key)
                        if not isinstance(value, str) or not value:
                            continue
                        limit = remaining if key == "error" else 500
                        text, consumed = _bounded_text(value, remaining, limit)
                        remaining -= consumed
                        if text:
                            safe_state[key] = text
                    raw_output = state.get("output")
                    metadata = state.get("metadata")
                    metadata_output = metadata.get("output") if isinstance(metadata, dict) else None
                    managed_output, managed_complete = _managed_tool_output(
                        raw_output,
                        remaining,
                    )
                    if managed_output:
                        raw_output = managed_output
                        safe_state["full_output"] = managed_complete
                    elif isinstance(metadata_output, str) and metadata_output:
                        raw_output = metadata_output
                        safe_state["full_output"] = not (
                            isinstance(metadata, dict) and metadata.get("truncated") is True
                        )
                    if isinstance(raw_output, str) and raw_output:
                        text, consumed = _bounded_text(raw_output, remaining, remaining)
                        remaining -= consumed
                        if text:
                            safe_state["output"] = text
                    if isinstance(metadata, dict):
                        exit_code = metadata.get("exit")
                        if isinstance(exit_code, int):
                            safe_state["exit_code"] = exit_code
                        if metadata.get("truncated") is True and not safe_state.get("full_output"):
                            safe_state["truncated"] = True
                    raw_time = state.get("time")
                    if isinstance(raw_time, dict):
                        safe_time = {
                            key: value
                            for key in ("start", "end")
                            if isinstance((value := raw_time.get(key)), (int, float))
                            and math.isfinite(value)
                            and value >= 0
                        }
                        if safe_time:
                            safe_state["time"] = safe_time
                    tool = part["tool"][:200]
                    tool_input = state.get("input")
                    if isinstance(tool_input, dict):
                        summary = _tool_input_summary(tool_input)
                        if summary:
                            text, consumed = _bounded_text(summary, remaining, 4000)
                            remaining -= consumed
                            safe_state["input"] = text
                    if tool in {"bash", "shell"} and isinstance(tool_input, dict):
                        command = tool_input.get("command")
                        if isinstance(command, str):
                            text, consumed = _bounded_text(command, remaining, 4000)
                            remaining -= consumed
                            if text:
                                safe_state["command"] = text
                        workdir = tool_input.get("workdir")
                        if isinstance(workdir, str) and workdir:
                            safe_state["workdir"] = workdir[:4000]
                    safe_parts.append({"type": "tool", "tool": tool, "state": safe_state})
                    continue
                if part.get("type") != "text":
                    continue
                raw_text = part.get("text")
                if not isinstance(raw_text, str) or not raw_text:
                    continue
                text, consumed = _bounded_text(raw_text, remaining, remaining)
                remaining -= consumed
                if text:
                    safe_parts.append({"type": "text", "text": text})
                if remaining <= 0:
                    break
        if safe_parts or safe_info.get("error"):
            result.append({"info": safe_info, "parts": safe_parts})
    return result


def _message_error(raw: Any) -> str:
    if isinstance(raw, str):
        return redact_text(raw[:4000])
    if not isinstance(raw, dict):
        return ""
    data = raw.get("data")
    message = data.get("message") if isinstance(data, dict) else None
    if isinstance(message, str) and message:
        return redact_text(message[:4000])
    name = raw.get("name")
    return redact_text(name[:200]) if isinstance(name, str) else ""


def _tool_input_summary(raw: dict[str, Any]) -> str:
    safe: dict[str, Any] = {}
    for key, value in raw.items():
        normalized = re.sub(r"[^a-z0-9]", "", str(key).lower())
        if any(
            marker in normalized
            for marker in ("secret", "token", "password", "authorization", "apikey")
        ):
            continue
        if isinstance(value, str):
            safe[str(key)[:100]] = redact_text(value[:2000])
        elif isinstance(value, (int, float, bool)) or value is None:
            safe[str(key)[:100]] = value
        elif isinstance(value, list) and all(
            isinstance(item, (str, int, float, bool)) or item is None
            for item in value[:50]
        ):
            safe[str(key)[:100]] = [
                redact_text(item) if isinstance(item, str) else item
                for item in value[:50]
            ]
    return json.dumps(safe, ensure_ascii=False, indent=2) if safe else ""


def _message_tokens(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    result: dict[str, Any] = {}
    for key in ("total", "input", "output", "reasoning"):
        value = raw.get(key)
        if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
            result[key] = value
    cache = raw.get("cache")
    if isinstance(cache, dict):
        safe_cache: dict[str, int | float] = {}
        for key in ("read", "write"):
            value = cache.get(key)
            if isinstance(value, (int, float)) and math.isfinite(value) and value >= 0:
                safe_cache[key] = value
        if safe_cache:
            result["cache"] = safe_cache
    return result


def _bounded_text(value: str, remaining: int, limit: int) -> tuple[str, int]:
    allowed = max(0, min(remaining, limit))
    encoded = value.encode("utf-8")
    if len(encoded) <= allowed:
        return value, len(encoded)
    if allowed == 0:
        return "", 0
    text = encoded[:allowed].decode("utf-8", errors="ignore")
    return f"{text}\n[Предпросмотр обрезан]", allowed


def _managed_tool_output(raw: Any, limit: int) -> tuple[str, bool]:
    if not isinstance(raw, str) or limit <= 0:
        return "", False
    match = re.search(r"(?:^|\n)Full output saved to: (/[^\n]+)", raw)
    if not match:
        return "", False
    candidate = Path(match.group(1))
    if not re.fullmatch(r"tool_[A-Za-z0-9]+", candidate.name):
        return "", False
    roots = [Path.home() / ".local/share/opencode/tool-output"]
    xdg_data_home = os.environ.get("XDG_DATA_HOME")
    if xdg_data_home:
        roots.append(Path(xdg_data_home).expanduser() / "opencode/tool-output")
    try:
        resolved = candidate.resolve(strict=True)
        if not any(resolved.parent == root.resolve() for root in roots):
            return "", False
        with resolved.open("rb") as handle:
            payload = handle.read(limit + 1)
    except OSError:
        return "", False
    complete = len(payload) <= limit
    return payload[:limit].decode("utf-8", errors="replace"), complete


def _agents(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    result: list[dict[str, Any]] = []
    for item in raw[:500]:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            continue
        result.append(
            {
                "name": item["name"],
                "description": item.get("description"),
                "mode": item.get("mode"),
                "model": item.get("model"),
                "native": item.get("native") is True,
                "hidden": item.get("hidden") is True,
                "color": item.get("color"),
            }
        )
    return result


def _mcp(raw: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        return {}
    return {
        name: {
            "status": value.get("status") if isinstance(value.get("status"), str) else "unknown",
            "error": "connection_failed" if value.get("error") else None,
        }
        for name, value in raw.items()
        if isinstance(name, str) and isinstance(value, dict)
    }


def _providers(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {"connected": [], "available": []}
    connected = raw.get("connected")
    connected_ids = {
        item for item in connected if isinstance(item, str)
    } if isinstance(connected, list) else set()
    defaults = raw.get("default")
    all_providers = raw.get("all")
    available: list[dict[str, Any]] = []
    if isinstance(all_providers, list):
        for provider in all_providers:
            if not isinstance(provider, dict) or not isinstance(provider.get("id"), str):
                continue
            if provider["id"] not in connected_ids:
                continue
            models = provider.get("models")
            model_ids = (
                [f"{provider['id']}/{model_id}" for model_id in models if isinstance(model_id, str)]
                if isinstance(models, dict)
                else []
            )
            model_variants: dict[str, list[str]] = {}
            if isinstance(models, dict):
                for model_id, model in models.items():
                    if not isinstance(model_id, str) or not isinstance(model, dict):
                        continue
                    variants = model.get("variants")
                    if not isinstance(variants, dict):
                        continue
                    names = [
                        name[:128]
                        for name in variants
                        if isinstance(name, str) and name and len(name) <= 128
                    ][:100]
                    if names:
                        model_variants[f"{provider['id']}/{model_id}"] = names
            available.append(
                {
                    "id": provider["id"],
                    "name": provider.get("name"),
                    "model_count": len(models) if isinstance(models, dict) else 0,
                    "models": model_ids[:1000],
                    "model_variants": model_variants,
                    "default_model": (
                        f"{provider['id']}/{defaults[provider['id']]}"
                        if isinstance(defaults, dict)
                        and isinstance(defaults.get(provider["id"]), str)
                        else None
                    ),
                }
            )
    return {
        "connected": sorted(connected_ids),
        "available": available,
    }


def _provider_auth_catalog(providers: Any, methods: Any) -> list[dict[str, Any]]:
    if not isinstance(methods, dict):
        raise OpenCodeError("OpenCode returned invalid provider authentication methods")
    connected = providers.get("connected") if isinstance(providers, dict) else []
    connected_ids = {
        item for item in connected if isinstance(item, str)
    } if isinstance(connected, list) else set()
    names: dict[str, str] = {}
    all_providers = providers.get("all") if isinstance(providers, dict) else []
    if isinstance(all_providers, list):
        for provider in all_providers[:1000]:
            if not isinstance(provider, dict) or not isinstance(provider.get("id"), str):
                continue
            name = provider.get("name")
            names[provider["id"]] = name if isinstance(name, str) else provider["id"]

    provider_ids = set(names)
    provider_ids.update(key for key in methods if isinstance(key, str))
    result: list[dict[str, Any]] = []
    for provider_id in list(provider_ids)[:1000]:
        raw_methods = methods.get(provider_id)
        if not isinstance(raw_methods, list):
            raw_methods = []
        safe_methods: list[dict[str, Any]] = []
        for raw_method in raw_methods[:20]:
            if not isinstance(raw_method, dict) or raw_method.get("type") not in {"api", "oauth"}:
                continue
            safe_method: dict[str, Any] = {
                "type": raw_method["type"],
                "label": raw_method.get("label")
                if isinstance(raw_method.get("label"), str)
                else str(raw_method["type"]).upper(),
            }
            prompts = raw_method.get("prompts")
            if isinstance(prompts, list):
                safe_method["prompts"] = [
                    prompt
                    for item in prompts[:20]
                    if (prompt := _provider_auth_prompt(item)) is not None
                ]
            safe_methods.append(safe_method)
        if not safe_methods:
            safe_methods.append({"type": "api", "label": "API key"})
        result.append(
            {
                "id": provider_id,
                "name": names.get(provider_id, provider_id),
                "connected": provider_id in connected_ids,
                "methods": safe_methods,
            }
        )
    return sorted(result, key=lambda item: str(item["name"]).lower())


def _provider_auth_prompt(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or raw.get("type") not in {"text", "select"}:
        return None
    if not isinstance(raw.get("key"), str) or not isinstance(raw.get("message"), str):
        return None
    result: dict[str, Any] = {
        "type": raw["type"],
        "key": raw["key"],
        "message": raw["message"],
    }
    if isinstance(raw.get("placeholder"), str):
        result["placeholder"] = raw["placeholder"]
    if raw["type"] == "select" and isinstance(raw.get("options"), list):
        result["options"] = [
            {
                "label": option["label"],
                "value": option["value"],
                **({"hint": option["hint"]} if isinstance(option.get("hint"), str) else {}),
            }
            for option in raw["options"][:100]
            if isinstance(option, dict)
            and isinstance(option.get("label"), str)
            and isinstance(option.get("value"), str)
        ]
    return result


def _is_loopback_hostname(value: str | None) -> bool:
    if value == "localhost":
        return True
    try:
        return bool(value and ipaddress.ip_address(value).is_loopback)
    except ValueError:
        return False


def _config(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    result: dict[str, Any] = {}
    for key in ("model", "small_model", "default_agent"):
        if isinstance(raw.get(key), str):
            result[key] = raw[key]
    providers = raw.get("provider")
    if isinstance(providers, dict):
        result["configured_providers"] = sorted(
            key for key in providers if isinstance(key, str)
        )
    mcp = raw.get("mcp")
    if isinstance(mcp, dict):
        result["mcp"] = {
            name: {
                key: value
                for key, value in config.items()
                if key in {"type", "enabled"} and isinstance(value, (str, bool))
            }
            for name, config in mcp.items()
            if isinstance(name, str) and isinstance(config, dict)
        }
    return result
