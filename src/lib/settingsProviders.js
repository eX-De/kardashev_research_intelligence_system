import { csv } from "./dashboard.js";

function normalizedProvider(provider = {}) {
  return {
    id: provider.id || "",
    name: provider.name || "",
    base_url: provider.base_url || "",
    api_key: "",
    api_key_configured: Boolean(provider.api_key_configured),
    chat_models: csv(provider.chat_models),
    embedding_models: csv(provider.embedding_models),
    clear_api_key: false
  };
}

export function normalizeProviders(providers = []) {
  return providers.length
    ? providers.map(normalizedProvider)
    : [normalizedProvider({ id: "default", name: "Default" })];
}

export function providerPayload(providers = []) {
  return providers
    .map((provider) => ({
      id: String(provider.id || "").trim(),
      name: String(provider.name || "").trim(),
      base_url: String(provider.base_url || "").trim(),
      api_key: provider.api_key || "",
      clear_api_key: Boolean(provider.clear_api_key),
      chat_models: String(provider.chat_models || "").split(",").map((item) => item.trim()).filter(Boolean),
      embedding_models: String(provider.embedding_models || "").split(",").map((item) => item.trim()).filter(Boolean)
    }))
    .filter((provider) => provider.id);
}
