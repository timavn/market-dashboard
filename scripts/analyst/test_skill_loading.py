"""Exercise the installed Hermes skill path without model calls or account data.

Run with Hermes's Python environment and HERMES_AGENT_ROOT pointing to its source.
"""

import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch


class AnalystSkillLoadingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        runtime = os.environ.get("HERMES_AGENT_ROOT")
        if not runtime or not (Path(runtime) / "model_tools.py").is_file():
            raise unittest.SkipTest("HERMES_AGENT_ROOT must name the installed Hermes source")
        cls.temporary = tempfile.TemporaryDirectory()
        cls.profile = Path(cls.temporary.name)
        cls.environment = patch.dict(os.environ, {"HERMES_HOME": str(cls.profile)})
        cls.home = patch.object(Path, "home", return_value=cls.profile)
        cls.environment.start()
        cls.home.start()
        sys.path.insert(0, runtime)

        repository = Path(__file__).resolve().parents[2]
        shutil.copytree(
            repository / "config/analyst/plugins/analyst-skill-reader",
            cls.profile / "plugins/analyst-skill-reader",
        )
        (cls.profile / "config.yaml").write_text(
            "plugins:\n  enabled: [analyst-skill-reader]\n"
            "platform_toolsets:\n  cli: [analyst-skill-reader]\n"
            "tools:\n  tool_search:\n    enabled: false\n"
            "skills:\n  inline_shell: false\n",
            encoding="utf-8",
        )
        cls.skill = cls.profile / "skills/test-portfolio-workflow/SKILL.md"
        cls.skill.parent.mkdir(parents=True)
        cls.skill.write_text(
            "---\nname: test-portfolio-workflow\n"
            "description: Test the portfolio workflow reader.\n---\n"
            "# Workflow\nRead verified evidence.\n"
            "!`touch must-not-exist`\n",
            encoding="utf-8",
        )
        import model_tools
        from hermes_cli.plugins import discover_plugins
        discover_plugins()
        cls.model_tools = model_tools

    @classmethod
    def tearDownClass(cls):
        cls.home.stop()
        cls.environment.stop()
        cls.temporary.cleanup()

    def test_discovery_exposes_readers_without_mutating_or_execution_tools(self):
        tools = self.model_tools.get_tool_definitions(
            enabled_toolsets=["analyst-skill-reader"], quiet_mode=True,
        )
        names = {tool["function"]["name"] for tool in tools}
        self.assertEqual(names, {"skills_list", "skill_view"})
        from agent.system_prompt import _skills_prompt
        from types import SimpleNamespace
        agent = SimpleNamespace(valid_tool_names=names, platform="cli")
        prompt = _skills_prompt(agent)
        self.assertIn("test-portfolio-workflow", prompt)
        self.assertIn("skill_view", prompt)
        agent.valid_tool_names = set()
        self.assertEqual(_skills_prompt(agent), "")

    def test_dispatch_reads_skill_and_preserves_read_only_boundary(self):
        before = self.skill.read_text(encoding="utf-8")
        listed = json.loads(self.model_tools.handle_function_call(
            "skills_list", {}, task_id="skill-reader-test",
            enabled_toolsets=["analyst-skill-reader"],
        ))
        self.assertTrue(listed["success"])
        self.assertIn("test-portfolio-workflow", {item["name"] for item in listed["skills"]})
        viewed = json.loads(self.model_tools.handle_function_call(
            "skill_view", {"name": "test-portfolio-workflow"}, task_id="skill-reader-test",
            enabled_toolsets=["analyst-skill-reader"],
        ))
        self.assertTrue(viewed["success"])
        self.assertIn("Read verified evidence.", viewed["content"])
        self.assertIn("!`touch must-not-exist`", viewed["content"])
        self.assertFalse((self.skill.parent / "must-not-exist").exists())
        self.assertEqual(self.skill.read_text(encoding="utf-8"), before)


if __name__ == "__main__":
    unittest.main()
