from __future__ import annotations

import errno
import json
import os
import re
import secrets
import stat
from collections.abc import Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_MAX_TEXT = 2 * 1024 * 1024
_CONFIG_REFERENCE = re.compile(r"^\{(?:env|file):[^{}]+\}$")
_SECRET_MARKERS = (
    "apikey",
    "authorization",
    "clientsecret",
    "credential",
    "password",
    "privatekey",
    "secret",
    "token",
)
_SECRET_CONTAINER_NAMES = {"env", "environment", "headers"}
_SECRET_CONTAINER_WORDS = {
    "auth",
    "authorization",
    "credential",
    "credentials",
    "key",
    "pass",
    "password",
    "pat",
    "secret",
    "token",
}
_REDACTED = "[REDACTED]"


class WorkspaceError(ValueError):
    pass


@dataclass(frozen=True)
class WorkspaceRoot:
    path: Path
    device: int
    inode: int


def validate_item_id(value: str) -> str:
    if not _ID.fullmatch(value):
        raise WorkspaceError(
            "identifier must be 1-64 characters, start with a lowercase Latin letter "
            "(a-z) or digit (0-9), and use only a-z, 0-9, '-' or '_'"
        )
    return value


def resolve_project_root(value: str) -> Path:
    try:
        candidate = Path(value).expanduser()
        lexical = candidate.absolute()
        lexical_stat = lexical.lstat()
        root = lexical.resolve(strict=True)
    except (OSError, RuntimeError) as error:
        raise WorkspaceError("project root is unavailable") from error
    if stat.S_ISLNK(lexical_stat.st_mode):
        raise WorkspaceError("project root cannot be a symlink")
    if not root.is_dir():
        raise WorkspaceError("project root must be an existing directory")
    return root


def root_identity(root: Path) -> WorkspaceRoot:
    try:
        info = root.stat()
    except OSError as error:
        raise WorkspaceError("project root is unavailable") from error
    return WorkspaceRoot(root, info.st_dev, info.st_ino)


def validate_root(root: WorkspaceRoot) -> None:
    with _open_root(root):
        return


def open_root_descriptor(root: WorkspaceRoot) -> int:
    try:
        descriptor = os.open(
            root.path,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
    except OSError as error:
        raise WorkspaceError("project root is unavailable or unsafe") from error
    info = os.fstat(descriptor)
    if info.st_dev != root.device or info.st_ino != root.inode:
        os.close(descriptor)
        raise WorkspaceError("project root identity changed; register it again")
    return descriptor


def read_text(root: WorkspaceRoot, relative: Path, *, missing: str = "") -> str:
    _validate_relative(relative)
    try:
        with _open_parent(root, relative.parent, create=False) as parent_fd:
            descriptor = os.open(
                relative.name,
                os.O_RDONLY | os.O_NOFOLLOW,
                dir_fd=parent_fd,
            )
    except FileNotFoundError:
        return missing
    except OSError as error:
        raise WorkspaceError("workspace file is unavailable or unsafe") from error
    try:
        return _read_descriptor(descriptor)
    finally:
        os.close(descriptor)


def file_exists(root: WorkspaceRoot, relative: Path) -> bool:
    _validate_relative(relative)
    try:
        with _open_parent(root, relative.parent, create=False) as parent_fd:
            info = os.stat(relative.name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return False
    except OSError as error:
        raise WorkspaceError("workspace file is unavailable or unsafe") from error
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1


def write_text(root: WorkspaceRoot, relative: Path, content: str) -> None:
    encoded = content.encode("utf-8")
    if len(encoded) > _MAX_TEXT:
        raise WorkspaceError("workspace file is too large")
    _validate_relative(relative)
    temporary = f".{relative.name}.{secrets.token_hex(12)}"
    with _open_parent(root, relative.parent, create=True) as parent_fd:
        try:
            existing = os.stat(relative.name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(existing.st_mode) or existing.st_nlink != 1:
                raise WorkspaceError("workspace file must be a regular, unlinked file")
        except FileNotFoundError:
            pass
        descriptor = os.open(
            temporary,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW,
            0o600,
            dir_fd=parent_fd,
        )
        try:
            with os.fdopen(descriptor, "wb", closefd=True) as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(
                temporary,
                relative.name,
                src_dir_fd=parent_fd,
                dst_dir_fd=parent_fd,
            )
            os.fsync(parent_fd)
        finally:
            with suppress(FileNotFoundError):
                os.unlink(temporary, dir_fd=parent_fd)


def delete_file(root: WorkspaceRoot, relative: Path) -> None:
    _validate_relative(relative)
    try:
        with _open_parent(root, relative.parent, create=False) as parent_fd:
            info = os.stat(relative.name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                raise WorkspaceError("workspace file must be a regular, unlinked file")
            os.unlink(relative.name, dir_fd=parent_fd)
            os.fsync(parent_fd)
    except FileNotFoundError:
        return
    except OSError as error:
        raise WorkspaceError("workspace file is unavailable or unsafe") from error


def delete_empty_directory(root: WorkspaceRoot, relative: Path) -> None:
    _validate_relative(relative)
    try:
        with _open_parent(root, relative.parent, create=False) as parent_fd:
            info = os.stat(relative.name, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISDIR(info.st_mode):
                raise WorkspaceError("workspace directory is unavailable or unsafe")
            os.rmdir(relative.name, dir_fd=parent_fd)
            os.fsync(parent_fd)
    except FileNotFoundError:
        return
    except OSError as error:
        if error.errno in {errno.ENOTEMPTY, errno.EEXIST}:
            return
        raise WorkspaceError("workspace directory is unavailable or unsafe") from error


def ensure_directory(root: WorkspaceRoot, relative: Path) -> None:
    _validate_relative(relative)
    try:
        with _open_parent(root, relative, create=True) as descriptor:
            os.fchmod(descriptor, 0o700)
    except OSError as error:
        raise WorkspaceError("workspace directory is unavailable or unsafe") from error


def list_regular_files(root: WorkspaceRoot, directory: Path) -> list[str]:
    _validate_relative(directory)
    try:
        context = _open_parent(root, directory, create=False)
        base_fd = context.__enter__()
    except FileNotFoundError:
        return []
    except OSError as error:
        raise WorkspaceError("workspace collection is unavailable or unsafe") from error
    try:
        result: list[str] = []
        for candidate in os.listdir(base_fd):
            try:
                info = os.stat(candidate, dir_fd=base_fd, follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISREG(info.st_mode) and info.st_nlink == 1:
                result.append(candidate)
        return sorted(result)
    finally:
        context.__exit__(None, None, None)


def list_markdown(
    root: WorkspaceRoot, directory: Path, filename: str | None = None
) -> list[dict[str, Any]]:
    _validate_relative(directory)
    try:
        context = _open_parent(root, directory, create=False)
        base_fd = context.__enter__()
    except FileNotFoundError:
        return []
    except OSError as error:
        raise WorkspaceError("workspace collection is unavailable or unsafe") from error
    try:
        items: list[dict[str, Any]] = []
        for candidate in os.listdir(base_fd):
            try:
                if filename is None:
                    if not candidate.endswith(".md"):
                        continue
                    descriptor = os.open(
                        candidate, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=base_fd
                    )
                    item_id = Path(candidate).stem
                else:
                    candidate_fd = os.open(
                        candidate,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=base_fd,
                    )
                    try:
                        descriptor = os.open(
                            filename,
                            os.O_RDONLY | os.O_NOFOLLOW,
                            dir_fd=candidate_fd,
                        )
                    finally:
                        os.close(candidate_fd)
                    item_id = candidate
                try:
                    content = _read_descriptor(descriptor)
                finally:
                    os.close(descriptor)
            except (FileNotFoundError, NotADirectoryError, OSError, WorkspaceError):
                continue
            metadata = parse_frontmatter(content)
            items.append(
                {
                    "id": item_id,
                    "effective_name": metadata.get("name") or item_id,
                    "description": metadata.get("description"),
                    "mode": metadata.get("mode"),
                    "model": metadata.get("model"),
                    "content": content,
                }
            )
        return sorted(items, key=lambda item: str(item["id"]))
    finally:
        context.__exit__(None, None, None)


def list_external_markdown(directory: Path, filename: str | None = None) -> list[dict[str, Any]]:
    """Read metadata from fixed user config directories without following links."""
    try:
        directory_info = directory.lstat()
    except FileNotFoundError:
        return []
    except OSError:
        return []
    if not stat.S_ISDIR(directory_info.st_mode) or stat.S_ISLNK(directory_info.st_mode):
        return []

    items: list[dict[str, Any]] = []
    try:
        candidates = list(directory.iterdir())
    except OSError:
        return []
    for candidate in candidates:
        target = candidate if filename is None else candidate / filename
        if filename is None and candidate.suffix != ".md":
            continue
        try:
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                continue
            content = target.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if len(content.encode("utf-8")) > _MAX_TEXT:
            continue
        metadata = parse_frontmatter(content)
        items.append(
            {
                "id": candidate.stem if filename is None else candidate.name,
                "effective_name": metadata.get("name")
                or (candidate.stem if filename is None else candidate.name),
                "description": metadata.get("description"),
                "mode": metadata.get("mode"),
                "model": metadata.get("model"),
                "content": content,
            }
        )
    return sorted(items, key=lambda item: str(item["id"]))


def read_external_text(path: Path) -> str:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            return ""
        content = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError, UnicodeDecodeError):
        return ""
    return content if len(content.encode("utf-8")) <= _MAX_TEXT else ""


def external_file_exists(path: Path) -> bool:
    try:
        info = path.lstat()
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1


def parse_frontmatter(content: str) -> dict[str, str]:
    if not content.startswith("---\n"):
        return {}
    end = content.find("\n---\n", 4)
    if end < 0:
        return {}
    result: dict[str, str] = {}
    for line in content[4:end].splitlines():
        key, separator, value = line.partition(":")
        if separator and key.strip() in {"name", "description", "mode", "model", "variant"}:
            result[key.strip()] = value.strip().strip('"\'')
    return result


def read_config(root: WorkspaceRoot) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for relative in (Path("opencode.json"), Path("opencode.jsonc")):
        raw = read_text(root, relative, missing="")
        if raw.strip():
            result.update(read_jsonc_config(root, relative))
    return result


def config_target(root: WorkspaceRoot) -> Path:
    if read_text(root, Path("opencode.jsonc"), missing="").strip():
        return Path("opencode.jsonc")
    return Path("opencode.json")


def read_jsonc_config(root: WorkspaceRoot, relative: Path) -> dict[str, Any]:
    raw = read_text(root, relative, missing="{}")
    return _parse_config(_strip_jsonc_comments(raw), str(relative))


def _parse_config(raw: str, name: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise WorkspaceError(f"{name} is not valid JSON") from error
    if not isinstance(value, dict):
        raise WorkspaceError(f"{name} must contain an object")
    return value


def write_config(root: WorkspaceRoot, value: dict[str, Any]) -> None:
    write_json_config(root, config_target(root), value)


def write_json_config(root: WorkspaceRoot, relative: Path, value: dict[str, Any]) -> None:
    write_text(root, relative, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def _strip_jsonc_comments(raw: str) -> str:
    without_comments: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(raw):
        char = raw[index]
        if in_string:
            without_comments.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
            without_comments.append(char)
            index += 1
            continue
        if char == "/" and index + 1 < len(raw) and raw[index + 1] == "/":
            index += 2
            while index < len(raw) and raw[index] not in "\r\n":
                index += 1
            continue
        if char == "/" and index + 1 < len(raw) and raw[index + 1] == "*":
            index += 2
            while index + 1 < len(raw) and raw[index : index + 2] != "*/":
                if raw[index] in "\r\n":
                    without_comments.append(raw[index])
                index += 1
            index = min(index + 2, len(raw))
            continue
        without_comments.append(char)
        index += 1

    cleaned = "".join(without_comments)
    without_trailing_commas: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(cleaned):
        char = cleaned[index]
        if in_string:
            without_trailing_commas.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            index += 1
            continue
        if char == '"':
            in_string = True
        if char == ",":
            lookahead = index + 1
            while lookahead < len(cleaned) and cleaned[lookahead].isspace():
                lookahead += 1
            if lookahead < len(cleaned) and cleaned[lookahead] in "}]":
                index += 1
                continue
        without_trailing_commas.append(char)
        index += 1
    return "".join(without_trailing_commas)


def preserve_redacted(current: Any, proposed: Any) -> Any:
    if proposed == _REDACTED:
        return current
    if isinstance(current, dict) and isinstance(proposed, dict):
        return {
            key: preserve_redacted(current.get(key), value)
            for key, value in proposed.items()
        }
    if isinstance(current, list) and isinstance(proposed, list):
        return [
            preserve_redacted(current[index] if index < len(current) else None, value)
            for index, value in enumerate(proposed)
        ]
    return proposed


def redact_for_browser(value: Any, key: str | None = None, parent: str | None = None) -> Any:
    if isinstance(value, dict):
        return {
            item_key: redact_for_browser(item, str(item_key), key)
            for item_key, item in value.items()
        }
    if isinstance(value, list):
        if _normalized(key) == "command":
            return _redact_command(value)
        return [redact_for_browser(item, key, parent) for item in value]
    if not isinstance(value, str) or value == _REDACTED or _CONFIG_REFERENCE.fullmatch(value):
        return value
    return _REDACTED if _secret_key(key, parent) else value


def _redact_command(value: list[Any]) -> list[Any]:
    result: list[Any] = []
    redact_next = False
    for item in value:
        if not isinstance(item, str):
            result.append(redact_for_browser(item))
            redact_next = False
            continue
        if redact_next:
            result.append(item if _CONFIG_REFERENCE.fullmatch(item) else _REDACTED)
            redact_next = False
            continue
        flag, separator, flag_value = item.partition("=")
        if _secret_cli_flag(flag):
            if separator:
                safe_value = flag_value if _CONFIG_REFERENCE.fullmatch(flag_value) else _REDACTED
                result.append(f"{flag}={safe_value}")
            else:
                result.append(item)
                redact_next = True
            continue
        result.append(item)
    return result


def _secret_cli_flag(value: str) -> bool:
    if not value.startswith("-"):
        return False
    normalized = _normalized(value)
    return any(marker in normalized for marker in _SECRET_MARKERS) or normalized in {
        "key",
        "pat",
    }


def _secret_key(key: str | None, parent: str | None) -> bool:
    normalized = _normalized(key)
    if any(marker in normalized for marker in _SECRET_MARKERS):
        return True
    if _normalized(parent) not in _SECRET_CONTAINER_NAMES:
        return False
    words = {word for word in re.split(r"[^a-z0-9]+", (key or "").lower()) if word}
    return bool(words & _SECRET_CONTAINER_WORDS)


def _normalized(value: str | None) -> str:
    return re.sub(r"[^a-z0-9]", "", (value or "").lower())


def _validate_relative(relative: Path) -> None:
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise WorkspaceError("workspace path is not allowed")


@contextmanager
def _open_root(root: WorkspaceRoot) -> Iterator[int]:
    descriptor = open_root_descriptor(root)
    try:
        yield descriptor
    finally:
        os.close(descriptor)


@contextmanager
def _open_parent(root: WorkspaceRoot, relative: Path, *, create: bool) -> Iterator[int]:
    if relative != Path("."):
        _validate_relative(relative)
    with _open_root(root) as root_fd:
        current_fd = os.dup(root_fd)
        try:
            for part in (() if relative == Path(".") else relative.parts):
                try:
                    next_fd = os.open(
                        part,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=current_fd,
                    )
                except FileNotFoundError:
                    if not create:
                        raise
                    os.mkdir(part, mode=0o700, dir_fd=current_fd)
                    next_fd = os.open(
                        part,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=current_fd,
                    )
                os.close(current_fd)
                current_fd = next_fd
            yield current_fd
        finally:
            os.close(current_fd)


def _read_descriptor(descriptor: int) -> str:
    info = os.fstat(descriptor)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise WorkspaceError("workspace file must be a regular, unlinked file")
    if info.st_size > _MAX_TEXT:
        raise WorkspaceError("workspace file is too large")
    chunks: list[bytes] = []
    remaining = _MAX_TEXT + 1
    while remaining > 0:
        chunk = os.read(descriptor, min(64 * 1024, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    payload = b"".join(chunks)
    if len(payload) > _MAX_TEXT:
        raise WorkspaceError("workspace file is too large")
    try:
        return payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise WorkspaceError("workspace file must be UTF-8") from error
