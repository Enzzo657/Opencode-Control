from __future__ import annotations

import json
import os
import re
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
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO, Protocol

from opencode_control.log_rotation import LogRotationError, rotate_log
from opencode_control.opencode_client import OpenCodeClient, OpenCodeError
from opencode_control.redaction import redact_text
from opencode_control.workspace import WorkspaceRoot, open_root_descriptor


class ProcessError(RuntimeError):
    def __init__(self, message: str, diagnostic: ProcessDiagnostic | None = None) -> None:
        super().__init__(message)
        self.diagnostic = diagnostic


@dataclass(frozen=True)
class ProcessDiagnostic:
    phase: str
    summary: str
    timestamp: str
    log_path: str
    exit_code: int | None = None
    detail: str | None = None

    def as_dict(self, *, include_detail: bool = True) -> dict[str, object]:
        result: dict[str, object] = {
            "phase": self.phase,
            "summary": self.summary,
            "timestamp": self.timestamp,
            "log_path": self.log_path,
            "exit_code": self.exit_code,
        }
        if include_detail and self.detail:
            result["detail"] = self.detail
        return result


@dataclass
class ManagedProcess:
    project_id: str
    endpoint: str
    process: ProcessHandle
    log_handle: BinaryIO
    password: str
    version: str | None = None


@dataclass(frozen=True)
class ManagedConnection:
    endpoint: str
    password: str
    process: ProcessHandle


class ProcessHandle(Protocol):
    pid: int
    returncode: int | None

    def poll(self) -> int | None: ...

    def wait(self, timeout: float) -> int: ...


class AdoptedProcess:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.returncode: int | None = None

    def poll(self) -> int | None:
        if _pid_alive(self.pid):
            return None
        self.returncode = 0
        return self.returncode

    def wait(self, timeout: float) -> int:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.poll()
            if result is not None:
                return result
            time.sleep(0.05)
        raise subprocess.TimeoutExpired(str(self.pid), timeout)


class OpenCodeProcessManager:
    def __init__(self, *, binary: str, data_dir: Path) -> None:
        self.binary = binary
        self.log_dir = data_dir / "logs"
        self.log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._processes: dict[str, ManagedProcess] = {}
        self._lock = threading.RLock()
        self._project_locks: dict[str, threading.RLock] = {}
        self._failures: dict[str, ProcessDiagnostic] = {}
        self.registry_path = data_dir / "managed-processes.json"
        self._registry = self._load_registry()

    def _project_lock(self, project_id: str) -> threading.RLock:
        with self._lock:
            return self._project_locks.setdefault(project_id, threading.RLock())

    def start(self, project_id: str, root: WorkspaceRoot) -> dict[str, object]:
        root_descriptor = open_root_descriptor(root)
        try:
            with self._project_lock(project_id):
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
        adopted = self._adopt(project_id, root)
        if adopted is not None:
            with self._lock:
                self._processes[project_id] = adopted
                self._failures.pop(project_id, None)
            return self.status(project_id)
        port = _available_port()
        endpoint = f"http://127.0.0.1:{port}"
        password = secrets.token_urlsafe(32)
        log_path = self.log_dir / f"{project_id}.log"
        try:
            rotate_log(log_path)
        except LogRotationError as error:
            raise ProcessError(str(error)) from error
        log_path.touch(mode=0o600, exist_ok=True)
        os.chmod(log_path, 0o600)
        log_handle = log_path.open("ab", buffering=0)
        try:
            process = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "opencode_control.exec_in_dir",
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
            diagnostic = self._record_failure(
                project_id, "spawn", f"cannot start {self.binary}", log_path
            )
            raise ProcessError(diagnostic.summary, diagnostic) from error
        managed = ManagedProcess(project_id, endpoint, process, log_handle, password)
        with self._lock:
            self._processes[project_id] = managed
        self._remember(project_id, root, managed)
        client = OpenCodeClient(endpoint, None, timeout=0.5, password=password)
        deadline = time.monotonic() + 10
        last_health_error: str | None = None
        while time.monotonic() < deadline:
            exit_code = process.poll()
            if exit_code is not None:
                self._forget(project_id)
                diagnostic = self._record_failure(
                    project_id,
                    "startup",
                    "OpenCode exited during startup",
                    log_path,
                    exit_code=exit_code,
                )
                raise ProcessError(diagnostic.summary, diagnostic)
            try:
                health = client.request("GET", "/global/health", directory=False)
                if isinstance(health, dict) and health.get("healthy") is True:
                    version = health.get("version")
                    managed.version = version if isinstance(version, str) else None
                    self._remember(project_id, root, managed)
                    with self._lock:
                        self._failures.pop(project_id, None)
                    return self.status(project_id)
            except OpenCodeError as error:
                last_health_error = str(error)
                time.sleep(0.1)
        self.stop(project_id)
        diagnostic = self._record_failure(
            project_id,
            "health",
            "OpenCode did not become healthy within 10 seconds",
            log_path,
            detail=last_health_error,
        )
        raise ProcessError(diagnostic.summary, diagnostic)

    def stop(self, project_id: str) -> dict[str, object]:
        with self._project_lock(project_id):
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

    def restart_if_running(self, project_id: str, root: WorkspaceRoot) -> dict[str, object] | None:
        with self._project_lock(project_id):
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
                return self._stopped_status(project_id)
            if managed.process.poll() is not None:
                diagnostic = self._record_failure(
                    project_id,
                    "runtime",
                    "OpenCode process exited",
                    self.log_dir / f"{project_id}.log",
                    exit_code=managed.process.returncode,
                )
                self._forget(project_id)
                return self._stopped_status(project_id, diagnostic)
            return {
                "state": "running",
                "managed": True,
                "endpoint": managed.endpoint,
                "pid": managed.process.pid,
                "version": managed.version,
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
        # Network calls can last for the full agent run. Holding the process lock here
        # would block status checks, page loads, and abort requests until it finishes.
        yield

    def shutdown(self) -> None:
        with self._lock:
            project_ids = list(self._processes)
        for project_id in project_ids:
            self.stop(project_id)

    def _forget(self, project_id: str) -> None:
        with self._lock:
            managed = self._processes.pop(project_id, None)
            self._registry.pop(project_id, None)
            self._save_registry()
        if managed is not None:
            managed.log_handle.close()

    def _adopt(self, project_id: str, root: WorkspaceRoot) -> ManagedProcess | None:
        with self._lock:
            raw = self._registry.get(project_id)
        if not isinstance(raw, dict):
            return None
        try:
            pid_value = raw["pid"]
            endpoint_value = raw["endpoint"]
            password_value = raw["password"]
            device_value = raw["root_device"]
            inode_value = raw["root_inode"]
        except KeyError:
            self._discard_registry(project_id)
            return None
        if (
            not isinstance(pid_value, int)
            or not isinstance(endpoint_value, str)
            or not isinstance(password_value, str)
            or not isinstance(device_value, int)
            or not isinstance(inode_value, int)
        ):
            self._discard_registry(project_id)
            return None
        pid = pid_value
        endpoint = endpoint_value
        password = password_value
        device = device_value
        inode = inode_value
        if device != root.device or inode != root.inode or not _pid_alive(pid):
            self._discard_registry(project_id)
            return None
        client = OpenCodeClient(endpoint, None, timeout=0.5, password=password)
        try:
            health = client.request("GET", "/global/health", directory=False)
        except OpenCodeError:
            self._terminate_orphan(pid)
            self._discard_registry(project_id)
            return None
        if not isinstance(health, dict) or health.get("healthy") is not True:
            self._terminate_orphan(pid)
            self._discard_registry(project_id)
            return None
        log_path = self.log_dir / f"{project_id}.log"
        log_path.touch(mode=0o600, exist_ok=True)
        os.chmod(log_path, 0o600)
        log_handle = log_path.open("ab", buffering=0)
        version = health.get("version")
        return ManagedProcess(
            project_id,
            endpoint,
            AdoptedProcess(pid),
            log_handle,
            password,
            version if isinstance(version, str) else None,
        )

    def _remember(self, project_id: str, root: WorkspaceRoot, managed: ManagedProcess) -> None:
        with self._lock:
            self._registry[project_id] = {
                "pid": managed.process.pid,
                "endpoint": managed.endpoint,
                "password": managed.password,
                "version": managed.version,
                "generation": secrets.token_hex(16),
                "root_device": root.device,
                "root_inode": root.inode,
            }
            self._save_registry()

    def _discard_registry(self, project_id: str) -> None:
        with self._lock:
            if self._registry.pop(project_id, None) is not None:
                self._save_registry()

    def _terminate_orphan(self, pid: int) -> None:
        with _ignore_process_error():
            os.killpg(pid, signal.SIGTERM)
        deadline = time.monotonic() + 2
        while _pid_alive(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        if _pid_alive(pid):
            with _ignore_process_error():
                os.killpg(pid, signal.SIGKILL)

    def _load_registry(self) -> dict[str, dict[str, object]]:
        try:
            raw = json.loads(self.registry_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        if not isinstance(raw, dict):
            return {}
        return {str(key): value for key, value in raw.items() if isinstance(value, dict)}

    def _save_registry(self) -> None:
        temporary = self.registry_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(self._registry, sort_keys=True), encoding="utf-8")
        os.chmod(temporary, 0o600)
        os.replace(temporary, self.registry_path)
        os.chmod(self.registry_path, 0o600)

    def _stopped_status(
        self, project_id: str, diagnostic: ProcessDiagnostic | None = None
    ) -> dict[str, object]:
        failure = diagnostic
        if failure is None:
            with self._lock:
                failure = self._failures.get(project_id)
        result: dict[str, object] = {
            "state": "stopped",
            "managed": False,
            "endpoint": None,
        }
        if failure is not None:
            result["last_error"] = failure.as_dict()
        return result

    def _record_failure(
        self,
        project_id: str,
        phase: str,
        summary: str,
        log_path: Path,
        *,
        exit_code: int | None = None,
        detail: str | None = None,
    ) -> ProcessDiagnostic:
        tail = _log_tail(log_path)
        combined = "\n".join(item for item in (detail, tail) if item) or None
        diagnostic = ProcessDiagnostic(
            phase=phase,
            summary=summary,
            timestamp=datetime.now(UTC).isoformat(),
            log_path=str(log_path),
            exit_code=exit_code,
            detail=combined,
        )
        with self._lock:
            self._failures[project_id] = diagnostic
        return diagnostic


class _ignore_process_error:
    def __enter__(self) -> None:
        return None

    def __exit__(self, error_type: object, error: object, traceback: object) -> bool:
        return isinstance(error, ProcessLookupError)


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _available_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
        candidate.bind(("127.0.0.1", 0))
        return int(candidate.getsockname()[1])


def _log_tail(path: Path, limit: int = 32_768) -> str:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - limit))
            raw = handle.read(limit)
    except OSError:
        return ""
    text = raw.decode("utf-8", errors="replace")
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = redact_text(text)
    return "\n".join(text.splitlines()[-80:]).strip()
