from __future__ import annotations

from typing import Any

from .config import LLMProvider, normalize_openrouter_provider_sort, normalize_reasoning_effort


def build_chat_payload(provider: LLMProvider, payload: dict[str, Any]) -> dict[str, Any]:
    """Apply provider-specific request policy without mutating the common payload."""
    request_payload = dict(payload)
    if provider.provider_type != "openrouter":
        return request_payload

    model = str(request_payload.get("model") or "").strip()
    policy = provider.openrouter_model_policies.get(model, {})
    reasoning_effort = normalize_reasoning_effort(policy.get("reasoning_effort", ""))
    if reasoning_effort:
        request_payload["reasoning"] = {"effort": reasoning_effort}

    provider_preferences: dict[str, Any] = {}
    raw_provider_only = policy.get("provider_only", [])
    provider_only = [str(item).strip().lower() for item in raw_provider_only if str(item).strip()] if isinstance(raw_provider_only, list) else []
    if provider_only:
        provider_preferences["only"] = provider_only
    provider_sort = normalize_openrouter_provider_sort(policy.get("provider_sort", ""))
    if provider_sort:
        provider_preferences["sort"] = provider_sort
    if provider_preferences:
        request_payload["provider"] = provider_preferences

    return request_payload
