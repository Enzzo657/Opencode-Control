from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

import opencode_control.processes as process_module
from opencode_control.opencode_client import OpenCodeError
from opencode_control.processes import OpenCodeProcessManager, ProcessError
from opencode_control.workspace import root_identity


def test_concurrent_start_owns_only_one_process(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    project.mkdir()
    spawned: list[Any] = []

    class HealthyClient:
        def __init__(
            self,
            endpoint: str,
            directory: str,
            *,
            timeout: float,
            password: str | None = None,
        ) -> None:
            return

        def request(
            self,
            method: str,
            path: str,
            *,
            body: dict[str, Any] | None = None,
            directory: bool = True,
        ) -> dict[str, bool]:
            return {"healthy": True}

    class FakeProcess:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.pid = 50_000 + len(spawned)
            self.returncode: int | None = None
            spawned.append(self)

        def poll(self) -> int | None:
            return self.returncode

        def wait(self, timeout: float) -> int:
            self.returncode = 0
            return 0

    monkeypatch.setattr(process_module, "OpenCodeClient", HealthyClient)
    monkeypatch.setattr(process_module.subprocess, "Popen", FakeProcess)
    monkeypatch.setattr(process_module.os, "killpg", lambda pid, signal: None)
    manager = OpenCodeProcessManager(binary="opencode", data_dir=tmp_path / "data")
    results: list[dict[str, object]] = []

    threads = [
        threading.Thread(
            target=lambda: results.append(manager.start("prj", root_identity(project)))
        )
        for _ in range(2)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=2)

    assert len(spawned) == 1
    assert len(results) == 2
    assert all(result["pid"] == spawned[0].pid for result in results)

    connection = manager.connection("prj")
    assert connection is not None
    lease_entered = threading.Event()
    release_lease = threading.Event()

    def hold_request_lease() -> None:
        with manager.lease("prj", connection):
            lease_entered.set()
            release_lease.wait(timeout=2)

    lease_thread = threading.Thread(target=hold_request_lease)
    lease_thread.start()
    assert lease_entered.wait(timeout=1)
    status_thread = threading.Thread(target=lambda: manager.status("prj"))
    status_thread.start()
    status_thread.join(timeout=0.2)
    release_lease.set()
    lease_thread.join(timeout=1)
    assert not status_thread.is_alive()
    manager.shutdown()


def test_startup_failure_captures_exit_code_and_log_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    project.mkdir()

    class FailedProcess:
        pid = 51_000
        returncode = 1

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs["stdout"].write(
                b"Configuration is invalid at opencode.jsonc token=super-secret-value\n"
            )

        def poll(self) -> int:
            return 1

    monkeypatch.setattr(process_module.subprocess, "Popen", FailedProcess)
    manager = OpenCodeProcessManager(binary="opencode", data_dir=tmp_path / "data")

    with pytest.raises(ProcessError) as captured:
        manager.start("prj", root_identity(project))

    diagnostic = captured.value.diagnostic
    assert diagnostic is not None
    assert diagnostic.phase == "startup"
    assert diagnostic.exit_code == 1
    assert "Configuration is invalid" in str(diagnostic.detail)
    assert "super-secret-value" not in str(diagnostic.detail)
    assert "[REDACTED]" in str(diagnostic.detail)
    assert manager.status("prj")["last_error"] == diagnostic.as_dict()


def test_different_projects_start_without_a_manager_wide_polling_lock(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    roots = [tmp_path / "one", tmp_path / "two"]
    for root in roots:
        root.mkdir()
    health_barrier = threading.Barrier(2)
    spawned: list[Any] = []

    class ConcurrentHealthyClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            return

        def request(self, *args: Any, **kwargs: Any) -> dict[str, bool]:
            health_barrier.wait(timeout=1)
            return {"healthy": True}

    class FakeProcess:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self.pid = 52_000 + len(spawned)
            self.returncode: int | None = None
            spawned.append(self)

        def poll(self) -> int | None:
            return self.returncode

        def wait(self, timeout: float) -> int:
            self.returncode = 0
            return 0

    monkeypatch.setattr(process_module, "OpenCodeClient", ConcurrentHealthyClient)
    monkeypatch.setattr(process_module.subprocess, "Popen", FakeProcess)
    monkeypatch.setattr(process_module.os, "killpg", lambda pid, signal: None)
    manager = OpenCodeProcessManager(binary="opencode", data_dir=tmp_path / "data")
    errors: list[Exception] = []

    def start(project_id: str, root: Path) -> None:
        try:
            manager.start(project_id, root_identity(root))
        except Exception as error:
            errors.append(error)

    threads = [
        threading.Thread(target=start, args=(f"prj-{index}", root))
        for index, root in enumerate(roots)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=2)

    assert errors == []
    assert len(spawned) == 2
    manager.shutdown()


def test_health_timeout_keeps_the_last_health_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    project = tmp_path / "project"
    project.mkdir()

    class UnhealthyClient:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            return

        def request(self, *args: Any, **kwargs: Any) -> dict[str, bool]:
            raise OpenCodeError("health endpoint refused connection")

    class FakeProcess:
        pid = 53_000
        returncode: int | None = None

        def __init__(self, *args: Any, **kwargs: Any) -> None:
            return

        def poll(self) -> int | None:
            return self.returncode

        def wait(self, timeout: float) -> int:
            self.returncode = 0
            return 0

    times = iter((0.0, 1.0, 11.0))
    monkeypatch.setattr(process_module, "OpenCodeClient", UnhealthyClient)
    monkeypatch.setattr(process_module.subprocess, "Popen", FakeProcess)
    monkeypatch.setattr(process_module.os, "killpg", lambda pid, signal: None)
    monkeypatch.setattr(process_module.time, "monotonic", lambda: next(times))
    monkeypatch.setattr(process_module.time, "sleep", lambda seconds: None)
    manager = OpenCodeProcessManager(binary="opencode", data_dir=tmp_path / "data")

    with pytest.raises(ProcessError) as captured:
        manager.start("prj", root_identity(project))

    diagnostic = captured.value.diagnostic
    assert diagnostic is not None
    assert diagnostic.phase == "health"
    assert "health endpoint refused connection" in str(diagnostic.detail)
