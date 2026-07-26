from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path

MAX_LOG_BYTES = 10 * 1024 * 1024
LOG_BACKUPS = 3


class LogRotationError(RuntimeError):
    pass


def rotate_log(
    path: Path,
    *,
    max_bytes: int = MAX_LOG_BYTES,
    backups: int = LOG_BACKUPS,
) -> bool:
    if max_bytes < 1 or backups < 1:
        raise ValueError("log rotation limits must be positive")
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    _require_regular_file(path, info)
    if info.st_size <= max_bytes:
        return False

    oldest = _backup_path(path, backups)
    _safe_unlink(oldest)
    for index in range(backups - 1, 0, -1):
        source_path = _backup_path(path, index)
        target_path = _backup_path(path, index + 1)
        try:
            source_info = source_path.lstat()
        except FileNotFoundError:
            continue
        _require_regular_file(source_path, source_info)
        os.replace(source_path, target_path)

    temporary = path.with_name(f".{path.name}.rotating")
    _safe_unlink(temporary)
    try:
        with path.open("rb") as source, temporary.open("xb") as target:
            source.seek(max(0, info.st_size - max_bytes))
            if source.tell() > 0:
                tail_start = source.tell()
                partial_line = source.readline()
                if not partial_line.endswith(b"\n"):
                    source.seek(tail_start)
            shutil.copyfileobj(source, target, length=64 * 1024)
        os.chmod(temporary, 0o600)
        os.replace(temporary, _backup_path(path, 1))
        path.unlink()
    except Exception:
        _safe_unlink(temporary)
        raise
    return True


def _backup_path(path: Path, index: int) -> Path:
    return path.with_name(f"{path.name}.{index}")


def _safe_unlink(path: Path) -> None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    _require_regular_file(path, info)
    path.unlink()


def _require_regular_file(path: Path, info: os.stat_result) -> None:
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        raise LogRotationError(f"log path is unsafe: {path}")
