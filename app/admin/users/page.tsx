'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import {
  ArrowLeft,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
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
  createdAt?: string;
  updatedAt?: string;
}

const ROLES: AppRole[] = ['admin', 'sop_admin', 'trainer', 'viewer'];

// Super Admin and SOP Admin differ only in user administration: SOP Admin
// cannot reach Login & Passwords or Access Management.
const ROLE_LABEL: Record<AppRole, string> = {
  admin: 'Super Admin',
  sop_admin: 'SOP Admin',
  trainer: 'Trainer',
  viewer: 'Viewer',
};
const DEPARTMENTS = ['QA', 'QC', 'Microbiology', 'Production', 'Store', 'Engineering', 'Personnel', 'General'];

const ROLE_STYLE: Record<AppRole, string> = {
  admin: 'bg-violet-100 text-violet-800 border-violet-200',
  sop_admin: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  trainer: 'bg-sky-100 text-sky-800 border-sky-200',
  viewer: 'bg-slate-100 text-slate-700 border-slate-200',
};

const emptyForm = {
  username: '',
  name: '',
  email: '',
  role: 'viewer' as AppRole,
  department: 'QA',
  designation: '',
  password: '',
  confirmPassword: '',
};

export default function AdminUsersPage() {
  useAuthGuard({ allowedRoles: ['admin'] });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.username.includes(q) ||
        u.name.toLowerCase().includes(q) ||
        u.role.includes(q) ||
        u.department.toLowerCase().includes(q),
    );
  }, [users, search]);

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
      department: user.department || 'QA',
      designation: user.designation,
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
        const payload: Record<string, string> = {
          name: form.name.trim(),
          email: form.email.trim(),
          role: form.role,
          department: form.department,
          designation: form.designation.trim(),
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
        setMessage(form.password ? 'User updated and password reset' : 'User updated');
      } else {
        const res = await fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: form.username.trim(),
            name: form.name.trim(),
            email: form.email.trim(),
            role: form.role,
            department: form.department,
            designation: form.designation.trim(),
            password: form.password,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Create failed');
        setUsers((prev) => [...prev, data.user].sort((a, b) => a.username.localeCompare(b.username)));
        setMessage(`Created login for ${data.user.username}`);
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

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Users className="h-3.5 w-3.5" />
            {users.length} login{users.length === 1 ? '' : 's'}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search username, name, role…"
            className="w-full max-w-xs rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
          />
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">User</th>
                <th className="px-4 py-2.5 font-semibold">Role</th>
                <th className="px-4 py-2.5 font-semibold">Department</th>
                <th className="px-4 py-2.5 font-semibold">Designation</th>
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
                    No users found.
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <div className="flex items-center gap-2">
                <Plus className="h-4 w-4 text-violet-600" />
                <h2 className="text-sm font-bold">{editing ? 'Edit user / reset password' : 'Add dashboard login'}</h2>
              </div>
              <button type="button" onClick={() => setModalOpen(false)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={(e) => void submit(e)} className="space-y-3 px-4 py-4">
              {!editing && (
                <label className="block text-xs font-semibold text-slate-600">
                  Username
                  <input
                    required
                    value={form.username}
                    onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                    placeholder="e.g. jane.doe"
                    autoComplete="off"
                  />
                </label>
              )}

              <label className="block text-xs font-semibold text-slate-600">
                Display name
                <input
                  required
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block text-xs font-semibold text-slate-600">
                  Role
                  <select
                    value={form.role}
                    onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as AppRole }))}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs font-semibold text-slate-600">
                  Department
                  <select
                    value={form.department}
                    onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))}
                    className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                  >
                    {DEPARTMENTS.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block text-xs font-semibold text-slate-600">
                Designation
                <input
                  value={form.designation}
                  onChange={(e) => setForm((f) => ({ ...f, designation: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                  placeholder="Optional"
                />
              </label>

              <label className="block text-xs font-semibold text-slate-600">
                Email
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                  placeholder="Optional"
                />
              </label>

              <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-bold text-violet-800">
                  <KeyRound className="h-3.5 w-3.5" />
                  {editing ? 'Reset password (leave blank to keep current)' : 'Login password'}
                </div>
                <div className="grid gap-2">
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                    placeholder={editing ? 'New password' : 'Password (min 6 chars)'}
                    autoComplete="new-password"
                    required={!editing}
                  />
                  <input
                    type="password"
                    value={form.confirmPassword}
                    onChange={(e) => setForm((f) => ({ ...f, confirmPassword: e.target.value }))}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-100"
                    placeholder="Confirm password"
                    autoComplete="new-password"
                    required={!editing || Boolean(form.password)}
                  />
                </div>
              </div>

              {error && modalOpen ? (
                <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</p>
              ) : null}

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {editing ? 'Save changes' : 'Create login'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
