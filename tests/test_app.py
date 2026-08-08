from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import subprocess
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient

import opencode_control.app as app_module
from opencode_control import __version__
from opencode_control.app import create_app
from opencode_control.command_catalog import (
    LEGACY_REVIEW_COMMAND_CONTENT,
    STARTER_COMMANDS,
    STARTER_COMMANDS_VERSION,
)
from opencode_control.config import ControlConfig
from opencode_control.config_lifecycle import PreflightResult
from opencode_control.opencode_client import OpenCodeError, OpenCodeHTTPError
from opencode_control.processes import ProcessError
from opencode_control.skill_import import DownloadedSkill, SkillFile, validate_skill_document
from opencode_control.store import ControlStore
from opencode_control.workspace import (
    WorkspaceError,
    read_jsonc_config,
    read_text,
    root_identity,
    write_text,
)


def _client(tmp_path: Path) -> TestClient:
    binary = tmp_path / "fake-opencode"
    if not binary.exists():
        binary.write_text(
            '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.18.5; else echo "{}"; fi\n'
        )
        os.chmod(binary, 0o700)
    return TestClient(
        create_app(
            ControlConfig(data_dir=tmp_path / "data", opencode_binary=str(binary))
        )
    )


def _csrf(client: TestClient) -> dict[str, str]:
    response = client.get("/api/v1/session")
    assert response.status_code == 200
    return {"X-CSRF-Token": response.json()["csrf_token"]}


def test_health_uses_package_version(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        response = client.get("/api/v1/health")

    assert response.status_code == 200
    assert response.json()["version"] == __version__


def test_favicon_is_served_as_svg(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        response = client.get("/favicon.svg")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/svg+xml")
    assert "#ff8a4c" in response.text


def _project(client: TestClient, root: Path, *, endpoint: str | None = None) -> dict[str, Any]:
    response = client.post(
        "/api/v1/projects",
        headers=_csrf(client),
        json={"name": "Test project", "root": str(root), "endpoint": endpoint},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _downloaded_skill(name: str = "https-import-test") -> DownloadedSkill:
    content = (
        f"---\nname: {name}\ndescription: Imported test skill\n---\n\n"
        "# Imported\n\nFollow the imported workflow.\n"
    )
    return DownloadedSkill(
        document=validate_skill_document(content),
        source_url="https://example.test/SKILL.md",
        final_url="https://cdn.example.test/SKILL.md",
        redirects=1,
    )


def test_control_branding_and_browser_session_cookie(tmp_path: Path) -> None:
    with _client(tmp_path) as client:
        assert client.get("/openapi.json").json()["info"]["title"] == "OpenCode Control"
        session = client.get("/api/v1/session")
        assert session.json()["product"] == "OpenCode Control"
        assert "control_session=" in session.headers["set-cookie"]


def test_upstream_not_found_stays_not_found(tmp_path: Path) -> None:
    app = create_app(ControlConfig(data_dir=tmp_path / "data"))
    handler = app.exception_handlers[OpenCodeError]

    response = asyncio.run(handler(None, OpenCodeHTTPError(404)))  # type: ignore[arg-type]

    assert response.status_code == 404
    assert json.loads(response.body)["detail"] == "OpenCode request failed with status 404"


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


def test_managed_server_start_and_stop_persist_restore_preference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FakeProcessManager:
        def __init__(self, *, binary: str, data_dir: Path) -> None:
            self.running: set[str] = set()

        def start(self, project_id: str, root: Any) -> dict[str, object]:
            self.running.add(project_id)
            return {
                "state": "running",
                "managed": True,
                "endpoint": "http://127.0.0.1:4096",
                "pid": 123,
            }

        def stop(self, project_id: str) -> dict[str, object]:
            self.running.discard(project_id)
            return {"state": "stopped", "managed": True, "endpoint": None}

        def status(self, project_id: str) -> dict[str, object]:
            return {
                "state": "running" if project_id in self.running else "stopped",
                "managed": project_id in self.running,
                "endpoint": "http://127.0.0.1:4096" if project_id in self.running else None,
            }

        def connection(self, project_id: str) -> None:
            return None

        def shutdown(self) -> None:
            self.running.clear()

    monkeypatch.setattr(app_module, "OpenCodeProcessManager", FakeProcessManager)
    root = tmp_path / "project"
    root.mkdir()
    app = create_app(ControlConfig(data_dir=tmp_path / "data"))

    with TestClient(app) as client:
        project_id = _project(client, root)["id"]
        started = client.post(
            f"/api/v1/projects/{project_id}/server/start", headers=_csrf(client)
        )
        assert started.status_code == 200
        assert app.state.control.store.get_project(project_id)["managed_enabled"] == 1

        stopped = client.post(
            f"/api/v1/projects/{project_id}/server/stop", headers=_csrf(client)
        )
        assert stopped.status_code == 200
        assert app.state.control.store.get_project(project_id)["managed_enabled"] == 0


def test_enabled_managed_server_is_restored_on_control_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    root = tmp_path / "project"
    root.mkdir()
    store = ControlStore(data_dir)
    project = store.create_project(name="Restored", root=root, endpoint=None)
    store.set_managed_enabled(str(project["id"]), True)
    store.close()
    restored = threading.Event()

    class FakeProcessManager:
        def __init__(self, *, binary: str, data_dir: Path) -> None:
            return

        def start(self, project_id: str, workspace: Any) -> dict[str, object]:
            assert project_id == project["id"]
            restored.set()
            return {"state": "running", "managed": True, "endpoint": "http://local"}

        def shutdown(self) -> None:
            return

    monkeypatch.setattr(app_module, "OpenCodeProcessManager", FakeProcessManager)

    with TestClient(create_app(ControlConfig(data_dir=data_dir))):
        assert restored.wait(timeout=1)


def test_store_backfills_legacy_task_session_links(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    data = tmp_path / "data"
    store = ControlStore(data)
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
    connection = sqlite3.connect(data / "control.sqlite")
    with connection:
        connection.execute("DELETE FROM task_sessions")
    connection.close()

    reopened = ControlStore(data)
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
        instruction_state = client.get(f"/api/v1/projects/{project_id}/instructions")
        assert instruction_state.status_code == 200
        assert instruction_state.json()["project_exists"] is True

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

        pencil_command = (
            "/Applications/Pen.app/Contents/Resources/app.asar.unpacked/out/"
            "mcp-server-darwin-arm64"
        )
        pencil = client.put(
            f"/api/v1/projects/{project_id}/mcp/pencil",
            headers=headers,
            json={
                "config": {
                    "name": "pencil",
                    "transport": "stdio",
                    "command": pencil_command,
                    "args": ["--app", "desktop"],
                    "env": {},
                }
            },
        )
        assert pencil.status_code == 200
        assert pencil.json()["config"] == {
            "type": "local",
            "command": [
                pencil_command,
                "--app",
                "desktop",
            ],
            "enabled": True,
        }
        before_invalid = (root / "opencode.json").read_text()
        invalid_mcp = client.put(
            f"/api/v1/projects/{project_id}/mcp/broken",
            headers=headers,
            json={
                "config": {
                    "transport": "websocket",
                    "command": "broken",
                    "args": [],
                }
            },
        )
        assert invalid_mcp.status_code == 422
        assert (root / "opencode.json").read_text() == before_invalid

        mcp = client.put(
            f"/api/v1/projects/{project_id}/mcp/github",
            headers=headers,
            json={
                "config": {
                    "type": "remote",
                    "url": "https://example.test/mcp",
                    "headers": {"Authorization": "secret-value"},
                }
            },
        )
        assert mcp.status_code == 200
        assert mcp.json()["config"]["headers"]["Authorization"] == "[REDACTED]"
        assert "secret-value" not in mcp.text
        persisted = json.loads((root / "opencode.json").read_text())
        assert persisted["mcp"]["github"]["headers"]["Authorization"] == "secret-value"

        config_payload = client.get(f"/api/v1/projects/{project_id}/configuration").json()
        config = config_payload["project"]
        assert config_payload["project_path"] == str(root / "opencode.json")
        assert config["mcp"]["github"]["headers"]["Authorization"] == "[REDACTED]"
        assert "secret-value" not in json.dumps(config_payload)

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


def test_https_skill_import_previews_then_saves_exact_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    downloaded = _downloaded_skill()
    calls: list[str] = []

    def fetch(url: str) -> DownloadedSkill:
        calls.append(url)
        return downloaded

    monkeypatch.setattr(app_module, "fetch_skill", fetch)
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)
        preview = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/preview",
            headers=headers,
            json={"url": "https://example.test/SKILL.md", "scope": "project"},
        )

        assert preview.status_code == 200, preview.text
        payload = preview.json()
        assert payload["name"] == "https-import-test"
        assert payload["description"] == "Imported test skill"
        assert payload["conflict"]["has_conflict"] is False
        assert payload["content"] == downloaded.document.content
        assert not (root / ".opencode/skills/https-import-test/SKILL.md").exists()

        confirmed = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/confirm",
            headers=headers,
            json={"preview_id": payload["preview_id"], "conflict_policy": "skip"},
        )
        repeated = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/confirm",
            headers=headers,
            json={"preview_id": payload["preview_id"], "conflict_policy": "skip"},
        )

        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["state"] == "imported"
        assert repeated.json() == confirmed.json()
        assert calls == ["https://example.test/SKILL.md"]
        assert (
            root / ".opencode/skills/https-import-test/SKILL.md"
        ).read_text() == downloaded.document.content


def test_https_skill_import_supports_skip_overwrite_and_previewed_rename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    target = root / ".opencode/skills/https-import-test/SKILL.md"
    target.parent.mkdir(parents=True)
    target.write_text("existing\n")
    monkeypatch.setattr(app_module, "fetch_skill", lambda url: _downloaded_skill())
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)

        def preview() -> dict[str, Any]:
            response = client.post(
                f"/api/v1/projects/{project_id}/skill-imports/preview",
                headers=headers,
                json={"url": "https://example.test/SKILL.md", "scope": "project"},
            )
            assert response.status_code == 200, response.text
            return cast(dict[str, Any], response.json())

        skipped_preview = preview()
        assert skipped_preview["conflict"]["has_conflict"] is True
        skipped = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/confirm",
            headers=headers,
            json={"preview_id": skipped_preview["preview_id"], "conflict_policy": "skip"},
        )
        assert skipped.json()["state"] == "skipped"
        assert target.read_text() == "existing\n"

        overwrite_preview = preview()
        overwritten = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/confirm",
            headers=headers,
            json={
                "preview_id": overwrite_preview["preview_id"],
                "conflict_policy": "overwrite",
            },
        )
        assert overwritten.json()["state"] == "imported"
        assert target.read_text() == _downloaded_skill().document.content

        rename_preview = preview()
        renamed = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/{rename_preview['preview_id']}/rename",
            headers=headers,
            json={"name": "https-import-renamed"},
        )
        assert renamed.status_code == 200, renamed.text
        renamed_payload = renamed.json()
        assert renamed_payload["name"] == "https-import-renamed"
        assert "name: https-import-renamed" in renamed_payload["content"]
        assert renamed_payload["conflict"]["has_conflict"] is False
        confirmed = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/confirm",
            headers=headers,
            json={"preview_id": renamed_payload["preview_id"], "conflict_policy": "skip"},
        )
        assert confirmed.json()["state"] == "imported"
        assert (root / ".opencode/skills/https-import-renamed/SKILL.md").is_file()


def test_https_skill_import_does_not_overwrite_a_target_changed_after_preview(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    monkeypatch.setattr(app_module, "fetch_skill", lambda url: _downloaded_skill())
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)
        preview = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/preview",
            headers=headers,
            json={"url": "https://example.test/SKILL.md", "scope": "project"},
        ).json()
        target = root / ".opencode/skills/https-import-test/SKILL.md"
        target.parent.mkdir(parents=True)
        target.write_text("changed outside Control\n")

        confirmed = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/confirm",
            headers=headers,
            json={"preview_id": preview["preview_id"], "conflict_policy": "overwrite"},
        )

        assert confirmed.status_code == 409
        assert target.read_text() == "changed outside Control\n"


def test_https_skill_import_can_save_to_global_scope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setattr(app_module, "fetch_skill", lambda url: _downloaded_skill())
    root = tmp_path / "project"
    root.mkdir()
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)
        preview = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/preview",
            headers=headers,
            json={"url": "https://example.test/SKILL.md", "scope": "global"},
        )
        assert preview.status_code == 200, preview.text
        confirmed = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/confirm",
            headers=headers,
            json={"preview_id": preview.json()["preview_id"], "conflict_policy": "skip"},
        )

        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["scope"] == "global"
        assert (
            home / ".config/opencode/skills/https-import-test/SKILL.md"
        ).read_text() == _downloaded_skill().document.content


def test_https_skill_bundle_import_saves_all_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    base = _downloaded_skill("bundle-test")
    downloaded = DownloadedSkill(
        document=base.document,
        source_url="https://github.com/example/repo/tree/main/skill",
        final_url="https://github.com/example/repo/tree/" + "a" * 40 + "/skill",
        redirects=0,
        files=(
            SkillFile("SKILL.md", base.document.content.encode(), 0o644, base.document.sha256),
            SkillFile("scripts/run.py", b"print('bundle')\n", 0o755, "b" * 64),
            SkillFile("references/guide.md", b"# Guide\n", 0o644, "c" * 64),
        ),
        commit="a" * 40,
    )
    monkeypatch.setattr(app_module, "fetch_skill", lambda url: downloaded)
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)
        preview = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/preview",
            headers=headers,
            json={"url": downloaded.source_url, "scope": "project"},
        )
        assert preview.status_code == 200, preview.text
        assert preview.json()["file_count"] == 3
        assert preview.json()["commit"] == "a" * 40
        confirmed = client.post(
            f"/api/v1/projects/{project_id}/skill-imports/confirm",
            headers=headers,
            json={"preview_id": preview.json()["preview_id"], "conflict_policy": "skip"},
        )

        assert confirmed.status_code == 200, confirmed.text
        assert confirmed.json()["file_count"] == 3
        assert (
            root / ".opencode/skills/bundle-test/scripts/run.py"
        ).read_text() == "print('bundle')\n"
        assert (root / ".opencode/skills/bundle-test/references/guide.md").is_file()


def test_native_skill_can_be_renamed_and_moved_with_sidecar_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    (home / ".config/opencode").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    root = tmp_path / "project"
    source = root / ".opencode/skills/original"
    (source / "scripts").mkdir(parents=True)
    (source / "SKILL.md").write_text(
        "---\nname: original\ndescription: Original skill\n---\n\n# Original\n"
    )
    (source / "scripts/run.py").write_text("print('preserved')\n")
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        updated_content = (
            "---\nname: renamed-skill\ndescription: Original skill\n---\n\n# Original\n"
        )
        updated = client.patch(
            f"/api/v1/projects/{project_id}/skills/original",
            headers=_csrf(client),
            json={
                "name": "renamed-skill",
                "content": updated_content,
                "source_scope": "project",
                "target_scope": "global",
            },
        )

        assert updated.status_code == 200, updated.text
        target = home / ".config/opencode/skills/renamed-skill"
        assert not source.exists()
        assert (target / "SKILL.md").read_text() == updated_content
        assert (target / "scripts/run.py").read_text() == "print('preserved')\n"


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
        assert "project-secret" not in loaded.text
        assert "global-secret" not in loaded.text

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
        assert read_jsonc_config(root_identity(root), Path("opencode.jsonc")) == {
            "model": "openai/new-project",
            "apiKey": "project-secret",
        }
        assert "// project override" in project_path.read_text()

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
        assert read_jsonc_config(root_identity(global_root), Path("opencode.jsonc")) == {
            "model": "openai/new-global",
            "apiKey": "global-secret",
        }
        assert "// shared provider" in global_path.read_text()


def test_secret_manager_writes_private_files_without_returning_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))

    with _client(tmp_path) as client:
        headers = _csrf(client)
        assert client.get("/api/v1/secrets").json() == []

        rejected = client.put(
            "/api/v1/secrets/context7_api_key",
            json={"value": "ctx7-secret"},
        )
        assert rejected.status_code == 403

        saved = client.put(
            "/api/v1/secrets/context7_api_key",
            headers=headers,
            json={"value": "ctx7-secret"},
        )
        assert saved.status_code == 200
        assert saved.json() == {
            "name": "context7_api_key",
            "path": str(home / ".config/opencode/secrets/context7_api_key"),
            "reference": "{file:~/.config/opencode/secrets/context7_api_key}",
        }
        assert "ctx7-secret" not in saved.text

        secret_path = home / ".config/opencode/secrets/context7_api_key"
        assert secret_path.read_text() == "ctx7-secret"
        assert secret_path.stat().st_mode & 0o777 == 0o600
        assert secret_path.parent.stat().st_mode & 0o777 == 0o700

        listed = client.get("/api/v1/secrets")
        assert listed.status_code == 200
        assert listed.json() == [saved.json()]
        assert "ctx7-secret" not in listed.text

        replaced = client.put(
            "/api/v1/secrets/context7_api_key",
            headers=headers,
            json={"value": "new-secret"},
        )
        assert replaced.status_code == 200
        assert secret_path.read_text() == "new-secret"
        assert "new-secret" not in replaced.text

        unsafe = client.put(
            "/api/v1/secrets/..%2Fescape",
            headers=headers,
            json={"value": "unsafe"},
        )
        assert unsafe.status_code in {400, 404, 405}
        assert not (home / ".config/opencode/escape").exists()

        outside = tmp_path / "outside-secret"
        outside.write_text("outside")
        linked = secret_path.parent / "linked_secret"
        linked.symlink_to(outside)
        assert all(item["name"] != "linked_secret" for item in client.get("/api/v1/secrets").json())
        rejected_link = client.put(
            "/api/v1/secrets/linked_secret",
            headers=headers,
            json={"value": "replacement"},
        )
        assert rejected_link.status_code == 400
        assert outside.read_text() == "outside"

        removed = client.delete("/api/v1/secrets/context7_api_key", headers=headers)
        assert removed.status_code == 204
        assert not secret_path.exists()


def test_configuration_references_stay_visible_while_literal_secrets_are_redacted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    (home / ".config/opencode").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    root = tmp_path / "project"
    root.mkdir()
    (root / "opencode.json").write_text(
        json.dumps(
            {
                "provider": {
                    "safe-file": {
                        "options": {
                            "apiKey": "{file:~/.config/opencode/secrets/provider_key}"
                        }
                    },
                    "safe-env": {"options": {"apiKey": "{env:PROVIDER_API_KEY}"}},
                    "literal": {"options": {"apiKey": "literal-provider-secret"}},
                }
            }
        )
    )

    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        response = client.get(f"/api/v1/projects/{project_id}/configuration")
        assert response.status_code == 200
        providers = response.json()["project"]["provider"]
        assert providers["safe-file"]["options"]["apiKey"] == (
            "{file:~/.config/opencode/secrets/provider_key}"
        )
        assert providers["safe-env"]["options"]["apiKey"] == "{env:PROVIDER_API_KEY}"
        assert providers["literal"]["options"]["apiKey"] == "[REDACTED]"
        assert "literal-provider-secret" not in response.text


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
        persisted_global = read_jsonc_config(
            root_identity(global_root), Path("opencode.jsonc")
        )
        assert "// Global server inherited by projects." in global_path.read_text()
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
        assert project_override.json()["inherited"] is False
        persisted_project = json.loads((root / "opencode.json").read_text())
        assert persisted_project["mcp"]["docs"] == {"enabled": False}

        restored_inheritance = client.patch(
            f"/api/v1/projects/{project_id}/mcp/docs/enabled",
            headers=headers,
            json={"scope": "project", "enabled": True},
        )
        assert restored_inheritance.status_code == 200
        assert restored_inheritance.json()["inherited"] is True
        persisted_project = json.loads((root / "opencode.json").read_text())
        assert "docs" not in persisted_project["mcp"]


def test_mcp_updates_preserve_jsonc_comments_formatting_and_crlf(
    tmp_path: Path,
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    config = root / "opencode.jsonc"
    config.write_bytes(
        b'{\r\n  // Keep project model\r\n  "model": "openai/gpt",\r\n}\r\n'
    )

    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        headers = _csrf(client)
        saved = client.put(
            f"/api/v1/projects/{project_id}/mcp/docs",
            headers=headers,
            json={
                "scope": "project",
                "config": {
                    "type": "remote",
                    "url": "https://example.test/mcp",
                    "enabled": True,
                },
            },
        )
        assert saved.status_code == 200, saved.text
        after_save = config.read_bytes()
        assert b"// Keep project model" in after_save
        assert b"\r\n" in after_save
        assert b'  "mcp": {\r\n    "docs": {' in after_save
        assert read_jsonc_config(root_identity(root), Path("opencode.jsonc"))["mcp"][
            "docs"
        ]["enabled"] is True

        removed = client.delete(
            f"/api/v1/projects/{project_id}/mcp/docs?scope=project",
            headers=headers,
        )
        assert removed.status_code == 200, removed.text
        after_remove = config.read_bytes()
        assert b"// Keep project model" in after_remove
        assert b"\r\n" in after_remove
        assert "mcp" not in read_jsonc_config(
            root_identity(root), Path("opencode.jsonc")
        )


def test_global_config_failure_rolls_back_and_leaves_unreached_project_running(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    global_dir = home / ".config/opencode"
    global_dir.mkdir(parents=True)
    global_config = global_dir / "opencode.json"
    global_config.write_text('{"before":true}\n')
    monkeypatch.setenv("HOME", str(home))
    roots = [tmp_path / name for name in ("one", "two", "three")]
    for root in roots:
        root.mkdir()

    with _client(tmp_path) as client:
        projects = [_project(client, root) for root in roots]
        state = client.app.state.control
        stopped: list[str] = []
        started: list[str] = []
        failed = False

        monkeypatch.setattr(
            state.processes,
            "status",
            lambda project_id: {
                "state": "running",
                "managed": True,
                "endpoint": "http://127.0.0.1:1",
            },
        )
        monkeypatch.setattr(
            state.processes,
            "stop",
            lambda project_id: stopped.append(project_id)
            or {"state": "stopped", "managed": True, "endpoint": None},
        )

        def start(project_id: str, root: Any) -> dict[str, object]:
            nonlocal failed
            started.append(project_id)
            candidate = json.loads(global_config.read_text()).get("candidate") is True
            if project_id == projects[1]["id"] and candidate and not failed:
                failed = True
                raise ProcessError("candidate startup failed")
            return {"state": "running", "managed": True, "endpoint": "test"}

        monkeypatch.setattr(state.processes, "start", start)
        response = client.patch(
            f"/api/v1/projects/{projects[0]['id']}/configuration",
            headers=_csrf(client),
            json={"scope": "global", "values": {"candidate": True}},
        )

        assert response.status_code == 409
        assert response.json()["state"] == "rolled_back"
        assert global_config.read_text() == '{"before":true}\n'
        assert projects[2]["id"] not in stopped
        assert started == [
            projects[0]["id"],
            projects[1]["id"],
            projects[0]["id"],
            projects[1]["id"],
        ]


def test_preflight_rejection_does_not_write_or_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    target = root / "opencode.json"
    target.write_text('{"before":true}\n')
    with _client(tmp_path) as client:
        project = _project(client, root)
        state = client.app.state.control
        monkeypatch.setattr(
            state.config_preflight,
            "validate",
            lambda **kwargs: PreflightResult(False, "1.18.5", "schema rejected"),
        )
        stopped: list[str] = []
        monkeypatch.setattr(state.processes, "stop", lambda project_id: stopped.append(project_id))

        response = client.patch(
            f"/api/v1/projects/{project['id']}/configuration",
            headers=_csrf(client),
            json={"scope": "project", "values": {"after": True}},
        )

        assert response.status_code == 422
        assert response.json()["state"] == "rejected"
        assert target.read_text() == '{"before":true}\n'
        assert stopped == []


def test_incompatible_opencode_blocks_config_mutation(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    target = root / "opencode.json"
    target.write_text('{"before":true}\n')
    with _client(tmp_path) as client:
        project = _project(client, root)
        state = client.app.state.control
        state.config_preflight._version = "1.17.9"

        response = client.patch(
            f"/api/v1/projects/{project['id']}/configuration",
            headers=_csrf(client),
            json={"scope": "project", "values": {"after": True}},
        )

        assert response.status_code == 422
        assert response.json()["compatibility"]["state"] == "incompatible"
        assert target.read_text() == '{"before":true}\n'


def test_manual_config_editor_replaces_the_target_file(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    target = root / "opencode.jsonc"
    target.write_text('{"keep":"old","remove":true}\n')
    with _client(tmp_path) as client:
        project = _project(client, root)
        response = client.patch(
            f"/api/v1/projects/{project['id']}/configuration",
            headers=_csrf(client),
            json={"scope": "project", "values": {"keep": "new"}},
        )

        assert response.status_code == 200
        assert response.json()["operation"]["state"] == "committed"
        assert json.loads(target.read_text()) == {"keep": "new"}


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
        assert "lowercase Latin letter (a-z)" in invalid.json()["detail"]
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
    created_sessions = iter(("ses_task", "ses_extra", "ses_extra_2", "ses_command"))
    runtime_statuses: dict[str, dict[str, str]] = {}

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
                "statuses": runtime_statuses,
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
            variant: str | None = None,
            attachments: list[dict[str, str]] | None = None,
            mentions: list[str] | None = None,
        ) -> None:
            calls.append(("prompt", (session_id, prompt, agent, model, attachments)))
            if mentions:
                calls.append(("mentions", mentions))

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
            calls.append(
                ("command", (session_id, command, arguments, agent, model, variant))
            )

        def session_todos(self, session_id: str) -> list[dict[str, str]]:
            return [{"content": "Run tests", "status": "in_progress", "priority": "high"}]

        def session_permissions(self, session_id: str) -> list[dict[str, Any]]:
            return [{"id": "per_1", "permission": "bash", "patterns": ["pytest"]}]

        def session_messages(self, session_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "info": {"id": "msg_user", "role": "user"},
                    "parts": [{"type": "text", "text": "Run the task"}],
                }
            ]

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
                "prompt": "@general Find authorization gaps and add tests.",
                "agent": "reviewer",
                "model": "openai/gpt-test",
                "mentions": ["general"],
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
        assert response.json()["mentions"] == ["general"]
        assert ("session", "Review auth") in calls
        assert (
            "prompt",
            (
                "ses_task",
                "Ожидаемый результат: Review auth\n\n"
                "Подробное задание:\n@general Find authorization gaps and add tests.",
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
        assert ("mentions", ["general"]) in calls

        runtime_statuses["ses_task"] = {
            "type": "failed",
            "error": "token limit exhausted",
        }
        failed = client.get(f"/api/v1/projects/{project_id}/tasks").json()[0]
        assert failed["status"] == "failed"
        assert failed["error"] == "token limit exhausted"
        messages = client.get(
            f"/api/v1/projects/{project_id}/sessions/ses_task/messages"
        ).json()
        assert messages[-1] == {
            "info": {
                "id": f"control-error-{response.json()['id']}",
                "role": "assistant",
                "error": "token limit exhausted",
            },
            "parts": [],
        }
        runtime_statuses.clear()

        client.app.state.control.store.update_task(
            project_id, response.json()["id"], status="completed"
        )
        rerun = client.post(
            f"/api/v1/projects/{project_id}/tasks/{response.json()['id']}/rerun",
            headers=_csrf(client),
            json={},
        )
        assert rerun.status_code == 202
        assert rerun.json()["session_id"] == "ses_task"
        rerun_prompt = [call for call in calls if call[0] == "prompt"][-1]
        assert rerun_prompt[1][0] == "ses_task"
        assert "Продолжи задачу в этой же сессии" in rerun_prompt[1][1]
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
        resumed = client.app.state.control.store.get_task(project_id, response.json()["id"])
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
        assert client.app.state.control.store.get_task(project_id, response.json()["id"])[
            "status"
        ] == "aborted"

        client.app.state.control.store.update_task(
            project_id, response.json()["id"], status="completed"
        )
        rerun_updated = client.post(
            f"/api/v1/projects/{project_id}/tasks/{response.json()['id']}/rerun",
            headers=_csrf(client),
            json={},
        )
        assert rerun_updated.status_code == 202
        updated_prompt = [call for call in calls if call[0] == "prompt"][-1]
        assert "Актуальное задание:\n@explore Run the tests again" in updated_prompt[1][1]
        assert calls[-1] == ("mentions", ["explore"])

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
        after_file = client.app.state.control.store.get_task(project_id, response.json()["id"])
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
        assert sessions["ses_task"]["control_task"]["title"] == "Review auth"
        assert sessions["ses_task"]["control_task"]["status"] == "running"
        assert sessions["ses_extra"]["control_task"]["title"] == "Review auth"
        assert sessions["ses_child"]["control_task"]["title"] == "Review auth"
        assert "control_task" not in sessions["ses_cli"]

        control = client.app.state.control
        control.dashboard_cache[(project_id, "7d", "UTC")] = (
            datetime.now(UTC),
            {"stale": True},
        )
        control.dashboard_cache[("*", "7d", "UTC")] = (
            datetime.now(UTC),
            {"stale": True},
        )
        removed_session = client.delete(
            f"/api/v1/projects/{project_id}/sessions/ses_extra",
            headers=_csrf(client),
        )
        assert removed_session.status_code == 204
        assert control.dashboard_cache == {}
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

        command_task = client.post(
            f"/api/v1/projects/{project_id}/tasks",
            headers=_csrf(client),
            json={
                "title": "Fix auth",
                "prompt": "/fix authorization",
                "agent": "build",
                "model": "opencode/deepseek-v4-flash-free",
                "variant": "max",
            },
        )
        assert command_task.status_code == 202
        for _ in range(100):
            if (
                "command",
                (
                    "ses_command",
                    "fix",
                    "authorization",
                    "build",
                    "opencode/deepseek-v4-flash-free",
                    "max",
                ),
            ) in calls:
                break
            time.sleep(0.01)
        assert (
            "command",
            (
                "ses_command",
                "fix",
                "authorization",
                "build",
                "opencode/deepseek-v4-flash-free",
                "max",
            ),
        ) in calls


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
        manager = client.app.state.control.processes
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

        def ensure_session_directory(
            self, session_id: str, *, missing_ok: bool = False
        ) -> bool:
            return True

        def prompt_async(self, session_id: str, prompt: str, **kwargs: Any) -> None:
            return

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
                "prompt": "@general Prepare a revised report",
                "mentions": ["general"],
            },
        )
        assert scheduled_again.status_code == 200
        assert scheduled_again.json()["cron"] == "30 8 * * *"
        assert scheduled_again.json()["timezone"] == "Europe/Paris"
        assert scheduled_again.json()["cron_session_mode"] == "reuse"
        assert scheduled_again.json()["prompt"] == "@general Prepare a revised report"
        assert scheduled_again.json()["mentions"] == ["general"]
        assert scheduled_again.json()["status"] == "scheduled"
        assert scheduled_again.json()["next_run_at"]

        client.app.state.control.store.add_task_session(
            project_id, task["id"], "ses_scheduled"
        )
        follow_up = client.post(
            f"/api/v1/projects/{project_id}/sessions/ses_scheduled/prompt",
            headers=headers,
            json={
                "prompt": "Only inspect this completed run",
                "agent": "plan",
                "model": "openai/gpt-next",
                "variant": "max",
            },
        )
        assert follow_up.status_code == 202
        persisted = client.app.state.control.store.get_task(project_id, task["id"])
        assert persisted is not None
        assert persisted["prompt"] == "@general Prepare a revised report"
        assert persisted["mentions"] == ["general"]
        assert persisted["agent"] is None
        assert persisted["model"] is None
        assert persisted["variant"] is None

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


def test_dashboard_aggregates_message_usage_for_project_and_global_scope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    roots = [tmp_path / "one", tmp_path / "two"]
    for root in roots:
        root.mkdir()
    now_ms = datetime.now(UTC).timestamp() * 1000

    class FakeOpenCodeClient:
        def __init__(self, endpoint: str, directory: str, **kwargs: Any) -> None:
            self.directory = directory

        def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
            return {"worktree": self.directory}

        def snapshot(self) -> dict[str, Any]:
            return {
                "state": "connected",
                "errors": [],
                "sessions": [
                    {
                        "id": "ses_shared",
                        "title": f"Session {Path(self.directory).name}",
                        "agent": "build",
                        "model": {"providerID": "openai", "modelID": "gpt-test"},
                        "time": {"created": now_ms - 1000, "updated": now_ms},
                    },
                    {
                        "id": "ses_child",
                        "parentID": "ses_shared",
                        "title": "Explore child",
                        "agent": "explore",
                        "model": {"providerID": "openai", "modelID": "gpt-test"},
                        "time": {"created": now_ms - 900, "updated": now_ms},
                    },
                ],
                "statuses": {
                    "ses_shared": {"type": "idle"},
                    "ses_child": {"type": "idle"},
                },
                "mcp": {"context7": {"status": "connected"}},
            }

        def session_messages(self, session_id: str) -> list[dict[str, Any]]:
            return [
                {
                    "info": {
                        "id": f"msg_{session_id}",
                        "role": "assistant",
                        "agent": "build",
                        "providerID": "openai",
                        "modelID": "gpt-test",
                        "cost": 0.5,
                        "tokens": {
                            "input": 10,
                            "output": 4,
                            "reasoning": 2,
                            "cache": {"read": 3, "write": 1},
                        },
                        "time": {"created": now_ms - 500, "completed": now_ms},
                    },
                    "parts": [],
                },
                {
                    "info": {
                        "id": "msg_old",
                        "role": "assistant",
                        "cost": 9,
                        "tokens": {"input": 1000},
                        "time": {"completed": now_ms - 40 * 24 * 60 * 60 * 1000},
                    },
                    "parts": [],
                },
            ]

    monkeypatch.setattr(app_module, "OpenCodeClient", FakeOpenCodeClient)
    with _client(tmp_path) as client:
        first = _project(client, roots[0], endpoint="http://127.0.0.1:4096")
        _project(client, roots[1], endpoint="http://127.0.0.1:4097")
        project_usage = client.get(
            "/api/v1/dashboard",
            params={
                "scope": "project",
                "project_id": first["id"],
                "period": "7d",
                "timezone": "UTC",
            },
        )
        global_usage = client.get(
            "/api/v1/dashboard",
            params={"scope": "global", "period": "7d", "timezone": "UTC"},
        )

        assert project_usage.status_code == 200, project_usage.text
        assert project_usage.json()["totals"] == {
            "id": "total",
            "tokens": {
                "input": 20,
                "output": 8,
                "reasoning": 4,
                "cache_read": 6,
                "cache_write": 2,
            },
            "tokens_total": 32,
            "cost": 1.0,
            "messages": 2,
            "sessions": 1,
            "active": 0,
            "mcp_connected": 1,
            "mcp_total": 1,
        }
        assert global_usage.status_code == 200, global_usage.text
        assert global_usage.json()["totals"]["tokens_total"] == 64
        assert global_usage.json()["totals"]["cost"] == 2.0
        assert global_usage.json()["totals"]["sessions"] == 2
        assert len(global_usage.json()["projects"]) == 2
        assert global_usage.json()["models"][0]["id"] == "openai/gpt-test"
        assert global_usage.json()["models"][0]["sessions"] == 2
        assert client.get(
            "/api/v1/dashboard",
            params={"scope": "global", "timezone": "Mars/Olympus"},
        ).status_code == 422


def test_search_indexes_changed_sessions_across_projects(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    roots = [tmp_path / "one", tmp_path / "two"]
    for root in roots:
        root.mkdir()
    message_calls: list[tuple[str, str]] = []

    class FakeOpenCodeClient:
        def __init__(self, endpoint: str, directory: str, **kwargs: Any) -> None:
            self.directory = directory

        def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
            return {"worktree": self.directory}

        def sessions(self) -> list[dict[str, Any]]:
            name = Path(self.directory).name
            return [
                {
                    "id": f"ses_{name}",
                    "title": f"Deploy {name}",
                    "time": {"updated": 1000},
                }
            ]

        def session_messages(self, session_id: str) -> list[dict[str, Any]]:
            message_calls.append((self.directory, session_id))
            return [
                {
                    "info": {
                        "id": f"msg_{session_id}",
                        "role": "user",
                        "time": {"created": 1100},
                    },
                    "parts": [
                        {"type": "text", "text": f"Rotate deployment token for {session_id}"},
                        {
                            "type": "tool",
                            "state": {"output": "private tool output"},
                        },
                    ],
                }
            ]

    monkeypatch.setattr(app_module, "OpenCodeClient", FakeOpenCodeClient)
    with _client(tmp_path) as client:
        first = _project(client, roots[0], endpoint="http://127.0.0.1:4096")
        _project(client, roots[1], endpoint="http://127.0.0.1:4097")

        response = client.get("/api/v1/search", params={"q": "deployment", "scope": "global"})
        first_page = client.get(
            "/api/v1/search", params={"q": "deployment", "scope": "global", "limit": 1}
        )
        second_page = client.get(
            "/api/v1/search",
            params={"q": "deployment", "scope": "global", "limit": 1, "offset": 1},
        )
        repeated = client.get("/api/v1/search", params={"q": "deployment", "scope": "global"})
        project_title = client.get(
            "/api/v1/search",
            params={"q": "Deploy one", "scope": "project", "project_id": first["id"]},
        )
        private_output = client.get(
            "/api/v1/search", params={"q": "private tool", "scope": "global"}
        )

    assert response.status_code == 200, response.text
    assert response.json()["partial"] is False
    assert response.json()["indexed_sessions"] == 2
    assert len(response.json()["results"]) == 2
    assert {item["kind"] for item in response.json()["results"]} == {"message"}
    assert all("deployment" in item["snippet"].lower() for item in response.json()["results"])
    assert repeated.json()["indexed_sessions"] == 0
    assert first_page.json()["has_more"] is True
    assert first_page.json()["offset"] == 0
    assert second_page.json()["offset"] == 1
    assert (
        first_page.json()["results"][0]["message_id"]
        != second_page.json()["results"][0]["message_id"]
    )
    assert len(message_calls) == 2
    assert [item["kind"] for item in project_title.json()["results"]] == ["session"]
    assert private_output.json()["results"] == []


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
    store = client.app.state.control.store
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
        time.sleep(0.05)
        updated = store.get_task(str(project["id"]), str(task["id"]))
        runs = client.get(
            f"/api/v1/projects/{project['id']}/tasks/{task['id']}/runs"
        ).json()

    assert updated is not None
    assert updated["session_id"] == "ses_fresh"
    assert updated["session_ids"] == ["ses_old", "ses_fresh"]
    assert calls[0] == ("session", "Fresh report")
    assert calls[1][0] == "prompt"
    assert calls[1][1][0] == "ses_fresh"
    assert "Продолжи задачу в этой же сессии" not in calls[1][1][1]
    assert "opencode-control-run:" in calls[1][1][1]
    assert runs[0]["status"] == "running"
    assert runs[0]["attempt_count"] == 1
    assert runs[0]["scheduled_for"] == "2020-01-01T00:00:00+00:00"
    assert updated["last_scheduled_run"]["id"] == runs[0]["id"]


def test_manual_rerun_of_scheduled_slash_task_uses_fresh_session_and_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    commanded = threading.Event()
    calls: list[tuple[str, str | None, str | None, str | None]] = []

    class FakeOpenCodeClient:
        def __init__(self, endpoint: str, directory: str, **kwargs: Any) -> None:
            return

        def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
            return {"worktree": str(root)}

        def create_session(self, title: str | None = None) -> dict[str, Any]:
            return {"id": "ses_manual_fresh", "title": title}

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
            calls.append((session_id, agent, model, variant))
            commanded.set()

    monkeypatch.setattr(app_module, "OpenCodeClient", FakeOpenCodeClient)
    client = _client(tmp_path)
    store = client.app.state.control.store
    project = store.create_project(
        name="Scheduled project",
        root=root,
        endpoint="http://127.0.0.1:4096",
    )
    task = store.create_task(
        str(project["id"]),
        title="Daily summary",
        prompt="/hacker-news-summary",
        agent="build",
        model="opencode/deepseek-v4-flash-free",
        variant="max",
        cron="20 11 * * *",
        timezone="Europe/Moscow",
        next_run_at="2099-01-01T08:20:00+00:00",
    )

    with client:
        rerun = client.post(
            f"/api/v1/projects/{project['id']}/tasks/{task['id']}/rerun",
            headers=_csrf(client),
            json={},
        )
        assert commanded.wait(timeout=1)

    assert rerun.status_code == 202, rerun.text
    assert rerun.json()["session_id"] == "ses_manual_fresh"
    assert rerun.json()["session_ids"] == ["ses_manual_fresh"]
    assert calls == [
        (
            "ses_manual_fresh",
            "build",
            "opencode/deepseek-v4-flash-free",
            "max",
        )
    ]


def test_git_status_diff_and_commit_are_scoped_to_project(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()

    def git(*arguments: str) -> None:
        subprocess.run(["git", "-C", str(root), *arguments], check=True, capture_output=True)

    git("init", "-q")
    git("config", "user.name", "Control Test")
    git("config", "user.email", "control@example.test")

    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        tracked = root / "tracked.txt"
        tracked.write_text("before\n")
        git("add", ".")
        git("commit", "-q", "-m", "Initial")
        tracked.write_text("after\n")
        (root / "new.txt").write_text("new\n")
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
        assert reset.json()["backup_branch"].startswith("control-backup/")
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
        manager = client.app.state.control.processes
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


def test_default_commands_and_project_crud(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    skill = root / ".opencode/skills/native-tool/SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: native-tool\ndescription: Native tool skill\n---\n")

    class FakeOpenCodeClient:
        def __init__(self, endpoint: str, directory: str, **kwargs: Any) -> None:
            return

        def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
            return {"worktree": str(root)}

        def commands(self) -> list[dict[str, Any]]:
            return [
                {"id": "native-tool", "description": "Native tool", "content": "Tool"}
            ]

    monkeypatch.setattr(app_module, "OpenCodeClient", FakeOpenCodeClient)
    with _client(tmp_path) as client:
        project_id = _project(client, root, endpoint="http://127.0.0.1:4096")["id"]
        headers = _csrf(client)
        custom_review = root / ".opencode/commands/review.md"
        custom_review.parent.mkdir(parents=True, exist_ok=True)
        custom_review.write_text("---\ndescription: Custom review\n---\n\nKeep me\n")

        for command_id, definition in STARTER_COMMANDS.items():
            assert (root / f".opencode/commands/{command_id}.md").read_text() == definition[
                "content"
            ]
        assert (
            client.app.state.control.store.get_project(project_id)[
                "starter_commands_version"
            ]
            == STARTER_COMMANDS_VERSION
        )
        assert custom_review.read_text().endswith("Keep me\n")

        saved = client.put(
            f"/api/v1/projects/{project_id}/commands/audit",
            headers=headers,
            json={
                "scope": "project",
                "content": (
                    "---\ndescription: Audit code\nagent: plan\nsubtask: false\n"
                    "---\n\nAudit $ARGUMENTS\n"
                ),
            },
        )
        commands = client.get(f"/api/v1/projects/{project_id}/commands")

        assert saved.status_code == 200
        audit = next(item for item in commands.json() if item["id"] == "audit")
        assert audit["agent"] == "plan"
        assert audit["has_arguments"] is True
        assert audit["editable"] is True
        native_tool = next(item for item in commands.json() if item["id"] == "native-tool")
        assert native_tool["editable"] is False
        assert native_tool["content"] == ""
        assert native_tool["kind"] == "skill"

        removed = client.delete(
            f"/api/v1/projects/{project_id}/commands/audit?scope=project", headers=headers
        )
        assert removed.status_code == 204
        assert not (root / ".opencode/commands/audit.md").exists()


def test_deleted_default_command_is_not_recreated(tmp_path: Path) -> None:
    root = tmp_path / "project"
    root.mkdir()
    with _client(tmp_path) as client:
        project_id = _project(client, root)["id"]
        removed = client.delete(
            f"/api/v1/projects/{project_id}/commands/fix?scope=project",
            headers=_csrf(client),
        )
        assert removed.status_code == 204
        assert not (root / ".opencode/commands/fix.md").exists()

    with _client(tmp_path):
        assert not (root / ".opencode/commands/fix.md").exists()


def test_legacy_review_migration_preserves_edited_files(tmp_path: Path) -> None:
    exact_root = tmp_path / "exact"
    edited_root = tmp_path / "edited"
    exact_root.mkdir()
    edited_root.mkdir()
    for root, content in (
        (exact_root, LEGACY_REVIEW_COMMAND_CONTENT),
        (edited_root, LEGACY_REVIEW_COMMAND_CONTENT + "\nUser change\n"),
    ):
        target = root / ".opencode/commands/review.md"
        target.parent.mkdir(parents=True)
        target.write_text(content)

    store = ControlStore(tmp_path / "data")
    exact = store.create_project(name="Exact", root=exact_root, endpoint=None)
    edited = store.create_project(name="Edited", root=edited_root, endpoint=None)
    store.close()

    with _client(tmp_path) as client:
        assert not (exact_root / ".opencode/commands/review.md").exists()
        assert (edited_root / ".opencode/commands/review.md").read_text().endswith(
            "User change\n"
        )
        assert client.app.state.control.store.get_project(str(exact["id"]))[
            "starter_commands_version"
        ] == STARTER_COMMANDS_VERSION
        assert client.app.state.control.store.get_project(str(edited["id"]))[
            "starter_commands_version"
        ] == STARTER_COMMANDS_VERSION


def test_command_runs_natively_and_rejects_busy_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "project"
    root.mkdir()
    calls: list[tuple[str, str, str]] = []
    status = {"value": "idle"}
    started = threading.Event()
    release = threading.Event()

    class FakeOpenCodeClient:
        def __init__(self, endpoint: str, directory: str, **kwargs: Any) -> None:
            return

        def request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
            return {"worktree": str(root)}

        def ensure_session_directory(
            self, session_id: str, *, missing_ok: bool = False
        ) -> bool:
            return True

        def commands(self) -> list[dict[str, Any]]:
            return [
                {"id": "review", "description": "Review", "content": "Review $ARGUMENTS"}
            ]

        def snapshot(self) -> dict[str, Any]:
            return {"statuses": {"ses_command": {"type": status["value"]}}}

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
            started.set()
            release.wait(timeout=2)
            calls.append((session_id, command, arguments))

    monkeypatch.setattr(app_module, "OpenCodeClient", FakeOpenCodeClient)
    with _client(tmp_path) as client:
        project_id = _project(client, root, endpoint="http://127.0.0.1:4096")["id"]
        headers = _csrf(client)
        endpoint = f"/api/v1/projects/{project_id}/sessions/ses_command/commands/review"

        executed = client.post(endpoint, headers=headers, json={"arguments": "auth"})
        assert started.wait(timeout=1)
        status["value"] = "busy"
        busy = client.post(endpoint, headers=headers, json={"arguments": "again"})

        assert executed.status_code == 202
        assert executed.json() == {"accepted": True}
        assert calls == []
        release.set()
        for _ in range(100):
            if calls:
                break
            time.sleep(0.01)
        assert calls == [("ses_command", "review", "auth")]
        assert busy.status_code == 409
