from pathlib import Path
import tempfile
import unittest

from sync_runtime_secrets import sync_runtime_token


class RuntimeSecretsTest(unittest.TestCase):
    def test_rotation_preserves_other_profile_settings_and_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory)
            target = profile / ".env"
            target.write_text("# User settings\nOTHER_KEY=keep-me\nexport ANALYST_SERVICE_TOKEN=" + "a" * 64 + "\n")
            sync_runtime_token(profile, "b" * 64)
            self.assertEqual(target.read_text(), "# User settings\nOTHER_KEY=keep-me\nANALYST_SERVICE_TOKEN=" + "b" * 64 + "\n")
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            sync_runtime_token(profile, "c" * 64)
            self.assertEqual(target.read_text().count("ANALYST_SERVICE_TOKEN="), 1)
            self.assertIn("c" * 64, target.read_text())

    def test_missing_runtime_token_does_not_overwrite_existing_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory)
            target = profile / ".env"
            target.write_text("OTHER_KEY=keep-me\n")
            for invalid in ["", "token\nOTHER_KEY=changed", "x" * 64]:
                with self.assertRaises(ValueError):
                    sync_runtime_token(profile, invalid)
            self.assertEqual(target.read_text(), "OTHER_KEY=keep-me\n")

    def test_creates_profile_but_never_follows_an_environment_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            profile = Path(directory) / "profile"
            sync_runtime_token(profile, "a" * 64)
            target = profile / ".env"
            original = target.read_text()
            elsewhere = Path(directory) / "other-env"
            target.rename(elsewhere)
            target.symlink_to(elsewhere)
            with self.assertRaises(ValueError):
                sync_runtime_token(profile, "b" * 64)
            self.assertEqual(elsewhere.read_text(), original)


if __name__ == "__main__":
    unittest.main()
