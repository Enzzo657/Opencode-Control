from __future__ import annotations

import os
import sqlite3
from pathlib import Path

from opencode_control.store import ControlStore


def test_existing_project_identity_is_migrated_without_recreating_project(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "data"
    root = tmp_path / "project"
    root.mkdir()
    store = ControlStore(data_dir)
    project = store.create_project(name="Existing", root=root, endpoint=None)
    store.close()
    connection = sqlite3.connect(data_dir / "control.sqlite")
    with connection:
        connection.execute("ALTER TABLE projects DROP COLUMN root_birthtime_ns")
        connection.execute(
            "UPDATE projects SET root_device = ? WHERE id = ?",
            (root.stat().st_dev + 1, project["id"]),
        )
    connection.close()

    migrated = ControlStore(data_dir)
    projects = migrated.list_projects()

    assert len(projects) == 1
    assert projects[0]["id"] == project["id"]
    assert projects[0]["root_device"] == os.stat(root).st_dev
    migrated.close()


def test_removed_task_session_is_not_restored_on_restart(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    root = tmp_path / "project"
    root.mkdir()
    store = ControlStore(data_dir)
    project = store.create_project(name="Project", root=root, endpoint=None)
    project_id = str(project["id"])
    task = store.create_task(
        project_id,
        title="Task",
        prompt="Work",
        agent=None,
        model=None,
    )
    task_id = str(task["id"])
    store.add_task_session(project_id, task_id, "ses_deleted")
    store.update_task(
        project_id, task_id, status="failed", session_id="ses_deleted"
    )
    store.remove_task_session(project_id, "ses_deleted")
    store.close()

    reopened = ControlStore(data_dir)
    assert reopened.task_session_ids(project_id, task_id) == []
    reopened.close()


def _scheduled_task(store: ControlStore, tmp_path: Path) -> tuple[str, str]:
    root = tmp_path / "project"
    root.mkdir(exist_ok=True)
    project = store.create_project(name="Scheduled", root=root, endpoint=None)
    task = store.create_task(
        str(project["id"]),
        title="Daily check",
        prompt="Check the project",
        agent=None,
        model=None,
        cron="0 9 * * *",
        timezone="UTC",
        next_run_at="2026-07-27T09:00:00+00:00",
    )
    return str(project["id"]), str(task["id"])


def test_materializing_run_atomically_advances_schedule(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    project_id, task_id = _scheduled_task(store, tmp_path)

    run = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:01+00:00",
    )
    duplicate = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:02+00:00",
    )

    assert run is not None
    assert run["status"] == "pending"
    assert duplicate is None
    assert store.get_task(project_id, task_id)["next_run_at"] == "2026-07-28T09:00:00+00:00"
    assert len(store.list_scheduled_runs(project_id, task_id)) == 1
    store.close()


def test_overdue_run_is_recorded_as_skipped_and_schedule_advances(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    project_id, task_id = _scheduled_task(store, tmp_path)

    run = store.skip_overdue_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T12:00:00+00:00",
        reason="Control was offline when this run was scheduled",
    )
    duplicate = store.skip_overdue_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T12:00:01+00:00",
        reason="Control was offline when this run was scheduled",
    )

    assert run is not None
    assert run["status"] == "skipped"
    assert duplicate is None
    assert store.get_task(project_id, task_id)["next_run_at"] == "2026-07-28T09:00:00+00:00"
    events = store.list_events(project_id=project_id)
    assert events["unread"] == 0
    assert len(events["events"]) == 1
    assert events["events"][0]["kind"] == "scheduled_run_skipped"
    store.close()


def test_only_one_scheduler_can_claim_and_update_a_run(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    first = ControlStore(data_dir)
    project_id, task_id = _scheduled_task(first, tmp_path)
    run = first.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:01+00:00",
    )
    assert run is not None
    second = ControlStore(data_dir)

    claimed = first.claim_scheduled_run(
        str(run["id"]),
        lease_token="owner-one",
        lease_expires_at="2026-07-27T09:02:00+00:00",
        claimed_at="2026-07-27T09:00:02+00:00",
    )
    rejected = second.claim_scheduled_run(
        str(run["id"]),
        lease_token="owner-two",
        lease_expires_at="2026-07-27T09:02:00+00:00",
        claimed_at="2026-07-27T09:00:02+00:00",
    )

    assert claimed is not None
    assert rejected is None
    assert not second.attach_scheduled_run_session(str(run["id"]), "owner-two", "ses_wrong")
    assert first.attach_scheduled_run_session(str(run["id"]), "owner-one", "ses_run")
    assert not second.mark_scheduled_run_running(str(run["id"]), "owner-two")
    assert first.mark_scheduled_run_running(str(run["id"]), "owner-one")
    assert second.get_scheduled_run(str(run["id"]))["status"] == "running"
    second.close()
    first.close()


def test_restart_recovers_claim_before_external_side_effect(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    store = ControlStore(data_dir)
    project_id, task_id = _scheduled_task(store, tmp_path)
    run = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:01+00:00",
    )
    assert run is not None
    assert store.claim_scheduled_run(
        str(run["id"]),
        lease_token="crashed-owner",
        lease_expires_at="2026-07-27T09:02:00+00:00",
        claimed_at="2026-07-27T09:00:02+00:00",
    )
    store.close()

    restarted = ControlStore(data_dir)
    assert restarted.recover_interrupted_scheduled_runs() == 1
    recovered = restarted.claim_scheduled_run(
        str(run["id"]),
        lease_token="new-owner",
        lease_expires_at="2026-07-27T09:03:00+00:00",
        claimed_at="2026-07-27T09:01:00+00:00",
    )

    assert recovered is not None
    assert recovered["attempt_count"] == 2
    restarted.close()


def test_restart_does_not_retry_after_session_creation_started(tmp_path: Path) -> None:
    data_dir = tmp_path / "data"
    store = ControlStore(data_dir)
    project_id, task_id = _scheduled_task(store, tmp_path)
    run = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:01+00:00",
    )
    assert run is not None
    assert store.claim_scheduled_run(
        str(run["id"]),
        lease_token="crashed-owner",
        lease_expires_at="2026-07-27T09:02:00+00:00",
        claimed_at="2026-07-27T09:00:02+00:00",
    )
    assert store.mark_scheduled_run_creating(str(run["id"]), "crashed-owner")
    store.close()

    restarted = ControlStore(data_dir)
    assert restarted.recover_interrupted_scheduled_runs() == 1
    recovered = restarted.get_scheduled_run(str(run["id"]))

    assert recovered is not None
    assert recovered["status"] == "failed"
    assert "retry suppressed" in recovered["error"]
    assert restarted.claimable_scheduled_runs("2026-07-27T09:03:00+00:00") == []
    events = restarted.list_events(project_id=project_id)
    assert events["unread"] == 1
    assert events["events"][0]["kind"] == "scheduled_run_failed"
    restarted.close()


def test_schedule_change_cancels_unstarted_run_and_fences_worker(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    project_id, task_id = _scheduled_task(store, tmp_path)
    run = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:01+00:00",
    )
    assert run is not None
    claimed = store.claim_scheduled_run(
        str(run["id"]),
        lease_token="old-schedule",
        lease_expires_at="2026-07-27T09:02:00+00:00",
        claimed_at="2026-07-27T09:00:02+00:00",
    )
    assert claimed is not None

    store.set_schedule_enabled(project_id, task_id, enabled=False, next_run_at=None)

    assert store.get_scheduled_run(str(run["id"]))["status"] == "cancelled"
    assert not store.attach_scheduled_run_session(str(run["id"]), "old-schedule", "ses_late")
    assert store.task_session_ids(project_id, task_id) == []
    store.close()


def test_ambiguous_dispatch_is_preserved_for_reconciliation(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    project_id, task_id = _scheduled_task(store, tmp_path)
    run = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:01+00:00",
    )
    assert run is not None
    store.claim_scheduled_run(
        str(run["id"]),
        lease_token="owner",
        lease_expires_at="2026-07-27T09:02:00+00:00",
        claimed_at="2026-07-27T09:00:02+00:00",
    )
    store.attach_scheduled_run_session(str(run["id"]), "owner", "ses_uncertain")

    assert store.mark_scheduled_run_ambiguous(str(run["id"]), "owner", "prompt response was lost")
    assert store.get_scheduled_run(str(run["id"]))["status"] == "ambiguous"
    assert store.get_task(project_id, task_id)["status"] == "dispatching"

    assert store.reconcile_scheduled_run_running(str(run["id"]))
    assert store.get_scheduled_run(str(run["id"]))["status"] == "running"
    assert store.get_task(project_id, task_id)["status"] == "running"
    store.close()


def test_search_index_replaces_messages_and_treats_wildcards_literally(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    root = tmp_path / "project"
    root.mkdir()
    project = store.create_project(name="Search", root=root, endpoint=None)
    project_id = str(project["id"])
    store.replace_search_session(
        project_id,
        session_id="ses_one",
        title="Deploy 100% safely",
        parent_id=None,
        updated_at=10,
        messages=[
            {
                "id": "msg_one",
                "role": "user",
                "created_at": 11,
                "content": "Keep value_name unchanged",
            }
        ],
    )

    assert [item["kind"] for item in store.search_history("100%", [project_id], limit=10)] == [
        "session"
    ]
    message_matches = store.search_history("value_", [project_id], limit=10)
    assert [item["message_id"] for item in message_matches] == ["msg_one"]
    assert store.search_history("valueX", [project_id], limit=10) == []

    store.replace_search_session(
        project_id,
        session_id="ses_one",
        title="Deploy safely",
        parent_id=None,
        updated_at=12,
        messages=[],
    )
    assert store.search_history("value_name", [project_id], limit=10) == []
    store.prune_search_sessions(project_id, set())
    assert store.search_session_versions(project_id) == {}
    store.close()


def test_search_index_ranks_titles_and_paginates_stably(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    root = tmp_path / "project"
    root.mkdir()
    project_id = str(store.create_project(name="Search", root=root, endpoint=None)["id"])
    for session_id, title, updated_at in [
        ("ses_message", "Other", 30),
        ("ses_contains", "Using Search today", 20),
        ("ses_prefix", "Search architecture", 10),
        ("ses_exact", "Search", 1),
    ]:
        store.replace_search_session(
            project_id,
            session_id=session_id,
            title=title,
            parent_id=None,
            updated_at=updated_at,
            messages=[
                {
                    "id": f"msg_{session_id}",
                    "role": "assistant",
                    "created_at": updated_at,
                    "content": "Search appears in this message",
                }
            ]
            if session_id == "ses_message"
            else [],
        )

    first_page = store.search_history("search", [project_id], limit=2)
    second_page = store.search_history("search", [project_id], limit=2, offset=2)

    assert [item["session_id"] for item in first_page] == ["ses_exact", "ses_prefix"]
    assert [item["session_id"] for item in second_page] == ["ses_contains", "ses_message"]
    store.close()


def test_artifact_index_tracks_message_sources(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    root = tmp_path / "project"
    root.mkdir()
    project_id = str(store.create_project(name="Artifacts", root=root, endpoint=None)["id"])
    store.replace_search_session(
        project_id,
        session_id="ses_artifacts",
        title="Generate images",
        parent_id=None,
        updated_at=10,
        messages=[
            {
                "id": "msg_artifacts",
                "role": "assistant",
                "created_at": 11,
                "content": "Images",
                "artifacts": ["one.png", "nested/two.webp"],
            }
        ],
    )

    artifacts = store.list_artifacts([project_id])
    assert [item["artifact_path"] for item in artifacts] == ["nested/two.webp", "one.png"]
    assert {item["message_id"] for item in artifacts} == {"msg_artifacts"}
    store.prune_search_sessions(project_id, set())
    assert store.list_artifacts([project_id]) == []
    store.close()


def test_overlap_skip_does_not_overwrite_active_task_status(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    project_id, task_id = _scheduled_task(store, tmp_path)
    run = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:01+00:00",
    )
    assert run is not None
    store.claim_scheduled_run(
        str(run["id"]),
        lease_token="owner",
        lease_expires_at="2026-07-27T09:02:00+00:00",
        claimed_at="2026-07-27T09:00:02+00:00",
    )
    store.update_task(project_id, task_id, status="running", session_id="ses_previous")

    assert store.finish_scheduled_run(str(run["id"]), "skipped", "overlap")
    assert store.get_scheduled_run(str(run["id"]))["status"] == "skipped"
    assert store.get_task(project_id, task_id)["status"] == "running"
    store.close()


def test_task_session_statuses_are_scoped_to_each_execution(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    project_id, task_id = _scheduled_task(store, tmp_path)

    for day, session_id, outcome in [
        (27, "ses_completed", "completed"),
        (28, "ses_failed", "failed"),
    ]:
        run = store.materialize_scheduled_run(
            project_id,
            task_id,
            expected_run_at=f"2026-07-{day:02d}T09:00:00+00:00",
            next_run_at=f"2026-07-{day + 1:02d}T09:00:00+00:00",
            created_at=f"2026-07-{day:02d}T09:00:01+00:00",
        )
        assert run is not None
        token = f"owner-{day}"
        assert store.claim_scheduled_run(
            str(run["id"]),
            lease_token=token,
            lease_expires_at=f"2026-07-{day:02d}T09:02:00+00:00",
            claimed_at=f"2026-07-{day:02d}T09:00:02+00:00",
        )
        assert store.attach_scheduled_run_session(str(run["id"]), token, session_id)
        assert store.mark_scheduled_run_running(str(run["id"]), token)
        assert store.finish_scheduled_run(
            str(run["id"]),
            outcome,
            "run failed" if outcome == "failed" else None,
        )
        assert not store.finish_scheduled_run(str(run["id"]), outcome)

    links = store.project_session_tasks(project_id)
    assert links["ses_completed"]["session_status"] == "completed"
    assert "session_error" not in links["ses_completed"]
    assert links["ses_failed"]["session_status"] == "failed"
    assert links["ses_failed"]["session_error"] == "run failed"
    assert links["ses_failed"]["session_updated_at"]
    events = store.list_events(project_id=project_id)["events"]
    assert len([item for item in events if item["kind"] == "scheduled_run_completed"]) == 1
    assert len([item for item in events if item["kind"] == "scheduled_run_failed"]) == 1

    store.add_task_session(project_id, task_id, "ses_manual")
    store.update_task(
        project_id,
        task_id,
        status="failed",
        session_id="ses_manual",
        error="server unavailable",
    )
    links = store.project_session_tasks(project_id)
    assert links["ses_manual"]["session_status"] == "failed"
    assert links["ses_manual"]["session_error"] == "server unavailable"
    assert links["ses_completed"]["session_status"] == "completed"
    assert store.session_task(project_id, "ses_failed") == links["ses_failed"]
    store.close()


def test_failed_scheduled_run_can_complete_after_manual_continuation(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    project_id, task_id = _scheduled_task(store, tmp_path)
    run = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:01+00:00",
    )
    assert run is not None
    run_id = str(run["id"])
    assert store.claim_scheduled_run(
        run_id,
        lease_token="owner",
        lease_expires_at="2026-07-27T09:02:00+00:00",
        claimed_at="2026-07-27T09:00:02+00:00",
    )
    assert store.attach_scheduled_run_session(run_id, "owner", "ses_recovered")
    assert store.mark_scheduled_run_running(run_id, "owner")
    assert store.finish_scheduled_run(run_id, "failed", "server unavailable")

    assert store.complete_interrupted_scheduled_run(project_id, "ses_recovered") == run_id
    assert store.get_scheduled_run(run_id)["status"] == "completed"
    assert store.complete_interrupted_scheduled_run(project_id, "ses_recovered") is None

    recovered = store.session_task(project_id, "ses_recovered")
    assert recovered is not None
    assert recovered["session_status"] == "completed"
    assert "session_error" not in recovered
    failed_events = [
        item
        for item in store.list_events(project_id=project_id)["events"]
        if item["kind"] == "scheduled_run_failed"
    ]
    assert len(failed_events) == 1
    assert failed_events[0]["read_at"] is not None
    store.close()


def test_stalled_run_does_not_block_next_schedule_and_can_complete_late(
    tmp_path: Path,
) -> None:
    store = ControlStore(tmp_path / "data")
    project_id, task_id = _scheduled_task(store, tmp_path)
    first = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-27T09:00:00+00:00",
        next_run_at="2026-07-28T09:00:00+00:00",
        created_at="2026-07-27T09:00:01+00:00",
    )
    assert first is not None
    first_id = str(first["id"])
    assert store.claim_scheduled_run(
        first_id,
        lease_token="owner",
        lease_expires_at="2026-07-27T09:02:00+00:00",
        claimed_at="2026-07-27T09:00:02+00:00",
    )
    assert store.attach_scheduled_run_session(first_id, "owner", "ses_stalled")
    assert store.mark_scheduled_run_running(first_id, "owner")
    assert store.finish_scheduled_run(first_id, "stalled", "no message progress")
    assert not store.has_active_scheduled_run(project_id, task_id)

    second = store.materialize_scheduled_run(
        project_id,
        task_id,
        expected_run_at="2026-07-28T09:00:00+00:00",
        next_run_at="2026-07-29T09:00:00+00:00",
        created_at="2026-07-28T09:00:01+00:00",
    )
    assert second is not None
    assert second["status"] == "pending"

    assert store.complete_interrupted_scheduled_run(project_id, "ses_stalled") == first_id
    assert store.get_scheduled_run(first_id)["status"] == "completed"
    stalled_events = [
        item
        for item in store.list_events(project_id=project_id)["events"]
        if item["kind"] == "scheduled_run_stalled"
    ]
    assert len(stalled_events) == 1
    assert stalled_events[0]["read_at"] is not None
    store.close()


def test_events_track_task_transitions_and_read_state(tmp_path: Path) -> None:
    store = ControlStore(tmp_path / "data")
    root = tmp_path / "project"
    root.mkdir()
    project = store.create_project(name="Events", root=root, endpoint=None)
    project_id = str(project["id"])
    task = store.create_task(
        project_id,
        title="Deploy",
        prompt="Deploy safely",
        agent="build",
        model=None,
    )
    task_id = str(task["id"])
    store.update_task(project_id, task_id, status="running", session_id="ses_deploy")
    store.update_task(
        project_id,
        task_id,
        status="failed",
        session_id="ses_deploy",
        error="server unavailable",
    )
    store.update_task(
        project_id,
        task_id,
        status="failed",
        session_id="ses_deploy",
        error="server unavailable",
    )

    payload = store.list_events(project_id=project_id)
    assert payload["unread"] == 1
    assert len(payload["events"]) == 1
    failed = payload["events"][0]
    assert failed["kind"] == "task_failed"
    assert failed["session_id"] == "ses_deploy"
    assert failed["detail"] == "server unavailable"
    assert failed["read_at"] is None
    assert store.mark_event_read(str(failed["id"]))
    assert store.list_events(project_id=project_id)["unread"] == 0

    store.update_task(project_id, task_id, status="running", session_id="ses_deploy")
    store.update_task(project_id, task_id, status="completed", session_id="ses_deploy")
    payload = store.list_events(project_id=project_id)
    assert payload["events"][0]["kind"] == "task_completed"
    assert payload["events"][0]["read_at"] is not None
    store.close()
