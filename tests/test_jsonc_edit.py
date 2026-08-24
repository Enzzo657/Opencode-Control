from __future__ import annotations

import json

import pytest

from opencode_control.jsonc_edit import JsoncEditError, Parser, patch_jsonc


def test_updates_nested_value_without_losing_comments_or_crlf() -> None:
    source = (
        "{\r\n"
        "  // Provider settings\r\n"
        '  "provider": {\r\n'
        '    "openai": {\r\n'
        '      "timeout": 30000, // keep timeout comment\r\n'
        '      "apiKey": "{env:OPENAI_API_KEY}",\r\n'
        "    },\r\n"
        "  },\r\n"
        "}\r\n"
    )
    proposed = {
        "provider": {
            "openai": {"timeout": 45000, "apiKey": "{env:OPENAI_API_KEY}"}
        }
    }

    result = patch_jsonc(source, proposed)

    assert '"timeout": 45000, // keep timeout comment' in result
    assert "// Provider settings" in result
    assert "\r\n" in result
    assert Parser(result).parse().value == proposed


def test_adds_and_removes_members_while_preserving_surrounding_text() -> None:
    source = (
        "{\n"
        "  // Keep this model comment\n"
        '  "model": "openai/gpt",\n'
        '  "mcp": {\n'
        "    // Existing server\n"
        '    "context7": { "enabled": true },\n'
        "  },\n"
        "}\n"
    )
    proposed = {
        "model": "openai/gpt",
        "mcp": {"pencil": {"enabled": True, "type": "local"}},
    }

    result = patch_jsonc(source, proposed)

    assert "// Keep this model comment" in result
    assert "// Existing server" in result
    assert '"context7"' not in result
    assert '"pencil"' in result
    assert Parser(result).parse().value == proposed


def test_rejects_duplicate_keys_instead_of_rewriting_document() -> None:
    source = '{\n  "mcp": {},\n  "mcp": {}\n}\n'

    with pytest.raises(JsoncEditError, match="duplicate JSONC key"):
        patch_jsonc(source, {"mcp": {"context7": {"enabled": True}}})


def test_removes_multiple_trailing_members_without_overlapping_edits() -> None:
    source = '{\n  "keep": true,\n  "removeA": 1,\n  "removeB": 2\n}\n'

    result = patch_jsonc(source, {"keep": True})

    assert Parser(result).parse().value == {"keep": True}
    assert '"removeA"' not in result
    assert '"removeB"' not in result
    assert json.loads(result) == {"keep": True}


def test_replaces_last_member_without_overlapping_remove_and_add_edits() -> None:
    source = (
        "{\n"
        '  "models": {\n'
        '    "qwen": { "name": "Qwen" },\n'
        '    "ornith": { "name": "Ornith" },\n'
        '    "old": { "name": "Old" }\n'
        "  }\n"
        "}\n"
    )
    proposed = {
        "models": {
            "qwen": {"name": "Qwen"},
            "ornith": {"name": "Ornith"},
            "new": {"name": "New"},
        }
    }

    result = patch_jsonc(source, proposed)

    assert Parser(result).parse().value == proposed
    assert '"old"' not in result
    assert '"new"' in result


def test_rejects_array_replacement_that_would_drop_comments() -> None:
    source = (
        '{\n  "command": [\n    "tool", // keep why this argument exists\n'
        '    "serve"\n  ]\n}\n'
    )

    with pytest.raises(JsoncEditError, match="remove an existing comment"):
        patch_jsonc(source, {"command": ["tool", "serve", "--verbose"]})
