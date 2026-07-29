from __future__ import annotations

import hashlib
import http.client
import ipaddress
import json
import re
import socket
import ssl
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass

from opencode_control import __version__

MAX_SKILL_BYTES = 1024 * 1024
MAX_BUNDLE_BYTES = 10 * 1024 * 1024
MAX_BUNDLE_FILES = 200
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_REDIRECTS = 3
_SKILL_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_FRONTMATTER = re.compile(r"\A---\r?\n(?P<header>.*?)\r?\n---(?:\r?\n|$)", re.DOTALL)
_SCALAR = re.compile(r"^(?P<key>[A-Za-z][A-Za-z0-9_-]*):\s*(?P<value>.*?)\s*$")
_ALLOWED_CONTENT_TYPES = {"", "application/octet-stream", "text/markdown", "text/plain"}


class SkillImportError(ValueError):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class SkillDocument:
    content: str
    name: str
    description: str
    body: str
    size: int
    sha256: str


@dataclass(frozen=True)
class DownloadedSkill:
    document: SkillDocument
    source_url: str
    final_url: str
    redirects: int
    files: tuple[SkillFile, ...] = ()
    commit: str | None = None

    def __post_init__(self) -> None:
        if not self.files:
            content = self.document.content.encode("utf-8")
            object.__setattr__(
                self,
                "files",
                (SkillFile("SKILL.md", content, 0o600, self.document.sha256),),
            )


@dataclass(frozen=True)
class SkillFile:
    path: str
    content: bytes
    mode: int
    sha256: str


@dataclass(frozen=True)
class FetchedResource:
    content: bytes
    final_url: str
    redirects: int
    content_type: str


Resolver = Callable[[str, int], list[str]]


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname: str, port: int, address: str, timeout: float) -> None:
        context = ssl.create_default_context()
        super().__init__(hostname, port, timeout=timeout, context=context)
        self._address = address
        self._ssl_context = context

    def connect(self) -> None:
        sock = socket.create_connection((self._address, self.port), self.timeout)
        try:
            self.sock = self._ssl_context.wrap_socket(sock, server_hostname=self.host)
        except Exception:
            sock.close()
            raise


def fetch_skill(
    source_url: str,
    *,
    resolver: Resolver | None = None,
    timeout: float = 10.0,
) -> DownloadedSkill:
    tree = _github_directory_parts(source_url)
    if tree is not None:
        return _fetch_github_skill_directory(
            source_url, tree, resolver=resolver, timeout=timeout
        )
    requested = canonical_skill_url(source_url)
    source_display = display_url(source_url.strip())
    resource = _fetch_resource(
        requested,
        max_bytes=MAX_SKILL_BYTES,
        resolver=resolver,
        timeout=timeout,
    )
    if resource.content_type not in _ALLOWED_CONTENT_TYPES:
        raise SkillImportError(422, "Skill source must return Markdown or plain text")
    try:
        content = resource.content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise SkillImportError(422, "Skill document must be valid UTF-8") from error
    document = validate_skill_document(content)
    file = SkillFile("SKILL.md", resource.content, 0o600, document.sha256)
    return DownloadedSkill(
        document=document,
        source_url=source_display,
        final_url=resource.final_url,
        redirects=resource.redirects,
        files=(file,),
    )


def _fetch_resource(
    source_url: str,
    *,
    max_bytes: int,
    resolver: Resolver | None = None,
    timeout: float = 10.0,
    accept: str = "text/markdown, text/plain;q=0.9, application/octet-stream;q=0.5",
) -> FetchedResource:
    current = source_url
    resolve = resolver or _resolve_addresses
    redirects = 0
    while True:
        parsed, addresses = _validated_destination(current, resolve)
        port = parsed.port or 443
        target = urllib.parse.urlunsplit(("", "", parsed.path or "/", parsed.query, ""))
        connection = _PinnedHTTPSConnection(parsed.hostname or "", port, addresses[0], timeout)
        try:
            connection.request(
                "GET",
                target,
                headers={
                    "Accept": accept,
                    "Accept-Encoding": "identity",
                    "User-Agent": f"OpenCode-Control/{__version__}",
                },
            )
            response = connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location = response.getheader("Location")
                response.read(1024)
                if not location:
                    raise SkillImportError(502, "HTTPS redirect did not include a destination")
                redirects += 1
                if redirects > MAX_REDIRECTS:
                    raise SkillImportError(422, "HTTPS URL redirected too many times")
                current = urllib.parse.urljoin(current, location)
                continue
            if response.status < 200 or response.status >= 300:
                raise SkillImportError(502, f"Skill source returned HTTP {response.status}")
            encoding = (response.getheader("Content-Encoding") or "identity").lower()
            if encoding != "identity":
                raise SkillImportError(422, "Compressed Skill responses are not accepted")
            content_type = (response.getheader("Content-Type") or "").split(";", 1)[0].lower()
            declared = response.getheader("Content-Length")
            if declared:
                try:
                    if int(declared) > max_bytes:
                        raise SkillImportError(413, "Skill source exceeded the size limit")
                except ValueError as error:
                    raise SkillImportError(
                        502, "Skill source returned an invalid content length"
                    ) from error
            raw = response.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise SkillImportError(413, "Skill source exceeded the size limit")
        except SkillImportError:
            raise
        except (OSError, http.client.HTTPException) as error:
            raise SkillImportError(502, "Could not download Skill from the HTTPS source") from error
        finally:
            connection.close()
        return FetchedResource(
            content=raw,
            final_url=display_url(current),
            redirects=redirects,
            content_type=content_type,
        )


def _fetch_github_skill_directory(
    source_url: str,
    parts: tuple[str, str, str, str],
    *,
    resolver: Resolver | None,
    timeout: float,
) -> DownloadedSkill:
    owner, repository, reference, directory = parts
    api_base = f"https://api.github.com/repos/{owner}/{repository}"
    commit_resource = _fetch_resource(
        f"{api_base}/commits/{urllib.parse.quote(reference, safe='')}",
        max_bytes=MAX_MANIFEST_BYTES,
        resolver=resolver,
        timeout=timeout,
        accept="application/vnd.github+json",
    )
    commit_data = _json_object(commit_resource.content, "GitHub commit response")
    commit = commit_data.get("sha")
    if not isinstance(commit, str) or re.fullmatch(r"[0-9a-f]{40}", commit) is None:
        raise SkillImportError(502, "GitHub did not return a valid commit SHA")
    tree_resource = _fetch_resource(
        f"{api_base}/git/trees/{commit}?recursive=1",
        max_bytes=MAX_MANIFEST_BYTES,
        resolver=resolver,
        timeout=timeout,
        accept="application/vnd.github+json",
    )
    tree_data = _json_object(tree_resource.content, "GitHub tree response")
    raw_tree = tree_data.get("tree")
    if tree_data.get("truncated") is True or not isinstance(raw_tree, list):
        raise SkillImportError(422, "GitHub repository tree is too large to import safely")
    prefix = directory.rstrip("/") + "/"
    manifest: list[tuple[str, int]] = []
    for raw_entry in raw_tree:
        if not isinstance(raw_entry, dict) or not isinstance(raw_entry.get("path"), str):
            continue
        repository_path = raw_entry["path"]
        if not repository_path.startswith(prefix):
            continue
        relative = repository_path[len(prefix) :]
        if not relative or raw_entry.get("type") == "tree":
            continue
        if raw_entry.get("type") != "blob" or raw_entry.get("mode") == "120000":
            raise SkillImportError(422, "Skill directory contains a symlink or submodule")
        _validate_bundle_path(relative)
        mode = 0o755 if str(raw_entry.get("mode", "")).endswith("755") else 0o644
        manifest.append((relative, mode))
    manifest.sort()
    if not manifest or len(manifest) > MAX_BUNDLE_FILES:
        raise SkillImportError(422, "Skill bundle must contain 1-200 regular files")
    if "SKILL.md" not in {path for path, _ in manifest}:
        raise SkillImportError(422, "GitHub directory must contain SKILL.md at its root")
    files: list[SkillFile] = []
    total = 0
    redirects = commit_resource.redirects + tree_resource.redirects
    for path, mode in manifest:
        quoted_path = "/".join(
            urllib.parse.quote(part, safe="")
            for part in (directory + "/" + path).split("/")
        )
        resource = _fetch_resource(
            f"https://raw.githubusercontent.com/{owner}/{repository}/{commit}/{quoted_path}",
            max_bytes=MAX_SKILL_BYTES,
            resolver=resolver,
            timeout=timeout,
        )
        total += len(resource.content)
        if total > MAX_BUNDLE_BYTES:
            raise SkillImportError(413, "Skill bundle is larger than 10 MiB")
        files.append(
            SkillFile(
                path=path,
                content=resource.content,
                mode=mode,
                sha256=hashlib.sha256(resource.content).hexdigest(),
            )
        )
        redirects += resource.redirects
    skill_file = next(file for file in files if file.path == "SKILL.md")
    try:
        skill_content = skill_file.content.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise SkillImportError(422, "SKILL.md must be valid UTF-8") from error
    document = validate_skill_document(skill_content)
    return DownloadedSkill(
        document=document,
        source_url=display_url(source_url.strip()),
        final_url=f"https://github.com/{owner}/{repository}/tree/{commit}/{directory}",
        redirects=redirects,
        files=tuple(files),
        commit=commit,
    )


def canonical_skill_url(value: str) -> str:
    raw = value.strip()
    if not raw or len(raw) > 4096:
        raise SkillImportError(422, "A valid HTTPS URL is required")
    if any(character.isspace() or ord(character) < 32 for character in raw):
        raise SkillImportError(422, "HTTPS URL contains unsafe characters")
    try:
        parsed = urllib.parse.urlsplit(raw)
        port = parsed.port
    except ValueError as error:
        raise SkillImportError(422, "HTTPS URL is invalid") from error
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise SkillImportError(422, "Only HTTPS URLs are accepted")
    if parsed.username is not None or parsed.password is not None:
        raise SkillImportError(422, "Credentials are not allowed in Skill URLs")
    if parsed.fragment:
        raise SkillImportError(422, "URL fragments are not allowed")
    if port is not None and not 1 <= port <= 65535:
        raise SkillImportError(422, "HTTPS URL port is invalid")
    if parsed.hostname.lower() == "github.com":
        parts = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
        if len(parts) >= 5 and parts[2] == "blob":
            owner, repository, _, reference = parts[:4]
            path = "/".join(urllib.parse.quote(part, safe="") for part in parts[4:])
            if not path.lower().endswith(".md"):
                raise SkillImportError(422, "GitHub URL must point to a SKILL.md file")
            raw_path = "/".join(
                urllib.parse.quote(part, safe="")
                for part in (owner, repository, reference)
            )
            return f"https://raw.githubusercontent.com/{raw_path}/{path}"
    return urllib.parse.urlunsplit(parsed)


def validate_skill_document(content: str) -> SkillDocument:
    if content.startswith("\ufeff"):
        raise SkillImportError(422, "Skill document must not contain a UTF-8 BOM")
    raw = content.encode("utf-8")
    if len(raw) > MAX_SKILL_BYTES:
        raise SkillImportError(413, "Skill document is larger than 1 MiB")
    match = _FRONTMATTER.match(content)
    if match is None:
        raise SkillImportError(422, "SKILL.md must start with YAML frontmatter")
    values: dict[str, str] = {}
    for line in match.group("header").splitlines():
        candidate = _SCALAR.match(line)
        if candidate is None:
            continue
        key = candidate.group("key")
        if key not in {"name", "description"}:
            continue
        if key in values:
            raise SkillImportError(422, f"Skill frontmatter contains duplicate {key}")
        values[key] = candidate.group("value").strip().strip("\"'")
    name = values.get("name", "")
    description = values.get("description", "")
    if not name or len(name) > 64 or _SKILL_NAME.fullmatch(name) is None:
        raise SkillImportError(
            422,
            "Skill name must be 1-64 lowercase letters or digits separated by hyphens",
        )
    if not description:
        raise SkillImportError(422, "Skill frontmatter requires a description")
    body = content[match.end() :]
    if not body.strip():
        raise SkillImportError(422, "Skill Markdown body must not be empty")
    return SkillDocument(
        content=content,
        name=name,
        description=description,
        body=body,
        size=len(raw),
        sha256=hashlib.sha256(raw).hexdigest(),
    )


def rename_skill(document: SkillDocument, name: str) -> SkillDocument:
    if not name or len(name) > 64 or _SKILL_NAME.fullmatch(name) is None:
        raise SkillImportError(
            422,
            "Skill name must be 1-64 lowercase letters or digits separated by hyphens",
        )
    match = _FRONTMATTER.match(document.content)
    if match is None:
        raise SkillImportError(422, "SKILL.md must start with YAML frontmatter")
    header = re.sub(
        r"(?m)^name:\s*.*$",
        f"name: {name}",
        match.group("header"),
        count=1,
    )
    updated = (
        document.content[: match.start("header")]
        + header
        + document.content[match.end("header") :]
    )
    return validate_skill_document(updated)


def rename_downloaded_skill(downloaded: DownloadedSkill, name: str) -> DownloadedSkill:
    document = rename_skill(downloaded.document, name)
    content = document.content.encode("utf-8")
    files = tuple(
        SkillFile(file.path, content, file.mode, document.sha256)
        if file.path == "SKILL.md"
        else file
        for file in downloaded.files
    )
    return DownloadedSkill(
        document=document,
        source_url=downloaded.source_url,
        final_url=downloaded.final_url,
        redirects=downloaded.redirects,
        files=files,
        commit=downloaded.commit,
    )


def display_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if not parsed.query:
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    keys = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    redacted = urllib.parse.urlencode([(key, "[REDACTED]") for key, _ in keys])
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, redacted, ""))


def _github_directory_parts(value: str) -> tuple[str, str, str, str] | None:
    raw = value.strip()
    try:
        parsed = urllib.parse.urlsplit(raw)
    except ValueError:
        return None
    if parsed.scheme.lower() != "https" or (parsed.hostname or "").lower() != "github.com":
        return None
    if (
        parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise SkillImportError(
            422,
            "GitHub directory URL must not contain credentials, query, or fragment",
        )
    parts = [urllib.parse.unquote(part) for part in parsed.path.split("/") if part]
    if len(parts) < 5 or parts[2] not in {"tree", "blob"}:
        return None
    owner, repository, _, reference = parts[:4]
    if parts[2] == "blob":
        if len(parts) < 6 or parts[-1].lower() != "skill.md":
            return None
        directory = "/".join(parts[4:-1])
    else:
        directory = "/".join(parts[4:])
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", owner) or not re.fullmatch(
        r"[A-Za-z0-9_.-]+", repository
    ):
        raise SkillImportError(422, "GitHub repository name is invalid")
    if not reference or not directory:
        raise SkillImportError(422, "GitHub directory URL is incomplete")
    _validate_bundle_path(directory)
    return owner, repository, reference, directory


def _validate_bundle_path(value: str) -> None:
    if not value or len(value) > 1024 or "\\" in value or "\0" in value:
        raise SkillImportError(422, "Skill bundle contains an unsafe path")
    parts = value.split("/")
    if any(part in {"", ".", ".."} or len(part.encode("utf-8")) > 255 for part in parts):
        raise SkillImportError(422, "Skill bundle contains an unsafe path")


def _json_object(content: bytes, label: str) -> dict[str, object]:
    try:
        value = json.loads(content.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SkillImportError(502, f"{label} was invalid") from error
    if not isinstance(value, dict):
        raise SkillImportError(502, f"{label} was invalid")
    return value


def _validated_destination(
    value: str, resolver: Resolver
) -> tuple[urllib.parse.SplitResult, list[str]]:
    canonical = canonical_skill_url(value)
    parsed = urllib.parse.urlsplit(canonical)
    hostname = parsed.hostname or ""
    port = parsed.port or 443
    try:
        addresses = resolver(hostname, port)
    except OSError as error:
        raise SkillImportError(502, "Could not resolve Skill source hostname") from error
    if not addresses:
        raise SkillImportError(502, "Skill source hostname did not resolve")
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as error:
            raise SkillImportError(502, "Skill source resolved to an invalid address") from error
        if ip.version == 6 and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        if not ip.is_global:
            raise SkillImportError(422, "Skill source resolves to a non-public network")
    return parsed, addresses


def _resolve_addresses(hostname: str, port: int) -> list[str]:
    result: list[str] = []
    for _, _, _, _, sockaddr in socket.getaddrinfo(
        hostname, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM
    ):
        address = str(sockaddr[0])
        if address not in result:
            result.append(address)
    return result
