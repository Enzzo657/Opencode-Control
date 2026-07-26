from __future__ import annotations

import os
from pathlib import Path

import pytest

from opencode_control.log_rotation import LogRotationError, rotate_log


def test_rotates_tail_and_shifts_bounded_backups(tmp_path: Path) -> None:
    log = tmp_path / "control.log"
    log.write_bytes(b"discarded-line\n" + b"kept-line\n" * 8)
    (tmp_path / "control.log.1").write_text("first backup")
    (tmp_path / "control.log.2").write_text("second backup")
    (tmp_path / "control.log.3").write_text("oldest backup")

    assert rotate_log(log, max_bytes=48, backups=3) is True

    assert not log.exists()
    assert 0 < (tmp_path / "control.log.1").stat().st_size <= 48
    assert (tmp_path / "control.log.1").read_bytes().startswith(b"kept-line\n")
    assert (tmp_path / "control.log.2").read_text() == "first backup"
    assert (tmp_path / "control.log.3").read_text() == "second backup"
    assert (tmp_path / "control.log.1").stat().st_mode & 0o777 == 0o600


def test_leaves_small_log_unchanged(tmp_path: Path) -> None:
    log = tmp_path / "project.log"
    log.write_text("small")

    assert rotate_log(log, max_bytes=32) is False
    assert log.read_text() == "small"
    assert not (tmp_path / "project.log.1").exists()


def test_preserves_bounded_tail_for_one_long_line(tmp_path: Path) -> None:
    log = tmp_path / "control.log"
    log.write_bytes(b"x" * 128)

    assert rotate_log(log, max_bytes=32) is True

    assert (tmp_path / "control.log.1").read_bytes() == b"x" * 32


def test_rejects_symlinks_and_hard_links(tmp_path: Path) -> None:
    outside = tmp_path / "outside.log"
    outside.write_text("sensitive")
    symlink = tmp_path / "symlink.log"
    symlink.symlink_to(outside)
    hard_link = tmp_path / "hard-link.log"
    os.link(outside, hard_link)

    with pytest.raises(LogRotationError, match="unsafe"):
        rotate_log(symlink, max_bytes=1)
    with pytest.raises(LogRotationError, match="unsafe"):
        rotate_log(hard_link, max_bytes=1)

    assert outside.read_text() == "sensitive"
