from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from opencode_control.config_lifecycle import (
    ConfigFile,
    ConfigTransactionManager,
    OpenCodeConfigPreflight,
    compatibility_for_version,
)
from opencode_control.workspace import WorkspaceError, root_identity


def test_transaction_restores_exact_content_mode_and_missing_file(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    existing = project / "opencode.jsonc"
    existing.write_text('{\n  // keep this comment\n  "mcp": {}\n}\n')
    os.chmod(existing, 0o640)
    root = root_identity(project)
    files = [
        ConfigFile(root, Path("opencode.jsonc")),
        ConfigFile(root, Path("opencode.json")),
    ]
    manager = ConfigTransactionManager(tmp_path / "data")
    transaction = manager.begin("test", files)

    transaction.write_candidates(
        {
            files[0].key: '{"mcp":{"broken":true}}\n',
            files[1].key: '{"provider":{}}\n',
        }
    )
    transaction.rollback()

    assert existing.read_text() == '{\n  // keep this comment\n  "mcp": {}\n}\n'
    assert existing.stat().st_mode & 0o777 == 0o640
    assert not (project / "opencode.json").exists()
    assert list(manager.root.iterdir()) == []


def test_pending_transaction_is_rolled_back_on_recovery(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    target = project / "opencode.json"
    target.write_text('{"before":true}\n')
    config_file = ConfigFile(root_identity(project), Path("opencode.json"))
    manager = ConfigTransactionManager(tmp_path / "data")
    transaction = manager.begin("crash", [config_file])
    transaction.write_candidates({config_file.key: '{"after":true}\n'})

    recovered = ConfigTransactionManager(tmp_path / "data").recover_pending()

    assert recovered == [
        {"operation_id": transaction.operation_id, "state": "rolled_back"}
    ]
    assert target.read_text() == '{"before":true}\n'


def test_rollback_refuses_to_overwrite_an_external_change(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    target = project / "opencode.json"
    target.write_text('{"before":true}\n')
    config_file = ConfigFile(root_identity(project), Path("opencode.json"))
    manager = ConfigTransactionManager(tmp_path / "data")
    transaction = manager.begin("conflict", [config_file])
    transaction.write_candidates({config_file.key: '{"candidate":true}\n'})
    target.write_text('{"external":true}\n')

    with pytest.raises(WorkspaceError, match="changed externally"):
        transaction.rollback()

    assert target.read_text() == '{"external":true}\n'
    assert (transaction.directory / "manifest.json").is_file()


def test_preflight_uses_isolated_global_and_project_configs(tmp_path: Path) -> None:
    binary = tmp_path / "opencode"
    binary.write_text(
        f"#!{sys.executable}\n"
        "import json, os, pathlib, sys\n"
        "if sys.argv[1:] == ['--version']:\n"
        "    print('1.18.5')\n"
        "    raise SystemExit(0)\n"
        "xdg = pathlib.Path(os.environ['XDG_CONFIG_HOME'])\n"
        "texts = [p.read_text() for p in (xdg / 'opencode').glob('opencode.*')]\n"
        "texts += [p.read_text() for p in pathlib.Path.cwd().glob('opencode.*')]\n"
        "if any('broken' in text for text in texts):\n"
        "    print('mcp.pencil.command: expected array', file=sys.stderr)\n"
        "    raise SystemExit(1)\n"
        "print(json.dumps({'mcp': {}}))\n"
    )
    os.chmod(binary, 0o700)
    preflight = OpenCodeConfigPreflight(str(binary), tmp_path / "data")

    valid = preflight.validate(
        global_files={"opencode.jsonc": '{"mcp":{}}\n'},
        project_files={"opencode.json": '{"provider":{}}\n'},
    )
    invalid = preflight.validate(
        global_files={"opencode.jsonc": '{"broken":true}\n'},
        project_files={},
    )

    assert valid.valid is True
    assert valid.version == "1.18.5"
    assert invalid.valid is False
    assert "expected array" in str(invalid.error)


@pytest.mark.parametrize(
    ("version", "state"),
    [
        ("1.17.9", "incompatible"),
        ("1.18.5", "compatible"),
        ("opencode 1.19.0", "untested_newer"),
        (None, "unknown"),
    ],
)
def test_version_compatibility_policy(version: str | None, state: str) -> None:
    assert compatibility_for_version(version)["state"] == state
