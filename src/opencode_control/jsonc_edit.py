from __future__ import annotations

import json
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any


class JsoncEditError(ValueError):
    pass


@dataclass
class Member:
    key: str
    start: int
    value: Node
    comma_start: int | None = None
    comma_end: int | None = None


@dataclass
class Node:
    kind: str
    start: int
    end: int
    value: Any
    members: list[Member] = field(default_factory=list)
    items: list[Node] = field(default_factory=list)
    close_start: int | None = None


@dataclass(frozen=True)
class Edit:
    start: int
    end: int
    text: str


def patch_jsonc(source: str, proposed: Any) -> str:
    parser = Parser(source)
    root = parser.parse()
    edits: list[Edit] = []
    _diff(source, root, proposed, edits)
    _validate_edits(edits)
    result = source
    for edit in sorted(edits, key=lambda item: item.start, reverse=True):
        result = result[: edit.start] + edit.text + result[edit.end :]
    Parser(result).parse()
    return result


class Parser:
    def __init__(self, source: str) -> None:
        self.source = source
        self.index = 0

    def parse(self) -> Node:
        self._skip()
        node = self._value()
        self._skip()
        if self.index != len(self.source):
            raise JsoncEditError("unexpected content after JSONC document")
        return node

    def _value(self) -> Node:
        self._skip()
        if self.index >= len(self.source):
            raise JsoncEditError("expected JSONC value")
        char = self.source[self.index]
        if char == "{":
            return self._object()
        if char == "[":
            return self._array()
        if char == '"':
            start = self.index
            value = self._string()
            return Node("string", start, self.index, value)
        return self._primitive()

    def _object(self) -> Node:
        start = self.index
        self.index += 1
        members: list[Member] = []
        values: dict[str, Any] = {}
        self._skip()
        while self._peek() != "}":
            member_start = self.index
            if self._peek() != '"':
                raise JsoncEditError("object keys must be quoted")
            key = self._string()
            if key in values:
                raise JsoncEditError(f"duplicate JSONC key: {key}")
            self._skip()
            self._expect(":")
            value = self._value()
            member = Member(key, member_start, value)
            members.append(member)
            values[key] = value.value
            self._skip()
            if self._peek() == ",":
                member.comma_start = self.index
                self.index += 1
                member.comma_end = self.index
                self._skip()
                if self._peek() == "}":
                    break
                continue
            if self._peek() != "}":
                raise JsoncEditError("expected comma between object members")
        close = self.index
        self._expect("}")
        return Node("object", start, self.index, values, members=members, close_start=close)

    def _array(self) -> Node:
        start = self.index
        self.index += 1
        items: list[Node] = []
        self._skip()
        while self._peek() != "]":
            items.append(self._value())
            self._skip()
            if self._peek() == ",":
                self.index += 1
                self._skip()
                if self._peek() == "]":
                    break
                continue
            if self._peek() != "]":
                raise JsoncEditError("expected comma between array items")
        close = self.index
        self._expect("]")
        return Node(
            "array",
            start,
            self.index,
            [item.value for item in items],
            items=items,
            close_start=close,
        )

    def _primitive(self) -> Node:
        start = self.index
        while self.index < len(self.source):
            if self.source[self.index] in ",]}" or self.source[self.index].isspace():
                break
            if self.source.startswith("//", self.index) or self.source.startswith(
                "/*", self.index
            ):
                break
            self.index += 1
        raw = self.source[start : self.index]
        try:
            value = json.loads(raw)
        except json.JSONDecodeError as error:
            raise JsoncEditError("invalid JSONC primitive") from error
        return Node("primitive", start, self.index, value)

    def _string(self) -> str:
        start = self.index
        self.index += 1
        escaped = False
        while self.index < len(self.source):
            char = self.source[self.index]
            self.index += 1
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                try:
                    value = json.loads(self.source[start : self.index])
                    if not isinstance(value, str):
                        raise JsoncEditError("invalid JSONC string")
                    return value
                except json.JSONDecodeError as error:
                    raise JsoncEditError("invalid JSONC string") from error
        raise JsoncEditError("unterminated JSONC string")

    def _skip(self) -> None:
        while self.index < len(self.source):
            if self.source[self.index].isspace():
                self.index += 1
                continue
            if self.source.startswith("//", self.index):
                newline = self.source.find("\n", self.index + 2)
                self.index = len(self.source) if newline < 0 else newline + 1
                continue
            if self.source.startswith("/*", self.index):
                end = self.source.find("*/", self.index + 2)
                if end < 0:
                    raise JsoncEditError("unterminated JSONC comment")
                self.index = end + 2
                continue
            return

    def _peek(self) -> str:
        if self.index >= len(self.source):
            raise JsoncEditError("unexpected end of JSONC document")
        return self.source[self.index]

    def _expect(self, value: str) -> None:
        if self._peek() != value:
            raise JsoncEditError(f"expected {value}")
        self.index += 1


def _diff(source: str, node: Node, proposed: Any, edits: list[Edit]) -> None:
    if node.value == proposed:
        return
    if node.kind == "object" and isinstance(proposed, dict):
        _diff_object(source, node, proposed, edits)
        return
    if node.kind == "array" and isinstance(proposed, list) and len(node.items) == len(proposed):
        for item, value in zip(node.items, proposed, strict=True):
            _diff(source, item, value, edits)
        return
    _replace_node(source, node, proposed, edits)


def _diff_object(
    source: str, node: Node, proposed: dict[str, Any], edits: list[Edit]
) -> None:
    current = {member.key: member for member in node.members}
    removed = [member for member in node.members if member.key not in proposed]
    added = [(key, value) for key, value in proposed.items() if key not in current]
    if (removed or added) and "\n" not in source[node.start : node.end]:
        _replace_node(source, node, proposed, edits)
        return
    for key, member in current.items():
        if key in proposed:
            _diff(source, member.value, proposed[key], edits)
    paired = min(len(removed), len(added))
    for member, (key, value) in zip(removed[:paired], added[:paired], strict=True):
        _replace_member(source, member, key, value, edits)
    remaining_removed = removed[paired:]
    remaining_added = added[paired:]
    removed_keys = {member.key for member in remaining_removed}
    for member in remaining_removed:
        edits.extend(_remove_member_edits(source, node, member, removed_keys))
    if remaining_added:
        edits.extend(_add_member_edits(source, node, remaining_added))


def _replace_member(
    source: str, member: Member, key: str, value: Any, edits: list[Edit]
) -> None:
    if _contains_comment(source[member.start : member.value.end]):
        raise JsoncEditError("changing this value would remove an existing comment")
    rendered = _format_value(source, member.value.start, value)
    edits.append(
        Edit(
            member.start,
            member.value.end,
            f"{json.dumps(key, ensure_ascii=False)}: {rendered}",
        )
    )


def _remove_member_edits(
    source: str, node: Node, member: Member, removed_keys: set[str]
) -> list[Edit]:
    start = member.start
    line_start = source.rfind("\n", node.start, start) + 1
    if source[line_start:start].strip() == "":
        start = line_start
    end = member.comma_end or member.value.end
    newline = source.find("\n", end, node.end)
    if newline >= 0 and source[end:newline].strip() == "":
        end = newline + 1
    edits = [Edit(start, end, "")]
    if member.comma_end is None:
        previous = next(
            (
                candidate
                for candidate in reversed(node.members)
                if candidate.start < member.start
                and candidate.key not in removed_keys
                and candidate.comma_start is not None
            ),
            None,
        )
        if previous is not None:
            assert previous.comma_start is not None and previous.comma_end is not None
            edits.append(Edit(previous.comma_start, previous.comma_end, ""))
    return edits


def _add_member_edits(
    source: str, node: Node, added: list[tuple[str, Any]]
) -> list[Edit]:
    assert node.close_start is not None
    newline = "\r\n" if "\r\n" in source else "\n"
    close_line_start = source.rfind("\n", node.start, node.close_start) + 1
    close_indent = source[close_line_start : node.close_start]
    if close_indent.strip():
        close_indent = ""
    if node.members:
        first_line_start = source.rfind("\n", node.start, node.members[0].start) + 1
        member_indent = source[first_line_start : node.members[0].start]
        if member_indent.strip():
            member_indent = close_indent + "  "
    else:
        member_indent = close_indent + "  "
    trailing = bool(node.members and node.members[-1].comma_end is not None)
    lines = []
    for index, (key, value) in enumerate(added):
        comma = "," if index < len(added) - 1 or trailing else ""
        rendered = json.dumps(value, ensure_ascii=False, indent=2).replace(
            "\n", newline + member_indent
        )
        lines.append(f"{member_indent}{json.dumps(key, ensure_ascii=False)}: {rendered}{comma}")
    insertion = newline.join(lines) + newline
    edits: list[Edit] = [Edit(close_line_start, close_line_start, insertion)]
    if node.members and not trailing:
        edits.append(Edit(node.members[-1].value.end, node.members[-1].value.end, ","))
    return edits


def _format_value(source: str, position: int, value: Any) -> str:
    rendered = json.dumps(value, ensure_ascii=False, indent=2)
    line_start = source.rfind("\n", 0, position) + 1
    line_prefix = source[line_start:position]
    indent = line_prefix[: len(line_prefix) - len(line_prefix.lstrip())]
    newline = "\r\n" if "\r\n" in source else "\n"
    return rendered.replace("\n", newline + indent)


def _replace_node(source: str, node: Node, value: Any, edits: list[Edit]) -> None:
    if _contains_comment(source[node.start : node.end]):
        raise JsoncEditError("changing this value would remove an existing comment")
    edits.append(Edit(node.start, node.end, _format_value(source, node.start, value)))


def _contains_comment(source: str) -> bool:
    index = 0
    in_string = False
    escaped = False
    while index < len(source):
        char = source[index]
        if in_string:
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
            index += 1
            continue
        if source.startswith("//", index) or source.startswith("/*", index):
            return True
        index += 1
    return False


def _validate_edits(edits: list[Edit]) -> None:
    ordered = sorted(edits, key=lambda item: (item.start, item.end))
    for previous, current in pairwise(ordered):
        if current.start < previous.end:
            raise JsoncEditError("overlapping JSONC edits")
