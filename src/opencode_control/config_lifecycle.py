from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from opencode_control.workspace import (
    WorkspaceError,
    WorkspaceFileSnapshot,
    WorkspaceRoot,
    restore_file,
    snapshot_file,
    write_text,
)


@dataclass(frozen=True)
class ConfigFile:
    root: WorkspaceRoot
    relative: Path

    @property
    def key(self) -> str:
        return f"{self.root.path}:{self.relative.as_posix()}"


@dataclass(frozen=True)
class PreflightResult:
    valid: bool
    version: str | None
    error: str | None = None

    def as_dict(self) -> dict[str, object]:
        return {"valid": self.valid, "version": self.version, "error": self.error}


class ConfigOperationError(RuntimeError):
    def __init__(self, status_code: int, result: dict[str, Any]) -> None:
        super().__init__(str(result.get("message") or "config operation failed"))
        self.status_code = status_code
        self.result = result


def compatibility_for_version(version: str | None) -> dict[str, str | None]:
    if not version:
        return {
            "state": "unknown",
            "version": None,
            "message": "OpenCode version could not be determined",
        }
    match = re.search(r"(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?", version)
    if match is None:
        return {
            "state": "unknown",
            "version": version,
            "message": "OpenCode returned an unrecognized version",
        }
    major, minor = int(match.group(1)), int(match.group(2))
    if (major, minor) < (1, 18):
        return {
            "state": "incompatible",
            "version": version,
            "message": "OpenCode 1.18 or newer is required",
        }
    if (major, minor) == (1, 18):
        return {
            "state": "compatible",
            "version": version,
            "message": "This OpenCode release line is tested",
        }
    return {
        "state": "untested_newer",
        "version": version,
        "message": "Newer OpenCode version; config preflight is required",
    }


class OpenCodeConfigPreflight:
    def __init__(self, binary: str, data_dir: Path) -> None:
        self.binary = binary
        self.temp_root = data_dir / "config-preflight"
        self.temp_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.temp_root, 0o700)
        self._version: str | None = None
        self._version_lock = threading.Lock()

    def version(self) -> str | None:
        with self._version_lock:
            if self._version is not None:
                return self._version
            try:
                completed = subprocess.run(
                    [self.binary, "--version"],
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    check=False,
                    timeout=5,
                    env=_clean_opencode_env(),
                )
            except (OSError, subprocess.TimeoutExpired):
                return None
            if completed.returncode != 0:
                return None
            value = completed.stdout.decode("utf-8", errors="replace").strip()
            self._version = value or None
            return self._version

    def validate(
        self,
        *,
        global_files: dict[str, str],
        project_files: dict[str, str],
    ) -> PreflightResult:
        with tempfile.TemporaryDirectory(dir=self.temp_root) as temporary:
            base = Path(temporary)
            xdg = base / "xdg"
            global_dir = xdg / "opencode"
            project_dir = base / "project"
            global_dir.mkdir(parents=True, mode=0o700)
            project_dir.mkdir(mode=0o700)
            for name, content in global_files.items():
                _write_preflight_file(global_dir / name, content)
            for name, content in project_files.items():
                _write_preflight_file(project_dir / name, content)
            environment = _clean_opencode_env()
            environment["XDG_CONFIG_HOME"] = str(xdg)
            try:
                completed = subprocess.run(
                    [self.binary, "--pure", "debug", "config"],
                    cwd=project_dir,
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    check=False,
                    timeout=15,
                    env=environment,
                )
            except FileNotFoundError:
                return PreflightResult(False, None, f"OpenCode binary not found: {self.binary}")
            except OSError as error:
                return PreflightResult(False, self.version(), str(error))
            except subprocess.TimeoutExpired as error:
                detail = _bounded_output(error.stderr or error.stdout or b"")
                return PreflightResult(
                    False,
                    self.version(),
                    "OpenCode config preflight timed out" + (f": {detail}" if detail else ""),
                )
            if completed.returncode != 0:
                detail = _bounded_output(completed.stderr or completed.stdout)
                return PreflightResult(
                    False,
                    self.version(),
                    detail or f"OpenCode config preflight exited with code {completed.returncode}",
                )
            try:
                parsed = json.loads(completed.stdout)
            except json.JSONDecodeError:
                return PreflightResult(
                    False,
                    self.version(),
                    "OpenCode config preflight returned invalid JSON",
                )
            if not isinstance(parsed, dict):
                return PreflightResult(
                    False,
                    self.version(),
                    "OpenCode config preflight returned a non-object config",
                )
            return PreflightResult(True, self.version())


@dataclass
class _TransactionFile:
    config_file: ConfigFile
    snapshot: WorkspaceFileSnapshot
    backup_name: str | None
    candidate_sha256: str | None = None


class ConfigTransaction:
    def __init__(
        self,
        manager: ConfigTransactionManager,
        operation_id: str,
        label: str,
        directory: Path,
        files: list[_TransactionFile],
    ) -> None:
        self.manager = manager
        self.operation_id = operation_id
        self.label = label
        self.directory = directory
        self.files = files
        self.state = "prepared"

    def write_candidates(self, candidates: dict[str, str]) -> None:
        expected = {item.config_file.key for item in self.files}
        if set(candidates) != expected:
            raise WorkspaceError("config transaction candidate set does not match snapshots")
        self.state = "writing"
        self._save_manifest()
        for item in self.files:
            content = candidates[item.config_file.key]
            write_text(item.config_file.root, item.config_file.relative, content)
            item.candidate_sha256 = snapshot_file(
                item.config_file.root, item.config_file.relative
            ).sha256
            self._save_manifest()
        self.state = "candidate_written"
        self._save_manifest()

    def mark_restarting(self) -> None:
        self.state = "restarting"
        self._save_manifest()

    def rollback(self) -> None:
        conflicts: list[str] = []
        for item in reversed(self.files):
            expected = item.candidate_sha256 or item.snapshot.sha256
            try:
                restore_file(
                    item.config_file.root,
                    item.config_file.relative,
                    item.snapshot,
                    expected_sha256=expected,
                )
            except WorkspaceError:
                conflicts.append(item.config_file.key)
        if conflicts:
            self.state = "rollback_conflict"
            self._save_manifest()
            raise WorkspaceError(
                "config rollback refused because files changed externally: "
                + ", ".join(conflicts)
            )
        self.state = "rolled_back"
        self._save_manifest()
        self._cleanup()

    def commit(self) -> None:
        self.state = "committed"
        self._save_manifest()
        self._cleanup()

    def _save_manifest(self) -> None:
        self.manager._write_manifest(self.directory, self._manifest())

    def _manifest(self) -> dict[str, Any]:
        return {
            "version": 1,
            "operation_id": self.operation_id,
            "label": self.label,
            "state": self.state,
            "files": [
                {
                    "root": str(item.config_file.root.path),
                    "device": item.config_file.root.device,
                    "inode": item.config_file.root.inode,
                    "relative": item.config_file.relative.as_posix(),
                    "existed": item.snapshot.existed,
                    "mode": item.snapshot.mode,
                    "before_sha256": item.snapshot.sha256,
                    "candidate_sha256": item.candidate_sha256,
                    "backup": item.backup_name,
                }
                for item in self.files
            ],
        }

    def _cleanup(self) -> None:
        shutil.rmtree(self.directory, ignore_errors=True)


class ConfigTransactionManager:
    def __init__(self, data_dir: Path) -> None:
        self.root = data_dir / "config-transactions"
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self._lock = threading.RLock()

    def begin(self, label: str, config_files: list[ConfigFile]) -> ConfigTransaction:
        if not config_files:
            raise WorkspaceError("config transaction requires at least one file")
        operation_id = secrets.token_hex(16)
        directory = self.root / operation_id
        directory.mkdir(mode=0o700)
        files: list[_TransactionFile] = []
        try:
            for index, config_file in enumerate(config_files):
                snapshot = snapshot_file(config_file.root, config_file.relative)
                backup_name = f"{index}.before" if snapshot.existed else None
                if backup_name is not None:
                    self._write_private(directory / backup_name, snapshot.content)
                files.append(_TransactionFile(config_file, snapshot, backup_name))
            transaction = ConfigTransaction(
                self, operation_id, label, directory, files
            )
            transaction._save_manifest()
            return transaction
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise

    def recover_pending(self) -> list[dict[str, str]]:
        results: list[dict[str, str]] = []
        with self._lock:
            for directory in sorted(self.root.iterdir()):
                if not directory.is_dir():
                    continue
                try:
                    transaction = self._load(directory)
                    if transaction.state == "prepared":
                        transaction._cleanup()
                        results.append(
                            {"operation_id": transaction.operation_id, "state": "discarded"}
                        )
                        continue
                    if transaction.state in {"committed", "rolled_back"}:
                        transaction._cleanup()
                        continue
                    transaction.rollback()
                    results.append(
                        {"operation_id": transaction.operation_id, "state": "rolled_back"}
                    )
                except Exception as error:
                    results.append(
                        {
                            "operation_id": directory.name,
                            "state": "recovery_failed",
                            "detail": str(error),
                        }
                    )
        return results

    def _load(self, directory: Path) -> ConfigTransaction:
        manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or manifest.get("version") != 1:
            raise WorkspaceError("unsupported config transaction manifest")
        files: list[_TransactionFile] = []
        for value in manifest.get("files", []):
            if not isinstance(value, dict):
                raise WorkspaceError("invalid config transaction file entry")
            backup_name = value.get("backup")
            content = (
                (directory / str(backup_name)).read_text(encoding="utf-8")
                if backup_name
                else ""
            )
            config_file = ConfigFile(
                WorkspaceRoot(
                    Path(str(value["root"])),
                    int(value["device"]),
                    int(value["inode"]),
                ),
                Path(str(value["relative"])),
            )
            snapshot = WorkspaceFileSnapshot(
                bool(value["existed"]),
                content,
                int(value["mode"]),
                str(value["before_sha256"]),
            )
            files.append(
                _TransactionFile(
                    config_file,
                    snapshot,
                    str(backup_name) if backup_name else None,
                    str(value["candidate_sha256"])
                    if value.get("candidate_sha256")
                    else None,
                )
            )
        transaction = ConfigTransaction(
            self,
            str(manifest["operation_id"]),
            str(manifest.get("label") or "recovery"),
            directory,
            files,
        )
        transaction.state = str(manifest.get("state") or "prepared")
        return transaction

    def _write_manifest(self, directory: Path, value: dict[str, Any]) -> None:
        with self._lock:
            temporary = directory / f".manifest.{secrets.token_hex(8)}"
            self._write_private(
                temporary, json.dumps(value, ensure_ascii=False, indent=2) + "\n"
            )
            os.replace(temporary, directory / "manifest.json")
            descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)

    @staticmethod
    def _write_private(path: Path, content: str) -> None:
        descriptor = os.open(
            path,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
            0o600,
        )
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())


def _clean_opencode_env() -> dict[str, str]:
    environment = dict(os.environ)
    for name in (
        "OPENCODE_CONFIG",
        "OPENCODE_CONFIG_CONTENT",
        "OPENCODE_CONFIG_DIR",
        "OPENCODE_DISABLE_PROJECT_CONFIG",
    ):
        environment.pop(name, None)
    return environment


def _write_preflight_file(path: Path, content: str) -> None:
    descriptor = os.open(
        path,
        os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
        0o600,
    )
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def _bounded_output(value: bytes, limit: int = 32_768) -> str:
    return value[-limit:].decode("utf-8", errors="replace").strip()
