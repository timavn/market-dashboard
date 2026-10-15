import importlib.util
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("sync_profile_assets", Path(__file__).with_name("sync_profile_assets.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AssetInstallationTests(unittest.TestCase):
    def test_installs_nested_skills_and_plugin_without_removing_user_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "source", Path(directory) / "profile"
            contents = {
                "SOUL.md": "shared identity",
                "skills/balance-review/SKILL.md": "balance guidance",
                "skills/balance-review/references/account.md": "account comparisons",
                "plugins/analyst-skill-reader/plugin.yaml": "reader manifest",
            }
            for name, value in contents.items():
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(value)
            user_skill = target / "skills/user-owned/SKILL.md"
            user_skill.parent.mkdir(parents=True)
            user_skill.write_text("keep this skill")
            self.assertEqual(set(module.sync_assets(source, target)), set(contents))
            for name, value in contents.items():
                path = target / name
                self.assertEqual(path.read_text(), value)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(user_skill.read_text(), "keep this skill")

    def test_rejects_profile_symlink_escape_without_touching_external_file(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, target, outside = base / "source", base / "profile", base / "outside"
            (source / "skills/review").mkdir(parents=True)
            (source / "skills/review/SKILL.md").write_text("managed")
            (source / "SOUL.md").write_text("identity")
            target.mkdir()
            outside.mkdir()
            (outside / "SKILL.md").write_text("external")
            (target / "skills").mkdir()
            (target / "skills/review").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                module.sync_assets(source, target)
            self.assertEqual((outside / "SKILL.md").read_text(), "external")

    def test_explicit_retirement_is_recoverable_and_preserves_unrelated_skills_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, target, archive = base / "source", base / "profile", base / "backups/analyst-retired-skills"
            current = source / "skills/portfolio-review/SKILL.md"
            current.parent.mkdir(parents=True)
            current.write_text("current focused workflow")
            (source / "SOUL.md").write_text("refined identity")
            retired_paths = [
                "skills/the-analyst", "skills/portfolio-refresh",
                "skills/autonomous-ai-agents/hermes-agent",
            ]
            for name in [*retired_paths, "skills/user-owned"]:
                skill = target / name / "SKILL.md"
                skill.parent.mkdir(parents=True, exist_ok=True)
                skill.write_text(f"original {name}")
            for name in [".bundled_manifest", ".usage.json"]:
                (target / "skills" / name).write_text("preserved metadata")
            command = [sys.executable, str(Path(module.__file__)), "--source", str(source), "--target", str(target), "--archive-root", str(archive)]
            for name in retired_paths:
                command.extend(["--retire", name])
            completed = subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertIn("archived 3 retired skills", completed.stdout)
            batches = list(archive.iterdir())
            self.assertEqual(len(batches), 1)
            for name in retired_paths:
                self.assertFalse((target / name).exists())
                self.assertEqual((batches[0] / name / "SKILL.md").read_text(), f"original {name}")
            self.assertEqual((target / "skills/portfolio-review/SKILL.md").read_text(), "current focused workflow")
            self.assertEqual((target / "skills/user-owned/SKILL.md").read_text(), "original skills/user-owned")
            for name in [".bundled_manifest", ".usage.json"]:
                self.assertEqual((target / "skills" / name).read_text(), "preserved metadata")
            repeated = subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertIn("archived 0 retired skills", repeated.stdout)
            self.assertEqual(list(archive.iterdir()), batches)

    def test_retirement_rejects_escape_broad_pruning_current_skills_and_unsafe_archives(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, target, archive = base / "source", base / "profile", base / "backups/analyst"
            (source / "skills/current").mkdir(parents=True)
            (source / "skills/current/SKILL.md").write_text("current source")
            for name in ["current", "obsolete"]:
                skill = target / "skills" / name / "SKILL.md"
                skill.parent.mkdir(parents=True, exist_ok=True)
                skill.write_text("user original")
            for name in [
                "../profile/skills/obsolete", "skills/../../outside", "/skills/obsolete",
                "skills", "plugins/unrelated", "skills/.bundled_manifest", "skills/./obsolete",
                "skills\\obsolete", "skills/current",
            ]:
                with self.subTest(name=name), self.assertRaises(ValueError):
                    module.plan_retired_skills(source, target, [name], archive)
            for unsafe in [None, target / "skills/archive", target.parent, source / "skills/archive"]:
                with self.subTest(archive=unsafe), self.assertRaises(ValueError):
                    module.plan_retired_skills(source, target, ["skills/obsolete"], unsafe)
            self.assertEqual((target / "skills/obsolete/SKILL.md").read_text(), "user original")
            self.assertEqual((target / "skills/current/SKILL.md").read_text(), "user original")
            self.assertFalse(archive.exists())

    def test_retirement_rejects_skill_and_archive_parent_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, target, outside = base / "source", base / "profile", base / "outside"
            source.mkdir()
            (target / "skills").mkdir(parents=True)
            outside.mkdir()
            (outside / "SKILL.md").write_text("external skill")
            (target / "skills/obsolete").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                module.plan_retired_skills(source, target, ["skills/obsolete"], base / "backups")
            (target / "skills/obsolete").unlink()
            (target / "skills/obsolete").mkdir()
            (target / "skills/obsolete/SKILL.md").write_text("old skill")
            (base / "backups").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                module.plan_retired_skills(source, target, ["skills/obsolete"], base / "backups/analyst")
            self.assertEqual((outside / "SKILL.md").read_text(), "external skill")
            self.assertEqual((target / "skills/obsolete/SKILL.md").read_text(), "old skill")

    def test_source_symlinks_are_rejected_before_any_managed_file_is_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, target, outside = base / "source", base / "profile", base / "outside"
            source.mkdir()
            target.mkdir()
            outside.mkdir()
            (source / "SOUL.md").write_text("new identity")
            (target / "SOUL.md").write_text("original identity")
            (outside / "SKILL.md").write_text("external instructions")
            (source / "skills").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                module.sync_assets(source, target)
            self.assertEqual((target / "SOUL.md").read_text(), "original identity")
            self.assertEqual((outside / "SKILL.md").read_text(), "external instructions")

    def test_nested_root_symlinks_cannot_redirect_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            source, target, outside = base / "source", base / "profile", base / "outside"
            source.mkdir()
            target.mkdir()
            (outside / "nested").mkdir(parents=True)
            (source / "SOUL.md").write_text("new identity")
            (outside / "nested/SOUL.md").write_text("external original")
            (base / "redirect").symlink_to(outside, target_is_directory=True)
            with self.assertRaises(ValueError):
                module.sync_assets(source, base / "redirect/nested")
            with self.assertRaises(ValueError):
                module.sync_assets(base / "redirect/nested", target)
            self.assertEqual((outside / "nested/SOUL.md").read_text(), "external original")


if __name__ == "__main__":
    unittest.main()
