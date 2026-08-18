'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, Check, Loader2, Search, UserCheck, UserX, X,
} from 'lucide-react';

type EligibleEmployee = {
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  employeeCode?: string;
  assignedThisSop: boolean;
};

type SeedEmployee = {
  employeeId: string;
  employeeName: string;
  department: string;
  status?: string;
  scheduledDate?: string;
};

/**
 * Compact attendance sheet for one SOP × today — opened from My Trainings Attend.
 * Everyone defaults to present; trainer toggles absentees, then saves.
 */
export function MarkAttendanceModal({
  sopCode,
  sopName,
  trainingDate,
  seedEmployees,
  onClose,
  onSaved,
}: {
  sopCode: string;
  sopName: string;
  /** YYYY-MM-DD — normally today. */
  trainingDate: string;
  /** Employees scheduled for this SOP (prefer showing these). */
  seedEmployees: SeedEmployee[];
  onClose: () => void;
  onSaved?: () => void;
}) {
  const departments = useMemo(() => {
    const set = new Set(
      seedEmployees.map((e) => e.department.trim()).filter(Boolean),
    );
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [seedEmployees]);

  const [dept, setDept] = useState(departments[0] || '');
  const [employees, setEmployees] = useState<EligibleEmployee[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [absent, setAbsent] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    if (!dept && departments[0]) setDept(departments[0]);
  }, [departments, dept]);

  const load = useCallback(async () => {
    if (!sopCode || !dept) {
      setEmployees([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    setSavedMsg('');
    try {
      const qs = new URLSearchParams({
        sopCode,
        department: dept,
        date: trainingDate,
      });
      const res = await fetch(`/api/lms/trainer/attendance/eligible?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load employees');

      const seedIds = new Set(
        seedEmployees
          .filter((e) => !e.department || e.department.toLowerCase() === dept.toLowerCase())
          .map((e) => e.employeeId),
      );
      const all = (json.employees ?? []) as EligibleEmployee[];
      // Prefer people on this SOP’s sitting; fall back to assigned-this-SOP, then all.
      const scoped = seedIds.size > 0
        ? all.filter((e) => seedIds.has(e.employeeId) || e.assignedThisSop)
        : all.filter((e) => e.assignedThisSop);
      const list = (scoped.length > 0 ? scoped : all)
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name));
      setEmployees(list);

      if (json.existing?.records) {
        setAbsent(new Set(
          (json.existing.records as Array<{ employeeId: string; status: string }>)
            .filter((r) => r.status === 'absent')
            .map((r) => r.employeeId),
        ));
      } else {
        setAbsent(new Set());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      setEmployees(null);
    } finally {
      setLoading(false);
    }
  }, [sopCode, dept, trainingDate, seedEmployees]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (employees ?? []).filter(
      (e) => !q || `${e.name} ${e.designation} ${e.employeeCode ?? ''}`.toLowerCase().includes(q),
    );
  }, [employees, search]);

  const presentCount = (employees?.length ?? 0) - absent.size;

  const toggleAbsent = (id: string) => {
    setAbsent((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    if (!employees?.length || !dept) return;
    setBusy(true);
    setError('');
    setSavedMsg('');
    try {
      const res = await fetch('/api/lms/trainer/attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sopCode,
          department: dept,
          trainingDate,
          employeeIds: employees.map((e) => e.employeeId),
          absentEmployeeIds: [...absent],
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to save attendance');
      setSavedMsg(
        `Saved — ${json.sheet?.presentCount ?? presentCount} present, ${json.sheet?.absentCount ?? absent.size} absent`,
      );
      onSaved?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
              <UserCheck className="h-4 w-4 text-purple-600" />
              Mark attendance
            </p>
            <p className="mt-0.5 font-mono text-xs font-bold text-purple-700">
              {sopCode}
              <span className="ml-2 font-sans font-normal text-gray-600">{sopName}</span>
            </p>
            <p className="mt-0.5 text-[10px] text-gray-500">
              Session date {trainingDate} · Present employees can start the exam
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2">
          {departments.length > 1 && (
            <select
              value={dept}
              onChange={(e) => setDept(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white py-1.5 pl-2 pr-6 text-xs font-medium text-gray-700"
            >
              {departments.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
          <div className="relative min-w-[10rem] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search employees…"
              className="w-full rounded-lg border border-gray-200 py-1.5 pl-7 pr-2 text-xs focus:border-purple-300 focus:outline-none"
            />
          </div>
          <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-bold text-green-700">
            <Check className="h-3 w-3" /> {presentCount} present
          </span>
          <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700">
            <UserX className="h-3 w-3" /> {absent.size} absent
          </span>
          <button
            type="button"
            onClick={() => setAbsent(new Set())}
            className="text-[10px] font-semibold text-indigo-600 hover:underline"
          >
            Mark all present
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
          </div>
        )}
        {savedMsg && (
          <div className="mx-4 mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            {savedMsg}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="h-7 w-7 animate-spin text-purple-400" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-400">
              No employees to mark for this session.
            </p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 border-b border-gray-100 bg-gray-50">
                <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-2">Employee</th>
                  <th className="px-3 py-2">Designation</th>
                  <th className="px-3 py-2 text-right">Attendance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map((emp) => {
                  const isAbsent = absent.has(emp.employeeId);
                  return (
                    <tr key={emp.employeeId} className="hover:bg-gray-50/80">
                      <td className="px-3 py-2 font-semibold text-gray-900">
                        {emp.name}
                        {emp.employeeCode ? (
                          <span className="ml-1.5 text-[10px] font-normal text-gray-400">
                            {emp.employeeCode}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-gray-600">{emp.designation || '—'}</td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => toggleAbsent(emp.employeeId)}
                          className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
                            isAbsent
                              ? 'border-red-300 bg-red-50 text-red-700'
                              : 'border-emerald-300 bg-emerald-50 text-emerald-800'
                          }`}
                        >
                          {isAbsent ? (
                            <><UserX className="h-3 w-3" /> Absent</>
                          ) : (
                            <><Check className="h-3 w-3" /> Present</>
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-gray-100 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
          >
            Close
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || loading || !employees?.length}
            className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-purple-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserCheck className="h-3.5 w-3.5" />}
            Save attendance
          </button>
        </div>
      </div>
    </div>
  );
}
