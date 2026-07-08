export const CACHE_KEY_SEPARATOR = "|";

export function cacheKey(...parts) {
  const values = parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts;
  const key = values
    .map((part) => encodeURIComponent(String(part ?? "")))
    .join(CACHE_KEY_SEPARATOR);
  if (!key) throw new Error("Api cache key is required.");
  return key;
}

export function cacheNamespace(...parts) {
  return { namespace: cacheKey(...parts) };
}
