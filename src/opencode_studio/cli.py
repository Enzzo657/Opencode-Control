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

from opencode_studio.app import create_app
from opencode_studio.config import StudioConfig


def main() -> None:
    parser = argparse.ArgumentParser(description="OpenCode Studio local control plane")
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
        parser.error("OpenCode Studio only binds to loopback addresses")
    pid_path, log_path = _runtime_paths()
    if arguments.status:
        pid = _read_pid(pid_path)
        print(f"running (PID {pid})" if pid and _is_running(pid) else "stopped")
        return
    if arguments.stop:
        _stop(pid_path)
        return
    if arguments.restart:
        _stop(pid_path, quiet=True)
        _start_background(
            arguments.host, arguments.port, arguments.open_browser, pid_path, log_path
        )
        return
    if arguments.background:
        _start_background(
            arguments.host, arguments.port, arguments.open_browser, pid_path, log_path
        )
        return
    _serve(arguments.host, arguments.port, arguments.open_browser, pid_path)


def _runtime_paths() -> tuple[Path, Path]:
    data_dir = StudioConfig.from_environment().data_dir
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    return data_dir / "studio.pid", data_dir / "studio.log"


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


def _stop(pid_path: Path, *, quiet: bool = False) -> None:
    pid = _read_pid(pid_path)
    if not pid or not _is_running(pid):
        with suppress(FileNotFoundError):
            pid_path.unlink()
        if not quiet:
            print("OpenCode Studio is not running")
        return
    with suppress(ProcessLookupError):
        os.killpg(pid, signal.SIGTERM)
    deadline = time.monotonic() + 8
    while _is_running(pid) and time.monotonic() < deadline:
        time.sleep(0.1)
    with suppress(FileNotFoundError):
        pid_path.unlink()
    if not quiet:
        print("OpenCode Studio stopped")


def _start_background(
    host: str,
    port: int,
    open_browser: bool,
    pid_path: Path,
    log_path: Path,
) -> None:
    current = _read_pid(pid_path)
    if current and _is_running(current):
        print(f"OpenCode Studio is already running (PID {current})")
        if open_browser:
            _open_browser(host, port)
        return
    log_handle = log_path.open("ab", buffering=0)
    try:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "opencode_studio.cli",
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
    endpoint = _endpoint(host, port)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SystemExit(f"OpenCode Studio failed to start; inspect {log_path}")
        try:
            with urllib.request.urlopen(f"{endpoint}/api/v1/health", timeout=0.4) as response:
                if response.status == 200:
                    if open_browser:
                        _open_browser(host, port)
                    print(
                        f"OpenCode Studio running in background (PID {process.pid}) "
                        f"at {endpoint}"
                    )
                    print(f"Log: {log_path}")
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.1)
    raise SystemExit(f"OpenCode Studio did not become ready; inspect {log_path}")


def _serve(host: str, port: int, open_browser: bool, pid_path: Path) -> None:
    current = _read_pid(pid_path)
    if current and current != os.getpid() and _is_running(current):
        raise SystemExit(f"OpenCode Studio is already running (PID {current})")
    pid_path.write_text(str(os.getpid()), encoding="utf-8")
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
