'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowLeft,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Loader2,
  RefreshCw,
  Search,
  Users,
  X,
} from 'lucide-react';
import { displaySopCode } from '@/lib/sop-display';
import {
  LMS_CLIENT_FRESH_MS,
  lmsClientFields,
  readLmsClientCache,
  writeLmsClientCache,
} from '@/lib/lmsCache';

type ExamStatus = 'completed' | 'pending' | 'overdue';

interface ExamTotals {
  total: number;
  completed: number;
  pending: number;
  overdue: number;
  ignored: number;
}

interface MonthBucket extends ExamTotals {
  month: number;
}

interface OverviewExamRow {
  key: string;
  sopCode: string;
  sopName: string;
  sopNameGujarati?: string;
  month: number;
  year: number;
  status: ExamStatus;
  scheduleStatus: string;
  isIgnored: boolean;
  examDate?: string;
  completedDate?: string;
  score?: number;
  progressPct: number;
  daysOverdue: number;
}

interface OverviewEmployee {
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  employeeCode?: string;
  isTrainer: boolean;
  hasLmsAccess: boolean;
  totals: ExamTotals;
  completionPct: number;
  fullyCompleted: boolean;
  lastCompletedDate?: string;
  monthly: MonthBucket[];
  exams: OverviewExamRow[];
}

interface OverviewDepartment {
  department: string;
  trainers: string[];
  employeeCount: number;
  employeesCompleted: number;
  employeesPending: number;
  totals: ExamTotals;
  completionPct: number;
  examSops: { total: number; completed: number; remaining: number };
  monthly: MonthBucket[];
  monthlySops: MonthBucket[];
  employees: OverviewEmployee[];
}

interface OverviewTrainer {
  trainerId: string;
  name: string;
  homeDepartment: string;
  trainerDepartments: string[];
  employeeCount: number;
  employeesCompleted: number;
  employeesPending: number;
  totals: ExamTotals;
  completionPct: number;
  own: { totals: ExamTotals; completionPct: number; hasRecord: boolean };
  monthly: MonthBucket[];
  monthlySops: MonthBucket[];
  departments: OverviewDepartment[];
}

interface TrainerOverviewPayload {
  generatedAt: string;
  year: number;
  years: number[];
  trainingCycleStart: string;
  includeIgnored: boolean;
  totals: {
    trainers: number;
    departments: number;
    departmentsCovered: number;
    employees: number;
    employeesCompleted: number;
    employeesPending: number;
    exams: ExamTotals;
    completionPct: number;
  };
  monthly: MonthBucket[];
  monthlySops: MonthBucket[];
  trainers: OverviewTrainer[];
  departments: OverviewDepartment[];
  departmentsWithoutTrainer: string[];
}

type BoardTab = 'hierarchy' | 'departments' | 'monthly';
type CompletionFilter = 'all' | 'completed' | 'pending';

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

function notCompleted(t: ExamTotals): number {
  return t.pending + t.overdue;
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="flex min-w-[7rem] items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-200">
        <div className="h-full rounded-full bg-purple-500" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
      <span className="w-8 text-right tabular-nums text-gray-500">{pct}%</span>
    </div>
  );
}

function DonePending({ done, pending }: { done: number; pending: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">
        {done} completed
      </span>
      <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
        {pending} not completed
      </span>
    </span>
  );
}

function employeeMatches(
  emp: OverviewEmployee,
  search: string,
  completion: CompletionFilter,
  months: number[],
): boolean {
  if (completion === 'completed' && !emp.fullyCompleted) return false;
  if (completion === 'pending' && (emp.fullyCompleted || emp.totals.total === 0)) return false;
  if (months.length > 0 && !emp.exams.some((e) => months.includes(e.month))) return false;
  if (!search) return true;
  const hay = `${emp.name} ${emp.designation} ${emp.department} ${emp.employeeCode || ''}`.toLowerCase();
  return hay.includes(search);
}

function MonthStrip({
  buckets,
  selected,
  onToggle,
  label,
}: {
  buckets: MonthBucket[];
  selected: number[];
  onToggle: (month: number) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      <button
        type="button"
        onClick={() => onToggle(0)}
        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
          selected.length === 0 ? 'bg-purple-600 text-white' : 'border border-gray-200 bg-white text-gray-600'
        }`}
      >
        All months
      </button>
      {MONTHS.map((m, i) => {
        const b = buckets[i];
        const on = selected.includes(i + 1);
        return (
          <button
            key={m}
            type="button"
            onClick={() => onToggle(i + 1)}
            title={`${MONTHS_FULL[i]}: ${b?.completed ?? 0} completed, ${notCompleted(b || { total: 0, completed: 0, pending: 0, overdue: 0, ignored: 0 })} not completed`}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              on ? 'bg-indigo-600 text-white' : 'border border-gray-200 bg-white text-gray-600'
            }`}
          >
            {m}
            <span className="ml-1 opacity-70">{b?.completed ?? 0}/{b?.total ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}

function ExamRows({ exams, months }: { exams: OverviewExamRow[]; months: number[] }) {
  const rows = months.length > 0 ? exams.filter((e) => months.includes(e.month)) : exams;
  if (rows.length === 0) {
    return <p className="py-3 text-center text-xs text-gray-400">No exams in this filter.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead className="border-b border-gray-100 bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          <tr>
            <th className="px-3 py-2">SOP</th>
            <th className="px-3 py-2">Month</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Progress</th>
            <th className="px-3 py-2">Completed</th>
            <th className="px-3 py-2 text-right">Score</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="px-3 py-2">
                <p className="font-semibold text-gray-800">{displaySopCode(row.sopCode)}</p>
                <p className="text-[11px] text-gray-500">{row.sopName}</p>
              </td>
              <td className="px-3 py-2 text-gray-600">{MONTHS[row.month - 1] || row.month}</td>
              <td className="px-3 py-2">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_CHIP[row.status]}`}>
                  {row.status === 'completed' ? 'Completed' : row.status === 'overdue' ? 'Overdue' : 'Not completed'}
                </span>
              </td>
              <td className="px-3 py-2"><ProgressBar pct={row.progressPct} /></td>
              <td className="px-3 py-2 text-gray-500">{row.completedDate || '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                {row.score != null ? row.score : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmployeeTable({
  employees,
  months,
  expandedEmp,
  setExpandedEmp,
}: {
  employees: OverviewEmployee[];
  months: number[];
  expandedEmp: string | null;
  setExpandedEmp: (id: string | null) => void;
}) {
  if (employees.length === 0) {
    return <p className="py-8 text-center text-sm text-gray-400">No employees match these filters.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
      <table className="w-full min-w-[960px] text-left text-xs">
        <thead className="border-b border-gray-200 bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
          <tr>
            <th className="px-3 py-2.5">Employee</th>
            <th className="px-3 py-2.5">Designation</th>
            <th className="px-3 py-2.5">Dept</th>
            <th className="px-3 py-2.5">Training / exam status</th>
            <th className="px-3 py-2.5 text-right">Exams</th>
            <th className="px-3 py-2.5">Progress</th>
            <th className="w-8 px-3 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {employees.map((emp) => {
            const open = expandedEmp === emp.employeeId;
            return (
              <Fragment key={emp.employeeId}>
                <tr
                  className="cursor-pointer hover:bg-gray-50"
                  onClick={() => setExpandedEmp(open ? null : emp.employeeId)}
                >
                  <td className="px-3 py-2.5 font-semibold text-gray-900">
                    {emp.name}
                    {!emp.hasLmsAccess && (
                      <span className="ml-1.5 text-[10px] font-medium text-amber-700">No LMS login</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-gray-700">{emp.designation || '—'}</td>
                  <td className="px-3 py-2.5 text-gray-600">{emp.department}</td>
                  <td className="px-3 py-2.5">
                    {emp.totals.total === 0 ? (
                      <span className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-bold text-gray-600">No exams</span>
                    ) : emp.fullyCompleted ? (
                      <span className="inline-flex rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold text-green-700">Completed</span>
                    ) : (
                      <span className="inline-flex rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">Not completed</span>
                    )}
                    <span className="ml-2 text-[11px] text-gray-400">
                      {emp.totals.completed}/{emp.totals.total} exams
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-gray-800">{emp.totals.total}</td>
                  <td className="px-3 py-2.5"><ProgressBar pct={emp.completionPct} /></td>
                  <td className="px-3 py-2.5">
                    <ChevronDown className={`h-4 w-4 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
                  </td>
                </tr>
                {open && (
                  <tr className="bg-gray-50/80">
                    <td colSpan={7} className="px-3 py-3">
                      <ExamRows exams={emp.exams} months={months} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function TrainerOverviewDashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<TrainerOverviewPayload | null>(null);
  const [year, setYear] = useState<number | 'all'>(new Date().getFullYear());
  const [tab, setTab] = useState<BoardTab>('hierarchy');
  const [search, setSearch] = useState('');
  const [completion, setCompletion] = useState<CompletionFilter>('all');
  const [months, setMonths] = useState<number[]>([]);
  const [openTrainer, setOpenTrainer] = useState<string | null>(null);
  const [openDept, setOpenDept] = useState<string | null>(null);
  const [expandedEmp, setExpandedEmp] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    setError('');
    const yearKey = year === 'all' ? 'all' : year;
    const qs = new URLSearchParams();
    qs.set('year', year === 'all' ? 'all' : String(year));
    const url = `/api/lms/admin/trainer-overview?${qs}`;
    const field = lmsClientFields.adminTrainerOverview(yearKey, false);
    try {
      if (!force) {
        const cached = readLmsClientCache<TrainerOverviewPayload>(field);
        if (cached && Date.now() - cached.cachedAt <= LMS_CLIENT_FRESH_MS) {
          setData(cached.value);
          setLoading(false);
          return;
        }
      }
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (res.status === 401) {
        router.push('/login');
        return;
      }
      if (res.status === 403) {
        setError('This overview is limited to Super Admin and SOP Admin.');
        setData(null);
        return;
      }
      if (!res.ok) throw new Error(json.error || 'Failed to load trainer overview');
      setData(json as TrainerOverviewPayload);
      writeLmsClientCache(field, json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [year, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const q = search.trim().toLowerCase();

  const filteredTrainers = useMemo(() => {
    if (!data) return [];
    return data.trainers
      .map((t) => {
        const departments = t.departments
          .map((d) => ({
            ...d,
            employees: d.employees.filter((e) => employeeMatches(e, q, completion, months)),
          }))
          .filter((d) => {
            if (q && d.department.toLowerCase().includes(q)) return true;
            return d.employees.length > 0 || (!q && completion === 'all' && months.length === 0);
          });
        const nameHit = !q || t.name.toLowerCase().includes(q)
          || t.trainerDepartments.some((d) => d.toLowerCase().includes(q));
        if (!nameHit && departments.every((d) => d.employees.length === 0) && q) return null;
        return { ...t, departments };
      })
      .filter((t): t is OverviewTrainer => Boolean(t));
  }, [data, q, completion, months]);

  const filteredDepartments = useMemo(() => {
    if (!data) return [];
    return data.departments
      .map((d) => ({
        ...d,
        employees: d.employees.filter((e) => employeeMatches(e, q, completion, months)),
      }))
      .filter((d) => {
        if (q && (d.department.toLowerCase().includes(q) || d.trainers.some((n) => n.toLowerCase().includes(q)))) {
          return true;
        }
        return d.employees.length > 0 || (!q && completion === 'all' && months.length === 0);
      });
  }, [data, q, completion, months]);

  const toggleMonth = (month: number) => {
    if (month === 0) {
      setMonths([]);
      return;
    }
    setMonths((prev) => (
      prev.includes(month) ? prev.filter((n) => n !== month) : [...prev, month].sort((a, b) => a - b)
    ));
  };

  const t = data?.totals;

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
                <h1 className="text-sm font-bold tracking-tight text-gray-900">Trainer Overview</h1>
                <p className="mt-0.5 truncate text-[11px] text-gray-400">
                  Super Admin / SOP Admin
                  {data?.trainingCycleStart ? ` · Cycle from ${data.trainingCycleStart}` : ''}
                </p>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <select
                value={year}
                onChange={(e) => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                className="appearance-none rounded-lg border border-gray-200 bg-white py-1.5 pl-3 pr-7 text-xs font-medium text-gray-700"
              >
                <option value="all">All years</option>
                {(data?.years?.length ? data.years : [new Date().getFullYear()]).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
              <Link
                href="/lms/trainer"
                className="hidden rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 sm:inline-flex"
              >
                Trainer View
              </Link>
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
          </div>

          <div className="mt-2 overflow-x-auto">
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
              {([
                { id: 'hierarchy' as const, label: 'Trainer → Department', Icon: Users },
                { id: 'departments' as const, label: 'Departments', Icon: ClipboardList },
                { id: 'monthly' as const, label: 'Monthly', Icon: CalendarRange },
              ]).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setTab(v.id)}
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold whitespace-nowrap transition ${
                    tab === v.id ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'
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
        ) : data && t ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { label: 'Trainers', value: t.trainers, hint: `${t.departmentsCovered} depts covered` },
                { label: 'Departments', value: t.departments, hint: data.departmentsWithoutTrainer.length ? `${data.departmentsWithoutTrainer.length} without trainer` : 'All have a trainer' },
                { label: 'Employees', value: t.employees, hint: 'Learners only' },
                { label: 'Completed', value: t.employeesCompleted, hint: 'All required exams done', tone: 'green' },
                { label: 'Not completed', value: t.employeesPending, hint: 'Still outstanding', tone: 'amber' },
                { label: 'Exam sittings', value: `${t.exams.completed}/${t.exams.total}`, hint: `${t.completionPct}% complete` },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
                  <p className={`text-lg font-bold leading-none ${
                    s.tone === 'green' ? 'text-green-700' : s.tone === 'amber' ? 'text-amber-800' : 'text-gray-800'
                  }`}>{s.value}</p>
                  <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">{s.label}</p>
                  {s.hint ? <p className="mt-0.5 text-[10px] text-gray-400">{s.hint}</p> : null}
                </div>
              ))}
            </div>

            {tab !== 'monthly' && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-52 max-w-sm flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search trainer, department, or employee…"
                      className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-8 text-xs focus:border-purple-300 focus:outline-none"
                    />
                    {search && (
                      <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
                    {([
                      { id: 'all' as const, label: 'All' },
                      { id: 'completed' as const, label: 'Completed' },
                      { id: 'pending' as const, label: 'Not completed' },
                    ]).map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setCompletion(s.id)}
                        className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
                          completion === s.id ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <MonthStrip
                  buckets={data.monthlySops}
                  selected={months}
                  onToggle={toggleMonth}
                  label="Unique SOP exams"
                />
              </>
            )}

            {tab === 'hierarchy' && (
              <div className="space-y-3">
                {filteredTrainers.length === 0 ? (
                  <p className="py-16 text-center text-sm text-gray-400">No trainers match these filters.</p>
                ) : filteredTrainers.map((trainer) => {
                  const open = openTrainer === trainer.trainerId;
                  return (
                    <section key={trainer.trainerId} className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                      <button
                        type="button"
                        onClick={() => setOpenTrainer(open ? null : trainer.trainerId)}
                        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-gray-900">{trainer.name}</p>
                          <p className="mt-0.5 text-[11px] text-gray-500">
                            Home: {trainer.homeDepartment || '—'}
                            {' · '}
                            {trainer.trainerDepartments.join(', ') || 'No departments assigned'}
                          </p>
                        </div>
                        <DonePending done={trainer.employeesCompleted} pending={trainer.employeesPending} />
                        <div className="text-right">
                          <p className="text-[10px] uppercase tracking-wide text-gray-400">Employee exams</p>
                          <p className="text-xs font-semibold text-gray-800">
                            {trainer.totals.completed}/{trainer.totals.total}
                            <span className="ml-1 font-normal text-gray-400">({trainer.completionPct}%)</span>
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-[10px] uppercase tracking-wide text-gray-400">Trainer’s own</p>
                          <p className="text-xs font-semibold text-gray-800">
                            {trainer.own.hasRecord
                              ? `${trainer.own.totals.completed}/${trainer.own.totals.total} (${trainer.own.completionPct}%)`
                              : 'No record'}
                          </p>
                        </div>
                        <ChevronDown className={`h-4 w-4 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
                      </button>
                      {open && (
                        <div className="space-y-3 border-t border-gray-100 bg-gray-50 px-4 py-4">
                          {trainer.departments.length === 0 ? (
                            <p className="text-xs text-gray-400">No departments assigned to this trainer.</p>
                          ) : trainer.departments.map((dept) => {
                            const dKey = `${trainer.trainerId}::${dept.department}`;
                            const dOpen = openDept === dKey;
                            return (
                              <div key={dKey} className="overflow-hidden rounded-xl border border-gray-200 bg-white">
                                <button
                                  type="button"
                                  onClick={() => setOpenDept(dOpen ? null : dKey)}
                                  className="flex w-full flex-wrap items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50"
                                >
                                  <div className="min-w-0 flex-1">
                                    <p className="text-xs font-bold text-gray-900">{dept.department}</p>
                                    <p className="text-[11px] text-gray-400">
                                      {dept.employeeCount} employees · SOP exams {dept.examSops.completed}/{dept.examSops.total}
                                    </p>
                                  </div>
                                  <DonePending done={dept.employeesCompleted} pending={dept.employeesPending} />
                                  <ChevronDown className={`h-4 w-4 text-gray-400 transition ${dOpen ? 'rotate-180' : ''}`} />
                                </button>
                                {dOpen && (
                                  <div className="border-t border-gray-100 p-3">
                                    <EmployeeTable
                                      employees={dept.employees}
                                      months={months}
                                      expandedEmp={expandedEmp}
                                      setExpandedEmp={setExpandedEmp}
                                    />
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}

            {tab === 'departments' && (
              <div className="space-y-3">
                {data.departmentsWithoutTrainer.length > 0 && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                    No trainer assigned: {data.departmentsWithoutTrainer.join(', ')}
                  </p>
                )}
                {filteredDepartments.map((dept) => {
                  const dOpen = openDept === dept.department;
                  return (
                    <section key={dept.department} className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                      <button
                        type="button"
                        onClick={() => setOpenDept(dOpen ? null : dept.department)}
                        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-gray-50"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-bold text-gray-900">{dept.department}</p>
                          <p className="mt-0.5 text-[11px] text-gray-500">
                            {dept.trainers.length > 0 ? `Trainers: ${dept.trainers.join(', ')}` : 'No trainer assigned'}
                          </p>
                        </div>
                        <DonePending done={dept.employeesCompleted} pending={dept.employeesPending} />
                        <div className="text-right">
                          <p className="text-[10px] uppercase tracking-wide text-gray-400">SOP exams</p>
                          <p className="text-xs font-semibold text-gray-800">
                            {dept.examSops.completed}/{dept.examSops.total}
                            {dept.examSops.remaining > 0 ? (
                              <span className="ml-1 font-normal text-amber-700">{dept.examSops.remaining} pending</span>
                            ) : null}
                          </p>
                        </div>
                        <ChevronDown className={`h-4 w-4 text-gray-400 transition ${dOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {dOpen && (
                        <div className="border-t border-gray-100 p-4">
                          <EmployeeTable
                            employees={dept.employees}
                            months={months}
                            expandedEmp={expandedEmp}
                            setExpandedEmp={setExpandedEmp}
                          />
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            )}

            {tab === 'monthly' && (
              <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                <div className="border-b border-gray-100 px-4 py-3">
                  <p className="text-sm font-bold text-gray-900">Month-by-month completion</p>
                  <p className="text-[11px] text-gray-400">
                    Unique SOP exams (same counting as Trainer View). Sitting counts are employee × SOP.
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[900px] text-left text-xs">
                    <thead className="border-b border-gray-200 bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                      <tr>
                        <th className="px-4 py-2.5">Month</th>
                        <th className="px-4 py-2.5 text-right">SOP exams</th>
                        <th className="px-4 py-2.5 text-right">SOP completed</th>
                        <th className="px-4 py-2.5 text-right">SOP not completed</th>
                        <th className="px-4 py-2.5 text-right">Sittings</th>
                        <th className="px-4 py-2.5 text-right">Sittings completed</th>
                        <th className="px-4 py-2.5 text-right">Sittings not completed</th>
                        <th className="px-4 py-2.5">SOP progress</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {MONTHS.map((m, i) => {
                        const sop = data.monthlySops[i];
                        const sit = data.monthly[i];
                        const sopLeft = notCompleted(sop);
                        const sitLeft = notCompleted(sit);
                        const pct = sop.total > 0 ? Math.round((sop.completed / sop.total) * 100) : 0;
                        return (
                          <tr key={m}>
                            <td className="px-4 py-2.5 font-semibold text-gray-900">{MONTHS_FULL[i]}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{sop.total}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-green-700 font-semibold">{sop.completed}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-amber-800 font-semibold">{sopLeft}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums">{sit.total}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-green-700">{sit.completed}</td>
                            <td className="px-4 py-2.5 text-right tabular-nums text-amber-800">{sitLeft}</td>
                            <td className="px-4 py-2.5"><ProgressBar pct={pct} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}
