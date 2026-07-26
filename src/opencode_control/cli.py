from __future__ import annotations

import argparse
import os
import shutil
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request
from contextlib import suppress
from copy import deepcopy
from pathlib import Path
from typing import Any

import uvicorn

from opencode_control.app import create_app
from opencode_control.config import ControlConfig
from opencode_control.log_rotation import LogRotationError, rotate_log
from opencode_control.migration import MigrationError, prepare_control_data_dir


def main(argv: list[str] | None = None) -> None:
    arguments_list = list(sys.argv[1:] if argv is None else argv)
    if arguments_list[:1] == ["_serve"]:
        internal = argparse.ArgumentParser(add_help=False)
        internal.add_argument("_serve")
        internal.add_argument("--host", default="127.0.0.1")
        internal.add_argument("--port", default=8765, type=int)
        arguments = internal.parse_args(arguments_list)
        config = ControlConfig.from_environment()
        _prepare_data(config)
        _serve(arguments.host, arguments.port, config.data_dir / "control.pid")
        return

    parser = _build_parser()
    arguments = parser.parse_args(arguments_list)
    if getattr(arguments, "host", "127.0.0.1") not in {"127.0.0.1", "::1"}:
        parser.error("OpenCode Control only binds to loopback addresses")
    config = ControlConfig.from_environment()
    pid_path, log_path = _runtime_paths(config)
    legacy_pid_path = (
        None
        if os.environ.get("OPENCODE_CONTROL_HOME")
        else Path.home() / ".opencode-studio/studio.pid"
    )
    if arguments.action == "status":
        _status(pid_path, legacy_pid_path)
        return
    if arguments.action == "logs":
        if arguments.lines < 1:
            parser.error("--lines must be greater than zero")
        _show_logs(log_path, arguments.lines, arguments.follow)
        return
    if arguments.action == "uninstall":
        _uninstall(config, pid_path, legacy_pid_path, arguments.yes, arguments.purge_data)
        return
    if arguments.action == "stop":
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
    if arguments.action == "restart":
        _stop(pid_path, "OpenCode Control", "opencode_control.cli", quiet=True)
        if legacy_pid_path:
            _stop(
                legacy_pid_path,
                "legacy OpenCode Studio",
                "opencode_studio.cli",
                quiet=True,
            )
    else:
        legacy_pid = _read_pid(legacy_pid_path) if legacy_pid_path else None
        if legacy_pid and _is_managed_process(legacy_pid, "opencode_studio.cli"):
            raise SystemExit("Legacy OpenCode Studio is running; use opencode-control restart")
    _prepare_data(config)
    _start_background(
        arguments.host,
        arguments.port,
        not arguments.no_open,
        pid_path,
        log_path,
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenCode Control local control plane")
    commands = parser.add_subparsers(dest="action", required=True)
    for name, help_text in (
        ("start", "start in the background and open the browser"),
        ("restart", "restart in the background and open the browser"),
    ):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("--host", default="127.0.0.1")
        command.add_argument("--port", default=8765, type=int)
        command.add_argument("--no-open", action="store_true")
    commands.add_parser("stop", help="stop OpenCode Control and managed OpenCode servers")
    commands.add_parser("status", help="show whether OpenCode Control is running")
    logs = commands.add_parser("logs", help="show the OpenCode Control log")
    logs.add_argument("--lines", type=int, default=100)
    logs.add_argument("--follow", "-f", action="store_true")
    uninstall = commands.add_parser(
        "uninstall", help="uninstall the uv tool and optionally delete Control data"
    )
    uninstall.add_argument("--yes", "-y", action="store_true")
    uninstall.add_argument(
        "--purge-data",
        action="store_true",
        help="delete projects, tasks, configuration and logs after uninstalling",
    )
    return parser


def _status(pid_path: Path, legacy_pid_path: Path | None) -> None:
    pid = _read_pid(pid_path)
    legacy_pid = _read_pid(legacy_pid_path) if legacy_pid_path else None
    if pid and _is_managed_process(pid, "opencode_control.cli"):
        print(f"running (PID {pid})")
    elif legacy_pid and _is_managed_process(legacy_pid, "opencode_studio.cli"):
        print(f"legacy runtime running (PID {legacy_pid}); use opencode-control restart")
    else:
        print("stopped")


def _show_logs(path: Path, lines: int, follow: bool) -> None:
    info = _safe_log_info(path)
    if info is None:
        print(f"Log does not exist yet: {path}")
        return
    for line in _tail_lines(path, info.st_size, lines):
        print(line)
    if not follow:
        return
    position = info.st_size
    try:
        while True:
            current = _safe_log_info(path)
            if current is None:
                time.sleep(0.25)
                continue
            if current.st_size < position or (current.st_dev, current.st_ino) != (
                info.st_dev,
                info.st_ino,
            ):
                position = 0
                info = current
            if current.st_size > position:
                with path.open("rb") as stream:
                    stream.seek(position)
                    chunk = stream.read()
                    position = stream.tell()
                sys.stdout.write(chunk.decode("utf-8", errors="replace"))
                sys.stdout.flush()
            time.sleep(0.25)
    except KeyboardInterrupt:
        return


def _tail_lines(path: Path, size: int, count: int) -> list[str]:
    block_size = 64 * 1024
    position = size
    content = b""
    with path.open("rb") as stream:
        while position > 0 and content.count(b"\n") <= count:
            chunk_size = min(block_size, position)
            position -= chunk_size
            stream.seek(position)
            content = stream.read(chunk_size) + content
    return content.decode("utf-8", errors="replace").splitlines()[-count:]


def _safe_log_info(path: Path) -> os.stat_result | None:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        raise SystemExit(f"Log path is unsafe: {path}")
    return info


def _uninstall(
    config: ControlConfig,
    pid_path: Path,
    legacy_pid_path: Path | None,
    assume_yes: bool,
    purge_data: bool,
) -> None:
    if not assume_yes:
        if not sys.stdin.isatty():
            raise SystemExit("Run opencode-control uninstall --yes in non-interactive mode")
        answer = input("Uninstall OpenCode Control? [y/N] ")
        if answer.lower() not in {"y", "yes"}:
            print("Uninstall cancelled")
            return
        answer = input(
            f"Delete all Control projects, tasks, configuration and logs at "
            f"{_configured_data_path()}? [y/N] "
        )
        purge_data = answer.lower() in {"y", "yes"}
    data_path = _configured_data_path()
    purge_files, purge_directories = _control_data_purge_plan(data_path) if purge_data else ([], [])
    _stop(pid_path, "OpenCode Control", "opencode_control.cli", quiet=True)
    if legacy_pid_path:
        _stop(
            legacy_pid_path,
            "legacy OpenCode Studio",
            "opencode_studio.cli",
            quiet=True,
        )
    uv = shutil.which("uv")
    if uv is None:
        raise SystemExit("uv is required to uninstall OpenCode Control")
    result = subprocess.run([uv, "tool", "uninstall", "opencode-control"], check=False)
    if result.returncode != 0:
        raise SystemExit(result.returncode)
    if purge_data:
        _purge_control_data(data_path, purge_files, purge_directories)
        print(f"OpenCode Control uninstalled. Data deleted from {data_path}")
    else:
        print(f"OpenCode Control uninstalled. Data preserved at {config.data_dir}")


def _configured_data_path() -> Path:
    raw = os.environ.get("OPENCODE_CONTROL_HOME")
    path = Path(raw).expanduser() if raw else Path.home() / ".opencode-control"
    return Path(os.path.abspath(path))


def _control_data_purge_plan(path: Path) -> tuple[list[Path], list[Path]]:
    try:
        info = path.lstat()
    except FileNotFoundError:
        return [], []
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise SystemExit(f"Control data path is unsafe: {path}")

    known_files = {
        "control.sqlite",
        "control.sqlite-shm",
        "control.sqlite-wal",
        "control.pid",
        "migration.json",
        "control.log",
        "control.log.1",
        "control.log.2",
        "control.log.3",
    }
    files: list[Path] = []
    directories: list[Path] = []
    for entry in path.iterdir():
        if entry.name in known_files:
            _validate_purge_file(entry)
            files.append(entry)
            continue
        if entry.name != "logs":
            raise SystemExit(
                f"Unknown file in Control data directory; data was not deleted: {entry}"
            )
        log_info = entry.lstat()
        if not stat.S_ISDIR(log_info.st_mode) or stat.S_ISLNK(log_info.st_mode):
            raise SystemExit(f"Control log directory is unsafe: {entry}")
        for log in entry.iterdir():
            parts = log.name.split(".")
            valid_name = (
                parts[0].startswith("prj_")
                and len(parts[0]) > 4
                and parts[1:] in (["log"], ["log", "1"], ["log", "2"], ["log", "3"])
            )
            if not valid_name:
                raise SystemExit(f"Unknown project log; data was not deleted: {log}")
            _validate_purge_file(log)
            files.append(log)
        directories.append(entry)
    directories.append(path)
    return files, directories


def _validate_purge_file(path: Path) -> None:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_nlink != 1:
        raise SystemExit(f"Control data file is unsafe: {path}")


def _purge_control_data(path: Path, files: list[Path], directories: list[Path]) -> None:
    if not directories:
        return
    try:
        for file in files:
            _validate_purge_file(file)
            file.unlink()
        for directory in directories:
            directory.rmdir()
    except (FileNotFoundError, OSError) as error:
        raise SystemExit(f"Could not safely delete all Control data at {path}: {error}") from error


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
    try:
        rotate_log(log_path)
    except LogRotationError as error:
        raise SystemExit(str(error)) from error
    log_path.touch(mode=0o600, exist_ok=True)
    os.chmod(log_path, 0o600)
    log_handle = log_path.open("ab", buffering=0)
    try:
        process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "opencode_control.cli",
                "_serve",
                "--host",
                host,
                "--port",
                str(port),
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


def _serve(host: str, port: int, pid_path: Path) -> None:
    current = _read_pid(pid_path)
    if current and current != os.getpid() and _is_running(current):
        raise SystemExit(f"OpenCode Control is already running (PID {current})")
    pid_path.write_text(str(os.getpid()), encoding="utf-8")
    os.chmod(pid_path, 0o600)
    try:
        uvicorn.run(
            create_app(), host=host, port=port, log_level="info", log_config=_uvicorn_log_config()
        )
    finally:
        if _read_pid(pid_path) == os.getpid():
            with suppress(FileNotFoundError):
                pid_path.unlink()


def _uvicorn_log_config() -> dict[str, Any]:
    config: dict[str, Any] = deepcopy(uvicorn.config.LOGGING_CONFIG)
    config["formatters"]["default"].update(
        fmt="%(asctime)s %(levelprefix)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
    config["formatters"]["access"].update(
        fmt='%(asctime)s %(levelprefix)s %(client_addr)s - "%(request_line)s" %(status_code)s',
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    return config


def _endpoint(host: str, port: int) -> str:
    browser_host = f"[{host}]" if ":" in host else host
    return f"http://{browser_host}:{port}"


def _open_browser(host: str, port: int) -> None:
    import webbrowser

    webbrowser.open(_endpoint(host, port))


if __name__ == "__main__":
    main()
