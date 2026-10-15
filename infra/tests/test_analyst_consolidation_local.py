#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "ops"))

import analyst_consolidation_local as local  # noqa: E402


def write_local_export(path: Path, *, mode: str = "shadow") -> None:
    settings = path / "local-settings"
    settings.mkdir(parents=True)
    (settings / "settings.json").write_text(
        json.dumps(
            {
                "classification": "rollback-local-settings",
                "repositoryEnv": {
                    "LEGACY_HERMES_MODE": mode,
                    "REACT_APP_ANALYST_SHADOW_MODE": "true",
                    "HERMES_BRIDGE_ENABLED": "true",
                },
                "launchAgent": {
                    "environment": {
                        "HERMES_BRIDGE_ENABLED": "false",
                        "READINESS_CONTROLLER_MODE": "shadow",
                    }
                },
            }
        ),
        encoding="utf-8",
    )


class AnalystConsolidationLocalTests(unittest.TestCase):
    def test_render_env_changes_only_allowlisted_keys_and_removes_duplicates(self):
        original = (
            "# local settings\n"
            "SECRET_VALUE=preserve-me\n"
            "LEGACY_HERMES_MODE=shadow\n"
            "LEGACY_HERMES_MODE=shadow\n"
            "HERMES_RELIABILITY_CONTROLLER_MODE=shadow\n"
        )

        rendered = local.render_env(
            original,
            {
                "LEGACY_HERMES_MODE": "read-only",
                "HERMES_RELIABILITY_CONTROLLER_MODE": None,
                "READINESS_CONTROLLER_MODE": "active",
            },
        )

        self.assertIn("SECRET_VALUE=preserve-me", rendered)
        self.assertEqual(rendered.count("LEGACY_HERMES_MODE="), 1)
        self.assertIn("LEGACY_HERMES_MODE=read-only", rendered)
        self.assertNotIn("HERMES_RELIABILITY_CONTROLLER_MODE=", rendered)
        self.assertIn("READINESS_CONTROLLER_MODE=active", rendered)

    def test_cutover_uses_new_controller_allowlist_with_legacy_fallback(self):
        settings = local.cutover_settings(
            {"HERMES_RELIABILITY_ENABLED_ACTIONS": "prune-dashboard-logs"}
        )

        self.assertEqual(settings["LEGACY_HERMES_MODE"], "read-only")
        self.assertEqual(settings["REACT_APP_ANALYST_SHADOW_MODE"], "false")
        self.assertEqual(settings["HERMES_BRIDGE_ENABLED"], "false")
        self.assertEqual(settings["HERMES_OPERATIONS_BRIDGE_ENABLED"], "false")
        self.assertEqual(settings["HERMES_PORTFOLIO_BRIDGE_ENABLED"], "false")
        self.assertEqual(settings["READINESS_CONTROLLER_MODE"], "active")
        self.assertEqual(
            settings["READINESS_CONTROLLER_ENABLED_ACTIONS"],
            "prune-dashboard-logs",
        )

    def test_cutover_preserves_a_launchagent_only_action_allowlist(self):
        settings = local.cutover_settings(
            {},
            {
                "READINESS_CONTROLLER_ENABLED_ACTIONS": (
                    "restart-ibkr-sidecar,prune-dashboard-logs"
                )
            },
        )

        self.assertEqual(
            settings["READINESS_CONTROLLER_ENABLED_ACTIONS"],
            "restart-ibkr-sidecar,prune-dashboard-logs",
        )

    def test_rollback_restores_exported_shadow_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            export = Path(directory)
            write_local_export(export)

            restored = local.rollback_settings(export)

        self.assertEqual(restored["LEGACY_HERMES_MODE"], "shadow")
        self.assertEqual(restored["REACT_APP_ANALYST_SHADOW_MODE"], "true")
        # Repository configuration is the desired source and wins over a
        # differing captured runtime plist value.
        self.assertEqual(restored["HERMES_BRIDGE_ENABLED"], "true")
        self.assertEqual(restored["READINESS_CONTROLLER_MODE"], "shadow")

    def test_rollback_rejects_an_export_captured_after_cutover(self):
        with tempfile.TemporaryDirectory() as directory:
            export = Path(directory)
            write_local_export(export, mode="read-only")

            with self.assertRaises(local.LocalModeFailure) as raised:
                local.rollback_settings(export)

        self.assertEqual(raised.exception.code, "ROLLBACK_LOCAL_MODE_NOT_SHADOW")

    def test_failed_cutover_reinstalls_exported_shadow_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            env_path = root / ".env"
            env_path.write_text(
                "LEGACY_HERMES_MODE=shadow\nHERMES_BRIDGE_ENABLED=true\n",
                encoding="utf-8",
            )
            export = root / "rollback"
            write_local_export(export)
            stderr = StringIO()
            install_failure = subprocess.CalledProcessError(2, ["npm"])
            with (
                mock.patch.object(local, "ENV_PATH", env_path),
                mock.patch.object(local, "APP_SUPPORT", root / "support"),
                mock.patch.object(
                    local,
                    "verify_rollback_export",
                    return_value={"passed": True, "path": str(export)},
                ),
                mock.patch.object(
                    local,
                    "verify_analyst_shadow_acceptance",
                    return_value={"passed": True},
                ),
                mock.patch.object(
                    local,
                    "install_launch_agent",
                    side_effect=[install_failure, None],
                ) as install,
                redirect_stderr(stderr),
            ):
                result = local.main(
                    [
                        "--mode",
                        "cutover",
                        "--apply",
                        "--rollback-export",
                        str(export),
                    ]
                )

            self.assertEqual(result, 2)
            self.assertEqual(
                env_path.read_text(encoding="utf-8"),
                "LEGACY_HERMES_MODE=shadow\nHERMES_BRIDGE_ENABLED=true\n",
            )
            self.assertEqual(install.call_count, 2)
            failure = json.loads(stderr.getvalue())
            self.assertEqual(failure["error"]["code"], "LOCAL_MODE_APPLY_FAILED")


if __name__ == "__main__":
    unittest.main()
