import { useEffect } from "react";

import { useApiCacheClient } from "./apiCache.jsx";
import { SERVER_EVENTS, applyServerEvent, markGlobalStale } from "./serverEventRules.js";

export { SERVER_EVENTS, applyServerEvent };

function notificationChannels(notification) {
  if (!notification || typeof notification !== "object") return [];
  if (Array.isArray(notification.channels)) return notification.channels.map((channel) => String(channel).toLowerCase());
  if (notification.channels) return [String(notification.channels).toLowerCase()];
  return [];
}

function eventNotification(event, data) {
  const candidates = [event?.notification, data?.notification];
  return candidates.find((candidate) => candidate && typeof candidate === "object") || null;
}

function notificationToastType(notification) {
  const severity = String(notification?.severity || "").toLowerCase();
  if (severity === "bad" || severity === "error") return "error";
  if (severity === "warn" || severity === "warning") return "warning";
  if (severity === "ok" || severity === "success") return "success";
  return "info";
}

function notifyToastNotification(notify, notification) {
  if (!notificationChannels(notification).includes("toast")) return null;

  const title = typeof notification?.title === "string" ? notification.title.trim() : "";
  const detail = typeof notification?.detail === "string" ? notification.detail.trim() : "";
  const message = title && detail ? `${title}: ${detail}` : title || detail;

  if (!message) return null;
  return notify(message, { type: notificationToastType(notification) });
}

export function useServerEvents({ enabled = true, notify = () => {}, notifyNotification = null } = {}) {
  const cache = useApiCacheClient();

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.EventSource !== "function") return undefined;

    const source = new window.EventSource("/api/events");
    let opened = false;
    let needsResync = false;
    const handleOpen = () => {
      if (opened || needsResync) markGlobalStale(cache);
      opened = true;
      needsResync = false;
    };
    const handleMessage = (message) => {
      let event = null;
      try {
        event = JSON.parse(message.data || "{}");
      } catch {
        return;
      }
      applyServerEvent(cache, event);
      const data = event?.data && typeof event.data === "object" ? event.data : event;
      const notification = eventNotification(event, data);
      if (typeof notifyNotification === "function") notifyNotification(notification);
      else notifyToastNotification(notify, notification);
    };
    const eventTypes = Object.values(SERVER_EVENTS);

    for (const eventType of eventTypes) {
      source.addEventListener(eventType, handleMessage);
    }
    source.addEventListener("open", handleOpen);
    source.onmessage = handleMessage;
    source.onerror = () => {
      needsResync = true;
      markGlobalStale(cache);
    };

    return () => {
      for (const eventType of eventTypes) {
        source.removeEventListener(eventType, handleMessage);
      }
      source.removeEventListener("open", handleOpen);
      source.close();
    };
  }, [cache, enabled, notify, notifyNotification]);
}
