'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import {
  ArrowLeft,
  Building2,
  Check,
  KeyRound,
  LayoutGrid,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Users,
  X,
} from 'lucide-react';

type AppRole = 'admin' | 'trainer' | 'viewer';

interface AppPage {
  key: string;
  label: string;
  prefix: string;
  group: string;
  description: string;
  adminOnly?: boolean;
  alwaysAllowed?: boolean;
  restrictedByDefault?: boolean;
}

interface AccessUser {
  id: string;
  username: string;
  name: string;
  email: string;
  role: AppRole;
  designation: string;
  departments: string[];
  /** null = never configured; role defaults apply. */
  pageAccess: string[] | null;
  effectivePages: string[];
  updatedAt?: string;
}

const ROLE_STYLE: Record<AppRole, string> = {
  admin: 'bg-violet-100 text-violet-800 border-violet-200',
  trainer: 'bg-sky-100 text-sky-800 border-sky-200',
  viewer: 'bg-slate-100 text-slate-700 border-slate-200',
};

function sameSet(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export default function AccessManagementPage() {
  useAuthGuard({ allowedRoles: ['admin'] });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [users, setUsers] = useState<AccessUser[]>([]);
  const [pages, setPages] = useState<AppPage[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | AppRole>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Draft state for the selected user, re-synced whenever that user changes.
  const [draftPages, setDraftPages] = useState<string[]>([]);
  const [draftDepts, setDraftDepts] = useState<string[]>([]);
  const [usingDefaults, setUsingDefaults] = useState(true);
  const [draftKey, setDraftKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/access');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load access data');
      setUsers(data.users || []);
      setPages(data.pages || []);
      setDepartments(data.departments || []);
      setSelectedId((prev) => prev ?? data.users?.[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load access data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => users.find((u) => u.id === selectedId) ?? null,
    [users, selectedId],
  );

  // Adjust the draft during render when the selected user (or its saved state)
  // changes — see "You Might Not Need an Effect".
  const selectedKey = selected ? `${selected.id}:${selected.updatedAt ?? ''}` : null;
  if (selected && selectedKey !== draftKey) {
    setDraftKey(selectedKey);
    setDraftPages(selected.pageAccess ?? selected.effectivePages);
    setDraftDepts(selected.departments);
    setUsingDefaults(selected.pageAccess === null);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (!q) return true;
      return (
        u.username.includes(q) ||
        u.name.toLowerCase().includes(q) ||
        u.departments.join(' ').toLowerCase().includes(q)
      );
    });
  }, [users, search, roleFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, AppPage[]>();
    for (const page of pages) {
      const list = map.get(page.group) ?? [];
      list.push(page);
      map.set(page.group, list);
    }
    return [...map.entries()];
  }, [pages]);

  const isAdminUser = selected?.role === 'admin';

  const dirty = useMemo(() => {
    if (!selected) return false;
    if (!sameSet(draftDepts, selected.departments)) return true;
    if (usingDefaults) return selected.pageAccess !== null;
    if (selected.pageAccess === null) return true;
    return !sameSet(draftPages, selected.pageAccess);
  }, [selected, draftPages, draftDepts, usingDefaults]);

  const togglePage = (page: AppPage) => {
    if (page.alwaysAllowed || (page.adminOnly && !isAdminUser)) return;
    setUsingDefaults(false);
    setDraftPages((prev) =>
      prev.includes(page.key) ? prev.filter((k) => k !== page.key) : [...prev, page.key],
    );
  };

  const toggleDept = (dept: string) => {
    setDraftDepts((prev) =>
      prev.includes(dept) ? prev.filter((d) => d !== dept) : [...prev, dept],
    );
  };

  const setAllPages = (on: boolean) => {
    setUsingDefaults(false);
    setDraftPages(
      on
        ? pages
            .filter((p) => !p.alwaysAllowed && (!p.adminOnly || isAdminUser))
            .map((p) => p.key)
        : [],
    );
  };

  const resetToDefaults = () => {
    if (!selected) return;
    setUsingDefaults(true);
    setDraftPages(selected.effectivePages);
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      const res = await fetch('/api/admin/access', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: selected.id,
          pageAccess: usingDefaults ? null : draftPages,
          departments: draftDepts,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setUsers((prev) => prev.map((u) => (u.id === selected.id ? data.user : u)));
      setMessage(`Access updated for ${selected.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const grantedCount = (user: AccessUser) =>
    user.role === 'admin'
      ? pages.length
      : user.effectivePages.filter((k) => !pages.find((p) => p.key === k)?.alwaysAllowed).length;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
            </Link>
            <div className="h-5 w-px bg-slate-200" />
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-violet-600" />
              <div>
                <h1 className="text-sm font-bold tracking-tight">Access Management</h1>
                <p className="text-[11px] text-slate-500">
                  Control which pages and departments each user can reach
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin/users"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <KeyRound className="h-3.5 w-3.5" /> Logins &amp; Passwords
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-5">
        {(error || message) && (
          <div
            className={`mb-4 flex items-start justify-between rounded-lg px-3 py-2 text-sm ${
              error ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
            }`}
          >
            <span>{error || message}</span>
            <button
              type="button"
              onClick={() => {
                setError('');
                setMessage('');
              }}
              className="ml-3 rounded p-0.5 hover:bg-black/5"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* Users */}
          <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-3 py-2.5">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-600">
                <Users className="h-3.5 w-3.5" />
                {users.length} user{users.length === 1 ? '' : 's'}
              </div>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search username, name, department…"
                className="w-full rounded-lg border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
              />
              <div className="mt-2 flex gap-1">
                {(['all', 'admin', 'trainer', 'viewer'] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setRoleFilter(r)}
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold capitalize ${
                      roleFilter === r
                        ? 'border-violet-300 bg-violet-100 text-violet-800'
                        : 'border-slate-200 text-slate-500 hover:bg-slate-50'
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>

            <div className="max-h-[calc(100vh-260px)] overflow-y-auto">
              {loading ? (
                <div className="px-4 py-10 text-center text-sm text-slate-500">
                  <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                  Loading users…
                </div>
              ) : filtered.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-slate-500">No users found.</div>
              ) : (
                filtered.map((user) => (
                  <button
                    key={user.id}
                    type="button"
                    onClick={() => setSelectedId(user.id)}
                    className={`flex w-full flex-col gap-1 border-b border-slate-100 px-3 py-2.5 text-left last:border-0 ${
                      user.id === selectedId ? 'bg-violet-50' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-slate-900">
                        {user.name}
                      </span>
                      <span
                        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold capitalize ${ROLE_STYLE[user.role]}`}
                      >
                        {user.role}
                      </span>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500">
                      {user.username}
                      {user.id === currentUserId ? ' (you)' : ''}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {user.role === 'admin'
                        ? 'All pages · all departments'
                        : `${grantedCount(user)} page${grantedCount(user) === 1 ? '' : 's'} · ${
                            user.departments.length
                              ? user.departments.join(', ')
                              : 'no department'
                          }`}
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* Permissions */}
          <section className="rounded-xl border border-slate-200 bg-white shadow-sm">
            {!selected ? (
              <div className="px-4 py-16 text-center text-sm text-slate-500">
                Select a user to manage their access.
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">{selected.name}</h2>
                    <p className="font-mono text-[11px] text-slate-500">
                      {selected.username} · {selected.role}
                      {selected.designation ? ` · ${selected.designation}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {!isAdminUser && (
                      <button
                        type="button"
                        onClick={resetToDefaults}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                        title="Clear the custom allowlist and fall back to role defaults"
                      >
                        <RotateCcw className="h-3 w-3" /> Role defaults
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void save()}
                      disabled={saving || !dirty}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
                    >
                      {saving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      Save changes
                    </button>
                  </div>
                </div>

                {isAdminUser && (
                  <div className="mx-4 mt-4 flex items-start gap-2 rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-800">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      Admins always have every page and every department. Change the role on the{' '}
                      <Link href="/admin/users" className="underline">
                        Logins &amp; Passwords
                      </Link>{' '}
                      page to restrict this user.
                    </span>
                  </div>
                )}

                {!isAdminUser && usingDefaults && (
                  <div className="mx-4 mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    No custom page access set — this user currently gets the default set for their
                    role. Toggle any page below to switch to an explicit allowlist.
                  </div>
                )}

                {/* Page access */}
                <div className="px-4 py-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
                      <LayoutGrid className="h-3.5 w-3.5" /> Page access
                    </h3>
                    {!isAdminUser && (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setAllPages(true)}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          onClick={() => setAllPages(false)}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Clear all
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="space-y-4">
                    {grouped.map(([group, groupPages]) => (
                      <div key={group}>
                        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                          {group}
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                          {groupPages.map((page) => {
                            const locked =
                              isAdminUser || page.alwaysAllowed || (page.adminOnly && !isAdminUser);
                            const checked =
                              isAdminUser ||
                              page.alwaysAllowed ||
                              (!page.adminOnly && draftPages.includes(page.key));
                            return (
                              <button
                                key={page.key}
                                type="button"
                                onClick={() => togglePage(page)}
                                disabled={locked}
                                className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-left transition ${
                                  checked
                                    ? 'border-violet-200 bg-violet-50'
                                    : 'border-slate-200 bg-white'
                                } ${locked ? 'cursor-default opacity-70' : 'hover:border-violet-300'}`}
                              >
                                <span
                                  className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                    checked
                                      ? 'border-violet-600 bg-violet-600 text-white'
                                      : 'border-slate-300 bg-white'
                                  }`}
                                >
                                  {checked ? <Check className="h-3 w-3" /> : null}
                                </span>
                                <span className="min-w-0">
                                  <span className="flex items-center gap-1 text-xs font-semibold text-slate-800">
                                    {page.label}
                                    {page.alwaysAllowed ? (
                                      <span className="rounded bg-slate-100 px-1 text-[9px] font-bold uppercase text-slate-500">
                                        always
                                      </span>
                                    ) : null}
                                    {page.adminOnly ? (
                                      <span className="rounded bg-violet-100 px-1 text-[9px] font-bold uppercase text-violet-700">
                                        admin
                                      </span>
                                    ) : null}
                                  </span>
                                  <span className="block truncate text-[11px] text-slate-500">
                                    {page.description}
                                  </span>
                                  <span className="block font-mono text-[10px] text-slate-400">
                                    {page.prefix}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Department access */}
                <div className="border-t border-slate-200 px-4 py-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
                      <Building2 className="h-3.5 w-3.5" /> Department access
                    </h3>
                    {!isAdminUser && (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => setDraftDepts(departments)}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Select all
                        </button>
                        <button
                          type="button"
                          onClick={() => setDraftDepts([])}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Clear all
                        </button>
                      </div>
                    )}
                  </div>

                  {isAdminUser ? (
                    <p className="text-xs text-slate-500">
                      Admins see every department; department scoping does not apply.
                    </p>
                  ) : departments.length === 0 ? (
                    <p className="text-xs text-slate-500">No departments found.</p>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {departments.map((dept) => {
                          const checked = draftDepts.includes(dept);
                          return (
                            <button
                              key={dept}
                              type="button"
                              onClick={() => toggleDept(dept)}
                              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                                checked
                                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
                                  : 'border-slate-200 bg-white text-slate-600 hover:border-emerald-300'
                              }`}
                            >
                              <span
                                className={`flex h-3.5 w-3.5 items-center justify-center rounded-full border ${
                                  checked
                                    ? 'border-emerald-600 bg-emerald-600 text-white'
                                    : 'border-slate-300'
                                }`}
                              >
                                {checked ? <Check className="h-2.5 w-2.5" /> : null}
                              </span>
                              {dept}
                            </button>
                          );
                        })}
                      </div>
                      {draftDepts.length === 0 ? (
                        <p className="mt-2 text-[11px] text-amber-700">
                          With no department selected this user sees no department-scoped SOP data.
                        </p>
                      ) : null}
                    </>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
