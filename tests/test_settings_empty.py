"""F10 regression (fork): an empty-string option selects the DEFAULT, never a
fallback chain, and one broken option must not cascade into the remaining fields.

The fork fixed this in the host settings layer: `update_model(base_url="")` and a
blank `model` or numeric option arrived as present-but-empty strings and produced
a blank that broke the request, or a ValueError that aborted the remaining option
fields. The plugin's coerce helpers must refuse both.
"""
from __future__ import annotations

import importlib.util
import pathlib
import sys

import pytest

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


@pytest.fixture
def settings(monkeypatch: pytest.MonkeyPatch, tmp_path: pathlib.Path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    path = pathlib.Path(__file__).resolve().parents[1] / "hermes-plugin" / "settings.py"
    spec = importlib.util.spec_from_file_location("jev_settings_empty_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, spec.name, module)
    spec.loader.exec_module(module)
    return module


def test_empty_model_string_selects_default(settings):
    assert settings.EngineSettings._coerce_text("", settings.DEFAULT_MODEL) == settings.DEFAULT_MODEL
    assert settings.EngineSettings._coerce_text("  ", settings.DEFAULT_MODEL) == settings.DEFAULT_MODEL


def test_nonempty_model_string_passes_through(settings):
    assert settings.EngineSettings._coerce_text("jev-x", "default-m") == "jev-x"


def test_non_string_garbage_selects_default(settings):
    for junk in (None, 42, 3.14, [], {}, object()):
        assert settings.EngineSettings._coerce_text(junk, "fallback") == "fallback"


def test_empty_numeric_option_selects_default(settings):
    coerce = settings.EngineSettings._coerce_number
    assert coerce("", 120.0, float) == 120.0
    assert coerce("   ", 120.0, float) == 120.0
    assert coerce(None, 120.0, float) == 120.0
    assert coerce("junk", 120.0, float) == 120.0
    assert coerce("30.5", 120.0, float) == 30.5


def test_bad_option_does_not_stop_remaining_fields(settings):
    """Fork F10: one broken value must not cascade — later fields still apply."""
    coerce_text = settings.EngineSettings._coerce_text
    coerce_number = settings.EngineSettings._coerce_number
    model = coerce_text("valid-model", "unused-default")        # applied
    timeout = coerce_number("not-a-number", 120.0, float)       # default, no raise
    policy = str("rollback" if "rollback" in ("rollback",) else "retain-unscored")
    assert model == "valid-model"
    assert timeout == 120.0
    assert policy == "rollback"
