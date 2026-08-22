from __future__ import annotations

import asyncio
import base64
import binascii
import csv
import hashlib
import io
import ipaddress
import json
import logging
import math
import mimetypes
import re
import secrets
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import zipfile
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from send2trash import send2trash

from opencode_control import __version__
from opencode_control.access import load_or_create_access_token
from opencode_control.command_catalog import (
    LEGACY_REVIEW_COMMAND_CONTENT,
    STARTER_COMMANDS,
    STARTER_COMMANDS_VERSION,
)
from opencode_control.config import ControlConfig
from opencode_control.config_lifecycle import (
    ConfigFile,
    ConfigOperationError,
    ConfigTransactionManager,
    OpenCodeConfigPreflight,
    compatibility_for_version,
)
from opencode_control.git_workspace import (
    GitError,
    git_commit,
    git_diff,
    git_reset,
    git_revert,
    git_stage,
    git_state,
    git_unstage,
)
from opencode_control.opencode_client import OpenCodeClient, OpenCodeError, OpenCodeHTTPError
from opencode_control.processes import OpenCodeProcessManager, ProcessError
from opencode_control.secret_store import list_secrets, remove_secret, save_secret
from opencode_control.skill_import import (
    DownloadedSkill,
    SkillDocument,
    SkillImportError,
    fetch_skill,
    rename_downloaded_skill,
)
from opencode_control.store import ControlStore
from opencode_control.workspace import (
    WorkspaceError,
    WorkspaceRoot,
    WorkspaceTreeFile,
    config_target,
    delete_directory,
    delete_file,
    external_file_exists,
    file_exists,
    list_external_markdown,
    list_markdown,
    parse_frontmatter,
    preserve_redacted,
    read_config,
    read_external_text,
    read_jsonc_config,
    read_text,
    redact_for_browser,
    render_jsonc_update,
    replace_directory,
    resolve_project_root,
    root_identity,
    snapshot_directory,
    validate_item_id,
    validate_root,
    write_text,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ProjectCreate(StrictModel):
    name: str = Field(min_length=1, max_length=100)
    root: str = Field(min_length=1, max_length=4096)
    endpoint: str | None = Field(default=None, max_length=200)


class ProjectUpdate(StrictModel):
    name: str | None = Field(default=None, min_length=1, max_length=100)
    endpoint: str | None = Field(default=None, max_length=200)
    clear_endpoint: bool = False


class SessionCreate(StrictModel):
    title: str | None = Field(default=None, max_length=200)


class Attachment(StrictModel):
    filename: str = Field(min_length=1, max_length=255)
    mime: str = Field(min_length=3, max_length=255)
    data_url: str = Field(min_length=1, max_length=7_500_000)

    @model_validator(mode="after")
    def validate_data_url(self) -> Attachment:
        if any(ord(character) < 32 for character in self.filename) or any(
            separator in self.filename for separator in ("/", "\\")
        ):
            raise ValueError("attachment filename is unsafe")
        if not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*",
            self.mime,
        ):
            raise ValueError("attachment MIME type is invalid")
        prefix = f"data:{self.mime};base64,"
        if not self.data_url.startswith(prefix):
            raise ValueError("attachment data URL does not match its MIME type")
        try:
            decoded = base64.b64decode(self.data_url[len(prefix) :], validate=True)
        except (binascii.Error, ValueError) as error:
            raise ValueError("attachment data URL is not valid base64") from error
        if len(decoded) > 5 * 1024 * 1024:
            raise ValueError("each attachment must be 5 MB or smaller")
        return self


class ArtifactArchivePayload(StrictModel):
    artifact_ids: list[str] = Field(min_length=1, max_length=100)


class ProjectArtifactAction(StrictModel):
    path: str = Field(min_length=1, max_length=4096)


class PromptCreate(StrictModel):
    prompt: str = Field(default="", max_length=200_000)
    agent: str | None = Field(default=None, max_length=128)
    model: str | None = Field(default=None, max_length=256)
    variant: str | None = Field(default=None, max_length=128)
    attachments: list[Attachment] = Field(default_factory=list, max_length=4)
    mentions: list[Annotated[str, Field(min_length=1, max_length=128)]] = Field(
        default_factory=list, max_length=20
    )

    @model_validator(mode="after")
    def validate_content(self) -> PromptCreate:
        if not self.prompt.strip() and not self.attachments:
            raise ValueError("prompt or at least one attachment is required")
        return self


class TaskCreate(PromptCreate):
    title: str = Field(min_length=1, max_length=200)
    cron: str | None = Field(default=None, min_length=9, max_length=100)
    timezone: str = Field(default="UTC", min_length=1, max_length=100)
    cron_session_mode: Literal["new", "reuse"] = "new"

    @model_validator(mode="after")
    def validate_schedule(self) -> TaskCreate:
        if not self.prompt.strip():
            raise ValueError("task prompt is required")
        if self.cron is None:
            return self
        expression = " ".join(self.cron.split())
        if len(expression.split()) != 5 or not croniter.is_valid(expression, strict=True):
            raise ValueError("cron must be a valid five-field expression")
        try:
            ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError as error:
            raise ValueError("timezone is not a valid IANA timezone") from error
        if self.attachments:
            raise ValueError("scheduled tasks cannot store file attachments")
        self.cron = expression
        return self


class TaskScheduleUpdate(StrictModel):
    mode: Literal["manual", "cron"] | None = None
    enabled: bool | None = None
    prompt: str | None = Field(default=None, min_length=1, max_length=200_000)
    mentions: list[str] | None = Field(default=None, max_length=50)
    cron: str | None = Field(default=None, min_length=9, max_length=100)
    timezone: str | None = Field(default=None, min_length=1, max_length=100)
    cron_session_mode: Literal["new", "reuse"] | None = None
    agent: str | None = Field(default=None, max_length=128)
    model: str | None = Field(default=None, max_length=256)
    variant: str | None = Field(default=None, max_length=128)

    @model_validator(mode="after")
    def validate_schedule(self) -> TaskScheduleUpdate:
        if self.prompt is not None and not self.prompt.strip():
            raise ValueError("task prompt is required")
        if self.mentions is not None and any(not item or len(item) > 128 for item in self.mentions):
            raise ValueError("invalid mentioned agent")
        if self.mode is None:
            if (
                self.enabled is None
                or self.cron is not None
                or self.timezone is not None
                or self.cron_session_mode is not None
            ):
                raise ValueError("enabled is required when schedule mode is omitted")
            return self
        if self.mode == "manual":
            if (
                self.cron is not None
                or self.timezone is not None
                or self.cron_session_mode is not None
            ):
                raise ValueError("manual tasks cannot have cron or timezone")
            return self
        if self.cron is None or self.timezone is None:
            raise ValueError("cron and timezone are required for cron mode")
        expression = " ".join(self.cron.split())
        if len(expression.split()) != 5 or not croniter.is_valid(expression, strict=True):
            raise ValueError("cron must be a valid five-field expression")
        try:
            ZoneInfo(self.timezone)
        except ZoneInfoNotFoundError as error:
            raise ValueError("timezone is not a valid IANA timezone") from error
        self.cron = expression
        return self


class TextWrite(StrictModel):
    content: str = Field(max_length=2_000_000)


class ScopedTextWrite(TextWrite):
    scope: Literal["project", "global"] = "project"


class SkillImportPreviewCreate(StrictModel):
    url: str = Field(min_length=1, max_length=4096)
    scope: Literal["project", "global"] = "project"


class SkillImportRename(StrictModel):
    name: str = Field(min_length=1, max_length=64)


class SkillImportConfirm(StrictModel):
    preview_id: str = Field(min_length=32, max_length=128)
    conflict_policy: Literal["skip", "overwrite"] = "skip"


class SkillUpdate(StrictModel):
    name: str = Field(min_length=1, max_length=64)
    content: str = Field(max_length=2 * 1024 * 1024)
    source_scope: Literal["project", "global"]
    target_scope: Literal["project", "global"]


class CommandRun(StrictModel):
    arguments: str = Field(default="", max_length=20_000)
    agent: str | None = Field(default=None, max_length=100)
    model: str | None = Field(default=None, max_length=256)
    variant: str | None = Field(default=None, max_length=128)


class ConfigPatch(StrictModel):
    values: dict[str, Any]


class ScopedConfigPatch(ConfigPatch):
    scope: Literal["project", "global"] = "project"


class McpWrite(StrictModel):
    config: dict[str, Any]
    scope: Literal["project", "global"] = "project"


class McpEnabledWrite(StrictModel):
    enabled: bool
    scope: Literal["project", "global"] = "project"


class ProviderApiAuth(StrictModel):
    key: str = Field(min_length=1, max_length=65_536)
    metadata: dict[str, str] = Field(default_factory=dict, max_length=32)

    @model_validator(mode="after")
    def validate_metadata(self) -> ProviderApiAuth:
        if any(len(key) > 128 or len(value) > 4096 for key, value in self.metadata.items()):
            raise ValueError("provider metadata is too long")
        return self


class ProviderOAuthAuthorize(StrictModel):
    method: int = Field(ge=0, le=100)
    inputs: dict[str, str] = Field(default_factory=dict, max_length=32)

    @model_validator(mode="after")
    def validate_inputs(self) -> ProviderOAuthAuthorize:
        if any(len(key) > 128 or len(value) > 4096 for key, value in self.inputs.items()):
            raise ValueError("provider input is too long")
        return self


class ProviderOAuthCallback(StrictModel):
    method: int = Field(ge=0, le=100)
    code: str | None = Field(default=None, max_length=16_384)


class ProviderConfigWrite(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    base_url: str = Field(min_length=1, max_length=2048)
    models: list[str] = Field(min_length=1, max_length=200)
    api_key: str | None = Field(default=None, max_length=65_536)

    @model_validator(mode="after")
    def validate_provider(self) -> ProviderConfigWrite:
        parsed = urllib.parse.urlsplit(self.base_url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValueError("provider base URL must be HTTP or HTTPS")
        if any(not model.strip() or len(model) > 500 or "\0" in model for model in self.models):
            raise ValueError("provider model ID is invalid")
        return self


class SecretWrite(StrictModel):
    value: str = Field(min_length=1, max_length=65_536)


class PermissionReply(StrictModel):
    reply: Literal["once", "always", "reject"]


class EventReadAll(StrictModel):
    project_id: str | None = Field(default=None, max_length=100)


class GitCommitCreate(StrictModel):
    message: str = Field(min_length=1, max_length=500)
    paths: list[str] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def validate_commit(self) -> GitCommitCreate:
        if not self.message.strip():
            raise ValueError("commit message is required")
        if any(not path or len(path) > 4096 or "\0" in path for path in self.paths):
            raise ValueError("commit path is invalid")
        return self


class GitPathsUpdate(StrictModel):
    paths: list[str] = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def validate_paths(self) -> GitPathsUpdate:
        if any(not path or len(path) > 4096 or "\0" in path for path in self.paths):
            raise ValueError("Git path is invalid")
        return self


class GitCommitTarget(StrictModel):
    commit: str = Field(pattern=r"^[0-9a-fA-F]{7,64}$")


class ControlState:
    def __init__(self, config: ControlConfig) -> None:
        self.config = config
        self.store = ControlStore(config.data_dir)
        try:
            self.access_token = load_or_create_access_token(config.data_dir)
        except Exception:
            self.store.close()
            raise
        self.processes = OpenCodeProcessManager(
            binary=config.opencode_binary,
            data_dir=config.data_dir,
        )
        self.config_transactions = ConfigTransactionManager(config.data_dir)
        self.config_preflight = OpenCodeConfigPreflight(config.opencode_binary, config.data_dir)
        self.config_lock = threading.RLock()
        self.browser_sessions: dict[str, str] = {}
        self.skill_import_previews: dict[str, dict[str, Any]] = {}
        self.skill_import_lock = threading.RLock()
        self.skill_import_slots = threading.BoundedSemaphore(4)
        self.dashboard_cache: dict[tuple[str, str, str], tuple[datetime, dict[str, Any]]] = {}
        self.dashboard_lock = threading.RLock()
        self._command_slots = threading.BoundedSemaphore(8)
        self._command_threads: set[threading.Thread] = set()
        self._command_threads_lock = threading.Lock()
        self._closing = threading.Event()

    def submit_command(
        self,
        operation: Callable[[], None],
        *,
        before_start: Callable[[], object] | None = None,
        on_error: Callable[[Exception], object] | None = None,
    ) -> bool:
        if self._closing.is_set() or not self._command_slots.acquire(blocking=False):
            return False
        try:
            if before_start is not None:
                before_start()
        except Exception:
            self._command_slots.release()
            raise

        def run() -> None:
            try:
                operation()
            except Exception as error:
                logging.getLogger("uvicorn.error").error(
                    "Background OpenCode command failed: %s", error
                )
                if on_error is not None:
                    with suppress(Exception):
                        on_error(error)
            finally:
                self._command_slots.release()
                with self._command_threads_lock:
                    self._command_threads.discard(threading.current_thread())

        worker = threading.Thread(target=run, name="control-command", daemon=True)
        with self._command_threads_lock:
            self._command_threads.add(worker)
        worker.start()
        return True

    def close(self) -> None:
        self._closing.set()
        self._join_command_threads(timeout=1)
        self.processes.shutdown()
        self._join_command_threads(timeout=4)
        self.store.close()

    def _join_command_threads(self, *, timeout: float) -> None:
        deadline = time.monotonic() + timeout
        while True:
            with self._command_threads_lock:
                workers = list(self._command_threads)
            if not workers:
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            workers[0].join(timeout=remaining)


def csrf_guard(
    request: Request,
    x_csrf_token: Annotated[str | None, Header()] = None,
) -> None:
    state = cast(ControlState, request.app.state.control)
    session_id = request.cookies.get("control_session")
    expected = state.browser_sessions.get(session_id or "")
    if expected is None or not secrets.compare_digest(expected, x_csrf_token or ""):
        raise HTTPException(
            status_code=403,
            detail={
                "code": "csrf_session_expired",
                "message": "invalid browser session or CSRF token",
            },
        )


WriteGuard = Annotated[None, Depends(csrf_guard)]


def _global_opencode_configs() -> tuple[WorkspaceRoot, dict[Path, dict[str, Any]]]:
    directory = Path.home() / ".config/opencode"
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = root_identity(directory)
    configs: dict[Path, dict[str, Any]] = {}
    for relative in (Path("opencode.json"), Path("opencode.jsonc")):
        if read_text(root, relative, missing="").strip():
            configs[relative] = read_jsonc_config(root, relative)
    return root, configs


def _project_opencode_configs(root: WorkspaceRoot) -> dict[Path, dict[str, Any]]:
    configs: dict[Path, dict[str, Any]] = {}
    for relative in (Path("opencode.json"), Path("opencode.jsonc")):
        if read_text(root, relative, missing="").strip():
            configs[relative] = read_jsonc_config(root, relative)
    return configs


def _merged_global_mcp(configs: dict[Path, dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for config in configs.values():
        mcp = config.get("mcp")
        if not isinstance(mcp, dict):
            continue
        for name, value in mcp.items():
            if not isinstance(name, str) or not isinstance(value, dict):
                continue
            current = result.get(name)
            result[name] = {**current, **value} if isinstance(current, dict) else dict(value)
    return result


def _global_mcp_target(
    configs: dict[Path, dict[str, Any]], name: str
) -> tuple[Path, dict[str, Any]]:
    for relative in reversed(tuple(configs)):
        mcp = configs[relative].get("mcp")
        if isinstance(mcp, dict) and name in mcp:
            return relative, configs[relative]
    if Path("opencode.jsonc") in configs:
        return Path("opencode.jsonc"), configs[Path("opencode.jsonc")]
    if Path("opencode.json") in configs:
        return Path("opencode.json"), configs[Path("opencode.json")]
    relative = Path("opencode.json")
    config: dict[str, Any] = {}
    configs[relative] = config
    return relative, config


def _project_mcp_target(
    root: WorkspaceRoot, configs: dict[Path, dict[str, Any]], name: str
) -> tuple[Path, dict[str, Any]]:
    for relative in reversed(tuple(configs)):
        mcp = configs[relative].get("mcp")
        if isinstance(mcp, dict) and name in mcp:
            return relative, configs[relative]
    relative = config_target(root)
    config = configs.setdefault(relative, {})
    return relative, config


def _normalize_mcp_config(value: dict[str, Any]) -> dict[str, Any]:
    if set(value) == {"enabled"} and isinstance(value["enabled"], bool):
        return dict(value)

    transport = value.get("transport")
    generic_stdio = transport == "stdio" or (
        transport is None and isinstance(value.get("command"), str) and "args" in value
    )
    if generic_stdio:
        allowed = {
            "name",
            "transport",
            "command",
            "args",
            "env",
            "enabled",
            "timeout",
            "cwd",
        }
        unknown = set(value) - allowed
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"unsupported MCP fields: {', '.join(sorted(unknown))}",
            )
        command = value.get("command")
        args = value.get("args", [])
        environment = value.get("env", {})
        if not isinstance(command, str) or not command.strip():
            raise HTTPException(status_code=422, detail="stdio MCP command is required")
        if not isinstance(args, list) or any(not isinstance(item, str) for item in args):
            raise HTTPException(status_code=422, detail="stdio MCP args must be strings")
        if not isinstance(environment, dict) or any(
            not isinstance(key, str) or not isinstance(item, str)
            for key, item in environment.items()
        ):
            raise HTTPException(status_code=422, detail="stdio MCP env must contain strings")
        result: dict[str, Any] = {
            "type": "local",
            "command": [command, *args],
            "enabled": value.get("enabled", True),
        }
        if environment:
            result["environment"] = environment
        if "timeout" in value:
            result["timeout"] = value["timeout"]
        if "cwd" in value:
            result["cwd"] = value["cwd"]
        return _normalize_mcp_config(result)

    kind = value.get("type")
    if kind == "local":
        allowed = {
            "type",
            "command",
            "environment",
            "env",
            "enabled",
            "timeout",
            "cwd",
        }
        unknown = set(value) - allowed
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"unsupported local MCP fields: {', '.join(sorted(unknown))}",
            )
        command = value.get("command")
        environment = value.get("environment", value.get("env", {}))
        if (
            not isinstance(command, list)
            or not command
            or any(not isinstance(item, str) or not item for item in command)
        ):
            raise HTTPException(
                status_code=422, detail="local MCP command must be a non-empty string array"
            )
        if not isinstance(environment, dict) or any(
            not isinstance(key, str) or not isinstance(item, str)
            for key, item in environment.items()
        ):
            raise HTTPException(
                status_code=422, detail="local MCP environment must contain strings"
            )
        result = {
            "type": "local",
            "command": command,
            "enabled": value.get("enabled", True),
        }
        if environment:
            result["environment"] = environment
        if "timeout" in value:
            result["timeout"] = value["timeout"]
        if "cwd" in value:
            result["cwd"] = value["cwd"]
    elif kind == "remote":
        allowed = {"type", "url", "headers", "oauth", "enabled", "timeout"}
        unknown = set(value) - allowed
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=f"unsupported remote MCP fields: {', '.join(sorted(unknown))}",
            )
        if not isinstance(value.get("url"), str) or not value["url"]:
            raise HTTPException(status_code=422, detail="remote MCP url is required")
        headers = value.get("headers", {})
        if not isinstance(headers, dict) or any(
            not isinstance(key, str) or not isinstance(item, str) for key, item in headers.items()
        ):
            raise HTTPException(status_code=422, detail="remote MCP headers must contain strings")
        result = {key: item for key, item in value.items() if key in allowed}
        result["enabled"] = value.get("enabled", True)
    else:
        raise HTTPException(
            status_code=422,
            detail=(
                'MCP config must use OpenCode type "local"/"remote" or a stdio '
                "descriptor with command and args"
            ),
        )

    if not isinstance(result.get("enabled"), bool):
        raise HTTPException(status_code=422, detail="MCP enabled must be boolean")
    timeout = result.get("timeout")
    if timeout is not None and (
        not isinstance(timeout, int) or isinstance(timeout, bool) or timeout <= 0
    ):
        raise HTTPException(status_code=422, detail="MCP timeout must be a positive integer")
    cwd = result.get("cwd")
    if cwd is not None and not isinstance(cwd, str):
        raise HTTPException(status_code=422, detail="local MCP cwd must be a string")
    return result


def create_app(config: ControlConfig | None = None) -> FastAPI:
    control_config = config or ControlConfig.from_environment()
    state = ControlState(control_config)
    scheduler_stop = asyncio.Event()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        recovery = await asyncio.to_thread(state.config_transactions.recover_pending)
        for result in recovery:
            level = logging.ERROR if result["state"] == "recovery_failed" else logging.WARNING
            logging.getLogger("uvicorn.error").log(level, "Config transaction recovery: %s", result)
        await initialize_project_commands()
        restore = asyncio.create_task(restore_managed_servers())
        scheduler = asyncio.create_task(scheduler_loop())
        try:
            yield
        finally:
            restore.cancel()
            with suppress(asyncio.CancelledError):
                await restore
            scheduler_stop.set()
            await scheduler
            state.close()

    app = FastAPI(title="OpenCode Control", version=__version__, lifespan=lifespan)
    app.state.control = state

    @app.middleware("http")
    async def local_boundary(request: Request, call_next: Any) -> Response:
        host = urllib.parse.urlsplit(f"//{request.headers.get('host', '')}").hostname
        client_host = request.client.host if request.client else ""
        server = request.scope.get("server")
        server_host = str(server[0]) if isinstance(server, (list, tuple)) and server else ""
        if not _local_host(host) or not _local_host(client_host) or not _local_host(server_host):
            return JSONResponse({"detail": "OpenCode Control is loopback-only"}, status_code=400)
        origin = request.headers.get("origin")
        if origin:
            parsed = urllib.parse.urlsplit(origin)
            if not _local_host(parsed.hostname):
                return JSONResponse({"detail": "cross-origin request rejected"}, status_code=403)
        public_api = request.url.path == "/api/v1/health" or (
            request.url.path == "/api/v1/access" and request.method == "POST"
        )
        if request.url.path.startswith("/api/v1/") and not public_api:
            authorization = request.headers.get("authorization", "")
            bearer = authorization[7:] if authorization.startswith("Bearer ") else ""
            cookie = request.cookies.get("control_access", "")
            if not (
                secrets.compare_digest(cookie, state.access_token)
                or secrets.compare_digest(bearer, state.access_token)
            ):
                return JSONResponse(
                    {
                        "detail": {
                            "code": "access_required",
                            "message": "runtime access token is required",
                        }
                    },
                    status_code=401,
                )
        content_length = request.headers.get("content-length")
        try:
            body_size = int(content_length) if content_length else 0
        except ValueError:
            return JSONResponse({"detail": "invalid content length"}, status_code=400)
        if body_size > 32 * 1024 * 1024:
            return JSONResponse({"detail": "request body is too large"}, status_code=413)
        response = cast(Response, await call_next(request))
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        frame_ancestors = (
            "'self'"
            if request.url.path.startswith("/api/v1/artifacts/")
            and request.url.path.endswith("/preview")
            and response.headers.get("content-type", "").startswith("application/pdf")
            else "'none'"
        )
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; font-src 'self'; "
            f"frame-ancestors {frame_ancestors}"
        )
        return response

    def project_or_404(project_id: str) -> dict[str, Any]:
        project = state.store.get_project(project_id)
        if project is None:
            raise HTTPException(status_code=404, detail="project not found")
        return project

    def workspace_for(project: dict[str, Any]) -> WorkspaceRoot:
        device = project.get("root_device")
        inode = project.get("root_inode")
        birthtime_ns = project.get("root_birthtime_ns")
        if not isinstance(device, int) or not isinstance(inode, int):
            raise HTTPException(status_code=409, detail="project root identity is unavailable")
        return WorkspaceRoot(
            Path(str(project["root"])),
            device,
            inode,
            birthtime_ns if isinstance(birthtime_ns, int) else None,
        )

    def ensure_project_commands(project: dict[str, Any]) -> None:
        version = project.get("starter_commands_version")
        if isinstance(version, int) and version >= STARTER_COMMANDS_VERSION:
            return
        workspace = workspace_for(project)
        validate_root(workspace)
        prefix = Path(".opencode/commands")
        for command_id, definition in STARTER_COMMANDS.items():
            target = prefix / f"{command_id}.md"
            if not file_exists(workspace, target):
                write_text(workspace, target, definition["content"])
        legacy_review = prefix / "review.md"
        if read_text(workspace, legacy_review, missing="\0") == LEGACY_REVIEW_COMMAND_CONTENT:
            delete_file(workspace, legacy_review)
        state.store.set_starter_commands_version(str(project["id"]), STARTER_COMMANDS_VERSION)

    async def initialize_project_commands() -> None:
        logger = logging.getLogger("uvicorn.error")
        for project in state.store.list_projects():
            try:
                await asyncio.to_thread(ensure_project_commands, project)
            except (HTTPException, OSError, WorkspaceError) as error:
                logger.error("Could not initialize Commands for %s: %s", project["name"], error)

    def client_for(project_id: str) -> OpenCodeClient:
        project = project_or_404(project_id)
        validate_root(workspace_for(project))
        managed = state.processes.connection(project_id)
        endpoint = managed.endpoint if managed else project.get("endpoint")
        if not endpoint:
            raise HTTPException(status_code=409, detail="OpenCode server is not running")
        try:
            password = managed.password if managed else None
            client = OpenCodeClient(
                str(endpoint),
                str(project["root"]),
                password=password,
                guard=(lambda: state.processes.lease(project_id, managed)) if managed else None,
            )
            if not managed:
                _validate_external_project(client, Path(str(project["root"])))
            return client
        except OpenCodeError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    def managed_client_for_auth(project_id: str) -> OpenCodeClient:
        project_or_404(project_id)
        if state.processes.connection(project_id) is None:
            raise HTTPException(
                status_code=409,
                detail="Подключение провайдера доступно только для управляемого OpenCode server",
            )
        return client_for(project_id)

    def task_client_for(project_id: str) -> OpenCodeClient:
        project = project_or_404(project_id)
        if state.processes.connection(project_id) is None and not project.get("endpoint"):
            workspace = workspace_for(project)
            validate_root(workspace)
            state.processes.start(project_id, workspace)
            state.store.set_managed_enabled(project_id, True)
        return client_for(project_id)

    async def restore_managed_servers() -> None:
        logger = logging.getLogger("uvicorn.error")
        for project in state.store.list_projects():
            if not project.get("managed_enabled") or project.get("endpoint"):
                continue
            project_id = str(project["id"])
            try:
                workspace = workspace_for(project)
                validate_root(workspace)
                await asyncio.to_thread(state.processes.start, project_id, workspace)
                logger.info("Restored managed OpenCode server for %s", project["name"])
            except (HTTPException, OSError, ProcessError, WorkspaceError) as error:
                logger.error(
                    "Could not restore managed OpenCode server for %s: %s",
                    project["name"],
                    error,
                )

    def client_for_session(
        project_id: str, session_id: str, *, missing_ok: bool = False
    ) -> OpenCodeClient | None:
        client = client_for(project_id)
        if not client.ensure_session_directory(session_id, missing_ok=missing_ok):
            return None
        return client

    def restart_changed_resources(
        project: dict[str, Any], scope: Literal["project", "global"]
    ) -> dict[str, dict[str, object]]:
        candidates = state.store.list_projects() if scope == "global" else [project]
        restarted: dict[str, dict[str, object]] = {}
        for candidate in candidates:
            project_id = str(candidate["id"])
            status = state.processes.status(project_id)
            if candidate.get("endpoint") or status["state"] != "running":
                continue
            try:
                workspace = workspace_for(candidate)
                validate_root(workspace)
                restarted_status = state.processes.restart_if_running(project_id, workspace)
                if restarted_status is not None:
                    restarted[project_id] = restarted_status
            except (HTTPException, ProcessError, WorkspaceError) as error:
                detail = error.detail if isinstance(error, HTTPException) else str(error)
                restarted[project_id] = {"state": "error", "detail": detail}
        return restarted

    def browser_session_id(request: Request) -> str:
        session_id = request.cookies.get("control_session")
        if session_id is None or session_id not in state.browser_sessions:
            raise HTTPException(status_code=403, detail="invalid browser session")
        return session_id

    def skill_target(
        project: dict[str, Any], scope: Literal["project", "global"], name: str
    ) -> tuple[WorkspaceRoot, Path, str]:
        if scope == "global":
            directory = Path.home() / ".config/opencode"
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            root = root_identity(directory)
            relative = Path(f"skills/{name}/SKILL.md")
            display = f"~/.config/opencode/{relative}"
        else:
            root = workspace_for(project)
            relative = Path(f".opencode/skills/{name}/SKILL.md")
            display = str(Path(str(project["root"])) / relative)
        return root, relative, display

    def skill_directory(
        project: dict[str, Any], scope: Literal["project", "global"], name: str
    ) -> tuple[WorkspaceRoot, Path]:
        root, skill_file, _ = skill_target(project, scope, name)
        return root, skill_file.parent

    def skill_directory_hash(
        project: dict[str, Any], scope: Literal["project", "global"], name: str
    ) -> tuple[str, bool]:
        root, directory = skill_directory(project, scope, name)
        files = snapshot_directory(root, directory)
        digest = hashlib.sha256()
        if files is None:
            digest.update(b"0\0")
            return digest.hexdigest(), False
        digest.update(b"1\0")
        for path, item in sorted(files.items(), key=lambda pair: str(pair[0])):
            digest.update(path.as_posix().encode())
            digest.update(b"\0")
            digest.update(item.mode.to_bytes(4, "big"))
            digest.update(item.content)
        return digest.hexdigest(), True

    def skill_entries(project: dict[str, Any]) -> list[dict[str, Any]]:
        root = workspace_for(project)
        items: dict[str, dict[str, Any]] = {}
        for directory in (
            Path.home() / ".config/opencode/skills",
            Path.home() / ".claude/skills",
            Path.home() / ".agents/skills",
        ):
            for item in list_external_markdown(directory, filename="SKILL.md"):
                items[str(item["id"])] = {
                    **item,
                    "scope": "global",
                    "source": str(directory),
                    "editable": directory == Path.home() / ".config/opencode/skills",
                }
        for directory in (
            Path(".claude/skills"),
            Path(".agents/skills"),
            Path(".opencode/skills"),
        ):
            for item in list_markdown(root, directory, filename="SKILL.md"):
                items[str(item["id"])] = {
                    **item,
                    "scope": "project",
                    "source": str(Path(str(project["root"])) / directory),
                    "editable": directory == Path(".opencode/skills"),
                }
        return sorted(items.values(), key=lambda item: str(item["id"]))

    def remove_expired_skill_previews() -> None:
        now = datetime.now(UTC)
        expired = [
            preview_id
            for preview_id, preview in state.skill_import_previews.items()
            if cast(datetime, preview["expires_at"]) <= now
        ]
        for preview_id in expired:
            state.skill_import_previews.pop(preview_id, None)

    def skill_conflicts(
        project: dict[str, Any], scope: Literal["project", "global"], document: SkillDocument
    ) -> tuple[dict[str, Any], str]:
        target_sha256, target_exists = skill_directory_hash(project, scope, document.name)
        matches = []
        for item in skill_entries(project):
            effective_name = str(item.get("effective_name") or item["id"])
            if str(item["id"]) != document.name and effective_name != document.name:
                continue
            matches.append(
                {
                    "id": item["id"],
                    "name": effective_name,
                    "scope": item.get("scope"),
                    "source": item.get("source"),
                    "editable": item.get("editable", False),
                }
            )
        return {
            "target_exists": target_exists,
            "matches": matches,
            "has_conflict": target_exists or bool(matches),
        }, target_sha256

    def skill_preview_response(preview_id: str, preview: dict[str, Any]) -> dict[str, Any]:
        project = project_or_404(str(preview["project_id"]))
        downloaded = cast(DownloadedSkill, preview["downloaded"])
        document = downloaded.document
        _, _, target_path = skill_target(project, cast(Any, preview["scope"]), document.name)
        files = [
            {
                "path": file.path,
                "bytes": len(file.content),
                "sha256": file.sha256,
                "executable": bool(file.mode & 0o111),
                "kind": Path(file.path).parts[0] if len(Path(file.path).parts) > 1 else "root",
            }
            for file in downloaded.files
        ]
        return {
            "preview_id": preview_id,
            "expires_at": cast(datetime, preview["expires_at"]).isoformat(),
            "source_url": preview["source_url"],
            "final_url": preview["final_url"],
            "redirects": preview["redirects"],
            "content": document.content,
            "markdown": document.body,
            "sha256": document.sha256,
            "bytes": sum(item["bytes"] for item in files),
            "file_count": len(files),
            "files": files,
            "commit": downloaded.commit,
            "name": document.name,
            "description": document.description,
            "scope": preview["scope"],
            "target_path": target_path,
            "conflict": preview["conflict"],
        }

    def store_skill_preview(
        project: dict[str, Any],
        session_id: str,
        scope: Literal["project", "global"],
        downloaded: DownloadedSkill,
    ) -> dict[str, Any]:
        conflict, target_sha256 = skill_conflicts(project, scope, downloaded.document)
        preview_id = secrets.token_urlsafe(32)
        preview: dict[str, Any] = {
            "project_id": str(project["id"]),
            "session_id": session_id,
            "scope": scope,
            "downloaded": downloaded,
            "source_url": downloaded.source_url,
            "final_url": downloaded.final_url,
            "redirects": downloaded.redirects,
            "target_sha256": target_sha256,
            "conflict": conflict,
            "expires_at": datetime.now(UTC) + timedelta(minutes=5),
            "result": None,
        }
        with state.skill_import_lock:
            remove_expired_skill_previews()
            while len(state.skill_import_previews) >= 64:
                state.skill_import_previews.pop(next(iter(state.skill_import_previews)))
            state.skill_import_previews[preview_id] = preview
        return skill_preview_response(preview_id, preview)

    def get_skill_preview(preview_id: str, project_id: str, session_id: str) -> dict[str, Any]:
        with state.skill_import_lock:
            remove_expired_skill_previews()
            preview = state.skill_import_previews.get(preview_id)
            if preview is None:
                raise HTTPException(status_code=410, detail="Skill preview expired")
            if preview["project_id"] != project_id or preview["session_id"] != session_id:
                raise HTTPException(status_code=404, detail="Skill preview not found")
            return preview

    def raw_config_files(root: WorkspaceRoot, candidates: dict[str, str]) -> dict[str, str]:
        result: dict[str, str] = {}
        for relative in (Path("opencode.json"), Path("opencode.jsonc")):
            key = ConfigFile(root, relative).key
            if key in candidates:
                result[relative.name] = candidates[key]
                continue
            content = read_text(root, relative, missing="")
            if content:
                result[relative.name] = content
        return result

    def apply_config_candidates(
        project: dict[str, Any],
        scope: Literal["project", "global"],
        label: str,
        candidate_files: dict[ConfigFile, str],
    ) -> dict[str, Any]:
        candidates = {config_file.key: content for config_file, content in candidate_files.items()}
        target_projects = state.store.list_projects() if scope == "global" else [project]
        with state.config_lock:
            compatibility = compatibility_for_version(state.config_preflight.version())
            if compatibility["state"] == "incompatible":
                raise ConfigOperationError(
                    422,
                    {
                        "state": "rejected",
                        "message": compatibility["message"],
                        "compatibility": compatibility,
                    },
                )
            global_root, _ = _global_opencode_configs()
            preflight: dict[str, dict[str, object]] = {}
            for candidate_project in target_projects:
                project_id = str(candidate_project["id"])
                try:
                    workspace = workspace_for(candidate_project)
                    result = state.config_preflight.validate(
                        global_files=raw_config_files(global_root, candidates),
                        project_files=raw_config_files(workspace, candidates),
                    )
                    preflight[project_id] = result.as_dict()
                except (OSError, WorkspaceError) as error:
                    preflight[project_id] = {
                        "valid": False,
                        "version": state.config_preflight.version(),
                        "error": str(error),
                    }
            invalid = {
                project_id: result
                for project_id, result in preflight.items()
                if result["valid"] is not True
            }
            if invalid:
                raise ConfigOperationError(
                    422,
                    {
                        "state": "rejected",
                        "message": "OpenCode rejected the candidate configuration",
                        "compatibility": compatibility,
                        "preflight": preflight,
                    },
                )

            running: list[dict[str, Any]] = []
            for candidate_project in target_projects:
                project_id = str(candidate_project["id"])
                if (
                    not candidate_project.get("endpoint")
                    and state.processes.status(project_id)["state"] == "running"
                ):
                    running.append(candidate_project)

            transaction = state.config_transactions.begin(label, list(candidate_files))
            try:
                transaction.write_candidates(candidates)
                transaction.mark_restarting()
                restarts: dict[str, dict[str, object]] = {}
                touched: list[dict[str, Any]] = []
                failure: Exception | None = None
                for candidate_project in running:
                    project_id = str(candidate_project["id"])
                    touched.append(candidate_project)
                    try:
                        workspace = workspace_for(candidate_project)
                        validate_root(workspace)
                        state.processes.stop(project_id)
                        restarts[project_id] = state.processes.start(project_id, workspace)
                    except (OSError, ProcessError, WorkspaceError) as error:
                        failure = error
                        diagnostic = (
                            error.diagnostic.as_dict()
                            if isinstance(error, ProcessError) and error.diagnostic is not None
                            else None
                        )
                        restarts[project_id] = {
                            "state": "error",
                            "detail": str(error),
                            "diagnostic": diagnostic,
                        }
                        break
                if failure is None:
                    transaction.commit()
                    return {
                        "state": "committed",
                        "operation_id": transaction.operation_id,
                        "compatibility": compatibility,
                        "preflight": preflight,
                        "projects": restarts,
                    }

                transaction.rollback()
                restored: dict[str, dict[str, object]] = {}
                rollback_failed = False
                for candidate_project in touched:
                    project_id = str(candidate_project["id"])
                    try:
                        workspace = workspace_for(candidate_project)
                        state.processes.stop(project_id)
                        restored[project_id] = state.processes.start(project_id, workspace)
                    except (OSError, ProcessError, WorkspaceError) as error:
                        rollback_failed = True
                        restored[project_id] = {
                            "state": "error",
                            "detail": str(error),
                        }
                raise ConfigOperationError(
                    500 if rollback_failed else 409,
                    {
                        "state": "rollback_failed" if rollback_failed else "rolled_back",
                        "message": (
                            "Candidate failed and rollback could not restore every server"
                            if rollback_failed
                            else "Candidate failed; previous configuration was restored"
                        ),
                        "operation_id": transaction.operation_id,
                        "compatibility": compatibility,
                        "preflight": preflight,
                        "projects": restarts,
                        "restored": restored,
                    },
                )
            except ConfigOperationError:
                raise
            except Exception as error:
                try:
                    transaction.rollback()
                except Exception as rollback_error:
                    raise ConfigOperationError(
                        500,
                        {
                            "state": "rollback_failed",
                            "message": str(error),
                            "rollback_error": str(rollback_error),
                            "operation_id": transaction.operation_id,
                            "compatibility": compatibility,
                            "preflight": preflight,
                        },
                    ) from error
                raise ConfigOperationError(
                    409,
                    {
                        "state": "rolled_back",
                        "message": str(error),
                        "operation_id": transaction.operation_id,
                        "compatibility": compatibility,
                        "preflight": preflight,
                    },
                ) from error

    def send_task_input(
        client: OpenCodeClient,
        session_id: str,
        task: dict[str, Any],
        prompt: str,
        *,
        attachments: list[dict[str, str]] | None = None,
        marker: str | None = None,
        before_command: Callable[[], object] | None = None,
        on_command_error: Callable[[Exception], object] | None = None,
    ) -> bool:
        invocation = _slash_command(str(task["prompt"]))
        if invocation is not None:
            command, arguments = invocation
            if marker:
                arguments = f"<!-- {marker} -->\n{arguments}".rstrip()
            accepted = state.submit_command(
                lambda: client.run_command(
                    session_id,
                    command,
                    arguments,
                    agent=task.get("agent"),
                    model=task.get("model"),
                    variant=task.get("variant"),
                ),
                before_start=before_command,
                on_error=on_command_error,
            )
            if not accepted:
                raise RuntimeError("too many OpenCode commands are already running")
            return True
        client.prompt_async(
            session_id,
            prompt,
            agent=task.get("agent"),
            model=task.get("model"),
            variant=task.get("variant"),
            attachments=attachments or [],
            mentions=task.get("mentions"),
        )
        return False

    def dispatch_task(
        project_id: str,
        task: dict[str, Any],
        *,
        attachments: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        session_id: str | None = None
        client: OpenCodeClient | None = None
        try:
            client = task_client_for(project_id)
            session = client.create_session(str(task["title"]))
            session_id = str(session["id"])
            state.store.update_task(
                project_id,
                str(task["id"]),
                status="dispatching",
                session_id=session_id,
            )
            state.store.add_task_session(project_id, str(task["id"]), session_id)
            dispatched_prompt = (
                f"Ожидаемый результат: {task['title']}\n\nПодробное задание:\n{task['prompt']}"  # noqa: RUF001
            )
            task_id = str(task["id"])
            background = send_task_input(
                client,
                session_id,
                task,
                dispatched_prompt,
                attachments=attachments or [],
                before_command=lambda: state.store.update_task(
                    project_id, task_id, status="running", session_id=session_id
                ),
                on_command_error=lambda error: state.store.update_task(
                    project_id, task_id, status="failed", error=str(error)
                ),
            )
            updated = (
                state.store.get_task(project_id, task_id)
                if background
                else state.store.update_task(
                    project_id, task_id, status="running", session_id=session_id
                )
            )
            assert updated is not None
            return updated
        except Exception as error:
            if client and session_id:
                with suppress(Exception):
                    client.request(
                        "POST",
                        f"/session/{_segment(session_id)}/abort",
                        body={},
                    )
            with suppress(Exception):
                state.store.update_task(
                    project_id,
                    str(task["id"]),
                    status="failed",
                    error=str(error),
                )
            raise

    def continue_task(project_id: str, task: dict[str, Any]) -> dict[str, Any]:
        session_id = task.get("session_id")
        if not isinstance(session_id, str):
            return dispatch_task(project_id, task)
        try:
            client = task_client_for(project_id)
            if not client.ensure_session_directory(session_id, missing_ok=True):
                return dispatch_task(project_id, task)
            state.store.update_task(
                project_id,
                str(task["id"]),
                status="dispatching",
                session_id=session_id,
            )
            task_id = str(task["id"])
            background = send_task_input(
                client,
                session_id,
                task,
                (
                    f"Продолжи задачу в этой же сессии: {task['title']}\n\n"
                    f"Актуальное задание:\n{task['prompt']}\n\n"
                    "Проверь текущее состояние файлов и выполни очередной запуск."
                ),
                before_command=lambda: state.store.update_task(
                    project_id, task_id, status="running", session_id=session_id
                ),
                on_command_error=lambda error: state.store.update_task(
                    project_id, task_id, status="failed", error=str(error)
                ),
            )
            updated = (
                state.store.get_task(project_id, task_id)
                if background
                else state.store.update_task(
                    project_id,
                    task_id,
                    status="running",
                    session_id=session_id,
                    error=None,
                )
            )
            assert updated is not None
            return updated
        except Exception as error:
            with suppress(Exception):
                state.store.update_task(
                    project_id,
                    str(task["id"]),
                    status="failed",
                    error=str(error),
                )
            raise

    def task_runtime_active(project_id: str, task: dict[str, Any]) -> bool:
        session_id = task.get("session_id")
        if not isinstance(session_id, str):
            return False
        try:
            snapshot = task_client_for(project_id).snapshot()
        except (HTTPException, OpenCodeError, ProcessError):
            return True
        errors = snapshot.get("errors")
        if isinstance(errors, list) and any(
            error in {"sessions_unavailable", "statuses_unavailable"} for error in errors
        ):
            return True
        statuses = snapshot.get("statuses")
        status = statuses.get(session_id) if isinstance(statuses, dict) else None
        value = status.get("type") or status.get("status") if isinstance(status, dict) else None
        return value in {"busy", "dispatching", "in_progress", "pending", "queued", "running"}

    def dispatch_scheduled_run(run: dict[str, Any], task: dict[str, Any], lease_token: str) -> None:
        project_id = str(run["project_id"])
        run_id = str(run["id"])
        session_id: str | None = None
        attached = False
        client: OpenCodeClient | None = None
        try:
            client = task_client_for(project_id)
            existing = task.get("session_id")
            if (
                task.get("cron_session_mode") == "reuse"
                and isinstance(existing, str)
                and client.ensure_session_directory(existing, missing_ok=True)
            ):
                session_id = existing
            else:
                if not state.store.mark_scheduled_run_creating(run_id, lease_token):
                    raise RuntimeError("scheduled run lease changed before session creation")
                session = client.create_session(str(task["title"]))
                session_id = str(session["id"])
            attached = state.store.attach_scheduled_run_session(run_id, lease_token, session_id)
            if not attached:
                raise RuntimeError("scheduled run lease changed before session attachment")
            marker = f"<!-- opencode-control-run:{run_id} -->"
            if task.get("cron_session_mode") == "reuse" and session_id == existing:
                prompt = (
                    f"{marker}\nПродолжи задачу в этой же сессии: {task['title']}\n\n"  # noqa: RUF001
                    f"Актуальное задание:\n{task['prompt']}\n\n"
                    "Проверь текущее состояние файлов и выполни очередной запуск."
                )
            else:
                prompt = (
                    f"{marker}\nОжидаемый результат: {task['title']}\n\n"  # noqa: RUF001
                    f"Подробное задание:\n{task['prompt']}"
                )

            def mark_running() -> None:
                if not state.store.mark_scheduled_run_running(run_id, lease_token):
                    raise RuntimeError("scheduled run lease changed before command dispatch")

            background = send_task_input(
                client,
                session_id,
                task,
                prompt,
                marker=f"opencode-control-run:{run_id}",
                before_command=mark_running,
                on_command_error=lambda error: state.store.finish_scheduled_run(
                    run_id, "failed", str(error)
                ),
            )
            if not background and not state.store.mark_scheduled_run_running(run_id, lease_token):
                raise RuntimeError("scheduled run lease changed after prompt dispatch")
        except Exception as error:
            detail = str(error)
            if attached:
                state.store.mark_scheduled_run_ambiguous(run_id, lease_token, detail)
            else:
                state.store.finish_scheduled_run(run_id, "failed", detail)
                if client is not None and session_id is not None:
                    with suppress(Exception):
                        client.delete_session(session_id, missing_ok=True)
            raise

    def reconcile_scheduled_runs() -> None:
        logger = logging.getLogger("uvicorn.error")
        active_states = {
            "busy",
            "dispatching",
            "in_progress",
            "pending",
            "queued",
            "running",
        }
        now = datetime.now(UTC)
        for run in state.store.active_scheduled_runs():
            project_id = str(run["project_id"])
            session_id = run.get("session_id")
            if not isinstance(session_id, str):
                state.store.finish_scheduled_run(
                    str(run["id"]), "failed", "scheduled run has no session"
                )
                continue
            try:
                client = task_client_for(project_id)
                snapshot = client.snapshot()
            except (HTTPException, OpenCodeError, ProcessError) as exception:
                logger.warning("Could not reconcile scheduled run %s: %s", run["id"], exception)
                continue
            errors = snapshot.get("errors")
            if isinstance(errors, list) and any(
                error in {"sessions_unavailable", "statuses_unavailable"} for error in errors
            ):
                continue
            statuses = snapshot.get("statuses")
            status = statuses.get(session_id, {}) if isinstance(statuses, dict) else {}
            value = status.get("type") or status.get("status") if isinstance(status, dict) else None
            if value in active_states:
                state.store.reconcile_scheduled_run_running(str(run["id"]))
                continue
            if value == "stalled":
                detail = status.get("error") if isinstance(status, dict) else None
                state.store.finish_scheduled_run(
                    str(run["id"]),
                    "stalled",
                    str(detail or "OpenCode session has no message progress"),
                )
                continue
            if value in {"error", "failed"}:
                failure = status.get("error") if isinstance(status, dict) else None
                state.store.finish_scheduled_run(
                    str(run["id"]), "failed", str(failure or "OpenCode session failed")
                )
                continue
            sessions = {
                item.get("id") for item in snapshot.get("sessions", []) if isinstance(item, dict)
            }
            try:
                age = (now - datetime.fromisoformat(str(run["updated_at"]))).total_seconds()
            except ValueError:
                age = 0
            if age < 3:
                continue
            if session_id not in sessions:
                state.store.finish_scheduled_run(
                    str(run["id"]), "failed", "OpenCode session disappeared"
                )
                continue
            if run["status"] == "running":
                state.store.finish_scheduled_run(str(run["id"]), "completed")
                continue
            marker = f"opencode-control-run:{run['id']}"
            try:
                messages = client.session_messages(session_id)
            except OpenCodeError as error:
                logger.warning("Could not inspect scheduled run %s messages: %s", run["id"], error)
                continue
            if marker in json.dumps(messages, ensure_ascii=False):
                state.store.finish_scheduled_run(str(run["id"]), "completed")
            else:
                state.store.finish_scheduled_run(
                    str(run["id"]),
                    "failed",
                    "Control restarted before the scheduled prompt was accepted",
                )

    def run_scheduler_cycle() -> None:
        logger = logging.getLogger("uvicorn.error")
        now = datetime.now(UTC)
        reconcile_scheduled_runs()
        for candidate in state.store.due_tasks(now.isoformat()):
            expression = candidate.get("cron")
            timezone = candidate.get("timezone")
            expected = candidate.get("next_run_at")
            if (
                not isinstance(expression, str)
                or not isinstance(timezone, str)
                or not isinstance(expected, str)
            ):
                continue
            next_run = _next_cron_run(expression, timezone, now)
            try:
                overdue = now - datetime.fromisoformat(expected).astimezone(UTC)
            except ValueError:
                continue
            if overdue > timedelta(minutes=2):
                state.store.skip_overdue_scheduled_run(
                    str(candidate["project_id"]),
                    str(candidate["id"]),
                    expected_run_at=expected,
                    next_run_at=next_run,
                    created_at=now.isoformat(),
                    reason="Control was offline when this run was scheduled",
                )
                continue
            run = state.store.materialize_scheduled_run(
                str(candidate["project_id"]),
                str(candidate["id"]),
                expected_run_at=expected,
                next_run_at=next_run,
                created_at=now.isoformat(),
            )
            if run is None:
                continue
        for pending in state.store.claimable_scheduled_runs(now.isoformat()):
            lease_token = secrets.token_urlsafe(24)
            run = state.store.claim_scheduled_run(
                str(pending["id"]),
                lease_token=lease_token,
                lease_expires_at=(now + timedelta(minutes=2)).isoformat(),
                claimed_at=now.isoformat(),
            )
            if run is None:
                continue
            current = state.store.get_task(str(run["project_id"]), str(run["task_id"]))
            if current is None:
                state.store.finish_scheduled_run(str(run["id"]), "cancelled")
                continue
            previous_run = state.store.active_scheduled_run_for_task(
                str(run["project_id"]),
                str(run["task_id"]),
                exclude_run_id=str(run["id"]),
            )
            if previous_run is not None:
                state.store.finish_scheduled_run(str(run["id"]), "skipped", "overlap")
                continue
            if current["status"] in {"queued", "dispatching", "running"}:
                if task_runtime_active(str(run["project_id"]), current):
                    state.store.finish_scheduled_run(str(run["id"]), "skipped", "overlap")
                    continue
                updated = state.store.update_task(
                    str(run["project_id"]),
                    str(run["task_id"]),
                    status="scheduled",
                )
                if updated is None:
                    continue
                current = updated
            try:
                dispatch_scheduled_run(run, current, lease_token)
            except Exception:
                logger.exception("Scheduled run %s failed during dispatch", run["id"])

    async def scheduler_loop() -> None:
        state.store.recover_interrupted_scheduled_runs()
        while not scheduler_stop.is_set():
            try:
                await asyncio.to_thread(run_scheduler_cycle)
                for project in state.store.list_projects():
                    await asyncio.to_thread(reconcile_project_tasks, str(project["id"]))
            except Exception:
                logging.getLogger("uvicorn.error").exception("Scheduled task cycle failed")
            with suppress(TimeoutError):
                await asyncio.wait_for(scheduler_stop.wait(), timeout=15)

    @app.exception_handler(WorkspaceError)
    async def workspace_error(request: Request, error: WorkspaceError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.exception_handler(ConfigOperationError)
    async def config_operation_error(request: Request, error: ConfigOperationError) -> JSONResponse:
        payload = cast(dict[str, Any], redact_for_browser(error.result))
        return JSONResponse(
            {**payload, "detail": payload},
            status_code=error.status_code,
        )

    @app.exception_handler(OpenCodeError)
    async def opencode_error(request: Request, error: OpenCodeError) -> JSONResponse:
        status = error.status if isinstance(error, OpenCodeHTTPError) else 502
        return JSONResponse({"detail": str(error)}, status_code=status)

    @app.exception_handler(ProcessError)
    async def process_error(request: Request, error: ProcessError) -> JSONResponse:
        payload: dict[str, Any] = {"message": str(error)}
        if error.diagnostic is not None:
            payload["diagnostic"] = redact_for_browser(error.diagnostic.as_dict())
        return JSONResponse({"detail": payload}, status_code=502)

    @app.get("/api/v1/session")
    def browser_session(request: Request, response: Response) -> dict[str, str]:
        session_id = request.cookies.get("control_session")
        if session_id not in state.browser_sessions:
            if len(state.browser_sessions) >= 256:
                state.browser_sessions.pop(next(iter(state.browser_sessions)))
            session_id = secrets.token_urlsafe(24)
            state.browser_sessions[session_id] = secrets.token_urlsafe(32)
        response.set_cookie(
            "control_session",
            session_id,
            httponly=True,
            samesite="strict",
            secure=False,
            path="/",
        )
        return {"csrf_token": state.browser_sessions[session_id], "product": "OpenCode Control"}

    @app.post("/api/v1/access", status_code=204)
    def authorize_runtime(authorization: Annotated[str | None, Header()] = None) -> Response:
        value = authorization or ""
        supplied = value[7:] if value.startswith("Bearer ") else ""
        if not secrets.compare_digest(supplied, state.access_token):
            raise HTTPException(status_code=403, detail="invalid runtime access token")
        response = Response(status_code=204)
        response.set_cookie(
            "control_access",
            state.access_token,
            httponly=True,
            samesite="strict",
            secure=False,
            max_age=365 * 24 * 60 * 60,
            path="/",
        )
        return response

    @app.get("/api/v1/access")
    def runtime_access() -> dict[str, bool]:
        return {"authenticated": True}

    @app.get("/api/v1/health")
    def health() -> dict[str, Any]:
        return {
            "healthy": True,
            "version": __version__,
        }

    @app.get("/api/v1/events")
    def events(
        project_id: str | None = None,
        sync_project_id: str | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 40,
    ) -> dict[str, Any]:
        available_session_ids: set[str] | None = None
        if project_id is not None:
            project_or_404(project_id)
        if sync_project_id is not None:
            project_or_404(sync_project_id)
            with suppress(HTTPException, OpenCodeError, ProcessError):
                snapshot = project_snapshot(sync_project_id)
                sessions = snapshot.get("sessions")
                if isinstance(sessions, list):
                    available_session_ids = {
                        str(item["id"])
                        for item in sessions
                        if isinstance(item, dict) and isinstance(item.get("id"), str)
                    }
        result = state.store.list_events(project_id=project_id, limit=limit)
        if sync_project_id is not None and available_session_ids is not None:
            result["events"] = [
                {
                    **event,
                    "session_id": None,
                }
                if event.get("project_id") == sync_project_id
                and isinstance(event.get("session_id"), str)
                and event["session_id"] not in available_session_ids
                else event
                for event in result["events"]
            ]
        return result

    @app.post("/api/v1/events/{event_id}/read")
    def read_event(event_id: str, guard: WriteGuard) -> dict[str, bool]:
        if not state.store.mark_event_read(event_id):
            raise HTTPException(status_code=404, detail="event not found")
        return {"read": True}

    @app.post("/api/v1/events/read-all")
    def read_all_events(payload: EventReadAll, guard: WriteGuard) -> dict[str, int]:
        if payload.project_id is not None:
            project_or_404(payload.project_id)
        return {"read": state.store.mark_events_read(project_id=payload.project_id)}

    def managed_server_status(project_id: str) -> dict[str, object]:
        status = state.processes.status(project_id)
        version = status.get("version")
        status["compatibility"] = compatibility_for_version(
            version if isinstance(version, str) else state.config_preflight.version()
        )
        last_error = status.get("last_error")
        if isinstance(last_error, dict):
            timestamp = last_error.get("timestamp")
            project = state.store.get_project(project_id)
            if isinstance(timestamp, str) and project is not None:
                state.store.record_event(
                    dedupe_key=f"server:{project_id}:error:{timestamp}",
                    project_id=project_id,
                    kind="server_failed",
                    severity="error",
                    resource_title=str(project["name"]),
                    detail=str(last_error.get("summary") or "OpenCode server failed"),
                    occurred_at=timestamp,
                    unread=True,
                )
        return status

    @app.get("/api/v1/compatibility")
    def compatibility() -> dict[str, str | None]:
        return compatibility_for_version(state.config_preflight.version())

    @app.get("/api/v1/projects")
    def projects() -> list[dict[str, Any]]:
        return [
            _project_view(item, managed_server_status(str(item["id"])))
            for item in state.store.list_projects()
        ]

    @app.get("/api/v1/projects/{project_id}/media")
    def project_media(
        project_id: str,
        path: Annotated[str, Query(min_length=1, max_length=4096)],
        download: bool = False,
    ) -> Response:
        project = project_or_404(project_id)
        root = Path(str(project["root"]))
        try:
            media_path, stat_result = _safe_project_media(root, path)
        except HTTPException as error:
            if error.status_code == 404 and not download and _safe_missing_media_path(root, path):
                return Response(
                    content=_MISSING_IMAGE_SVG,
                    media_type="image/svg+xml",
                    headers={
                        "Cache-Control": "no-store",
                        "Content-Security-Policy": "sandbox; default-src 'none'",
                        "X-Content-Type-Options": "nosniff",
                    },
                )
            raise
        media_type = mimetypes.guess_type(media_path.name)[0] or "application/octet-stream"
        return FileResponse(
            media_path,
            media_type=media_type,
            filename=media_path.name,
            stat_result=stat_result,
            content_disposition_type="attachment" if download else "inline",
            headers={
                "Cache-Control": "private, max-age=3600",
                "Content-Security-Policy": "sandbox; default-src 'none'",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/api/v1/projects/{project_id}/artifact")
    def project_artifact_file(
        project_id: str,
        path: Annotated[str, Query(min_length=1, max_length=4096)],
    ) -> FileResponse:
        project = project_or_404(project_id)
        artifact_path, stat_result, _, media_type = _safe_project_artifact(
            Path(str(project["root"])), path
        )
        return FileResponse(
            artifact_path,
            media_type=media_type,
            filename=artifact_path.name,
            stat_result=stat_result,
            content_disposition_type="attachment",
            headers={
                "Cache-Control": "private, max-age=3600",
                "Content-Security-Policy": "sandbox; default-src 'none'",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.post("/api/v1/projects/{project_id}/artifact/reveal")
    def reveal_project_artifact(project_id: str, payload: ProjectArtifactAction) -> dict[str, Any]:
        project = project_or_404(project_id)
        path, _, _, _ = _safe_project_artifact(Path(str(project["root"])), payload.path)
        _reveal_file(path)
        return {"revealed": True, "name": path.name}

    @app.post("/api/v1/projects/{project_id}/artifact/trash")
    def trash_project_artifact(project_id: str, payload: ProjectArtifactAction) -> dict[str, Any]:
        project = project_or_404(project_id)
        path, _, _, _ = _safe_project_artifact(Path(str(project["root"])), payload.path)
        _move_to_trash(path)
        return {"trashed": True, "name": path.name}

    def sync_search_project(project: dict[str, Any]) -> int:
        project_id = str(project["id"])
        client = client_for(project_id)
        sessions = client.sessions()
        versions = state.store.search_session_versions(project_id)
        session_ids = {str(session["id"]) for session in sessions}
        indexed = 0
        for session in sessions:
            session_id = str(session["id"])
            title = str(session.get("title") or "")[:200]
            raw_time = session.get("time")
            raw_updated = raw_time.get("updated") if isinstance(raw_time, dict) else None
            updated_at = (
                float(raw_updated)
                if isinstance(raw_updated, (int, float)) and math.isfinite(raw_updated)
                else None
            )
            if updated_at is not None and versions.get(session_id) == (updated_at, title, 1):
                continue
            messages = client.session_messages(session_id)
            state.store.replace_search_session(
                project_id,
                session_id=session_id,
                title=title,
                parent_id=str(session["parentID"])
                if isinstance(session.get("parentID"), str)
                else None,
                updated_at=updated_at,
                messages=_search_message_entries(messages),
            )
            indexed += 1
        state.store.prune_search_sessions(project_id, session_ids)
        return indexed

    @app.get("/api/v1/search")
    def search_history(
        q: Annotated[str, Query(min_length=2, max_length=200)],
        scope: Literal["project", "global"] = "project",
        project_id: str | None = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
    ) -> dict[str, Any]:
        query = q.strip()
        if len(query) < 2:
            raise HTTPException(status_code=422, detail="search query is too short")
        if scope == "project":
            selected_projects = [project_or_404(project_id or "")]
        else:
            selected_projects = state.store.list_projects()
        unavailable: list[dict[str, str]] = []
        indexed_sessions = 0
        for project in selected_projects:
            try:
                indexed_sessions += sync_search_project(project)
            except (HTTPException, OpenCodeError, ProcessError, WorkspaceError) as error:
                detail = error.detail if isinstance(error, HTTPException) else str(error)
                unavailable.append(
                    {
                        "id": str(project["id"]),
                        "name": str(project["name"]),
                        "error": str(detail),
                    }
                )
        selected_ids = [str(project["id"]) for project in selected_projects]
        rows = state.store.search_history(query, selected_ids, limit=limit + 1, offset=offset)
        project_names = {str(project["id"]): str(project["name"]) for project in selected_projects}
        return {
            "query": query,
            "scope": scope,
            "partial": bool(unavailable),
            "unavailable_projects": unavailable,
            "indexed_sessions": indexed_sessions,
            "offset": offset,
            "has_more": len(rows) > limit,
            "results": [
                {
                    "kind": row["kind"],
                    "project_id": row["project_id"],
                    "project_name": project_names.get(str(row["project_id"]), ""),
                    "session_id": row["session_id"],
                    "session_title": row["title"],
                    "message_id": row["message_id"],
                    "role": row["role"],
                    "created_at": row["occurred_at"],
                    "snippet": _search_snippet(str(row["content"]), query),
                }
                for row in rows[:limit]
            ],
        }

    @app.get("/api/v1/artifacts")
    def artifacts(
        scope: Literal["project", "global"] = "project",
        project_id: str | None = None,
        limit: Annotated[int, Query(ge=1, le=500)] = 200,
    ) -> dict[str, Any]:
        if scope == "project":
            selected_projects = [project_or_404(project_id or "")]
        else:
            selected_projects = state.store.list_projects()
        unavailable: list[dict[str, str]] = []
        indexed_sessions = 0
        for project in selected_projects:
            try:
                indexed_sessions += sync_search_project(project)
            except (HTTPException, OpenCodeError, ProcessError, WorkspaceError) as error:
                detail = error.detail if isinstance(error, HTTPException) else str(error)
                unavailable.append(
                    {
                        "id": str(project["id"]),
                        "name": str(project["name"]),
                        "error": str(detail),
                    }
                )
        project_by_id = {str(project["id"]): project for project in selected_projects}
        results: list[dict[str, Any]] = []
        seen: set[tuple[str, str]] = set()
        for row in artifact_rows(project_by_id):
            project = project_by_id[str(row["project_id"])]
            try:
                media_path, stat_result, kind, media_type = _safe_project_artifact(
                    Path(str(project["root"])), str(row["artifact_path"])
                )
            except HTTPException:
                continue
            key = (str(project["id"]), str(media_path))
            if key in seen:
                continue
            seen.add(key)
            query = urllib.parse.urlencode({"path": str(row["artifact_path"])})
            media_url = (
                f"/api/v1/projects/{project['id']}/media?{query}" if kind == "image" else None
            )
            download_url = f"/api/v1/projects/{project['id']}/artifact?{query}"
            results.append(
                {
                    "id": _artifact_id(str(project["id"]), media_path),
                    "kind": kind,
                    "name": media_path.name,
                    "mime": media_type,
                    "size": stat_result.st_size,
                    "modified_at": stat_result.st_mtime * 1000,
                    "created_at": row["created_at"],
                    "project_id": project["id"],
                    "project_name": project["name"],
                    "session_id": row.get("session_id"),
                    "session_title": row.get("title"),
                    "message_id": row.get("message_id"),
                    "media_url": media_url,
                    "download_url": download_url,
                }
            )
            if len(results) >= limit:
                break
        return {
            "scope": scope,
            "partial": bool(unavailable),
            "unavailable_projects": unavailable,
            "indexed_sessions": indexed_sessions,
            "has_more": len(results) >= limit,
            "artifacts": results,
        }

    @app.post("/api/v1/artifacts/archive")
    def artifact_archive(payload: ArtifactArchivePayload) -> Response:
        wanted = set(payload.artifact_ids)
        if len(wanted) != len(payload.artifact_ids):
            raise HTTPException(status_code=422, detail="artifact IDs must be unique")
        projects = {str(item["id"]): item for item in state.store.list_projects()}
        selected: list[tuple[Path, str]] = []
        total_size = 0
        for row in artifact_rows(projects):
            project = projects[str(row["project_id"])]
            try:
                path, stat_result, _, _ = _safe_project_artifact(
                    Path(str(project["root"])), str(row["artifact_path"])
                )
            except HTTPException:
                continue
            artifact_id = _artifact_id(str(project["id"]), path)
            if artifact_id not in wanted:
                continue
            total_size += stat_result.st_size
            if total_size > 100 * 1024 * 1024:
                raise HTTPException(status_code=413, detail="selected artifacts exceed 100 MB")
            relative = path.relative_to(Path(str(project["root"])).resolve(strict=True))
            project_name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(project["name"])).strip("-")
            selected.append((path, f"{project_name or project['id']}/{relative.as_posix()}"))
        if len(selected) != len(wanted):
            raise HTTPException(
                status_code=404,
                detail="one or more selected artifacts are unavailable",
            )
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
            for path, archive_name in selected:
                bundle.write(path, archive_name)
        return Response(
            content=archive.getvalue(),
            media_type="application/zip",
            headers={
                "Content-Disposition": 'attachment; filename="opencode-artifacts.zip"',
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @app.get("/api/v1/artifacts/{artifact_id}/preview")
    def artifact_preview(artifact_id: str) -> Response:
        _, _, path, stat_result, kind, media_type = resolve_artifact(artifact_id)
        if kind in {"image", "pdf"}:
            return FileResponse(
                path,
                media_type=media_type,
                filename=path.name,
                stat_result=stat_result,
                content_disposition_type="inline",
                headers={
                    "Cache-Control": "private, max-age=3600",
                    "X-Content-Type-Options": "nosniff",
                },
            )
        if kind == "archive":
            try:
                with zipfile.ZipFile(path) as bundle:
                    infos = bundle.infolist()
            except (OSError, zipfile.BadZipFile) as error:
                raise HTTPException(status_code=415, detail="ZIP archive is invalid") from error
            total_size = sum(info.file_size for info in infos)
            entries = [
                {
                    "name": info.filename,
                    "size": info.file_size,
                    "compressed_size": info.compress_size,
                    "directory": info.is_dir(),
                    "unsafe": Path(info.filename).is_absolute()
                    or ".." in Path(info.filename).parts,
                }
                for info in infos[:1000]
            ]
            return JSONResponse(
                {
                    "kind": kind,
                    "name": path.name,
                    "mime": media_type,
                    "size": stat_result.st_size,
                    "entries": entries,
                    "entry_count": len(infos),
                    "total_size": total_size,
                    "truncated": len(infos) > len(entries),
                    "suspicious": total_size > 1024 * 1024 * 1024,
                }
            )
        preview_limit = 1024 * 1024
        with path.open("rb") as handle:
            raw = handle.read(preview_limit + 1)
        truncated = len(raw) > preview_limit
        try:
            content = raw[:preview_limit].decode("utf-8")
        except UnicodeDecodeError as error:
            raise HTTPException(status_code=415, detail="text preview is not UTF-8") from error
        suffix = path.suffix.lower()
        if suffix == ".json" and not truncated:
            try:
                content = json.dumps(json.loads(content), ensure_ascii=False, indent=2)
            except json.JSONDecodeError as error:
                raise HTTPException(status_code=415, detail="JSON artifact is invalid") from error
        if suffix == ".csv":
            reader = csv.reader(io.StringIO(content))
            rows = [row[:100] for _, row in zip(range(1001), reader, strict=False)]
            header = rows[0] if rows else []
            return JSONResponse(
                {
                    "kind": kind,
                    "format": "csv",
                    "name": path.name,
                    "mime": media_type,
                    "size": stat_result.st_size,
                    "columns": header,
                    "rows": rows[1:1001],
                    "truncated": truncated or len(rows) > 1000,
                }
            )
        return JSONResponse(
            {
                "kind": kind,
                "format": (
                    "markdown" if suffix == ".md" else "json" if suffix == ".json" else "text"
                ),
                "name": path.name,
                "mime": media_type,
                "size": stat_result.st_size,
                "content": content,
                "truncated": truncated,
            }
        )

    @app.post("/api/v1/artifacts/{artifact_id}/reveal")
    def reveal_artifact(artifact_id: str) -> dict[str, Any]:
        _, _, path, _, _, _ = resolve_artifact(artifact_id)
        _reveal_file(path)
        return {"revealed": True, "name": path.name}

    @app.post("/api/v1/artifacts/{artifact_id}/trash")
    def trash_artifact(artifact_id: str) -> dict[str, Any]:
        _, _, path, _, _, _ = resolve_artifact(artifact_id)
        _move_to_trash(path)
        return {"trashed": True, "name": path.name}

    @app.post("/api/v1/artifacts/trash")
    def trash_artifacts(payload: ArtifactArchivePayload) -> dict[str, Any]:
        wanted = list(dict.fromkeys(payload.artifact_ids))
        if len(wanted) != len(payload.artifact_ids):
            raise HTTPException(status_code=422, detail="artifact IDs must be unique")
        trashed: list[str] = []
        errors: list[dict[str, str]] = []
        for artifact_id in wanted:
            try:
                _, _, path, _, _, _ = resolve_artifact(artifact_id)
                _move_to_trash(path)
                trashed.append(artifact_id)
            except HTTPException as error:
                errors.append({"id": artifact_id, "error": str(error.detail)})
        return {"trashed_ids": trashed, "errors": errors}

    def artifact_rows(projects: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        rows = state.store.list_artifacts(list(projects))
        for project in projects.values():
            root = Path(str(project["root"]))
            directory = root / ".opencode" / "artifacts"
            if not directory.is_dir() or directory.is_symlink():
                continue
            for path in directory.rglob("*"):
                if not path.is_file() or path.is_symlink():
                    continue
                try:
                    relative = path.relative_to(root)
                    stat_result = path.stat()
                except (OSError, ValueError):
                    continue
                rows.append(
                    {
                        "project_id": project["id"],
                        "session_id": None,
                        "message_id": None,
                        "artifact_path": relative.as_posix(),
                        "created_at": stat_result.st_mtime * 1000,
                        "title": None,
                    }
                )
        return sorted(
            rows,
            key=lambda row: (float(row.get("created_at") or 0), str(row["artifact_path"])),
            reverse=True,
        )

    def resolve_artifact(
        artifact_id: str,
    ) -> tuple[dict[str, Any], dict[str, Any], Path, Any, str, str]:
        projects = {str(item["id"]): item for item in state.store.list_projects()}
        for row in artifact_rows(projects):
            project = projects[str(row["project_id"])]
            try:
                path, stat_result, kind, media_type = _safe_project_artifact(
                    Path(str(project["root"])), str(row["artifact_path"])
                )
            except HTTPException:
                continue
            if _artifact_id(str(project["id"]), path) == artifact_id:
                return project, row, path, stat_result, kind, media_type
        raise HTTPException(status_code=404, detail="artifact was not found")

    def invalidate_dashboard_cache(project_id: str) -> None:
        with state.dashboard_lock:
            for key in list(state.dashboard_cache):
                if key[0] in {project_id, "*"}:
                    state.dashboard_cache.pop(key, None)

    @app.get("/api/v1/dashboard")
    def dashboard_usage(
        scope: Literal["project", "global"] = "project",
        project_id: str | None = None,
        period: Literal["today", "7d", "30d", "all"] = "7d",
        timezone: str = "UTC",
    ) -> dict[str, Any]:
        try:
            zone = ZoneInfo(timezone)
        except ZoneInfoNotFoundError as error:
            raise HTTPException(status_code=422, detail="unknown dashboard timezone") from error
        if scope == "project":
            selected = project_or_404(project_id or "")
            selected_projects = [selected]
        else:
            selected_projects = state.store.list_projects()
        cache_key = (
            str(selected_projects[0]["id"]) if scope == "project" else "*",
            period,
            timezone,
        )
        now = datetime.now(UTC)
        with state.dashboard_lock:
            cached = state.dashboard_cache.get(cache_key)
            if cached is not None and now - cached[0] < timedelta(seconds=30):
                return cached[1]
        local_now = now.astimezone(zone)
        if period == "today":
            local_cutoff = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        elif period == "7d":
            local_cutoff = (local_now - timedelta(days=6)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
        elif period == "30d":
            local_cutoff = (local_now - timedelta(days=29)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )
        else:
            local_cutoff = None
        cutoff_ms = local_cutoff.timestamp() * 1000 if local_cutoff else None

        def usage_row(name: str) -> dict[str, Any]:
            return {
                "id": name,
                "tokens": {
                    "input": 0,
                    "output": 0,
                    "reasoning": 0,
                    "cache_read": 0,
                    "cache_write": 0,
                },
                "tokens_total": 0,
                "cost": 0.0,
                "messages": 0,
                "sessions": set(),
            }

        totals = usage_row("total")
        totals.update({"sessions": set(), "active": 0, "mcp_connected": 0, "mcp_total": 0})
        models: dict[str, dict[str, Any]] = {}
        providers: dict[str, dict[str, Any]] = {}
        agents: dict[str, dict[str, Any]] = {}
        projects_usage: dict[str, dict[str, Any]] = {}
        daily: dict[str, dict[str, Any]] = {}
        recent_sessions: list[dict[str, Any]] = []
        unavailable: list[dict[str, str]] = []
        seen_messages: set[str] = set()
        partial = False

        def add_usage(row: dict[str, Any], info: dict[str, Any], session_key: str) -> None:
            raw_tokens = info.get("tokens")
            tokens: dict[str, Any] = raw_tokens if isinstance(raw_tokens, dict) else {}
            for key in ("input", "output", "reasoning"):
                value = tokens.get(key)
                if isinstance(value, (int, float)) and value >= 0:
                    row["tokens"][key] += value
                    row["tokens_total"] += value
            raw_cache = tokens.get("cache")
            cache: dict[str, Any] = raw_cache if isinstance(raw_cache, dict) else {}
            for source, target in (("read", "cache_read"), ("write", "cache_write")):
                value = cache.get(source)
                if isinstance(value, (int, float)) and value >= 0:
                    row["tokens"][target] += value
            cost = info.get("cost")
            if isinstance(cost, (int, float)) and cost >= 0:
                row["cost"] += cost
            row["messages"] += 1
            cast(set[str], row["sessions"]).add(session_key)

        for project in selected_projects:
            project_id_value = str(project["id"])
            project_row = usage_row(project_id_value)
            project_row["name"] = str(project["name"])
            projects_usage[project_id_value] = project_row
            linked_tasks = state.store.project_session_tasks(project_id_value)
            try:
                client = client_for(project_id_value)
                snapshot = client.snapshot()
            except (HTTPException, OpenCodeError) as error:
                unavailable.append(
                    {
                        "id": project_id_value,
                        "name": str(project["name"]),
                        "error": str(error),
                    }
                )
                partial = True
                continue
            snapshot_errors = snapshot.get("errors")
            if snapshot.get("state") != "connected" or (
                isinstance(snapshot_errors, list) and snapshot_errors
            ):
                unavailable.append(
                    {
                        "id": project_id_value,
                        "name": str(project["name"]),
                        "error": "OpenCode snapshot is temporarily incomplete",
                    }
                )
                partial = True
            raw_statuses = snapshot.get("statuses")
            statuses: dict[str, Any] = raw_statuses if isinstance(raw_statuses, dict) else {}
            raw_mcp = snapshot.get("mcp")
            mcp: dict[str, Any] = raw_mcp if isinstance(raw_mcp, dict) else {}
            totals["mcp_total"] += len(mcp)
            totals["mcp_connected"] += sum(
                1
                for item in mcp.values()
                if isinstance(item, dict) and item.get("status") == "connected"
            )
            raw_sessions = snapshot.get("sessions")
            sessions: list[Any] = raw_sessions if isinstance(raw_sessions, list) else []
            if len(sessions) > 200:
                sessions = sorted(
                    sessions,
                    key=lambda item: (
                        item.get("time", {}).get("updated", 0)
                        if isinstance(item, dict) and isinstance(item.get("time"), dict)
                        else 0
                    ),
                    reverse=True,
                )[:200]
                partial = True
            session_index = {
                str(item["id"]): item
                for item in sessions
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }

            def root_session_id(session_id: str, index: dict[str, Any] = session_index) -> str:
                current = session_id
                seen: set[str] = set()
                while current not in seen:
                    seen.add(current)
                    item = index.get(current)
                    parent = item.get("parentID") if isinstance(item, dict) else None
                    if not isinstance(parent, str) or parent not in index:
                        return current
                    current = parent
                return session_id

            for session in sessions:
                if not isinstance(session, dict) or not isinstance(session.get("id"), str):
                    continue
                session_id = str(session["id"])
                session_key = f"{project_id_value}:{session_id}"
                usage_session_key = f"{project_id_value}:{root_session_id(session_id)}"
                session_time = session.get("time")
                raw_time: dict[str, Any] = session_time if isinstance(session_time, dict) else {}
                updated = raw_time.get("updated")
                in_period = cutoff_ms is None or (
                    isinstance(updated, (int, float)) and updated >= cutoff_ms
                )
                if in_period and not session.get("parentID"):
                    cast(set[str], totals["sessions"]).add(session_key)
                    cast(set[str], project_row["sessions"]).add(session_key)
                    status = statuses.get(session_id, {})
                    runtime_status = (
                        status.get("type") or status.get("status")
                        if isinstance(status, dict)
                        else None
                    )
                    persisted_status = linked_tasks.get(session_id, {}).get("session_status")
                    status_value = (
                        runtime_status
                        if runtime_status not in {None, "idle"}
                        else persisted_status or runtime_status or "idle"
                    )
                    if status_value not in {"completed", "idle", "failed", "aborted"}:
                        totals["active"] += 1
                    recent_session = {
                        "id": session_id,
                        "project_id": project_id_value,
                        "project_name": project["name"],
                        "title": session.get("title"),
                        "agent": session.get("agent"),
                        "model": session.get("model"),
                        "time": session.get("time"),
                        "status": status_value,
                        "cost": session.get("cost") or 0,
                        "tokens": session.get("tokens") or {},
                    }
                    recent_sessions.append(recent_session)
                else:
                    recent_session = None
                try:
                    messages = client.session_messages(session_id)
                except OpenCodeError:
                    partial = True
                    continue
                if recent_session is not None:
                    assistant_messages = [
                        message
                        for message in messages
                        if isinstance(message, dict)
                        and isinstance(message.get("info"), dict)
                        and message["info"].get("role") == "assistant"
                    ]
                    if assistant_messages and assistant_messages[-1]["info"].get("error"):
                        recent_session["status"] = "failed"
                for index, message in enumerate(messages):
                    if not isinstance(message, dict) or not isinstance(message.get("info"), dict):
                        continue
                    info = cast(dict[str, Any], message["info"])
                    if info.get("role") != "assistant":
                        continue
                    raw_message_time = info.get("time")
                    message_time: dict[str, Any] = (
                        raw_message_time if isinstance(raw_message_time, dict) else {}
                    )
                    occurred = message_time.get("completed") or message_time.get("created")
                    if cutoff_ms is not None and (
                        not isinstance(occurred, (int, float)) or occurred < cutoff_ms
                    ):
                        continue
                    message_id = str(info.get("id") or f"{session_key}:{index}")
                    dedupe_key = f"{project_id_value}:{message_id}"
                    if dedupe_key in seen_messages:
                        continue
                    seen_messages.add(dedupe_key)
                    provider = str(info.get("providerID") or "unknown")
                    model_id = str(info.get("modelID") or "unknown")
                    model = f"{provider}/{model_id}"
                    agent = str(info.get("agent") or session.get("agent") or "default")
                    local_date = (
                        datetime.fromtimestamp(float(occurred) / 1000, UTC)
                        .astimezone(zone)
                        .date()
                        .isoformat()
                        if isinstance(occurred, (int, float))
                        else "unknown"
                    )
                    for collection, key in (
                        (models, model),
                        (providers, provider),
                        (agents, agent),
                        (daily, local_date),
                    ):
                        if key not in collection:
                            collection[key] = usage_row(key)
                    for row in (
                        totals,
                        project_row,
                        models[model],
                        providers[provider],
                        agents[agent],
                        daily[local_date],
                    ):
                        add_usage(row, info, usage_session_key)

        def serialize(row: dict[str, Any]) -> dict[str, Any]:
            return {
                **{key: value for key, value in row.items() if key != "sessions"},
                "sessions": len(cast(set[str], row["sessions"])),
            }

        recent_sessions.sort(
            key=lambda item: (
                item.get("time", {}).get("updated", 0) if isinstance(item.get("time"), dict) else 0
            ),
            reverse=True,
        )
        result = {
            "scope": scope,
            "period": period,
            "timezone": timezone,
            "generated_at": now.isoformat(),
            "partial": partial,
            "unavailable_projects": unavailable,
            "totals": serialize(totals),
            "projects": sorted(
                (serialize(row) for row in projects_usage.values()),
                key=lambda row: row["tokens_total"],
                reverse=True,
            ),
            "models": sorted(
                (serialize(row) for row in models.values()),
                key=lambda row: row["tokens_total"],
                reverse=True,
            ),
            "providers": sorted(
                (serialize(row) for row in providers.values()),
                key=lambda row: row["tokens_total"],
                reverse=True,
            ),
            "agents": sorted(
                (serialize(row) for row in agents.values()),
                key=lambda row: row["tokens_total"],
                reverse=True,
            ),
            "daily": [serialize(daily[key]) for key in sorted(daily)],
            "recent_sessions": recent_sessions[:8],
        }
        if not partial:
            with state.dashboard_lock:
                state.dashboard_cache[cache_key] = (now, result)
                if len(state.dashboard_cache) > 32:
                    state.dashboard_cache.pop(next(iter(state.dashboard_cache)))
        return result

    @app.get("/api/v1/secrets")
    def secrets_catalog() -> list[dict[str, Any]]:
        return list_secrets()

    @app.put("/api/v1/secrets/{name}")
    def put_secret(name: str, payload: SecretWrite, guard: WriteGuard) -> dict[str, Any]:
        return save_secret(name, payload.value)

    @app.delete("/api/v1/secrets/{name}", status_code=204)
    def delete_secret(name: str, guard: WriteGuard) -> Response:
        remove_secret(name)
        return Response(status_code=204)

    @app.post("/api/v1/projects", status_code=201)
    def add_project(payload: ProjectCreate, guard: WriteGuard) -> dict[str, Any]:
        root = resolve_project_root(payload.root)
        endpoint = payload.endpoint
        if endpoint:
            _validate_external_project(OpenCodeClient(endpoint, str(root)), root)
        try:
            project = state.store.create_project(
                name=payload.name.strip(),
                root=root,
                endpoint=endpoint,
            )
        except sqlite3.IntegrityError as error:
            raise HTTPException(
                status_code=409,
                detail="project root is already registered",
            ) from error
        try:
            ensure_project_commands(project)
        except (HTTPException, OSError, WorkspaceError) as error:
            logging.getLogger("uvicorn.error").error(
                "Could not initialize Commands for %s: %s", project["name"], error
            )
        return _project_view(project, managed_server_status(str(project["id"])))

    @app.patch("/api/v1/projects/{project_id}")
    def update_project(
        project_id: str,
        payload: ProjectUpdate,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        endpoint = payload.endpoint
        if endpoint:
            _validate_external_project(
                OpenCodeClient(endpoint, str(project["root"])),
                Path(str(project["root"])),
            )
        updated = state.store.update_project(
            project_id,
            name=payload.name.strip() if payload.name else None,
            endpoint=None if payload.clear_endpoint else endpoint,
            update_endpoint=payload.clear_endpoint or payload.endpoint is not None,
        )
        assert updated is not None
        if endpoint:
            state.store.set_managed_enabled(project_id, False)
            state.processes.stop(project_id)
        return _project_view(updated, managed_server_status(project_id))

    @app.delete("/api/v1/projects/{project_id}", status_code=204)
    def remove_project(project_id: str, guard: WriteGuard) -> Response:
        project_or_404(project_id)
        state.processes.stop(project_id)
        state.store.delete_project(project_id)
        return Response(status_code=204)

    @app.get("/api/v1/projects/{project_id}/server")
    def server_status(project_id: str) -> dict[str, Any]:
        project = project_or_404(project_id)
        status = managed_server_status(project_id)
        if status["state"] == "stopped" and project.get("endpoint"):
            status = {
                "state": "external",
                "managed": False,
                "endpoint": project["endpoint"],
                "compatibility": status["compatibility"],
            }
        return status

    def record_server_lifecycle(project: dict[str, Any], kind: str) -> None:
        timestamp = datetime.now(UTC).isoformat()
        state.store.record_event(
            dedupe_key=f"server:{project['id']}:{kind}:{timestamp}",
            project_id=str(project["id"]),
            kind=kind,
            severity="info",
            resource_title=str(project["name"]),
            occurred_at=timestamp,
            unread=False,
        )

    @app.post("/api/v1/projects/{project_id}/server/start")
    def start_server(project_id: str, guard: WriteGuard) -> dict[str, object]:
        project = project_or_404(project_id)
        workspace = workspace_for(project)
        validate_root(workspace)
        was_running = state.processes.status(project_id)["state"] == "running"
        status = state.processes.start(project_id, workspace)
        state.store.set_managed_enabled(project_id, True)
        if not was_running:
            record_server_lifecycle(project, "server_started")
        invalidate_dashboard_cache(project_id)
        return status

    @app.post("/api/v1/projects/{project_id}/server/stop")
    def stop_server(project_id: str, guard: WriteGuard) -> dict[str, object]:
        project = project_or_404(project_id)
        was_running = state.processes.status(project_id)["state"] == "running"
        state.store.set_managed_enabled(project_id, False)
        status = state.processes.stop(project_id)
        if was_running:
            record_server_lifecycle(project, "server_stopped")
        invalidate_dashboard_cache(project_id)
        return status

    @app.post("/api/v1/projects/{project_id}/server/restart")
    def restart_server(project_id: str, guard: WriteGuard) -> dict[str, object]:
        project = project_or_404(project_id)
        if project.get("endpoint"):
            raise HTTPException(
                status_code=409,
                detail="external OpenCode server must be restarted outside Control",
            )
        workspace = workspace_for(project)
        validate_root(workspace)
        state.processes.stop(project_id)
        status = state.processes.start(project_id, workspace)
        state.store.set_managed_enabled(project_id, True)
        record_server_lifecycle(project, "server_restarted")
        invalidate_dashboard_cache(project_id)
        return status

    @app.post("/api/v1/servers/restart")
    def restart_running_servers(guard: WriteGuard) -> dict[str, dict[str, object]]:
        restarted: dict[str, dict[str, object]] = {}
        for project in state.store.list_projects():
            project_id = str(project["id"])
            if state.processes.status(project_id)["state"] != "running":
                continue
            try:
                workspace = workspace_for(project)
                validate_root(workspace)
                status = state.processes.restart_if_running(project_id, workspace)
                if status is not None:
                    restarted[project_id] = status
                    record_server_lifecycle(project, "server_restarted")
                    invalidate_dashboard_cache(project_id)
            except (OSError, ProcessError, WorkspaceError) as error:
                restarted[project_id] = {"state": "error", "detail": str(error)}
        return restarted

    def record_permission_events(
        project_id: str,
        session_id: str,
        permissions: list[dict[str, Any]],
        *,
        session_title: str | None = None,
    ) -> None:
        task = state.store.session_task(project_id, session_id)
        resource_title = task.get("title") if task else session_title or session_id
        for permission in permissions:
            permission_id = permission.get("id")
            if not isinstance(permission_id, str):
                continue
            permission_name = permission.get("permission")
            detail = str(permission_name) if permission_name else None
            state.store.record_event(
                dedupe_key=f"permission:{project_id}:{session_id}:{permission_id}",
                project_id=project_id,
                kind="permission_requested",
                severity="action",
                resource_title=str(resource_title),
                detail=detail,
                task_id=task.get("id") if task else None,
                session_id=session_id,
                permission_id=permission_id,
                unread=True,
            )

    @app.get("/api/v1/projects/{project_id}/snapshot")
    def project_snapshot(project_id: str) -> dict[str, Any]:
        project = project_or_404(project_id)
        server = state.processes.status(project_id)
        endpoint = state.processes.endpoint(project_id) or project.get("endpoint")
        if not endpoint:
            return {
                "state": "stopped",
                "errors": [],
                "sessions": [],
                "statuses": {},
                "agents": [],
                "mcp": {},
                "providers": {"connected": [], "available": []},
                "server": server,
            }
        client = client_for(project_id)
        snapshot = client.snapshot()
        reconcile_project_tasks(project_id, snapshot)
        sessions = snapshot.get("sessions")
        if isinstance(sessions, list):
            linked = state.store.project_session_tasks(project_id)
            by_id = {
                str(item["id"]): item
                for item in sessions
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            for session in sessions:
                if not isinstance(session, dict) or not isinstance(session.get("id"), str):
                    continue
                current: dict[str, Any] | None = session
                visited: set[str] = set()
                while current is not None:
                    current_id = str(current["id"])
                    if current_id in visited:
                        break
                    visited.add(current_id)
                    task = linked.get(current_id)
                    if task:
                        session["control_task"] = task
                        break
                    parent_id = current.get("parentID")
                    current = by_id.get(str(parent_id)) if parent_id else None
            statuses = snapshot.get("statuses")
            if isinstance(statuses, dict):
                active_states = {
                    "busy",
                    "dispatching",
                    "in_progress",
                    "pending",
                    "queued",
                    "running",
                    "stalled",
                }
                for session_id, raw_status in statuses.items():
                    if not isinstance(session_id, str) or not isinstance(raw_status, dict):
                        continue
                    value = raw_status.get("type") or raw_status.get("status")
                    if value not in active_states:
                        continue
                    with suppress(OpenCodeError):
                        pending = client.session_permissions(session_id)
                        if pending:
                            session = by_id.get(session_id)
                            title = session.get("title") if isinstance(session, dict) else None
                            record_permission_events(
                                project_id,
                                session_id,
                                pending,
                                session_title=str(title) if title else None,
                            )
        snapshot["server"] = (
            server
            if server["state"] == "running"
            else {
                "state": "external",
                "managed": False,
                "endpoint": endpoint,
            }
        )
        return snapshot

    @app.get("/api/v1/projects/{project_id}/providers/auth")
    def provider_auth_catalog(project_id: str) -> list[dict[str, Any]]:
        project = project_or_404(project_id)
        catalog = client_for(project_id).provider_auth_catalog()
        config_value = read_config(workspace_for(project))
        configured = config_value.get("provider", {})
        configured_items = configured if isinstance(configured, dict) else {}
        by_id = {entry["id"]: entry for entry in catalog}
        for provider_id, raw in configured_items.items():
            if not isinstance(provider_id, str) or not isinstance(raw, dict):
                continue
            entry = by_id.get(provider_id)
            if entry is None:
                name = raw.get("name")
                entry = {
                    "id": provider_id,
                    "name": name if isinstance(name, str) else provider_id,
                    "connected": False,
                    "methods": [],
                }
                catalog.append(entry)
                by_id[provider_id] = entry
            entry["configured"] = True
        return catalog

    @app.put("/api/v1/projects/{project_id}/providers/{provider_id}/auth")
    async def set_provider_auth(
        project_id: str,
        provider_id: str,
        request: Request,
        guard: WriteGuard,
    ) -> dict[str, bool]:
        try:
            payload = ProviderApiAuth.model_validate(await request.json())
        except (ValidationError, ValueError, TypeError) as error:
            raise HTTPException(
                status_code=422, detail="Некорректные данные авторизации"
            ) from error
        managed_client_for_auth(project_id).set_provider_api_key(
            provider_id, payload.key, payload.metadata
        )
        return {"connected": True}

    @app.post("/api/v1/projects/{project_id}/providers/{provider_id}/oauth/authorize")
    async def authorize_provider_oauth(
        project_id: str,
        provider_id: str,
        request: Request,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        try:
            payload = ProviderOAuthAuthorize.model_validate(await request.json())
        except (ValidationError, ValueError, TypeError) as error:
            raise HTTPException(status_code=422, detail="Некорректные данные OAuth") from error
        return managed_client_for_auth(project_id).authorize_provider_oauth(
            provider_id, payload.method, payload.inputs
        )

    @app.post("/api/v1/projects/{project_id}/providers/{provider_id}/oauth/callback")
    async def complete_provider_oauth(
        project_id: str,
        provider_id: str,
        request: Request,
        guard: WriteGuard,
    ) -> dict[str, bool]:
        try:
            payload = ProviderOAuthCallback.model_validate(await request.json())
        except (ValidationError, ValueError, TypeError) as error:
            raise HTTPException(status_code=422, detail="Некорректный ответ OAuth") from error
        managed_client_for_auth(project_id).complete_provider_oauth(
            provider_id, payload.method, payload.code
        )
        return {"connected": True}

    @app.put("/api/v1/projects/{project_id}/providers/{provider_id}/configuration")
    def save_provider_configuration(
        project_id: str,
        provider_id: str,
        payload: ProviderConfigWrite,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        item_id = validate_item_id(provider_id)
        root = workspace_for(project)
        relative = config_target(root)
        config_value = read_jsonc_config(root, relative)
        providers = config_value.setdefault("provider", {})
        if not isinstance(providers, dict):
            raise WorkspaceError("OpenCode config provider section must be an object")
        options: dict[str, Any] = {"baseURL": payload.base_url}
        providers[item_id] = {
            "npm": "@ai-sdk/openai-compatible",
            "name": payload.name,
            "options": options,
            "models": {model.strip(): {"name": model.strip()} for model in payload.models},
        }
        operation = apply_config_candidates(
            project,
            "project",
            f"provider:{item_id}",
            {ConfigFile(root, relative): render_jsonc_update(root, relative, config_value)},
        )
        if payload.api_key:
            try:
                managed_client_for_auth(project_id).set_provider_api_key(item_id, payload.api_key)
            except (OpenCodeError, ProcessError) as error:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "message": "Provider config was applied, but authentication failed",
                        "operation": operation,
                        "auth_error": str(error),
                    },
                ) from error
        return {
            "id": item_id,
            "config": providers[item_id],
            "operation": operation,
        }

    def reconcile_task_session_messages(
        project_id: str, session_id: str, messages: list[Any]
    ) -> None:
        task = state.store.task_for_session(project_id, session_id)
        if (
            task is None
            or task.get("session_id") != session_id
            or task.get("status") not in {"dispatching", "running", "failed"}
        ):
            return
        last_user = -1
        last_assistant = -1
        for index, message in enumerate(messages):
            info = message.get("info") if isinstance(message, dict) else None
            if not isinstance(info, dict):
                continue
            if info.get("role") == "user":
                last_user = index
            elif info.get("role") == "assistant":
                last_assistant = index
        if last_assistant <= last_user:
            return
        message = messages[last_assistant]
        info = message.get("info") if isinstance(message, dict) else None
        if not isinstance(info, dict):
            return
        raw_time = info.get("time")
        message_time = raw_time if isinstance(raw_time, dict) else {}
        occurred = message_time.get("completed") or message_time.get("created")
        if not isinstance(occurred, (int, float)):
            return
        occurred_ms = float(occurred) if occurred > 100_000_000_000 else float(occurred) * 1000
        try:
            task_updated_ms = datetime.fromisoformat(str(task["updated_at"])).timestamp() * 1000
        except ValueError:
            return
        if occurred_ms <= task_updated_ms:
            return
        raw_error = info.get("error")
        if raw_error:
            if isinstance(raw_error, dict):
                detail = (
                    raw_error.get("message") or raw_error.get("name") or "OpenCode session failed"
                )
            else:
                detail = str(raw_error)
            state.store.update_task(
                project_id,
                str(task["id"]),
                status="failed",
                session_id=session_id,
                error=str(detail),
            )
            invalidate_dashboard_cache(project_id)
            return
        raw_parts = message.get("parts")
        parts = raw_parts if isinstance(raw_parts, list) else []
        finished = (
            bool(message_time.get("completed"))
            or info.get("finish") == "stop"
            or any(isinstance(part, dict) and part.get("type") == "step-finish" for part in parts)
        )
        if not finished:
            return
        if task.get("cron"):
            status = "scheduled" if task.get("schedule_enabled") else "paused"
            state.store.record_event(
                dedupe_key=f"task-continuation:{task['id']}:{session_id}:{info.get('id')}",
                project_id=project_id,
                kind="task_completed",
                severity="info",
                resource_title=str(task["title"]),
                task_id=str(task["id"]),
                session_id=session_id,
                unread=False,
            )
        else:
            status = "completed"
        state.store.update_task(
            project_id,
            str(task["id"]),
            status=status,
            session_id=session_id,
        )
        invalidate_dashboard_cache(project_id)

    @app.get("/api/v1/projects/{project_id}/sessions/{session_id}/messages")
    def session_messages(project_id: str, session_id: str) -> Any:
        client = client_for_session(project_id, session_id)
        assert client is not None
        messages = client.session_messages(session_id)
        reconcile_task_session_messages(project_id, session_id, messages)
        task = state.store.session_task(project_id, session_id)
        recovered = task is not None and _successful_assistant_after(
            messages, task.get("session_updated_at")
        )
        if recovered:
            run_id = state.store.complete_interrupted_scheduled_run(project_id, session_id)
            if run_id is not None:
                task = state.store.session_task(project_id, session_id)
                invalidate_dashboard_cache(project_id)
        if (
            task is not None
            and task.get("session_status") == "failed"
            and isinstance(task.get("session_error"), str)
            and task["session_error"]
            and not any(
                isinstance(message, dict)
                and isinstance(message.get("info"), dict)
                and message["info"].get("error")
                for message in messages
            )
            and not recovered
        ):
            messages.append(
                {
                    "info": {
                        "id": f"control-error-{task['id']}",
                        "role": "assistant",
                        "error": task["session_error"],
                    },
                    "parts": [],
                }
            )
        return messages

    @app.get("/api/v1/projects/{project_id}/git")
    def project_git(project_id: str) -> dict[str, Any]:
        project = project_or_404(project_id)
        root = workspace_for(project)
        validate_root(root)
        return git_state(root.path)

    @app.get("/api/v1/projects/{project_id}/git/diff")
    def project_git_diff(project_id: str, path: str) -> dict[str, str]:
        project = project_or_404(project_id)
        root = workspace_for(project)
        validate_root(root)
        try:
            return git_diff(root.path, path)
        except GitError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error

    @app.post("/api/v1/projects/{project_id}/git/commit")
    def commit_project_git(
        project_id: str, payload: GitCommitCreate, guard: WriteGuard
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        root = workspace_for(project)
        validate_root(root)
        try:
            return git_commit(root.path, payload.message.strip(), payload.paths)
        except GitError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/api/v1/projects/{project_id}/git/stage")
    def stage_project_git(
        project_id: str, payload: GitPathsUpdate, guard: WriteGuard
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        root = workspace_for(project)
        validate_root(root)
        try:
            return git_stage(root.path, payload.paths)
        except GitError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/api/v1/projects/{project_id}/git/unstage")
    def unstage_project_git(
        project_id: str, payload: GitPathsUpdate, guard: WriteGuard
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        root = workspace_for(project)
        validate_root(root)
        try:
            return git_unstage(root.path, payload.paths)
        except GitError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/api/v1/projects/{project_id}/git/revert")
    def revert_project_git(
        project_id: str, payload: GitCommitTarget, guard: WriteGuard
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        root = workspace_for(project)
        validate_root(root)
        try:
            return git_revert(root.path, payload.commit)
        except GitError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.post("/api/v1/projects/{project_id}/git/reset")
    def reset_project_git(
        project_id: str, payload: GitCommitTarget, guard: WriteGuard
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        root = workspace_for(project)
        validate_root(root)
        try:
            return git_reset(root.path, payload.commit)
        except GitError as error:
            raise HTTPException(status_code=409, detail=str(error)) from error

    @app.get("/api/v1/projects/{project_id}/sessions/{session_id}/todos")
    def session_todos(project_id: str, session_id: str) -> list[dict[str, str]]:
        client = client_for_session(project_id, session_id)
        assert client is not None
        return client.session_todos(session_id)

    @app.get("/api/v1/projects/{project_id}/sessions/{session_id}/permissions")
    def session_permissions(project_id: str, session_id: str) -> list[dict[str, Any]]:
        client = client_for_session(project_id, session_id)
        assert client is not None
        permissions = client.session_permissions(session_id)
        record_permission_events(project_id, session_id, permissions)
        return permissions

    @app.post(
        "/api/v1/projects/{project_id}/sessions/{session_id}/permissions/{permission_id}/reply"
    )
    def reply_session_permission(
        project_id: str,
        session_id: str,
        permission_id: str,
        payload: PermissionReply,
        guard: WriteGuard,
    ) -> dict[str, bool]:
        client = client_for_session(project_id, session_id)
        assert client is not None
        client.reply_permission(session_id, permission_id, payload.reply)
        state.store.resolve_permission_event(project_id, session_id, permission_id)
        return {"replied": True}

    @app.post("/api/v1/projects/{project_id}/sessions", status_code=201)
    def create_session(
        project_id: str,
        payload: SessionCreate,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        return client_for(project_id).create_session(payload.title)

    @app.post("/api/v1/projects/{project_id}/sessions/{session_id}/prompt", status_code=202)
    def send_prompt(
        project_id: str,
        session_id: str,
        payload: PromptCreate,
        guard: WriteGuard,
    ) -> dict[str, bool]:
        client = client_for_session(project_id, session_id)
        assert client is not None
        client.prompt_async(
            session_id,
            payload.prompt,
            agent=payload.agent,
            model=payload.model,
            variant=payload.variant,
            attachments=[item.model_dump() for item in payload.attachments],
            mentions=payload.mentions,
        )
        task = state.store.task_for_session(project_id, session_id)
        if task is not None:
            scheduled = bool(task.get("cron"))
            state.store.record_task_prompt(
                project_id,
                str(task["id"]),
                session_id=session_id,
                prompt=None if scheduled else payload.prompt.strip() or None,
                agent=payload.agent,
                model=payload.model,
                variant=payload.variant,
                mentions=payload.mentions,
                update_agent=not scheduled and "agent" in payload.model_fields_set,
                update_model=not scheduled and "model" in payload.model_fields_set,
                update_variant=not scheduled and "variant" in payload.model_fields_set,
            )
            invalidate_dashboard_cache(project_id)
        return {"accepted": True}

    @app.post("/api/v1/projects/{project_id}/sessions/{session_id}/abort")
    def abort_session(project_id: str, session_id: str, guard: WriteGuard) -> dict[str, bool]:
        client = client_for_session(project_id, session_id)
        assert client is not None
        client.request("POST", f"/session/{_segment(session_id)}/abort", body={})
        task = state.store.task_for_session(project_id, session_id)
        if task is not None:
            run = state.store.active_scheduled_run_for_task(
                project_id, str(task["id"]), session_id=session_id
            )
            if run is not None:
                state.store.finish_scheduled_run(str(run["id"]), "aborted")
            elif task["status"] in {"queued", "dispatching", "running"}:
                state.store.update_task(project_id, str(task["id"]), status="aborted")
        return {"aborted": True}

    @app.delete("/api/v1/projects/{project_id}/sessions/{session_id}", status_code=204)
    def delete_session(project_id: str, session_id: str, guard: WriteGuard) -> Response:
        client = client_for_session(project_id, session_id, missing_ok=True)
        task = state.store.task_for_session(project_id, session_id)
        was_current = task is not None and task.get("session_id") == session_id
        state.store.remove_task_session(project_id, session_id)
        if was_current and task is not None and task.get("status") in {
            "queued",
            "dispatching",
            "running",
            "pending",
        }:
            next_status = (
                "scheduled"
                if task.get("cron") and task.get("schedule_enabled")
                else "paused"
                if task.get("cron")
                else "aborted"
            )
            state.store.update_task(
                project_id,
                str(task["id"]),
                status=next_status,
                error=None,
            )
        if client is not None:
            with suppress(Exception):
                client.request(
                    "POST", f"/session/{_segment(session_id)}/abort", body={}
                )
            client.delete_session(session_id, missing_ok=True)
        invalidate_dashboard_cache(project_id)
        return Response(status_code=204)

    def reconcile_project_tasks(
        project_id: str, snapshot: dict[str, Any] | None = None
    ) -> None:
        result = state.store.list_tasks(project_id)
        failed_scheduled = [
            item
            for item in result
            if item.get("cron")
            and item.get("status") == "failed"
            and isinstance(item.get("session_id"), str)
        ]
        if failed_scheduled and snapshot is None:
            try:
                snapshot = client_for(project_id).snapshot()
            except (OpenCodeError, HTTPException):
                snapshot = None
        snapshot_session_ids: set[str] | None = None
        if snapshot is not None:
            snapshot_errors = {
                str(error)
                for error in snapshot.get("errors", [])
                if isinstance(error, str)
            }
            snapshot_sessions = snapshot.get("sessions")
            if (
                snapshot.get("state") != "degraded"
                and not snapshot_errors.intersection(
                    {"sessions_unavailable", "statuses_unavailable"}
                )
                and isinstance(snapshot_sessions, list)
            ):
                snapshot_session_ids = {
                    str(item["id"])
                    for item in snapshot_sessions
                    if isinstance(item, dict) and isinstance(item.get("id"), str)
                }
        repaired = False
        for item in failed_scheduled:
            current_session_id = item.get("session_id")
            assert isinstance(current_session_id, str)
            missing_link = current_session_id not in item.get("session_ids", [])
            missing_runtime = (
                snapshot_session_ids is not None
                and current_session_id not in snapshot_session_ids
            )
            if not missing_link and not missing_runtime:
                continue
            if missing_runtime:
                state.store.remove_task_session(project_id, current_session_id)
            state.store.update_task(
                project_id,
                str(item["id"]),
                status="scheduled" if item.get("schedule_enabled") else "paused",
                error=None,
            )
            repaired = True
        if repaired:
            result = state.store.list_tasks(project_id)
        running = [
            item
            for item in result
            if item["status"] in {"dispatching", "running"}
            and (
                not item.get("cron")
                or not state.store.has_active_scheduled_run(project_id, str(item["id"]))
            )
        ]
        if not running:
            return
        if snapshot is None:
            try:
                snapshot = client_for(project_id).snapshot()
            except (OpenCodeError, HTTPException):
                return
        errors = {
            str(error) for error in snapshot.get("errors", []) if isinstance(error, str)
        }
        if snapshot.get("state") == "degraded" or errors.intersection(
            {"sessions_unavailable", "statuses_unavailable"}
        ):
            return
        statuses = snapshot.get("statuses")
        sessions = snapshot.get("sessions")
        if not isinstance(statuses, dict) or not isinstance(sessions, list):
            return
        session_ids = {
            item.get("id") for item in sessions if isinstance(item, dict)
        }
        now = datetime.now(UTC)
        active_states = {
            "busy",
            "dispatching",
            "in_progress",
            "pending",
            "queued",
            "running",
            "stalled",
        }
        for task in running:
            session_id = task.get("session_id")
            if not isinstance(session_id, str):
                continue
            status = statuses.get(session_id, {})
            value = status.get("type") or status.get("status") if isinstance(status, dict) else None
            active = value in active_states
            failed = value in {"error", "failed"}
            failure_error: str | None = None
            if failed and isinstance(status, dict) and isinstance(status.get("error"), str):
                failure_error = status["error"]
            try:
                age = (now - datetime.fromisoformat(str(task["updated_at"]))).total_seconds()
            except ValueError:
                age = 0
            has_known_session = session_id in session_ids
            if has_known_session and not active and (failed or age >= 3):
                if task.get("cron"):
                    next_status = "scheduled" if task.get("schedule_enabled") else "paused"
                else:
                    next_status = "failed" if failed else "completed"
                state.store.update_task(
                    project_id,
                    str(task["id"]),
                    status=next_status,
                    error=failure_error,
                )

    @app.get("/api/v1/projects/{project_id}/tasks")
    def tasks(project_id: str) -> list[dict[str, Any]]:
        project_or_404(project_id)
        reconcile_project_tasks(project_id)
        return state.store.list_tasks(project_id)

    @app.get("/api/v1/projects/{project_id}/tasks/{task_id}/runs")
    def scheduled_task_runs(project_id: str, task_id: str) -> list[dict[str, Any]]:
        task = state.store.get_task(project_id, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        return state.store.list_scheduled_runs(project_id, task_id)

    @app.post("/api/v1/projects/{project_id}/tasks", status_code=202)
    def launch_task(project_id: str, payload: TaskCreate, guard: WriteGuard) -> dict[str, Any]:
        project_or_404(project_id)
        if _slash_command(payload.prompt) is not None and payload.attachments:
            raise HTTPException(
                status_code=422,
                detail="Slash Command tasks do not support attachments",
            )
        task = state.store.create_task(
            project_id,
            title=payload.title,
            prompt=payload.prompt,
            agent=payload.agent,
            model=payload.model,
            variant=payload.variant,
            mentions=payload.mentions,
            cron=payload.cron,
            timezone=payload.timezone if payload.cron else None,
            cron_session_mode=payload.cron_session_mode,
            next_run_at=_next_cron_run(payload.cron, payload.timezone) if payload.cron else None,
        )
        if payload.cron:
            return task
        return dispatch_task(
            project_id,
            task,
            attachments=[item.model_dump() for item in payload.attachments],
        )

    @app.post("/api/v1/projects/{project_id}/tasks/{task_id}/rerun", status_code=202)
    def rerun_task(project_id: str, task_id: str, guard: WriteGuard) -> dict[str, Any]:
        task = state.store.get_task(project_id, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        if task["status"] in {"queued", "dispatching", "running"}:
            raise HTTPException(status_code=409, detail="task is already active")
        if task.get("cron") and task.get("cron_session_mode") == "new":
            return dispatch_task(project_id, task)
        return continue_task(project_id, task)

    @app.patch("/api/v1/projects/{project_id}/tasks/{task_id}/schedule")
    def update_task_schedule(
        project_id: str,
        task_id: str,
        payload: TaskScheduleUpdate,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        task = state.store.get_task(project_id, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        if payload.mode == "manual":
            updated = state.store.configure_task_schedule(
                project_id,
                task_id,
                cron=None,
                timezone=None,
                enabled=False,
                cron_session_mode=None,
                next_run_at=None,
                prompt=payload.prompt,
                mentions=payload.mentions,
                update_execution=bool(
                    {"agent", "model", "variant"} & payload.model_fields_set
                ),
                agent=payload.agent,
                model=payload.model,
                variant=payload.variant,
            )
            assert updated is not None
            return updated
        if payload.mode == "cron":
            assert payload.cron is not None and payload.timezone is not None
            enabled = payload.enabled is not False
            updated = state.store.configure_task_schedule(
                project_id,
                task_id,
                cron=payload.cron,
                timezone=payload.timezone,
                enabled=enabled,
                cron_session_mode=payload.cron_session_mode or "new",
                next_run_at=(_next_cron_run(payload.cron, payload.timezone) if enabled else None),
                prompt=payload.prompt,
                mentions=payload.mentions,
                update_execution=bool(
                    {"agent", "model", "variant"} & payload.model_fields_set
                ),
                agent=payload.agent,
                model=payload.model,
                variant=payload.variant,
            )
            assert updated is not None
            return updated
        if not isinstance(task.get("cron"), str) or not isinstance(task.get("timezone"), str):
            raise HTTPException(status_code=409, detail="task has no schedule")
        assert payload.enabled is not None
        next_run_at = _next_cron_run(task["cron"], task["timezone"]) if payload.enabled else None
        updated = state.store.set_schedule_enabled(
            project_id,
            task_id,
            enabled=payload.enabled,
            next_run_at=next_run_at,
        )
        assert updated is not None
        return updated

    @app.post("/api/v1/projects/{project_id}/tasks/{task_id}/abort")
    def abort_task(project_id: str, task_id: str, guard: WriteGuard) -> dict[str, Any]:
        task = state.store.get_task(project_id, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        session_id = task.get("session_id")
        if session_id:
            client = client_for_session(project_id, str(session_id))
            assert client is not None
            client.request("POST", f"/session/{_segment(str(session_id))}/abort", body={})
        run = state.store.active_scheduled_run_for_task(project_id, task_id)
        if run is not None:
            state.store.finish_scheduled_run(str(run["id"]), "aborted")
            updated = state.store.get_task(project_id, task_id)
        else:
            updated = state.store.update_task(project_id, task_id, status="aborted")
        assert updated is not None
        return updated

    @app.post("/api/v1/projects/{project_id}/tasks/{task_id}/sessions", status_code=201)
    def create_task_session(
        project_id: str,
        task_id: str,
        payload: SessionCreate,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        task = state.store.get_task(project_id, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        client = client_for(project_id)
        session = client.create_session(payload.title or f"{task['title']} · новая сессия")
        session_id = str(session["id"])
        try:
            state.store.add_task_session(project_id, task_id, session_id)
        except Exception:
            with suppress(Exception):
                client.delete_session(session_id, missing_ok=True)
            raise
        return session

    @app.delete("/api/v1/projects/{project_id}/tasks/{task_id}", status_code=204)
    def delete_task(project_id: str, task_id: str, guard: WriteGuard) -> Response:
        task = state.store.get_task(project_id, task_id)
        if task is None:
            raise HTTPException(status_code=404, detail="task not found")
        if task["status"] in {"queued", "dispatching", "running"}:
            raise HTTPException(status_code=409, detail="abort the active task before deleting it")
        session_ids = state.store.task_session_ids(project_id, task_id)
        if session_ids:
            client = client_for(project_id)
            for session_id in session_ids:
                if client.ensure_session_directory(session_id, missing_ok=True):
                    client.delete_session(session_id, missing_ok=True)
        state.store.delete_task(project_id, task_id)
        invalidate_dashboard_cache(project_id)
        return Response(status_code=204)

    def command_items(project: dict[str, Any]) -> list[dict[str, Any]]:
        items: dict[str, dict[str, Any]] = {}
        skill_ids = {"customize-opencode"}
        for directory in (
            Path.home() / ".config/opencode/skills",
            Path.home() / ".claude/skills",
            Path.home() / ".agents/skills",
        ):
            skill_ids.update(
                str(item["effective_name"])
                for item in list_external_markdown(directory, "SKILL.md")
            )
        for directory in (
            Path(".claude/skills"),
            Path(".agents/skills"),
            Path(".opencode/skills"),
        ):
            skill_ids.update(
                str(item["effective_name"])
                for item in list_markdown(workspace_for(project), directory, "SKILL.md")
            )
        global_directory = Path.home() / ".config/opencode/commands"
        for item in list_external_markdown(global_directory):
            items[str(item["id"])] = {
                **item,
                "scope": "global",
                "source": str(global_directory),
                "editable": True,
                "kind": "command",
            }
        project_directory = Path(".opencode/commands")
        for item in list_markdown(workspace_for(project), project_directory):
            items[str(item["id"])] = {
                **item,
                "scope": "project",
                "source": str(Path(str(project["root"])) / project_directory),
                "editable": True,
                "kind": "command",
            }
        try:
            runtime = client_for(str(project["id"])).commands()
        except (HTTPException, OpenCodeError, ProcessError):
            runtime = []
        for command in runtime:
            command_id = str(command["id"])
            if command_id in items:
                items[command_id] = {
                    **items[command_id],
                    "description": command.get("description")
                    or items[command_id].get("description"),
                    "agent": command.get("agent") or items[command_id].get("agent"),
                    "model": command.get("model") or items[command_id].get("model"),
                    "subtask": command.get("subtask") is True,
                    "runtime": True,
                }
            else:
                items[command_id] = {
                    **command,
                    "scope": "runtime",
                    "source": "Runtime OpenCode или opencode.json(c)",
                    "editable": False,
                    "runtime": True,
                    "kind": "skill" if command_id in skill_ids else "command",
                }
        for item in items.values():
            content = str(item.get("content") or "")
            item["has_shell"] = bool(re.search(r"!`[^`]+`", content))
            item["has_arguments"] = "$ARGUMENTS" in content or bool(
                re.search(r"\$[1-9][0-9]*", content)
            )
            if item.get("editable") is False:
                item["content"] = ""
        return sorted(items.values(), key=lambda item: str(item["id"]))

    @app.get("/api/v1/projects/{project_id}/commands")
    def commands(project_id: str) -> list[dict[str, Any]]:
        return command_items(project_or_404(project_id))

    @app.put("/api/v1/projects/{project_id}/commands/{command_id}")
    def save_command(
        project_id: str,
        command_id: str,
        payload: ScopedTextWrite,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        item_id = validate_item_id(command_id)
        metadata = parse_frontmatter(payload.content)
        if not payload.content.strip():
            raise HTTPException(status_code=422, detail="command template cannot be empty")
        if metadata.get("subtask") not in {None, True, False}:
            raise HTTPException(status_code=422, detail="subtask must be true or false")
        if payload.scope == "global":
            root = root_identity(resolve_project_root(str(Path.home() / ".config/opencode")))
            target = Path(f"commands/{item_id}.md")
        else:
            root = workspace_for(project)
            target = Path(f".opencode/commands/{item_id}.md")
        write_text(root, target, payload.content)
        return {
            "id": item_id,
            "content": payload.content,
            "restarted": restart_changed_resources(project, payload.scope),
        }

    @app.delete("/api/v1/projects/{project_id}/commands/{command_id}", status_code=204)
    def remove_command(
        project_id: str,
        command_id: str,
        guard: WriteGuard,
        scope: Literal["project", "global"] = "project",
    ) -> Response:
        project = project_or_404(project_id)
        item_id = validate_item_id(command_id)
        if scope == "global":
            root = root_identity(resolve_project_root(str(Path.home() / ".config/opencode")))
            target = Path(f"commands/{item_id}.md")
        else:
            root = workspace_for(project)
            target = Path(f".opencode/commands/{item_id}.md")
        delete_file(root, target)
        restart_changed_resources(project, scope)
        return Response(status_code=204)

    @app.post(
        "/api/v1/projects/{project_id}/sessions/{session_id}/commands/{command_id}",
        status_code=202,
    )
    def run_command(
        project_id: str,
        session_id: str,
        command_id: str,
        payload: CommandRun,
        guard: WriteGuard,
    ) -> dict[str, bool]:
        item_id = validate_item_id(command_id)
        client = client_for_session(project_id, session_id)
        assert client is not None
        available = {str(item["id"]) for item in command_items(project_or_404(project_id))}
        if item_id not in available:
            raise HTTPException(status_code=404, detail="command not found")
        snapshot = client.snapshot()
        statuses = snapshot.get("statuses")
        status = statuses.get(session_id, {}) if isinstance(statuses, dict) else {}
        value = status.get("type") or status.get("status") if isinstance(status, dict) else None
        if value in {"busy", "dispatching", "in_progress", "pending", "queued", "running"}:
            raise HTTPException(status_code=409, detail="session is already active")
        task = state.store.task_for_session(project_id, session_id)
        scheduled = bool(task and task.get("cron"))
        invocation_id = secrets.token_hex(12)

        def current_task() -> dict[str, Any] | None:
            if task is None:
                return None
            current = state.store.task_for_session(project_id, session_id)
            if current is None or current.get("id") != task.get("id"):
                return None
            return current

        def mark_task_running() -> None:
            current = current_task()
            if current is None:
                return
            state.store.record_task_prompt(
                project_id,
                str(current["id"]),
                session_id=session_id,
                prompt=None,
                agent=payload.agent,
                model=payload.model,
                variant=payload.variant,
                mentions=[],
                update_agent=not scheduled and "agent" in payload.model_fields_set,
                update_model=not scheduled and "model" in payload.model_fields_set,
                update_variant=not scheduled and "variant" in payload.model_fields_set,
            )
            invalidate_dashboard_cache(project_id)

        def mark_task_failed(error: Exception) -> None:
            current = current_task()
            if current is None:
                return
            if scheduled:
                state.store.record_event(
                    dedupe_key=f"task-command:{invocation_id}:failed",
                    project_id=project_id,
                    kind="task_failed",
                    severity="error",
                    resource_title=str(current["title"]),
                    detail=str(error),
                    task_id=str(current["id"]),
                    session_id=session_id,
                    unread=True,
                )
                state.store.update_task(
                    project_id,
                    str(current["id"]),
                    status="scheduled" if current.get("schedule_enabled") else "paused",
                    error=None,
                )
                invalidate_dashboard_cache(project_id)
                return
            state.store.update_task(
                project_id,
                str(current["id"]),
                status="failed",
                session_id=session_id,
                error=str(error),
            )
            invalidate_dashboard_cache(project_id)

        if not state.submit_command(
            lambda: client.run_command(
                session_id,
                item_id,
                payload.arguments,
                agent=payload.agent,
                model=payload.model,
                variant=payload.variant,
            ),
            before_start=mark_task_running,
            on_error=mark_task_failed,
        ):
            raise HTTPException(status_code=429, detail="too many commands are already running")
        return {"accepted": True}

    @app.get("/api/v1/projects/{project_id}/agents")
    def agents(project_id: str) -> list[dict[str, Any]]:
        project = project_or_404(project_id)
        root = workspace_for(project)
        items: dict[str, dict[str, Any]] = {}
        global_root = Path.home() / ".config/opencode"
        for directory in (global_root / "agent", global_root / "agents"):
            for item in list_external_markdown(directory):
                items[str(item["id"])] = {
                    **item,
                    "scope": "global",
                    "source": str(directory),
                    "editable": directory == global_root / "agents",
                }
        for directory in (Path(".opencode/agent"), Path(".opencode/agents")):
            for item in list_markdown(root, directory):
                items[str(item["id"])] = {
                    **item,
                    "scope": "project",
                    "source": str(Path(str(project["root"])) / directory),
                    "editable": directory == Path(".opencode/agents"),
                }
        return sorted(items.values(), key=lambda item: str(item["id"]))

    @app.put("/api/v1/projects/{project_id}/agents/{agent_id}")
    def save_agent(
        project_id: str,
        agent_id: str,
        payload: ScopedTextWrite,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        item_id = validate_item_id(agent_id)
        if payload.scope == "global":
            global_root = Path.home() / ".config/opencode"
            write_text(
                root_identity(global_root),
                Path(f"agents/{item_id}.md"),
                payload.content,
            )
        else:
            write_text(
                workspace_for(project),
                Path(f".opencode/agents/{item_id}.md"),
                payload.content,
            )
        return {
            "id": item_id,
            "content": payload.content,
            "restarted": restart_changed_resources(project, payload.scope),
        }

    @app.delete("/api/v1/projects/{project_id}/agents/{agent_id}", status_code=204)
    def remove_agent(
        project_id: str,
        agent_id: str,
        guard: WriteGuard,
        scope: Literal["project", "global"] = "project",
    ) -> Response:
        project = project_or_404(project_id)
        item_id = validate_item_id(agent_id)
        if scope == "global":
            delete_file(
                root_identity(Path.home() / ".config/opencode"),
                Path(f"agents/{item_id}.md"),
            )
        else:
            delete_file(workspace_for(project), Path(f".opencode/agents/{item_id}.md"))
        restart_changed_resources(project, scope)
        return Response(status_code=204)

    @app.get("/api/v1/projects/{project_id}/skills")
    def skills(project_id: str) -> list[dict[str, Any]]:
        project = project_or_404(project_id)
        return skill_entries(project)

    @app.post("/api/v1/projects/{project_id}/skill-imports/preview")
    def preview_skill_import(
        project_id: str,
        payload: SkillImportPreviewCreate,
        request: Request,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        session_id = browser_session_id(request)
        if not state.skill_import_slots.acquire(blocking=False):
            raise HTTPException(status_code=429, detail="Too many Skill downloads are active")
        try:
            downloaded = fetch_skill(payload.url)
        except SkillImportError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error
        finally:
            state.skill_import_slots.release()
        return store_skill_preview(project, session_id, payload.scope, downloaded)

    @app.post("/api/v1/projects/{project_id}/skill-imports/{preview_id}/rename")
    def rename_skill_import(
        project_id: str,
        preview_id: str,
        payload: SkillImportRename,
        request: Request,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        session_id = browser_session_id(request)
        preview = get_skill_preview(preview_id, project_id, session_id)
        if preview.get("result") is not None:
            raise HTTPException(status_code=409, detail="Skill preview was already used")
        try:
            downloaded = rename_downloaded_skill(
                cast(DownloadedSkill, preview["downloaded"]), payload.name
            )
        except SkillImportError as error:
            raise HTTPException(status_code=error.status_code, detail=error.detail) from error
        return store_skill_preview(
            project,
            session_id,
            cast(Literal["project", "global"], preview["scope"]),
            downloaded,
        )

    @app.post("/api/v1/projects/{project_id}/skill-imports/confirm")
    def confirm_skill_import(
        project_id: str,
        payload: SkillImportConfirm,
        request: Request,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        session_id = browser_session_id(request)
        preview = get_skill_preview(payload.preview_id, project_id, session_id)
        with state.skill_import_lock:
            existing_result = preview.get("result")
            if isinstance(existing_result, dict):
                return existing_result
            if preview.get("processing"):
                raise HTTPException(status_code=409, detail="Skill import is already processing")
            preview["processing"] = True
        try:
            downloaded = cast(DownloadedSkill, preview["downloaded"])
            document = downloaded.document
            scope = cast(Literal["project", "global"], preview["scope"])
            conflict = cast(dict[str, Any], preview["conflict"])
            if conflict["has_conflict"] and payload.conflict_policy == "skip":
                result: dict[str, Any] = {
                    "state": "skipped",
                    "id": document.name,
                    "scope": scope,
                    "restarted": {},
                }
            else:
                root, relative, target_path = skill_target(project, scope, document.name)
                with state.config_lock:
                    current_conflict, current_sha256 = skill_conflicts(project, scope, document)
                    if current_sha256 != preview["target_sha256"]:
                        raise HTTPException(
                            status_code=409,
                            detail="Skill target changed after preview; review it again",
                        )
                    if current_conflict["has_conflict"] and payload.conflict_policy == "skip":
                        result = {
                            "state": "skipped",
                            "id": document.name,
                            "scope": scope,
                            "restarted": {},
                        }
                    else:
                        if len(downloaded.files) == 1:
                            write_text(root, relative, document.content)
                        else:
                            replace_directory(
                                root,
                                relative.parent,
                                {
                                    Path(file.path): WorkspaceTreeFile(file.content, file.mode)
                                    for file in downloaded.files
                                },
                            )
                        result = {
                            "state": "imported",
                            "id": document.name,
                            "scope": scope,
                            "path": target_path,
                            "sha256": document.sha256,
                            "source_url": preview["source_url"],
                            "file_count": len(downloaded.files),
                            "restarted": {},
                        }
                if result["state"] == "imported":
                    result["restarted"] = restart_changed_resources(project, scope)
            with state.skill_import_lock:
                preview["processing"] = False
                preview["result"] = result
            return result
        except Exception:
            with state.skill_import_lock:
                preview["processing"] = False
            raise

    @app.put("/api/v1/projects/{project_id}/skills/{skill_id}")
    def save_skill(
        project_id: str,
        skill_id: str,
        payload: ScopedTextWrite,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        item_id = validate_item_id(skill_id)
        if payload.scope == "global":
            global_root = Path.home() / ".config/opencode"
            write_text(
                root_identity(global_root),
                Path(f"skills/{item_id}/SKILL.md"),
                payload.content,
            )
        else:
            write_text(
                workspace_for(project),
                Path(f".opencode/skills/{item_id}/SKILL.md"),
                payload.content,
            )
        return {
            "id": item_id,
            "content": payload.content,
            "restarted": restart_changed_resources(project, payload.scope),
        }

    @app.patch("/api/v1/projects/{project_id}/skills/{skill_id}")
    def update_skill(
        project_id: str,
        skill_id: str,
        payload: SkillUpdate,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        source_id = validate_item_id(skill_id)
        target_id = validate_item_id(payload.name)
        if parse_frontmatter(payload.content).get("name") != target_id:
            raise HTTPException(
                status_code=422,
                detail="Skill frontmatter name must match the target directory",
            )
        source_root, source_directory = skill_directory(project, payload.source_scope, source_id)
        target_root, target_directory = skill_directory(project, payload.target_scope, target_id)
        source_files = snapshot_directory(source_root, source_directory)
        if source_files is None:
            raise HTTPException(status_code=404, detail="Skill directory not found")
        source_files[Path("SKILL.md")] = WorkspaceTreeFile(payload.content.encode("utf-8"), 0o600)
        same_target = source_root.path == target_root.path and source_directory == target_directory
        with state.config_lock:
            if same_target:
                write_text(source_root, source_directory / "SKILL.md", payload.content)
            else:
                if snapshot_directory(target_root, target_directory) is not None:
                    raise HTTPException(
                        status_code=409, detail="A Skill with the target name already exists"
                    )
                replace_directory(target_root, target_directory, source_files)
                try:
                    delete_directory(source_root, source_directory)
                except Exception:
                    with suppress(Exception):
                        delete_directory(target_root, target_directory)
                    raise
        restart_scope: Literal["project", "global"] = (
            "global" if "global" in {payload.source_scope, payload.target_scope} else "project"
        )
        return {
            "id": target_id,
            "scope": payload.target_scope,
            "content": payload.content,
            "file_count": len(source_files),
            "restarted": restart_changed_resources(project, restart_scope),
        }

    @app.delete("/api/v1/projects/{project_id}/skills/{skill_id}", status_code=204)
    def remove_skill(
        project_id: str,
        skill_id: str,
        guard: WriteGuard,
        scope: Literal["project", "global"] = "project",
    ) -> Response:
        project = project_or_404(project_id)
        item_id = validate_item_id(skill_id)
        if scope == "global":
            global_root = root_identity(Path.home() / ".config/opencode")
            delete_directory(global_root, Path(f"skills/{item_id}"))
        else:
            project_root = workspace_for(project)
            delete_directory(project_root, Path(f".opencode/skills/{item_id}"))
        restart_changed_resources(project, scope)
        return Response(status_code=204)

    @app.get("/api/v1/projects/{project_id}/instructions")
    def instructions(project_id: str) -> dict[str, Any]:
        project = project_or_404(project_id)
        project_root = workspace_for(project)
        project_file = Path("AGENTS.md")
        global_path = Path.home() / ".config/opencode/AGENTS.md"
        global_content = read_external_text(global_path)
        return {
            "content": read_text(project_root, project_file),
            "path": str(Path(str(project["root"])) / "AGENTS.md"),
            "project_exists": file_exists(project_root, project_file),
            "global_content": global_content,
            "global_path": str(global_path),
            "global_exists": external_file_exists(global_path),
        }

    @app.put("/api/v1/projects/{project_id}/instructions")
    def save_instructions(
        project_id: str,
        payload: TextWrite,
        guard: WriteGuard,
    ) -> dict[str, str]:
        project = project_or_404(project_id)
        write_text(workspace_for(project), Path("AGENTS.md"), payload.content)
        return {"content": payload.content}

    @app.put("/api/v1/projects/{project_id}/instructions/global")
    def save_global_instructions(
        project_id: str,
        payload: TextWrite,
        guard: WriteGuard,
    ) -> dict[str, str]:
        project_or_404(project_id)
        global_root = Path.home() / ".config/opencode"
        if not global_root.is_dir():
            raise WorkspaceError("global OpenCode config directory does not exist")
        write_text(root_identity(global_root), Path("AGENTS.md"), payload.content)
        return {"content": payload.content, "path": str(global_root / "AGENTS.md")}

    @app.get("/api/v1/projects/{project_id}/configuration")
    def configuration(project_id: str) -> dict[str, Any]:
        project = project_or_404(project_id)
        project_root = workspace_for(project)
        global_root, global_configs = _global_opencode_configs()
        project_relative = config_target(project_root)
        global_relative = config_target(global_root)
        project_value = read_jsonc_config(project_root, project_relative)
        global_value = global_configs.get(global_relative, {})
        return {
            "project": redact_for_browser(project_value),
            "project_path": str(project_root.path / project_relative),
            "global": redact_for_browser(global_value),
            "global_path": str(global_root.path / global_relative),
        }

    @app.patch("/api/v1/projects/{project_id}/configuration")
    def update_configuration(
        project_id: str,
        payload: ScopedConfigPatch,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        if payload.scope == "global":
            root, configs = _global_opencode_configs()
            relative = config_target(root)
            config_value = configs.get(relative, {})
        else:
            root = workspace_for(project)
            relative = config_target(root)
            config_value = read_jsonc_config(root, relative)
        replacement = preserve_redacted(config_value, payload.values)
        if not isinstance(replacement, dict):
            raise WorkspaceError("OpenCode config must contain an object")
        operation = apply_config_candidates(
            project,
            payload.scope,
            f"configuration:{payload.scope}",
            {ConfigFile(root, relative): render_jsonc_update(root, relative, replacement)},
        )
        return {
            "scope": payload.scope,
            "path": str(root.path / relative),
            "values": redact_for_browser(replacement),
            "operation": operation,
        }

    @app.get("/api/v1/projects/{project_id}/mcp/configuration")
    def mcp_configuration(project_id: str) -> dict[str, Any]:
        project = project_or_404(project_id)
        config_value = read_config(workspace_for(project))
        mcp = config_value.get("mcp", {})
        return cast(dict[str, Any], redact_for_browser(mcp)) if isinstance(mcp, dict) else {}

    @app.get("/api/v1/projects/{project_id}/mcp/global")
    def global_mcp_configuration(project_id: str) -> dict[str, Any]:
        project_or_404(project_id)
        _, configs = _global_opencode_configs()
        return cast(dict[str, Any], redact_for_browser(_merged_global_mcp(configs)))

    @app.get("/api/v1/projects/{project_id}/mcp/effective")
    def effective_mcp_configuration(project_id: str) -> dict[str, Any]:
        config_value = client_for(project_id).request("GET", "/config")
        if not isinstance(config_value, dict):
            return {}
        mcp = config_value.get("mcp", {})
        return cast(dict[str, Any], redact_for_browser(mcp)) if isinstance(mcp, dict) else {}

    @app.put("/api/v1/projects/{project_id}/mcp/{name}")
    def save_mcp(
        project_id: str,
        name: str,
        payload: McpWrite,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        item_id = validate_item_id(name)
        if payload.scope == "global":
            root, configs = _global_opencode_configs()
            relative, config_value = _global_mcp_target(configs, item_id)
        else:
            root = workspace_for(project)
            configs = _project_opencode_configs(root)
            relative, config_value = _project_mcp_target(root, configs, item_id)
        mcp = config_value.setdefault("mcp", {})
        if not isinstance(mcp, dict):
            raise WorkspaceError("OpenCode config mcp section must be an object")
        normalized = _normalize_mcp_config(payload.config)
        mcp[item_id] = preserve_redacted(mcp.get(item_id), normalized)
        operation = apply_config_candidates(
            project,
            payload.scope,
            f"mcp:{item_id}",
            {ConfigFile(root, relative): render_jsonc_update(root, relative, config_value)},
        )
        return {
            "name": item_id,
            "scope": payload.scope,
            "config": redact_for_browser(mcp[item_id]),
            "operation": operation,
        }

    @app.patch("/api/v1/projects/{project_id}/mcp/{name}/enabled")
    def set_mcp_enabled(
        project_id: str,
        name: str,
        payload: McpEnabledWrite,
        guard: WriteGuard,
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        item_id = validate_item_id(name)
        if payload.scope == "global":
            root, configs = _global_opencode_configs()
            if item_id not in _merged_global_mcp(configs):
                raise HTTPException(status_code=404, detail="global MCP server not found")
            relative, config_value = _global_mcp_target(configs, item_id)
        else:
            root = workspace_for(project)
            configs = _project_opencode_configs(root)
            relative, config_value = _project_mcp_target(root, configs, item_id)
        mcp = config_value.setdefault("mcp", {})
        if not isinstance(mcp, dict):
            raise WorkspaceError("OpenCode config mcp section must be an object")
        current = mcp.get(item_id)
        inherited = False
        global_entry: dict[str, Any] | None = None
        if payload.scope == "project" and current is None:
            _, global_configs = _global_opencode_configs()
            candidate = _merged_global_mcp(global_configs).get(item_id)
            if not isinstance(candidate, dict):
                raise HTTPException(status_code=404, detail="MCP server not found")
            global_entry = candidate
            current = {}
        if not isinstance(current, dict):
            raise WorkspaceError("MCP server config must be an object")
        if payload.scope == "project":
            if global_entry is None:
                _, global_configs = _global_opencode_configs()
                candidate = _merged_global_mcp(global_configs).get(item_id)
                global_entry = candidate if isinstance(candidate, dict) else None
            global_enabled = global_entry.get("enabled") is not False if global_entry else None
            if global_enabled is not None and payload.enabled == global_enabled:
                next_config = dict(current)
                next_config.pop("enabled", None)
                if next_config:
                    mcp[item_id] = next_config
                else:
                    mcp.pop(item_id, None)
                    if not mcp:
                        config_value.pop("mcp", None)
                inherited = True
            else:
                mcp[item_id] = {**current, "enabled": payload.enabled}
        else:
            mcp[item_id] = {**current, "enabled": payload.enabled}
        operation = apply_config_candidates(
            project,
            payload.scope,
            f"mcp-enabled:{item_id}",
            {ConfigFile(root, relative): render_jsonc_update(root, relative, config_value)},
        )
        return {
            "name": item_id,
            "scope": payload.scope,
            "enabled": payload.enabled,
            "inherited": inherited,
            "operation": operation,
        }

    @app.delete("/api/v1/projects/{project_id}/mcp/{name}")
    def remove_mcp(
        project_id: str,
        name: str,
        guard: WriteGuard,
        scope: Literal["project", "global"] = "project",
    ) -> dict[str, Any]:
        project = project_or_404(project_id)
        item_id = validate_item_id(name)
        if scope == "global":
            root, configs = _global_opencode_configs()
            candidate_files: dict[ConfigFile, str] = {}
            for relative, config_value in configs.items():
                mcp = config_value.get("mcp")
                if isinstance(mcp, dict) and item_id in mcp:
                    mcp.pop(item_id)
                    if not mcp:
                        config_value.pop("mcp", None)
                    candidate_files[ConfigFile(root, relative)] = render_jsonc_update(
                        root, relative, config_value
                    )
            if not candidate_files:
                raise HTTPException(status_code=404, detail="global MCP server not found")
            operation = apply_config_candidates(
                project, "global", f"mcp-remove:{item_id}", candidate_files
            )
            return {"name": item_id, "scope": scope, "operation": operation}
        root = workspace_for(project)
        configs = _project_opencode_configs(root)
        relative, config_value = _project_mcp_target(root, configs, item_id)
        mcp = config_value.get("mcp")
        if not isinstance(mcp, dict) or item_id not in mcp:
            raise HTTPException(status_code=404, detail="project MCP server not found")
        mcp.pop(item_id)
        if not mcp:
            config_value.pop("mcp", None)
        operation = apply_config_candidates(
            project,
            "project",
            f"mcp-remove:{item_id}",
            {ConfigFile(root, relative): render_jsonc_update(root, relative, config_value)},
        )
        return {"name": item_id, "scope": scope, "operation": operation}

    @app.post("/api/v1/projects/{project_id}/mcp/{name}/{action}")
    def mcp_connection(
        project_id: str,
        name: str,
        action: Literal["connect", "disconnect"],
        guard: WriteGuard,
    ) -> dict[str, bool]:
        item_id = validate_item_id(name)
        client_for(project_id).request("POST", f"/mcp/{_segment(item_id)}/{action}", body={})
        return {action: True}

    static_root = Path(__file__).with_name("static")
    assets = static_root / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/favicon.svg", include_in_schema=False)
    def favicon() -> Response:
        path = static_root / "favicon.svg"
        if not path.exists():
            raise HTTPException(status_code=404, detail="not found")
        return FileResponse(path, media_type="image/svg+xml")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> Response:
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="not found")
        index = static_root / "index.html"
        if not index.exists():
            return JSONResponse(
                {
                    "product": "OpenCode Control",
                    "detail": "Frontend bundle is missing. Run npm run build --prefix web.",
                }
            )
        return FileResponse(index, media_type="text/html")

    return app


def _search_message_entries(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for index, message in enumerate(messages):
        info = message.get("info")
        parts = message.get("parts")
        if not isinstance(info, dict) or not isinstance(parts, list):
            continue
        text = "\n\n".join(
            str(part["text"])
            for part in parts
            if isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
            and part["text"]
        )[:500_000]
        if not text:
            continue
        raw_time = info.get("time")
        raw_created = raw_time.get("created") if isinstance(raw_time, dict) else None
        entries.append(
            {
                "id": str(info.get("id") or f"message-{index}"),
                "role": str(info["role"])[:32] if isinstance(info.get("role"), str) else None,
                "created_at": float(raw_created)
                if isinstance(raw_created, (int, float)) and math.isfinite(raw_created)
                else None,
                "content": text,
                "artifacts": _local_artifact_paths(text),
            }
        )
    return entries


_MARKDOWN_FILE_LINK = re.compile(r"\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)")
_RASTER_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico"}
_ARTIFACT_SUFFIXES = _RASTER_SUFFIXES | {
    ".pdf",
    ".csv",
    ".json",
    ".zip",
    ".txt",
    ".md",
    ".log",
}


def _local_artifact_paths(content: str) -> list[str]:
    paths: list[str] = []
    for match in _MARKDOWN_FILE_LINK.finditer(content):
        value = urllib.parse.unquote(match.group(1).split("#", 1)[0].split("?", 1)[0])
        if value.startswith("file://"):
            value = urllib.parse.urlparse(value).path
        elif re.match(r"^[a-z][a-z0-9+.-]*:", value, re.IGNORECASE):
            continue
        if Path(value).suffix.lower() not in _ARTIFACT_SUFFIXES or value in paths:
            continue
        paths.append(value[:4096])
    return paths


def _safe_project_file(root: Path, raw_path: str) -> tuple[Path, Any]:
    if "\x00" in raw_path:
        raise HTTPException(status_code=400, detail="media path is invalid")
    try:
        resolved_root = root.resolve(strict=True)
        requested = Path(raw_path).expanduser()
        candidate = requested if requested.is_absolute() else resolved_root / requested
        resolved = candidate.resolve(strict=True)
        relative = resolved.relative_to(resolved_root)
    except (OSError, RuntimeError, ValueError) as error:
        raise HTTPException(status_code=404, detail="project media was not found") from error
    try:
        lexical_relative = candidate.relative_to(resolved_root)
    except ValueError:
        lexical_relative = relative
    current = resolved_root
    for part in lexical_relative.parts:
        if part == "..":
            raise HTTPException(status_code=403, detail="media path leaves the project root")
        current /= part
        if current.is_symlink():
            raise HTTPException(status_code=403, detail="symlinked project media is not allowed")
    stat_result = resolved.stat()
    if not resolved.is_file() or stat_result.st_nlink != 1:
        raise HTTPException(status_code=403, detail="project media must be a regular file")
    if stat_result.st_size > 50 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="project media is larger than 50 MB")
    return resolved, stat_result


def _safe_project_media(root: Path, raw_path: str) -> tuple[Path, Any]:
    resolved, stat_result = _safe_project_file(root, raw_path)
    with resolved.open("rb") as handle:
        signature = handle.read(16)
    if not _is_safe_raster_image(signature):
        raise HTTPException(
            status_code=415,
            detail="only PNG, JPEG, GIF, WebP, AVIF and ICO are supported",
        )
    return resolved, stat_result


def _safe_project_artifact(root: Path, raw_path: str) -> tuple[Path, Any, str, str]:
    resolved, stat_result = _safe_project_file(root, raw_path)
    suffix = resolved.suffix.lower()
    if suffix not in _ARTIFACT_SUFFIXES:
        raise HTTPException(status_code=415, detail="artifact format is not supported")
    with resolved.open("rb") as handle:
        sample = handle.read(min(stat_result.st_size, 1024 * 1024))
    if suffix in _RASTER_SUFFIXES:
        if not _is_safe_raster_image(sample[:16]):
            raise HTTPException(status_code=415, detail="image signature is invalid")
        kind = "image"
    elif suffix == ".pdf":
        if not sample.startswith(b"%PDF-"):
            raise HTTPException(status_code=415, detail="PDF signature is invalid")
        kind = "pdf"
    elif suffix == ".zip":
        if not sample.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08")):
            raise HTTPException(status_code=415, detail="ZIP signature is invalid")
        kind = "archive"
    else:
        if b"\x00" in sample:
            raise HTTPException(status_code=415, detail="text artifact contains binary data")
        try:
            sample.decode("utf-8")
        except UnicodeDecodeError as error:
            raise HTTPException(status_code=415, detail="text artifact is not UTF-8") from error
        kind = "data" if suffix in {".csv", ".json"} else "text"
    media_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
    return resolved, stat_result, kind, media_type


def _artifact_id(project_id: str, path: Path) -> str:
    return hashlib.sha256(f"{project_id}:{path}".encode()).hexdigest()[:24]


def _reveal_file(path: Path) -> None:
    if sys.platform == "darwin":
        command = ["open", "-R", str(path)]
    elif sys.platform.startswith("linux"):
        command = ["xdg-open", str(path.parent)]
    elif sys.platform == "win32":
        command = ["explorer", f"/select,{path}"]
    else:
        raise HTTPException(status_code=501, detail="file reveal is not supported")
    try:
        subprocess.run(command, check=True, capture_output=True, timeout=10)
    except FileNotFoundError as error:
        raise HTTPException(status_code=501, detail="system file manager is unavailable") from error
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise HTTPException(status_code=500, detail="failed to reveal artifact") from error


def _move_to_trash(path: Path) -> None:
    try:
        send2trash(path)
    except (OSError, TypeError) as error:
        raise HTTPException(status_code=500, detail="failed to move artifact to Trash") from error


_MISSING_IMAGE_SVG = (
    b'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" '
    b'viewBox="0 0 640 400"><rect width="640" height="400" fill="#11141a"/>'
    b'<path d="M250 275l55-70 42 48 38-43 55 65H250z" fill="#363d49"/>'
    b'<circle cx="285" cy="155" r="24" fill="#4b5565"/>'
    b'<rect x="220" y="110" width="200" height="180" rx="18" fill="none" '
    b'stroke="#4b5565" stroke-width="8"/><text x="320" y="335" fill="#818a99" '
    b'font-family="system-ui,sans-serif" font-size="18" text-anchor="middle">'
    b"Image file is no longer available</text></svg>"
)


def _safe_missing_media_path(root: Path, raw_path: str) -> bool:
    if "\x00" in raw_path:
        return False
    requested = Path(raw_path).expanduser()
    if requested.suffix.lower() not in _RASTER_SUFFIXES:
        return False
    try:
        resolved_root = root.resolve(strict=True)
        candidate = requested if requested.is_absolute() else resolved_root / requested
        resolved = candidate.resolve(strict=False)
        relative = resolved.relative_to(resolved_root)
    except (OSError, RuntimeError, ValueError):
        return False
    current = resolved_root
    for part in relative.parts[:-1]:
        current /= part
        if current.is_symlink():
            return False
    return not resolved.exists()


def _is_safe_raster_image(signature: bytes) -> bool:
    return (
        signature.startswith(b"\x89PNG\r\n\x1a\n")
        or signature.startswith(b"\xff\xd8\xff")
        or signature.startswith((b"GIF87a", b"GIF89a"))
        or (signature.startswith(b"RIFF") and signature[8:12] == b"WEBP")
        or (
            len(signature) >= 12
            and signature[4:8] == b"ftyp"
            and signature[8:12] in {b"avif", b"avis"}
        )
        or signature.startswith(b"\x00\x00\x01\x00")
    )


def _search_snippet(content: str, query: str, *, radius: int = 120) -> str:
    compact = re.sub(r"\s+", " ", content).strip()
    match = re.search(re.escape(query), compact, re.IGNORECASE)
    if match is None:
        return compact[: radius * 2]
    start = max(0, match.start() - radius)
    end = min(len(compact), match.end() + radius)
    return f"{'…' if start else ''}{compact[start:end]}{'…' if end < len(compact) else ''}"


def _project_view(project: dict[str, Any], server: dict[str, object]) -> dict[str, Any]:
    if server.get("state") == "stopped" and project.get("endpoint"):
        server = {
            "state": "external",
            "managed": False,
            "endpoint": project["endpoint"],
            "compatibility": server.get("compatibility"),
            "last_error": server.get("last_error"),
        }
    return {
        "id": project["id"],
        "name": project["name"],
        "root": project["root"],
        "endpoint": project["endpoint"],
        "created_at": project["created_at"],
        "updated_at": project["updated_at"],
        "server": server,
    }


def _segment(value: str) -> str:
    return urllib.parse.quote(value, safe="")


def _slash_command(value: str) -> tuple[str, str] | None:
    match = re.fullmatch(r"/([a-z0-9][a-z0-9_-]{0,63})(?:\s+([\s\S]*))?", value.strip())
    return (match.group(1), match.group(2) or "") if match else None


def _local_host(value: str | None) -> bool:
    if value in {"localhost", "testserver", "testclient"}:
        return True
    if not value:
        return False
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def _successful_assistant_after(messages: list[Any], updated_at: Any) -> bool:
    if not isinstance(updated_at, str):
        return False
    try:
        cutoff_ms = datetime.fromisoformat(updated_at).timestamp() * 1000
    except ValueError:
        return False
    for message in messages:
        if not isinstance(message, dict):
            continue
        info = message.get("info")
        if not isinstance(info, dict) or info.get("role") != "assistant" or info.get("error"):
            continue
        raw_time = info.get("time")
        message_time = raw_time if isinstance(raw_time, dict) else {}
        raw_parts = message.get("parts")
        parts = raw_parts if isinstance(raw_parts, list) else []
        finished = (
            bool(message_time.get("completed"))
            or info.get("finish") == "stop"
            or any(isinstance(part, dict) and part.get("type") == "step-finish" for part in parts)
        )
        occurred = message_time.get("completed") or message_time.get("created")
        if not finished or not isinstance(occurred, (int, float)):
            continue
        occurred_ms = float(occurred) if occurred > 100_000_000_000 else float(occurred) * 1000
        if occurred_ms > cutoff_ms:
            return True
    return False


def _next_cron_run(
    expression: str,
    timezone: str,
    base: datetime | None = None,
) -> str:
    zone = ZoneInfo(timezone)
    current = (base or datetime.now(UTC)).astimezone(zone)
    next_run = croniter(expression, current).get_next(datetime)
    return next_run.astimezone(UTC).isoformat()


def _validate_external_project(client: OpenCodeClient, expected_root: Path) -> None:
    current = client.request("GET", "/project/current")
    if not isinstance(current, dict):
        raise OpenCodeError("external OpenCode server returned an invalid project identity")
    raw_root = current.get("worktree") or current.get("directory")
    if not isinstance(raw_root, str):
        raise OpenCodeError("external OpenCode server did not report its project root")
    try:
        actual_root = Path(raw_root).resolve(strict=True)
    except OSError as error:
        raise OpenCodeError("external OpenCode project root is unavailable") from error
    if actual_root != expected_root:
        raise OpenCodeError("external OpenCode server belongs to a different project")
