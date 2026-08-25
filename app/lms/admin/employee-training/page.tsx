'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Loader2, RefreshCw, Search, ChevronDown, X,
} from 'lucide-react';
import { TrainingDeptCapsules, type TrainingDeptCapsule, type SopCapsuleFilter, type EmpCapsuleFilter } from '@/components/lms/TrainingDeptCapsules';
import {
  EmployeeTrainingGrid,
  buildMonthlyBreakdown,
  type EmployeeGridRow,
  type MonthBreakdown,
} from '@/components/employees/EmployeeTrainingGrid';
import {
  SopTrainingGrid,
  type SopGridRow,
  type SopGridDrill,
} from '@/components/lms/SopTrainingGrid';
import {
  lmsClientFields,
  LMS_CLIENT_FRESH_MS,
  readLmsClientCache,
  writeLmsClientCache,
} from '@/lib/lmsCache';
import { DesignationUpdatedBadge } from '@/components/lms/DesignationUpdatedBadge';
import { hasGujaratiScript, isInvalidSopAssignmentCode, isPlaceholderSopName } from '@/lib/sop-name-resolution';
import { baseIdentifierFromIdentifier } from '@/lib/sop-utils';
import type { DashboardStats, RegistrySOP } from '@/lib/types';

// Preferred department display order; departments not listed fall after these.
const DEPT_ORDER = ['QA', 'QC', 'Microbiology', 'Production', 'Store', 'Engineering', 'Personnel'];

type ComponentStatus = 'completed' | 'not_completed' | 'na';
type SopStatus = 'completed' | 'not_completed';
type ComponentKey = 'videos' | 'slides' | 'sopDoc' | 'mcq';

interface SopBreakdown {
  sopCode: string;
  sopKey?: string;
  sopName: string;
  sopNameGujarati?: string;
  status: SopStatus;
  months: number[];
  year?: number;
  scheduleStatus?: 'ignored' | 'upcoming' | 'due' | 'overdue' | 'missed';
  hasExam: boolean;
  components: Record<ComponentKey, ComponentStatus>;
}

interface SopTrainingRow extends SopGridRow {
  months: number[];
}

interface EmployeeTrainingRecord {
  employeeId: string;
  employeeName: string;
  designation: string;
  /** Designation held before the most recent change, if there has been one. */
  previousDesignation?: string;
  /** ISO timestamp of the most recent designation change. */
  designationUpdatedAt?: string;
  department: string;
  isActive: boolean;
  isTrainer?: boolean;
  totalSops: number;
  completedSops: number;
  notCompletedSops: number;
  missedSops?: number;
  ignoredSops?: number;
  overallPct: number;
  monthlyCounts: number[];
  monthlyBreakdown?: MonthBreakdown[];
  sops: SopBreakdown[];
  hasTraining: boolean;
  hasInduction: boolean;
}

const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const emptySopMonthlyBreakdown = (): MonthBreakdown[] =>
  Array.from({ length: 12 }, () => ({ completed: 0, notCompleted: 0 }));

type EmpStatus = 'completed' | 'not_completed';

function employeeStatus(r: EmployeeTrainingRecord): EmpStatus {
  if (r.totalSops > 0 && r.completedSops === r.totalSops) return 'completed';
  return 'not_completed';
}

const DEFAULT_EMP_FILTER: EmpCapsuleFilter = { kind: 'overall', status: 'all' };

function matchesEmpFilter(r: EmployeeTrainingRecord, filter: EmpCapsuleFilter): boolean {
  switch (filter.kind) {
    case 'overall':
      return filter.status === 'all' || employeeStatus(r) === filter.status;
    case 'slides':
    case 'videos':
    case 'mcq': {
      // Employees with no material of this kind are outside the column entirely,
      // so the list matches the count on the capsule.
      const componentStatus = employeeComponentStatus(r, filter.kind);
      if (componentStatus === null) return false;
      return filter.status === 'all' || componentStatus === filter.status;
    }
    case 'training':
      return r.hasTraining;
    case 'induction':
      return r.hasInduction;
  }
}

function isDefaultEmpFilter(filter: EmpCapsuleFilter): boolean {
  return filter.kind === 'overall' && filter.status === 'all';
}

// ─── Department summary capsules ──────────────────────────────────────────────

// Per-SOP roll-up across the employees assigned to it. A SOP counts once
// (distinct), and its department-wide status follows the rule: Completed only
// when every assigned employee finished it; otherwise Not Completed.

/**
 * `applicable` is the denominator: employees whose assigned SOPs actually carry
 * material of this kind. Counting someone with no slides as "slides not
 * completed" implies outstanding work that does not exist.
 */
interface ComponentRollup { applicable: number; completed: number; not: number; }

interface DeptAcc {
  totalEmployees: number; empCompleted: number; empNot: number;
  empTraining: number; empInduction: number;
  slides: ComponentRollup;
  videos: ComponentRollup;
  mcq: ComponentRollup;
}

const emptyComponentRollup = (): ComponentRollup => ({ applicable: 0, completed: 0, not: 0 });

const emptyDeptAcc = (): DeptAcc => ({
  totalEmployees: 0, empCompleted: 0, empNot: 0,
  empTraining: 0, empInduction: 0,
  slides: emptyComponentRollup(), videos: emptyComponentRollup(), mcq: emptyComponentRollup(),
});

type ComponentRollupKey = 'slides' | 'videos' | 'mcq';

/**
 * Where this employee stands on one component column, or null when none of
 * their SOPs carry that material and the column does not apply to them.
 */
function employeeComponentStatus(
  r: EmployeeTrainingRecord,
  key: ComponentRollupKey,
): EmpStatus | null {
  const statuses = r.sops.map((s) => s.components[key]).filter((st) => st !== 'na');
  if (statuses.length === 0) return null;
  return statuses.every((st) => st === 'completed') ? 'completed' : 'not_completed';
}

function bumpComponentRollup(rollup: ComponentRollup, status: EmpStatus | null) {
  if (status === null) return;
  rollup.applicable++;
  if (status === 'completed') rollup.completed++;
  else rollup.not++;
}

function addToDeptAcc(acc: DeptAcc, r: EmployeeTrainingRecord) {
  acc.totalEmployees += 1;
  const st = employeeStatus(r);
  if (st === 'completed') acc.empCompleted++;
  else                    acc.empNot++;
  if (r.hasTraining)  acc.empTraining++;
  if (r.hasInduction) acc.empInduction++;
  bumpComponentRollup(acc.slides, employeeComponentStatus(r, 'slides'));
  bumpComponentRollup(acc.videos, employeeComponentStatus(r, 'videos'));
  bumpComponentRollup(acc.mcq, employeeComponentStatus(r, 'mcq'));
}

function sopRowStatus(row: SopTrainingRow): SopStatus {
  if (row.assigned > 0 && row.completed === row.assigned) return 'completed';
  return 'not_completed';
}

function countRegistrySopStatus(rows: SopTrainingRow[]) {
  let sopCompleted = 0;
  let sopNot = 0;
  for (const row of rows) {
    const status = sopRowStatus(row);
    if (status === 'completed') sopCompleted++;
    else sopNot++;
  }
  return { sopCompleted, sopNot };
}

function buildRegistrySopRows(
  registry: RegistrySOP[],
  trainingRows: SopTrainingRow[],
  dept: string,
): SopTrainingRow[] {
  const trainingByKey = new Map<string, SopTrainingRow>();
  for (const row of trainingRows) {
    trainingByKey.set(row.sopCode.toUpperCase(), row);
    trainingByKey.set(row.sopKey.toUpperCase(), row);
    trainingByKey.set(baseIdentifierFromIdentifier(row.sopCode).toUpperCase(), row);
  }

  const active = registry.filter((r) => !r.isObsolete);
  const scoped = dept === 'All'
    ? active
    : active.filter((r) => r.department === dept);

  return scoped.map((sop) => {
    const id = sop.identifier.toUpperCase();
    const base = baseIdentifierFromIdentifier(sop.identifier).toUpperCase();
    const train = trainingByKey.get(id) ?? trainingByKey.get(base);
    return {
      sopKey: base || id,
      sopCode: sop.identifier,
      sopName: sop.name,
      sopNameGujarati: sop.nameGujarati,
      department: sop.department,
      months: train?.months ?? [],
      assigned: train?.assigned ?? 0,
      completed: train?.completed ?? 0,
      notCompleted: train?.notCompleted ?? 0,
      completionPct: train?.completionPct ?? 0,
      monthlyBreakdown: train?.monthlyBreakdown ?? emptySopMonthlyBreakdown(),
    };
  });
}

function deptAccToCapsule(
  department: string,
  acc: DeptAcc,
  sopTotals: { totalSops: number; sopCompleted: number; sopNot: number },
): TrainingDeptCapsule {
  return {
    department,
    totalSops: sopTotals.totalSops,
    sopCompleted: sopTotals.sopCompleted,
    sopNot: sopTotals.sopNot,
    totalEmployees: acc.totalEmployees,
    empCompleted: acc.empCompleted, empNot: acc.empNot,
    empTraining: acc.empTraining, empInduction: acc.empInduction,
    slidesTotal: acc.slides.applicable, slidesCompleted: acc.slides.completed,
    slidesNot: acc.slides.not,
    videosTotal: acc.videos.applicable, videosCompleted: acc.videos.completed,
    videosNot: acc.videos.not,
    mcqTotal: acc.mcq.applicable, mcqCompleted: acc.mcq.completed,
    mcqNot: acc.mcq.not,
  };
}

function onlyActiveEmployees(recs: EmployeeTrainingRecord[]): EmployeeTrainingRecord[] {
  return recs.filter((r) => r.isActive !== false);
}

function buildSopTrainingRows(records: EmployeeTrainingRecord[], dept: string): SopTrainingRow[] {
  const byKey = new Map<string, SopTrainingRow>();
  for (const emp of records) {
    if (dept !== 'All' && (emp.department || 'Unknown') !== dept) continue;
    for (const s of emp.sops) {
      if (isInvalidSopAssignmentCode(s.sopCode)) continue;
      const key = s.sopKey || s.sopCode.toUpperCase();
      let row = byKey.get(key);
      if (!row) {
        row = {
          sopKey: key,
          sopCode: s.sopCode,
          sopName: s.sopName,
          sopNameGujarati: s.sopNameGujarati,
          department: '',
          months: s.months,
          assigned: 0,
          completed: 0,
          notCompleted: 0,
          completionPct: 0,
          monthlyBreakdown: emptySopMonthlyBreakdown(),
        };
        byKey.set(key, row);
      }
      if (s.sopName && !isPlaceholderSopName(s.sopName, s.sopCode) && !hasGujaratiScript(s.sopName)) {
        row.sopName = s.sopName;
      }
      if (s.sopNameGujarati && !row.sopNameGujarati) row.sopNameGujarati = s.sopNameGujarati;
      if (s.months.length > row.months.length) row.months = s.months;
      row.assigned++;
      if (s.status === 'completed') row.completed++;
      else row.notCompleted++;
      for (const m of s.months) {
        const idx = m - 1;
        if (idx < 0 || idx > 11) continue;
        if (s.status === 'completed') row.monthlyBreakdown[idx].completed++;
        else row.monthlyBreakdown[idx].notCompleted++;
      }
    }
  }
  return [...byKey.values()].map((row) => ({
    ...row,
    completionPct: row.assigned > 0 ? Math.round((row.completed / row.assigned) * 100) : 0,
  }));
}

const SOP_STATUS_META: Record<SopStatus, { label: string; chip: string }> = {
  completed:     { label: 'Completed',     chip: 'bg-green-100 text-green-700' },
  not_completed: { label: 'Not Completed', chip: 'bg-gray-100 text-gray-600' },
};

// ─── SOP drill-down modal ────────────────────────────────────────────────────

function SopDrillDownModal({
  drill, records, dept, onClose,
}: {
  drill: SopGridDrill;
  records: EmployeeTrainingRecord[];
  dept: string;
  onClose: () => void;
}) {
  const { row: sop } = drill;
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const scoped = dept === 'All' ? records : records.filter((r) => (r.department || 'Unknown') === dept);
    const matches = scoped.flatMap((emp) => {
      const hit = emp.sops.find((s) => (s.sopKey || s.sopCode.toUpperCase()) === sop.sopKey);
      if (!hit) return [];
      if (drill.kind === 'status' && hit.status !== drill.status) return [];
      if (drill.kind === 'month') {
        if (!hit.months.includes(drill.month)) return [];
        if (hit.status !== drill.status) return [];
      }
      return [{ emp, hit }];
    });
    const q = query.trim().toLowerCase();
    if (!q) return matches;
    return matches.filter((item) =>
      `${item.emp.employeeName} ${item.emp.designation} ${item.emp.department}`.toLowerCase().includes(q),
    );
  }, [drill, records, dept, sop.sopKey, query]);

  const title =
    drill.kind === 'status'
      ? SOP_STATUS_META[drill.status].label
      : `${MONTHS_FULL[drill.month - 1]} — ${SOP_STATUS_META[drill.status].label}`;
  const titleChip =
    drill.kind === 'status' ? SOP_STATUS_META[drill.status].chip : 'bg-blue-100 text-blue-700';
  const gujaratiRe = /[\u0A80-\u0AFF]/;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-gray-200 px-5 py-4">
          <div className="min-w-0 flex-1 pr-4">
            <p className="font-semibold text-gray-900 leading-tight">{sop.sopName}</p>
            {sop.sopNameGujarati && gujaratiRe.test(sop.sopNameGujarati) && (
              <p className="mt-0.5 text-xs font-medium text-indigo-700 leading-tight">{sop.sopNameGujarati}</p>
            )}
            <p className="mt-0.5 text-xs text-gray-400">{sop.sopCode}</p>
            <span className={`mt-2 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${titleChip}`}>
              {title} · {rows.length} employee{rows.length !== 1 ? 's' : ''}
            </span>
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <X className="h-5 w-5" />
          </button>
        </div>
        {rows.length > 3 && (
          <div className="border-b border-gray-100 px-5 py-2.5">
            <div className="relative max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search employee…"
                className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-8 text-xs focus:border-purple-300 focus:outline-none"
              />
            </div>
          </div>
        )}
        <div className="overflow-auto">
          {rows.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-400">No employees in this category.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Employee</th>
                  <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Designation</th>
                  <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Department</th>
                  <th className="px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row) => (
                  <tr key={row.emp.employeeId} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">{row.emp.employeeName}</td>
                    <td className="px-4 py-3 text-gray-900">
                      {row.emp.designation || '—'}
                      <DesignationUpdatedBadge
                        designation={row.emp.designation}
                        previousDesignation={row.emp.previousDesignation}
                        designationUpdatedAt={row.emp.designationUpdatedAt}
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-600">{row.emp.department || '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${SOP_STATUS_META[row.hit.status].chip}`}>
                        {SOP_STATUS_META[row.hit.status].label}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

type ViewMode = 'employee' | 'sop';

// ─── Page ────────────────────────────────────────────────────────────────────

export default function EmployeeTrainingDashboardPage() {
  const { status: authStatus } = useSession();
  const router = useRouter();

  const [records, setRecords] = useState<EmployeeTrainingRecord[]>([]);
  const [registry, setRegistry] = useState<RegistrySOP[]>([]);
  const [sopStats, setSopStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [dept,    setDept]    = useState('All');
  const [search,  setSearch]  = useState('');
  const [empFilter, setEmpFilter] = useState<EmpCapsuleFilter>(DEFAULT_EMP_FILTER);
  const [sopFilter, setSopFilter] = useState<'all' | SopStatus>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('employee');
  const [sopDrill, setSopDrill] = useState<SopGridDrill | null>(null);
  const [monthFilter, setMonthFilter] = useState<number | 'all'>('all');
  const [learnerFilter, setLearnerFilter] = useState<'all' | 'employees' | 'pending' | 'missed'>('all');
  const [monthExamCounts, setMonthExamCounts] = useState<number[]>(() => Array(12).fill(0));
  const [cycleStart, setCycleStart] = useState<string>('');
  const [rescheduleTarget, setRescheduleTarget] = useState<{
    employeeId: string;
    employeeName: string;
    department: string;
    sopCode: string;
    sopName: string;
    fromMonth: number;
    fromYear: number;
  } | null>(null);
  const [rescheduleToMonth, setRescheduleToMonth] = useState(new Date().getMonth() + 1);
  const [rescheduleBusy, setRescheduleBusy] = useState(false);

  useEffect(() => {
    if (authStatus === 'unauthenticated') router.push('/login');
  }, [authStatus, router]);

  const load = useCallback(async (force = false) => {
    const field = lmsClientFields.adminEmployeeTraining('all');
    const cached = !force ? readLmsClientCache<{ records: EmployeeTrainingRecord[] }>(field) : null;
    if (cached?.value) {
      setRecords(onlyActiveEmployees(cached.value.records || []));
      if (!force && Date.now() - cached.cachedAt <= LMS_CLIENT_FRESH_MS) {
        setLoading(false);
      }
    } else {
      setLoading(true);
    }
    try {
      const trainingRes = await fetch('/api/lms/admin/employee-training', { cache: 'no-store' });
      if (trainingRes.ok) {
        const json = await trainingRes.json();
        const recs = onlyActiveEmployees(json.records || []);
        setRecords(recs);
        setMonthExamCounts(Array.isArray(json.monthExamCounts) ? json.monthExamCounts : Array(12).fill(0));
        if (json.trainingCycleStart) setCycleStart(String(json.trainingCycleStart));
        writeLmsClientCache(field, { records: recs });
      }
    } finally {
      setLoading(false);
    }
    void Promise.all([
      fetch('/api/sops/stats', { cache: 'no-store' }),
      fetch('/api/sops?all=1', { cache: 'no-store' }),
    ]).then(async ([statsRes, registryRes]) => {
      if (statsRes.ok) setSopStats(await statsRes.json());
      if (registryRes.ok) {
        const json = await registryRes.json();
        setRegistry((json.items || []).filter((r: RegistrySOP) => !r.isObsolete));
      }
    });
  }, []);

  useEffect(() => { load(); }, [load]);

  const gridRows = useMemo((): EmployeeGridRow[] => {
    const q = search.trim().toLowerCase();
    return records
      .filter((r) => {
        if (r.isActive === false) return false;
        if (dept !== 'All' && (r.department || 'Unknown') !== dept) return false;
        if (learnerFilter === 'employees' && r.isTrainer) return false;
        if (learnerFilter === 'pending' && (r.isTrainer || r.notCompletedSops <= 0)) return false;
        if (learnerFilter === 'missed' && (r.isTrainer || (r.missedSops ?? 0) <= 0)) return false;
        if (monthFilter !== 'all') {
          const hasMonth = r.sops.some((s) => s.months.includes(monthFilter));
          if (!hasMonth) return false;
        }
        if (q && !`${r.employeeName} ${r.designation} ${r.department}`.toLowerCase().includes(q)) return false;
        if (!matchesEmpFilter(r, empFilter)) return false;
        return true;
      })
      .map((r) => ({
        employeeId:       r.employeeId,
        employeeName:     r.employeeName,
        designation:      r.designation,
        previousDesignation:  r.previousDesignation,
        designationUpdatedAt: r.designationUpdatedAt,
        department:       r.department,
        isActive:         r.isActive,
        totalSops:        r.totalSops,
        completedSops:    r.completedSops,
        notCompletedSops: r.notCompletedSops,
        overallPct:       r.overallPct,
        monthlyBreakdown: r.monthlyBreakdown ?? buildMonthlyBreakdown(r.sops),
        sops:             r.sops,
        trainingLoaded:   true,
      }));
  }, [records, dept, search, empFilter, monthFilter, learnerFilter]);

  const trainingSopRows = useMemo(() => buildSopTrainingRows(records, 'All'), [records]);

  const sopRows = useMemo((): SopTrainingRow[] => {
    const q = search.trim().toLowerCase();
    return buildRegistrySopRows(registry, trainingSopRows, dept).filter((row) => {
      if (sopFilter !== 'all' && sopRowStatus(row) !== sopFilter) return false;
      if (monthFilter !== 'all' && !row.months.includes(monthFilter)) return false;
      if (!q) return true;
      const hay = `${row.sopName} ${row.sopNameGujarati || ''} ${row.sopCode} ${row.department}`.toLowerCase();
      return hay.includes(q);
    });
  }, [registry, trainingSopRows, dept, search, sopFilter, monthFilter]);

  const employeeOptions = useMemo(() => {
    const scoped = records.filter((r) => {
      if (r.isActive === false) return false;
      if (r.isTrainer) return false;
      if (dept !== 'All' && (r.department || 'Unknown') !== dept) return false;
      return true;
    });
    return scoped
      .map((r) => ({
        id: r.employeeId,
        name: r.employeeName,
        pending: r.notCompletedSops,
        missed: r.missedSops ?? 0,
        department: r.department,
      }))
      .sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name));
  }, [records, dept]);

  const missedInScope = useMemo(() => {
    const out: Array<{
      employeeId: string;
      employeeName: string;
      department: string;
      sopCode: string;
      sopName: string;
      fromMonth: number;
      fromYear: number;
    }> = [];
    for (const r of records) {
      if (dept !== 'All' && (r.department || 'Unknown') !== dept) continue;
      if (r.isTrainer) continue;
      for (const s of r.sops) {
        if (s.status === 'completed') continue;
        if (s.scheduleStatus !== 'missed' && s.scheduleStatus !== 'overdue') continue;
        if (monthFilter !== 'all' && !s.months.includes(monthFilter)) continue;
        out.push({
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          department: r.department,
          sopCode: s.sopCode,
          sopName: s.sopName,
          fromMonth: s.months[0] ?? 1,
          fromYear: s.year ?? new Date().getFullYear(),
        });
      }
    }
    return out;
  }, [records, dept, monthFilter]);

  // Employee metrics from training records; SOP totals from the dashboard registry
  // (/api/sops/stats + /api/sops?all=1 — same source as the main SOP dashboard).
  const capsules = useMemo<TrainingDeptCapsule[]>(() => {
    const total = emptyDeptAcc();
    const byDept = new Map<string, DeptAcc>();
    const dashboardDeptNames = (sopStats?.departments ?? [])
      .map((d) => d.department)
      .filter((d) => d && d !== 'Total');
    const allowed = new Set(dashboardDeptNames.map((d) => d.toLowerCase()));

    for (const r of records) {
      const name = r.department || '';
      if (!name || !allowed.has(name.toLowerCase())) continue;
      if (!byDept.has(name)) byDept.set(name, emptyDeptAcc());
      addToDeptAcc(byDept.get(name)!, r);
      addToDeptAcc(total, r);
    }
    // Ensure every dashboard dept appears as a capsule (even with 0 employees).
    for (const name of dashboardDeptNames) {
      if (!byDept.has(name)) byDept.set(name, emptyDeptAcc());
    }
    const statsByDept = new Map(
      (sopStats?.departments ?? []).map((d) => [d.department, d.total]),
    );
    const rank = (d: string) => {
      const i = DEPT_ORDER.findIndex((o) => d.toLowerCase().startsWith(o.toLowerCase()));
      return i < 0 ? DEPT_ORDER.length : i;
    };
    const capsuleFor = (department: string, acc: DeptAcc): TrainingDeptCapsule => {
      const deptScope = department === 'Total' ? 'All' : department;
      const rows = buildRegistrySopRows(registry, trainingSopRows, deptScope);
      const status = countRegistrySopStatus(rows);
      return deptAccToCapsule(department, acc, {
        totalSops: statsByDept.get(department) ?? rows.length,
        ...status,
      });
    };
    const depts = [...byDept.entries()]
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
      .map(([name, acc]) => capsuleFor(name, acc));
    return [capsuleFor('Total', total), ...depts];
  }, [records, registry, trainingSopRows, sopStats]);

  const deptOptions = useMemo(
    () => ['All', ...capsules.filter((c) => c.department !== 'Total').map((c) => c.department)],
    [capsules],
  );

  const handleSelectDept = (department: string) =>
    setDept((prev) => (prev === department ? 'All' : department));

  const handleSopCapsuleFilter = useCallback((department: string, status: SopCapsuleFilter) => {
    setDept(department === 'Total' ? 'All' : department);
    setSopFilter(status);
    setEmpFilter(DEFAULT_EMP_FILTER);
    setViewMode('sop');
  }, []);

  const handleEmpCapsuleFilter = useCallback((department: string, filter: EmpCapsuleFilter) => {
    setDept(department === 'Total' ? 'All' : department);
    setEmpFilter(filter);
    setSopFilter('all');
    setViewMode('employee');
  }, []);

  if (authStatus === 'loading') {
    return <div className="flex min-h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-purple-400" /></div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1920px] items-center justify-between px-2 py-3 sm:px-4">
          <div className="flex items-center gap-3">
            <Link href="/lms/admin" className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800">
              <ArrowLeft className="h-3.5 w-3.5" /> SOP Exam Settings
            </Link>
            <div className="h-4 w-px bg-gray-200" />
            <h1 className="text-sm font-bold tracking-tight">Employee Training Dashboard</h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => load(true)} disabled={loading} className="rounded-lg border border-gray-200 p-1.5 text-gray-400 hover:bg-gray-50">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1920px] px-2 py-6 sm:px-4 space-y-5">
        {/* Department summary capsules */}
        {!loading && records.length > 0 && (
          <TrainingDeptCapsules
            capsules={capsules}
            selected={dept}
            onSelect={handleSelectDept}
            onSopFilter={handleSopCapsuleFilter}
            onEmpFilter={handleEmpCapsuleFilter}
          />
        )}

        {/* Search + department + view toggle */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('employee')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${viewMode === 'employee' ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              By Employee
            </button>
            <button
              type="button"
              onClick={() => setViewMode('sop')}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${viewMode === 'sop' ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              By SOP
            </button>
          </div>

          <div className="relative flex-1 min-w-52 max-w-sm">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={viewMode === 'employee' ? 'Search name, designation, department…' : 'Search SOP name, code…'}
              className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-8 text-xs focus:border-purple-300 focus:outline-none"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="relative">
            <select
              value={dept}
              onChange={(e) => setDept(e.target.value)}
              className="appearance-none rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-7 text-xs font-medium text-gray-600 focus:outline-none"
            >
              {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
          </div>

          {(!isDefaultEmpFilter(empFilter) || sopFilter !== 'all' || search || dept !== 'All' || monthFilter !== 'all' || learnerFilter !== 'all') && (
            <button
              onClick={() => {
                setEmpFilter(DEFAULT_EMP_FILTER);
                setSopFilter('all');
                setSearch('');
                setDept('All');
                setMonthFilter('all');
                setLearnerFilter('all');
              }}
              className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-gray-800"
            >
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
          )}

          <span className="ml-auto text-xs text-gray-400">
            {viewMode === 'employee'
              ? `${gridRows.length} employee${gridRows.length !== 1 ? 's' : ''}`
              : `${sopRows.length} SOP${sopRows.length !== 1 ? 's' : ''}`}
            {cycleStart ? ` · Cycle from ${cycleStart}` : ''}
          </span>
        </div>

        {/* Month filter — shows scheduled exam counts */}
        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Month filter</p>
            <p className="text-[10px] text-gray-400">SOP exams scheduled per month</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setMonthFilter('all')}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                monthFilter === 'all' ? 'bg-purple-600 text-white' : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              All months
            </button>
            {MONTHS_FULL.map((name, idx) => {
              const month = idx + 1;
              const count = monthExamCounts[idx] ?? 0;
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => setMonthFilter((prev) => (prev === month ? 'all' : month))}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    monthFilter === month
                      ? 'bg-indigo-600 text-white'
                      : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                  title={`${count} SOP exam${count !== 1 ? 's' : ''} scheduled in ${name}`}
                >
                  {name.slice(0, 3)}
                  <span className={`ml-1 ${monthFilter === month ? 'opacity-80' : 'text-gray-400'}`}>{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Employee filter — non-trainers with pending / missed counts */}
        <div className="rounded-xl border border-gray-200 bg-white p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Employee filter</p>
            <div className="flex flex-wrap gap-1">
              {([
                { id: 'all', label: 'All' },
                { id: 'employees', label: 'Employees only' },
                { id: 'pending', label: 'Pending exams' },
                { id: 'missed', label: 'Missed exams' },
              ] as const).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setLearnerFilter(opt.id)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    learnerFilter === opt.id
                      ? opt.id === 'missed'
                        ? 'bg-red-600 text-white'
                        : 'bg-purple-600 text-white'
                      : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
            {employeeOptions.length === 0 ? (
              <p className="text-xs text-gray-400">No non-trainer employees in this department scope.</p>
            ) : (
              employeeOptions.slice(0, 40).map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => {
                    setLearnerFilter('employees');
                    setViewMode('employee');
                    setSearch(e.name);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1 text-[11px] font-medium text-gray-700 hover:border-purple-300 hover:bg-purple-50"
                  title={`${e.pending} pending · ${e.missed} missed`}
                >
                  <span className="truncate max-w-[10rem]">{e.name}</span>
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">{e.pending}</span>
                  {e.missed > 0 && (
                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold text-red-700">{e.missed}</span>
                  )}
                </button>
              ))
            )}
            {employeeOptions.length > 40 && (
              <span className="self-center text-[10px] text-gray-400">+{employeeOptions.length - 40} more — use search</span>
            )}
          </div>
        </div>

        {/* Missed exams — review + reschedule */}
        {missedInScope.length > 0 && (
          <div className="rounded-xl border border-red-200 bg-red-50/40 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-wide text-red-700">
                Missed SOP exams ({missedInScope.length})
              </p>
              <p className="text-[10px] text-red-600/80">Reschedule moves the exam to another month without keeping the original month overdue</p>
            </div>
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {missedInScope.slice(0, 50).map((m) => (
                <div
                  key={`${m.employeeId}-${m.sopCode}-${m.fromMonth}-${m.fromYear}`}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-red-100 bg-white px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-gray-800">{m.employeeName}</p>
                    <p className="truncate text-[11px] text-gray-500">
                      {m.sopCode} — {m.sopName} · {MONTHS_FULL[m.fromMonth - 1]} {m.fromYear}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setRescheduleTarget(m);
                      setRescheduleToMonth(Math.min(12, Math.max(1, m.fromMonth + 1)));
                    }}
                    className="rounded-md bg-indigo-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-indigo-700"
                  >
                    Reschedule
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {viewMode === 'employee' ? (
          <div className="flex min-h-[calc(100vh-16rem)] flex-col">
            <EmployeeTrainingGrid
              rows={gridRows}
              rosterLoading={loading}
              trainingLoading={false}
              showActions
            />
          </div>
        ) : (
          <div className="flex min-h-[calc(100vh-16rem)] flex-col">
            <SopTrainingGrid
              rows={sopRows}
              loading={loading}
              onDrill={setSopDrill}
            />
          </div>
        )}
      </main>

      {sopDrill && (
        <SopDrillDownModal drill={sopDrill} records={records} dept={dept} onClose={() => setSopDrill(null)} />
      )}

      {rescheduleTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !rescheduleBusy && setRescheduleTarget(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-sm font-bold text-gray-900">Reschedule missed SOP exam</h2>
            <p className="mt-1 text-xs text-gray-500">
              {rescheduleTarget.employeeName} · {rescheduleTarget.sopCode}
            </p>
            <p className="mt-2 text-xs text-gray-600">
              From <strong>{MONTHS_FULL[rescheduleTarget.fromMonth - 1]} {rescheduleTarget.fromYear}</strong> to:
            </p>
            <select
              value={rescheduleToMonth}
              onChange={(e) => setRescheduleToMonth(Number(e.target.value))}
              className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
            >
              {MONTHS_FULL.map((name, idx) => (
                <option key={name} value={idx + 1} disabled={idx + 1 === rescheduleTarget.fromMonth}>
                  {name} {rescheduleTarget.fromYear}
                </option>
              ))}
            </select>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={rescheduleBusy}
                onClick={() => setRescheduleTarget(null)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={rescheduleBusy || rescheduleToMonth === rescheduleTarget.fromMonth}
                onClick={async () => {
                  setRescheduleBusy(true);
                  try {
                    const res = await fetch('/api/lms/reschedule', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        department: rescheduleTarget.department,
                        sopCode: rescheduleTarget.sopCode,
                        employeeId: rescheduleTarget.employeeId,
                        employeeName: rescheduleTarget.employeeName,
                        fromMonth: rescheduleTarget.fromMonth,
                        fromYear: rescheduleTarget.fromYear,
                        toMonth: rescheduleToMonth,
                        toYear: rescheduleTarget.fromYear,
                      }),
                    });
                    const json = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(json.error || 'Reschedule failed');
                    setRescheduleTarget(null);
                    await load(true);
                  } catch (err) {
                    window.alert(err instanceof Error ? err.message : 'Reschedule failed');
                  } finally {
                    setRescheduleBusy(false);
                  }
                }}
                className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {rescheduleBusy ? 'Saving…' : 'Save reschedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
