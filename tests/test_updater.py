"""Self-update in an image-managed (Docker) install, and the Linux lock files.

    python tests/test_updater.py

In Docker the image owns the code: the release is still looked up - the plugin
updates itself from master, so the backend must hear that a newer one exists
(§1-91) - but nothing is ever downloaded or installed in place.
"""
from __future__ import annotations

import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pyserver"))
from app import updater

RELEASE = {
    "tag_name": "v999.0.0",
    "assets": [
        {"name": "Risu.Hina.999.0.0.Linux.x64.Auto.Install.Package.zip", "browser_download_url": "https://example.invalid/l.zip"},
        {"name": "Risu.Hina.999.0.0.Windows.x64.Auto.Install.Package.zip", "browser_download_url": "https://example.invalid/w.zip"},
        {"name": updater.SUMS_PREFIX + "999.0.0.txt", "browser_download_url": "https://example.invalid/s.txt"},
    ],
}


class ManagedInstallationTests(unittest.TestCase):
    def test_docker_still_sees_a_newer_release_but_never_installs(self) -> None:
        for value in ("1", "true", "YES", " on "):
            with self.subTest(value=value), patch.dict(os.environ, {"RISUHINA_DISABLE_SELF_UPDATE": value}), \
                    patch.object(updater, "repo", return_value="owner/repo"), \
                    patch.object(updater, "_http_json", return_value=RELEASE) as network, \
                    patch.object(updater, "_http_bytes") as download, \
                    patch.object(updater.tempfile, "mkdtemp") as staging, \
                    patch.object(updater, "_install") as install:
                result = updater.check()
                self.assertTrue(result["ok"])
                self.assertTrue(result["newer"], "a Docker backend is told a newer release exists")
                self.assertEqual(result["latest"], "999.0.0")
                self.assertFalse(result["installable"])
                self.assertIn("Docker", result["reason"])
                self.assertIn("v999.0.0", result["reason"], "the reason names the tag to build")
                network.assert_called()
                with self.assertRaisesRegex(updater.UpdateError, "Docker"):
                    updater.apply()
                download.assert_not_called()
                staging.assert_not_called()
                install.assert_not_called()

    def test_docker_without_a_newer_release_is_a_no_op(self) -> None:
        current = {**RELEASE, "tag_name": "v0.0.1"}
        with patch.dict(os.environ, {"RISUHINA_DISABLE_SELF_UPDATE": "1"}), \
                patch.object(updater, "repo", return_value="owner/repo"), \
                patch.object(updater, "_http_json", return_value=current), \
                patch.object(updater, "_install") as install:
            self.assertFalse(updater.apply()["updated"])
            install.assert_not_called()

    def test_normal_installation_still_installs(self) -> None:
        for value in (None, "0", "false"):
            with self.subTest(value=value), patch.dict(os.environ):
                os.environ.pop("RISUHINA_DISABLE_SELF_UPDATE", None)
                if value is not None:
                    os.environ["RISUHINA_DISABLE_SELF_UPDATE"] = value
                with patch.object(updater, "repo", return_value="owner/repo"), \
                        patch.object(updater, "_http_json", return_value=RELEASE) as network:
                    result = updater.check()
                    self.assertTrue(result["ok"])
                    self.assertTrue(result["newer"])
                    self.assertTrue(result["installable"])
                    network.assert_called_once_with(updater.API.format(repo="owner/repo"))


def _pins(name: str) -> set[str]:
    lines = (ROOT / "pyserver" / "locks" / name).read_text(encoding="utf-8").splitlines()
    return {line.split()[0] for line in lines if line.strip() and not line.startswith("#")}


class LinuxLockTests(unittest.TestCase):
    def test_both_linux_locks_pin_the_same_versions(self) -> None:
        # A version bumped in one lock and not the other still installs - just
        # different code on ARM64. Only the wheel hashes may differ.
        x86, arm = _pins("linux-x86_64-cp311.txt"), _pins("linux-aarch64-cp311.txt")
        self.assertEqual(x86, arm, f"only in x86_64: {sorted(x86 - arm)}; only in aarch64: {sorted(arm - x86)}")


if __name__ == "__main__":
    unittest.main()
