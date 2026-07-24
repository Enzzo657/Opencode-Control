from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(UTC).isoformat()


class ControlStore:
    def __init__(self, data_dir: Path) -> None:
        data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(data_dir, 0o700)
        database_path = data_dir / "control.sqlite"
        self._connection = sqlite3.connect(database_path, check_same_thread=False)
        os.chmod(database_path, 0o600)
        self._connection.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._connection:
            self._connection.executescript(
                """
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS projects (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    root TEXT NOT NULL UNIQUE,
                    endpoint TEXT,
                    root_device INTEGER,
                    root_inode INTEGER,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tasks (
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
                CREATE UNIQUE INDEX IF NOT EXISTS tasks_project_task
                    ON tasks(project_id, id);
                CREATE TABLE IF NOT EXISTS task_sessions (
                    project_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY (project_id, session_id),
                    FOREIGN KEY (project_id, task_id)
                        REFERENCES tasks(project_id, id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS task_sessions_task_created
                    ON task_sessions(task_id, created_at, session_id);
                INSERT INTO task_sessions (project_id, task_id, session_id, created_at)
                SELECT project_id, id, session_id, created_at FROM tasks
                WHERE session_id IS NOT NULL
                ON CONFLICT(project_id, session_id) DO NOTHING;
                """
            )
            columns = {
                str(row[1])
                for row in self._connection.execute("PRAGMA table_info(projects)").fetchall()
            }
            if "root_device" not in columns:
                self._connection.execute("ALTER TABLE projects ADD COLUMN root_device INTEGER")
            if "root_inode" not in columns:
                self._connection.execute("ALTER TABLE projects ADD COLUMN root_inode INTEGER")
            task_columns = {
                str(row[1])
                for row in self._connection.execute("PRAGMA table_info(tasks)").fetchall()
            }
            for name, definition in (
                ("cron", "TEXT"),
                ("timezone", "TEXT"),
                ("schedule_enabled", "INTEGER NOT NULL DEFAULT 0"),
                ("cron_session_mode", "TEXT NOT NULL DEFAULT 'new'"),
                ("next_run_at", "TEXT"),
                ("last_run_at", "TEXT"),
            ):
                if name not in task_columns:
                    self._connection.execute(f"ALTER TABLE tasks ADD COLUMN {name} {definition}")
            rows = self._connection.execute(
                "SELECT id, root FROM projects WHERE root_device IS NULL OR root_inode IS NULL"
            ).fetchall()
            for row in rows:
                try:
                    stat = os.stat(str(row["root"]), follow_symlinks=False)
                except OSError:
                    continue
                self._connection.execute(
                    "UPDATE projects SET root_device = ?, root_inode = ? WHERE id = ?",
                    (stat.st_dev, stat.st_ino, row["id"]),
                )

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def list_projects(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM projects ORDER BY name COLLATE NOCASE"
            ).fetchall()
        return [dict(row) for row in rows]

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM projects WHERE id = ?", (project_id,)
            ).fetchone()
        return dict(row) if row else None

    def create_project(self, *, name: str, root: Path, endpoint: str | None) -> dict[str, Any]:
        project_id = f"prj_{uuid.uuid4().hex[:12]}"
        timestamp = _now()
        stat = root.stat()
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO projects
                    (id, name, root, endpoint, root_device, root_inode, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    name,
                    str(root),
                    endpoint,
                    stat.st_dev,
                    stat.st_ino,
                    timestamp,
                    timestamp,
                ),
            )
        project = self.get_project(project_id)
        assert project is not None
        return project

    def update_project(
        self,
        project_id: str,
        *,
        name: str | None = None,
        endpoint: str | None = None,
        update_endpoint: bool = False,
    ) -> dict[str, Any] | None:
        project = self.get_project(project_id)
        if project is None:
            return None
        next_name = name if name is not None else str(project["name"])
        next_endpoint = endpoint if update_endpoint else project["endpoint"]
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE projects SET name = ?, endpoint = ?, updated_at = ? WHERE id = ?",
                (next_name, next_endpoint, _now(), project_id),
            )
        return self.get_project(project_id)

    def delete_project(self, project_id: str) -> bool:
        with self._lock, self._connection:
            cursor = self._connection.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        return cursor.rowcount > 0

    def create_task(
        self,
        project_id: str,
        *,
        title: str,
        prompt: str,
        agent: str | None,
        model: str | None,
        cron: str | None = None,
        timezone: str | None = None,
        cron_session_mode: str = "new",
        next_run_at: str | None = None,
    ) -> dict[str, Any]:
        task_id = f"task_{uuid.uuid4().hex[:12]}"
        timestamp = _now()
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO tasks
                    (id, project_id, title, prompt, agent, model, status, session_id, error,
                     created_at, updated_at, cron, timezone, schedule_enabled, cron_session_mode,
                     next_run_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    project_id,
                    title,
                    prompt,
                    agent,
                    model,
                    "scheduled" if cron else "queued",
                    None,
                    None,
                    timestamp,
                    timestamp,
                    cron,
                    timezone,
                    int(cron is not None),
                    cron_session_mode,
                    next_run_at,
                ),
            )
        task = self.get_task(project_id, task_id)
        assert task is not None
        return task

    def update_task(
        self,
        project_id: str,
        task_id: str,
        *,
        status: str,
        session_id: str | None = None,
        error: str | None = None,
    ) -> dict[str, Any] | None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE tasks SET status = ?, session_id = COALESCE(?, session_id),
                    error = ?, updated_at = ? WHERE project_id = ? AND id = ?
                """,
                (status, session_id, error, _now(), project_id, task_id),
            )
        return self.get_task(project_id, task_id)

    def record_task_prompt(
        self,
        project_id: str,
        task_id: str,
        *,
        session_id: str,
        prompt: str | None,
        agent: str | None,
        model: str | None,
        update_agent: bool,
        update_model: bool,
    ) -> dict[str, Any] | None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE tasks SET status = 'running', session_id = ?,
                    prompt = COALESCE(?, prompt),
                    agent = CASE WHEN ? THEN ? ELSE agent END,
                    model = CASE WHEN ? THEN ? ELSE model END,
                    error = NULL, updated_at = ?
                WHERE project_id = ? AND id = ?
                """,
                (
                    session_id,
                    prompt,
                    update_agent,
                    agent,
                    update_model,
                    model,
                    _now(),
                    project_id,
                    task_id,
                ),
            )
        return self.get_task(project_id, task_id)

    def get_task(self, project_id: str, task_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM tasks WHERE project_id = ? AND id = ?",
                (project_id, task_id),
            ).fetchone()
        return self._task_view(row) if row else None

    def list_tasks(self, project_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC",
                (project_id,),
            ).fetchall()
        return [self._task_view(row) for row in rows]

    def add_task_session(self, project_id: str, task_id: str, session_id: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO task_sessions (project_id, task_id, session_id, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (project_id, task_id, session_id, _now()),
            )

    def remove_task_session(self, project_id: str, session_id: str) -> None:
        with self._lock, self._connection:
            row = self._connection.execute(
                "SELECT task_id FROM task_sessions WHERE project_id = ? AND session_id = ?",
                (project_id, session_id),
            ).fetchone()
            self._connection.execute(
                "DELETE FROM task_sessions WHERE project_id = ? AND session_id = ?",
                (project_id, session_id),
            )
            if row is None:
                return
            task_id = str(row["task_id"])
            primary = self._connection.execute(
                "SELECT session_id FROM tasks WHERE project_id = ? AND id = ?",
                (project_id, task_id),
            ).fetchone()
            if primary is None or primary["session_id"] != session_id:
                return
            replacement = self._connection.execute(
                """
                SELECT session_id FROM task_sessions
                WHERE project_id = ? AND task_id = ?
                ORDER BY created_at, session_id LIMIT 1
                """,
                (project_id, task_id),
            ).fetchone()
            self._connection.execute(
                "UPDATE tasks SET session_id = ?, updated_at = ? WHERE project_id = ? AND id = ?",
                (replacement["session_id"] if replacement else None, _now(), project_id, task_id),
            )

    def task_session_ids(self, project_id: str, task_id: str) -> list[str]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT session_id FROM task_sessions
                WHERE project_id = ? AND task_id = ?
                ORDER BY created_at, session_id
                """,
                (project_id, task_id),
            ).fetchall()
        return [str(row["session_id"]) for row in rows]

    def project_session_tasks(self, project_id: str) -> dict[str, dict[str, str]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT links.session_id, tasks.id, tasks.title, tasks.status
                FROM task_sessions AS links
                JOIN tasks ON tasks.project_id = links.project_id AND tasks.id = links.task_id
                WHERE links.project_id = ?
                """,
                (project_id,),
            ).fetchall()
        return {
            str(row["session_id"]): {
                "id": str(row["id"]),
                "title": str(row["title"]),
                "status": str(row["status"]),
            }
            for row in rows
        }

    def task_for_session(self, project_id: str, session_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT tasks.* FROM task_sessions AS links
                JOIN tasks ON tasks.project_id = links.project_id AND tasks.id = links.task_id
                WHERE links.project_id = ? AND links.session_id = ?
                """,
                (project_id, session_id),
            ).fetchone()
        return self._task_view(row) if row else None

    def set_schedule_enabled(
        self,
        project_id: str,
        task_id: str,
        *,
        enabled: bool,
        next_run_at: str | None,
    ) -> dict[str, Any] | None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE tasks SET schedule_enabled = ?, next_run_at = ?,
                    status = CASE
                        WHEN status IN ('queued', 'dispatching', 'running') THEN status
                        WHEN ? THEN 'scheduled'
                        ELSE 'paused'
                    END,
                    updated_at = ?
                WHERE project_id = ? AND id = ? AND cron IS NOT NULL
                """,
                (int(enabled), next_run_at, int(enabled), _now(), project_id, task_id),
            )
        return self.get_task(project_id, task_id)

    def configure_task_schedule(
        self,
        project_id: str,
        task_id: str,
        *,
        cron: str | None,
        timezone: str | None,
        enabled: bool,
        cron_session_mode: str | None,
        next_run_at: str | None,
    ) -> dict[str, Any] | None:
        task = self.get_task(project_id, task_id)
        if task is None:
            return None
        status = str(task["status"])
        if status not in {"queued", "dispatching", "running"}:
            if cron is not None:
                status = "scheduled" if enabled else "paused"
            elif status in {"scheduled", "paused"}:
                status = "completed"
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE tasks SET cron = ?, timezone = ?, schedule_enabled = ?,
                    cron_session_mode = COALESCE(?, cron_session_mode), next_run_at = ?,
                    status = ?, updated_at = ?
                WHERE project_id = ? AND id = ?
                """,
                (
                    cron,
                    timezone,
                    int(enabled and cron is not None),
                    cron_session_mode,
                    next_run_at,
                    status,
                    _now(),
                    project_id,
                    task_id,
                ),
            )
        return self.get_task(project_id, task_id)

    def due_tasks(self, now: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT * FROM tasks
                WHERE schedule_enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
                ORDER BY next_run_at, created_at
                """,
                (now,),
            ).fetchall()
        return [self._task_view(row) for row in rows]

    def claim_scheduled_run(
        self,
        project_id: str,
        task_id: str,
        *,
        expected_run_at: str,
        next_run_at: str,
        claimed_at: str,
    ) -> bool:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                UPDATE tasks SET next_run_at = ?, last_run_at = ?, updated_at = ?
                WHERE project_id = ? AND id = ? AND schedule_enabled = 1
                    AND next_run_at = ?
                """,
                (next_run_at, claimed_at, claimed_at, project_id, task_id, expected_run_at),
            )
        return cursor.rowcount == 1

    def delete_task(self, project_id: str, task_id: str) -> bool:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                "DELETE FROM tasks WHERE project_id = ? AND id = ?",
                (project_id, task_id),
            )
        return cursor.rowcount > 0

    def _task_view(self, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["session_ids"] = self.task_session_ids(
            str(result["project_id"]), str(result["id"])
        )
        return result

    def export_state(self) -> str:
        return json.dumps({"projects": self.list_projects()}, ensure_ascii=False)
