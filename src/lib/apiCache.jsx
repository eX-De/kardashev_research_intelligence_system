import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";

import { api } from "./dashboard.js";

export const DEFAULT_API_CACHE_STALE_TIME_MS = 30000;
export const CACHE_KEY_SEPARATOR = "|";

export const API_CACHE_TARGETS = {
  artifacts: cacheNamespace("artifacts"),
  health: cacheNamespace("health"),
  jobsHistory: cacheNamespace("jobs", "history"),
  jobsStatus: cacheKey("jobs", "status"),
  library: cacheNamespace("library"),
  paperReports: cacheNamespace("paper-reports"),
  papers: cacheNamespace("paper"),
  projects: cacheNamespace("projects"),
  readerPapers: cacheKey("reader", "papers"),
  notifications: cacheNamespace("notifications"),
  settings: cacheKey("settings")
};

export const DEFAULT_API_CACHE_EVENT_RULES = {
  "artifacts.changed": {
    invalidate: [API_CACHE_TARGETS.artifacts, API_CACHE_TARGETS.health, API_CACHE_TARGETS.notifications]
  },
  "jobs.changed": {
    refresh: [API_CACHE_TARGETS.jobsStatus],
    invalidate: [API_CACHE_TARGETS.jobsHistory, API_CACHE_TARGETS.paperReports, API_CACHE_TARGETS.health, API_CACHE_TARGETS.notifications]
  },
  "jobs.finished": {
    refresh: [API_CACHE_TARGETS.jobsStatus],
    invalidate: [
      API_CACHE_TARGETS.jobsHistory,
      API_CACHE_TARGETS.paperReports,
      API_CACHE_TARGETS.health,
      API_CACHE_TARGETS.notifications,
      API_CACHE_TARGETS.artifacts,
      API_CACHE_TARGETS.library
    ]
  },
  "jobs.started": {
    refresh: [API_CACHE_TARGETS.jobsStatus],
    invalidate: [API_CACHE_TARGETS.jobsHistory, API_CACHE_TARGETS.notifications]
  },
  "papers.changed": {
    invalidate: [
      API_CACHE_TARGETS.library,
      API_CACHE_TARGETS.papers,
      API_CACHE_TARGETS.readerPapers,
      API_CACHE_TARGETS.paperReports,
      API_CACHE_TARGETS.health,
      API_CACHE_TARGETS.notifications
    ]
  },
  "projects.changed": {
    invalidate: [API_CACHE_TARGETS.projects, API_CACHE_TARGETS.health, API_CACHE_TARGETS.notifications]
  },
  "reports.changed": {
    invalidate: [API_CACHE_TARGETS.paperReports, API_CACHE_TARGETS.artifacts, API_CACHE_TARGETS.notifications]
  },
  "settings.changed": {
    invalidate: [API_CACHE_TARGETS.settings, API_CACHE_TARGETS.health],
    refresh: [API_CACHE_TARGETS.jobsStatus]
  }
};

const ApiCacheContext = createContext(null);
const ACTION_FIELDS = new Set(["invalidate", "invalidateOptions", "keys", "patch", "refresh", "refreshOptions", "target"]);

function now() {
  return Date.now();
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeCacheKey(key) {
  if (Array.isArray(key)) return cacheKey(...key);
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) throw new Error("Api cache key is required.");
  return normalizedKey;
}

export function cacheKey(...parts) {
  const values = parts.length === 1 && Array.isArray(parts[0]) ? parts[0] : parts;
  const cacheKey = values
    .map((part) => encodeURIComponent(String(part ?? "")))
    .join(CACHE_KEY_SEPARATOR);
  if (!cacheKey) throw new Error("Api cache key is required.");
  return cacheKey;
}

export function cacheNamespace(...parts) {
  return { namespace: cacheKey(...parts) };
}

function stableBody(value) {
  if (value === undefined || value === null || typeof value === "string") return value || "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function makeApiCacheKey(path, options = {}) {
  if (options.key) return normalizeCacheKey(options.key);
  const method = String(options.method || options.requestOptions?.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return normalizeCacheKey(path);
  const body = stableBody(options.body ?? options.requestOptions?.body);
  return normalizeCacheKey(`${method} ${path}${body ? ` ${body}` : ""}`);
}

function createEntry(key) {
  return {
    data: undefined,
    error: null,
    fetcher: null,
    key,
    promise: null,
    stale: true,
    staleTimeMs: undefined,
    startedAt: 0,
    status: "idle",
    updatedAt: 0
  };
}

function publicEntry(entry) {
  return entry ? { ...entry } : null;
}

function keyMatchesTarget(target, key, entry) {
  if (target === undefined || target === null) return true;
  if (typeof target === "string") return key === target;
  if (target instanceof RegExp) return target.test(key);
  if (Array.isArray(target)) return target.some((item) => keyMatchesTarget(item, key, entry));
  if (typeof target === "function") return Boolean(target(key, publicEntry(entry)));
  if (!isPlainObject(target)) return false;

  if (hasOwn(target, "key") && key !== normalizeCacheKey(target.key)) return false;
  if (hasOwn(target, "keys")) return Array.isArray(target.keys) && target.keys.some((item) => keyMatchesTarget(item, key, entry));
  if (hasOwn(target, "namespace")) {
    const namespace = normalizeCacheKey(target.namespace);
    if (key !== namespace && !key.startsWith(`${namespace}${CACHE_KEY_SEPARATOR}`)) return false;
  }
  if (hasOwn(target, "prefix") && !key.startsWith(String(target.prefix))) return false;
  if (hasOwn(target, "pattern")) {
    const pattern = target.pattern;
    if (pattern instanceof RegExp && !pattern.test(key)) return false;
    if (!(pattern instanceof RegExp) && !key.includes(String(pattern))) return false;
  }
  if (typeof target.test === "function" && !target.test(key, publicEntry(entry))) return false;
  return true;
}

function isTargetDescriptor(value) {
  if (typeof value === "string" || value instanceof RegExp || Array.isArray(value) || typeof value === "function") return true;
  if (!isPlainObject(value)) return false;
  return ["key", "keys", "namespace", "prefix", "pattern", "test"].some((field) => hasOwn(value, field));
}

function hasActionFields(value) {
  return isPlainObject(value) && Object.keys(value).some((key) => ACTION_FIELDS.has(key));
}

export function createApiCacheClient({
  defaultFetcher = api,
  defaultStaleTimeMs = DEFAULT_API_CACHE_STALE_TIME_MS
} = {}) {
  const entries = new Map();
  const listeners = new Set();
  let version = 0;
  let staleTimeMs = defaultStaleTimeMs;

  function notify() {
    version += 1;
    for (const listener of listeners) listener();
  }

  function ensureEntry(key) {
    const cacheKey = normalizeCacheKey(key);
    let entry = entries.get(cacheKey);
    if (!entry) {
      entry = createEntry(cacheKey);
      entries.set(cacheKey, entry);
    }
    return entry;
  }

  function fallbackFetcherFor(key) {
    if (typeof defaultFetcher !== "function" || !String(key).startsWith("/")) return null;
    return () => defaultFetcher(key);
  }

  function resolveStaleTime(entry, options = {}) {
    return options.staleTimeMs ?? entry?.staleTimeMs ?? staleTimeMs;
  }

  function isEntryStale(entry, options = {}) {
    if (!entry || entry.status === "idle") return true;
    if (entry.stale) return true;
    if (entry.status !== "success") return true;
    const entryStaleTimeMs = resolveStaleTime(entry, options);
    if (entryStaleTimeMs === Infinity) return false;
    if (!Number.isFinite(Number(entryStaleTimeMs))) return false;
    if (Number(entryStaleTimeMs) <= 0) return true;
    return now() - entry.updatedAt > Number(entryStaleTimeMs);
  }

  function resolveTargetKeys(target, { includeMissing = false } = {}) {
    if (target === undefined || target === null) return Array.from(entries.keys());
    if (Array.isArray(target)) {
      return Array.from(new Set(target.flatMap((item) => resolveTargetKeys(item, { includeMissing }))));
    }
    if (typeof target === "string") {
      const key = normalizeCacheKey(target);
      return includeMissing || entries.has(key) ? [key] : [];
    }
    return Array.from(entries.entries())
      .filter(([key, entry]) => keyMatchesTarget(target, key, entry))
      .map(([key]) => key);
  }

  function setFetcher(key, fetcher, options = {}) {
    if (typeof fetcher !== "function") return null;
    const entry = ensureEntry(key);
    entry.fetcher = fetcher;
    if (options.staleTimeMs !== undefined) entry.staleTimeMs = options.staleTimeMs;
    return publicEntry(entry);
  }

  function get(key, fetcher, options = {}) {
    const entry = ensureEntry(key);
    const nextFetcher = typeof fetcher === "function" ? fetcher : entry.fetcher || fallbackFetcherFor(entry.key);

    if (typeof fetcher === "function") {
      entry.fetcher = fetcher;
      if (options.staleTimeMs !== undefined) entry.staleTimeMs = options.staleTimeMs;
    }

    if (entry.promise && options.dedupe !== false) return entry.promise;
    if (!options.force && entry.status === "success" && !isEntryStale(entry, options)) {
      return Promise.resolve(entry.data);
    }

    if (typeof nextFetcher !== "function") {
      entry.stale = true;
      notify();
      return Promise.resolve(entry.data);
    }

    const startedAt = now();
    const promise = Promise.resolve()
      .then(() => nextFetcher({ entry: publicEntry(entry), key: entry.key }))
      .then((data) => {
        const latestEntry = entries.get(entry.key);
        if (latestEntry?.promise !== promise) return data;
        latestEntry.data = data;
        latestEntry.error = null;
        latestEntry.promise = null;
        latestEntry.stale = false;
        latestEntry.startedAt = startedAt;
        latestEntry.status = "success";
        latestEntry.updatedAt = now();
        notify();
        return data;
      })
      .catch((error) => {
        const latestEntry = entries.get(entry.key);
        if (latestEntry?.promise === promise) {
          latestEntry.error = error;
          latestEntry.promise = null;
          latestEntry.stale = true;
          latestEntry.startedAt = startedAt;
          latestEntry.status = latestEntry.updatedAt ? "success" : "error";
          notify();
        }
        throw error;
      });

    entry.error = null;
    entry.promise = promise;
    entry.startedAt = startedAt;
    entry.status = entry.updatedAt ? entry.status : "loading";
    notify();
    return promise;
  }

  function refresh(target, options = {}) {
    const keys = resolveTargetKeys(target);
    const tasks = keys.map((key) => {
      const entry = ensureEntry(key);
      return get(key, options.fetcher || entry.fetcher, {
        ...options,
        force: true
      });
    });
    return Promise.all(tasks);
  }

  function invalidate(target, options = {}) {
    const keys = resolveTargetKeys(target);
    let changed = false;
    for (const key of keys) {
      const entry = ensureEntry(key);
      if (!entry.stale) changed = true;
      entry.stale = true;
    }
    if (changed) notify();
    if (options.refresh) {
      return refresh(keys, options.refreshOptions || {});
    }
    return keys;
  }

  function patch(target, updater, options = {}) {
    const keys = resolveTargetKeys(target, { includeMissing: typeof target === "string" });
    for (const key of keys) {
      const entry = ensureEntry(key);
      const nextValue = typeof updater === "function" ? updater(entry.data, publicEntry(entry)) : updater;
      entry.data = options.merge && isPlainObject(entry.data) && isPlainObject(nextValue)
        ? { ...entry.data, ...nextValue }
        : nextValue;
      entry.error = null;
      entry.stale = Boolean(options.stale);
      entry.status = "success";
      entry.updatedAt = now();
    }
    if (keys.length) notify();
    return keys;
  }

  function setCache(key, data, options = {}) {
    const entry = ensureEntry(normalizeCacheKey(key));
    entry.data = data;
    entry.error = null;
    entry.promise = null;
    entry.stale = Boolean(options.stale);
    entry.status = "success";
    entry.updatedAt = now();
    if (options.staleTimeMs !== undefined || options.staleTime !== undefined) {
      entry.staleTimeMs = options.staleTimeMs ?? options.staleTime;
    }
    notify();
    return publicEntry(entry);
  }

  function markStale(target, options = {}) {
    const normalizedTarget = Array.isArray(target) ? cacheNamespace(...target) : target;
    return invalidate(normalizedTarget, options);
  }

  function remove(target) {
    const keys = resolveTargetKeys(target);
    for (const key of keys) entries.delete(key);
    if (keys.length) notify();
    return keys;
  }

  function clear() {
    if (!entries.size) return;
    entries.clear();
    notify();
  }

  return {
    clear,
    delete: remove,
    get,
    getEntry: (key) => {
      const cacheKey = normalizeCacheKey(key);
      return publicEntry(entries.get(cacheKey));
    },
    getSnapshot: () => version,
    invalidate,
    isStale: (key, options = {}) => {
      const cacheKey = normalizeCacheKey(key);
      return isEntryStale(entries.get(cacheKey), options);
    },
    keys: () => Array.from(entries.keys()),
    markStale,
    patch,
    refresh,
    setCache,
    setDefaultStaleTimeMs: (nextStaleTimeMs) => {
      if (staleTimeMs === nextStaleTimeMs) return;
      staleTimeMs = nextStaleTimeMs;
      notify();
    },
    setFetcher,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function ApiCacheProvider({ children, client, defaultStaleTimeMs = DEFAULT_API_CACHE_STALE_TIME_MS }) {
  const clientRef = useRef(null);
  if (!clientRef.current) {
    clientRef.current = createApiCacheClient({ defaultStaleTimeMs });
  }

  useEffect(() => {
    clientRef.current.setDefaultStaleTimeMs(defaultStaleTimeMs);
  }, [defaultStaleTimeMs]);

  return (
    <ApiCacheContext.Provider value={client || clientRef.current}>
      {children}
    </ApiCacheContext.Provider>
  );
}

export function useApiCacheClient() {
  const client = useContext(ApiCacheContext);
  if (!client) throw new Error("useApiCacheClient must be used inside ApiCacheProvider.");
  return client;
}

function useCachedApiConfig(request, fetcherOrOptions, optionsArg) {
  return useMemo(() => {
    if (isPlainObject(request) && hasOwn(request, "path")) {
      const options = request;
      const key = makeApiCacheKey(options.path, options);
      const requestOptions = options.requestOptions || {};
      const fetcher = options.fetcher || (() => api(options.path, requestOptions));
      const staleTimeMs = options.staleTimeMs ?? options.staleTime;
      return { ...options, enabled: options.enabled !== false, fetcher, key, staleTimeMs };
    }

    if (typeof fetcherOrOptions === "function") {
      const options = optionsArg || {};
      const staleTimeMs = options.staleTimeMs ?? options.staleTime;
      return {
        ...options,
        enabled: options.enabled !== false,
        fetcher: fetcherOrOptions,
        key: normalizeCacheKey(options.key || request),
        staleTimeMs
      };
    }

    const options = fetcherOrOptions || {};
    const key = makeApiCacheKey(request, options);
    const requestOptions = options.requestOptions || {};
    const fetcher = options.fetcher || (() => api(request, requestOptions));
    const staleTimeMs = options.staleTimeMs ?? options.staleTime;
    return { ...options, enabled: options.enabled !== false, fetcher, key, staleTimeMs };
  }, [fetcherOrOptions, optionsArg, request]);
}

export function useCachedApi(request, fetcherOrOptions, optionsArg) {
  const client = useApiCacheClient();
  const config = useCachedApiConfig(request, fetcherOrOptions, optionsArg);
  const fetcherRef = useRef(config.fetcher);

  useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);

  useEffect(() => {
    fetcherRef.current = config.fetcher;
  }, [config.fetcher]);

  const fetcher = useCallback((context) => fetcherRef.current(context), []);

  useEffect(() => {
    if (!config.key) return undefined;
    client.setFetcher(config.key, fetcher, { staleTimeMs: config.staleTimeMs });
    return undefined;
  }, [client, config.key, config.staleTimeMs, fetcher]);

  useEffect(() => {
    if (!config.enabled || !config.key) return undefined;
    client.get(config.key, fetcher, { staleTimeMs: config.staleTimeMs }).catch(() => {});
    return undefined;
  }, [client, config.enabled, config.key, config.staleTimeMs, fetcher]);

  const entry = config.key ? client.getEntry(config.key) : null;
  const hasData = entry?.status === "success" || Boolean(entry?.updatedAt);
  const data = hasData ? entry.data : config.initialData;
  const status = entry?.status || "idle";
  const loading = Boolean(config.enabled && (!entry || status === "idle" || status === "loading"));
  const refreshing = Boolean(entry?.promise && !loading);
  const stale = config.key ? client.isStale(config.key, { staleTimeMs: config.staleTimeMs }) : false;

  const refresh = useCallback(async (options = {}) => {
    const results = await client.refresh(config.key, {
      ...options,
      fetcher,
      staleTimeMs: options.staleTimeMs ?? options.staleTime ?? config.staleTimeMs
    });
    return Array.isArray(results) && results.length === 1 ? results[0] : results;
  }, [client, config.key, config.staleTimeMs, fetcher]);

  useEffect(() => {
    if (!config.enabled || !config.key || config.refetchOnStale === false || !stale) return undefined;
    client.get(config.key, fetcher, { staleTimeMs: config.staleTimeMs }).catch(() => {});
    return undefined;
  }, [client, config.enabled, config.key, config.refetchOnStale, config.staleTimeMs, fetcher, stale]);

  const invalidate = useCallback((options = {}) => client.invalidate(config.key, options), [client, config.key]);

  const patch = useCallback((updater, options = {}) => client.patch(config.key, updater, options), [client, config.key]);

  return {
    data,
    error: entry?.error || null,
    hasData,
    invalidate,
    key: config.key,
    loading,
    patch,
    refresh,
    refreshing,
    stale,
    status,
    updatedAt: entry?.updatedAt || 0
  };
}

function parseEventData(data) {
  const text = String(data ?? "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function eventNamesFromRules(rules, extraEvents = []) {
  const configuredEvents = Array.isArray(extraEvents) ? extraEvents : [extraEvents].filter(Boolean);
  const names = new Set(["message", ...configuredEvents]);
  if (Array.isArray(rules)) {
    for (const rule of rules) {
      const events = Array.isArray(rule?.events) ? rule.events : [rule?.event].filter(Boolean);
      for (const eventName of events) names.add(eventName);
    }
    return Array.from(names);
  }
  if (isPlainObject(rules)) {
    for (const eventName of Object.keys(rules)) {
      if (eventName !== "*") names.add(eventName);
    }
  }
  return Array.from(names);
}

function eventRulesFor(rules, envelope) {
  if (!rules) return [];
  if (typeof rules === "function") return [rules];
  if (Array.isArray(rules)) {
    return rules.filter((rule) => {
      const names = Array.isArray(rule?.events) ? rule.events : [rule?.event || "message"];
      return names.includes(envelope.type) || names.includes(envelope.domEventType) || names.includes("*");
    });
  }
  if (!isPlainObject(rules)) return [];

  const nextRules = [];
  for (const name of [envelope.type, envelope.domEventType, "*"]) {
    if (name && hasOwn(rules, name) && !nextRules.includes(rules[name])) {
      nextRules.push(rules[name]);
    }
  }
  return nextRules;
}

function resolveEventValue(value, envelope, client) {
  return typeof value === "function" ? value(envelope, client) : value;
}

function applyPatchAction(client, patchAction, envelope) {
  const patchItems = Array.isArray(patchAction) ? patchAction : [patchAction];
  for (const item of patchItems) {
    const patch = resolveEventValue(item, envelope, client);
    if (!patch) continue;
    const target = resolveEventValue(patch.target ?? patch.key ?? patch.keys, envelope, client);
    const updater = patch.updater ?? patch.update ?? patch.value;
    if (!target || updater === undefined) continue;
    client.patch(
      target,
      typeof updater === "function" ? (data, entry) => updater(data, entry, envelope) : updater,
      patch.options || {}
    );
  }
}

function applyApiCacheAction(client, action, envelope) {
  const resolvedAction = resolveEventValue(action, envelope, client);
  const tasks = [];
  if (!resolvedAction) return tasks;

  if (Array.isArray(resolvedAction)) {
    for (const item of resolvedAction) {
      tasks.push(...applyApiCacheAction(client, item, envelope));
    }
    return tasks;
  }

  if (isTargetDescriptor(resolvedAction) && !hasActionFields(resolvedAction)) {
    client.invalidate(resolvedAction);
    return tasks;
  }

  if (resolvedAction.keys || resolvedAction.target) {
    client.invalidate(resolveEventValue(resolvedAction.keys || resolvedAction.target, envelope, client), resolvedAction.invalidateOptions || {});
  }

  if (resolvedAction.invalidate) {
    client.invalidate(resolveEventValue(resolvedAction.invalidate, envelope, client), resolvedAction.invalidateOptions || {});
  }

  if (resolvedAction.patch) {
    applyPatchAction(client, resolvedAction.patch, envelope);
  }

  if (resolvedAction.refresh) {
    tasks.push(client.refresh(resolveEventValue(resolvedAction.refresh, envelope, client), {
      ...(resolvedAction.refreshOptions || {}),
      force: true
    }));
  }

  return tasks;
}

export function applyApiCacheEvent(client, rules, envelope) {
  const tasks = eventRulesFor(rules, envelope).flatMap((rule) => applyApiCacheAction(client, rule, envelope));
  return Promise.allSettled(tasks);
}

export function useApiCacheEventSource(url, rules = DEFAULT_API_CACHE_EVENT_RULES, options = {}) {
  const client = useApiCacheClient();
  const rulesRef = useRef(rules);
  const optionsRef = useRef(options);
  const [state, setState] = useState({
    connected: false,
    error: null,
    lastEvent: null,
    readyState: "idle"
  });

  useEffect(() => {
    rulesRef.current = rules;
  }, [rules]);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const eventNames = useMemo(() => eventNamesFromRules(rules, options.events), [options.events, rules]);
  const eventNamesKey = eventNames.join("\n");
  const enabled = options.enabled !== false;
  const withCredentials = Boolean(options.withCredentials);

  useEffect(() => {
    if (!enabled || !url || typeof window === "undefined" || typeof window.EventSource !== "function") {
      setState((current) => ({ ...current, connected: false, readyState: "idle" }));
      return undefined;
    }

    const source = new window.EventSource(url, { withCredentials });
    const names = eventNamesKey.split("\n").filter(Boolean);
    let active = true;

    const handleOpen = (event) => {
      if (!active) return;
      setState((current) => ({ ...current, connected: true, error: null, readyState: "open" }));
      optionsRef.current.onOpen?.(event);
    };

    const handleError = (event) => {
      if (!active) return;
      setState((current) => ({ ...current, connected: false, error: event, readyState: "error" }));
      optionsRef.current.onError?.(event);
    };

    const handleEvent = (event) => {
      if (!active) return;
      const data = parseEventData(event.data);
      const type = isPlainObject(data) ? data.type || data.event || event.type : event.type;
      const envelope = {
        data,
        domEventType: event.type,
        id: event.lastEventId || "",
        rawEvent: event,
        type
      };
      setState((current) => ({ ...current, error: null, lastEvent: envelope }));
      optionsRef.current.onEvent?.(envelope);
      applyApiCacheEvent(client, rulesRef.current, envelope).then((results) => {
        if (!active) return;
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected) {
          setState((current) => ({ ...current, error: rejected.reason }));
          optionsRef.current.onActionError?.(rejected.reason, envelope);
        }
      });
    };

    source.addEventListener("open", handleOpen);
    source.addEventListener("error", handleError);
    for (const eventName of names) source.addEventListener(eventName, handleEvent);

    setState((current) => ({ ...current, connected: false, error: null, readyState: "connecting" }));

    return () => {
      active = false;
      source.removeEventListener("open", handleOpen);
      source.removeEventListener("error", handleError);
      for (const eventName of names) source.removeEventListener(eventName, handleEvent);
      source.close();
    };
  }, [client, enabled, eventNamesKey, url, withCredentials]);

  return state;
}

export function ApiCacheEventBridge({ url, rules = DEFAULT_API_CACHE_EVENT_RULES, ...options }) {
  useApiCacheEventSource(url, rules, options);
  return null;
}
