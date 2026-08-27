/* ─── LMS portal caching ─────────────────────────────────────────────────
 * Server: short-lived in-memory TTL cache for expensive DB reads.
 * Client: sessionStorage stale-while-revalidate so pages paint instantly.
 */

// ─── Client cache keys ──────────────────────────────────────────────────────

export const LMS_CACHE_KEY = 'lms-portal-cache-v8';
/** Skip network when client cache is younger than this. */
export const LMS_CLIENT_FRESH_MS = 60_000;

// ─── Server TTLs ────────────────────────────────────────────────────────────

const SERVER_TTL_MS = {
  journeyContent: 5 * 60_000,
  userProgress: 30_000,
  userDashboard: 60_000,
  adminTrainingStatus: 2 * 60_000,
  adminEmployeeTraining: 2 * 60_000,
  adminTrainerOverview: 2 * 60_000,
  adminMeta: 5 * 60_000,
  adminExamSettings: 2 * 60_000,
  adminSopExamSettings: 2 * 60_000,
  certificate: 5 * 60_000,
} as const;

// ─── Server in-memory store ─────────────────────────────────────────────────

interface ServerEntry<T = unknown> {
  value: T;
  expiresAt: number;
}

type ServerStore = {
  entries: Map<string, ServerEntry>;
  inFlight: Map<string, Promise<unknown>>;
};

function getServerStore(): ServerStore {
  const g = globalThis as { __lmsServerCache?: ServerStore };
  if (!g.__lmsServerCache) {
    g.__lmsServerCache = { entries: new Map(), inFlight: new Map() };
  }
  return g.__lmsServerCache;
}

function serverGet<T>(key: string): T | null {
  const entry = getServerStore().entries.get(key);
  if (!entry || entry.expiresAt < Date.now()) {
    if (entry) getServerStore().entries.delete(key);
    return null;
  }
  return entry.value as T;
}

function serverSet<T>(key: string, value: T, ttlMs: number) {
  getServerStore().entries.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export function invalidateLmsServerKeys(...keys: string[]) {
  const store = getServerStore();
  for (const key of keys) {
    store.entries.delete(key);
    store.inFlight.delete(key);
  }
}

export function invalidateLmsServerPrefix(prefix: string) {
  const store = getServerStore();
  for (const key of store.entries.keys()) {
    if (key.startsWith(prefix)) store.entries.delete(key);
  }
  for (const key of store.inFlight.keys()) {
    if (key.startsWith(prefix)) store.inFlight.delete(key);
  }
}

/** Invalidate all learner-scoped caches after progress or certificate changes. */
export function invalidateLmsLearnerCache(employeeId: string, sopCode?: string) {
  invalidateLmsServerKeys(
    `lms:me:${employeeId}`,
    `lms:progress:${employeeId}`,
    `lms:certificates:${employeeId}`,
    `lms:dashboard:${employeeId}`,
    `lms:assets:${employeeId}`,
  );
  if (sopCode) {
    invalidateLmsServerKeys(
      `lms:journey:${employeeId}:${sopCode}`,
      `lms:progress:${employeeId}:${sopCode}`,
      `lms:certificate:${employeeId}:${sopCode}`,
    );
  } else {
    invalidateLmsServerPrefix(`lms:journey:${employeeId}:`);
    invalidateLmsServerPrefix(`lms:progress:${employeeId}:`);
    invalidateLmsServerPrefix(`lms:certificate:${employeeId}:`);
  }
}

export function invalidateLmsAdminCaches() {
  invalidateLmsServerPrefix('lms:admin:');
}

export function peekLmsServerCache<T>(key: string): T | null {
  return serverGet<T>(key);
}

export function primeLmsServerCache<T>(key: string, value: T, ttlMs: number) {
  serverSet(key, value, ttlMs);
}

/**
 * Returns a cached value or builds it via `build`. Concurrent misses share one
 * in-flight promise so parallel page loads don't hammer the database.
 */
export async function getOrBuildLmsCache<T>(
  key: string,
  ttlMs: number,
  build: () => Promise<T>,
): Promise<T> {
  const cached = serverGet<T>(key);
  if (cached !== null) return cached;

  const store = getServerStore();
  const existing = store.inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = (async () => {
    try {
      const value = await build();
      serverSet(key, value, ttlMs);
      return value;
    } finally {
      store.inFlight.delete(key);
    }
  })();

  store.inFlight.set(key, promise);
  return promise;
}

// ─── Server cache key builders ──────────────────────────────────────────────

export const lmsServerKeys = {
  me: (employeeId: string) => `lms:me:${employeeId}`,
  assets: (employeeId: string) => `lms:assets:${employeeId}`,
  progress: (employeeId: string) => `lms:progress:${employeeId}`,
  progressSop: (employeeId: string, sopCode: string) => `lms:progress:${employeeId}:${sopCode}`,
  certificates: (employeeId: string) => `lms:certificates:${employeeId}`,
  certificate: (employeeId: string, sopCode: string) => `lms:certificate:${employeeId}:${sopCode}`,
  journey: (employeeId: string, sopCode: string) => `lms:journey:${employeeId}:${sopCode}`,
  journeyContent: (sopCode: string) => `lms:journey-content:v2:${sopCode.toUpperCase()}`,
  adminTrainingStatus: (department: string) => `lms:admin:training-status:v2:${department || 'all'}`,
  adminEmployeeTraining: (department: string) => `lms:admin:employee-training:v4:${department || 'all'}`,
  adminTrainerOverview: (year: number | 'all', includeIgnored: boolean) =>
    `lms:admin:trainer-overview:v1:${year}:${includeIgnored ? 'inc' : 'exc'}`,
  trainerDashboard: (employeeId: string) => `lms:trainer:dashboard:v6:${employeeId}`,
  adminMeta: () => 'lms:admin:meta:v2',
  adminMetaForSop: (sopCode: string) => `lms:admin:meta:sop:v2:${sopCode.toUpperCase()}`,
  adminExamSettings: () => 'lms:admin:exam-settings',
  adminSopExamSettings: () => 'lms:admin:sop-exam-settings:v3',
} as const;

export const lmsServerTtl = SERVER_TTL_MS;

// ─── HTTP response helpers ──────────────────────────────────────────────────

export function lmsCacheControl(maxAgeSec: number) {
  return { 'Cache-Control': `private, max-age=${maxAgeSec}` };
}

// ─── Client-side cache (sessionStorage) ─────────────────────────────────────

export function clearLmsClientCache() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(LMS_CACHE_KEY);
}

export function readLmsClientCache<T>(field: string): { value: T; cachedAt: number } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(LMS_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as Record<string, { value: T; cachedAt: number }>;
    const entry = obj?.[field];
    if (!entry || entry.value === undefined) return null;
    return entry;
  } catch {
    return null;
  }
}

export function writeLmsClientCache(field: string, value: unknown) {
  if (typeof window === 'undefined') return;
  try {
    const raw = sessionStorage.getItem(LMS_CACHE_KEY);
    const obj = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    obj[field] = { value, cachedAt: Date.now() };
    sessionStorage.setItem(LMS_CACHE_KEY, JSON.stringify(obj));
  } catch {
    /* best-effort */
  }
}

export function invalidateLmsClientFields(...fields: string[]) {
  if (typeof window === 'undefined') return;
  try {
    const raw = sessionStorage.getItem(LMS_CACHE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, unknown>;
    for (const field of fields) delete obj[field];
    sessionStorage.setItem(LMS_CACHE_KEY, JSON.stringify(obj));
  } catch {
    /* best-effort */
  }
}

/** Client cache field names used by LMS pages. */
export const lmsClientFields = {
  employee: 'employee',
  /** Learner dashboard — always scoped to employee so progress never leaks across logins. */
  dashboard: (employeeId: string) => `dashboard:${String(employeeId || '').trim()}`,
  /** Journey payload — scoped to employee + SOP. */
  journey: (employeeId: string, sopCode: string) =>
    `journey:${String(employeeId || '').trim()}:${String(sopCode || '').toUpperCase()}`,
  /** Certificate payload — scoped to employee + SOP. */
  certificate: (employeeId: string, sopCode: string) =>
    `certificate:${String(employeeId || '').trim()}:${String(sopCode || '').toUpperCase()}`,
  adminTrainingStatus: (dept: string) => `admin:training-status:${dept || 'all'}`,
  adminEmployeeTraining: (dept: string) => `admin:employee-training:v2:${dept || 'all'}`,
  adminTrainerOverview: (year: number | 'all', includeIgnored: boolean) =>
    `admin:trainer-overview:v1:${year}:${includeIgnored ? 'inc' : 'exc'}`,
  adminMeta: 'admin:meta:v2',
  adminMetaForSop: (sopCode: string) => `admin:meta:sop:v2:${sopCode.toUpperCase()}`,
  adminExamSettings: 'admin:exam-settings',
  adminSopExamSettings: 'admin:sop-exam-settings:v3',
} as const;

/** Current LMS learner id from session cache (set on login / session restore). */
export function getCachedLmsEmployeeId(): string {
  const cached = readLmsClientCache<{ employee?: { id?: string; _id?: string } }>(
    lmsClientFields.employee,
  );
  const emp = cached?.value?.employee;
  return String(emp?.id || emp?._id || '').trim();
}

/**
 * Stale-while-revalidate fetch for LMS pages.
 * Returns cached data immediately when available; always revalidates in background
 * unless the cache is still fresh and force is false.
 */
export async function fetchLmsWithCache<T>(
  url: string,
  field: string,
  opts?: { force?: boolean; init?: RequestInit; freshMs?: number },
): Promise<{ data: T; fromCache: boolean }> {
  const freshMs = opts?.freshMs ?? LMS_CLIENT_FRESH_MS;
  const cached = !opts?.force ? readLmsClientCache<T>(field) : null;

  if (cached && Date.now() - cached.cachedAt <= freshMs) {
    return { data: cached.value, fromCache: true };
  }

  const res = await fetch(url, opts?.init);
  const data = (await res.json()) as T;
  writeLmsClientCache(field, data);
  return { data, fromCache: false };
}
