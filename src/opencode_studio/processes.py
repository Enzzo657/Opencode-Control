from __future__ import annotations

import os
import secrets
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

from opencode_studio.opencode_client import OpenCodeClient, OpenCodeError
from opencode_studio.workspace import WorkspaceRoot, open_root_descriptor


class ProcessError(RuntimeError):
    pass


@dataclass
class ManagedProcess:
    project_id: str
    endpoint: str
    process: subprocess.Popen[bytes]
    log_handle: BinaryIO
    password: str


@dataclass(frozen=True)
class ManagedConnection:
    endpoint: str
    password: str
    process: subprocess.Popen[bytes]


class OpenCodeProcessManager:
    def __init__(self, *, binary: str, data_dir: Path) -> None:
        self.binary = binary
        self.log_dir = data_dir / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._processes: dict[str, ManagedProcess] = {}
        self._lock = threading.RLock()

    def start(self, project_id: str, root: WorkspaceRoot) -> dict[str, object]:
        root_descriptor = open_root_descriptor(root)
        try:
            return self._start(project_id, root, root_descriptor)
        finally:
            os.close(root_descriptor)

    def _start(
        self,
        project_id: str,
        root: WorkspaceRoot,
        root_descriptor: int,
    ) -> dict[str, object]:
        with self._lock:
            existing = self._processes.get(project_id)
            if existing and existing.process.poll() is None:
                return self.status(project_id)
            if existing:
                self._forget(project_id)
            port = _available_port()
            endpoint = f"http://127.0.0.1:{port}"
            password = secrets.token_urlsafe(32)
            log_handle = (self.log_dir / f"{project_id}.log").open("ab", buffering=0)
            try:
                process = subprocess.Popen(
                    [
                        sys.executable,
                        "-m",
                        "opencode_studio.exec_in_dir",
                        str(root_descriptor),
                        self.binary,
                        "serve",
                        "--hostname=127.0.0.1",
                        f"--port={port}",
                    ],
                    stdin=subprocess.DEVNULL,
                    stdout=log_handle,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                    env={**os.environ, "OPENCODE_SERVER_PASSWORD": password},
                    pass_fds=(root_descriptor,),
                )
            except OSError as error:
                log_handle.close()
                raise ProcessError(f"cannot start {self.binary}") from error
            managed = ManagedProcess(project_id, endpoint, process, log_handle, password)
            self._processes[project_id] = managed
            client = OpenCodeClient(endpoint, None, timeout=0.5, password=password)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    self._forget(project_id)
                    raise ProcessError("OpenCode exited during startup")
                try:
                    health = client.request("GET", "/global/health", directory=False)
                    if isinstance(health, dict) and health.get("healthy") is True:
                        return self.status(project_id)
                except OpenCodeError:
                    time.sleep(0.1)
            self.stop(project_id)
            raise ProcessError("OpenCode did not become healthy within 10 seconds")

    def stop(self, project_id: str) -> dict[str, object]:
        with self._lock:
            managed = self._processes.get(project_id)
            if managed is None:
                return {"state": "stopped", "managed": False, "endpoint": None}
            if managed.process.poll() is None:
                with _ignore_process_error():
                    os.killpg(managed.process.pid, signal.SIGTERM)
                try:
                    managed.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    with _ignore_process_error():
                        os.killpg(managed.process.pid, signal.SIGKILL)
                    managed.process.wait(timeout=2)
            endpoint = managed.endpoint
            self._forget(project_id)
            return {"state": "stopped", "managed": True, "endpoint": endpoint}

    def restart_if_running(
        self, project_id: str, root: WorkspaceRoot
    ) -> dict[str, object] | None:
        with self._lock:
            managed = self._processes.get(project_id)
            if managed is None or managed.process.poll() is not None:
                return None
            self.stop(project_id)
            return self.start(project_id, root)

    def status(self, project_id: str) -> dict[str, object]:
        with self._lock:
            managed = self._processes.get(project_id)
            if managed is None:
                return {"state": "stopped", "managed": False, "endpoint": None}
            if managed.process.poll() is not None:
                self._forget(project_id)
                return {"state": "stopped", "managed": False, "endpoint": None}
            return {
                "state": "running",
                "managed": True,
                "endpoint": managed.endpoint,
                "pid": managed.process.pid,
            }

    def endpoint(self, project_id: str) -> str | None:
        status = self.status(project_id)
        value = status.get("endpoint")
        return str(value) if status["state"] == "running" and value else None

    def connection(self, project_id: str) -> ManagedConnection | None:
        with self._lock:
            managed = self._processes.get(project_id)
            if managed is None or managed.process.poll() is not None:
                return None
            return ManagedConnection(managed.endpoint, managed.password, managed.process)

    @contextmanager
    def lease(self, project_id: str, connection: ManagedConnection) -> Iterator[None]:
        with self._lock:
            managed = self._processes.get(project_id)
            if (
                managed is None
                or managed.process is not connection.process
                or managed.process.poll() is not None
            ):
                raise ProcessError("managed OpenCode server changed before request")
            yield

    def shutdown(self) -> None:
        with self._lock:
            project_ids = list(self._processes)
        for project_id in project_ids:
            self.stop(project_id)

    def _forget(self, project_id: str) -> None:
        managed = self._processes.pop(project_id, None)
        if managed is not None:
            managed.log_handle.close()


class _ignore_process_error:
    def __enter__(self) -> None:
        return None

    def __exit__(self, error_type: object, error: object, traceback: object) -> bool:
        return isinstance(error, ProcessLookupError)


def _available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return int(candidate.getsockname()[1])
