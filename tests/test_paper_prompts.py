from __future__ import annotations

import unittest
from types import SimpleNamespace

from worker.paper_prompts import (
    PAPER_READER_DEFAULT_PROMPTS,
    infer_paper_reader_prompt_mode,
    resolve_paper_reader_prompt,
)


class PaperPromptTests(unittest.TestCase):
    def test_legacy_chinese_default_is_not_migrated_as_custom(self) -> None:
        legacy_prompt = """请阅读这篇论文 PDF，输出结构化解读：

1. 研究问题和背景
2. 方法和实验设计
3. 主要发现
4. 局限性
5. 对后续研究或应用的启发

请尽量使用中文，保留关键英文术语。"""

        self.assertEqual(infer_paper_reader_prompt_mode("", legacy_prompt), "default")

    def test_default_prompt_follows_requested_locale(self) -> None:
        settings = SimpleNamespace(
            paper_reader_prompt_mode="default",
            paper_reader_prompt_locale="zh-CN",
            paper_reader_default_prompt="Unused custom prompt",
        )

        self.assertEqual(
            resolve_paper_reader_prompt(settings, locale="en"),
            PAPER_READER_DEFAULT_PROMPTS["en"],
        )

    def test_custom_prompt_is_not_overwritten_by_locale(self) -> None:
        settings = SimpleNamespace(
            paper_reader_prompt_mode="custom",
            paper_reader_prompt_locale="zh-CN",
            paper_reader_default_prompt="Focus on the evaluation protocol.",
        )

        self.assertEqual(
            resolve_paper_reader_prompt(settings, locale="en"),
            "Focus on the evaluation protocol.",
        )


if __name__ == "__main__":
    unittest.main()
