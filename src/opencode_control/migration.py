from __future__ import annotations

import json
import os
import shutil
import sqlite3
import stat
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class MigrationResult:
    migrated: bool
    source: Path | None
    target: Path
    counts: dict[str, int]


def prepare_control_data_dir(target: Path, legacy: Path | None = None) -> MigrationResult:
    target = Path(os.path.abspath(target.expanduser()))
    source = Path(os.path.abspath((legacy or Path.home() / ".opencode-studio").expanduser()))
    if target == source:
        raise MigrationError("OpenCode Control data directory cannot use the legacy path")

    existing = _existing_directory(target)
    if existing:
        return MigrationResult(False, None, target, _database_counts(target / "control.sqlite"))
    if not _legacy_available(source):
        target.mkdir(parents=True, mode=0o700)
        os.chmod(target, 0o700)
        return MigrationResult(False, None, target, {})

    staging = target.with_name(f".{target.name}.migrating")
    _reset_staging(staging)
    staging.mkdir(parents=True, mode=0o700)
    try:
        source_counts = _backup_database(source / "studio.sqlite", staging / "control.sqlite")
        _copy_regular_file(source / "studio.log", staging / "control.log")
        _copy_logs(source / "logs", staging / "logs")
        marker = {
            "migration": "opencode-studio-to-opencode-control",
            "source": str(source),
            "target": str(target),
            "created_at": datetime.now(UTC).isoformat(),
            "counts": source_counts,
        }
        marker_path = staging / "migration.json"
        marker_path.write_text(json.dumps(marker, indent=2) + "\n", encoding="utf-8")
        os.chmod(marker_path, 0o600)
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staging, target)
    except Exception:
        _reset_staging(staging)
        raise

    migrated_counts = _verify_database(target / "control.sqlite")
    if migrated_counts != source_counts:
        raise MigrationError("migrated database counts do not match the legacy database")
    return MigrationResult(True, source, target, migrated_counts)


def _existing_directory(target: Path) -> bool:
    try:
        info = target.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise MigrationError(f"data path is not a safe directory: {target}")
    entries = list(target.iterdir())
    if entries:
        return True
    target.rmdir()
    return False


def _legacy_available(source: Path) -> bool:
    try:
        info = source.lstat()
        database = (source / "studio.sqlite").lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise MigrationError(f"legacy data path is not a safe directory: {source}")
    if not stat.S_ISREG(database.st_mode) or stat.S_ISLNK(database.st_mode):
        raise MigrationError("legacy database is not a safe regular file")
    return True


def _backup_database(source_path: Path, target_path: Path) -> dict[str, int]:
    source_uri = f"file:{source_path}?mode=ro"
    try:
        with sqlite3.connect(source_uri, uri=True) as source:
            source.execute("PRAGMA foreign_keys=ON")
            source_counts = _verify_connection(source)
            with sqlite3.connect(target_path) as target:
                source.backup(target)
                target.execute("PRAGMA journal_mode=DELETE")
                target.execute("PRAGMA foreign_keys=ON")
                target.commit()
    except sqlite3.Error as error:
        raise MigrationError(f"failed to migrate legacy database: {error}") from error
    os.chmod(target_path, 0o600)
    migrated_counts = _verify_database(target_path)
    if migrated_counts != source_counts:
        raise MigrationError("database backup verification failed")
    return source_counts


def _verify_database(path: Path) -> dict[str, int]:
    if not path.exists():
        return {}
    try:
        with sqlite3.connect(path) as connection:
            connection.execute("PRAGMA foreign_keys=ON")
            return _verify_connection(connection)
    except sqlite3.Error as error:
        raise MigrationError(f"database verification failed: {error}") from error


def _verify_connection(connection: sqlite3.Connection) -> dict[str, int]:
    integrity = connection.execute("PRAGMA integrity_check").fetchone()
    if not integrity or integrity[0] != "ok":
        raise MigrationError("database integrity check failed")
    if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
        raise MigrationError("database foreign key check failed")
    return {
        table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
        for table in ("projects", "tasks", "task_sessions")
    }


def _database_counts(path: Path) -> dict[str, int]:
    return _verify_database(path) if path.exists() else {}


def _copy_logs(source: Path, target: Path) -> None:
    try:
        info = source.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise MigrationError("legacy logs path is unsafe")
    target.mkdir(mode=0o700)
    for candidate in source.iterdir():
        _copy_regular_file(candidate, target / candidate.name)


def _copy_regular_file(source: Path, target: Path) -> None:
    try:
        info = source.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        raise MigrationError(f"legacy file is unsafe: {source}")
    shutil.copyfile(source, target, follow_symlinks=False)
    os.chmod(target, 0o600)


def _reset_staging(staging: Path) -> None:
    try:
        info = staging.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise MigrationError(f"migration staging path is unsafe: {staging}")
    shutil.rmtree(staging)
