import { csv } from "./dashboard.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export function providerType(provider = {}) {
  const explicit = String(provider.provider_type || "").trim().toLowerCase();
  if (explicit === "openrouter" || explicit === "openai_compatible") return explicit;
  return String(provider.base_url || "").toLowerCase().includes("openrouter.ai")
    ? "openrouter"
    : "openai_compatible";
}

function modelNames(value) {
  return String(csv(value) || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export function normalizeOpenRouterModelPolicies(value = {}, chatModels = []) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const policies = {};
  for (const model of modelNames(chatModels)) {
    const policy = source[model];
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) continue;
    policies[model] = {
      reasoning_effort: String(policy.reasoning_effort || "").trim(),
      provider_only: csv(policy.provider_only),
      provider_sort: String(policy.provider_sort || "").trim()
    };
  }
  return policies;
}

function normalizedProvider(provider = {}) {
  const type = providerType(provider);
  const chatModels = csv(provider.chat_models);
  return {
    id: provider.id || "",
    name: provider.name || "",
    base_url: type === "openrouter" ? OPENROUTER_BASE_URL : provider.base_url || "",
    api_key: "",
    api_key_configured: Boolean(provider.api_key_configured),
    chat_models: chatModels,
    embedding_models: csv(provider.embedding_models),
    provider_type: type,
    openrouter_model_policies: type === "openrouter"
      ? normalizeOpenRouterModelPolicies(provider.openrouter_model_policies, chatModels)
      : {},
    clear_api_key: false
  };
}

export function normalizeProviders(providers = []) {
  return providers.map(normalizedProvider);
}

export function providerPayload(providers = []) {
  return providers
    .map((provider) => {
      const type = providerType(provider);
      const chatModels = modelNames(provider.chat_models);
      const policies = normalizeOpenRouterModelPolicies(provider.openrouter_model_policies, chatModels);
      return {
        id: String(provider.id || "").trim(),
        name: String(provider.name || "").trim(),
        base_url: type === "openrouter" ? OPENROUTER_BASE_URL : String(provider.base_url || "").trim(),
        api_key: provider.api_key || "",
        clear_api_key: Boolean(provider.clear_api_key),
        chat_models: chatModels,
        embedding_models: modelNames(provider.embedding_models),
        provider_type: type,
        openrouter_model_policies: type === "openrouter"
          ? Object.fromEntries(Object.entries(policies).map(([model, policy]) => [model, {
            reasoning_effort: policy.reasoning_effort,
            provider_only: modelNames(policy.provider_only).map((provider) => provider.toLowerCase()),
            provider_sort: policy.provider_sort
          }]))
          : {}
      };
    })
    .filter((provider) => provider.id);
}
