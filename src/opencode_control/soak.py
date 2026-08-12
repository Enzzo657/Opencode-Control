from __future__ import annotations

import sqlite3
import tempfile
import time
from contextlib import suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from opencode_control.store import ControlStore


def run_soak(
    *,
    cycles: int,
    data_dir: Path | None = None,
    interval_seconds: float = 0,
) -> dict[str, Any]:
    if cycles < 1:
        raise ValueError("cycles must be greater than zero")
    started = time.monotonic()
    temporary: tempfile.TemporaryDirectory[str] | None = None
    if data_dir is None:
        temporary = tempfile.TemporaryDirectory(prefix="opencode-control-soak-")
        data_dir = Path(temporary.name)
    data_dir.mkdir(parents=True, exist_ok=True)
    project_root = data_dir / "workspace"
    project_root.mkdir(exist_ok=True)
    store = ControlStore(data_dir)
    project = store.create_project(name="Soak Project", root=project_root, endpoint=None)
    project_id = str(project["id"])
    base = datetime(2026, 1, 1, tzinfo=UTC)
    task = store.create_task(
        project_id,
        title="Soak Task",
        prompt="Exercise scheduler persistence",
        agent=None,
        model=None,
        cron="* * * * *",
        timezone="UTC",
        next_run_at=base.isoformat(),
    )
    task_id = str(task["id"])
    expected = base
    outcomes = {"completed": 0, "failed": 0, "skipped": 0, "crash_recovered": 0}
    try:
        for index in range(cycles):
            next_run = expected + timedelta(minutes=1)
            if index % 11 == 3:
                run = store.skip_overdue_scheduled_run(
                    project_id,
                    task_id,
                    expected_run_at=expected.isoformat(),
                    next_run_at=next_run.isoformat(),
                    created_at=(expected + timedelta(minutes=5)).isoformat(),
                    reason="Control was offline when this run was scheduled",
                )
                assert run is not None and run["status"] == "skipped"
                outcomes["skipped"] += 1
            else:
                run = store.materialize_scheduled_run(
                    project_id,
                    task_id,
                    expected_run_at=expected.isoformat(),
                    next_run_at=next_run.isoformat(),
                    created_at=(expected + timedelta(seconds=1)).isoformat(),
                )
                assert run is not None
                run_id = str(run["id"])
                lease = f"lease-{index}"
                claimed = store.claim_scheduled_run(
                    run_id,
                    lease_token=lease,
                    lease_expires_at=(expected + timedelta(minutes=2)).isoformat(),
                    claimed_at=(expected + timedelta(seconds=2)).isoformat(),
                )
                assert claimed is not None
                if index % 13 == 5:
                    assert store.mark_scheduled_run_creating(run_id, lease)
                    store.close()
                    store = ControlStore(data_dir)
                    assert store.recover_interrupted_scheduled_runs() == 1
                    recovered = store.get_scheduled_run(run_id)
                    assert recovered is not None and recovered["status"] == "failed"
                    outcomes["crash_recovered"] += 1
                elif index % 7 == 2:
                    assert store.finish_scheduled_run(run_id, "failed", "injected failure")
                    assert not store.finish_scheduled_run(run_id, "failed", "duplicate")
                    outcomes["failed"] += 1
                else:
                    session_id = f"ses_soak_{index}"
                    assert store.attach_scheduled_run_session(run_id, lease, session_id)
                    assert store.mark_scheduled_run_running(run_id, lease)
                    assert store.finish_scheduled_run(run_id, "completed")
                    assert not store.finish_scheduled_run(run_id, "completed")
                    outcomes["completed"] += 1
            expected = next_run
            if index and index % 25 == 0:
                store.close()
                store = ControlStore(data_dir)
            if interval_seconds > 0:
                time.sleep(interval_seconds)

        runs = store.list_scheduled_runs(project_id, task_id, limit=cycles + 10)
        events = store.list_events(project_id=project_id, limit=min(100, cycles + 10))
        active = store.active_scheduled_runs()
        store.close()
        connection = sqlite3.connect(data_dir / "control.sqlite")
        try:
            integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
            event_row = connection.execute("SELECT COUNT(*) FROM control_events").fetchone()
            event_count = int(event_row[0])
        finally:
            connection.close()
        if integrity != "ok" or active or len(runs) != cycles or event_count != cycles:
            raise RuntimeError("soak invariants failed")
        return {
            "ok": True,
            "cycles": cycles,
            "duration_seconds": round(time.monotonic() - started, 3),
            "integrity": integrity,
            "active_runs": len(active),
            "events": event_count,
            "unread": events["unread"],
            "outcomes": outcomes,
            "data_dir": str(data_dir),
            "temporary": temporary is not None,
        }
    finally:
        with suppress(sqlite3.Error):
            store.close()
        if temporary is not None:
            temporary.cleanup()
