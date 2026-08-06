from __future__ import annotations

import unittest
from types import SimpleNamespace

from worker.project_judgment_prompts import (
    PROJECT_JUDGMENT_DEFAULT_PROMPTS,
    resolve_project_judgment_prompt,
)
from worker.llm import _project_judgment_prompt


class ProjectJudgmentPromptTests(unittest.TestCase):
    def test_default_prompt_follows_requested_locale(self) -> None:
        settings = SimpleNamespace(
            project_judgment_prompt_mode="default",
            project_judgment_prompt_locale="zh-CN",
            project_judgment_custom_prompt="Unused custom prompt",
        )

        self.assertEqual(
            resolve_project_judgment_prompt(settings, locale="en"),
            PROJECT_JUDGMENT_DEFAULT_PROMPTS["en"],
        )

    def test_custom_prompt_is_not_overwritten_by_locale(self) -> None:
        settings = SimpleNamespace(
            project_judgment_prompt_mode="custom",
            project_judgment_prompt_locale="zh-CN",
            project_judgment_custom_prompt="Only accept contributions that solve the core problem.",
        )

        self.assertEqual(
            resolve_project_judgment_prompt(settings, locale="en"),
            "Only accept contributions that solve the core problem.",
        )

    def test_default_prompt_rejects_shared_auxiliary_methods(self) -> None:
        prompt = PROJECT_JUDGMENT_DEFAULT_PROMPTS["zh-CN"]

        self.assertIn("使用某方法”不能作为“研究或改进该方法", prompt)
        self.assertIn("只是辅助工具", prompt)
        self.assertIn("核心贡献", prompt)

    def test_custom_rules_are_used_inside_the_fixed_json_contract(self) -> None:
        settings = SimpleNamespace(
            project_judgment_prompt_mode="custom",
            project_judgment_prompt_locale="zh-CN",
            project_judgment_custom_prompt="自定义：只有核心贡献相关才通过。",
        )

        prompt = _project_judgment_prompt(
            {"project": {"name": "Test"}, "paper": {"title": "Paper"}},
            settings,
        )

        self.assertIn("自定义：只有核心贡献相关才通过。", prompt)
        self.assertIn("输出契约（不可由自定义判定规则覆盖）", prompt)
        self.assertIn('"project": {"name": "Test"}', prompt)


if __name__ == "__main__":
    unittest.main()
