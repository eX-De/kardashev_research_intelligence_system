from __future__ import annotations

import json
from unittest.mock import patch

from worker.chat_requests import build_chat_payload
from worker.config import LLMProvider, normalize_openrouter_model_policies
from worker.llm import call_chat_json


def provider(**overrides: object) -> LLMProvider:
    values = {
        "id": "provider",
        "name": "Provider",
        "base_url": "https://example.test/v1",
        "api_key": "secret",
        "chat_models": ["model"],
        "embedding_models": [],
    }
    values.update(overrides)
    return LLMProvider(**values)


def test_generic_provider_keeps_common_payload_unchanged() -> None:
    payload = {"model": "model", "messages": [], "temperature": 0.1}

    result = build_chat_payload(provider(), payload)

    assert result == payload
    assert result is not payload


def test_openrouter_provider_maps_reasoning_and_upstream_routing() -> None:
    payload = {"model": "deepseek/deepseek-v4-pro", "messages": []}

    result = build_chat_payload(
        provider(
            provider_type="openrouter",
            openrouter_model_policies={
                "deepseek/deepseek-v4-pro": {
                    "reasoning_effort": "max",
                    "provider_only": ["DeepSeek", "Fireworks"],
                    "provider_sort": "price",
                }
            },
        ),
        payload,
    )

    assert result == {
        **payload,
        "reasoning": {"effort": "max"},
        "provider": {"only": ["deepseek", "fireworks"], "sort": "price"},
    }


def test_openrouter_provider_default_policy_omits_optional_request_fields() -> None:
    payload = {"model": "openai/gpt-5.5", "messages": []}

    result = build_chat_payload(provider(provider_type="openrouter"), payload)

    assert result == payload


def test_openrouter_policy_is_scoped_to_the_selected_model() -> None:
    openrouter = provider(
        provider_type="openrouter",
        openrouter_model_policies={
            "deepseek/deepseek-chat": {
                "reasoning_effort": "high",
                "provider_only": ["DeepInfra"],
                "provider_sort": "price",
            }
        },
    )

    result = build_chat_payload(openrouter, {"model": "openai/gpt-5.5", "messages": []})

    assert result == {"model": "openai/gpt-5.5", "messages": []}


def test_legacy_openrouter_policy_migrates_only_for_one_model() -> None:
    legacy = {
        "reasoning_effort": "high",
        "openrouter_provider_only": ["DeepInfra"],
        "openrouter_provider_sort": "price",
    }

    assert normalize_openrouter_model_policies(None, ["deepseek/deepseek-chat"], legacy) == {
        "deepseek/deepseek-chat": {
            "reasoning_effort": "high",
            "provider_only": ["deepinfra"],
            "provider_sort": "price",
        }
    }
    assert normalize_openrouter_model_policies(
        None,
        ["deepseek/deepseek-chat", "openai/gpt-5.5"],
        legacy,
    ) == {}


def test_call_chat_json_applies_openrouter_policy_to_wire_payload() -> None:
    openrouter = provider(
        provider_type="openrouter",
        openrouter_model_policies={
            "deepseek/deepseek-v4-pro": {
                "reasoning_effort": "high",
                "provider_only": ["DeepSeek"],
                "provider_sort": "",
            }
        },
    )

    class SettingsStub:
        llm_chat_provider_id = "provider"
        llm_chat_model = "deepseek/deepseek-v4-pro"

        @staticmethod
        def provider(_provider_id: str) -> LLMProvider:
            return openrouter

    class Response:
        def __enter__(self) -> "Response":
            return self

        def __exit__(self, *_args: object) -> bool:
            return False

        @staticmethod
        def read() -> bytes:
            return b'{"choices":[{"message":{"content":"{\\"ok\\":true}"}}]}'

    with patch("worker.llm.urllib.request.urlopen", return_value=Response()) as urlopen:
        assert call_chat_json(SettingsStub(), "prompt") == {"ok": True}  # type: ignore[arg-type]

    request = urlopen.call_args.args[0]
    wire_payload = json.loads(request.data.decode("utf-8"))
    assert wire_payload["reasoning"] == {"effort": "high"}
    assert wire_payload["provider"] == {"only": ["deepseek"]}
