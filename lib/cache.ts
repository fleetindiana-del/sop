import { dropCachedValues } from "@/lib/clientCache";

/* Client-safe dashboard cache helpers and keys.
 * Server-side grouped-registry caching lives in @/lib/server-cache. */

export const DASHBOARD_CACHE_KEY = "sop-dashboard-cache-v5";
export const DASHBOARD_STATS_CACHE_KEY = "sop-dashboard-stats-v11";

export function clearClientDashboardCache() {
  if (typeof window === "undefined") return;
  sessionStorage.removeItem(DASHBOARD_CACHE_KEY);
  sessionStorage.removeItem(DASHBOARD_STATS_CACHE_KEY);
  localStorage.removeItem(DASHBOARD_CACHE_KEY);
  localStorage.removeItem(DASHBOARD_STATS_CACHE_KEY);
}

export function readClientCache<T>(key: string, field: string): T | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, T>;
    return obj?.[field] ?? null;
  } catch {
    return null;
  }
}

export function writeClientCache(key: string, field: string, value: unknown) {
  if (typeof window === "undefined") return;
  try {
    const raw = sessionStorage.getItem(key);
    const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    obj[field] = value;
    sessionStorage.setItem(key, JSON.stringify(obj));
  } catch {
    /* storage full or unavailable — caching is best-effort */
  }
}

/** Clear browser-side dashboard caches (safe to call from client components). */
export function bustDashboardCache() {
  clearClientDashboardCache();
  // The MCQ Bank and Compliance first-paint copies (lib/clientCache) are built
  // from the same SOP registry, so a change here must drop them too — otherwise
  // the next visit paints the pre-edit registry before its refetch lands.
  dropCachedValues("mcq-bank:");
  dropCachedValues("compliance:");
}
