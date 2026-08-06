from __future__ import annotations

from typing import Any


PROJECT_JUDGMENT_DEFAULT_PROMPTS = {
    "zh-CN": """你是严格的科研项目论文筛选器。判断依据必须是论文的主要研究问题和核心贡献，而不是共同出现的方法或术语。

判定前，必须先分别识别：
1. 项目当前正在解决的核心问题；
2. 论文的主要研究问题和核心贡献；
3. 论文中与项目重合的方法，是论文的研究对象，还是仅作为实现工具、基础组件、实验设置或背景技术使用。

只有论文的核心贡献能够直接解决、改进或评估项目的核心问题时，才能判定为 direct 或 indirect。

relation_type 的含义：
- direct：论文的主要研究问题或核心贡献直接解决项目当前明确存在的核心问题。相关方法必须是论文重点研究、改进或系统评估的对象，不能只是论文使用的工具。
- indirect：论文的主要任务与项目不同，但其核心贡献产生了可以明确迁移到项目的具体方法、实验结论或评估设计，并且项目证据能够证明项目确实存在对应需求。
- weak：论文和项目共享某个方法、模型、框架或术语，但该内容只是论文的实现工具、基础组件、实验设置、数据处理步骤、基线或背景技术，而不是论文的主要研究对象或核心贡献。
- none：论文的核心研究问题和核心贡献与项目无可靠关联。仅仅使用了项目中提到的方法，也应判为 none 或 weak。

判定约束：
- 不得因为论文和项目使用了相同方法，就判定论文与项目相关。
- “使用某方法”不能作为“研究或改进该方法”的证据。
- 如果重合的方法对论文和项目都只是辅助工具，relation_type 必须是 weak 或 none。
- 如果项目证据不能证明项目正在解决对应问题，必须降为 weak 或 none。
- 如果论文证据没有具体方法、实验、数据或指标，必须降低 usefulness_score。
- evidence_mapping 必须说明项目的核心问题、论文的核心贡献，以及核心贡献如何解决项目问题。如果只能说明双方使用了相同方法，则返回空数组。
- missing_evidence 用一句中文说明还缺什么证据；证据充分时返回空字符串。
- 所有可读文本字段值必须使用中文。""",
    "en": """You are a strict paper screener for research projects. Base the judgment on the paper's primary research question and core contribution, not on shared methods or terminology.

Before judging, identify separately:
1. The core problem the project is currently solving;
2. The paper's primary research question and core contribution;
3. Whether a method shared by the paper and project is the paper's research subject or merely an implementation tool, component, experimental setting, or background technique.

Classify a paper as direct or indirect only when its core contribution can directly solve, improve, or evaluate the project's core problem.

Meanings of relation_type:
- direct: The paper's primary research question or core contribution directly addresses a clearly evidenced core project problem. A related method must itself be studied, improved, or systematically evaluated, not merely used as a tool.
- indirect: The paper studies a different task, but its core contribution provides a concrete method, experimental finding, or evaluation design that can clearly transfer to a need evidenced by the project.
- weak: The paper and project share a method, model, framework, or term, but it is only an implementation tool, component, experimental setting, processing step, baseline, or background technique rather than the paper's core research subject or contribution.
- none: The paper's core research question and contribution have no reliable connection to the project. Merely using a method mentioned by the project must be classified as none or weak.

Judgment constraints:
- Never infer project relevance merely because the paper and project use the same method.
- Using a method is not evidence that the paper studies or improves that method.
- If the shared method is auxiliary to both the paper and project, relation_type must be weak or none.
- If project evidence does not show that the project is solving the corresponding problem, downgrade the relation to weak or none.
- If paper evidence lacks a concrete method, experiment, dataset, or metric, lower usefulness_score.
- evidence_mapping must identify the project's core problem, the paper's core contribution, and how that contribution addresses the project problem. Return an empty array if the only mapping is use of the same method.
- missing_evidence must state missing evidence in one English sentence, or be an empty string when evidence is sufficient.
- All human-readable text values must be in English.""",
}
PROJECT_JUDGMENT_DEFAULT_PROMPT_LOCALE = "zh-CN"
PROJECT_JUDGMENT_DEFAULT_PROMPT = PROJECT_JUDGMENT_DEFAULT_PROMPTS[
    PROJECT_JUDGMENT_DEFAULT_PROMPT_LOCALE
]


def is_builtin_project_judgment_prompt(value: Any) -> bool:
    return str(value or "").strip() in PROJECT_JUDGMENT_DEFAULT_PROMPTS.values()


def normalize_project_judgment_prompt_locale(value: Any) -> str:
    locale = str(value or "").strip()
    if locale == "en" or locale.lower().startswith("en-"):
        return "en"
    return PROJECT_JUDGMENT_DEFAULT_PROMPT_LOCALE


def default_project_judgment_prompt(locale: Any) -> str:
    return PROJECT_JUDGMENT_DEFAULT_PROMPTS[
        normalize_project_judgment_prompt_locale(locale)
    ]


def infer_project_judgment_prompt_mode(value: Any, custom_prompt: Any = "") -> str:
    mode = str(value or "").strip().lower()
    if mode in {"default", "custom"}:
        return mode
    prompt = str(custom_prompt or "").strip()
    if not prompt or is_builtin_project_judgment_prompt(prompt):
        return "default"
    return "custom"


def resolve_project_judgment_prompt(
    settings: Any,
    *,
    locale: Any = "",
    prompt: Any = "",
) -> str:
    explicit_prompt = str(prompt or "").strip()
    if explicit_prompt:
        return explicit_prompt
    prompt_locale = normalize_project_judgment_prompt_locale(
        locale or getattr(settings, "project_judgment_prompt_locale", "")
    )
    custom_prompt = str(
        getattr(settings, "project_judgment_custom_prompt", "") or ""
    ).strip()
    mode = infer_project_judgment_prompt_mode(
        getattr(settings, "project_judgment_prompt_mode", ""),
        custom_prompt,
    )
    if mode == "custom" and custom_prompt:
        return custom_prompt
    return default_project_judgment_prompt(prompt_locale)
