"""Self-update opt-out must stop before network or installation side effects.

    python tests/test_updater.py
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pyserver"))
from app import updater


class ManagedInstallationTests(unittest.TestCase):
    def test_disabled_check_and_apply_have_no_side_effects(self) -> None:
        for value in ("1", "true", "YES", " on "):
            with self.subTest(value=value), patch.dict(os.environ, {"RISUHINA_DISABLE_SELF_UPDATE": value}), \
                    patch.object(updater, "repo", side_effect=AssertionError("disabled checks must not load config")), \
                    patch.object(updater, "_http_json") as network, \
                    patch.object(updater, "_http_bytes") as download, \
                    patch.object(updater.tempfile, "mkdtemp") as staging, \
                    patch.object(updater, "_install") as install:
                result = updater.check()
                self.assertFalse(result["ok"])
                self.assertTrue(result["configured"], "the plugin must show the Docker message, not missing-repo help")
                self.assertIn("Docker", result["error"])
                with self.assertRaisesRegex(updater.UpdateError, "Docker"):
                    updater.apply()
                network.assert_not_called()
                download.assert_not_called()
                staging.assert_not_called()
                install.assert_not_called()

    def test_normal_installation_still_checks_releases(self) -> None:
        for value in (None, "0", "false"):
            with self.subTest(value=value), patch.dict(os.environ):
                os.environ.pop("RISUHINA_DISABLE_SELF_UPDATE", None)
                if value is not None:
                    os.environ["RISUHINA_DISABLE_SELF_UPDATE"] = value
                with patch.object(updater, "repo", return_value="owner/repo"), \
                        patch.object(updater, "_http_json", return_value={"tag_name": "v999.0.0", "assets": []}) as network:
                    result = updater.check()
                    self.assertTrue(result["ok"])
                    self.assertTrue(result["newer"])
                    network.assert_called_once_with(updater.API.format(repo="owner/repo"))


if __name__ == "__main__":
    unittest.main()
