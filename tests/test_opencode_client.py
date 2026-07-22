from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar

import pytest

from opencode_studio.opencode_client import OpenCodeClient, OpenCodeError, OpenCodeHTTPError


class Handler(BaseHTTPRequestHandler):
    requests: ClassVar[list[tuple[str, str, Any]]] = []

    def do_GET(self) -> None:
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "https://example.com")
            self.end_headers()
            return
        self._respond({"healthy": True, "path": self.path})

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length)) if length else None
        self.requests.append(("POST", self.path, body))
        if self.path.startswith("/session?"):
            self._respond({"id": "ses_new"})
        else:
            self.send_response(204)
            self.end_headers()

    def do_PUT(self) -> None:
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length)) if length else None
        self.requests.append(("PUT", self.path, body))
        self.send_response(204)
        self.end_headers()

    def do_DELETE(self) -> None:
        self.requests.append(("DELETE", self.path, None))
        if "missing" in self.path:
            self.send_response(404)
            self.end_headers()
            return
        self._respond(True)

    def _respond(self, value: Any) -> None:
        payload = json.dumps(value).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: Any) -> None:
        return


@contextmanager
def server() -> Any:
    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield instance.server_port
    finally:
        instance.shutdown()
        thread.join(timeout=2)
        instance.server_close()


def test_client_restricts_endpoint_to_loopback() -> None:
    with pytest.raises(OpenCodeError):
        OpenCodeClient("https://127.0.0.1:4096", "/tmp/project")
    with pytest.raises(OpenCodeError):
        OpenCodeClient("http://example.com:4096", "/tmp/project")
    with pytest.raises(OpenCodeError):
        OpenCodeClient("http://127.0.0.1:4096/path", "/tmp/project")


def test_client_routes_directory_and_rejects_redirects() -> None:
    with server() as port:
        client = OpenCodeClient(f"http://127.0.0.1:{port}", "/tmp/my project")
        health = client.request("GET", "/global/health", directory=False)
        assert health["path"] == "/global/health"
        session = client.create_session("Investigate")
        assert session["id"] == "ses_new"
        method, path, body = Handler.requests[-1]
        assert method == "POST"
        assert "directory=%2Ftmp%2Fmy+project" in path
        assert body == {"title": "Investigate"}
        with pytest.raises(OpenCodeError, match="redirect rejected"):
            client.request("GET", "/redirect")
        client.delete_session("ses/with space")
        assert Handler.requests[-1][0] == "DELETE"
        assert "/session/ses%2Fwith%20space" in Handler.requests[-1][1]
        client.delete_session("missing", missing_ok=True)
        with pytest.raises(OpenCodeHTTPError) as error:
            client.delete_session("missing")
        assert error.value.status == 404
        client.set_provider_api_key("openai/custom", "secret")
        assert Handler.requests[-1] == (
            "PUT",
            "/auth/openai%2Fcustom",
            {"type": "api", "key": "secret"},
        )


def test_session_messages_are_complete_and_sanitized(monkeypatch: pytest.MonkeyPatch) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    calls: list[dict[str, str | int] | None] = []

    def fake_request(
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        directory: bool = True,
        query: dict[str, str | int] | None = None,
        max_response_bytes: int = 8 * 1024 * 1024,
    ) -> Any:
        calls.append(query)
        return [
            {
                "info": {
                    "id": "msg_1",
                    "role": "assistant",
                    "tokens": {
                        "input": 210,
                        "output": 864,
                        "reasoning": 1331,
                        "cache": {"read": 116352, "write": 0},
                    },
                    "time": {"created": 1_000, "completed": 3_500},
                    "agent": "build",
                    "modelID": "gpt-test",
                    "providerID": "openai",
                    "cost": 0.012,
                    "finish": "stop",
                    "secret": "drop",
                },
                "parts": [
                    {"type": "text", "text": "Готово"},
                    {
                        "type": "tool",
                        "tool": "context7_query-docs",
                        "state": {
                            "status": "completed",
                            "title": "Документация",
                            "input": {"secret": "drop"},
                            "output": "Найдено",
                            "metadata": {"secret": "drop"},
                            "time": {"start": 1_500, "end": 3_000},
                        },
                    },
                ],
            }
        ]

    monkeypatch.setattr(client, "request", fake_request)
    assert client.session_messages("ses_large") == [
        {
            "info": {
                "id": "msg_1",
                "role": "assistant",
                "tokens": {
                    "input": 210,
                    "output": 864,
                    "reasoning": 1331,
                    "cache": {"read": 116352, "write": 0},
                },
                "time": {"created": 1_000, "completed": 3_500},
                "agent": "build",
                "modelID": "gpt-test",
                "providerID": "openai",
                "cost": 0.012,
                "finish": "stop",
            },
            "parts": [
                {"type": "text", "text": "Готово"},
                {
                    "type": "tool",
                    "tool": "context7_query-docs",
                    "state": {
                        "status": "completed",
                        "title": "Документация",
                        "output": "Найдено",
                        "time": {"start": 1_500, "end": 3_000},
                    },
                },
            ],
        }
    ]
    assert calls == [None]


def test_session_messages_keep_cli_events_without_provider_metadata(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    raw = [
        {
            "info": {
                "id": "msg_cli",
                "role": "assistant",
                "error": {"name": "APIError", "data": {"message": "provider failed"}},
            },
            "parts": [
                {
                    "type": "reasoning",
                    "text": "Проверяю варианты",
                    "time": {"start": 1000, "end": 2500},
                    "metadata": {"secret": "drop"},
                },
                {"type": "subtask", "agent": "explore", "description": "Найти обработчик"},
                {"type": "patch", "files": ["src/app.py", "tests/test_app.py"]},
                {"type": "agent", "name": "build"},
                {
                    "type": "retry",
                    "attempt": 2,
                    "error": {"message": "rate limited", "secret": "drop"},
                },
                {"type": "compaction"},
                {"type": "snapshot", "snapshot": "secret-snapshot-id"},
                {
                    "type": "tool",
                    "tool": "read",
                    "state": {
                        "status": "completed",
                        "input": {"filePath": "/tmp/project/app.py", "token": "drop"},
                    },
                },
            ],
        }
    ]
    monkeypatch.setattr(client, "request", lambda method, path, **kwargs: raw)

    result = client.session_messages("ses_cli")[0]
    assert result["info"]["error"] == "provider failed"
    assert result["parts"][:7] == [
        {
            "type": "reasoning",
            "text": "Проверяю варианты",
            "time": {"start": 1000, "end": 2500},
        },
        {"type": "subtask", "text": "Найти обработчик", "agent": "explore"},
        {"type": "patch", "files": ["src/app.py", "tests/test_app.py"]},
        {"type": "agent", "name": "build"},
        {"type": "retry", "attempt": 2, "error": "rate limited"},
        {"type": "compaction"},
        {"type": "snapshot"},
    ]
    assert result["parts"][7]["state"]["input"] == '{\n  "filePath": "/tmp/project/app.py"\n}'


def test_session_runtime_projects_todos_and_permissions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    calls: list[tuple[str, str, Any]] = []

    def fake_request(method: str, path: str, **kwargs: Any) -> Any:
        calls.append((method, path, kwargs.get("body")))
        if path.endswith("/todo"):
            return [
                {"content": "Проверить файл", "status": "in_progress", "priority": "high"},
                {"content": "Готово", "status": "completed", "priority": "low"},
            ]
        if path == "/permission":
            return [
                {
                    "id": "per_1",
                    "sessionID": "ses_1",
                    "permission": "bash",
                    "patterns": ["npm test"],
                    "metadata": {"secret": "drop"},
                },
                {
                    "id": "per_2",
                    "sessionID": "ses_other",
                    "permission": "edit",
                    "patterns": [],
                },
                {
                    "id": "per_v2",
                    "sessionID": "ses_1",
                    "action": "external_directory",
                    "resources": ["/tmp/screenshots/*"],
                },
            ]
        return True

    monkeypatch.setattr(client, "request", fake_request)
    assert client.session_todos("ses_1")[0] == {
        "content": "Проверить файл",
        "status": "in_progress",
        "priority": "high",
    }
    assert client.session_permissions("ses_1") == [
        {"id": "per_1", "permission": "bash", "patterns": ["npm test"]},
        {
            "id": "per_v2",
            "permission": "external_directory",
            "patterns": ["/tmp/screenshots/*"],
        },
    ]
    client.reply_permission("ses_1", "per_1", "once")
    assert calls[-1] == ("POST", "/permission/per_1/reply", {"reply": "once"})


def test_messages_hide_synthetic_compaction_continuation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    raw = [
        {
            "info": {
                "id": "msg_synthetic",
                "role": "user",
            },
            "parts": [
                {
                    "type": "text",
                    "text": "Continue if you have next steps",
                    "synthetic": True,
                    "metadata": {"compaction_continue": True},
                }
            ],
        },
        {
            "info": {
                "id": "msg_compaction",
                "role": "assistant",
                "mode": "compaction",
                "summary": True,
            },
            "parts": [{"type": "text", "text": "## Objective\nInternal summary"}],
        },
        {
            "info": {"id": "msg_real", "role": "user"},
            "parts": [{"type": "text", "text": "Продолжи проверку"}],
        },
    ]
    monkeypatch.setattr(client, "request", lambda method, path, **kwargs: raw)
    assert client.session_messages("ses_1") == [
        {
            "info": {"id": "msg_real", "role": "user"},
            "parts": [{"type": "text", "text": "Продолжи проверку"}],
        }
    ]


def test_prompt_accepts_generic_attachment_without_synthetic_text(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    sent: list[dict[str, Any]] = []

    def fake_request(method: str, path: str, **kwargs: Any) -> None:
        sent.append(kwargs["body"])

    monkeypatch.setattr(client, "request", fake_request)
    client.prompt_async(
        "ses_files",
        "",
        attachments=[
            {
                "filename": "report.xlsx",
                "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "data_url": (
                    "data:application/vnd.openxmlformats-officedocument."
                    "spreadsheetml.sheet;base64,eA=="
                ),
            }
        ],
    )
    assert sent == [
        {
            "parts": [
                {
                    "type": "file",
                    "filename": "report.xlsx",
                    "mime": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "url": (
                        "data:application/vnd.openxmlformats-officedocument."
                        "spreadsheetml.sheet;base64,eA=="
                    ),
                }
            ]
        }
    ]


def test_prompt_sends_agent_mentions_as_native_parts(monkeypatch: pytest.MonkeyPatch) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    sent: list[dict[str, Any]] = []
    monkeypatch.setattr(
        client, "request", lambda method, path, **kwargs: sent.append(kwargs["body"])
    )

    client.prompt_async(
        "ses_agents",
        "Пусть @explore найдёт реализацию",
        mentions=["explore", "missing"],
    )

    assert sent == [
        {
            "parts": [
                {"type": "text", "text": "Пусть @explore найдёт реализацию"},
                {
                    "type": "agent",
                    "name": "explore",
                    "source": {"value": "@explore", "start": 6, "end": 14},
                },
            ]
        }
    ]


def test_provider_auth_catalog_is_sanitized(monkeypatch: pytest.MonkeyPatch) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    fixtures = {
        "/provider": {
            "connected": ["openai"],
            "all": [
                {"id": "openai", "name": "OpenAI", "options": {"key": "drop"}},
                {"id": "zeta", "name": "Zeta AI", "options": {"key": "drop"}},
            ],
        },
        "/provider/auth": {
            "openai": [
                {"type": "oauth", "label": "ChatGPT Plus", "secret": "drop"},
                {"type": "api", "label": "API key"},
            ]
        },
    }
    monkeypatch.setattr(client, "request", lambda method, path, **kwargs: fixtures[path])
    assert client.provider_auth_catalog() == [
        {
            "id": "openai",
            "name": "OpenAI",
            "connected": True,
            "methods": [
                {"type": "oauth", "label": "ChatGPT Plus"},
                {"type": "api", "label": "API key"},
            ],
        },
        {
            "id": "zeta",
            "name": "Zeta AI",
            "connected": False,
            "methods": [{"type": "api", "label": "API key"}],
        },
    ]


def test_session_scope_accepts_only_project_directory(monkeypatch: pytest.MonkeyPatch) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")

    def fake_request(
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        directory: bool = True,
    ) -> Any:
        return {
            "id": path.rsplit("/", 1)[-1],
            "directory": "/tmp/project/nested" if path.endswith("owned") else "/tmp/other",
        }

    monkeypatch.setattr(client, "request", fake_request)
    assert client.ensure_session_directory("owned") is True
    with pytest.raises(OpenCodeError, match="different project directory"):
        client.ensure_session_directory("foreign")


def test_snapshot_projects_only_safe_runtime_metadata(monkeypatch: pytest.MonkeyPatch) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    fixtures = {
        "/global/health": {"healthy": True, "version": "1.18.1", "secret": "drop"},
        "/session": [
            {
                "id": "ses_1",
                "title": "Work",
                "directory": "/tmp/project",
                "messages": ["drop"],
            },
            {"id": "ses_nested", "title": "Nested", "directory": "/tmp/project/src"},
            {"id": "ses_foreign", "title": "Foreign", "directory": "/tmp/other"},
        ],
        "/session/status": {
            "ses_1": {"type": "busy", "details": "drop"},
            "ses_foreign": {"type": "busy"},
        },
        "/agent": [{"name": "build", "mode": "primary", "prompt": "drop"}],
        "/mcp": {"github": {"status": "connected", "headers": {"token": "drop"}}},
        "/provider": {
            "connected": ["openai"],
            "default": {"openai": "gpt"},
            "all": [
                {
                    "id": "openai",
                    "name": "OpenAI",
                    "options": {"apiKey": "drop"},
                    "models": {"gpt": {"headers": {"Authorization": "drop"}}},
                },
                {"id": "unused", "name": "Unused", "models": {"other": {}}},
            ],
        },
        "/config": {
            "model": "openai/gpt",
            "default_agent": "build",
            "provider": {"openai": {"options": {"apiKey": "drop"}}},
            "mcp": {
                "github": {
                    "type": "remote",
                    "enabled": True,
                    "headers": {"Authorization": "drop"},
                }
            },
        },
    }

    def fake_request(
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        directory: bool = True,
    ) -> Any:
        return fixtures[path]

    monkeypatch.setattr(client, "request", fake_request)
    snapshot = client.snapshot()

    serialized = json.dumps(snapshot)
    assert "drop" not in serialized
    assert [item["id"] for item in snapshot["sessions"]] == ["ses_1", "ses_nested"]
    assert snapshot["statuses"] == {"ses_1": {"type": "busy", "status": None}}
    assert snapshot["providers"] == {
        "connected": ["openai"],
        "available": [
            {
                "id": "openai",
                "name": "OpenAI",
                "model_count": 1,
                "models": ["openai/gpt"],
                "default_model": "openai/gpt",
            }
        ],
    }
    assert snapshot["config"] == {
        "model": "openai/gpt",
        "default_agent": "build",
        "configured_providers": ["openai"],
        "mcp": {"github": {"type": "remote", "enabled": True}},
    }


def test_snapshot_derives_busy_status_from_external_session_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    monkeypatch.setattr("opencode_studio.opencode_client.time.time", lambda: 10.0)
    fixtures: dict[str, Any] = {
        "/global/health": {"healthy": True},
        "/session": [
            {
                "id": "ses_running",
                "directory": "/tmp/project",
                "time": {"updated": 3_000},
            },
            {
                "id": "ses_done",
                "directory": "/tmp/project",
                "time": {"updated": 2_000},
            },
        ],
        "/session/status": {},
        "/agent": [],
        "/mcp": {},
        "/provider": {},
        "/config": {},
        "/session/ses_running/message": [
            {
                "info": {
                    "id": "msg_running",
                    "role": "assistant",
                    "time": {"created": 2_500},
                },
                "parts": [
                    {"type": "tool", "state": {"status": "running"}}
                ],
            }
        ],
        "/session/ses_done/message": [
            {
                "info": {
                    "id": "msg_done",
                    "role": "assistant",
                    "time": {"created": 1_000, "completed": 1_900},
                },
                "parts": [{"type": "text", "text": "Done"}],
            }
        ],
    }
    calls: list[tuple[str, dict[str, str | int] | None]] = []

    def fake_request(method: str, path: str, **kwargs: Any) -> Any:
        calls.append((path, kwargs.get("query")))
        return fixtures[path]

    monkeypatch.setattr(client, "request", fake_request)

    assert client.snapshot()["statuses"] == {
        "ses_running": {"type": "busy", "status": None}
    }
    assert ("/session/ses_running/message", {"limit": 1}) in calls
    assert ("/session/ses_done/message", {"limit": 1}) in calls


def test_snapshot_ignores_stale_unfinished_messages_but_preserves_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client = OpenCodeClient("http://127.0.0.1:4096", "/tmp/project")
    monkeypatch.setattr("opencode_studio.opencode_client.time.time", lambda: 1_000.0)
    fixtures: dict[str, Any] = {
        "/global/health": {"healthy": True},
        "/session": [
            {
                "id": "ses_failed",
                "directory": "/tmp/project",
                "time": {"updated": 2_000},
            },
            {
                "id": "ses_stale",
                "directory": "/tmp/project",
                "time": {"updated": 1_000},
            },
        ],
        "/session/status": {},
        "/agent": [],
        "/mcp": {},
        "/provider": {},
        "/config": {},
        "/session/ses_failed/message": [
            {
                "info": {
                    "role": "assistant",
                    "time": {"created": 2_000},
                    "error": {
                        "name": "ProviderError",
                        "data": {"message": "token limit exhausted"},
                    },
                },
                "parts": [],
            }
        ],
        "/session/ses_stale/message": [
            {
                "info": {"role": "assistant", "time": {"created": 1_000}},
                "parts": [{"type": "step-start"}],
            }
        ],
    }

    monkeypatch.setattr(client, "request", lambda method, path, **kwargs: fixtures[path])

    assert client.snapshot()["statuses"] == {
        "ses_failed": {
            "type": "failed",
            "status": None,
            "error": "token limit exhausted",
        }
    }
