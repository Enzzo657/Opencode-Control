from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

import opencode_control.workspace as workspace
from opencode_control.workspace import WorkspaceError, root_identity, validate_root


def test_root_identity_allows_device_change_with_stable_birthtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = replace(root_identity(tmp_path), birthtime_ns=123)
    original_fstat = workspace.os.fstat
    monkeypatch.setattr(
        workspace.os,
        "fstat",
        lambda descriptor: replace_stat_device(
            original_fstat(descriptor), root.device + 1, birthtime_ns=123
        ),
    )

    validate_root(root)


def test_root_identity_rejects_device_change_without_birthtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = replace(root_identity(tmp_path), birthtime_ns=None)
    original_fstat = workspace.os.fstat
    monkeypatch.setattr(
        workspace.os,
        "fstat",
        lambda descriptor: replace_stat_device(original_fstat(descriptor), root.device + 1),
    )

    with pytest.raises(WorkspaceError, match="identity changed"):
        validate_root(root)


def replace_stat_device(info: object, device: int, *, birthtime_ns: int | None = None) -> object:
    class StatProxy:
        st_dev = device
        st_ino = info.st_ino  # type: ignore[attr-defined]
        st_birthtime = (
            birthtime_ns / 1_000_000_000
            if birthtime_ns is not None
            else getattr(info, "st_birthtime", None)
        )

    return StatProxy()
