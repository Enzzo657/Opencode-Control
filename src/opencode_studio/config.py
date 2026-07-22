from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class StudioConfig:
    data_dir: Path
    opencode_binary: str = "opencode"

    @classmethod
    def from_environment(cls) -> StudioConfig:
        raw = os.environ.get("OPENCODE_STUDIO_HOME")
        data_dir = Path(raw).expanduser() if raw else Path.home() / ".opencode-studio"
        return cls(
            data_dir=data_dir.resolve(),
            opencode_binary=os.environ.get("OPENCODE_BINARY", "opencode"),
        )
