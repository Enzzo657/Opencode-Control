from __future__ import annotations

import json

import pytest

import opencode_control.skill_import as skill_import
from opencode_control.skill_import import (
    DownloadedSkill,
    FetchedResource,
    SkillImportError,
    canonical_skill_url,
    fetch_skill,
    rename_skill,
    validate_skill_document,
)

SKILL = """---
name: release-notes
description: Prepare release notes from changes
license: MIT
---

# Release notes

Summarize user-visible changes.
"""


class FakeResponse:
    def __init__(
        self,
        status: int,
        body: bytes = b"",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status = status
        self.body = body
        self.headers = headers or {}

    def getheader(self, name: str) -> str | None:
        return self.headers.get(name)

    def read(self, amount: int | None = None) -> bytes:
        return self.body if amount is None else self.body[:amount]


def test_validates_and_renames_skill_without_losing_frontmatter() -> None:
    document = validate_skill_document(SKILL)

    renamed = rename_skill(document, "release-summary")

    assert renamed.name == "release-summary"
    assert "name: release-summary" in renamed.content
    assert "license: MIT" in renamed.content
    assert renamed.description == document.description


@pytest.mark.parametrize(
    "content, detail",
    [
        ("# Missing frontmatter\n", "frontmatter"),
        ("---\nname: Bad_Name\ndescription: Test\n---\nBody\n", "lowercase"),
        ("---\nname: valid-name\n---\nBody\n", "description"),
        ("---\nname: valid-name\ndescription: Test\n---\n", "must not be empty"),
    ],
)
def test_rejects_invalid_import_documents(content: str, detail: str) -> None:
    with pytest.raises(SkillImportError, match=detail):
        validate_skill_document(content)


def test_canonicalizes_standard_github_blob_url() -> None:
    assert canonical_skill_url(
        "https://github.com/example/skills/blob/main/release/SKILL.md"
    ) == "https://raw.githubusercontent.com/example/skills/main/release/SKILL.md"


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/SKILL.md",
        "https://user:password@example.com/SKILL.md",
        "https://example.com/SKILL.md#section",
    ],
)
def test_rejects_unsafe_url_shapes(url: str) -> None:
    with pytest.raises(SkillImportError):
        canonical_skill_url(url)


def test_rejects_private_or_mixed_dns_answers() -> None:
    for addresses in (["127.0.0.1"], ["93.184.216.34", "10.0.0.4"]):
        with pytest.raises(SkillImportError, match="non-public"):
            fetch_skill(
                "https://example.com/SKILL.md",
                resolver=lambda hostname, port, values=addresses: values,
            )


def test_revalidates_redirect_destination(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connections: list[tuple[str, str]] = []

    class Connection:
        def __init__(self, hostname: str, port: int, address: str, timeout: float) -> None:
            connections.append((hostname, address))

        def request(self, method: str, target: str, headers: dict[str, str]) -> None:
            return None

        def getresponse(self) -> FakeResponse:
            return FakeResponse(302, headers={"Location": "https://127.0.0.1/SKILL.md"})

        def close(self) -> None:
            return None

    monkeypatch.setattr(skill_import, "_PinnedHTTPSConnection", Connection)

    with pytest.raises(SkillImportError, match="non-public"):
        fetch_skill(
            "https://example.com/SKILL.md",
            resolver=lambda hostname, port: (
                ["127.0.0.1"] if hostname == "127.0.0.1" else ["93.184.216.34"]
            ),
        )

    assert connections == [("example.com", "93.184.216.34")]


def test_downloads_bounded_utf8_markdown(monkeypatch: pytest.MonkeyPatch) -> None:
    class Connection:
        def __init__(self, hostname: str, port: int, address: str, timeout: float) -> None:
            return None

        def request(self, method: str, target: str, headers: dict[str, str]) -> None:
            assert headers["Accept-Encoding"] == "identity"

        def getresponse(self) -> FakeResponse:
            return FakeResponse(
                200,
                SKILL.encode(),
                {"Content-Type": "text/markdown; charset=utf-8"},
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(skill_import, "_PinnedHTTPSConnection", Connection)

    result = fetch_skill(
        "https://example.com/SKILL.md?token=secret",
        resolver=lambda hostname, port: ["93.184.216.34"],
    )

    assert isinstance(result, DownloadedSkill)
    assert result.document.name == "release-notes"
    assert "secret" not in result.source_url
    assert "%5BREDACTED%5D" in result.source_url


@pytest.mark.parametrize(
    "source_url",
    [
        "https://github.com/example/skills/tree/main/.claude/skills/design-system",
        "https://github.com/example/skills/blob/main/.claude/skills/design-system/SKILL.md",
    ],
)
def test_downloads_complete_github_skill_directory_at_pinned_commit(
    monkeypatch: pytest.MonkeyPatch, source_url: str
) -> None:
    commit = "a" * 40
    tree = {
        "truncated": False,
        "tree": [
            {
                "path": ".claude/skills/design-system/SKILL.md",
                "type": "blob",
                "mode": "100644",
            },
            {
                "path": ".claude/skills/design-system/scripts/run.py",
                "type": "blob",
                "mode": "100755",
            },
            {"path": ".claude/skills/other/SKILL.md", "type": "blob", "mode": "100644"},
        ],
    }

    def resource(url: str, **kwargs: object) -> FetchedResource:
        if "/commits/main" in url:
            content = (f'{{"sha":"{commit}"}}').encode()
        elif "/git/trees/" in url:
            content = json.dumps(tree).encode()
        elif url.endswith("/SKILL.md"):
            content = SKILL.encode()
        elif url.endswith("/scripts/run.py"):
            content = b"print('safe preview')\n"
        else:
            raise AssertionError(url)
        return FetchedResource(content, url, 0, "application/octet-stream")

    monkeypatch.setattr(skill_import, "_fetch_resource", resource)

    downloaded = fetch_skill(source_url)

    assert downloaded.commit == commit
    assert [file.path for file in downloaded.files] == ["SKILL.md", "scripts/run.py"]
    assert downloaded.files[1].mode == 0o755
    assert downloaded.document.name == "release-notes"


def test_rejects_symlink_in_github_skill_directory(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commit = "b" * 40

    def resource(url: str, **kwargs: object) -> FetchedResource:
        if "/commits/main" in url:
            content = (f'{{"sha":"{commit}"}}').encode()
        else:
            content = (
                b'{"truncated":false,"tree":['
                b'{"path":"skill/SKILL.md","type":"blob","mode":"100644"},'
                b'{"path":"skill/link","type":"blob","mode":"120000"}]}'
            )
        return FetchedResource(content, url, 0, "application/json")

    monkeypatch.setattr(skill_import, "_fetch_resource", resource)

    with pytest.raises(SkillImportError, match="symlink"):
        fetch_skill("https://github.com/example/skills/tree/main/skill")
