'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { isLearnerOnly } from '@/lib/page-access';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronsUpDown,
  ExternalLink,
  GraduationCap,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserPlus,
  Users,
  X,
} from 'lucide-react';

type AppRole = 'admin' | 'sop_admin' | 'trainer' | 'viewer';

interface AppUser {
  id: string;
  username: string;
  name: string;
  email: string;
  role: AppRole;
  department: string;
  designation: string;
  isTrainer?: boolean;
  /** Employee `_id` this login is in the LMS; '' when never linked. */
  lmsEmployeeId?: string;
  /** One password for dashboard + LMS. False = LMS-only, own LMS password. */
  sharedLmsLogin?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface DesignationOption {
  id: string;
  name: string;
}

interface EmployeeOption {
  id: string;
  name: string;
  department: string;
  designation: string;
  employeeCode: string;
}

const ROLES: AppRole[] = ['admin', 'sop_admin', 'trainer', 'viewer'];

// Super Admin and SOP Admin carry the same capability, including this page;
// the two labels only distinguish who the login belongs to.
const ROLE_LABEL: Record<AppRole, string> = {
  admin: 'Super Admin',
  sop_admin: 'SOP Admin',
  trainer: 'Trainer',
  viewer: 'Viewer',
};
/**
 * Only used until `/api/departments` answers — the real catalogue is loaded at
 * mount so a department added after this file was written is still selectable.
 */
const FALLBACK_DEPARTMENTS = ['QA', 'QC', 'Microbiology', 'Production', 'Store', 'Engineering', 'Personnel'];

const ROLE_STYLE: Record<AppRole, string> = {
  admin: 'bg-violet-100 text-violet-800 border-violet-200',
  sop_admin: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  trainer: 'bg-sky-100 text-sky-800 border-sky-200',
  viewer: 'bg-slate-100 text-slate-700 border-slate-200',
};

// Shared field styling, so every control in the modal lines up.
const INPUT_CLS =
  'mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-violet-400 focus:ring-2 focus:ring-violet-100';
const LABEL_CLS = 'block text-xs font-semibold text-slate-600';
const FILTER_CLS =
  'rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-100';
const HINT_CLS = 'mt-1 text-[11px] font-normal leading-relaxed text-slate-400';
const SECTION_CLS =
  'flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400';

const emptyForm = {
  username: '',
  name: '',
  email: '',
  role: 'viewer' as AppRole,
  /** Assigned departments. Stored on the user as a comma-separated list. */
  departments: [] as string[],
  designation: '',
  isTrainer: false,
  lmsEmployeeId: '',
  /** Default follows the role — see {@link defaultSharedLmsLogin}. */
  sharedLmsLogin: false,
  password: '',
  confirmPassword: '',
};

/**
 * A learner has no dashboard to bridge from, so their LMS password is kept on
 * the Employee record instead. Everyone who signs in to the dashboard defaults
 * to one password for both modules.
 */
function defaultSharedLmsLogin(role: AppRole): boolean {
  return !isLearnerOnly(role);
}

/** Split the stored comma-separated `User.department` back into a list. */
function splitDepartments(value: string): string[] {
  return value.split(',').map((d) => d.trim()).filter(Boolean);
}

type SortKey = 'name' | 'username' | 'role' | 'department' | 'designation';
type SortDir = 'asc' | 'desc';
interface SortState { key: SortKey; dir: SortDir; }

type AccessFilter = 'all' | 'trainer' | 'shared-lms' | 'separate-lms';

const ACCESS_FILTER_LABEL: Record<AccessFilter, string> = {
  all: 'Any access',
  trainer: 'Trainers only',
  'shared-lms': 'Shared LMS password',
  'separate-lms': 'Separate LMS password',
};

/**
 * Sorting by role means by privilege, not alphabetically — an admin reading the
 * list wants Super Admins first, not "admin" before "viewer" by accident.
 * Roles no longer offered (e.g. legacy "learner") sort after the known ones.
 */
function roleRank(role: string): number {
  const index = ROLES.indexOf(role as AppRole);
  return index === -1 ? ROLES.length : index;
}

function roleLabel(role: string): string {
  return ROLE_LABEL[role as AppRole] ?? role;
}

/** Blank cells sort last in both directions, so "—" never tops the list. */
function compareText(a: string, b: string): number {
  const left = a.trim();
  const right = b.trim();
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

const SORT_LABEL: Record<SortKey, string> = {
  name: 'name',
  username: 'username',
  role: 'role',
  department: 'department',
  designation: 'designation',
};

/** The header cells that sort, in table order. "User" sorts by display name. */
const SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'User' },
  { key: 'role', label: 'Role' },
  { key: 'department', label: 'Department' },
  { key: 'designation', label: 'Designation' },
];

function ariaSort(active: boolean, dir: SortDir): 'ascending' | 'descending' | 'none' {
  if (!active) return 'none';
  return dir === 'asc' ? 'ascending' : 'descending';
}

function compareUsers(a: AppUser, b: AppUser, key: SortKey): number {
  if (key === 'role') {
    const byRank = roleRank(a.role) - roleRank(b.role);
    // Same role: fall back to name so the order inside a group is stable.
    return byRank !== 0 ? byRank : compareText(a.name, b.name);
  }
  if (key === 'username') return compareText(a.username, b.username);
  if (key === 'department') return compareText(a.department, b.department) || compareText(a.name, b.name);
  if (key === 'designation') return compareText(a.designation, b.designation) || compareText(a.name, b.name);
  return compareText(a.name, b.name);
}

/**
 * The Trainer flag only grants LMS trainer access once it reaches the matching
 * Employee record, so say plainly when no employee matched the login.
 */
function trainerSyncNote(
  sync: { matched?: boolean; employeeName?: string } | undefined,
  isTrainer: boolean,
): string {
  if (!sync) return '';
  if (sync.matched) {
    return ` · Trainer ${isTrainer ? 'enabled' : 'removed'} on employee ${sync.employeeName}`;
  }
  return isTrainer
    ? ' · No matching employee record found, so LMS trainer access is not active yet'
    : '';
}

/**
 * The shared password only reaches the LMS once it is written to the matching
 * Employee record, so say plainly when no employee matched — otherwise the
 * screen implies both passwords changed when only the dashboard one did.
 */
function lmsPasswordNote(
  sync: { matched?: boolean; employeeName?: string; lmsUsername?: string } | undefined,
  shared: boolean,
  passwordChanged: boolean,
): string {
  if (!shared) return ' · LMS password unchanged — manage it in Employee Master';
  if (!passwordChanged) return '';
  if (!sync) return '';
  if (sync.matched) {
    return ` · Same password set for LMS login ${sync.lmsUsername || sync.employeeName}`;
  }
  return ' · No matching employee record found, so the LMS password was not set';
}

export default function AdminUsersPage() {
  useAuthGuard({ allowedRoles: ['admin', 'sop_admin'] });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [users, setUsers] = useState<AppUser[]>([]);
  const [designations, setDesignations] = useState<DesignationOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [departmentFilter, setDepartmentFilter] = useState('all');
  const [accessFilter, setAccessFilter] = useState<AccessFilter>('all');
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [departments, setDepartments] = useState<string[]>(FALLBACK_DEPARTMENTS);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/users');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load users');
      setUsers(data.users || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Designation Master drives the dropdown, so titles stay consistent with the
  // Employee Master instead of being free text.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/designations');
        const json = await res.json();
        if (cancelled || !res.ok || !Array.isArray(json.designations)) return;
        setDesignations(
          json.designations
            .map((d: { id: string; name: string }) => ({
              id: String(d.id),
              name: String(d.name || '').trim(),
            }))
            .filter((d: DesignationOption) => d.name),
        );
      } catch {
        /* dropdown falls back to the value already on the user */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // The full department catalogue (SOP registry ∪ Department master) so every
  // department can be assigned here, not just a list hardcoded in this file.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/departments');
        const json = await res.json();
        if (cancelled || !res.ok || !Array.isArray(json.departments)) return;
        const list = json.departments
          .map((d: unknown) => String(d || '').trim())
          .filter(Boolean);
        if (list.length) setDepartments(list);
      } catch {
        /* keep the fallback list */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Employee Master, for linking a login to the learner record it *is* in the
  // LMS. skipSync keeps this off the slow matrix re-scan path.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/employees?skipSync=1');
        const json = await res.json();
        if (cancelled || !res.ok || !Array.isArray(json.employees)) return;
        setEmployees(
          json.employees.map((e: Record<string, unknown>) => ({
            id: String(e._id),
            name: String(e.name || '').trim(),
            department: String(e.department || '').trim(),
            designation: String(e.designation || '').trim(),
            employeeCode: String(e.employeeId || '').trim(),
          })).filter((e: EmployeeOption) => e.name),
        );
      } catch {
        /* the picker degrades to "not linked" */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Roles actually present, not just the four this file knows about — legacy
  // logins carry roles (e.g. "learner") that are no longer offered but must
  // still be filterable.
  const roleOptions = useMemo(() => {
    const present = new Set(users.map((u) => u.role).filter(Boolean));
    ROLES.forEach((r) => present.add(r));
    return [...present].sort((a, b) => roleRank(a) - roleRank(b));
  }, [users]);

  // Every department assigned to at least one login, so the filter never offers
  // an empty result.
  const departmentOptions = useMemo(() => {
    const present = new Set<string>();
    users.forEach((u) => splitDepartments(u.department || '').forEach((d) => present.add(d)));
    return [...present].sort((a, b) => a.localeCompare(b));
  }, [users]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();

    const rows = users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;

      if (departmentFilter !== 'all') {
        // A login can hold several departments; matching any of them counts.
        const held = splitDepartments(u.department || '');
        if (!held.some((d) => d.toLowerCase() === departmentFilter.toLowerCase())) return false;
      }

      if (accessFilter === 'trainer' && u.isTrainer !== true) return false;
      if (accessFilter === 'shared-lms' && u.sharedLmsLogin === false) return false;
      if (accessFilter === 'separate-lms' && u.sharedLmsLogin !== false) return false;

      if (!q) return true;
      return (
        u.username.toLowerCase().includes(q)
        || u.name.toLowerCase().includes(q)
        || u.email.toLowerCase().includes(q)
        || roleLabel(u.role).toLowerCase().includes(q)
        || u.role.toLowerCase().includes(q)
        || u.department.toLowerCase().includes(q)
        || u.designation.toLowerCase().includes(q)
      );
    });

    const dir = sort.dir === 'asc' ? 1 : -1;
    // Sorted on a copy: `users` is the fetched order, which the create path
    // appends to.
    return [...rows].sort((a, b) => compareUsers(a, b, sort.key) * dir);
  }, [users, search, roleFilter, departmentFilter, accessFilter, sort]);

  const filtersActive =
    Boolean(search.trim()) || roleFilter !== 'all' || departmentFilter !== 'all' || accessFilter !== 'all';

  const clearFilters = () => {
    setSearch('');
    setRoleFilter('all');
    setDepartmentFilter('all');
    setAccessFilter('all');
  };

  const toggleSort = (key: SortKey) => {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  };

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setError('');
    setMessage('');
    setModalOpen(true);
  };

  const openEdit = (user: AppUser) => {
    setEditing(user);
    setForm({
      username: user.username,
      name: user.name,
      email: user.email,
      role: user.role,
      departments: splitDepartments(user.department || ''),
      designation: user.designation,
      isTrainer: user.isTrainer === true,
      lmsEmployeeId: user.lmsEmployeeId || '',
      sharedLmsLogin: user.sharedLmsLogin !== false,
      password: '',
      confirmPassword: '',
    });
    setError('');
    setMessage('');
    setModalOpen(true);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setMessage('');

    if (form.password || form.confirmPassword) {
      if (form.password.length < 6) {
        setError('Password must be at least 6 characters');
        setSaving(false);
        return;
      }
      if (form.password !== form.confirmPassword) {
        setError('Passwords do not match');
        setSaving(false);
        return;
      }
    }

    if (!editing && !form.password) {
      setError('Password is required for new users');
      setSaving(false);
      return;
    }

    try {
      if (editing) {
        const payload: Record<string, string | boolean | string[]> = {
          name: form.name.trim(),
          email: form.email.trim(),
          role: form.role,
          departments: form.departments,
          designation: form.designation.trim(),
          isTrainer: form.isTrainer,
          lmsEmployeeId: form.lmsEmployeeId,
          sharedLmsLogin: form.sharedLmsLogin,
        };
        if (form.password) payload.password = form.password;

        const res = await fetch(`/api/admin/users/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Update failed');
        setUsers((prev) => prev.map((u) => (u.id === editing.id ? data.user : u)));
        setMessage(
          (form.password ? 'User updated and password reset' : 'User updated')
          + trainerSyncNote(data.trainerSync, form.isTrainer)
          + lmsPasswordNote(data.lmsSync, form.sharedLmsLogin, Boolean(form.password)),
        );
      } else {
        const res = await fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: form.username.trim(),
            name: form.name.trim(),
            email: form.email.trim(),
            role: form.role,
            departments: form.departments,
            designation: form.designation.trim(),
            isTrainer: form.isTrainer,
            lmsEmployeeId: form.lmsEmployeeId,
            sharedLmsLogin: form.sharedLmsLogin,
            password: form.password,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Create failed');
        setUsers((prev) => [...prev, data.user].sort((a, b) => a.username.localeCompare(b.username)));
        setMessage(
          `Created login for ${data.user.username}`
          + trainerSyncNote(data.trainerSync, form.isTrainer)
          + lmsPasswordNote(data.lmsSync, form.sharedLmsLogin, Boolean(form.password)),
        );
      }
      setModalOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const removeUser = async (user: AppUser) => {
    if (user.id === currentUserId) {
      setError('You cannot delete your own account');
      return;
    }
    if (!window.confirm(`Delete login “${user.username}”? This cannot be undone.`)) return;

    setDeletingId(user.id);
    setError('');
    try {
      const res = await fetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setUsers((prev) => prev.filter((u) => u.id !== user.id));
      setMessage(`Deleted ${user.username}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
            </Link>
            <div className="h-5 w-px bg-slate-200" />
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-violet-600" />
              <div>
                <h1 className="text-sm font-bold tracking-tight">Login &amp; Password Admin</h1>
                <p className="text-[11px] text-slate-500">Manage dashboard user accounts</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/admin/access"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Access Management
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-violet-700"
            >
              <UserPlus className="h-3.5 w-3.5" /> Add User
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5">
        {(error || message) && (
          <div
            className={`mb-4 flex items-start justify-between rounded-lg px-3 py-2 text-sm ${
              error ? 'bg-rose-50 text-rose-700' : 'bg-emerald-50 text-emerald-700'
            }`}
          >
            <span>{error || message}</span>
            <button type="button" onClick={() => { setError(''); setMessage(''); }} className="ml-3 rounded p-0.5 hover:bg-black/5">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="mb-4 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search username, name, email, role, department…"
                className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-8 text-sm outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>

            <select
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              aria-label="Filter by role"
              className={FILTER_CLS}
            >
              <option value="all">All roles</option>
              {roleOptions.map((r) => (
                <option key={r} value={r}>{roleLabel(r)}</option>
              ))}
            </select>

            <select
              value={departmentFilter}
              onChange={(e) => setDepartmentFilter(e.target.value)}
              aria-label="Filter by department"
              className={FILTER_CLS}
            >
              <option value="all">All departments</option>
              {departmentOptions.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>

            <select
              value={accessFilter}
              onChange={(e) => setAccessFilter(e.target.value as AccessFilter)}
              aria-label="Filter by access"
              className={FILTER_CLS}
            >
              {(Object.keys(ACCESS_FILTER_LABEL) as AccessFilter[]).map((k) => (
                <option key={k} value={k}>{ACCESS_FILTER_LABEL[k]}</option>
              ))}
            </select>

            {filtersActive ? (
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
              >
                <X className="h-3.5 w-3.5" /> Clear
              </button>
            ) : null}
          </div>

          <div className="mt-2.5 flex items-center gap-2 border-t border-slate-100 pt-2.5 text-xs text-slate-500">
            <Users className="h-3.5 w-3.5" />
            {filtersActive
              ? `${filtered.length} of ${users.length} login${users.length === 1 ? '' : 's'}`
              : `${users.length} login${users.length === 1 ? '' : 's'}`}
            <span className="text-slate-300">·</span>
            <span>
              Sorted by {SORT_LABEL[sort.key]} ({sort.key === 'role'
                ? (sort.dir === 'asc' ? 'most privileged first' : 'least privileged first')
                : (sort.dir === 'asc' ? 'A–Z' : 'Z–A')})
            </span>
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                {SORTABLE_COLUMNS.map((col) => {
                  const active = sort.key === col.key;
                  return (
                    <th key={col.key} className="px-4 py-2.5 font-semibold" aria-sort={ariaSort(active, sort.dir)}>
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        title={`Sort by ${col.label.toLowerCase()}`}
                        className={`inline-flex items-center gap-1 uppercase tracking-wide transition hover:text-slate-800 ${
                          active ? 'font-bold text-violet-700' : 'font-semibold'
                        }`}
                      >
                        {col.label}
                        {active ? (
                          sort.dir === 'asc'
                            ? <ArrowUp className="h-3 w-3" />
                            : <ArrowDown className="h-3 w-3" />
                        ) : (
                          <ChevronsUpDown className="h-3 w-3 text-slate-300" />
                        )}
                      </button>
                    </th>
                  );
                })}
                <th className="px-4 py-2.5 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
                    Loading users…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                    <p className="text-sm">No logins match these filters.</p>
                    {filtersActive ? (
                      <button
                        type="button"
                        onClick={clearFilters}
                        className="mt-2 inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                      >
                        <X className="h-3.5 w-3.5" /> Clear filters
                      </button>
                    ) : null}
                  </td>
                </tr>
              ) : (
                filtered.map((user) => (
                  <tr key={user.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/70">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{user.name}</div>
                      <div className="font-mono text-xs text-slate-500">{user.username}</div>
                      {user.email ? <div className="text-[11px] text-slate-400">{user.email}</div> : null}
                      {user.id === currentUserId ? (
                        <span className="mt-1 inline-block rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                          You
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${ROLE_STYLE[user.role]}`}>
                        {ROLE_LABEL[user.role] ?? user.role}
                      </span>
                      {user.isTrainer ? (
                        <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-semibold text-sky-800">
                          <UserCheck className="h-3 w-3" /> Trainer
                        </span>
                      ) : null}
                      {user.sharedLmsLogin === false ? (
                        <span
                          title="Separate LMS password — managed on the Employees page"
                          className="mt-1 inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800"
                        >
                          <GraduationCap className="h-3 w-3" /> LMS password separate
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-slate-600">{user.department || '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{user.designation || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEdit(user)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-600 hover:bg-white"
                          title="Edit / reset password"
                        >
                          <KeyRound className="h-3 w-3" />
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeUser(user)}
                          disabled={deletingId === user.id || user.id === currentUserId}
                          className="inline-flex items-center rounded-lg border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                          title="Delete user"
                        >
                          {deletingId === user.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4 backdrop-blur-[2px] sm:items-center">
          {/* The panel is capped to the viewport and scrolls internally, so the
              title and the Save button stay reachable however tall the form gets. */}
          <div className="flex max-h-[calc(100dvh-2rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-slate-900/5">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100 text-violet-700">
                  {editing ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                </span>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">
                    {editing ? 'Edit user / reset password' : 'Add dashboard login'}
                  </h2>
                  <p className="text-[11px] text-slate-500">
                    {editing ? editing.username : 'Creates a new application login'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={(e) => void submit(e)} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
                <section className="space-y-3">
                  <h3 className={SECTION_CLS}>
                    <Users className="h-3.5 w-3.5" /> Account
                  </h3>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {!editing && (
                      <label className={LABEL_CLS}>
                        Username
                        <input
                          required
                          value={form.username}
                          onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                          className={INPUT_CLS}
                          placeholder="e.g. jane.doe"
                          autoComplete="off"
                        />
                      </label>
                    )}

                    <label className={`${LABEL_CLS} ${editing ? 'sm:col-span-2' : ''}`}>
                      Display name
                      <input
                        required
                        value={form.name}
                        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                        className={INPUT_CLS}
                      />
                    </label>

                    <label className={`${LABEL_CLS} sm:col-span-2`}>
                      Email
                      <input
                        type="email"
                        value={form.email}
                        onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                        className={INPUT_CLS}
                        placeholder="Optional"
                      />
                    </label>
                  </div>
                </section>

                <section className="space-y-3 border-t border-slate-100 pt-5">
                  <h3 className={SECTION_CLS}>
                    <ShieldCheck className="h-3.5 w-3.5" /> Role &amp; access
                  </h3>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className={LABEL_CLS}>
                      Role
                      <select
                        value={form.role}
                        onChange={(e) => {
                          const role = e.target.value as AppRole;
                          // The shared-password default belongs to the role, so
                          // switching role re-applies it.
                          setForm((f) => ({
                            ...f,
                            role,
                            sharedLmsLogin: defaultSharedLmsLogin(role),
                          }));
                        }}
                        className={INPUT_CLS}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                        ))}
                      </select>
                    </label>

                    <label className={LABEL_CLS}>
                      Designation
                      <select
                        value={form.designation}
                        onChange={(e) => setForm((f) => ({ ...f, designation: e.target.value }))}
                        className={INPUT_CLS}
                      >
                        <option value="">— None —</option>
                        {/* A designation retired from the master must stay visible on
                            the user already holding it, or saving would silently drop it. */}
                        {form.designation
                          && !designations.some((d) => d.name === form.designation) ? (
                          <option value={form.designation}>{form.designation}</option>
                        ) : null}
                        {designations.map((d) => (
                          <option key={d.id} value={d.name}>{d.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <div className={LABEL_CLS}>
                    Departments
                    <div className="mt-1 flex flex-wrap gap-1.5 rounded-lg border border-slate-200 bg-slate-50/50 p-2">
                      {departments.map((d) => {
                        const on = form.departments.some(
                          (x) => x.toLowerCase() === d.toLowerCase(),
                        );
                        return (
                          <button
                            key={d}
                            type="button"
                            aria-pressed={on}
                            onClick={() => setForm((f) => ({
                              ...f,
                              departments: on
                                ? f.departments.filter((x) => x.toLowerCase() !== d.toLowerCase())
                                : [...f.departments, d],
                            }))}
                            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                              on
                                ? 'border-violet-300 bg-violet-100 text-violet-800'
                                : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'
                            }`}
                          >
                            {d}
                          </button>
                        );
                      })}
                      {/* A department this user already holds that is no longer in the
                          catalogue must stay visible, or saving would drop it. */}
                      {form.departments
                        .filter((d) => !departments.some((x) => x.toLowerCase() === d.toLowerCase()))
                        .map((d) => (
                          <button
                            key={d}
                            type="button"
                            title="No longer in the department master — click to remove"
                            onClick={() => setForm((f) => ({
                              ...f,
                              departments: f.departments.filter((x) => x !== d),
                            }))}
                            className="rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-800"
                          >
                            {d} ×
                          </button>
                        ))}
                    </div>
                    <p className={HINT_CLS}>
                      {form.role === 'admin' || form.role === 'sop_admin'
                        ? 'Super Admin and SOP Admin see every department regardless of what is selected here.'
                        : form.departments.length === 0
                          ? 'No department selected — this login will see no department-scoped data.'
                          : `Sees data for ${form.departments.length} department${form.departments.length === 1 ? '' : 's'}.`}
                    </p>
                  </div>
                </section>

                <section className="space-y-3 border-t border-slate-100 pt-5">
                  <h3 className={SECTION_CLS}>
                    <GraduationCap className="h-3.5 w-3.5" /> Learning module
                  </h3>

                  <label className={LABEL_CLS}>
                    LMS employee record
                    <select
                      value={form.lmsEmployeeId}
                      onChange={(e) => setForm((f) => ({ ...f, lmsEmployeeId: e.target.value }))}
                      className={INPUT_CLS}
                    >
                      <option value="">— Match automatically by name —</option>
                      {employees.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                          {e.employeeCode ? ` (${e.employeeCode})` : ''}
                          {e.department ? ` · ${e.department}` : ''}
                        </option>
                      ))}
                    </select>
                    <p className={HINT_CLS}>
                      Which learner this login opens in the LMS. Set it whenever two
                      employees share a name, or for an admin whose display name does
                      not match their employee record — otherwise the LMS has to guess
                      and may refuse to open.
                    </p>
                  </label>

                  <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-sky-100 bg-sky-50/60 p-3 transition hover:border-sky-200">
                    <input
                      type="checkbox"
                      checked={form.isTrainer}
                      onChange={(e) => setForm((f) => ({ ...f, isTrainer: e.target.checked }))}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-sky-600 focus:ring-sky-400"
                    />
                    <span>
                      <span className="flex items-center gap-1.5 text-xs font-bold text-sky-900">
                        <UserCheck className="h-3.5 w-3.5" /> Trainer
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-sky-800/70">
                        Grants Trainer View in the LMS. Also sets the trainer flag on
                        this person&rsquo;s employee record.
                      </span>
                    </span>
                  </label>

                  <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3 transition hover:border-emerald-200">
                    <input
                      type="checkbox"
                      checked={form.sharedLmsLogin}
                      onChange={(e) => setForm((f) => ({ ...f, sharedLmsLogin: e.target.checked }))}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-emerald-600 focus:ring-emerald-400"
                    />
                    <span>
                      <span className="flex items-center gap-1.5 text-xs font-bold text-emerald-900">
                        <Link2 className="h-3.5 w-3.5" /> Same password for Dashboard and LMS
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-emerald-800/70">
                        The password below signs this person into both. Once they are
                        signed in to the dashboard the LMS opens straight away — no
                        second password.
                      </span>
                    </span>
                  </label>

                  {/* LMS-only person: their learning-module password is a field on
                      the Employee record, not on this login, so send the admin
                      there instead of showing a password box that cannot set it. */}
                  {!form.sharedLmsLogin && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50/70 p-3">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-amber-900">
                        <GraduationCap className="h-3.5 w-3.5" /> LMS access only
                      </div>
                      <p className="mt-1 text-[11px] leading-relaxed text-amber-800/80">
                        This login will not open the LMS from a dashboard session. The
                        person signs in to the LMS separately, and their LMS username and
                        password are edited on the Employees page.
                      </p>
                      <Link
                        href="/employees"
                        target="_blank"
                        className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-amber-900 transition hover:bg-amber-100"
                      >
                        <ExternalLink className="h-3 w-3" /> Edit LMS password in Employees
                      </Link>
                    </div>
                  )}
                </section>

                <section className="space-y-3 border-t border-slate-100 pt-5">
                  <h3 className={SECTION_CLS}>
                    <KeyRound className="h-3.5 w-3.5" />
                    {form.sharedLmsLogin ? 'Dashboard & LMS password' : 'Dashboard password'}
                  </h3>

                  <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-3">
                    <p className="mb-2 text-[11px] font-semibold text-violet-800">
                      {editing
                        ? 'Reset password — leave blank to keep the current one'
                        : 'Set the password this person signs in with'}
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <input
                        type="password"
                        value={form.password}
                        onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                        className={INPUT_CLS}
                        placeholder={editing ? 'New password' : 'Password (min 6 chars)'}
                        autoComplete="new-password"
                        required={!editing}
                      />
                      <input
                        type="password"
                        value={form.confirmPassword}
                        onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                        className={INPUT_CLS}
                        placeholder="Confirm password"
                        autoComplete="new-password"
                        required={!editing || Boolean(form.password)}
                      />
                    </div>
                    {form.sharedLmsLogin ? (
                      <p className="mt-2 text-[11px] leading-relaxed text-violet-800/70">
                        Also written to the linked employee&rsquo;s LMS login, so both
                        modules stay on one password. Leaving it blank changes neither.
                      </p>
                    ) : null}
                  </div>
                </section>
              </div>

              {/* Pinned below the scroll area so the error and the Save button are
                  never scrolled out of reach on a short viewport. */}
              <div className="shrink-0 border-t border-slate-200 bg-slate-50 px-5 py-3">
                {error ? (
                  <p className="mb-2.5 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
                ) : null}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setModalOpen(false)}
                    className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-violet-700 disabled:opacity-60"
                  >
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    {editing ? 'Save changes' : 'Create login'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
