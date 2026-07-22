from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

import opencode_studio.processes as process_module
from opencode_studio.processes import OpenCodeProcessManager
from opencode_studio.workspace import root_identity


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
    manager.shutdown()
