'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Calendar, CalendarRange, CheckCircle2, ChevronDown, ClipboardList, Loader2,
  RefreshCw, Search, Settings2, UserCheck, UserCog, Users, X, AlertCircle, Clock, EyeOff,
} from 'lucide-react';
import {
  SopExamSettingsPanel,
  type SopExamSettingsApiPaths,
} from '@/components/lms/SopExamSettingsPanel';
import { TrainerMonthlyExams, DeptFilterBtn } from '@/components/lms/TrainerMonthlyExams';
import { TrainerRosterPanel } from '@/components/lms/TrainerRosterPanel';
import { TrainerAttendancePanel } from '@/components/lms/TrainerAttendancePanel';

type ScheduleStatus = 'ignored' | 'upcoming' | 'due' | 'overdue' | 'missed';
type SopStatus = 'completed' | 'not_completed';
type ViewMode = 'monthly' | 'employee' | 'sop' | 'roster' | 'attendance' | 'exams';
type StatusFilter = 'all' | 'due' | 'overdue' | 'completed' | 'ignored' | 'upcoming' | 'pending';

interface TrainerSopRow {
  sopCode: string;
  sopKey: string;
  sopName: string;
  sopNameGujarati?: string;
  status: SopStatus;
  scheduleStatus: ScheduleStatus;
  months: number[];
  year: number;
  examDate?: string;
  hasExam: boolean;
  /** Languages the exam can be taken in — Gujarati appears once translations exist. */
  examLanguages?: Array<'en' | 'gu'>;
  progressPct: number;
}

interface TrainerEmployeeRecord {
  employeeId: string;
  employeeName: string;
  designation: string;
  department: string;
  isActive: boolean;
  isTrainer: boolean;
  totalSops: number;
  completedSops: number;
  notCompletedSops: number;
  dueSops: number;
  overdueSops: number;
  ignoredSops: number;
  upcomingSops: number;
  overallPct: number;
  sops: TrainerSopRow[];
}

interface DashboardPayload {
  trainer: {
    id: string;
    name: string;
    department: string;
    trainerDepartments: string[];
    /** Scope came from the Super Admin / SOP Admin role — every department. */
    allDepartments?: boolean;
  };
  trainingCycleStart: string;
  records: TrainerEmployeeRecord[];
  monthExamCounts: number[];
  statusTotals: {
    due: number;
    overdue: number;
    completed: number;
    ignored: number;
    upcoming: number;
    notCompleted: number;
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const TRAINER_EXAM_API: SopExamSettingsApiPaths = {
  settings: '/api/lms/trainer/exam-settings',
  metaForSop: (sopCode) => `/api/lms/trainer/meta?sopCode=${encodeURIComponent(sopCode)}`,
};

const STATUS_CHIP: Record<string, string> = {
  completed: 'bg-green-100 text-green-700',
  due: 'bg-amber-100 text-amber-800',
  overdue: 'bg-red-100 text-red-700',
  missed: 'bg-red-100 text-red-700',
  ignored: 'bg-gray-100 text-gray-600',
  upcoming: 'bg-sky-100 text-sky-700',
  not_completed: 'bg-violet-100 text-violet-700',
};

function statusLabel(s: string): string {
  if (s === 'not_completed') return 'Pending';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function LmsTrainerPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('monthly');
  const [dept, setDept] = useState('All');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  /** Empty = all months. Matrix views can multi-select. */
  const [monthFilter, setMonthFilter] = useState<number[]>([]);
  const [search, setSearch] = useState('');
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<{
    employeeId: string;
    employeeName: string;
    department: string;
    sopCode: string;
    sopName: string;
    plannedMonth: number;
    year: number;
    examDate?: string;
  } | null>(null);
  const [assignDate, setAssignDate] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    try {
      const q = dept !== 'All' ? `?department=${encodeURIComponent(dept)}` : '';
      const res = await fetch(`/api/lms/trainer/dashboard${q}`, { cache: 'no-store' });
      const json = await res.json();
      if (res.status === 401) {
        router.push('/lms');
        return;
      }
      if (res.status === 403) {
        setError('Trainer access required. Ask an admin to enable Trainer on your employee profile.');
        setData(null);
        return;
      }
      if (!res.ok) throw new Error(json.error || 'Failed to load trainer dashboard');
      setData(json);
      void force;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [dept, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const records = data?.records ?? [];
  const depts = data?.trainer.trainerDepartments ?? [];
  // Training-matrix roll-up views share the status tiles, month chips and filters;
  // the monthly board, roster and exam settings own their controls.
  const isMatrixView = viewMode === 'employee' || viewMode === 'sop';

  const filteredEmployees = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records.filter((r) => {
      if (r.isTrainer) return false;
      if (dept !== 'All' && r.department !== dept) return false;
      if (monthFilter.length > 0 && !r.sops.some((s) => s.months.some((m) => monthFilter.includes(m)))) return false;
      if (statusFilter === 'pending' && r.notCompletedSops <= 0) return false;
      if (statusFilter === 'completed' && r.completedSops <= 0) return false;
      if (statusFilter === 'due' && r.dueSops <= 0) return false;
      if (statusFilter === 'overdue' && r.overdueSops <= 0) return false;
      if (statusFilter === 'ignored' && r.ignoredSops <= 0) return false;
      if (statusFilter === 'upcoming' && r.upcomingSops <= 0) return false;
      if (q && !`${r.employeeName} ${r.designation} ${r.department}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [records, dept, monthFilter, statusFilter, search]);

  const sopRows = useMemo(() => {
    const byKey = new Map<string, {
      sopKey: string;
      sopCode: string;
      sopName: string;
      department: string;
      assigned: number;
      completed: number;
      pending: number;
      due: number;
      overdue: number;
      ignored: number;
      upcoming: number;
      months: number[];
      employees: Array<{
        employeeId: string;
        employeeName: string;
        department: string;
        status: SopStatus;
        scheduleStatus: ScheduleStatus;
        progressPct: number;
        examDate?: string;
        year: number;
        month: number;
      }>;
    }>();

    for (const r of records) {
      if (r.isTrainer) continue;
      if (dept !== 'All' && r.department !== dept) continue;
      for (const s of r.sops) {
        if (monthFilter.length > 0 && !s.months.some((m) => monthFilter.includes(m))) continue;
        if (statusFilter === 'completed' && s.status !== 'completed') continue;
        if (statusFilter === 'pending' && s.status === 'completed') continue;
        if (statusFilter === 'due' && (s.status === 'completed' || s.scheduleStatus !== 'due')) continue;
        if (statusFilter === 'overdue' && (s.status === 'completed' || (s.scheduleStatus !== 'overdue' && s.scheduleStatus !== 'missed'))) continue;
        if (statusFilter === 'ignored' && (s.status === 'completed' || s.scheduleStatus !== 'ignored')) continue;
        if (statusFilter === 'upcoming' && (s.status === 'completed' || s.scheduleStatus !== 'upcoming')) continue;

        let row = byKey.get(s.sopKey);
        if (!row) {
          row = {
            sopKey: s.sopKey,
            sopCode: s.sopCode,
            sopName: s.sopName,
            department: r.department,
            assigned: 0,
            completed: 0,
            pending: 0,
            due: 0,
            overdue: 0,
            ignored: 0,
            upcoming: 0,
            months: [...s.months],
            employees: [],
          };
          byKey.set(s.sopKey, row);
        } else if (s.months.length) {
          row.months = [...new Set([...row.months, ...s.months])].sort((a, b) => a - b);
        }

        // One row per employee per SOP family — avoid duplicate keys when
        // versioned codes (PREO2 / PREO2-00) collapse to the same sopKey.
        if (row.employees.some((e) => e.employeeId === r.employeeId)) continue;

        row.assigned++;
        if (s.status === 'completed') row.completed++;
        else {
          row.pending++;
          if (s.scheduleStatus === 'due') row.due++;
          if (s.scheduleStatus === 'overdue' || s.scheduleStatus === 'missed') row.overdue++;
          if (s.scheduleStatus === 'ignored') row.ignored++;
          if (s.scheduleStatus === 'upcoming') row.upcoming++;
        }
        row.employees.push({
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          department: r.department,
          status: s.status,
          scheduleStatus: s.scheduleStatus,
          progressPct: s.progressPct,
          examDate: s.examDate,
          year: s.year,
          month: s.months[0] ?? 1,
        });
      }
    }

    const q = search.trim().toLowerCase();
    return [...byKey.values()]
      .filter((row) => !q || `${row.sopCode} ${row.sopName}`.toLowerCase().includes(q))
      .sort((a, b) => a.sopCode.localeCompare(b.sopCode));
  }, [records, dept, monthFilter, statusFilter, search]);

  const totals = data?.statusTotals;

  const openAssign = (target: NonNullable<typeof assignTarget>) => {
    setAssignTarget(target);
    setAssignDate(target.examDate || '');
  };

  const saveAssign = async () => {
    if (!assignTarget || !assignDate) return;
    setAssignBusy(true);
    try {
      const res = await fetch('/api/lms/trainer/exam-date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: assignTarget.employeeId,
          sopCode: assignTarget.sopCode,
          department: assignTarget.department,
          plannedMonth: assignTarget.plannedMonth,
          year: assignTarget.year,
          examDate: assignDate,
          allowOutsideMonth: true,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to assign date');
      setAssignTarget(null);
      await load(true);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to assign date');
    } finally {
      setAssignBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto w-full max-w-[1920px] px-3 py-2 sm:px-5">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 shrink-0 items-center gap-3">
              <Link href="/lms" className="flex shrink-0 items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800">
                <ArrowLeft className="h-3.5 w-3.5" /> My Training
              </Link>
              <div className="h-4 w-px shrink-0 bg-gray-200" />
              <div className="min-w-0">
                <h1 className="text-sm font-bold tracking-tight text-gray-900">Trainer View</h1>
                {data && (
                  <p className="mt-0.5 truncate text-[11px] text-gray-400">
                    {data.trainer.name}
                    {data.trainingCycleStart ? ` · Cycle from ${data.trainingCycleStart}` : ''}
                  </p>
                )}
              </div>
            </div>
            {depts.length > 1 && (
              <div className="min-w-0 flex-1">
                <DeptFilterBtn value={dept} onChange={setDept} departments={depts} />
              </div>
            )}
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={loading}
              className="shrink-0 rounded-lg border border-gray-200 p-1.5 text-gray-400 hover:bg-gray-50"
              title="Refresh"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="mt-2 overflow-x-auto">
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
              {([
                { id: 'monthly', label: 'Monthly Exams', Icon: CalendarRange },
                { id: 'employee', label: 'By Employee', Icon: Users },
                { id: 'sop', label: 'By SOP', Icon: ClipboardList },
                { id: 'roster', label: 'My Employees', Icon: UserCog },
                { id: 'attendance', label: 'Attendance', Icon: UserCheck },
                { id: 'exams', label: 'Exam Settings', Icon: Settings2 },
              ] as const).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setViewMode(v.id)}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition ${
                    viewMode === v.id ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  <v.Icon className="h-3.5 w-3.5" /> {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1920px] space-y-4 px-3 py-5 sm:px-5">
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {loading && !data ? (
          <div className="flex justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
          </div>
        ) : data ? (
          <>
            {/* Status totals — training-matrix roll-up, not the exam board */}
            {isMatrixView && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {([
                { id: 'all', label: 'Pending', value: totals?.notCompleted ?? 0, Icon: ClipboardList, color: 'text-violet-600', bg: 'bg-violet-50' },
                { id: 'due', label: 'Due', value: totals?.due ?? 0, Icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
                { id: 'overdue', label: 'Overdue', value: totals?.overdue ?? 0, Icon: AlertCircle, color: 'text-red-600', bg: 'bg-red-50' },
                { id: 'completed', label: 'Completed', value: totals?.completed ?? 0, Icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50' },
                { id: 'upcoming', label: 'Upcoming', value: totals?.upcoming ?? 0, Icon: Calendar, color: 'text-sky-600', bg: 'bg-sky-50' },
                { id: 'ignored', label: 'Ignored', value: totals?.ignored ?? 0, Icon: EyeOff, color: 'text-gray-500', bg: 'bg-gray-50' },
              ] as const).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setStatusFilter((prev) => (prev === s.id ? 'all' : s.id))}
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
            )}

            {isMatrixView && (
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-52 flex-1 max-w-sm">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={viewMode === 'employee' ? 'Search employee…' : 'Search SOP…'}
                    className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-8 text-xs focus:border-purple-300 focus:outline-none"
                  />
                  {search && (
                    <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600">
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {depts.length <= 1 && (
                <div className="relative">
                  <select
                    value={dept}
                    onChange={(e) => setDept(e.target.value)}
                    className="appearance-none rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-7 text-xs font-medium text-gray-600"
                  >
                    <option value="All">All departments</option>
                    {depts.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                </div>
                )}
              </div>
            )}

            {isMatrixView && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  Unique SOP exams
                </span>
                <button
                  type="button"
                  onClick={() => setMonthFilter([])}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    monthFilter.length === 0 ? 'bg-purple-600 text-white' : 'border border-gray-200 bg-white text-gray-600'
                  }`}
                >
                  All months
                </button>
                {MONTHS.map((m, i) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMonthFilter((prev) => (
                      prev.includes(i + 1) ? prev.filter((n) => n !== i + 1) : [...prev, i + 1].sort((a, b) => a - b)
                    ))}
                    title={`${data.monthExamCounts?.[i] ?? 0} unique SOP exam(s) in ${m} — click to multi-select`}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                      monthFilter.includes(i + 1) ? 'bg-indigo-600 text-white' : 'border border-gray-200 bg-white text-gray-600'
                    }`}
                  >
                    {m}
                    <span className="ml-1 opacity-70">{data.monthExamCounts?.[i] ?? 0}</span>
                  </button>
                ))}
              </div>
            )}

            {viewMode === 'monthly' ? (
              <TrainerMonthlyExams
                dept={dept}
                onDeptChange={setDept}
                onUnauthorized={() => router.push('/lms')}
              />
            ) : viewMode === 'roster' ? (
              <TrainerRosterPanel onUnauthorized={() => router.push('/lms')} />
            ) : viewMode === 'attendance' ? (
              <TrainerAttendancePanel onUnauthorized={() => router.push('/lms')} />
            ) : viewMode === 'exams' ? (
              <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
                <p className="mb-3 text-xs text-gray-500">
                  Configure exam question counts, pass marks, shuffle, and per-employee rules for SOPs in your departments
                  (same controls as LMS Admin Exam Settings).
                </p>
                <SopExamSettingsPanel apiPaths={TRAINER_EXAM_API} />
              </div>
            ) : viewMode === 'employee' ? (
              <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                {filteredEmployees.length === 0 ? (
                  <p className="py-16 text-center text-sm text-gray-400">No employees match these filters.</p>
                ) : (
                  <div className="overflow-auto max-h-[calc(100vh-18rem)]">
                    <table className="w-full min-w-[1100px] text-left text-xs">
                      <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
                        <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                          <th className="px-3 py-2.5">Employee</th>
                          <th className="px-3 py-2.5">Designation</th>
                          <th className="px-3 py-2.5">Dept</th>
                          <th className="px-3 py-2.5 text-right">Total</th>
                          <th className="px-3 py-2.5 text-right">Done</th>
                          <th className="px-3 py-2.5 text-right">Left</th>
                          <th className="px-3 py-2.5 text-right">Due</th>
                          <th className="px-3 py-2.5 text-right">Overdue</th>
                          <th className="px-3 py-2.5 text-right">Upcoming</th>
                          <th className="px-3 py-2.5 text-right">Ignored</th>
                          <th className="px-3 py-2.5">Progress</th>
                          <th className="px-3 py-2.5 w-8" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filteredEmployees.map((emp) => {
                          const open = expandedEmp === emp.employeeId;
                          const visibleSops = emp.sops.filter((s) => {
                            if (monthFilter.length > 0 && !s.months.some((m) => monthFilter.includes(m))) return false;
                            if (statusFilter === 'completed') return s.status === 'completed';
                            if (statusFilter === 'pending') return s.status !== 'completed';
                            if (statusFilter === 'due') return s.status !== 'completed' && s.scheduleStatus === 'due';
                            if (statusFilter === 'overdue') return s.status !== 'completed' && (s.scheduleStatus === 'overdue' || s.scheduleStatus === 'missed');
                            if (statusFilter === 'ignored') return s.status !== 'completed' && s.scheduleStatus === 'ignored';
                            if (statusFilter === 'upcoming') return s.status !== 'completed' && s.scheduleStatus === 'upcoming';
                            return true;
                          });
                          return (
                            <Fragment key={emp.employeeId}>
                              <tr
                                className="cursor-pointer hover:bg-gray-50"
                                onClick={() => setExpandedEmp(open ? null : emp.employeeId)}
                              >
                                <td className="px-3 py-2.5 font-semibold text-gray-900">{emp.employeeName}</td>
                                <td className="px-3 py-2.5 text-gray-900">{emp.designation || '—'}</td>
                                <td className="px-3 py-2.5 text-gray-600">{emp.department}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-gray-800">{emp.totalSops}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums">
                                  <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
                                    {emp.completedSops}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums">
                                  <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">
                                    {emp.notCompletedSops}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-amber-700 font-semibold">{emp.dueSops}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-red-600 font-semibold">{emp.overdueSops}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-sky-700 font-semibold">{emp.upcomingSops}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-gray-500 font-semibold">{emp.ignoredSops}</td>
                                <td className="px-3 py-2.5">
                                  <div className="flex min-w-[7rem] items-center gap-2">
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
                                      <div className="h-full rounded-full bg-purple-500" style={{ width: `${emp.overallPct}%` }} />
                                    </div>
                                    <span className="w-8 text-right tabular-nums text-gray-500">{emp.overallPct}%</span>
                                  </div>
                                </td>
                                <td className="px-3 py-2.5">
                                  <ChevronDown className={`h-4 w-4 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
                                </td>
                              </tr>
                              {open && (
                                <tr className="bg-gray-50/80">
                                  <td colSpan={12} className="px-3 py-2">
                                    {visibleSops.length === 0 ? (
                                      <p className="py-3 text-center text-xs text-gray-400">No SOPs in this filter.</p>
                                    ) : (
                                      <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
                                        <table className="w-full min-w-[900px] text-left text-xs">
                                          <thead className="border-b border-gray-100 bg-gray-50">
                                            <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                                              <th className="px-3 py-2">SOP Code</th>
                                              <th className="px-3 py-2">Training Name</th>
                                              <th className="px-3 py-2">Status</th>
                                              <th className="px-3 py-2">Due Month</th>
                                              <th className="px-3 py-2">Exam Date</th>
                                              <th className="px-3 py-2">Exam</th>
                                              <th className="px-3 py-2">Progress</th>
                                              <th className="px-3 py-2">Action</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-gray-100">
                                            {visibleSops.map((s, idx) => (
                                              <tr key={`${emp.employeeId}-${s.sopKey}-${s.sopCode}-${s.year}-${s.months[0] ?? 0}-${idx}`} className="hover:bg-gray-50/80">
                                                <td className="px-3 py-2 font-mono text-[11px] font-bold text-purple-700">{s.sopCode}</td>
                                                <td className="px-3 py-2">
                                                  <p className="max-w-sm truncate font-medium text-gray-800" title={s.sopName}>{s.sopName}</p>
                                                  {s.sopNameGujarati && (
                                                    <p className="max-w-sm truncate text-[10px] text-indigo-700">{s.sopNameGujarati}</p>
                                                  )}
                                                </td>
                                                <td className="px-3 py-2">
                                                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_CHIP[s.status === 'completed' ? 'completed' : s.scheduleStatus]}`}>
                                                    {s.status === 'completed' ? 'Completed' : statusLabel(s.scheduleStatus)}
                                                  </span>
                                                </td>
                                                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                                                  {MONTHS_FULL[(s.months[0] ?? 1) - 1]} {s.year}
                                                </td>
                                                <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{s.examDate || '—'}</td>
                                                <td className="px-3 py-2">
                                                  {s.hasExam ? (
                                                    <span
                                                      className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700"
                                                      title={
                                                        s.examLanguages?.includes('gu')
                                                          ? 'Exam available in English and Gujarati'
                                                          : 'Exam available in English only — not translated yet'
                                                      }
                                                    >
                                                      {s.examLanguages?.includes('gu') ? 'EN/ગુજ' : 'EN'}
                                                    </span>
                                                  ) : (
                                                    <span className="text-gray-400">No</span>
                                                  )}
                                                </td>
                                                <td className="px-3 py-2">
                                                  <div className="flex min-w-[7rem] items-center gap-2">
                                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
                                                      <div className="h-full rounded-full bg-purple-500" style={{ width: `${s.progressPct}%` }} />
                                                    </div>
                                                    <span className="w-8 text-right tabular-nums text-gray-500">{s.progressPct}%</span>
                                                  </div>
                                                </td>
                                                <td className="px-3 py-2">
                                                  {s.status !== 'completed' && (
                                                    <button
                                                      type="button"
                                                      onClick={(e) => {
                                                        e.stopPropagation();
                                                        openAssign({
                                                          employeeId: emp.employeeId,
                                                          employeeName: emp.employeeName,
                                                          department: emp.department,
                                                          sopCode: s.sopCode,
                                                          sopName: s.sopName,
                                                          plannedMonth: s.months[0] ?? 1,
                                                          year: s.year,
                                                          examDate: s.examDate,
                                                        });
                                                      }}
                                                      className="rounded-md bg-indigo-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-indigo-700"
                                                    >
                                                      Assign date
                                                    </button>
                                                  )}
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    )}
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                {sopRows.length === 0 ? (
                  <p className="py-16 text-center text-sm text-gray-400">No SOPs match these filters.</p>
                ) : (
                  <div className="overflow-auto max-h-[calc(100vh-18rem)]">
                    <table className="w-full min-w-[1100px] text-left text-xs">
                      <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
                        <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                          <th className="px-3 py-2.5">SOP Code</th>
                          <th className="px-3 py-2.5">Training Name</th>
                          <th className="px-3 py-2.5 text-right">Assigned</th>
                          <th className="px-3 py-2.5 text-right">Done</th>
                          <th className="px-3 py-2.5 text-right">Left</th>
                          <th className="px-3 py-2.5 text-right">Due</th>
                          <th className="px-3 py-2.5 text-right">Overdue</th>
                          <th className="px-3 py-2.5 text-right">Upcoming</th>
                          <th className="px-3 py-2.5 text-right">Ignored</th>
                          <th className="px-3 py-2.5">Months</th>
                          <th className="px-3 py-2.5 w-8" />
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {sopRows.map((row) => {
                          const open = expandedEmp === `sop:${row.sopKey}`;
                          return (
                            <Fragment key={row.sopKey}>
                              <tr
                                className="cursor-pointer hover:bg-gray-50"
                                onClick={() => setExpandedEmp(open ? null : `sop:${row.sopKey}`)}
                              >
                                <td className="px-3 py-2.5 font-mono text-[11px] font-bold text-purple-700">{row.sopCode}</td>
                                <td className="px-3 py-2.5 font-semibold text-gray-900 max-w-md truncate" title={row.sopName}>{row.sopName}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{row.assigned}</td>
                                <td className="px-3 py-2.5 text-right">
                                  <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">{row.completed}</span>
                                </td>
                                <td className="px-3 py-2.5 text-right">
                                  <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-700">{row.pending}</span>
                                </td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-amber-700 font-semibold">{row.due}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-red-600 font-semibold">{row.overdue}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-sky-700 font-semibold">{row.upcoming}</td>
                                <td className="px-3 py-2.5 text-right tabular-nums text-gray-500 font-semibold">{row.ignored}</td>
                                <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">
                                  {row.months.map((m) => MONTHS[m - 1]).join(', ') || '—'}
                                </td>
                                <td className="px-3 py-2.5">
                                  <ChevronDown className={`h-4 w-4 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
                                </td>
                              </tr>
                              {open && (
                                <tr className="bg-gray-50/80">
                                  <td colSpan={11} className="px-3 py-2">
                                    <div className="overflow-auto rounded-lg border border-gray-200 bg-white">
                                      <table className="w-full min-w-[900px] text-left text-xs">
                                        <thead className="border-b border-gray-100 bg-gray-50">
                                          <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                                            <th className="px-3 py-2">Employee</th>
                                            <th className="px-3 py-2">Dept</th>
                                            <th className="px-3 py-2">Status</th>
                                            <th className="px-3 py-2">Due Month</th>
                                            <th className="px-3 py-2">Exam Date</th>
                                            <th className="px-3 py-2">Progress</th>
                                            <th className="px-3 py-2">Action</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-gray-100">
                                          {row.employees.map((e, idx) => (
                                            <tr key={`${row.sopKey}-${e.employeeId}-${e.month}-${e.year}-${idx}`} className="hover:bg-gray-50/80">
                                              <td className="px-3 py-2 font-semibold text-gray-800">{e.employeeName}</td>
                                              <td className="px-3 py-2 text-gray-600">{e.department}</td>
                                              <td className="px-3 py-2">
                                                <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_CHIP[e.status === 'completed' ? 'completed' : e.scheduleStatus]}`}>
                                                  {e.status === 'completed' ? 'Completed' : statusLabel(e.scheduleStatus)}
                                                </span>
                                              </td>
                                              <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                                                {MONTHS_FULL[e.month - 1]} {e.year}
                                              </td>
                                              <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{e.examDate || '—'}</td>
                                              <td className="px-3 py-2">
                                                <div className="flex min-w-[7rem] items-center gap-2">
                                                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
                                                    <div className="h-full rounded-full bg-purple-500" style={{ width: `${e.progressPct}%` }} />
                                                  </div>
                                                  <span className="w-8 text-right tabular-nums text-gray-500">{e.progressPct}%</span>
                                                </div>
                                              </td>
                                              <td className="px-3 py-2">
                                                {e.status !== 'completed' && (
                                                  <button
                                                    type="button"
                                                    onClick={(ev) => {
                                                      ev.stopPropagation();
                                                      openAssign({
                                                        employeeId: e.employeeId,
                                                        employeeName: e.employeeName,
                                                        department: e.department,
                                                        sopCode: row.sopCode,
                                                        sopName: row.sopName,
                                                        plannedMonth: e.month,
                                                        year: e.year,
                                                        examDate: e.examDate,
                                                      });
                                                    }}
                                                    className="rounded-md bg-indigo-600 px-2 py-1 text-[10px] font-bold text-white hover:bg-indigo-700"
                                                  >
                                                    Assign date
                                                  </button>
                                                )}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        ) : null}
      </main>

      {assignTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !assignBusy && setAssignTarget(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-bold text-gray-900">Assign LMS exam date</h2>
            <p className="mt-1 text-xs text-gray-500">
              {assignTarget.employeeName} · {assignTarget.sopCode}
            </p>
            <p className="mt-2 text-xs text-gray-600">
              Planned month: <strong>{MONTHS_FULL[assignTarget.plannedMonth - 1]} {assignTarget.year}</strong>
            </p>
            <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              Exam date
              <input
                type="date"
                value={assignDate}
                onChange={(e) => setAssignDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
              />
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={assignBusy}
                onClick={() => setAssignTarget(null)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={assignBusy || !assignDate}
                onClick={() => void saveAssign()}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
              >
                {assignBusy ? 'Saving…' : 'Save date'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
