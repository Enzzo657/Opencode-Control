from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


def _birthtime_ns(info: os.stat_result) -> int | None:
    value = getattr(info, "st_birthtime", None)
    if not isinstance(value, (int, float)):
        return None
    return round(value * 1_000_000_000)


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _session_task_link(row: sqlite3.Row, run: sqlite3.Row | None) -> dict[str, str]:
    session_id = str(row["session_id"])
    task_status = str(row["status"])
    task_is_current = row["current_session_id"] == session_id and task_status not in {
        "scheduled",
        "paused",
    }
    task_is_newer = run is None or str(row["updated_at"]) > str(run["updated_at"])
    status: str | None = None
    error: str | None = None
    updated_at: str | None = None
    if task_is_current and task_is_newer:
        status = task_status
        error = str(row["error"]) if row["error"] else None
        updated_at = str(row["updated_at"])
    elif run is not None:
        status = str(run["status"])
        error = str(run["error"]) if run["error"] else None
        updated_at = str(run["updated_at"])
    normalized = {
        "claimed": "dispatching",
        "session_created": "dispatching",
        "ambiguous": "dispatching",
        "cancelled": "aborted",
        "skipped": "aborted",
        "error": "failed",
    }.get(status or "", status)
    result = {
        "id": str(row["id"]),
        "title": str(row["title"]),
        "status": task_status,
    }
    if normalized:
        result["session_status"] = normalized
    if error:
        result["session_error"] = error
    if updated_at:
        result["session_updated_at"] = updated_at
    return result


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
                    root_birthtime_ns INTEGER,
                    starter_commands_version INTEGER NOT NULL DEFAULT 0,
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
                    variant TEXT,
                    mentions TEXT NOT NULL DEFAULT '[]',
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
                CREATE TABLE IF NOT EXISTS scheduled_runs (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    schedule_revision INTEGER NOT NULL,
                    scheduled_for TEXT NOT NULL,
                    status TEXT NOT NULL,
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    lease_token TEXT,
                    lease_expires_at TEXT,
                    session_id TEXT,
                    error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT,
                    UNIQUE (project_id, task_id, schedule_revision, scheduled_for),
                    FOREIGN KEY (project_id, task_id)
                        REFERENCES tasks(project_id, id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS scheduled_runs_claimable
                    ON scheduled_runs(status, lease_expires_at, scheduled_for);
                CREATE INDEX IF NOT EXISTS scheduled_runs_task_history
                    ON scheduled_runs(project_id, task_id, scheduled_for DESC);
                CREATE TABLE IF NOT EXISTS control_events (
                    id TEXT PRIMARY KEY,
                    dedupe_key TEXT NOT NULL UNIQUE,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    task_id TEXT,
                    session_id TEXT,
                    run_id TEXT,
                    permission_id TEXT,
                    kind TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    resource_title TEXT NOT NULL,
                    detail TEXT,
                    occurred_at TEXT NOT NULL,
                    read_at TEXT
                );
                CREATE INDEX IF NOT EXISTS control_events_occurred
                    ON control_events(occurred_at DESC, id DESC);
                CREATE INDEX IF NOT EXISTS control_events_unread
                    ON control_events(read_at, occurred_at DESC);
                CREATE TABLE IF NOT EXISTS search_sessions (
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    title_search TEXT NOT NULL,
                    parent_id TEXT,
                    updated_at REAL,
                    indexed_at TEXT NOT NULL,
                    artifact_index_version INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY (project_id, session_id)
                );
                CREATE TABLE IF NOT EXISTS search_messages (
                    project_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    role TEXT,
                    created_at REAL,
                    content TEXT NOT NULL,
                    content_search TEXT NOT NULL,
                    PRIMARY KEY (project_id, session_id, message_id),
                    FOREIGN KEY (project_id, session_id)
                        REFERENCES search_sessions(project_id, session_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS search_sessions_updated
                    ON search_sessions(project_id, updated_at DESC);
                CREATE INDEX IF NOT EXISTS search_messages_created
                    ON search_messages(project_id, created_at DESC);
                CREATE TABLE IF NOT EXISTS search_artifacts (
                    project_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    message_id TEXT NOT NULL,
                    artifact_path TEXT NOT NULL,
                    created_at REAL,
                    PRIMARY KEY (project_id, session_id, message_id, artifact_path),
                    FOREIGN KEY (project_id, session_id)
                        REFERENCES search_sessions(project_id, session_id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS search_artifacts_recent
                    ON search_artifacts(project_id, created_at DESC);
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
            migrate_birthtime = "root_birthtime_ns" not in columns
            if migrate_birthtime:
                self._connection.execute(
                    "ALTER TABLE projects ADD COLUMN root_birthtime_ns INTEGER"
                )
            if "managed_enabled" not in columns:
                self._connection.execute(
                    "ALTER TABLE projects ADD COLUMN managed_enabled INTEGER NOT NULL DEFAULT 0"
                )
            if "starter_commands_version" not in columns:
                self._connection.execute(
                    "ALTER TABLE projects ADD COLUMN "
                    "starter_commands_version INTEGER NOT NULL DEFAULT 0"
                )
            search_columns = {
                str(row[1])
                for row in self._connection.execute("PRAGMA table_info(search_sessions)").fetchall()
            }
            if "artifact_index_version" not in search_columns:
                self._connection.execute(
                    "ALTER TABLE search_sessions ADD COLUMN "
                    "artifact_index_version INTEGER NOT NULL DEFAULT 0"
                )
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
                ("schedule_revision", "INTEGER NOT NULL DEFAULT 0"),
                ("variant", "TEXT"),
                ("mentions", "TEXT NOT NULL DEFAULT '[]'"),
            ):
                if name not in task_columns:
                    self._connection.execute(f"ALTER TABLE tasks ADD COLUMN {name} {definition}")
            self._connection.execute(
                """
                CREATE INDEX IF NOT EXISTS tasks_due_schedule
                ON tasks(schedule_enabled, next_run_at)
                """
            )
            identity_filter = (
                "1 = 1" if migrate_birthtime else "root_device IS NULL OR root_inode IS NULL"
            )
            rows = self._connection.execute(
                f"SELECT id, root FROM projects WHERE {identity_filter}"
            ).fetchall()
            for row in rows:
                try:
                    stat = os.stat(str(row["root"]), follow_symlinks=False)
                except OSError:
                    continue
                self._connection.execute(
                    "UPDATE projects SET root_device = ?, root_inode = ?, "
                    "root_birthtime_ns = ? WHERE id = ?",
                    (stat.st_dev, stat.st_ino, _birthtime_ns(stat), row["id"]),
                )
            self._connection.execute(
                "DELETE FROM control_events WHERE occurred_at < ?",
                ((datetime.now(UTC) - timedelta(days=30)).isoformat(),),
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
                    (id, name, root, endpoint, root_device, root_inode,
                     root_birthtime_ns, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    project_id,
                    name,
                    str(root),
                    endpoint,
                    stat.st_dev,
                    stat.st_ino,
                    _birthtime_ns(stat),
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

    def set_managed_enabled(self, project_id: str, enabled: bool) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE projects SET managed_enabled = ?, updated_at = ? WHERE id = ?",
                (int(enabled), _now(), project_id),
            )

    def set_starter_commands_version(self, project_id: str, version: int) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE projects SET starter_commands_version = ?, updated_at = ? WHERE id = ?",
                (version, _now(), project_id),
            )

    def search_session_versions(self, project_id: str) -> dict[str, tuple[float | None, str, int]]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT session_id, updated_at, title, artifact_index_version "
                "FROM search_sessions WHERE project_id = ?",
                (project_id,),
            ).fetchall()
        return {
            str(row["session_id"]): (
                float(row["updated_at"]) if row["updated_at"] is not None else None,
                str(row["title"]),
                int(row["artifact_index_version"]),
            )
            for row in rows
        }

    def replace_search_session(
        self,
        project_id: str,
        *,
        session_id: str,
        title: str,
        parent_id: str | None,
        updated_at: float | None,
        messages: list[dict[str, Any]],
    ) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO search_sessions
                    (project_id, session_id, title, title_search, parent_id, updated_at,
                     indexed_at, artifact_index_version)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(project_id, session_id) DO UPDATE SET
                    title = excluded.title,
                    title_search = excluded.title_search,
                    parent_id = excluded.parent_id,
                    updated_at = excluded.updated_at,
                    indexed_at = excluded.indexed_at,
                    artifact_index_version = 1
                """,
                (project_id, session_id, title, title.casefold(), parent_id, updated_at, _now()),
            )
            self._connection.execute(
                "DELETE FROM search_messages WHERE project_id = ? AND session_id = ?",
                (project_id, session_id),
            )
            self._connection.execute(
                "DELETE FROM search_artifacts WHERE project_id = ? AND session_id = ?",
                (project_id, session_id),
            )
            self._connection.executemany(
                """
                INSERT INTO search_messages
                    (project_id, session_id, message_id, role, created_at, content, content_search)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        project_id,
                        session_id,
                        str(message["id"]),
                        message.get("role"),
                        message.get("created_at"),
                        str(message["content"]),
                        str(message["content"]).casefold(),
                    )
                    for message in messages
                ],
            )
            self._connection.executemany(
                """
                INSERT INTO search_artifacts
                    (project_id, session_id, message_id, artifact_path, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (
                        project_id,
                        session_id,
                        str(message["id"]),
                        str(path),
                        message.get("created_at"),
                    )
                    for message in messages
                    for path in message.get("artifacts", [])
                ],
            )

    def list_artifacts(self, project_ids: list[str]) -> list[dict[str, Any]]:
        if not project_ids:
            return []
        placeholders = ", ".join("?" for _ in project_ids)
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT artifacts.project_id, artifacts.session_id, artifacts.message_id,
                    artifacts.artifact_path, artifacts.created_at, sessions.title
                FROM search_artifacts AS artifacts
                JOIN search_sessions AS sessions
                    ON sessions.project_id = artifacts.project_id
                    AND sessions.session_id = artifacts.session_id
                WHERE artifacts.project_id IN ({placeholders})
                ORDER BY artifacts.created_at DESC, artifacts.message_id DESC,
                    artifacts.artifact_path
                """,
                project_ids,
            ).fetchall()
        return [dict(row) for row in rows]

    def prune_search_sessions(self, project_id: str, session_ids: set[str]) -> None:
        with self._lock, self._connection:
            if not session_ids:
                self._connection.execute(
                    "DELETE FROM search_sessions WHERE project_id = ?", (project_id,)
                )
                return
            placeholders = ", ".join("?" for _ in session_ids)
            self._connection.execute(
                f"DELETE FROM search_sessions WHERE project_id = ? "
                f"AND session_id NOT IN ({placeholders})",
                (project_id, *sorted(session_ids)),
            )

    def search_history(
        self, query: str, project_ids: list[str], *, limit: int, offset: int = 0
    ) -> list[dict[str, Any]]:
        if not project_ids:
            return []
        placeholders = ", ".join("?" for _ in project_ids)
        escaped = query.casefold().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        needle = f"%{escaped}%"
        prefix = f"{escaped}%"
        sql = f"""
            SELECT * FROM (
                SELECT 'session' AS kind, project_id, session_id, NULL AS message_id,
                    NULL AS role, title AS content, updated_at AS occurred_at, title,
                    CASE WHEN title_search = ? THEN 0
                         WHEN title_search LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END AS match_rank
                FROM search_sessions
                WHERE project_id IN ({placeholders}) AND title_search LIKE ? ESCAPE '\\'
                UNION ALL
                SELECT 'message' AS kind, messages.project_id, messages.session_id,
                    messages.message_id, messages.role, messages.content,
                    messages.created_at AS occurred_at, sessions.title, 3 AS match_rank
                FROM search_messages AS messages
                JOIN search_sessions AS sessions
                    ON sessions.project_id = messages.project_id
                    AND sessions.session_id = messages.session_id
                WHERE messages.project_id IN ({placeholders})
                    AND messages.content_search LIKE ? ESCAPE '\\'
            )
            ORDER BY match_rank, occurred_at DESC, session_id, message_id
            LIMIT ? OFFSET ?
        """
        with self._lock:
            rows = self._connection.execute(
                sql,
                (
                    query.casefold(),
                    prefix,
                    *project_ids,
                    needle,
                    *project_ids,
                    needle,
                    limit,
                    offset,
                ),
            ).fetchall()
        return [dict(row) for row in rows]

    def create_task(
        self,
        project_id: str,
        *,
        title: str,
        prompt: str,
        agent: str | None,
        model: str | None,
        variant: str | None = None,
        mentions: list[str] | None = None,
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
                    (id, project_id, title, prompt, agent, model, variant, mentions, status,
                     session_id, error, created_at, updated_at, cron, timezone,
                     schedule_enabled, cron_session_mode, next_run_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    project_id,
                    title,
                    prompt,
                    agent,
                    model,
                    variant,
                    json.dumps(mentions or [], ensure_ascii=False),
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
        timestamp = _now()
        with self._lock, self._connection:
            previous = self._connection.execute(
                "SELECT title, status, session_id, error FROM tasks "
                "WHERE project_id = ? AND id = ?",
                (project_id, task_id),
            ).fetchone()
            self._connection.execute(
                """
                UPDATE tasks SET status = ?, session_id = COALESCE(?, session_id),
                    error = ?, updated_at = ? WHERE project_id = ? AND id = ?
                """,
                (status, session_id, error, timestamp, project_id, task_id),
            )
            if (
                previous is not None
                and status in {"completed", "failed", "aborted"}
                and (previous["status"] != status or previous["error"] != error)
            ):
                current_session_id = session_id or previous["session_id"]
                self._record_event_locked(
                    dedupe_key=f"task:{task_id}:{current_session_id or '-'}:{status}:{timestamp}",
                    project_id=project_id,
                    kind=f"task_{status}",
                    severity="error" if status == "failed" else "info",
                    resource_title=str(previous["title"]),
                    detail=error,
                    task_id=task_id,
                    session_id=str(current_session_id) if current_session_id else None,
                    occurred_at=timestamp,
                    unread=status == "failed",
                )
        return self.get_task(project_id, task_id)

    def record_event(
        self,
        *,
        dedupe_key: str,
        project_id: str,
        kind: str,
        severity: str,
        resource_title: str,
        detail: str | None = None,
        task_id: str | None = None,
        session_id: str | None = None,
        run_id: str | None = None,
        permission_id: str | None = None,
        occurred_at: str | None = None,
        unread: bool = False,
    ) -> dict[str, Any] | None:
        with self._lock, self._connection:
            event_id = self._record_event_locked(
                dedupe_key=dedupe_key,
                project_id=project_id,
                kind=kind,
                severity=severity,
                resource_title=resource_title,
                detail=detail,
                task_id=task_id,
                session_id=session_id,
                run_id=run_id,
                permission_id=permission_id,
                occurred_at=occurred_at or _now(),
                unread=unread,
            )
            if event_id is None:
                return None
            row = self._connection.execute(
                "SELECT * FROM control_events WHERE id = ?", (event_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_events(self, *, project_id: str | None = None, limit: int = 50) -> dict[str, Any]:
        where = "WHERE events.project_id = ?" if project_id else ""
        parameters: tuple[Any, ...] = (project_id,) if project_id else ()
        with self._lock:
            rows = self._connection.execute(
                f"""
                SELECT events.*, projects.name AS project_name
                FROM control_events AS events
                JOIN projects ON projects.id = events.project_id
                {where}
                ORDER BY events.occurred_at DESC, events.id DESC LIMIT ?
                """,
                (*parameters, limit),
            ).fetchall()
            unread = self._connection.execute(
                f"SELECT COUNT(*) FROM control_events AS events {where} AND events.read_at IS NULL"
                if where
                else "SELECT COUNT(*) FROM control_events AS events WHERE events.read_at IS NULL",
                parameters,
            ).fetchone()
        return {
            "events": [dict(row) for row in rows],
            "unread": int(unread[0]) if unread else 0,
        }

    def mark_event_read(self, event_id: str) -> bool:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                "UPDATE control_events SET read_at = COALESCE(read_at, ?) WHERE id = ?",
                (_now(), event_id),
            )
        return cursor.rowcount == 1

    def mark_events_read(self, *, project_id: str | None = None) -> int:
        query = "UPDATE control_events SET read_at = ? WHERE read_at IS NULL"
        parameters: tuple[Any, ...] = (_now(),)
        if project_id:
            query += " AND project_id = ?"
            parameters += (project_id,)
        with self._lock, self._connection:
            cursor = self._connection.execute(query, parameters)
        return cursor.rowcount

    def resolve_permission_event(
        self, project_id: str, session_id: str, permission_id: str
    ) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE control_events SET read_at = COALESCE(read_at, ?)
                WHERE project_id = ? AND session_id = ? AND permission_id = ?
                """,
                (_now(), project_id, session_id, permission_id),
            )

    def _record_event_locked(
        self,
        *,
        dedupe_key: str,
        project_id: str,
        kind: str,
        severity: str,
        resource_title: str,
        detail: str | None,
        task_id: str | None,
        session_id: str | None,
        run_id: str | None = None,
        permission_id: str | None = None,
        occurred_at: str,
        unread: bool,
    ) -> str | None:
        event_id = f"evt_{uuid.uuid4().hex}"
        clean_detail = " ".join((detail or "").split())[:500] or None
        cursor = self._connection.execute(
            """
            INSERT INTO control_events (
                id, dedupe_key, project_id, task_id, session_id, run_id, permission_id,
                kind, severity, resource_title, detail, occurred_at, read_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedupe_key) DO NOTHING
            """,
            (
                event_id,
                dedupe_key[:500],
                project_id,
                task_id,
                session_id,
                run_id,
                permission_id,
                kind,
                severity,
                resource_title[:200],
                clean_detail,
                occurred_at,
                None if unread else occurred_at,
            ),
        )
        return event_id if cursor.rowcount == 1 else None

    def record_task_prompt(
        self,
        project_id: str,
        task_id: str,
        *,
        session_id: str,
        prompt: str | None,
        agent: str | None,
        model: str | None,
        variant: str | None,
        mentions: list[str],
        update_agent: bool,
        update_model: bool,
        update_variant: bool,
    ) -> dict[str, Any] | None:
        with self._lock, self._connection:
            self._connection.execute(
                """
                UPDATE tasks SET status = 'running', session_id = ?,
                    prompt = COALESCE(?, prompt),
                    agent = CASE WHEN ? THEN ? ELSE agent END,
                    model = CASE WHEN ? THEN ? ELSE model END,
                    variant = CASE WHEN ? THEN ? ELSE variant END,
                    mentions = CASE WHEN ? THEN ? ELSE mentions END,
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
                    update_variant,
                    variant,
                    prompt is not None,
                    json.dumps(mentions, ensure_ascii=False),
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
                ON CONFLICT(project_id, session_id) DO NOTHING
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
                SELECT links.session_id, tasks.id, tasks.title, tasks.status,
                    tasks.session_id AS current_session_id, tasks.error, tasks.updated_at
                FROM task_sessions AS links
                JOIN tasks ON tasks.project_id = links.project_id AND tasks.id = links.task_id
                WHERE links.project_id = ?
                """,
                (project_id,),
            ).fetchall()
            run_rows = self._connection.execute(
                """
                SELECT session_id, status, error, updated_at FROM scheduled_runs
                WHERE project_id = ? AND session_id IS NOT NULL
                ORDER BY updated_at DESC, id DESC
                """,
                (project_id,),
            ).fetchall()
        runs = {str(row["session_id"]): row for row in reversed(run_rows)}
        return {
            str(row["session_id"]): _session_task_link(row, runs.get(str(row["session_id"])))
            for row in rows
        }

    def session_task(self, project_id: str, session_id: str) -> dict[str, str] | None:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT links.session_id, tasks.id, tasks.title, tasks.status,
                    tasks.session_id AS current_session_id, tasks.error, tasks.updated_at
                FROM task_sessions AS links
                JOIN tasks ON tasks.project_id = links.project_id AND tasks.id = links.task_id
                WHERE links.project_id = ? AND links.session_id = ?
                """,
                (project_id, session_id),
            ).fetchone()
            run = self._connection.execute(
                """
                SELECT session_id, status, error, updated_at FROM scheduled_runs
                WHERE project_id = ? AND session_id = ?
                ORDER BY updated_at DESC, id DESC LIMIT 1
                """,
                (project_id, session_id),
            ).fetchone()
        return _session_task_link(row, run) if row else None

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
                    schedule_revision = schedule_revision + 1,
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
            self._cancel_unstarted_runs(project_id, task_id)
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
        prompt: str | None = None,
        mentions: list[str] | None = None,
    ) -> dict[str, Any] | None:
        with self._lock, self._connection:
            row = self._connection.execute(
                "SELECT status FROM tasks WHERE project_id = ? AND id = ?",
                (project_id, task_id),
            ).fetchone()
            if row is None:
                return None
            status = str(row["status"])
            if status not in {"queued", "dispatching", "running"}:
                if cron is not None:
                    status = "scheduled" if enabled else "paused"
                elif status in {"scheduled", "paused"}:
                    status = "completed"
            self._connection.execute(
                """
                UPDATE tasks SET cron = ?, timezone = ?, schedule_enabled = ?,
                    cron_session_mode = COALESCE(?, cron_session_mode), next_run_at = ?,
                    prompt = COALESCE(?, prompt), mentions = COALESCE(?, mentions),
                    schedule_revision = schedule_revision + 1, status = ?, updated_at = ?
                WHERE project_id = ? AND id = ?
                """,
                (
                    cron,
                    timezone,
                    int(enabled and cron is not None),
                    cron_session_mode,
                    next_run_at,
                    prompt,
                    json.dumps(mentions, ensure_ascii=False) if mentions is not None else None,
                    status,
                    _now(),
                    project_id,
                    task_id,
                ),
            )
            self._cancel_unstarted_runs(project_id, task_id)
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

    def materialize_scheduled_run(
        self,
        project_id: str,
        task_id: str,
        *,
        expected_run_at: str,
        next_run_at: str,
        created_at: str,
    ) -> dict[str, Any] | None:
        run_id = f"run_{uuid.uuid4().hex}"
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                UPDATE tasks SET next_run_at = ?, updated_at = ?
                WHERE project_id = ? AND id = ? AND schedule_enabled = 1
                    AND next_run_at = ?
                """,
                (next_run_at, created_at, project_id, task_id, expected_run_at),
            )
            if cursor.rowcount != 1:
                return None
            task = self._connection.execute(
                "SELECT schedule_revision FROM tasks WHERE project_id = ? AND id = ?",
                (project_id, task_id),
            ).fetchone()
            assert task is not None
            self._connection.execute(
                """
                INSERT INTO scheduled_runs (
                    id, project_id, task_id, schedule_revision, scheduled_for, status,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    run_id,
                    project_id,
                    task_id,
                    task["schedule_revision"],
                    expected_run_at,
                    created_at,
                    created_at,
                ),
            )
        return self.get_scheduled_run(run_id)

    def skip_overdue_scheduled_run(
        self,
        project_id: str,
        task_id: str,
        *,
        expected_run_at: str,
        next_run_at: str,
        created_at: str,
        reason: str,
    ) -> dict[str, Any] | None:
        run = self.materialize_scheduled_run(
            project_id,
            task_id,
            expected_run_at=expected_run_at,
            next_run_at=next_run_at,
            created_at=created_at,
        )
        if run is None:
            return None
        self.finish_scheduled_run(str(run["id"]), "skipped", reason)
        return self.get_scheduled_run(str(run["id"]))

    def recover_interrupted_scheduled_runs(self) -> int:
        timestamp = _now()
        with self._lock, self._connection:
            creating = self._connection.execute(
                """
                SELECT id FROM scheduled_runs
                WHERE status = 'creating_session' AND session_id IS NULL
                """
            ).fetchall()
            self._connection.execute(
                """
                UPDATE scheduled_runs SET status = 'cancelled', lease_token = NULL,
                    lease_expires_at = NULL, finished_at = ?, updated_at = ?
                WHERE status IN ('pending', 'claimed') AND session_id IS NULL
                    AND NOT EXISTS (
                        SELECT 1 FROM tasks
                        WHERE tasks.project_id = scheduled_runs.project_id
                            AND tasks.id = scheduled_runs.task_id
                            AND tasks.schedule_enabled = 1
                            AND tasks.schedule_revision = scheduled_runs.schedule_revision
                    )
                """,
                (timestamp, timestamp),
            )
            cursor = self._connection.execute(
                """
                UPDATE scheduled_runs SET status = 'pending', lease_token = NULL,
                    lease_expires_at = NULL, updated_at = ?
                WHERE status = 'claimed' AND session_id IS NULL
                """,
                (timestamp,),
            )
        for row in creating:
            self.finish_scheduled_run(
                str(row["id"]),
                "failed",
                "Control restarted while creating the OpenCode session; retry suppressed",
            )
        return cursor.rowcount + len(creating)

    def mark_scheduled_run_creating(self, run_id: str, lease_token: str) -> bool:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                UPDATE scheduled_runs SET status = 'creating_session', updated_at = ?
                WHERE id = ? AND status = 'claimed' AND lease_token = ? AND session_id IS NULL
                """,
                (_now(), run_id, lease_token),
            )
        return cursor.rowcount == 1

    def claim_scheduled_run(
        self, run_id: str, *, lease_token: str, lease_expires_at: str, claimed_at: str
    ) -> dict[str, Any] | None:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                """
                UPDATE scheduled_runs SET status = 'claimed', attempt_count = attempt_count + 1,
                    lease_token = ?, lease_expires_at = ?, updated_at = ?
                WHERE id = ? AND (
                    status = 'pending'
                    OR (status = 'claimed' AND session_id IS NULL AND lease_expires_at < ?)
                ) AND EXISTS (
                    SELECT 1 FROM tasks
                    WHERE tasks.project_id = scheduled_runs.project_id
                        AND tasks.id = scheduled_runs.task_id
                        AND tasks.schedule_enabled = 1
                        AND tasks.schedule_revision = scheduled_runs.schedule_revision
                )
                """,
                (lease_token, lease_expires_at, claimed_at, run_id, claimed_at),
            )
        return self.get_scheduled_run(run_id) if cursor.rowcount == 1 else None

    def claimable_scheduled_runs(self, now: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT * FROM scheduled_runs
                WHERE status = 'pending'
                    OR (status = 'claimed' AND session_id IS NULL AND lease_expires_at < ?)
                ORDER BY scheduled_for, created_at
                """,
                (now,),
            ).fetchall()
        return [dict(row) for row in rows]

    def active_scheduled_runs(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT * FROM scheduled_runs
                WHERE status IN ('creating_session', 'session_created', 'running', 'ambiguous')
                ORDER BY created_at
                """
            ).fetchall()
        return [dict(row) for row in rows]

    def has_active_scheduled_run(self, project_id: str, task_id: str) -> bool:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT 1 FROM scheduled_runs
                WHERE project_id = ? AND task_id = ?
                    AND status IN (
                        'claimed', 'creating_session', 'session_created', 'running', 'ambiguous'
                    )
                LIMIT 1
                """,
                (project_id, task_id),
            ).fetchone()
        return row is not None

    def active_scheduled_run_for_task(
        self,
        project_id: str,
        task_id: str,
        *,
        session_id: str | None = None,
        exclude_run_id: str | None = None,
    ) -> dict[str, Any] | None:
        query = """
            SELECT * FROM scheduled_runs
            WHERE project_id = ? AND task_id = ?
                AND status IN (
                    'claimed', 'creating_session', 'session_created', 'running', 'ambiguous'
                )
        """
        parameters: list[Any] = [project_id, task_id]
        if session_id is not None:
            query += " AND session_id = ?"
            parameters.append(session_id)
        if exclude_run_id is not None:
            query += " AND id != ?"
            parameters.append(exclude_run_id)
        query += " ORDER BY created_at DESC LIMIT 1"
        with self._lock:
            row = self._connection.execute(query, parameters).fetchone()
        return dict(row) if row else None

    def get_scheduled_run(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM scheduled_runs WHERE id = ?", (run_id,)
            ).fetchone()
        return dict(row) if row else None

    def reopen_failed_scheduled_run(self, project_id: str, session_id: str) -> str | None:
        timestamp = _now()
        with self._lock, self._connection:
            run = self._connection.execute(
                """
                SELECT * FROM scheduled_runs
                WHERE project_id = ? AND session_id = ? AND status = 'failed'
                ORDER BY updated_at DESC, id DESC LIMIT 1
                """,
                (project_id, session_id),
            ).fetchone()
            if run is None:
                return None
            run_id = str(run["id"])
            self._connection.execute(
                """
                UPDATE scheduled_runs SET status = 'running', error = NULL,
                    lease_token = NULL, lease_expires_at = NULL, finished_at = NULL,
                    updated_at = ? WHERE id = ?
                """,
                (timestamp, run_id),
            )
            self._connection.execute(
                """
                UPDATE tasks SET status = 'running', error = NULL, updated_at = ?
                WHERE project_id = ? AND id = ?
                """,
                (timestamp, project_id, run["task_id"]),
            )
            self._connection.execute(
                """
                UPDATE control_events SET read_at = COALESCE(read_at, ?)
                WHERE run_id = ? AND kind = 'scheduled_run_failed'
                """,
                (timestamp, run_id),
            )
        return run_id

    def list_scheduled_runs(
        self, project_id: str, task_id: str, *, limit: int = 50
    ) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT * FROM scheduled_runs
                WHERE project_id = ? AND task_id = ?
                ORDER BY scheduled_for DESC LIMIT ?
                """,
                (project_id, task_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]

    def attach_scheduled_run_session(self, run_id: str, lease_token: str, session_id: str) -> bool:
        timestamp = _now()
        with self._lock, self._connection:
            run = self._connection.execute(
                """
                SELECT * FROM scheduled_runs
                WHERE id = ? AND status IN ('claimed', 'creating_session') AND lease_token = ?
                """,
                (run_id, lease_token),
            ).fetchone()
            if run is None:
                return False
            self._connection.execute(
                """
                INSERT INTO task_sessions (project_id, task_id, session_id, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(project_id, session_id) DO NOTHING
                """,
                (run["project_id"], run["task_id"], session_id, timestamp),
            )
            self._connection.execute(
                """
                UPDATE scheduled_runs SET status = 'session_created', session_id = ?,
                    updated_at = ? WHERE id = ? AND lease_token = ?
                """,
                (session_id, timestamp, run_id, lease_token),
            )
            self._connection.execute(
                """
                UPDATE tasks SET status = 'dispatching', session_id = ?, error = NULL,
                    updated_at = ? WHERE project_id = ? AND id = ?
                """,
                (session_id, timestamp, run["project_id"], run["task_id"]),
            )
        return True

    def mark_scheduled_run_running(self, run_id: str, lease_token: str) -> bool:
        timestamp = _now()
        with self._lock, self._connection:
            run = self._connection.execute(
                "SELECT * FROM scheduled_runs WHERE id = ? AND lease_token = ?",
                (run_id, lease_token),
            ).fetchone()
            if run is None or run["status"] not in {"session_created", "ambiguous"}:
                return False
            self._connection.execute(
                """
                UPDATE scheduled_runs SET status = 'running', lease_token = NULL,
                    lease_expires_at = NULL, started_at = COALESCE(started_at, ?), updated_at = ?
                WHERE id = ?
                """,
                (timestamp, timestamp, run_id),
            )
            self._connection.execute(
                """
                UPDATE tasks SET status = 'running', last_run_at = ?, error = NULL,
                    updated_at = ? WHERE project_id = ? AND id = ?
                """,
                (timestamp, timestamp, run["project_id"], run["task_id"]),
            )
        return True

    def reconcile_scheduled_run_running(self, run_id: str) -> bool:
        timestamp = _now()
        with self._lock, self._connection:
            run = self._connection.execute(
                """
                SELECT * FROM scheduled_runs
                WHERE id = ? AND status IN ('session_created', 'ambiguous')
                """,
                (run_id,),
            ).fetchone()
            if run is None:
                return False
            self._connection.execute(
                """
                UPDATE scheduled_runs SET status = 'running', error = NULL,
                    lease_token = NULL, lease_expires_at = NULL,
                    started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?
                """,
                (timestamp, timestamp, run_id),
            )
            self._connection.execute(
                """
                UPDATE tasks SET status = 'running', last_run_at = ?, error = NULL,
                    updated_at = ? WHERE project_id = ? AND id = ?
                """,
                (timestamp, timestamp, run["project_id"], run["task_id"]),
            )
        return True

    def mark_scheduled_run_ambiguous(self, run_id: str, lease_token: str, error: str) -> bool:
        timestamp = _now()
        with self._lock, self._connection:
            run = self._connection.execute(
                "SELECT * FROM scheduled_runs WHERE id = ? AND lease_token = ?",
                (run_id, lease_token),
            ).fetchone()
            if run is None:
                return False
            self._connection.execute(
                """
                UPDATE scheduled_runs SET status = 'ambiguous', error = ?, lease_token = NULL,
                    lease_expires_at = NULL, updated_at = ? WHERE id = ?
                """,
                (error, timestamp, run_id),
            )
            self._connection.execute(
                """
                UPDATE tasks SET status = 'dispatching', error = ?, updated_at = ?
                WHERE project_id = ? AND id = ?
                """,
                (error, timestamp, run["project_id"], run["task_id"]),
            )
        return True

    def finish_scheduled_run(self, run_id: str, status: str, error: str | None = None) -> bool:
        if status not in {"completed", "failed", "skipped", "cancelled", "aborted"}:
            raise ValueError(f"invalid scheduled run status: {status}")
        timestamp = _now()
        with self._lock, self._connection:
            run = self._connection.execute(
                "SELECT * FROM scheduled_runs WHERE id = ?", (run_id,)
            ).fetchone()
            if run is None or run["status"] in {
                "completed",
                "failed",
                "skipped",
                "cancelled",
                "aborted",
            }:
                return False
            self._connection.execute(
                """
                UPDATE scheduled_runs SET status = ?, error = ?, lease_token = NULL,
                    lease_expires_at = NULL, finished_at = ?, updated_at = ? WHERE id = ?
                """,
                (status, error, timestamp, timestamp, run_id),
            )
            other_active = self._connection.execute(
                """
                SELECT 1 FROM scheduled_runs
                WHERE project_id = ? AND task_id = ? AND id != ?
                    AND status IN (
                        'claimed', 'creating_session', 'session_created', 'running', 'ambiguous'
                    )
                LIMIT 1
                """,
                (run["project_id"], run["task_id"], run_id),
            ).fetchone()
            if other_active is None and status != "skipped":
                self._connection.execute(
                    """
                    UPDATE tasks SET status = CASE WHEN schedule_enabled = 1
                        THEN 'scheduled' ELSE 'paused' END,
                        error = ?, updated_at = ? WHERE project_id = ? AND id = ?
                    """,
                    (error, timestamp, run["project_id"], run["task_id"]),
                )
            task = self._connection.execute(
                "SELECT title FROM tasks WHERE project_id = ? AND id = ?",
                (run["project_id"], run["task_id"]),
            ).fetchone()
            if task is not None:
                self._record_event_locked(
                    dedupe_key=f"run:{run_id}:{status}",
                    project_id=str(run["project_id"]),
                    kind=f"scheduled_run_{status}",
                    severity="error" if status == "failed" else "info",
                    resource_title=str(task["title"]),
                    detail=error,
                    task_id=str(run["task_id"]),
                    session_id=str(run["session_id"]) if run["session_id"] else None,
                    run_id=run_id,
                    occurred_at=timestamp,
                    unread=status == "failed",
                )
        return True

    def _cancel_unstarted_runs(self, project_id: str, task_id: str) -> None:
        timestamp = _now()
        self._connection.execute(
            """
            UPDATE scheduled_runs SET status = 'cancelled', lease_token = NULL,
                lease_expires_at = NULL, finished_at = ?, updated_at = ?
            WHERE project_id = ? AND task_id = ?
                AND status IN ('pending', 'claimed') AND session_id IS NULL
            """,
            (timestamp, timestamp, project_id, task_id),
        )

    def delete_task(self, project_id: str, task_id: str) -> bool:
        with self._lock, self._connection:
            cursor = self._connection.execute(
                "DELETE FROM tasks WHERE project_id = ? AND id = ?",
                (project_id, task_id),
            )
        return cursor.rowcount > 0

    def _task_view(self, row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        try:
            mentions = json.loads(str(result.get("mentions") or "[]"))
        except json.JSONDecodeError:
            mentions = []
        result["mentions"] = [item for item in mentions if isinstance(item, str)]
        result["session_ids"] = self.task_session_ids(str(result["project_id"]), str(result["id"]))
        with self._lock:
            latest_run = self._connection.execute(
                """
                SELECT id, scheduled_for, status, attempt_count, session_id, error,
                    started_at, finished_at
                FROM scheduled_runs WHERE project_id = ? AND task_id = ?
                ORDER BY scheduled_for DESC LIMIT 1
                """,
                (result["project_id"], result["id"]),
            ).fetchone()
        result["last_scheduled_run"] = dict(latest_run) if latest_run else None
        return result

    def export_state(self) -> str:
        return json.dumps({"projects": self.list_projects()}, ensure_ascii=False)
