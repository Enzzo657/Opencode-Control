from __future__ import annotations

import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import opencode_control.cli as cli_module
from opencode_control.access import AccessTokenError, load_or_create_access_token
from opencode_control.cli import _build_parser, main
from opencode_control.config import ControlConfig
from opencode_control.store import ControlStore


def test_public_cli_has_only_operational_commands() -> None:
    parser = _build_parser()

    start = parser.parse_args(["start"])
    assert start.action == "start"
    assert start.host == "127.0.0.1"
    assert start.port == 8765
    assert start.no_open is False
    assert parser.parse_args(["restart", "--no-open"]).no_open is True
    assert parser.parse_args(["stop"]).action == "stop"
    assert parser.parse_args(["status"]).action == "status"
    assert parser.parse_args(["logs"]).lines == 100
    assert parser.parse_args(["logs", "--lines", "25", "--follow"]).follow is True
    assert parser.parse_args(["uninstall", "--yes"]).yes is True
    assert parser.parse_args(["uninstall", "--purge-data"]).purge_data is True
    with pytest.raises(SystemExit):
        parser.parse_args(["run"])


def test_prepare_data_creates_private_control_directory(tmp_path: Path) -> None:
    data_dir = tmp_path / "nested/control"

    cli_module._prepare_data(ControlConfig(data_dir=data_dir))

    assert data_dir.is_dir()
    assert data_dir.stat().st_mode & 0o777 == 0o700


def test_runtime_access_token_is_private_and_stable(tmp_path: Path) -> None:
    data_dir = tmp_path / "control"
    cli_module._prepare_data(ControlConfig(data_dir=data_dir))

    first = load_or_create_access_token(data_dir)
    second = load_or_create_access_token(data_dir)

    assert first == second
    assert len(first) >= 43
    assert (data_dir / "access-token").stat().st_mode & 0o777 == 0o600


def test_runtime_access_token_rejects_symlink(tmp_path: Path) -> None:
    data_dir = tmp_path / "control"
    cli_module._prepare_data(ControlConfig(data_dir=data_dir))
    outside = tmp_path / "outside-token"
    outside.write_text("x" * 43)
    (data_dir / "access-token").symlink_to(outside)

    with pytest.raises(AccessTokenError, match="could not open"):
        load_or_create_access_token(data_dir)


def test_browser_access_token_stays_in_url_fragment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    opened: list[str] = []
    monkeypatch.setattr("webbrowser.open", opened.append)

    cli_module._open_browser("127.0.0.1", 8765, "secret_value")

    assert opened == ["http://127.0.0.1:8765/#access_token=secret_value"]


@pytest.mark.parametrize("unsafe_kind", ["file", "symlink"])
def test_prepare_data_rejects_unsafe_target(
    tmp_path: Path, unsafe_kind: str
) -> None:
    data_dir = tmp_path / "control"
    if unsafe_kind == "file":
        data_dir.write_text("unsafe")
    else:
        outside = tmp_path / "outside"
        outside.mkdir()
        data_dir.symlink_to(outside, target_is_directory=True)

    with pytest.raises(SystemExit, match="not a safe directory"):
        cli_module._prepare_data(ControlConfig(data_dir=data_dir))

def test_status_uses_custom_control_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("OPENCODE_CONTROL_HOME", str(tmp_path / "control"))

    main(["status"])

    assert capsys.readouterr().out == "stopped\n"


def test_logs_prints_requested_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    data_dir = tmp_path / "control"
    data_dir.mkdir()
    (data_dir / "control.log").write_text("one\ntwo\nthree\n")
    monkeypatch.setenv("OPENCODE_CONTROL_HOME", str(data_dir))

    main(["logs", "--lines", "2"])

    assert capsys.readouterr().out == "two\nthree\n"


def test_uninstall_uses_uv_and_preserves_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    data_dir = tmp_path / "control"
    data_dir.mkdir()
    database = data_dir / "control.sqlite"
    database.write_text("keep")
    calls: list[list[str]] = []
    monkeypatch.setenv("OPENCODE_CONTROL_HOME", str(data_dir))
    monkeypatch.setattr(cli_module, "_stop", lambda *args, **kwargs: False)
    monkeypatch.setattr(cli_module.shutil, "which", lambda command: "/usr/bin/uv")
    monkeypatch.setattr(
        cli_module.subprocess,
        "run",
        lambda command, check: calls.append(command) or SimpleNamespace(returncode=0),
    )

    main(["uninstall", "--yes"])

    assert calls == [["/usr/bin/uv", "tool", "uninstall", "opencode-control"]]
    assert database.read_text() == "keep"
    assert f"Data preserved at {data_dir}" in capsys.readouterr().out


def test_uninstall_purges_only_control_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    data_dir = tmp_path / "control"
    logs = data_dir / "logs"
    logs.mkdir(parents=True)
    (data_dir / "control.sqlite").write_text("database")
    (data_dir / "control.log").write_text("runtime")
    (logs / "prj_123.log.1").write_text("project")
    monkeypatch.setenv("OPENCODE_CONTROL_HOME", str(data_dir))
    monkeypatch.setattr(cli_module, "_stop", lambda *args, **kwargs: False)
    monkeypatch.setattr(cli_module.shutil, "which", lambda command: "/usr/bin/uv")
    monkeypatch.setattr(
        cli_module.subprocess,
        "run",
        lambda command, check: SimpleNamespace(returncode=0),
    )

    main(["uninstall", "--yes", "--purge-data"])

    assert not data_dir.exists()
    assert f"Data deleted from {data_dir}" in capsys.readouterr().out


def test_uninstall_rejects_unsafe_purge_before_removing_tool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "target"
    target.mkdir()
    data_dir = tmp_path / "control"
    data_dir.symlink_to(target, target_is_directory=True)
    monkeypatch.setenv("OPENCODE_CONTROL_HOME", str(data_dir))
    monkeypatch.setattr(cli_module, "_stop", lambda *args, **kwargs: False)
    monkeypatch.setattr(cli_module.shutil, "which", lambda command: "/usr/bin/uv")
    run = SimpleNamespace()
    monkeypatch.setattr(cli_module.subprocess, "run", run)

    with pytest.raises(SystemExit, match="data path is unsafe"):
        main(["uninstall", "--yes", "--purge-data"])

    assert data_dir.is_symlink()
    assert not hasattr(run, "called")


def test_uninstall_asks_separately_about_data(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "control"
    data_dir.mkdir()
    database = data_dir / "control.sqlite"
    database.write_text("database")
    answers = iter(["yes", "no"])
    monkeypatch.setenv("OPENCODE_CONTROL_HOME", str(data_dir))
    monkeypatch.setattr(cli_module.sys, "stdin", SimpleNamespace(isatty=lambda: True))
    monkeypatch.setattr("builtins.input", lambda prompt: next(answers))
    monkeypatch.setattr(cli_module, "_stop", lambda *args, **kwargs: False)
    monkeypatch.setattr(cli_module.shutil, "which", lambda command: "/usr/bin/uv")
    monkeypatch.setattr(
        cli_module.subprocess,
        "run",
        lambda command, check: SimpleNamespace(returncode=0),
    )

    main(["uninstall"])

    assert database.read_text() == "database"


def test_uvicorn_log_format_includes_timestamp() -> None:
    config = cli_module._uvicorn_log_config()

    assert config["formatters"]["default"]["datefmt"] == "%Y-%m-%d %H:%M:%S"
    assert config["formatters"]["default"]["fmt"].startswith("%(asctime)s")
    assert config["formatters"]["access"]["fmt"].startswith("%(asctime)s")


def test_runtime_lock_rejects_a_second_owner(tmp_path: Path) -> None:
    lock = tmp_path / "control.lock"

    with (
        cli_module._exclusive_lock(lock),
        pytest.raises(SystemExit, match="already running"),
        cli_module._exclusive_lock(
            lock, blocking=False, busy_message="OpenCode Control is already running"
        ),
    ):
        pass


def test_failed_start_terminates_child_and_removes_its_pid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pid_path = tmp_path / "control.pid"
    pid_path.write_text("54321")
    signals: list[tuple[int, int]] = []

    class Process:
        pid = 54321
        returncode: int | None = None

        def poll(self) -> int | None:
            return self.returncode

        def wait(self, timeout: float) -> int:
            self.returncode = 0
            return 0

    monkeypatch.setattr(
        cli_module.os, "killpg", lambda pid, sent_signal: signals.append((pid, sent_signal))
    )

    cli_module._cleanup_failed_start(Process(), pid_path)  # type: ignore[arg-type]

    assert signals == [(54321, cli_module.signal.SIGTERM)]
    assert not pid_path.exists()


def test_atomic_pid_write_replaces_stale_value(tmp_path: Path) -> None:
    pid_path = tmp_path / "control.pid"
    pid_path.write_text("111")

    cli_module._write_pid(pid_path, 222)

    assert pid_path.read_text() == "222"
    assert not (tmp_path / "control.pid.tmp").exists()


def test_restart_remembers_servers_running_before_upgrade(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data_dir = tmp_path / "data"
    root = tmp_path / "project"
    root.mkdir()
    store = ControlStore(data_dir)
    project = store.create_project(name="Running", root=root, endpoint=None)
    store.close()
    payload = json.dumps(
        [{"id": project["id"], "server": {"state": "running", "managed": True}}]
    ).encode()
    monkeypatch.setattr(
        cli_module.urllib.request, "urlopen", lambda *args, **kwargs: io.BytesIO(payload)
    )

    cli_module._remember_running_servers(ControlConfig(data_dir=data_dir), "127.0.0.1", 8765)

    reopened = ControlStore(data_dir)
    try:
        assert reopened.get_project(str(project["id"]))["managed_enabled"] == 1
    finally:
        reopened.close()
