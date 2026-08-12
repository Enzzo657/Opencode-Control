from pathlib import Path

from opencode_control.soak import run_soak


def test_isolated_soak_exercises_recovery_without_active_runs(tmp_path: Path) -> None:
    result = run_soak(cycles=40, data_dir=tmp_path / "soak")

    assert result["ok"] is True
    assert result["cycles"] == 40
    assert result["integrity"] == "ok"
    assert result["active_runs"] == 0
    assert result["events"] == 40
    assert sum(result["outcomes"].values()) == 40
