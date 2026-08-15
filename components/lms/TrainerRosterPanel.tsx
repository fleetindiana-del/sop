'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, CalendarPlus, Loader2, RefreshCw, Search, Trash2, UserPlus, X,
} from 'lucide-react';
import { ScheduleExamModal } from '@/components/lms/ScheduleExamModal';

interface RosterRow {
  id: string;
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  employeeCode?: string;
  isTrainer: boolean;
  hasLmsAccess: boolean;
  lmsAccessIssue?: string;
  inScope: boolean;
  addedAt?: string;
}

interface AvailableRow {
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  employeeCode?: string;
  isTrainer: boolean;
  hasLmsAccess: boolean;
  lmsAccessIssue?: string;
}

interface RosterPayload {
  trainer: { id: string; name: string; departments: string[] };
  roster: RosterRow[];
  available: AvailableRow[];
  designations: string[];
  counts: {
    scoped: number;
    withLmsAccess: number;
    withoutLmsAccess: number;
    onRoster: number;
  };
}

/**
 * "My employees" — the trainer curates the employees whose exams and training
 * they are responsible for, then schedules exams straight from the selection.
 */
export function TrainerRosterPanel({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [data, setData] = useState<RosterPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set());
  const [addSearch, setAddSearch] = useState('');
  const [search, setSearch] = useState('');
  const [scheduleFor, setScheduleFor] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/lms/trainer/roster', { cache: 'no-store' });
      const json = await res.json();
      if (res.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (!res.ok) throw new Error(json.error || 'Failed to load employees');
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const roster = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.roster ?? []).filter(
      (r) => !q || `${r.name} ${r.designation} ${r.department}`.toLowerCase().includes(q),
    );
  }, [data, search]);

  const available = useMemo(() => {
    const q = addSearch.trim().toLowerCase();
    return (data?.available ?? []).filter(
      (r) => !q || `${r.name} ${r.designation} ${r.department}`.toLowerCase().includes(q),
    );
  }, [data, addSearch]);

  const addEmployees = async () => {
    if (addSelected.size === 0) return;
    setBusy(true);
    try {
      const res = await fetch('/api/lms/trainer/roster', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeIds: [...addSelected] }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to add employees');
      setAddSelected(new Set());
      setAddOpen(false);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to add employees');
    } finally {
      setBusy(false);
    }
  };

  const removeEmployee = async (row: RosterRow) => {
    if (!window.confirm(`Remove ${row.name} from your employee list?`)) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/lms/trainer/roster?employeeId=${encodeURIComponent(row.employeeId)}`,
        { method: 'DELETE' },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to remove');
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to remove');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {data && (
        <p className="text-[11px] text-gray-500">
          Department{data.trainer.departments.length === 1 ? '' : 's'}:{' '}
          <strong className="text-gray-700">{data.trainer.departments.join(', ') || '—'}</strong>
          {' · '}
          {data.counts.scoped} active employee{data.counts.scoped === 1 ? '' : 's'}
          {' · '}
          <span className="text-green-700">{data.counts.withLmsAccess} with LMS access</span>
          {data.counts.withoutLmsAccess > 0 && (
            <>
              {' · '}
              <span className="text-red-600">{data.counts.withoutLmsAccess} without</span>
            </>
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search my employees…"
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-xs focus:border-purple-300 focus:outline-none"
          />
        </div>
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-xs font-bold text-white hover:bg-purple-700"
        >
          <UserPlus className="h-3.5 w-3.5" /> Add employees
        </button>
        {roster.length > 0 && (
          <button
            type="button"
            onClick={() =>
              setScheduleFor(
                roster.filter((r) => r.inScope && r.hasLmsAccess).map((r) => r.employeeId),
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-2 text-xs font-bold text-purple-700 hover:bg-purple-100"
          >
            <CalendarPlus className="h-3.5 w-3.5" /> Schedule exam for all
          </button>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded-lg border border-gray-200 p-2 text-gray-400 hover:bg-gray-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        {loading && !data ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-7 w-7 animate-spin text-purple-400" />
          </div>
        ) : roster.length === 0 ? (
          <div className="py-16 text-center">
            <p className="text-sm text-gray-400">
              No employees added yet. Trainers still see everyone in their departments —
              adding employees here creates your own focused list.
            </p>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-purple-700"
            >
              <UserPlus className="h-3.5 w-3.5" /> Add employees
            </button>
          </div>
        ) : (
          <div className="max-h-[calc(100vh-22rem)] overflow-auto">
            <table className="w-full min-w-[700px] text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
                <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-2.5">Employee</th>
                  <th className="px-3 py-2.5">Designation</th>
                  <th className="px-3 py-2.5">Department</th>
                  <th className="px-3 py-2.5">LMS access</th>
                  <th className="px-3 py-2.5">Added</th>
                  <th className="px-3 py-2.5 w-24">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {roster.map((r) => (
                  <tr key={r.employeeId} className={r.inScope ? 'hover:bg-gray-50' : 'bg-red-50/40'}>
                    <td className="px-3 py-2.5 font-semibold text-gray-900">
                      {r.name}
                      {!r.inScope && (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                          Out of scope
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-gray-600">{r.designation || '—'}</td>
                    <td className="px-3 py-2.5 text-gray-600">{r.department || '—'}</td>
                    <td className="px-3 py-2.5">
                      {r.hasLmsAccess ? (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-bold text-green-700">
                          Yes
                        </span>
                      ) : (
                        <span
                          className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700"
                          title="Generate learning-module credentials on the Employees page"
                        >
                          {r.lmsAccessIssue === 'no-password' ? 'No password' : 'No login'}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-gray-500">{r.addedAt || '—'}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1">
                        {r.inScope && (
                          <button
                            type="button"
                            title="Schedule an exam for this employee"
                            onClick={() => setScheduleFor([r.employeeId])}
                            className="rounded p-1 text-gray-400 hover:bg-purple-50 hover:text-purple-700"
                          >
                            <CalendarPlus className="h-3.5 w-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          title="Remove from my employees"
                          disabled={busy}
                          onClick={() => void removeEmployee(r)}
                          className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setAddOpen(false)}>
          <div
            className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
              <div>
                <h2 className="text-sm font-bold text-gray-900">Add employees</h2>
                <p className="text-[11px] text-gray-500">
                  Active employees in {data?.trainer.departments.join(', ') || 'your departments'}.
                </p>
              </div>
              <button type="button" onClick={() => setAddOpen(false)} className="rounded p-1 text-gray-400 hover:bg-gray-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="border-b border-gray-100 px-5 py-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <input
                  value={addSearch}
                  onChange={(e) => setAddSearch(e.target.value)}
                  placeholder="Search…"
                  className="w-full rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-xs focus:border-purple-300 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {available.length === 0 ? (
                <p className="py-12 text-center text-xs text-gray-400">
                  Every employee in your departments is already on your list.
                </p>
              ) : (
                <table className="w-full text-left text-xs">
                  <tbody className="divide-y divide-gray-100">
                    {available.map((e) => (
                      <tr
                        key={e.employeeId}
                        className="cursor-pointer hover:bg-gray-50"
                        onClick={() =>
                          setAddSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(e.employeeId)) next.delete(e.employeeId);
                            else next.add(e.employeeId);
                            return next;
                          })
                        }
                      >
                        <td className="w-8 px-3 py-2">
                          <input
                            type="checkbox"
                            readOnly
                            checked={addSelected.has(e.employeeId)}
                            className="h-3.5 w-3.5 rounded border-gray-300"
                          />
                        </td>
                        <td className="px-3 py-2 font-semibold text-gray-800">{e.name}</td>
                        <td className="px-3 py-2 text-gray-600">{e.designation || '—'}</td>
                        <td className="px-3 py-2 text-gray-500">{e.department}</td>
                        <td className="px-3 py-2">
                          {e.hasLmsAccess ? (
                            <span className="rounded bg-green-50 px-1.5 py-0.5 text-[10px] font-bold text-green-700">
                              LMS access
                            </span>
                          ) : (
                            <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
                              No LMS login
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex items-center justify-between border-t border-gray-200 px-5 py-3">
              <p className="text-[11px] text-gray-500">{addSelected.size} selected</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  disabled={busy}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void addEmployees()}
                  disabled={busy || addSelected.size === 0}
                  className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                >
                  {busy ? 'Adding…' : 'Add to my employees'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {scheduleFor && (
        <ScheduleExamModal
          presetEmployeeIds={scheduleFor}
          onClose={() => setScheduleFor(null)}
          onScheduled={() => {
            setScheduleFor(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
