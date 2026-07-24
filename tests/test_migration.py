from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from opencode_control.migration import MigrationError, prepare_control_data_dir


def _legacy_database(path: Path) -> sqlite3.Connection:
    path.mkdir(mode=0o700)
    connection = sqlite3.connect(path / "studio.sqlite")
    connection.executescript(
        """
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            root TEXT NOT NULL UNIQUE,
            endpoint TEXT,
            root_device INTEGER,
            root_inode INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            prompt TEXT NOT NULL,
            agent TEXT,
            model TEXT,
            status TEXT NOT NULL,
            session_id TEXT,
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX tasks_project_task ON tasks(project_id, id);
        CREATE TABLE task_sessions (
            project_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (project_id, session_id),
            FOREIGN KEY (project_id, task_id)
                REFERENCES tasks(project_id, id) ON DELETE CASCADE
        );
        """
    )
    connection.execute(
        "INSERT INTO projects VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)",
        ("prj_keep", "Keep", "/tmp/keep", "now", "now"),
    )
    connection.execute(
        "INSERT INTO tasks VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)",
        (
            "task_keep",
            "prj_keep",
            "Keep task",
            "Keep prompt",
            "completed",
            "ses_keep",
            "now",
            "now",
        ),
    )
    connection.execute(
        "INSERT INTO task_sessions VALUES (?, ?, ?, ?)",
        ("prj_keep", "task_keep", "ses_keep", "now"),
    )
    connection.commit()
    return connection


def test_migrates_wal_database_and_logs_without_modifying_legacy(tmp_path: Path) -> None:
    legacy = tmp_path / ".opencode-studio"
    connection = _legacy_database(legacy)
    (legacy / "studio.log").write_text("legacy main log")
    (legacy / "logs").mkdir()
    (legacy / "logs/prj_keep.log").write_text("project log")
    target = tmp_path / ".opencode-control"

    try:
        result = prepare_control_data_dir(target, legacy)
    finally:
        connection.close()

    assert result.migrated is True
    assert result.counts == {"projects": 1, "tasks": 1, "task_sessions": 1}
    assert (legacy / "studio.sqlite").exists()
    assert not (target / "control.sqlite-wal").exists()
    assert not (target / "control.sqlite-shm").exists()
    assert (target / "control.log").read_text() == "legacy main log"
    assert (target / "logs/prj_keep.log").read_text() == "project log"
    assert not (target / "control.pid").exists()
    marker = json.loads((target / "migration.json").read_text())
    assert marker["migration"] == "opencode-studio-to-opencode-control"
    with sqlite3.connect(target / "control.sqlite") as migrated:
        assert migrated.execute("SELECT id FROM projects").fetchone() == ("prj_keep",)
        assert migrated.execute("SELECT session_id FROM task_sessions").fetchone() == (
            "ses_keep",
        )

    second = prepare_control_data_dir(target, legacy)
    assert second.migrated is False
    assert second.counts == result.counts


def test_rejects_corrupt_legacy_database_without_publishing_target(tmp_path: Path) -> None:
    legacy = tmp_path / ".opencode-studio"
    legacy.mkdir()
    (legacy / "studio.sqlite").write_bytes(b"not a sqlite database")
    target = tmp_path / ".opencode-control"

    with pytest.raises(MigrationError, match="failed to migrate legacy database"):
        prepare_control_data_dir(target, legacy)

    assert not target.exists()
    assert (legacy / "studio.sqlite").read_bytes() == b"not a sqlite database"


def test_rejects_symlinked_legacy_log(tmp_path: Path) -> None:
    legacy = tmp_path / ".opencode-studio"
    connection = _legacy_database(legacy)
    connection.close()
    outside = tmp_path / "outside.log"
    outside.write_text("outside")
    (legacy / "studio.log").symlink_to(outside)

    with pytest.raises(MigrationError, match="legacy file is unsafe"):
        prepare_control_data_dir(tmp_path / ".opencode-control", legacy)

    assert outside.read_text() == "outside"
