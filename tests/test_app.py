from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

import opencode_studio.app as app_module
from opencode_studio.app import create_app
from opencode_studio.config import StudioConfig
from opencode_studio.store import StudioStore
from opencode_studio.workspace import WorkspaceError, read_text, root_identity, write_text


def _client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(StudioConfig(data_dir=tmp_path / "data")))


def _csrf(client: TestClient) -> dict[str, str]:
    response = client.get("/api/v1/session")
    assert response.status_code == 200
    return {"X-CSRF-Token": response.json()["csrf_token"]}


def _project(client: TestClient, root: Path, *, endpoint: str | None = None) -> dict[str, Any]:
    response = client.post(
        "/api/v1/projects",
        headers=_csrf(client),
        json={"name": "Test project", "root": str(root), "endpoint": endpoint},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_project_registry_requires_csrf_and_stays_local(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    with _client(tmp_path) as client:
        rejected = client.post(
            "/api/v1/projects",
            json={"name": "Test", "root": str(root), "endpoint": None},
        )
        assert rejected.status_code == 403

        project = _project(client, root)
        assert project["root"] == str(root.resolve())
        assert project["server"]["state"] == "stopped"

        duplicate = client.post(
            "/api/v1/projects",
            headers=_csrf(client),
            json={"name": "Again", "root": str(root), "endpoint": None},
        )
        assert duplicate.status_code == 409

        hostile_host = client.get("/api/v1/projects", headers={"Host": "example.com"})
        assert hostile_host.status_code == 400


def test_store_backfills_legacy_task_session_links(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    data = tmp_path / "data"
    store = StudioStore(data)
    project = store.create_project(name="Project", root=root, endpoint=None)
    task = store.create_task(
        str(project["id"]),
        title="Legacy task",
        prompt="Work",
        agent=None,
        model=None,
    )
    store.update_task(
        str(project["id"]), str(task["id"]), status="completed", session_id="ses_legacy"
    )
    store.close()
    connection = sqlite3.connect(data / "studio.sqlite")
    with connection:
        connection.execute("DELETE FROM task_sessions")
    connection.close()

    reopened = StudioStore(data)
    migrated = reopened.get_task(str(project["id"]), str(task["id"]))
    reopened.close()
    assert migrated is not None
    assert migrated["session_ids"] == ["ses_legacy"]


def test_workspace_configuration_surfaces(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)

        instructions = client.put(
            f"/api/v1/projects/{project_id}/instructions",
            headers=headers,
            json={"content": "# Work carefully\n"},
        )
        assert instructions.status_code == 200
        assert (root / "AGENTS.md").read_text() == "# Work carefully\n"

        agent = client.put(
            f"/api/v1/projects/{project_id}/agents/reviewer",
            headers=headers,
            json={
                "content": "---\ndescription: Review changes\nmode: subagent\n---\nBe strict.\n"
            },
        )
        assert agent.status_code == 200
        assert client.get(f"/api/v1/projects/{project_id}/agents").json()[0]["mode"] == "subagent"

        skill = client.put(
            f"/api/v1/projects/{project_id}/skills/release",
            headers=headers,
            json={"content": "---\nname: release\ndescription: Ship safely\n---\n# Steps\n"},
        )
        assert skill.status_code == 200
        assert (root / ".opencode/skills/release/SKILL.md").is_file()
        listed_skill = next(
            item
            for item in client.get(f"/api/v1/projects/{project_id}/skills").json()
            if item["id"] == "release"
        )
        assert listed_skill["effective_name"] == "release"
        removed_skill = client.delete(
            f"/api/v1/projects/{project_id}/skills/release",
            headers=headers,
        )
        assert removed_skill.status_code == 204
        assert not (root / ".opencode/skills/release").exists()

        mcp = client.put(
            f"/api/v1/projects/{project_id}/mcp/github",
            headers=headers,
            json={
                "config": {
                    "type": "remote",
                    "url": "https://example.test/mcp",
                    "headers": {"Authorization": "secret-value"},
                    "env": {"GITHUB_PAT": "github_pat_abcdefghijklmnopqrstuvwxyz"},
                    "command": ["tool", "--token", "command-secret-value"],
                }
            },
        )
        assert mcp.status_code == 200
        assert mcp.json()["config"]["headers"]["Authorization"] == "[REDACTED]"
        assert mcp.json()["config"]["env"]["GITHUB_PAT"] == "[REDACTED]"
        assert mcp.json()["config"]["command"][-1] == "[REDACTED]"
        persisted = json.loads((root / "opencode.json").read_text())
        assert persisted["mcp"]["github"]["headers"]["Authorization"] == "secret-value"
        assert persisted["mcp"]["github"]["command"][-1] == "command-secret-value"

        config_payload = client.get(f"/api/v1/projects/{project_id}/configuration").json()
        config = config_payload["project"]
        assert config_payload["project_path"] == str(root / "opencode.json")
        assert config["mcp"]["github"]["headers"]["Authorization"] == "[REDACTED]"

        ollama = client.put(
            f"/api/v1/projects/{project_id}/providers/ollama/configuration",
            headers=headers,
            json={
                "name": "Ollama (local)",
                "base_url": "http://localhost:11434/v1",
                "models": ["qwen3-coder:30b"],
                "api_key": None,
            },
        )
        assert ollama.status_code == 200
        persisted = json.loads((root / "opencode.json").read_text())
        assert persisted["provider"]["ollama"] == {
            "npm": "@ai-sdk/openai-compatible",
            "name": "Ollama (local)",
            "options": {"baseURL": "http://localhost:11434/v1"},
            "models": {"qwen3-coder:30b": {"name": "qwen3-coder:30b"}},
        }
        config = client.get(f"/api/v1/projects/{project_id}/configuration").json()["project"]
        assert config["provider"]["ollama"]["options"] == {
            "baseURL": "http://localhost:11434/v1"
        }

        round_trip = client.put(
            f"/api/v1/projects/{project_id}/mcp/github",
            headers=headers,
            json={"config": config["mcp"]["github"]},
        )
        assert round_trip.status_code == 200
        persisted = json.loads((root / "opencode.json").read_text())
        assert persisted["mcp"]["github"]["headers"]["Authorization"] == "secret-value"


def test_global_agents_and_skills_use_global_scope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    (home / ".config/opencode").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    root = tmp_path / "project"
    root.mkdir()
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)

        agent = client.put(
            f"/api/v1/projects/{project_id}/agents/reviewer",
            headers=headers,
            json={"content": "---\ndescription: Review changes\n---\n", "scope": "global"},
        )
        skill = client.put(
            f"/api/v1/projects/{project_id}/skills/release",
            headers=headers,
            json={
                "content": "---\nname: release\ndescription: Ship safely\n---\n",
                "scope": "global",
            },
        )

        assert agent.status_code == 200
        assert skill.status_code == 200
        assert (home / ".config/opencode/agents/reviewer.md").is_file()
        assert (home / ".config/opencode/skills/release/SKILL.md").is_file()
        assert client.get(f"/api/v1/projects/{project_id}/agents").json()[0]["scope"] == "global"
        assert client.get(f"/api/v1/projects/{project_id}/skills").json()[0]["scope"] == "global"

        removed = client.delete(
            f"/api/v1/projects/{project_id}/agents/reviewer?scope=global",
            headers=headers,
        )
        assert removed.status_code == 204
        assert not (home / ".config/opencode/agents/reviewer.md").exists()
        removed_skill = client.delete(
            f"/api/v1/projects/{project_id}/skills/release?scope=global",
            headers=headers,
        )
        assert removed_skill.status_code == 204
        assert not (home / ".config/opencode/skills/release").exists()


def test_project_and_global_jsonc_are_editable_without_losing_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    global_root = home / ".config/opencode"
    global_root.mkdir(parents=True)
    global_path = global_root / "opencode.jsonc"
    global_path.write_text(
        '{\n  // shared provider\n  "model": "openai/global",\n  "apiKey": "global-secret",\n}\n'
    )
    monkeypatch.setenv("HOME", str(home))
    root = tmp_path / "project"
    root.mkdir()
    project_path = root / "opencode.jsonc"
    project_path.write_text(
        '{\n  // project override\n  "model": "openai/project",\n  "apiKey": "project-secret",\n}\n'
    )

    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)
        loaded = client.get(f"/api/v1/projects/{project_id}/configuration")
        assert loaded.status_code == 200
        assert loaded.json() == {
            "project": {"model": "openai/project", "apiKey": "[REDACTED]"},
            "project_path": str(project_path),
            "global": {"model": "openai/global", "apiKey": "[REDACTED]"},
            "global_path": str(global_path),
        }

        saved_project = client.patch(
            f"/api/v1/projects/{project_id}/configuration",
            headers=headers,
            json={
                "scope": "project",
                "values": {"model": "openai/new-project", "apiKey": "[REDACTED]"},
            },
        )
        assert saved_project.status_code == 200
        assert not (root / "opencode.json").exists()
        assert json.loads(project_path.read_text()) == {
            "model": "openai/new-project",
            "apiKey": "project-secret",
        }

        saved_global = client.patch(
            f"/api/v1/projects/{project_id}/configuration",
            headers=headers,
            json={
                "scope": "global",
                "values": {"model": "openai/new-global", "apiKey": "[REDACTED]"},
            },
        )
        assert saved_global.status_code == 200
        assert not (global_root / "opencode.json").exists()
        assert json.loads(global_path.read_text()) == {
            "model": "openai/new-global",
            "apiKey": "global-secret",
        }


def test_mcp_enabled_updates_preserve_global_and_project_definitions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    global_root = home / ".config/opencode"
    global_root.mkdir(parents=True)
    global_path = global_root / "opencode.jsonc"
    global_path.write_text(
        """{
  // Global server inherited by projects.
  "mcp": {
    "docs": {
      "type": "remote",
      "url": "https://example.test/mcp",
      "enabled": false,
    },
  },
}
"""
    )
    monkeypatch.setenv("HOME", str(home))
    root = tmp_path / "project"
    root.mkdir()
    (root / "opencode.json").write_text(
        json.dumps(
            {
                "mcp": {
                    "local-tool": {
                        "type": "local",
                        "command": ["local-tool", "serve"],
                        "enabled": True,
                    }
                }
            }
        )
    )

    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)
        global_mcp = client.get(f"/api/v1/projects/{project_id}/mcp/global")
        assert global_mcp.json()["docs"]["enabled"] is False

        enabled_global = client.patch(
            f"/api/v1/projects/{project_id}/mcp/docs/enabled",
            headers=headers,
            json={"scope": "global", "enabled": True},
        )
        assert enabled_global.status_code == 200
        persisted_global = json.loads(global_path.read_text())
        assert persisted_global["mcp"]["docs"] == {
            "type": "remote",
            "url": "https://example.test/mcp",
            "enabled": True,
        }

        disabled_local = client.patch(
            f"/api/v1/projects/{project_id}/mcp/local-tool/enabled",
            headers=headers,
            json={"scope": "project", "enabled": False},
        )
        assert disabled_local.status_code == 200
        persisted_project = json.loads((root / "opencode.json").read_text())
        assert persisted_project["mcp"]["local-tool"]["command"] == [
            "local-tool",
            "serve",
        ]
        assert persisted_project["mcp"]["local-tool"]["enabled"] is False

        project_override = client.patch(
            f"/api/v1/projects/{project_id}/mcp/docs/enabled",
            headers=headers,
            json={"scope": "project", "enabled": False},
        )
        assert project_override.status_code == 200
        persisted_project = json.loads((root / "opencode.json").read_text())
        assert persisted_project["mcp"]["docs"] == {"enabled": False}


def test_workspace_rejects_invalid_ids_and_symlink_targets(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("outside")
    (root / "AGENTS.md").symlink_to(outside)
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)
        invalid = client.put(
            f"/api/v1/projects/{project_id}/agents/bad%20agent",
            headers=headers,
            json={"content": "unsafe"},
        )
        assert invalid.status_code == 400
        linked = client.put(
            f"/api/v1/projects/{project_id}/instructions",
            headers=headers,
            json={"content": "replacement"},
        )
        assert linked.status_code == 400
        assert outside.read_text() == "outside"


def test_workspace_rejects_hard_links(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    source = tmp_path / "source"
    source.write_text("shared")
    os.link(source, root / "AGENTS.md")
    workspace = root_identity(root)
    with pytest.raises(WorkspaceError):
        read_text(workspace, Path("AGENTS.md"))
    with pytest.raises(WorkspaceError):
        write_text(workspace, Path("AGENTS.md"), "new")
    assert source.read_text() == "shared"


def test_workspace_rejects_symlinked_skill_directory_and_replaced_root(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text("---\nname: stolen\n---\nsecret")
    skill_root = root / ".agents/skills"
    skill_root.mkdir(parents=True)
    (skill_root / "stolen").symlink_to(outside, target_is_directory=True)
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        skills = client.get(f"/api/v1/projects/{project_id}/skills").json()
        assert all(item["id"] != "stolen" for item in skills)

        original = tmp_path / "original"
        root.rename(original)
        root.symlink_to(outside, target_is_directory=True)
        response = client.get(f"/api/v1/projects/{project_id}/instructions")
        assert response.status_code == 400


def test_task_launch_uses_dedicated_opencode_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    calls: list[tuple[str, Any]] = []
    created_sessions = iter(("ses_task", "ses_extra", "ses_extra_2"))

    class FakeOpenCodeClient:
        def __init__(self, endpoint: str, directory: str, **kwargs: Any) -> None:
            calls.append(("init", endpoint))

        def request(
            self,
            method: str,
            path: str,
            *,
            body: dict[str, Any] | None = None,
            directory: bool = True,
        ) -> dict[str, Any]:
            return {"worktree": str(root)}

        def create_session(self, title: str | None = None) -> dict[str, Any]:
            calls.append(("session", title))
            return {"id": next(created_sessions), "title": title}

        def delete_session(self, session_id: str, *, missing_ok: bool = False) -> None:
            calls.append(("delete_session", (session_id, missing_ok)))

        def ensure_session_directory(
            self, session_id: str, *, missing_ok: bool = False
        ) -> bool:
            calls.append(("ensure_session", (session_id, missing_ok)))
            return True

        def snapshot(self) -> dict[str, Any]:
            return {
                "state": "connected",
                "errors": [],
                "sessions": [
                    {"id": "ses_task", "title": "Review auth"},
                    {"id": "ses_extra", "title": "Alternative review"},
                    {"id": "ses_extra_2", "title": "Replacement review"},
                    {"id": "ses_child", "title": "Subagent", "parentID": "ses_task"},
                    {"id": "ses_cli", "title": "CLI session"},
                ],
                "statuses": {},
                "agents": [],
                "mcp": {},
                "providers": {},
                "config": {},
            }

        def prompt_async(
            self,
            session_id: str,
            prompt: str,
            *,
            agent: str | None = None,
            model: str | None = None,
            attachments: list[dict[str, str]] | None = None,
            mentions: list[str] | None = None,
        ) -> None:
            calls.append(("prompt", (session_id, prompt, agent, model, attachments)))
            if mentions:
                calls.append(("mentions", mentions))

        def session_todos(self, session_id: str) -> list[dict[str, str]]:
            return [{"content": "Run tests", "status": "in_progress", "priority": "high"}]

        def session_permissions(self, session_id: str) -> list[dict[str, Any]]:
            return [{"id": "per_1", "permission": "bash", "patterns": ["pytest"]}]

        def reply_permission(self, session_id: str, permission_id: str, reply: str) -> None:
            calls.append(("permission", (session_id, permission_id, reply)))

    monkeypatch.setattr(app_module, "OpenCodeClient", FakeOpenCodeClient)
    with _client(tmp_path) as client:
        project_id = _project(client, root, endpoint="http://127.0.0.1:4096")["id"]
        response = client.post(
            f"/api/v1/projects/{project_id}/tasks",
            headers=_csrf(client),
            json={
                "title": "Review auth",
                "prompt": "Find authorization gaps and add tests.",
                "agent": "reviewer",
                "model": "openai/gpt-test",
                "attachments": [
                    {
                        "filename": "screen.png",
                        "mime": "image/png",
                        "data_url": "data:image/png;base64,aW1hZ2U=",
                    }
                ],
            },
        )
        assert response.status_code == 202
        assert response.json()["session_id"] == "ses_task"
        assert response.json()["session_ids"] == ["ses_task"]
        assert response.json()["status"] == "running"
        assert ("session", "Review auth") in calls
        assert (
            "prompt",
            (
                "ses_task",
                "Ожидаемый результат: Review auth\n\n"
                "Подробное задание:\nFind authorization gaps and add tests.",
                "reviewer",
                "openai/gpt-test",
                [
                    {
                        "filename": "screen.png",
                        "mime": "image/png",
                        "data_url": "data:image/png;base64,aW1hZ2U=",
                    }
                ],
            ),
        ) in calls

        client.app.state.studio.store.update_task(
            project_id, response.json()["id"], status="completed"
        )
        rerun = client.post(
            f"/api/v1/projects/{project_id}/tasks/{response.json()['id']}/rerun",
            headers=_csrf(client),
            json={},
        )
        assert rerun.status_code == 202
        assert rerun.json()["session_id"] == "ses_task"
        assert calls[-1][0] == "prompt"
        assert calls[-1][1][0] == "ses_task"
        assert "Продолжи задачу в этой же сессии" in calls[-1][1][1]
        assert len([call for call in calls if call[0] == "session"]) == 1

        todos = client.get(f"/api/v1/projects/{project_id}/sessions/ses_task/todos")
        assert todos.json()[0]["status"] == "in_progress"
        permissions = client.get(
            f"/api/v1/projects/{project_id}/sessions/ses_task/permissions"
        )
        assert permissions.json()[0]["id"] == "per_1"
        permission_reply = client.post(
            f"/api/v1/projects/{project_id}/sessions/ses_task/permissions/per_1/reply",
            headers=_csrf(client),
            json={"reply": "once"},
        )
        assert permission_reply.status_code == 200
        assert calls[-1] == ("permission", ("ses_task", "per_1", "once"))

        follow_up = client.post(
            f"/api/v1/projects/{project_id}/sessions/ses_task/prompt",
            headers=_csrf(client),
            json={
                "prompt": "@explore Run the tests again",
                "agent": "plan",
                "model": "openai/gpt-next",
                "mentions": ["explore"],
            },
        )
        assert follow_up.status_code == 202
        assert calls[-1] == ("mentions", ["explore"])
        resumed = client.app.state.studio.store.get_task(project_id, response.json()["id"])
        assert resumed is not None
        assert resumed["status"] == "running"
        assert resumed["prompt"] == "@explore Run the tests again"
        assert resumed["agent"] == "plan"
        assert resumed["model"] == "openai/gpt-next"

        stopped = client.post(
            f"/api/v1/projects/{project_id}/sessions/ses_task/abort",
            headers=_csrf(client),
            json={},
        )
        assert stopped.status_code == 200
        assert client.app.state.studio.store.get_task(project_id, response.json()["id"])[
            "status"
        ] == "aborted"

        client.app.state.studio.store.update_task(
            project_id, response.json()["id"], status="completed"
        )
        rerun_updated = client.post(
            f"/api/v1/projects/{project_id}/tasks/{response.json()['id']}/rerun",
            headers=_csrf(client),
            json={},
        )
        assert rerun_updated.status_code == 202
        assert "Актуальное задание:\n@explore Run the tests again" in calls[-1][1][1]

        file_only = client.post(
            f"/api/v1/projects/{project_id}/sessions/ses_task/prompt",
            headers=_csrf(client),
            json={
                "prompt": "",
                "attachments": [
                    {
                        "filename": "report.pdf",
                        "mime": "application/pdf",
                        "data_url": "data:application/pdf;base64,UERG",
                    }
                ],
            },
        )
        assert file_only.status_code == 202
        assert calls[-1][1][-1][0]["mime"] == "application/pdf"
        after_file = client.app.state.studio.store.get_task(project_id, response.json()["id"])
        assert after_file is not None
        assert after_file["prompt"] == "@explore Run the tests again"
        assert after_file["agent"] == "plan"
        assert after_file["model"] == "openai/gpt-next"

        extra = client.post(
            f"/api/v1/projects/{project_id}/tasks/{response.json()['id']}/sessions",
            headers=_csrf(client),
            json={"title": "Alternative review"},
        )
        assert extra.status_code == 201
        assert extra.json()["id"] == "ses_extra"
        task = client.get(f"/api/v1/projects/{project_id}/tasks").json()[0]
        assert task["session_ids"] == ["ses_task", "ses_extra"]

        snapshot = client.get(f"/api/v1/projects/{project_id}/snapshot").json()
        sessions = {item["id"]: item for item in snapshot["sessions"]}
        assert sessions["ses_task"]["studio_task"]["title"] == "Review auth"
        assert sessions["ses_task"]["studio_task"]["status"] == "running"
        assert sessions["ses_extra"]["studio_task"]["title"] == "Review auth"
        assert sessions["ses_child"]["studio_task"]["title"] == "Review auth"
        assert "studio_task" not in sessions["ses_cli"]

        removed_session = client.delete(
            f"/api/v1/projects/{project_id}/sessions/ses_extra",
            headers=_csrf(client),
        )
        assert removed_session.status_code == 204
        task = client.get(f"/api/v1/projects/{project_id}/tasks").json()[0]
        assert task["session_ids"] == ["ses_task"]
        replacement = client.post(
            f"/api/v1/projects/{project_id}/tasks/{response.json()['id']}/sessions",
            headers=_csrf(client),
            json={"title": "Replacement review"},
        )
        assert replacement.json()["id"] == "ses_extra_2"

        active_delete = client.delete(
            f"/api/v1/projects/{project_id}/tasks/{response.json()['id']}",
            headers=_csrf(client),
        )
        assert active_delete.status_code == 409
        aborted = client.post(
            f"/api/v1/projects/{project_id}/tasks/{response.json()['id']}/abort",
            headers=_csrf(client),
            json={},
        )
        assert aborted.status_code == 200
        deleted = client.delete(
            f"/api/v1/projects/{project_id}/tasks/{response.json()['id']}",
            headers=_csrf(client),
        )
        assert deleted.status_code == 204
        assert ("delete_session", ("ses_task", True)) in calls
        assert ("delete_session", ("ses_extra", True)) in calls
        assert ("delete_session", ("ses_extra_2", True)) in calls
        assert client.get(f"/api/v1/projects/{project_id}/tasks").json() == []


def test_provider_auth_uses_managed_opencode_without_echoing_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    calls: list[tuple[str, Any]] = []

    class FakeOpenCodeClient:
        def __init__(self, endpoint: str, directory: str, **kwargs: Any) -> None:
            calls.append(("init", (endpoint, directory)))

        def provider_auth_catalog(self) -> list[dict[str, Any]]:
            return [
                {
                    "id": "openai",
                    "name": "OpenAI",
                    "connected": False,
                    "methods": [{"type": "api", "label": "API key"}],
                }
            ]

        def set_provider_api_key(
            self, provider_id: str, key: str, metadata: dict[str, str]
        ) -> None:
            calls.append(("key", (provider_id, key, metadata)))

    monkeypatch.setattr(app_module, "OpenCodeClient", FakeOpenCodeClient)
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        manager = client.app.state.studio.processes
        monkeypatch.setattr(
            manager,
            "connection",
            lambda candidate: SimpleNamespace(
                endpoint="http://127.0.0.1:4096", password="managed-secret"
            ),
        )
        catalog = client.get(f"/api/v1/projects/{project_id}/providers/auth")
        assert catalog.status_code == 200
        assert catalog.json()[0]["name"] == "OpenAI"
        connected = client.put(
            f"/api/v1/projects/{project_id}/providers/openai/auth",
            headers=_csrf(client),
            json={"key": "provider-secret"},
        )
        assert connected.status_code == 200
        assert connected.json() == {"connected": True}
        assert "provider-secret" not in connected.text
        assert ("key", ("openai", "provider-secret", {})) in calls
        invalid = client.put(
            f"/api/v1/projects/{project_id}/providers/openai/auth",
            headers=_csrf(client),
            json={"key": "must-not-leak", "unexpected": True},
        )
        assert invalid.status_code == 422
        assert "must-not-leak" not in invalid.text


def test_scheduled_task_can_be_paused_and_resumed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()

    class FakeOpenCodeClient:
        def __init__(self, endpoint: str, directory: str, **kwargs: Any) -> None:
            return

        def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
            return {"worktree": str(root)}

    monkeypatch.setattr(app_module, "OpenCodeClient", FakeOpenCodeClient)
    with _client(tmp_path) as client:
        project_id = _project(client, root, endpoint="http://127.0.0.1:4096")["id"]
        headers = _csrf(client)
        created = client.post(
            f"/api/v1/projects/{project_id}/tasks",
            headers=headers,
            json={
                "title": "Morning report",
                "prompt": "Prepare the report",
                "cron": "0 9 * * 1-5",
                "timezone": "Europe/Moscow",
            },
        )
        assert created.status_code == 202
        task = created.json()
        assert task["status"] == "scheduled"
        assert task["schedule_enabled"] == 1
        assert task["cron_session_mode"] == "new"
        assert task["next_run_at"]
        assert task["session_ids"] == []

        paused = client.patch(
            f"/api/v1/projects/{project_id}/tasks/{task['id']}/schedule",
            headers=headers,
            json={"enabled": False},
        )
        assert paused.status_code == 200
        assert paused.json()["schedule_enabled"] == 0
        assert paused.json()["status"] == "paused"
        assert paused.json()["next_run_at"] is None

        resumed = client.patch(
            f"/api/v1/projects/{project_id}/tasks/{task['id']}/schedule",
            headers=headers,
            json={"enabled": True},
        )
        assert resumed.status_code == 200
        assert resumed.json()["schedule_enabled"] == 1
        assert resumed.json()["next_run_at"]

        manual = client.patch(
            f"/api/v1/projects/{project_id}/tasks/{task['id']}/schedule",
            headers=headers,
            json={"mode": "manual"},
        )
        assert manual.status_code == 200
        assert manual.json()["cron"] is None
        assert manual.json()["timezone"] is None
        assert manual.json()["schedule_enabled"] == 0
        assert manual.json()["status"] == "completed"

        scheduled_again = client.patch(
            f"/api/v1/projects/{project_id}/tasks/{task['id']}/schedule",
            headers=headers,
            json={
                "mode": "cron",
                "cron": "30 8 * * *",
                "timezone": "Europe/Paris",
                "cron_session_mode": "reuse",
                "enabled": True,
            },
        )
        assert scheduled_again.status_code == 200
        assert scheduled_again.json()["cron"] == "30 8 * * *"
        assert scheduled_again.json()["timezone"] == "Europe/Paris"
        assert scheduled_again.json()["cron_session_mode"] == "reuse"
        assert scheduled_again.json()["status"] == "scheduled"
        assert scheduled_again.json()["next_run_at"]

        bad_timezone = client.patch(
            f"/api/v1/projects/{project_id}/tasks/{task['id']}/schedule",
            headers=headers,
            json={"mode": "cron", "cron": "0 9 * * *", "timezone": "Mars/Olympus"},
        )
        assert bad_timezone.status_code == 422

        invalid = client.post(
            f"/api/v1/projects/{project_id}/tasks",
            headers=headers,
            json={"title": "Bad", "prompt": "Bad cron", "cron": "every day"},
        )
        assert invalid.status_code == 422


def test_scheduled_task_uses_a_fresh_session_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    prompted = threading.Event()
    calls: list[tuple[str, Any]] = []

    class FakeOpenCodeClient:
        def __init__(self, endpoint: str, directory: str, **kwargs: Any) -> None:
            return

        def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
            return {"worktree": str(root)}

        def create_session(self, title: str | None = None) -> dict[str, Any]:
            calls.append(("session", title))
            return {"id": "ses_fresh", "title": title}

        def prompt_async(
            self,
            session_id: str,
            prompt: str,
            **kwargs: Any,
        ) -> None:
            calls.append(("prompt", (session_id, prompt)))
            prompted.set()

    monkeypatch.setattr(app_module, "OpenCodeClient", FakeOpenCodeClient)
    client = _client(tmp_path)
    store = client.app.state.studio.store
    project = store.create_project(
        name="Scheduled project",
        root=root,
        endpoint="http://127.0.0.1:4096",
    )
    task = store.create_task(
        str(project["id"]),
        title="Fresh report",
        prompt="Build the report",
        agent=None,
        model=None,
        cron="* * * * *",
        timezone="UTC",
        next_run_at="2020-01-01T00:00:00+00:00",
    )
    store.update_task(
        str(project["id"]), str(task["id"]), status="completed", session_id="ses_old"
    )
    store.add_task_session(str(project["id"]), str(task["id"]), "ses_old")

    with client:
        assert prompted.wait(timeout=2)
        updated = store.get_task(str(project["id"]), str(task["id"]))

    assert updated is not None
    assert updated["session_id"] == "ses_fresh"
    assert updated["session_ids"] == ["ses_old", "ses_fresh"]
    assert calls[0] == ("session", "Fresh report")
    assert calls[1][0] == "prompt"
    assert calls[1][1][0] == "ses_fresh"
    assert "Продолжи задачу в этой же сессии" not in calls[1][1][1]


def test_git_status_diff_and_commit_are_scoped_to_project(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()

    def git(*arguments: str) -> None:
        subprocess.run(["git", "-C", str(root), *arguments], check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.name", "Studio Test")
    git("config", "user.email", "studio@example.test")
    tracked = root / "tracked.txt"
    tracked.write_text("before\n")
    git("add", "tracked.txt")
    git("commit", "-q", "-m", "Initial")
    tracked.write_text("after\n")
    (root / "new.txt").write_text("new\n")

    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        state = client.get(f"/api/v1/projects/{project_id}/git")
        assert state.status_code == 200
        assert state.json()["available"] is True
        assert {item["path"] for item in state.json()["changes"]} == {
            "new.txt",
            "tracked.txt",
        }
        assert all(not item["staged"] for item in state.json()["changes"])

        diff = client.get(
            f"/api/v1/projects/{project_id}/git/diff", params={"path": "tracked.txt"}
        )
        assert diff.status_code == 200
        assert "+after" in diff.json()["diff"]

        staged = client.post(
            f"/api/v1/projects/{project_id}/git/stage",
            headers=_csrf(client),
            json={"paths": ["tracked.txt"]},
        )
        assert staged.status_code == 200
        staged_changes = {item["path"]: item for item in staged.json()["changes"]}
        assert staged_changes["tracked.txt"]["staged"] is True
        assert staged_changes["new.txt"]["staged"] is False

        unstaged = client.post(
            f"/api/v1/projects/{project_id}/git/unstage",
            headers=_csrf(client),
            json={"paths": ["tracked.txt"]},
        )
        assert unstaged.status_code == 200
        assert all(not item["staged"] for item in unstaged.json()["changes"])

        staged_all = client.post(
            f"/api/v1/projects/{project_id}/git/stage",
            headers=_csrf(client),
            json={"paths": ["tracked.txt", "new.txt"]},
        )
        assert staged_all.status_code == 200
        assert all(item["staged"] for item in staged_all.json()["changes"])

        committed = client.post(
            f"/api/v1/projects/{project_id}/git/commit",
            headers=_csrf(client),
            json={"message": "Update project files", "paths": ["tracked.txt", "new.txt"]},
        )
        assert committed.status_code == 200
        assert committed.json()["committed"] is True
        assert committed.json()["state"]["changes"] == []

        reverted = client.post(
            f"/api/v1/projects/{project_id}/git/revert",
            headers=_csrf(client),
            json={"commit": committed.json()["hash"]},
        )
        assert reverted.status_code == 200
        assert reverted.json()["reverted"] is True
        assert tracked.read_text() == "before\n"
        assert not (root / "new.txt").exists()

        reset = client.post(
            f"/api/v1/projects/{project_id}/git/reset",
            headers=_csrf(client),
            json={"commit": committed.json()["hash"]},
        )
        assert reset.status_code == 200
        assert reset.json()["reset"] is True
        assert reset.json()["backup_branch"].startswith("studio-backup/")
        assert tracked.read_text() == "after\n"
        assert (root / "new.txt").read_text() == "new\n"

        tracked.write_text("uncommitted\n")
        blocked_reset = client.post(
            f"/api/v1/projects/{project_id}/git/reset",
            headers=_csrf(client),
            json={"commit": reset.json()["previous_hash"]},
        )
        assert blocked_reset.status_code == 409
        assert tracked.read_text() == "uncommitted\n"

        outside = client.get(
            f"/api/v1/projects/{project_id}/git/diff", params={"path": "../secret.txt"}
        )
        assert outside.status_code == 400


def test_skill_save_restarts_running_managed_server(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        manager = client.app.state.studio.processes
        restarted: list[str] = []
        monkeypatch.setattr(
            manager,
            "status",
            lambda candidate: {
                "state": "running",
                "managed": True,
                "endpoint": "http://127.0.0.1:4096",
            },
        )
        monkeypatch.setattr(
            manager,
            "restart_if_running",
            lambda candidate, workspace: restarted.append(candidate)
            or {"state": "running", "managed": True},
        )
        saved = client.put(
            f"/api/v1/projects/{project_id}/skills/parser",
            headers=_csrf(client),
            json={
                "content": "---\nname: hacker-news-parser\ndescription: Parse news\n---\n"
            },
        )
        assert saved.status_code == 200
        assert saved.json()["restarted"][project_id]["state"] == "running"
        assert restarted == [project_id]
        skill = next(
            item
            for item in client.get(f"/api/v1/projects/{project_id}/skills").json()
            if item["id"] == "parser"
        )
        assert skill["id"] == "parser"
        assert skill["effective_name"] == "hacker-news-parser"
