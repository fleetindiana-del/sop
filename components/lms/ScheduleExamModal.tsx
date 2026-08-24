'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, CalendarDays, CheckCircle2, Loader2, Lock, Search, Users, X,
} from 'lucide-react';

interface ExamOption {
  sopCode: string;
  sopName: string;
  department: string;
  questionCount: number;
  lmsApproved: boolean;
  examQuestionCount: number;
  passingScore: number;
}

interface SchedulableEmployee {
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  employeeCode?: string;
  hasLmsAccess: boolean;
  lmsAccessIssue?: string;
  onRoster: boolean;
  inTrainingMatrix: boolean;
  alreadyScheduled: boolean;
  scheduledDate?: string;
  completed: boolean;
}

const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Last non-Sunday of the month — a sensible default completion deadline. */
function defaultDeadline(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0));
  while (last.getUTCDay() === 0) last.setUTCDate(last.getUTCDate() - 1);
  return last.toISOString().slice(0, 10);
}

type EmployeeFilter = 'eligible' | 'roster' | 'matrix' | 'all';

/**
 * Trainer exam scheduler — month first.
 *
 * 1. Pick the exam, the training month, and the completion deadline.
 * 2. The employee list reloads for that exam + month, showing exactly who is
 *    eligible (department scope + LMS login) and who is already scheduled,
 *    already on the matrix, or already passed.
 * 3. Selecting and saving upserts one schedule per employee for that month.
 */
export function ScheduleExamModal({
  onClose,
  onScheduled,
  presetEmployeeIds,
}: {
  onClose: () => void;
  onScheduled: () => void;
  presetEmployeeIds?: string[];
}) {
  const now = new Date();
  const [examsLoading, setExamsLoading] = useState(true);
  const [peopleLoading, setPeopleLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [exams, setExams] = useState<ExamOption[]>([]);
  const [employees, setEmployees] = useState<SchedulableEmployee[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(presetEmployeeIds ?? []));
  const [sopCode, setSopCode] = useState('');
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [year, setYear] = useState(now.getFullYear());
  // Null = follow the chosen month; a string is the trainer's explicit choice.
  const [deadlineOverride, setDeadlineOverride] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<EmployeeFilter>('eligible');

  // Derived, not stored: the deadline tracks the chosen month until overridden.
  const deadline = deadlineOverride ?? defaultDeadline(year, month);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/lms/trainer/exam-catalog', { cache: 'no-store' });
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(json.error || 'Failed to load exams');
        setExams(json.exams ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load exams');
      } finally {
        if (!cancelled) setExamsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadEmployees = useCallback(async () => {
    setPeopleLoading(true);
    try {
      const qs = new URLSearchParams({ month: String(month), year: String(year) });
      if (sopCode) qs.set('sopCode', sopCode);
      const res = await fetch(`/api/lms/trainer/schedulable-employees?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load employees');
      setEmployees(json.employees ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load employees');
    } finally {
      setPeopleLoading(false);
    }
  }, [sopCode, month, year]);

  useEffect(() => {
    void (async () => {
      await loadEmployees();
    })();
  }, [loadEmployees]);

  const selectedExam = exams.find((e) => e.sopCode === sopCode);

  const counts = useMemo(() => ({
    eligible: employees.filter((e) => e.hasLmsAccess).length,
    noAccess: employees.filter((e) => !e.hasLmsAccess).length,
    roster: employees.filter((e) => e.onRoster).length,
    matrix: employees.filter((e) => e.inTrainingMatrix).length,
  }), [employees]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (filter === 'eligible' && !e.hasLmsAccess) return false;
      if (filter === 'roster' && !e.onRoster) return false;
      if (filter === 'matrix' && !e.inTrainingMatrix) return false;
      if (q && !`${e.name} ${e.designation} ${e.department} ${e.employeeCode ?? ''}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [employees, filter, search]);

  // Never keep a selection the trainer can no longer legitimately save.
  const selectable = useMemo(
    () => new Set(employees.filter((e) => e.hasLmsAccess).map((e) => e.employeeId)),
    [employees],
  );
  const effectiveSelection = useMemo(
    () => [...selected].filter((id) => selectable.has(id)),
    [selected, selectable],
  );
  const droppedCount = selected.size - effectiveSelection.length;

  const toggle = (emp: SchedulableEmployee) => {
    if (!emp.hasLmsAccess) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(emp.employeeId)) next.delete(emp.employeeId);
      else next.add(emp.employeeId);
      return next;
    });
  };

  const submit = async () => {
    if (effectiveSelection.length === 0 || !sopCode || !deadline) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/lms/trainer/scheduled-exams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeIds: effectiveSelection,
          sopCode,
          scheduledDate: deadline,
          month,
          year,
          notes: notes.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to schedule exam');
      onScheduled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to schedule exam');
    } finally {
      setSaving(false);
    }
  };

  const deadlineOutsideMonth = useMemo(() => {
    if (!deadline) return false;
    const [y, m] = deadline.split('-').map(Number);
    return y !== year || m !== month;
  }, [deadline, year, month]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !saving && onClose()}>
      <div
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-5 py-3">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Schedule monthly training exam</h2>
            <p className="text-[11px] text-gray-500">
              Pick the exam and month, then select the employees who must complete it.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b border-red-100 bg-red-50 px-5 py-2 text-xs text-red-700">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </div>
        )}

        <div className="flex-1 space-y-4 overflow-auto px-5 py-4">
          {/* Step 1 — what and when */}
          <section className="rounded-xl border border-gray-200 bg-gray-50/60 p-3">
            <p className="mb-2 inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">
              <CalendarDays className="h-3.5 w-3.5" /> Step 1 · Exam and month
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 lg:col-span-2">
                Exam (SOP)
                <select
                  value={sopCode}
                  onChange={(e) => setSopCode(e.target.value)}
                  disabled={examsLoading}
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-gray-800"
                >
                  <option value="">{examsLoading ? 'Loading exams…' : 'Select an exam…'}</option>
                  {exams.map((e) => (
                    <option key={e.sopCode} value={e.sopCode}>
                      {e.sopCode} — {e.sopName} ({e.department})
                    </option>
                  ))}
                </select>
              </label>

              <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Training month
                <div className="mt-1 flex gap-1.5">
                  <select
                    value={month}
                    onChange={(e) => setMonth(Number(e.target.value))}
                    className="w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm font-normal normal-case tracking-normal text-gray-800"
                  >
                    {MONTHS_FULL.map((m, i) => (
                      <option key={m} value={i + 1}>{m}</option>
                    ))}
                  </select>
                  <select
                    value={year}
                    onChange={(e) => setYear(Number(e.target.value))}
                    className="rounded-lg border border-gray-200 bg-white px-2 py-2 text-sm font-normal tracking-normal text-gray-800"
                  >
                    {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
                      <option key={y} value={y}>{y}</option>
                    ))}
                  </select>
                </div>
              </label>

              <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                Complete by
                <input
                  type="date"
                  value={deadline}
                  onChange={(e) => setDeadlineOverride(e.target.value || null)}
                  className="mt-1 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-normal tracking-normal text-gray-800"
                />
              </label>
            </div>

            {deadlineOutsideMonth && (
              <p className="mt-2 text-[11px] text-amber-700">
                The deadline falls outside {MONTHS_FULL[month - 1]} {year}. The exam still counts
                towards {MONTHS_FULL[month - 1]} on the monthly board.
              </p>
            )}

            {selectedExam && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-600">
                <span>{selectedExam.questionCount} questions in bank</span>
                <span>·</span>
                <span>{selectedExam.examQuestionCount} per attempt</span>
                <span>·</span>
                <span>Pass {selectedExam.passingScore}%</span>
                {selectedExam.lmsApproved ? (
                  <span className="inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 font-bold text-green-700">
                    <CheckCircle2 className="h-3 w-3" /> Approved
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 font-bold text-amber-700">
                    <AlertCircle className="h-3 w-3" /> Not fully checked in MCQ Bank
                  </span>
                )}
              </div>
            )}
          </section>

          {/* Step 2 — who */}
          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-gray-500">
                <Users className="h-3.5 w-3.5" /> Step 2 · Employees
                <span className="font-semibold normal-case tracking-normal text-purple-700">
                  {effectiveSelection.length} selected
                </span>
              </p>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const e of visible) if (e.hasLmsAccess) next.add(e.employeeId);
                      return next;
                    })
                  }
                  className="rounded border border-gray-200 px-2 py-1 text-[10px] font-semibold text-gray-600 hover:bg-gray-50"
                >
                  Select shown
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="rounded border border-gray-200 px-2 py-1 text-[10px] font-semibold text-gray-600 hover:bg-gray-50"
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {([
                { id: 'eligible', label: `Eligible (${counts.eligible})` },
                { id: 'roster', label: `My employees (${counts.roster})` },
                { id: 'matrix', label: `On training matrix (${counts.matrix})` },
                { id: 'all', label: `All in department (${employees.length})` },
              ] as const).map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setFilter(f.id)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    filter === f.id
                      ? 'bg-purple-600 text-white'
                      : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {f.label}
                </button>
              ))}
              <div className="relative ml-auto min-w-48 flex-1 max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search employee…"
                  className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-xs focus:border-purple-300 focus:outline-none"
                />
              </div>
            </div>

            {counts.noAccess > 0 && filter !== 'eligible' && (
              <p className="mb-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                <Lock className="mt-0.5 h-3 w-3 shrink-0" />
                {counts.noAccess} employee(s) have no learning-module login and cannot be
                scheduled. Generate their credentials on the Employees page first.
              </p>
            )}

            <div className="max-h-72 overflow-auto rounded-lg border border-gray-200">
              {peopleLoading ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
                </div>
              ) : visible.length === 0 ? (
                <p className="py-10 text-center text-xs text-gray-400">
                  No employees match this filter.
                </p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 z-10 border-b border-gray-100 bg-gray-50">
                    <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                      <th className="w-8 px-3 py-2" />
                      <th className="px-3 py-2">Employee</th>
                      <th className="px-3 py-2">Designation</th>
                      <th className="px-3 py-2">Department</th>
                      <th className="px-3 py-2">Status for this exam</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visible.map((e) => (
                      <tr
                        key={e.employeeId}
                        onClick={() => toggle(e)}
                        className={
                          e.hasLmsAccess
                            ? `cursor-pointer hover:bg-gray-50 ${
                                selected.has(e.employeeId) ? 'bg-purple-50/60' : ''
                              }`
                            : 'bg-gray-50/60 opacity-70'
                        }
                      >
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            readOnly
                            disabled={!e.hasLmsAccess}
                            checked={selected.has(e.employeeId) && e.hasLmsAccess}
                            className="h-3.5 w-3.5 rounded border-gray-300"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-semibold text-gray-800">{e.name}</p>
                          {e.employeeCode && (
                            <p className="text-[10px] text-gray-400">{e.employeeCode}</p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-900">{e.designation || '—'}</td>
                        <td className="px-3 py-2 text-gray-500">{e.department}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap gap-1">
                            {!e.hasLmsAccess && (
                              <Badge className="bg-red-100 text-red-700">
                                {e.lmsAccessIssue === 'no-password' ? 'No LMS password' : 'No LMS login'}
                              </Badge>
                            )}
                            {e.completed && <Badge className="bg-green-100 text-green-700">Already passed</Badge>}
                            {e.alreadyScheduled && (
                              <Badge className="bg-indigo-100 text-indigo-700">
                                Scheduled {e.scheduledDate}
                              </Badge>
                            )}
                            {e.inTrainingMatrix && !e.alreadyScheduled && (
                              <Badge className="bg-sky-100 text-sky-700">On matrix</Badge>
                            )}
                            {e.onRoster && <Badge className="bg-purple-100 text-purple-700">My employee</Badge>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Note (optional)
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Shown on the trainer dashboard"
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-normal normal-case tracking-normal text-gray-800"
              />
            </label>
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3">
          <p className="text-[11px] text-gray-500">
            {effectiveSelection.length > 0 && sopCode && deadline ? (
              <>
                <strong className="text-gray-700">{effectiveSelection.length}</strong> employee
                {effectiveSelection.length === 1 ? '' : 's'} must complete{' '}
                <strong className="text-gray-700">{sopCode}</strong> by{' '}
                <strong className="text-gray-700">{deadline}</strong> ({MONTHS_FULL[month - 1]} {year}).
                {droppedCount > 0 && (
                  <span className="text-amber-700"> {droppedCount} without LMS access skipped.</span>
                )}
              </>
            ) : (
              'Choose an exam, a month and at least one eligible employee.'
            )}
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={saving || effectiveSelection.length === 0 || !sopCode || !deadline}
              className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
            >
              {saving ? 'Scheduling…' : 'Schedule exam'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${className}`}>{children}</span>
  );
}
