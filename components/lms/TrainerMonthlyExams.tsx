'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, CalendarPlus, CheckCircle2, ChevronDown, Clock, Loader2,
  RefreshCw, Search, Trash2, X,
} from 'lucide-react';
import { ScheduleExamModal } from '@/components/lms/ScheduleExamModal';

export type ExamStatus = 'completed' | 'pending' | 'overdue';

export interface MonthlyExamRow {
  key: string;
  employeeId: string;
  employeeName: string;
  designation: string;
  department: string;
  sopCode: string;
  sopName: string;
  sopNameGujarati?: string;
  month: number;
  year: number;
  scheduledDate?: string;
  status: ExamStatus;
  scheduleStatus: string;
  isIgnored: boolean;
  completedDate?: string;
  score?: number;
  progressPct: number;
  daysOverdue: number;
  source: 'trainer' | 'matrix';
  scheduleId?: string;
  scheduledBy?: string;
  onRoster: boolean;
  hasLmsAccess: boolean;
}

interface MonthlyPayload {
  trainer: { id: string; name: string; department: string; trainerDepartments: string[] };
  trainingCycleStart: string;
  year: number;
  currentMonth: number;
  currentYear: number;
  includeIgnored: boolean;
  rows: MonthlyExamRow[];
  monthCounts: Array<{
    total: number; completed: number; pending: number; overdue: number; ignored: number;
  }>;
  totals: {
    total: number; completed: number; pending: number; overdue: number;
    ignored: number; scheduled: number;
  };
  filters: {
    departments: string[];
    designations: string[];
    exams: Array<{ sopCode: string; sopName: string }>;
    years: number[];
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const STATUS_CHIP: Record<ExamStatus, string> = {
  completed: 'bg-green-100 text-green-700',
  pending: 'bg-amber-100 text-amber-800',
  overdue: 'bg-red-100 text-red-700',
};

const STATUS_LABEL: Record<ExamStatus, string> = {
  completed: 'Completed',
  pending: 'Pending',
  overdue: 'Overdue',
};

export function TrainerMonthlyExams({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [data, setData] = useState<MonthlyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Land on "what is due right now" rather than the whole year.
  const [year, setYear] = useState<number | 'all'>(new Date().getFullYear());
  const [monthFilter, setMonthFilter] = useState<number | 'all'>(new Date().getMonth() + 1);
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [dept, setDept] = useState('All');
  const [designation, setDesignation] = useState('All');
  const [examFilter, setExamFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState<ExamStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [groupByEmployee, setGroupByEmployee] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (dept !== 'All') qs.set('department', dept);
      qs.set('year', year === 'all' ? 'all' : String(year));
      if (includeIgnored) qs.set('includeIgnored', '1');
      const res = await fetch(`/api/lms/trainer/monthly?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (res.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (!res.ok) throw new Error(json.error || 'Failed to load monthly exams');
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [dept, year, includeIgnored, onUnauthorized]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => {
      if (monthFilter !== 'all' && r.month !== monthFilter) return false;
      if (designation !== 'All' && r.designation !== designation) return false;
      if (examFilter !== 'All' && r.sopCode !== examFilter) return false;
      // A pre-cycle exam is not pending/overdue work — keep it out of those tabs.
      if (statusFilter !== 'all' && (r.isIgnored || r.status !== statusFilter)) return false;
      if (q && !`${r.employeeName} ${r.designation} ${r.sopCode} ${r.sopName}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [data, monthFilter, designation, examFilter, statusFilter, search]);

  const byEmployee = useMemo(() => {
    const map = new Map<string, {
      employeeId: string;
      employeeName: string;
      designation: string;
      department: string;
      hasLmsAccess: boolean;
      rows: MonthlyExamRow[];
      completed: number;
      pending: number;
      overdue: number;
      ignored: number;
    }>();
    for (const r of rows) {
      let entry = map.get(r.employeeId);
      if (!entry) {
        entry = {
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          designation: r.designation,
          department: r.department,
          hasLmsAccess: r.hasLmsAccess,
          rows: [],
          completed: 0,
          pending: 0,
          overdue: 0,
          ignored: 0,
        };
        map.set(r.employeeId, entry);
      }
      entry.rows.push(r);
      if (r.isIgnored) entry.ignored++;
      else entry[r.status]++;
    }
    return [...map.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  }, [rows]);

  const visibleTotals = useMemo(() => {
    const t = { total: 0, completed: 0, pending: 0, overdue: 0, ignored: 0 };
    for (const r of rows) {
      // Pre-cycle exams are never "work due" — they get their own tally.
      if (r.isIgnored) {
        t.ignored++;
        continue;
      }
      t.total++;
      t[r.status]++;
    }
    return t;
  }, [rows]);

  const cancelSchedule = async (row: MonthlyExamRow) => {
    if (!row.scheduleId) return;
    if (!window.confirm(`Cancel the scheduled exam ${row.sopCode} for ${row.employeeName}?`)) return;
    setBusyId(row.scheduleId);
    try {
      const res = await fetch(
        `/api/lms/trainer/scheduled-exams?id=${encodeURIComponent(row.scheduleId)}`,
        { method: 'DELETE' },
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to cancel');
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to cancel');
    } finally {
      setBusyId('');
    }
  };

  const monthCounts = data?.monthCounts ?? [];

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {/* Month strip — exam count per month, click to filter */}
      <div className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Exams scheduled per month
              {year !== 'all' && <span className="ml-1 text-gray-400">· {year}</span>}
            </p>
            <p className="text-[10px] text-gray-400">
              Matches each employee&apos;s LMS: green completed · amber pending · red overdue.
              {data?.trainingCycleStart && ` Training cycle starts ${data.trainingCycleStart}.`}
              {(data?.totals.ignored ?? 0) > 0 && !includeIgnored && (
                <span> {data?.totals.ignored} pre-cycle exam(s) hidden.</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-gray-600">
              <input
                type="checkbox"
                checked={includeIgnored}
                onChange={(e) => setIncludeIgnored(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300"
              />
              Show pre-cycle (ignored)
            </label>
            <button
              type="button"
              onClick={() => setScheduleOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-purple-700"
            >
              <CalendarPlus className="h-3.5 w-3.5" /> Schedule exam
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded-lg border border-gray-200 p-1.5 text-gray-400 hover:bg-gray-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 lg:grid-cols-13">
          <button
            type="button"
            onClick={() => setMonthFilter('all')}
            className={`rounded-lg border px-2 py-2 text-center transition ${
              monthFilter === 'all'
                ? 'border-purple-500 bg-purple-50 ring-1 ring-purple-300'
                : 'border-gray-200 hover:bg-gray-50'
            }`}
          >
            <p className="text-sm font-bold text-gray-800">{data?.totals.total ?? 0}</p>
            <p className="text-[10px] text-gray-500">All</p>
          </button>
          {MONTHS.map((m, i) => {
            const c = monthCounts[i] || {
              total: 0, completed: 0, pending: 0, overdue: 0, ignored: 0,
            };
            const active = monthFilter === i + 1;
            const isCurrent =
              data?.currentMonth === i + 1 &&
              (year === 'all' || year === data?.currentYear);
            return (
              <button
                key={m}
                type="button"
                onClick={() => setMonthFilter(active ? 'all' : i + 1)}
                className={`rounded-lg border px-2 py-2 text-center transition ${
                  active
                    ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300'
                    : isCurrent
                      ? 'border-indigo-200 bg-indigo-50/40 hover:bg-indigo-50'
                      : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <p className="text-sm font-bold text-gray-800">{c.total}</p>
                <p className="text-[10px] font-semibold text-gray-500">
                  {m}
                  {isCurrent && <span className="ml-0.5 text-indigo-500">•</span>}
                </p>
                {c.total > 0 && (
                  <p className="mt-0.5 text-[9px] leading-tight">
                    <span className="text-green-600">{c.completed}</span>
                    {' · '}
                    <span className="text-amber-600">{c.pending}</span>
                    {' · '}
                    <span className="text-red-600">{c.overdue}</span>
                  </p>
                )}
                {includeIgnored && c.ignored > 0 && (
                  <p className="text-[9px] leading-tight text-gray-400">{c.ignored} ignored</p>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Status tiles — scoped to the month/filters currently in view */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {([
          {
            id: 'all',
            label: monthFilter === 'all' ? 'Exams in view' : `Exams in ${MONTHS_FULL[monthFilter - 1]}`,
            value: visibleTotals.total,
            Icon: Clock,
            color: 'text-gray-600',
            bg: 'bg-gray-50',
          },
          { id: 'completed', label: 'Completed', value: visibleTotals.completed, Icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50' },
          { id: 'pending', label: 'Pending', value: visibleTotals.pending, Icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
          { id: 'overdue', label: 'Overdue', value: visibleTotals.overdue, Icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-50' },
        ] as const).map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() =>
              setStatusFilter((prev) => (s.id === 'all' || prev === s.id ? 'all' : (s.id as ExamStatus)))
            }
            className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left transition ${s.bg} ${
              statusFilter === s.id ? 'border-transparent ring-2 ring-purple-400' : 'border-gray-200'
            }`}
          >
            <s.Icon className={`h-4 w-4 ${s.color}`} />
            <div>
              <p className="text-lg font-bold leading-none text-gray-800">{s.value}</p>
              <p className="mt-0.5 text-[10px] text-gray-500">{s.label}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1 max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search employee or exam…"
            className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-8 text-xs focus:border-purple-300 focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <FilterSelect value={dept} onChange={setDept} options={data?.filters.departments ?? []} allLabel="All departments" />
        <FilterSelect value={designation} onChange={setDesignation} options={data?.filters.designations ?? []} allLabel="All designations" />
        <div className="relative">
          <select
            value={examFilter}
            onChange={(e) => setExamFilter(e.target.value)}
            className="max-w-[16rem] appearance-none truncate rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-7 text-xs font-medium text-gray-600"
          >
            <option value="All">All exams</option>
            {(data?.filters.exams ?? []).map((e) => (
              <option key={e.sopCode} value={e.sopCode}>
                {e.sopCode} — {e.sopName}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        </div>
        <div className="relative">
          <select
            value={String(year)}
            onChange={(e) => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            className="appearance-none rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-7 text-xs font-medium text-gray-600"
          >
            <option value="all">All years</option>
            {(data?.filters.years ?? []).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        </div>

        <label className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-600">
          <input
            type="checkbox"
            checked={groupByEmployee}
            onChange={(e) => setGroupByEmployee(e.target.checked)}
            className="h-3.5 w-3.5 rounded border-gray-300"
          />
          Group by employee
        </label>
      </div>

      {loading && !data ? (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-gray-200 bg-white py-16 text-center">
          <p className="text-sm text-gray-400">No exams match these filters.</p>
          <button
            type="button"
            onClick={() => setScheduleOpen(true)}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-purple-700"
          >
            <CalendarPlus className="h-3.5 w-3.5" /> Schedule an exam
          </button>
        </div>
      ) : groupByEmployee ? (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="max-h-[calc(100vh-24rem)] overflow-auto">
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
                <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  <th className="px-3 py-2.5">Employee</th>
                  <th className="px-3 py-2.5">Designation</th>
                  <th className="px-3 py-2.5">Department</th>
                  <th className="px-3 py-2.5 text-right">Exams</th>
                  <th className="px-3 py-2.5 text-right">Completed</th>
                  <th className="px-3 py-2.5 text-right">Pending</th>
                  <th className="px-3 py-2.5 text-right">Overdue</th>
                  <th className="px-3 py-2.5 w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {byEmployee.map((emp) => {
                  const open = expanded === emp.employeeId;
                  return (
                    <Fragment key={emp.employeeId}>
                      <tr
                        className="cursor-pointer hover:bg-gray-50"
                        onClick={() => setExpanded(open ? null : emp.employeeId)}
                      >
                        <td className="px-3 py-2.5 font-semibold text-gray-900">
                          {emp.employeeName}
                          {!emp.hasLmsAccess && (
                            <span
                              className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[9px] font-bold text-red-700"
                              title="No learning-module login — this employee cannot take the exam"
                            >
                              No LMS login
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-gray-600">{emp.designation || '—'}</td>
                        <td className="px-3 py-2.5 text-gray-600">{emp.department}</td>
                        <td className="px-3 py-2.5 text-right font-semibold tabular-nums">
                          {emp.completed + emp.pending + emp.overdue}
                          {emp.ignored > 0 && (
                            <span className="ml-1 font-normal text-gray-400">+{emp.ignored}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-green-700">{emp.completed}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-amber-700">{emp.pending}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-red-600">{emp.overdue}</td>
                        <td className="px-3 py-2.5">
                          <ChevronDown className={`h-4 w-4 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-gray-50/80">
                          <td colSpan={8} className="px-3 py-2">
                            <ExamTable rows={emp.rows} onCancel={cancelSchedule} busyId={busyId} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="max-h-[calc(100vh-24rem)] overflow-auto">
            <ExamTable rows={rows} onCancel={cancelSchedule} busyId={busyId} showEmployee />
          </div>
        </div>
      )}

      {scheduleOpen && (
        <ScheduleExamModal
          onClose={() => setScheduleOpen(false)}
          onScheduled={() => {
            setScheduleOpen(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  allLabel: string;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-7 text-xs font-medium text-gray-600"
      >
        <option value="All">{allLabel}</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
    </div>
  );
}

function ExamTable({
  rows,
  onCancel,
  busyId,
  showEmployee = false,
}: {
  rows: MonthlyExamRow[];
  onCancel: (row: MonthlyExamRow) => void | Promise<void>;
  busyId: string;
  showEmployee?: boolean;
}) {
  return (
    <div className={showEmployee ? '' : 'overflow-auto rounded-lg border border-gray-200 bg-white'}>
      <table className="w-full min-w-[1000px] text-left text-xs">
        <thead className={`border-b border-gray-100 bg-gray-50 ${showEmployee ? 'sticky top-0 z-10' : ''}`}>
          <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            {showEmployee && <th className="px-3 py-2">Employee</th>}
            {showEmployee && <th className="px-3 py-2">Designation</th>}
            {showEmployee && <th className="px-3 py-2">Dept</th>}
            <th className="px-3 py-2">Exam / SOP</th>
            <th className="px-3 py-2">Month</th>
            <th className="px-3 py-2">Scheduled date</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Completed on</th>
            <th className="px-3 py-2">Score</th>
            <th className="px-3 py-2">Progress</th>
            <th className="px-3 py-2">Source</th>
            <th className="px-3 py-2 w-10" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-gray-50/80">
              {showEmployee && (
                <td className="px-3 py-2 font-semibold text-gray-900">
                  {r.employeeName}
                  {!r.hasLmsAccess && (
                    <span
                      className="ml-1.5 rounded bg-red-100 px-1 py-0.5 text-[9px] font-bold text-red-700"
                      title="No learning-module login — this employee cannot take the exam"
                    >
                      No LMS login
                    </span>
                  )}
                </td>
              )}
              {showEmployee && <td className="px-3 py-2 text-gray-600">{r.designation || '—'}</td>}
              {showEmployee && <td className="px-3 py-2 text-gray-600">{r.department}</td>}
              <td className="px-3 py-2">
                <p className="font-mono text-[11px] font-bold text-purple-700">{r.sopCode}</p>
                <p className="max-w-sm truncate text-gray-700" title={r.sopName}>{r.sopName}</p>
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                {MONTHS_FULL[r.month - 1]} {r.year}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                {r.scheduledDate || <span className="text-gray-400">Not set</span>}
              </td>
              <td className="px-3 py-2">
                {r.isIgnored ? (
                  <span
                    className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600"
                    title="Scheduled before the active training cycle — shown as Ignored in the employee's LMS"
                  >
                    Ignored
                  </span>
                ) : (
                  <>
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_CHIP[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                    {r.status === 'overdue' && r.daysOverdue > 0 && (
                      <span className="ml-1 text-[10px] text-red-500">+{r.daysOverdue}d</span>
                    )}
                  </>
                )}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-600">{r.completedDate || '—'}</td>
              <td className="px-3 py-2 tabular-nums text-gray-700">
                {typeof r.score === 'number' ? `${r.score}%` : '—'}
              </td>
              <td className="px-3 py-2">
                <div className="flex min-w-[6rem] items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
                    <div className="h-full rounded-full bg-purple-500" style={{ width: `${r.progressPct}%` }} />
                  </div>
                  <span className="w-8 text-right tabular-nums text-gray-500">{r.progressPct}%</span>
                </div>
              </td>
              <td className="px-3 py-2">
                {r.source === 'trainer' ? (
                  <span
                    className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700"
                    title={r.scheduledBy ? `Scheduled by ${r.scheduledBy}` : undefined}
                  >
                    Scheduled
                  </span>
                ) : (
                  <span className="text-[10px] text-gray-400">Matrix</span>
                )}
              </td>
              <td className="px-3 py-2">
                {r.scheduleId && (
                  <button
                    type="button"
                    onClick={() => void onCancel(r)}
                    disabled={busyId === r.scheduleId}
                    title="Cancel scheduled exam"
                    className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
