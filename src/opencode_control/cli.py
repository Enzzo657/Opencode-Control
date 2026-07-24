from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import suppress
from pathlib import Path

import uvicorn

from opencode_control.app import create_app
from opencode_control.config import ControlConfig
from opencode_control.migration import MigrationError, prepare_control_data_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenCode Control local control plane")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--open", action="store_true", dest="open_browser")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--background", action="store_true")
    actions.add_argument("--restart", action="store_true")
    actions.add_argument("--stop", action="store_true")
    actions.add_argument("--status", action="store_true")
    actions.add_argument("--foreground-child", action="store_true", help=argparse.SUPPRESS)
    arguments = parser.parse_args()
    if arguments.host not in {"127.0.0.1", "::1"}:
        parser.error("OpenCode Control only binds to loopback addresses")
    config = ControlConfig.from_environment()
    pid_path, log_path = _runtime_paths(config)
    legacy_pid_path = (
        None
        if os.environ.get("OPENCODE_CONTROL_HOME")
        else Path.home() / ".opencode-studio/studio.pid"
    )
    if arguments.status:
        pid = _read_pid(pid_path)
        legacy_pid = _read_pid(legacy_pid_path) if legacy_pid_path else None
        if pid and _is_managed_process(pid, "opencode_control.cli"):
            print(f"running (PID {pid})")
        elif legacy_pid and _is_managed_process(legacy_pid, "opencode_studio.cli"):
            print(f"legacy runtime running (PID {legacy_pid}); use --restart to migrate")
        else:
            print("stopped")
        return
    if arguments.stop:
        stopped = _stop(pid_path, "OpenCode Control", "opencode_control.cli", quiet=True)
        if legacy_pid_path:
            stopped = (
                _stop(
                    legacy_pid_path,
                    "legacy OpenCode Studio",
                    "opencode_studio.cli",
                    quiet=True,
                )
                or stopped
            )
        print("OpenCode Control stopped" if stopped else "OpenCode Control is not running")
        return
    if arguments.restart:
        _stop(pid_path, "OpenCode Control", "opencode_control.cli", quiet=True)
        if legacy_pid_path:
            _stop(
                legacy_pid_path,
                "legacy OpenCode Studio",
                "opencode_studio.cli",
                quiet=True,
            )
        _prepare_data(config)
        _start_background(
            arguments.host, arguments.port, arguments.open_browser, pid_path, log_path
        )
        return
    legacy_pid = _read_pid(legacy_pid_path) if legacy_pid_path else None
    if legacy_pid and _is_managed_process(legacy_pid, "opencode_studio.cli"):
        raise SystemExit("Legacy OpenCode Studio is running; use opencode-control --restart")
    _prepare_data(config)
    if arguments.background:
        _start_background(
            arguments.host, arguments.port, arguments.open_browser, pid_path, log_path
        )
        return
    _serve(arguments.host, arguments.port, arguments.open_browser, pid_path)


def _runtime_paths(config: ControlConfig) -> tuple[Path, Path]:
    data_dir = config.data_dir
    return data_dir / "control.pid", data_dir / "control.log"


def _prepare_data(config: ControlConfig) -> None:
    if os.environ.get("OPENCODE_CONTROL_HOME"):
        config.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(config.data_dir, 0o700)
        return
    try:
        result = prepare_control_data_dir(
            config.data_dir, Path.home() / ".opencode-studio"
        )
    except MigrationError as error:
        raise SystemExit(f"OpenCode Control data migration failed: {error}") from error
    if result.migrated:
        counts = ", ".join(f"{name}={count}" for name, count in result.counts.items())
        print(f"Migrated OpenCode Studio data to {result.target} ({counts})")


def _read_pid(path: Path) -> int | None:
    try:
        return int(path.read_text(encoding="utf-8").strip())
    except (FileNotFoundError, OSError, ValueError):
        return None


def _is_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _stop(pid_path: Path, label: str, expected_module: str, *, quiet: bool = False) -> bool:
    pid = _read_pid(pid_path)
    if not pid or not _is_managed_process(pid, expected_module):
        with suppress(FileNotFoundError):
            pid_path.unlink()
        if not quiet:
            print(f"{label} is not running")
        return False
    with suppress(ProcessLookupError):
        os.killpg(pid, signal.SIGTERM)
    deadline = time.monotonic() + 8
    while _is_running(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    if _is_managed_process(pid, expected_module):
        raise SystemExit(f"{label} did not stop cleanly; migration was not started")
    with suppress(FileNotFoundError):
        pid_path.unlink()
    if not quiet:
        print(f"{label} stopped")
    return True


def _is_managed_process(pid: int, expected_module: str) -> bool:
    if not _is_running(pid):
        return False
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "command="],
            check=True,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return expected_module in result.stdout


def _start_background(
    host: str,
    port: int,
    open_browser: bool,
    pid_path: Path,
    log_path: Path,
) -> None:
    current = _read_pid(pid_path)
    if current and _is_running(current):
        print(f"OpenCode Control is already running (PID {current})")
        if open_browser:
            _open_browser(host, port)
        return
    log_path.touch(mode=0o600, exist_ok=True)
    os.chmod(log_path, 0o600)
    log_handle = log_path.open("ab", buffering=0)
    try:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "opencode_control.cli",
                "--host",
                host,
                "--port",
                str(port),
                "--foreground-child",
            ],
            stdin=subprocess.DEVNULL,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
    finally:
        log_handle.close()
    pid_path.write_text(str(process.pid), encoding="utf-8")
    os.chmod(pid_path, 0o600)
    endpoint = _endpoint(host, port)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"OpenCode Control failed to start; inspect {log_path}")
        try:
            with urllib.request.urlopen(f"{endpoint}/api/v1/health", timeout=0.4) as response:
                if response.status == 200:
                    if open_browser:
                        _open_browser(host, port)
                    print(
                        f"OpenCode Control running in background (PID {process.pid}) "
                        f"at {endpoint}"
                    )
                    print(f"Log: {log_path}")
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise SystemExit(f"OpenCode Control did not become ready; inspect {log_path}")


def _serve(host: str, port: int, open_browser: bool, pid_path: Path) -> None:
    current = _read_pid(pid_path)
    if current and current != os.getpid() and _is_running(current):
        raise SystemExit(f"OpenCode Control is already running (PID {current})")
    pid_path.write_text(str(os.getpid()), encoding="utf-8")
    os.chmod(pid_path, 0o600)
    if open_browser:
        import threading

        threading.Timer(0.8, lambda: _open_browser(host, port)).start()
    try:
        uvicorn.run(create_app(), host=host, port=port, log_level="info")
    finally:
        if _read_pid(pid_path) == os.getpid():
            with suppress(FileNotFoundError):
                pid_path.unlink()


def _endpoint(host: str, port: int) -> str:
    browser_host = f"[{host}]" if ":" in host else host
    return f"http://{browser_host}:{port}"


def _open_browser(host: str, port: int) -> None:
    import webbrowser

    webbrowser.open(_endpoint(host, port))


if __name__ == "__main__":
    main()
