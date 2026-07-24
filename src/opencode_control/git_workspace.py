from __future__ import annotations

import hashlib
import os
import subprocess
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class GitError(RuntimeError):
    pass


def git_state(root: Path) -> dict[str, Any]:
    repository = _repository(root)
    if repository is None:
        return {"available": False, "branch": None, "revision": "", "changes": [], "commits": []}
    branch = _run(root, ["branch", "--show-current"]).strip()
    if not branch:
        branch = _run(root, ["rev-parse", "--short", "HEAD"]).strip()
    changes = _changes(root)
    commits: list[dict[str, Any]] = []
    raw_log = _run(
        root,
        ["log", "-20", "--pretty=format:%H%x00%h%x00%an%x00%at%x00%s"],
        allowed={0, 128},
    )
    for line in raw_log.splitlines():
        parts = line.split("\0", 4)
        if len(parts) != 5:
            continue
        full_hash, short_hash, author, timestamp, subject = parts
        commits.append(
            {
                "hash": full_hash,
                "short_hash": short_hash,
                "author": author[:200],
                "timestamp": int(timestamp) if timestamp.isdigit() else 0,
                "subject": subject[:1000],
            }
        )
    return {
        "available": True,
        "branch": branch[:500],
        "repository": str(repository),
        "revision": _revision(root, changes),
        "changes": changes,
        "commits": commits,
    }


def git_diff(root: Path, path: str) -> dict[str, str]:
    repository = _repository(root)
    if repository is None:
        raise GitError("project is not inside a Git repository")
    changes = {item["path"]: item for item in _changes(root)}
    change = changes.get(path)
    if change is None:
        raise GitError("file is not changed")
    if change["status"] == "??":
        candidate = _safe_path(root, path)
        diff = _run(
            root,
            ["diff", "--no-index", "--no-ext-diff", "--unified=3", "/dev/null", str(candidate)],
            allowed={0, 1},
            limit=2 * 1024 * 1024,
        )
    else:
        diff = _run(
            root,
            ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", path],
            limit=2 * 1024 * 1024,
        )
    return {"path": path, "diff": diff}


def git_stage(root: Path, paths: list[str]) -> dict[str, Any]:
    selected = _selected_changes(root, paths)
    _run(root, ["add", "-A", "--", *selected], timeout=30)
    return git_state(root)


def git_unstage(root: Path, paths: list[str]) -> dict[str, Any]:
    selected = _selected_changes(root, paths, staged=True)
    has_head = bool(_run(root, ["rev-parse", "--verify", "HEAD"], allowed={0, 128}).strip())
    if has_head:
        _run(root, ["reset", "--quiet", "HEAD", "--", *selected], timeout=30)
    else:
        _run(
            root,
            ["rm", "--cached", "-r", "--ignore-unmatch", "--", *selected],
            timeout=30,
        )
    return git_state(root)


def git_commit(root: Path, message: str, paths: list[str]) -> dict[str, Any]:
    repository = _repository(root)
    if repository is None:
        raise GitError("project is not inside a Git repository")
    selected = _selected_changes(root, paths, staged=True)
    staged = {item["path"] for item in _changes(root) if item["staged"]}
    if set(selected) != staged:
        raise GitError("commit paths must include all staged project changes")
    outside = []
    raw_staged = _run(root, ["diff", "--cached", "--name-only", "-z"])
    project = root.resolve(strict=True)
    for path in filter(None, raw_staged.split("\0")):
        candidate = (repository / path).resolve(strict=False)
        if candidate != project and not candidate.is_relative_to(project):
            outside.append(path)
    if outside:
        raise GitError("unstage repository changes outside this project before committing")
    _run(root, ["commit", "-m", message], timeout=60)
    commit_hash = _run(root, ["rev-parse", "HEAD"]).strip()
    return {"committed": True, "hash": commit_hash, "state": git_state(root)}


def git_revert(root: Path, commit_hash: str) -> dict[str, Any]:
    repository = _repository(root)
    if repository is None:
        raise GitError("project is not inside a Git repository")
    resolved = _run(
        root,
        ["rev-parse", "--verify", f"{commit_hash}^{{commit}}"],
        allowed={0, 128},
    ).strip()
    if not resolved:
        raise GitError("commit was not found")
    project = root.resolve(strict=True)
    raw_paths = _run(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", resolved])
    for path in filter(None, raw_paths.split("\0")):
        candidate = (repository / path).resolve(strict=False)
        if candidate != project and not candidate.is_relative_to(project):
            raise GitError("cannot revert a commit that changes files outside this project")
    try:
        _run(root, ["revert", "--no-edit", resolved], timeout=60)
    except GitError:
        with suppress(GitError):
            _run(root, ["revert", "--abort"], allowed={0, 128}, timeout=30)
        raise
    reverted_hash = _run(root, ["rev-parse", "HEAD"]).strip()
    return {"reverted": True, "hash": reverted_hash, "state": git_state(root)}


def git_reset(root: Path, commit_hash: str) -> dict[str, Any]:
    repository = _repository(root)
    if repository is None:
        raise GitError("project is not inside a Git repository")
    if repository != root.resolve(strict=True):
        raise GitError("reset is available only when the project root is the repository root")
    if _changes(root):
        raise GitError("commit or discard current changes before resetting the branch")
    branch = _run(root, ["branch", "--show-current"]).strip()
    if not branch:
        raise GitError("reset is not available in detached HEAD state")
    resolved = _run(
        root,
        ["rev-parse", "--verify", f"{commit_hash}^{{commit}}"],
        allowed={0, 128},
    ).strip()
    if not resolved:
        raise GitError("commit was not found")
    previous_hash = _run(root, ["rev-parse", "HEAD"]).strip()
    if resolved == previous_hash:
        raise GitError("branch is already at this commit")
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S-%f")
    backup_branch = f"control-backup/{timestamp}-{previous_hash[:7]}"
    _run(root, ["branch", backup_branch, previous_hash])
    _run(root, ["reset", "--hard", resolved], timeout=60)
    return {
        "reset": True,
        "hash": resolved,
        "previous_hash": previous_hash,
        "backup_branch": backup_branch,
        "state": git_state(root),
    }


def _repository(root: Path) -> Path | None:
    try:
        raw = _run(root, ["rev-parse", "--show-toplevel"], allowed={0, 128}).strip()
    except GitError:
        return None
    if not raw:
        return None
    try:
        repository = Path(raw).resolve(strict=True)
        project = root.resolve(strict=True)
    except OSError:
        return None
    if project != repository and not project.is_relative_to(repository):
        return None
    return repository


def _changes(root: Path) -> list[dict[str, Any]]:
    raw = _run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
    entries = raw.split("\0")
    result: list[dict[str, Any]] = []
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        status = entry[:2]
        path = entry[3:]
        previous: str | None = None
        if ("R" in status or "C" in status) and index < len(entries):
            previous = entries[index]
            index += 1
        try:
            _safe_path(root, path)
        except GitError:
            continue
        item = {
            "path": path,
            "status": status,
            "staged": status[0] not in {" ", "?"},
            "unstaged": status[1] != " " or status == "??",
        }
        if previous:
            item["previous_path"] = previous
        result.append(item)
        if len(result) >= 1000:
            break
    return result


def _selected_changes(root: Path, paths: list[str], *, staged: bool = False) -> list[str]:
    changes = {item["path"]: item for item in _changes(root)}
    selected = list(dict.fromkeys(paths))
    if not selected or any(path not in changes for path in selected):
        raise GitError("paths must be selected from current project changes")
    if staged and any(not changes[path]["staged"] for path in selected):
        raise GitError("paths must be staged")
    for path in selected:
        _safe_path(root, path)
    return selected


def _safe_path(root: Path, value: str) -> Path:
    if not value or "\0" in value:
        raise GitError("invalid Git path")
    candidate = (root / value).resolve(strict=False)
    project = root.resolve(strict=True)
    if candidate != project and not candidate.is_relative_to(project):
        raise GitError("Git path is outside the project")
    return candidate


def _revision(root: Path, changes: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for change in changes:
        path = change["path"]
        digest.update(change["status"].encode())
        digest.update(path.encode(errors="surrogateescape"))
        try:
            stat = _safe_path(root, path).stat()
            digest.update(f"{stat.st_mtime_ns}:{stat.st_size}".encode())
        except (GitError, OSError):
            digest.update(b"missing")
    return digest.hexdigest()


def _run(
    root: Path,
    arguments: list[str],
    *,
    allowed: set[int] | None = None,
    timeout: int = 10,
    limit: int = 4 * 1024 * 1024,
) -> str:
    environment = {
        **os.environ,
        "GIT_PAGER": "cat",
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
    }
    try:
        completed = subprocess.run(
            ["git", "-C", str(root), *arguments],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=timeout,
            check=False,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GitError("Git command could not be completed") from error
    if completed.returncode not in (allowed or {0}):
        detail = completed.stderr.decode("utf-8", errors="replace").strip()
        raise GitError(detail[:2000] or "Git command failed")
    if len(completed.stdout) > limit:
        return completed.stdout[:limit].decode("utf-8", errors="replace") + "\n… output truncated"
    return completed.stdout.decode("utf-8", errors="replace")
