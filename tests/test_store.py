from __future__ import annotations

from pathlib import Path

from opencode_control.store import ControlStore


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

    assert store.mark_scheduled_run_ambiguous(
        str(run["id"]), "owner", "prompt response was lost"
    )
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
            ] if session_id == "ses_message" else [],
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

    links = store.project_session_tasks(project_id)
    assert links["ses_completed"]["session_status"] == "completed"
    assert "session_error" not in links["ses_completed"]
    assert links["ses_failed"]["session_status"] == "failed"
    assert links["ses_failed"]["session_error"] == "run failed"

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
