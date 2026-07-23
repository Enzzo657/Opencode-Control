from __future__ import annotations

import asyncio
import base64
import binascii
import ipaddress
import re
import secrets
import sqlite3
import urllib.parse
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal, cast
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from opencode_studio.config import StudioConfig
from opencode_studio.git_workspace import (
    GitError,
    git_commit,
    git_diff,
    git_reset,
    git_revert,
    git_stage,
    git_state,
    git_unstage,
)
from opencode_studio.opencode_client import OpenCodeClient, OpenCodeError
from opencode_studio.processes import OpenCodeProcessManager, ProcessError
from opencode_studio.store import StudioStore
from opencode_studio.workspace import (
    WorkspaceError,
    WorkspaceRoot,
    config_target,
    delete_empty_directory,
    delete_file,
    external_file_exists,
    file_exists,
    list_external_markdown,
    list_markdown,
    preserve_redacted,
    read_config,
    read_external_text,
    read_jsonc_config,
    read_text,
    resolve_project_root,
    root_identity,
    validate_item_id,
    validate_root,
    write_config,
    write_json_config,
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


class PromptCreate(StrictModel):
    prompt: str = Field(default="", max_length=200_000)
    agent: str | None = Field(default=None, max_length=128)
    model: str | None = Field(default=None, max_length=256)
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
    cron: str | None = Field(default=None, min_length=9, max_length=100)
    timezone: str | None = Field(default=None, min_length=1, max_length=100)
    cron_session_mode: Literal["new", "reuse"] | None = None

    @model_validator(mode="after")
    def validate_schedule(self) -> TaskScheduleUpdate:
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
        if any(
            not model.strip() or len(model) > 500 or "\0" in model
            for model in self.models
        ):
            raise ValueError("provider model ID is invalid")
        return self


class PermissionReply(StrictModel):
    reply: Literal["once", "always", "reject"]


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


class StudioState:
    def __init__(self, config: StudioConfig) -> None:
        self.config = config
        self.store = StudioStore(config.data_dir)
        self.processes = OpenCodeProcessManager(
            binary=config.opencode_binary,
            data_dir=config.data_dir,
        )
        self.browser_sessions: dict[str, str] = {}

    def close(self) -> None:
        self.processes.shutdown()
        self.store.close()


def csrf_guard(
    request: Request,
    x_csrf_token: Annotated[str | None, Header()] = None,
) -> None:
    state = cast(StudioState, request.app.state.studio)
    session_id = request.cookies.get("studio_session")
    expected = state.browser_sessions.get(session_id or "")
    if expected is None or not secrets.compare_digest(expected, x_csrf_token or ""):
        raise HTTPException(status_code=403, detail="invalid browser session or CSRF token")


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


def create_app(config: StudioConfig | None = None) -> FastAPI:
    studio_config = config or StudioConfig.from_environment()
    state = StudioState(studio_config)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        scheduler = asyncio.create_task(scheduler_loop())
        try:
            yield
        finally:
            scheduler.cancel()
            with suppress(asyncio.CancelledError):
                await scheduler
            state.close()

    app = FastAPI(title="OpenCode Studio", version="0.1.0", lifespan=lifespan)
    app.state.studio = state

    @app.middleware("http")
    async def local_boundary(request: Request, call_next: Any) -> Response:
        host = urllib.parse.urlsplit(f"//{request.headers.get('host', '')}").hostname
        client_host = request.client.host if request.client else ""
        server = request.scope.get("server")
        server_host = str(server[0]) if isinstance(server, (list, tuple)) and server else ""
        if not _local_host(host) or not _local_host(client_host) or not _local_host(server_host):
            return JSONResponse({"detail": "OpenCode Studio is loopback-only"}, status_code=400)
        origin = request.headers.get("origin")
        if origin:
            parsed = urllib.parse.urlsplit(origin)
            if not _local_host(parsed.hostname):
                return JSONResponse({"detail": "cross-origin request rejected"}, status_code=403)
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
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'"
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
        if not isinstance(device, int) or not isinstance(inode, int):
            raise HTTPException(status_code=409, detail="project root identity is unavailable")
        return WorkspaceRoot(Path(str(project["root"])), device, inode)

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
                guard=(lambda: state.processes.lease(project_id, managed))
                if managed
                else None,
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
        return client_for(project_id)

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
                f"Ожидаемый результат: {task['title']}\n\n"
                f"Подробное задание:\n{task['prompt']}"
            )
            client.prompt_async(
                session_id,
                dispatched_prompt,
                agent=task.get("agent"),
                model=task.get("model"),
                attachments=attachments or [],
            )
            updated = state.store.update_task(
                project_id,
                str(task["id"]),
                status="running",
                session_id=session_id,
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
            client.prompt_async(
                session_id,
                (
                    f"Продолжи задачу в этой же сессии: {task['title']}\n\n"
                    f"Актуальное задание:\n{task['prompt']}\n\n"
                    "Проверь текущее состояние файлов и выполни очередной запуск."
                ),
                agent=task.get("agent"),
                model=task.get("model"),
            )
            updated = state.store.update_task(
                project_id,
                str(task["id"]),
                status="running",
                session_id=session_id,
                error=None,
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
            return False
        errors = snapshot.get("errors")
        if isinstance(errors, list) and any(
            error in {"sessions_unavailable", "statuses_unavailable"} for error in errors
        ):
            return True
        statuses = snapshot.get("statuses")
        status = statuses.get(session_id) if isinstance(statuses, dict) else None
        value = status.get("type") or status.get("status") if isinstance(status, dict) else None
        return value in {"busy", "dispatching", "in_progress", "pending", "queued", "running"}

    def run_due_tasks() -> None:
        now = datetime.now(UTC)
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
            claimed = state.store.claim_scheduled_run(
                str(candidate["project_id"]),
                str(candidate["id"]),
                expected_run_at=expected,
                next_run_at=next_run,
                claimed_at=now.isoformat(),
            )
            if not claimed:
                continue
            current = state.store.get_task(str(candidate["project_id"]), str(candidate["id"]))
            if current is None:
                continue
            if current["status"] in {"queued", "dispatching", "running"}:
                if task_runtime_active(str(candidate["project_id"]), current):
                    continue
                updated = state.store.update_task(
                    str(candidate["project_id"]),
                    str(candidate["id"]),
                    status="scheduled",
                )
                if updated is None:
                    continue
                current = updated
            with suppress(Exception):
                if current.get("cron_session_mode") == "reuse":
                    continue_task(str(candidate["project_id"]), current)
                else:
                    dispatch_task(str(candidate["project_id"]), current)

    async def scheduler_loop() -> None:
        while True:
            with suppress(Exception):
                await asyncio.to_thread(run_due_tasks)
            await asyncio.sleep(15)

    @app.exception_handler(WorkspaceError)
    async def workspace_error(request: Request, error: WorkspaceError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=400)

    @app.exception_handler(OpenCodeError)
    async def opencode_error(request: Request, error: OpenCodeError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=502)

    @app.exception_handler(ProcessError)
    async def process_error(request: Request, error: ProcessError) -> JSONResponse:
        return JSONResponse({"detail": str(error)}, status_code=409)

    @app.get("/api/v1/session")
    def browser_session(request: Request, response: Response) -> dict[str, str]:
        session_id = request.cookies.get("studio_session")
        if session_id not in state.browser_sessions:
            if len(state.browser_sessions) >= 256:
                state.browser_sessions.pop(next(iter(state.browser_sessions)))
            session_id = secrets.token_urlsafe(24)
            state.browser_sessions[session_id] = secrets.token_urlsafe(32)
        response.set_cookie(
            "studio_session",
            session_id,
            httponly=True,
            samesite="strict",
            secure=False,
            path="/",
        )
        return {"csrf_token": state.browser_sessions[session_id], "product": "OpenCode Studio"}

    @app.get("/api/v1/health")
    def health() -> dict[str, Any]:
        return {"healthy": True, "version": "0.1.0", "projects": len(state.store.list_projects())}

    @app.get("/api/v1/projects")
    def projects() -> list[dict[str, Any]]:
        return [
            _project_view(item, state.processes.status(str(item["id"])))
            for item in state.store.list_projects()
        ]

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
        return _project_view(project, state.processes.status(str(project["id"])))

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
        return _project_view(updated, state.processes.status(project_id))

    @app.delete("/api/v1/projects/{project_id}", status_code=204)
    def remove_project(project_id: str, guard: WriteGuard) -> Response:
        project_or_404(project_id)
        state.processes.stop(project_id)
        state.store.delete_project(project_id)
        return Response(status_code=204)

    @app.get("/api/v1/projects/{project_id}/server")
    def server_status(project_id: str) -> dict[str, Any]:
        project = project_or_404(project_id)
        status = state.processes.status(project_id)
        if status["state"] == "stopped" and project.get("endpoint"):
            status = {"state": "external", "managed": False, "endpoint": project["endpoint"]}
        return status

    @app.post("/api/v1/projects/{project_id}/server/start")
    def start_server(project_id: str, guard: WriteGuard) -> dict[str, object]:
        project = project_or_404(project_id)
        workspace = workspace_for(project)
        validate_root(workspace)
        try:
            return state.processes.start(project_id, workspace)
        except ProcessError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.post("/api/v1/projects/{project_id}/server/stop")
    def stop_server(project_id: str, guard: WriteGuard) -> dict[str, object]:
        project_or_404(project_id)
        return state.processes.stop(project_id)

    @app.post("/api/v1/projects/{project_id}/server/restart")
    def restart_server(project_id: str, guard: WriteGuard) -> dict[str, object]:
        project = project_or_404(project_id)
        if project.get("endpoint"):
            raise HTTPException(
                status_code=409,
                detail="external OpenCode server must be restarted outside Studio",
            )
        workspace = workspace_for(project)
        validate_root(workspace)
        state.processes.stop(project_id)
        return state.processes.start(project_id, workspace)

    @app.post("/api/v1/servers/restart")
    def restart_running_servers(guard: WriteGuard) -> dict[str, dict[str, object]]:
        restarted: dict[str, dict[str, object]] = {}
        for project in state.store.list_projects():
            project_id = str(project["id"])
            if state.processes.status(project_id)["state"] != "running":
                continue
            workspace = workspace_for(project)
            validate_root(workspace)
            state.processes.stop(project_id)
            restarted[project_id] = state.processes.start(project_id, workspace)
        return restarted

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
        snapshot = client_for(project_id).snapshot()
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
                        session["studio_task"] = task
                        break
                    parent_id = current.get("parentID")
                    current = by_id.get(str(parent_id)) if parent_id else None
        snapshot["server"] = server if server["state"] == "running" else {
            "state": "external",
            "managed": False,
            "endpoint": endpoint,
        }
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
            raise HTTPException(
                status_code=422, detail="Некорректные данные OAuth"
            ) from error
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
            raise HTTPException(
                status_code=422, detail="Некорректный ответ OAuth"
            ) from error
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
        config_value = read_config(root)
        providers = config_value.setdefault("provider", {})
        if not isinstance(providers, dict):
            raise WorkspaceError("OpenCode config provider section must be an object")
        options: dict[str, Any] = {"baseURL": payload.base_url}
        if payload.api_key:
            managed_client_for_auth(project_id).set_provider_api_key(item_id, payload.api_key)
        providers[item_id] = {
            "npm": "@ai-sdk/openai-compatible",
            "name": payload.name,
            "options": options,
            "models": {model.strip(): {"name": model.strip()} for model in payload.models},
        }
        write_config(root, config_value)
        restarted = restart_changed_resources(project, "project")
        return {
            "id": item_id,
            "config": providers[item_id],
            "restarted": restarted,
        }

    @app.get("/api/v1/projects/{project_id}/sessions/{session_id}/messages")
    def session_messages(project_id: str, session_id: str) -> Any:
        client = client_for_session(project_id, session_id)
        assert client is not None
        return client.session_messages(session_id)

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
        return client.session_permissions(session_id)

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
            attachments=[item.model_dump() for item in payload.attachments],
            mentions=payload.mentions,
        )
        task = state.store.task_for_session(project_id, session_id)
        if task is not None:
            state.store.record_task_prompt(
                project_id,
                str(task["id"]),
                session_id=session_id,
                prompt=payload.prompt.strip() or None,
                agent=payload.agent,
                model=payload.model,
                update_agent="agent" in payload.model_fields_set,
                update_model="model" in payload.model_fields_set,
            )
        return {"accepted": True}

    @app.post("/api/v1/projects/{project_id}/sessions/{session_id}/abort")
    def abort_session(project_id: str, session_id: str, guard: WriteGuard) -> dict[str, bool]:
        client = client_for_session(project_id, session_id)
        assert client is not None
        client.request("POST", f"/session/{_segment(session_id)}/abort", body={})
        task = state.store.task_for_session(project_id, session_id)
        if task is not None and task["status"] in {"queued", "dispatching", "running"}:
            state.store.update_task(project_id, str(task["id"]), status="aborted")
        return {"aborted": True}

    @app.delete("/api/v1/projects/{project_id}/sessions/{session_id}", status_code=204)
    def delete_session(project_id: str, session_id: str, guard: WriteGuard) -> Response:
        client = client_for_session(project_id, session_id, missing_ok=True)
        if client is not None:
            client.delete_session(session_id, missing_ok=True)
        state.store.remove_task_session(project_id, session_id)
        return Response(status_code=204)

    @app.get("/api/v1/projects/{project_id}/tasks")
    def tasks(project_id: str) -> list[dict[str, Any]]:
        project_or_404(project_id)
        result = state.store.list_tasks(project_id)
        running = [item for item in result if item["status"] in {"dispatching", "running"}]
        if not running:
            return result
        try:
            snapshot = client_for(project_id).snapshot()
        except (OpenCodeError, HTTPException):
            return result
        statuses = snapshot.get("statuses", {})
        session_ids = {
            item.get("id")
            for item in snapshot.get("sessions", [])
            if isinstance(item, dict)
        }
        now = datetime.now(UTC)
        active_states = {"busy", "dispatching", "in_progress", "pending", "queued", "running"}
        for task in running:
            linked_ids = task.get("session_ids") or (
                [task["session_id"]] if task.get("session_id") else []
            )
            active = False
            failed = False
            failure_error: str | None = None
            for session_id in linked_ids:
                status = statuses.get(session_id, {}) if isinstance(statuses, dict) else {}
                value = (
                    status.get("type") or status.get("status")
                    if isinstance(status, dict)
                    else None
                )
                if value in active_states:
                    active = True
                    break
                if value in {"error", "failed"}:
                    failed = True
                    if isinstance(status.get("error"), str):
                        failure_error = status["error"]
            try:
                age = (now - datetime.fromisoformat(str(task["updated_at"]))).total_seconds()
            except ValueError:
                age = 0
            has_known_session = any(session_id in session_ids for session_id in linked_ids)
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
        return state.store.list_tasks(project_id)

    @app.post("/api/v1/projects/{project_id}/tasks", status_code=202)
    def launch_task(project_id: str, payload: TaskCreate, guard: WriteGuard) -> dict[str, Any]:
        project_or_404(project_id)
        task = state.store.create_task(
            project_id,
            title=payload.title,
            prompt=payload.prompt,
            agent=payload.agent,
            model=payload.model,
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
                next_run_at=(
                    _next_cron_run(payload.cron, payload.timezone) if enabled else None
                ),
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
        return Response(status_code=204)

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
            delete_file(global_root, Path(f"skills/{item_id}/SKILL.md"))
            delete_empty_directory(global_root, Path(f"skills/{item_id}"))
        else:
            project_root = workspace_for(project)
            delete_file(project_root, Path(f".opencode/skills/{item_id}/SKILL.md"))
            delete_empty_directory(project_root, Path(f".opencode/skills/{item_id}"))
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
            "project": project_value,
            "project_path": str(project_root.path / project_relative),
            "global": global_value,
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
        for key, value in payload.values.items():
            if value is None:
                config_value.pop(key, None)
            else:
                config_value[key] = preserve_redacted(config_value.get(key), value)
        write_json_config(root, relative, config_value)
        restarted = restart_changed_resources(project, payload.scope)
        return {
            "scope": payload.scope,
            "path": str(root.path / relative),
            "values": config_value,
            "restarted": restarted,
        }

    @app.get("/api/v1/projects/{project_id}/mcp/configuration")
    def mcp_configuration(project_id: str) -> dict[str, Any]:
        project = project_or_404(project_id)
        config_value = read_config(workspace_for(project))
        mcp = config_value.get("mcp", {})
        return cast(dict[str, Any], mcp) if isinstance(mcp, dict) else {}

    @app.get("/api/v1/projects/{project_id}/mcp/global")
    def global_mcp_configuration(project_id: str) -> dict[str, Any]:
        project_or_404(project_id)
        _, configs = _global_opencode_configs()
        return _merged_global_mcp(configs)

    @app.get("/api/v1/projects/{project_id}/mcp/effective")
    def effective_mcp_configuration(project_id: str) -> dict[str, Any]:
        config_value = client_for(project_id).request("GET", "/config")
        if not isinstance(config_value, dict):
            return {}
        mcp = config_value.get("mcp", {})
        return cast(dict[str, Any], mcp) if isinstance(mcp, dict) else {}

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
            relative = Path("opencode.json")
            config_value = read_config(root)
        mcp = config_value.setdefault("mcp", {})
        if not isinstance(mcp, dict):
            raise WorkspaceError("OpenCode config mcp section must be an object")
        mcp[item_id] = preserve_redacted(mcp.get(item_id), payload.config)
        if payload.scope == "global":
            write_json_config(root, relative, config_value)
        else:
            write_config(root, config_value)
        return {"name": item_id, "scope": payload.scope, "config": mcp[item_id]}

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
            relative = Path("opencode.json")
            config_value = read_config(root)
        mcp = config_value.setdefault("mcp", {})
        if not isinstance(mcp, dict):
            raise WorkspaceError("OpenCode config mcp section must be an object")
        current = mcp.get(item_id)
        if payload.scope == "project" and current is None:
            _, global_configs = _global_opencode_configs()
            if item_id not in _merged_global_mcp(global_configs):
                raise HTTPException(status_code=404, detail="MCP server not found")
            current = {}
        if not isinstance(current, dict):
            raise WorkspaceError("MCP server config must be an object")
        mcp[item_id] = {**current, "enabled": payload.enabled}
        if payload.scope == "global":
            write_json_config(root, relative, config_value)
        else:
            write_config(root, config_value)
        return {"name": item_id, "scope": payload.scope, "enabled": payload.enabled}

    @app.delete("/api/v1/projects/{project_id}/mcp/{name}", status_code=204)
    def remove_mcp(
        project_id: str,
        name: str,
        guard: WriteGuard,
        scope: Literal["project", "global"] = "project",
    ) -> Response:
        project = project_or_404(project_id)
        item_id = validate_item_id(name)
        if scope == "global":
            root, configs = _global_opencode_configs()
            for relative, config_value in configs.items():
                mcp = config_value.get("mcp")
                if isinstance(mcp, dict) and item_id in mcp:
                    mcp.pop(item_id)
                    write_json_config(root, relative, config_value)
            return Response(status_code=204)
        root = workspace_for(project)
        config_value = read_config(root)
        mcp = config_value.get("mcp")
        if isinstance(mcp, dict):
            mcp.pop(item_id, None)
            write_config(root, config_value)
        return Response(status_code=204)

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

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> Response:
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="not found")
        index = static_root / "index.html"
        if not index.exists():
            return JSONResponse(
                {
                    "product": "OpenCode Studio",
                    "detail": "Frontend bundle is missing. Run npm run build --prefix web.",
                }
            )
        return FileResponse(index, media_type="text/html")

    return app


def _project_view(project: dict[str, Any], server: dict[str, object]) -> dict[str, Any]:
    if server.get("state") == "stopped" and project.get("endpoint"):
        server = {
            "state": "external",
            "managed": False,
            "endpoint": project["endpoint"],
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


def _local_host(value: str | None) -> bool:
    if value in {"localhost", "testserver", "testclient"}:
        return True
    if not value:
        return False
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
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
