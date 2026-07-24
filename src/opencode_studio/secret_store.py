from __future__ import annotations

from pathlib import Path
from typing import Any

from opencode_studio.workspace import (
    WorkspaceRoot,
    delete_file,
    ensure_directory,
    list_regular_files,
    root_identity,
    validate_item_id,
    write_text,
)

_SECRETS_DIRECTORY = Path("secrets")


def list_secrets() -> list[dict[str, Any]]:
    root = _root()
    ensure_directory(root, _SECRETS_DIRECTORY)
    return [
        _secret_metadata(name)
        for name in list_regular_files(root, _SECRETS_DIRECTORY)
        if _valid_name(name)
    ]


def save_secret(name: str, value: str) -> dict[str, Any]:
    item_id = validate_item_id(name)
    root = _root()
    ensure_directory(root, _SECRETS_DIRECTORY)
    write_text(root, _SECRETS_DIRECTORY / item_id, value)
    return _secret_metadata(item_id)


def remove_secret(name: str) -> None:
    item_id = validate_item_id(name)
    delete_file(_root(), _SECRETS_DIRECTORY / item_id)


def _root() -> WorkspaceRoot:
    directory = Path.home() / ".config/opencode"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return root_identity(directory)


def _secret_metadata(name: str) -> dict[str, Any]:
    path = Path.home() / ".config/opencode/secrets" / name
    return {
        "name": name,
        "path": str(path),
        "reference": f"{{file:~/.config/opencode/secrets/{name}}}",
    }


def _valid_name(name: str) -> bool:
    try:
        validate_item_id(name)
    except ValueError:
        return False
    return True
