import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeProviders,
  OPENROUTER_BASE_URL,
  providerPayload,
  providerType
} from "../../src/lib/settingsProviders.js";

test("providerType recognizes legacy OpenRouter URLs", () => {
  assert.equal(providerType({ base_url: OPENROUTER_BASE_URL }), "openrouter");
  assert.equal(providerType({ provider_type: "openai_compatible", base_url: OPENROUTER_BASE_URL }), "openai_compatible");
});

test("normalizeProviders preserves a truly empty provider registry", () => {
  assert.deepEqual(normalizeProviders([]), []);
});

test("OpenRouter model policies survive frontend normalization and payload conversion", () => {
  const [provider] = normalizeProviders([{
    id: "openrouter",
    name: "OpenRouter",
    base_url: OPENROUTER_BASE_URL,
    api_key_configured: true,
    chat_models: ["deepseek/deepseek-v4-pro"],
    provider_type: "openrouter",
    openrouter_model_policies: {
      "deepseek/deepseek-v4-pro": {
        reasoning_effort: "max",
        provider_only: ["DeepSeek", "Fireworks"],
        provider_sort: "throughput"
      }
    }
  }]);

  assert.deepEqual(providerPayload([provider]), [{
    id: "openrouter",
    name: "OpenRouter",
    base_url: OPENROUTER_BASE_URL,
    api_key: "",
    clear_api_key: false,
    chat_models: ["deepseek/deepseek-v4-pro"],
    embedding_models: [],
    provider_type: "openrouter",
    openrouter_model_policies: {
      "deepseek/deepseek-v4-pro": {
        reasoning_effort: "max",
        provider_only: ["deepseek", "fireworks"],
        provider_sort: "throughput"
      }
    }
  }]);
});

test("frontend drops stale OpenRouter policies and all policies from compatible APIs", () => {
  const payload = providerPayload([{
    id: "compatible",
    name: "Compatible",
    base_url: "https://example.test/v1",
    chat_models: "model-a",
    provider_type: "openai_compatible",
    openrouter_model_policies: {
      "model-a": { reasoning_effort: "high", provider_only: "DeepSeek", provider_sort: "price" },
      "stale-model": { reasoning_effort: "max", provider_only: "OpenAI", provider_sort: "latency" }
    }
  }]);

  assert.deepEqual(payload[0].openrouter_model_policies, {});
});
