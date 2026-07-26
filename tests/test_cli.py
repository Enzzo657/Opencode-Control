from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

import opencode_control.cli as cli_module
from opencode_control.cli import _build_parser, main


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
    legacy = tmp_path / ".opencode-studio"
    legacy.mkdir()
    (legacy / "keep").write_text("legacy")
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
    assert (legacy / "keep").read_text() == "legacy"
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
