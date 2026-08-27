'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, CalendarCheck, Check, ClipboardList, RefreshCw, Trash2, UserCheck, Users, X,
} from 'lucide-react';
import {
  countEmployeeUniqueSops,
  countUniqueSops,
  listEmployeeUniqueSops,
} from '@/lib/lmsTrainerExamCounts';
import { MarkAttendanceModal } from '@/components/lms/MarkAttendanceModal';
import { toDateOnlyIso } from '@/lib/trainingExamScheduleShared';
import { deptMatchesTrainerScope } from '@/lib/lmsTrainerScope';

type ExamStatus = 'completed' | 'pending' | 'overdue';

export interface TrainerSopEmployee {
  employeeId: string;
  employeeName: string;
  department: string;
  status: ExamStatus;
  assignedAt?: string;
  scheduledDate?: string;
}

export interface TrainerUniqueSop {
  sopCode: string;
  sopName: string;
  employeeCount: number;
  completed: number;
  pending: number;
  overdue: number;
  /** Earliest assigned date among sittings, when any. */
  assignedAt?: string;
  employees: TrainerSopEmployee[];
}

export interface TrainerBulkBridge {
  mode: 'schedule-training' | 'mark-attendance';
  selectedSopCodes: Set<string>;
  onToggle: (sopCode: string) => void;
  /** Select or clear all SOPs currently listed for bulk mode. */
  onToggleAll: (sopCodes: string[], select: boolean) => void;
  uniqueSops: TrainerUniqueSop[];
  examCatalog: Record<string, { questionCount: number; lmsApproved: boolean }>;
  month: number | 'all';
  year: number;
  onOpenEmployees: (sopCode: string, sopName: string) => void;
}

/** Always-on trainer dept SOP metadata for the My Trainings table columns. */
export interface TrainerTableData {
  uniqueSops: TrainerUniqueSop[];
  examCatalog: Record<string, { questionCount: number; lmsApproved: boolean }>;
  onOpenEmployees: (sopCode: string, sopName: string) => void;
  /** SOPs with at least one employee exam scheduled for today. */
  scheduledTodayByCode: Record<string, boolean>;
  onOpenAttendance: (sopCode: string, sopName: string) => void;
  /**
   * When set, My Trainings should show only these trainer-dept SOPs
   * (scheduling status filter). `null` = no schedule-status restriction.
   */
  scheduleFilteredSops: TrainerUniqueSop[] | null;
  scheduleFilterLabel: string | null;
}

type ScheduleMainFilter = 'all' | 'scheduled' | 'not_scheduled';
type ScheduleSubFilter = 'all' | 'today' | 'date' | 'week' | 'month';

function sopExamDates(sop: TrainerUniqueSop): string[] {
  const dates = new Set<string>();
  for (const e of sop.employees) {
    const d = String(e.scheduledDate || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) dates.add(d);
  }
  return [...dates];
}

function isSopExamScheduled(sop: TrainerUniqueSop): boolean {
  return sopExamDates(sop).length > 0 || Boolean(sop.assignedAt);
}

function startOfLocalWeek(isoOrDate: Date): Date {
  const x = new Date(isoOrDate.getFullYear(), isoOrDate.getMonth(), isoOrDate.getDate());
  const day = x.getDay(); // 0 = Sun
  const diff = day === 0 ? -6 : 1 - day; // Monday start
  x.setDate(x.getDate() + diff);
  return x;
}

function endOfLocalWeek(isoOrDate: Date): Date {
  const start = startOfLocalWeek(isoOrDate);
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
}

function dateInRange(iso: string, start: Date, end: Date): boolean {
  const t = iso.slice(0, 10);
  const a = toDateOnlyIso(start);
  const b = toDateOnlyIso(end);
  return t >= a && t <= b;
}

function sopMatchesScheduleFilter(
  sop: TrainerUniqueSop,
  main: ScheduleMainFilter,
  sub: ScheduleSubFilter,
  specificDate: string,
  todayIso: string,
  now: Date,
): boolean {
  const scheduled = isSopExamScheduled(sop);
  if (main === 'all') return true;
  if (main === 'not_scheduled') return !scheduled;
  if (!scheduled) return false;
  if (sub === 'all') return true;
  const dates = sopExamDates(sop);
  if (dates.length === 0) {
    // assignedAt only — treat as scheduled but with unknown exam day; show under All Scheduled only
    return false;
  }
  if (sub === 'today') return dates.some((d) => d === todayIso);
  if (sub === 'date') {
    const want = specificDate.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(want)) return false;
    return dates.some((d) => d === want);
  }
  if (sub === 'week') {
    const start = startOfLocalWeek(now);
    const end = endOfLocalWeek(now);
    return dates.some((d) => dateInRange(d, start, end));
  }
  if (sub === 'month') {
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const prefix = `${y}-${String(m).padStart(2, '0')}`;
    return dates.some((d) => d.startsWith(prefix));
  }
  return true;
}

interface MonthlyRow {
  key: string;
  employeeId: string;
  employeeName: string;
  designation: string;
  department: string;
  sopCode: string;
  sopName: string;
  month: number;
  year: number;
  scheduledDate?: string;
  assignedAt?: string;
  status: ExamStatus;
  isIgnored: boolean;
  daysOverdue: number;
  hasLmsAccess: boolean;
}

interface ExamCatalogEntry {
  sopCode: string;
  questionCount: number;
  lmsApproved: boolean;
  department?: string;
}

interface CycleStart {
  year: number;
  month: number;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

type BulkMode = 'idle' | 'schedule-training' | 'mark-attendance';

function parseCycleStart(raw: string | undefined | null): CycleStart | null {
  const m = /^(\d{4})-(\d{1,2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return null;
  return { year, month };
}

function monthIndex(year: number, month: number): number {
  return year * 12 + month;
}

/**
 * Rows for a selected month:
 * - SOPs scheduled for that month
 * - plus still-overdue sittings from earlier months in the cycle
 *   (e.g. August delayed into September)
 * Pre-cycle months never appear.
 */
function rowsForMonthFilter(
  rows: MonthlyRow[],
  monthFilter: number | 'all',
  year: number,
  cycle: CycleStart | null,
): MonthlyRow[] {
  if (monthFilter === 'all') return rows;

  const viewIdx = monthIndex(year, monthFilter);
  return rows.filter((r) => {
    const rowIdx = monthIndex(r.year, r.month);
    if (cycle && rowIdx < monthIndex(cycle.year, cycle.month)) return false;
    if (r.month === monthFilter && r.year === year) return true;
    // Delayed spillover into this month from an earlier cycle month
    if (r.status === 'overdue' && rowIdx < viewIdx) return true;
    return false;
  });
}

/**
 * Trainer controls on the LMS "My Training" page. SOP selection reuses the
 * My Trainings table via onBulkBridge — this panel only owns filters/actions.
 */
export function TrainerLmsSchedulePanel({
  onBulkBridge,
  onTrainerData,
  onAttendanceSaved,
  monthFilter: monthFilterProp,
}: {
  onBulkBridge?: (bridge: TrainerBulkBridge | null) => void;
  onTrainerData?: (data: TrainerTableData | null) => void;
  /** Called after an attendance sheet is saved from My Trainings. */
  onAttendanceSaved?: () => void;
  /** Shared with My Trainings month chips. */
  monthFilter?: number | 'all';
} = {}) {
  const now = new Date();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<MonthlyRow[]>([]);
  const [year] = useState(now.getFullYear());
  const [monthFilterLocal] = useState<number | 'all'>(now.getMonth() + 1);
  const monthFilter = monthFilterProp ?? monthFilterLocal;
  const [bulkMode, setBulkMode] = useState<BulkMode>('idle');
  const [selectedSopCodes, setSelectedSopCodes] = useState<Set<string>>(new Set());
  const [bulkDate, setBulkDate] = useState(() => now.toISOString().slice(0, 10));
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState('');
  const [scheduleMain, setScheduleMain] = useState<ScheduleMainFilter>('all');
  const [scheduleSub, setScheduleSub] = useState<ScheduleSubFilter>('all');
  const [scheduleSpecificDate, setScheduleSpecificDate] = useState(() => now.toISOString().slice(0, 10));
  const [overdueOpen, setOverdueOpen] = useState(false);
  const [employeePopup, setEmployeePopup] = useState<{
    sopCode: string;
    sopName: string;
    employeeIds: string[];
  } | null>(null);
  const [empSopDetail, setEmpSopDetail] = useState<{
    title: string;
    subtitle: string;
    rows: MonthlyRow[];
  } | null>(null);
  const [attendancePopup, setAttendancePopup] = useState<{
    sopCode: string;
    sopName: string;
    employees: TrainerSopEmployee[];
  } | null>(null);
  const [trainerDepartments, setTrainerDepartments] = useState<string[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignDept, setAssignDept] = useState('');
  const [assignName, setAssignName] = useState('');
  const [assignDesignation, setAssignDesignation] = useState('');
  const [assignRoster, setAssignRoster] = useState<Array<{
    name: string;
    designation: string;
    department: string;
  }>>([]);
  const [assignBusy, setAssignBusy] = useState(false);
  const [assignMsg, setAssignMsg] = useState('');
  const [examCatalog, setExamCatalog] = useState<Map<string, ExamCatalogEntry>>(new Map());
  const [cycleStart, setCycleStart] = useState<CycleStart | null>(() => ({
    year: now.getFullYear(),
    month: now.getMonth() + 1,
  }));

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [monthlyRes, catalogRes] = await Promise.all([
        fetch(`/api/lms/trainer/monthly?year=${year}`, { cache: 'no-store' }),
        fetch('/api/lms/trainer/exam-catalog', { cache: 'no-store' }),
      ]);
      const json = await monthlyRes.json();
      if (monthlyRes.status === 401) {
        // Session expired mid-visit — say so instead of surfacing the raw
        // "Not authenticated" API error.
        setError('Your session has expired. Sign out and sign in again to continue.');
        setRows([]);
        return;
      }
      if (monthlyRes.status === 403) {
        setError('');
        setRows([]);
        return;
      }
      if (!monthlyRes.ok) throw new Error(json.error || 'Failed to load trainer schedule data');
      setRows((json.rows ?? []) as MonthlyRow[]);
      setTrainerDepartments(
        Array.isArray(json.trainer?.trainerDepartments)
          ? (json.trainer.trainerDepartments as string[])
          : [],
      );
      const parsed = parseCycleStart(json.trainingCycleStart);
      if (parsed) setCycleStart(parsed);

      if (catalogRes.ok) {
        const catalogJson = await catalogRes.json();
        const map = new Map<string, ExamCatalogEntry>();
        for (const e of (catalogJson.exams ?? []) as ExamCatalogEntry[]) {
          const code = String(e.sopCode || '').trim().toUpperCase();
          if (!code) continue;
          map.set(code, {
            sopCode: code,
            questionCount: Number(e.questionCount) || 0,
            lmsApproved: e.lmsApproved === true,
          });
        }
        setExamCatalog(map);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Rows limited to employees in the trainer's departments (QA, Production, …). */
  const scopedRows = useMemo(() => {
    if (trainerDepartments.length === 0) return rows;
    return rows.filter((r) => deptMatchesTrainerScope(r.department, trainerDepartments));
  }, [rows, trainerDepartments]);

  /** Live work inside the training cycle — pre-cycle months are ignored. */
  const liveRows = useMemo(() => {
    return scopedRows.filter((r) => {
      if (r.isIgnored) return false;
      if (!cycleStart) return true;
      return monthIndex(r.year, r.month) >= monthIndex(cycleStart.year, cycleStart.month);
    });
  }, [scopedRows, cycleStart]);

  const monthScopedRows = useMemo(
    () => rowsForMonthFilter(liveRows, monthFilter, year, cycleStart),
    [liveRows, monthFilter, year, cycleStart],
  );

  const uniqueSops = useMemo(() => {
    const map = new Map<string, TrainerUniqueSop>();
    for (const r of monthScopedRows) {
      const key = r.sopCode.trim().toUpperCase();
      let e = map.get(key);
      if (!e) {
        e = {
          sopCode: key,
          sopName: r.sopName,
          employeeCount: 0,
          completed: 0,
          pending: 0,
          overdue: 0,
          employees: [],
        };
        map.set(key, e);
      }
      e.employeeCount++;
      if (r.status === 'completed') e.completed++;
      else if (r.status === 'overdue') e.overdue++;
      else e.pending++;
      if (!e.employees.some((emp) => emp.employeeId === r.employeeId)) {
        e.employees.push({
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          department: r.department,
          status: r.status,
          assignedAt: r.assignedAt,
          scheduledDate: r.scheduledDate,
        });
      }
      if (r.assignedAt && (!e.assignedAt || r.assignedAt < e.assignedAt)) {
        e.assignedAt = r.assignedAt;
      }
    }
    for (const e of map.values()) {
      e.employees.sort((a, b) => a.employeeName.localeCompare(b.employeeName));
    }
    return [...map.values()].sort((a, b) => a.sopCode.localeCompare(b.sopCode));
  }, [monthScopedRows]);

  const toggleSop = useCallback((code: string) => {
    setSelectedSopCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  const toggleAllSops = useCallback((sopCodes: string[], select: boolean) => {
    setSelectedSopCodes((prev) => {
      if (!select) {
        const next = new Set(prev);
        for (const code of sopCodes) next.delete(code);
        return next;
      }
      return new Set([...prev, ...sopCodes.map((c) => c.trim().toUpperCase())]);
    });
  }, []);

  const openEmployees = useCallback((sopCode: string, sopName: string) => {
    const key = sopCode.trim().toUpperCase();
    const sop = uniqueSops.find((s) => s.sopCode === key);
    setEmployeePopup({
      sopCode: key,
      sopName: sopName || sop?.sopName || key,
      employeeIds: (sop?.employees ?? []).map((e) => e.employeeId),
    });
    setEmpSopDetail(null);
  }, [uniqueSops]);

  const todayIso = useMemo(() => toDateOnlyIso(new Date()), []);

  const scheduleCounts = useMemo(() => {
    const clock = new Date();
    let scheduled = 0;
    let notScheduled = 0;
    let today = 0;
    let week = 0;
    let month = 0;
    const start = startOfLocalWeek(clock);
    const end = endOfLocalWeek(clock);
    const prefix = `${clock.getFullYear()}-${String(clock.getMonth() + 1).padStart(2, '0')}`;
    const byDate = new Map<string, number>();
    for (const sop of uniqueSops) {
      if (isSopExamScheduled(sop)) {
        scheduled++;
        const dates = sopExamDates(sop);
        for (const d of dates) {
          byDate.set(d, (byDate.get(d) || 0) + 1);
        }
        if (dates.some((d) => d === todayIso)) today++;
        if (dates.some((d) => dateInRange(d, start, end))) week++;
        if (dates.some((d) => d.startsWith(prefix))) month++;
      } else {
        notScheduled++;
      }
    }
    const availableDates = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, count]) => ({ date, count }));
    return { all: uniqueSops.length, scheduled, notScheduled, today, week, month, availableDates };
  }, [uniqueSops, todayIso]);

  // Keep specific-date filter on a date that actually has sittings.
  useEffect(() => {
    if (scheduleMain !== 'scheduled' || scheduleSub !== 'date') return;
    const dates = scheduleCounts.availableDates;
    if (dates.length === 0) return;
    if (!dates.some((d) => d.date === scheduleSpecificDate)) {
      setScheduleSpecificDate(dates[0].date);
    }
  }, [scheduleMain, scheduleSub, scheduleCounts.availableDates, scheduleSpecificDate]);

  const displayUniqueSops = useMemo(() => {
    const clock = new Date();
    return uniqueSops.filter((sop) => sopMatchesScheduleFilter(
      sop,
      scheduleMain,
      scheduleSub,
      scheduleSpecificDate,
      todayIso,
      clock,
    ));
  }, [uniqueSops, scheduleMain, scheduleSub, scheduleSpecificDate, todayIso]);

  const scheduleFilterLabel = useMemo(() => {
    if (scheduleMain === 'all') return null;
    if (scheduleMain === 'not_scheduled') return 'Not scheduled';
    if (scheduleSub === 'today') return 'Scheduled today';
    if (scheduleSub === 'week') return 'Scheduled this week';
    if (scheduleSub === 'month') return 'Scheduled this month';
    if (scheduleSub === 'date') return `Scheduled on ${scheduleSpecificDate}`;
    return 'All scheduled';
  }, [scheduleMain, scheduleSub, scheduleSpecificDate]);

  const scheduledTodayByCode = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const sop of uniqueSops) {
      out[sop.sopCode] = sop.employees.some(
        (e) => e.scheduledDate && String(e.scheduledDate).slice(0, 10) === todayIso,
      );
    }
    return out;
  }, [uniqueSops, todayIso]);

  const openAttendance = useCallback((sopCode: string, sopName: string) => {
    const key = sopCode.trim().toUpperCase();
    const sop = uniqueSops.find((s) => s.sopCode === key);
    const employees = (sop?.employees ?? []).filter(
      (e) => e.scheduledDate && String(e.scheduledDate).slice(0, 10) === todayIso,
    );
    setAttendancePopup({
      sopCode: key,
      sopName: sopName || sop?.sopName || key,
      employees: employees.length > 0 ? employees : (sop?.employees ?? []),
    });
  }, [uniqueSops, todayIso]);

  const monthLabel = monthFilter === 'all'
    ? 'all months'
    : (MONTHS[monthFilter - 1] || `Month ${monthFilter}`);

  /** Employees on the opened SOP, with month-wide unique exam counts (same as Trainer Monthly). */
  const employeePopupBoard = useMemo(() => {
    if (!employeePopup) return [];
    const sopCode = employeePopup.sopCode;
    const sopEmployees = uniqueSops.find((s) => s.sopCode === sopCode)?.employees ?? [];
    const statusById = new Map(sopEmployees.map((e) => [e.employeeId, e.status]));
    const idSet = new Set(employeePopup.employeeIds);
    const map = new Map<string, {
      employeeId: string;
      employeeName: string;
      department: string;
      sopStatus: ExamStatus;
      rows: MonthlyRow[];
      uniqueTotal: number;
      uniqueCompleted: number;
      uniqueRemaining: number;
    }>();
    for (const r of monthScopedRows) {
      if (!idSet.has(r.employeeId)) continue;
      let entry = map.get(r.employeeId);
      if (!entry) {
        entry = {
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          department: r.department,
          sopStatus: statusById.get(r.employeeId)
            || (r.sopCode.trim().toUpperCase() === sopCode ? r.status : 'pending'),
          rows: [],
          uniqueTotal: 0,
          uniqueCompleted: 0,
          uniqueRemaining: 0,
        };
        map.set(r.employeeId, entry);
      }
      entry.rows.push(r);
      if (r.sopCode.trim().toUpperCase() === sopCode) {
        entry.sopStatus = r.status;
      }
    }
    for (const id of employeePopup.employeeIds) {
      if (map.has(id)) continue;
      const fromSop = sopEmployees.find((e) => e.employeeId === id);
      if (!fromSop) continue;
      map.set(id, {
        employeeId: id,
        employeeName: fromSop.employeeName,
        department: fromSop.department,
        sopStatus: fromSop.status,
        rows: [],
        uniqueTotal: 0,
        uniqueCompleted: 0,
        uniqueRemaining: 0,
      });
    }
    return [...map.values()]
      .filter((entry) => deptMatchesTrainerScope(entry.department, trainerDepartments))
      .map((entry) => {
        const unique = countEmployeeUniqueSops(entry.rows);
        return {
          ...entry,
          uniqueTotal: unique.total,
          uniqueCompleted: unique.completed,
          uniqueRemaining: unique.remaining,
        };
      })
      .sort((a, b) => {
        const rank = (s: ExamStatus) => (s === 'completed' ? 1 : 0);
        const byStatus = rank(a.sopStatus) - rank(b.sopStatus);
        if (byStatus !== 0) return byStatus;
        return a.employeeName.localeCompare(b.employeeName);
      });
  }, [employeePopup, monthScopedRows, uniqueSops, trainerDepartments]);

  const openEmployeeSopDetail = useCallback((
    emp: { employeeName: string; rows: MonthlyRow[] },
    kind: 'completed' | 'remaining' | 'total',
  ) => {
    const list = listEmployeeUniqueSops(emp.rows, kind === 'total' ? undefined : kind);
    const live = list.filter((i) => i.kind !== 'ignored');
    const codes = new Set(live.map((i) => i.sopCode));
    const detailRows = emp.rows
      .filter((r) => !r.isIgnored && codes.has(r.sopCode.trim().toUpperCase()))
      .sort((a, b) => a.sopCode.localeCompare(b.sopCode));
    setEmpSopDetail({
      title: kind === 'completed'
        ? `Completed · ${emp.employeeName}`
        : kind === 'remaining'
          ? `Remaining · ${emp.employeeName}`
          : `Required SOP exams · ${emp.employeeName}`,
      subtitle: `${live.length} unique SOP${live.length === 1 ? '' : 's'} · ${detailRows.length} row${detailRows.length === 1 ? '' : 's'} · ${monthLabel}`,
      rows: detailRows,
    });
  }, [monthLabel]);

  const catalogRecord = useMemo(() => {
    const out: Record<string, { questionCount: number; lmsApproved: boolean }> = {};
    for (const [code, e] of examCatalog) {
      out[code] = { questionCount: e.questionCount, lmsApproved: e.lmsApproved };
    }
    return out;
  }, [examCatalog]);

  useEffect(() => {
    if (!onTrainerData) return;
    onTrainerData({
      uniqueSops,
      examCatalog: catalogRecord,
      onOpenEmployees: openEmployees,
      scheduledTodayByCode,
      onOpenAttendance: openAttendance,
      scheduleFilteredSops: scheduleMain === 'all' ? null : displayUniqueSops,
      scheduleFilterLabel,
    });
  }, [
    onTrainerData, uniqueSops, catalogRecord, openEmployees, scheduledTodayByCode,
    openAttendance, scheduleMain, displayUniqueSops, scheduleFilterLabel,
  ]);

  useEffect(() => {
    if (!onTrainerData) return;
    return () => {
      onTrainerData(null);
    };
  }, [onTrainerData]);

  useEffect(() => {
    if (!onBulkBridge) return;
    if (bulkMode === 'idle') {
      onBulkBridge(null);
      return;
    }
    onBulkBridge({
      mode: bulkMode,
      selectedSopCodes,
      onToggle: toggleSop,
      onToggleAll: toggleAllSops,
      uniqueSops: displayUniqueSops,
      examCatalog: catalogRecord,
      month: monthFilter,
      year,
      onOpenEmployees: openEmployees,
    });
  }, [
    onBulkBridge, bulkMode, selectedSopCodes, toggleSop, toggleAllSops, displayUniqueSops,
    catalogRecord, monthFilter, year, openEmployees,
  ]);

  const overdueRows = useMemo(
    () => monthScopedRows.filter((r) => r.status === 'overdue'),
    [monthScopedRows],
  );

  const overdueSopCount = useMemo(
    () => countUniqueSops(overdueRows).overdue,
    [overdueRows],
  );

  const cycleLabel = cycleStart
    ? `${MONTHS_SHORT[cycleStart.month - 1]} ${cycleStart.year}`
    : null;

  const startBulk = (mode: Exclude<BulkMode, 'idle'>) => {
    setBulkMode(mode);
    setSelectedSopCodes(new Set());
    setBulkDate(now.toISOString().slice(0, 10));
    setBulkMsg('');
  };

  const cancelBulk = () => {
    setBulkMode('idle');
    setSelectedSopCodes(new Set());
  };

  const submitBulk = async () => {
    if (bulkMode !== 'schedule-training' || selectedSopCodes.size === 0 || !bulkDate) return;
    setBulkBusy(true);
    setBulkMsg('');
    try {
      const res = await fetch('/api/lms/trainer/bulk-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: bulkMode,
          sopCodes: [...selectedSopCodes],
          date: bulkDate,
          month: monthFilter === 'all' ? undefined : monthFilter,
          year,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Action failed');

      setBulkMsg(
        `Assigned date ${json.date} to ${json.scheduled ?? 0} employee(s)`
        + (json.sessions != null ? ` · ${json.sessions} attendance session(s)` : '')
        + (json.skipped?.length ? ` · ${json.skipped.length} skipped` : ''),
      );
      setBulkMode('idle');
      setSelectedSopCodes(new Set());
      await load();
    } catch (err) {
      setBulkMsg(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const removeAssignForCodes = async (sopCodes: string[]) => {
    if (sopCodes.length === 0) return;
    const scope = monthFilter === 'all' ? 'all months' : monthLabel;
    if (!window.confirm(
      `Remove exam assignments for ${sopCodes.length} SOP${sopCodes.length === 1 ? '' : 's'} (${scope})?\n\n`
      + 'This cancels scheduled exams for employees in your trainer departments. Completed progress is not deleted.',
    )) return;

    setBulkBusy(true);
    setBulkMsg('');
    try {
      const res = await fetch('/api/lms/trainer/bulk-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'remove-assign',
          sopCodes,
          month: monthFilter === 'all' ? undefined : monthFilter,
          year,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to remove assignments');
      setBulkMsg(
        `Removed ${json.cancelled ?? 0} exam assignment${(json.cancelled ?? 0) === 1 ? '' : 's'}`
        + (json.matched && json.matched !== json.cancelled
          ? ` (${json.matched} matched)`
          : ''),
      );
      setBulkMode('idle');
      setSelectedSopCodes(new Set());
      await load();
    } catch (err) {
      setBulkMsg(err instanceof Error ? err.message : 'Failed to remove assignments');
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <section className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-bold text-gray-800">Trainer — schedule &amp; assign</h2>
          <p className="text-[10px] text-gray-400">
            SOPs in your trainer departments
            {trainerDepartments.length > 0 ? ` (${trainerDepartments.join(', ')})` : ''}
            {cycleLabel ? ` · cycle from ${cycleLabel}` : ''}
            — earlier months ignored; delayed exams carry into later months.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {overdueSopCount > 0 && (
            <button
              type="button"
              onClick={() => setOverdueOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-bold text-red-700 hover:bg-red-100"
            >
              <AlertCircle className="h-3.5 w-3.5" />
              {overdueSopCount} delayed SOP{overdueSopCount === 1 ? '' : 's'}
            </button>
          )}
          <button
            type="button"
            onClick={() => startBulk('schedule-training')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold ${
              bulkMode === 'schedule-training'
                ? 'bg-emerald-700 text-white'
                : 'border border-emerald-600 bg-white text-emerald-800 hover:bg-emerald-50'
            }`}
          >
            <CalendarCheck className="h-3.5 w-3.5" /> Schedule Training
          </button>
          <button
            type="button"
            onClick={async () => {
              setAssignOpen(true);
              setAssignMsg('');
              setAssignName('');
              setAssignDesignation('');
              const first = trainerDepartments[0] || '';
              setAssignDept(first);
              try {
                const res = await fetch('/api/lms/trainer/schedulable-employees', { cache: 'no-store' });
                const json = await res.json();
                const list = Array.isArray(json.employees) ? json.employees : [];
                setAssignRoster(list.map((e: { name?: string; employeeName?: string; designation?: string; department?: string }) => ({
                  name: String(e.name || e.employeeName || '').trim(),
                  designation: String(e.designation || '').trim(),
                  department: String(e.department || '').trim(),
                })).filter((e: { name: string; department: string }) => e.name && e.department));
              } catch {
                setAssignRoster([]);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-orange-300 bg-orange-50 px-2.5 py-1.5 text-xs font-bold text-orange-800 hover:bg-orange-100"
            title="Assign department SOPs to an employee for training"
          >
            <Users className="h-3.5 w-3.5" /> Assign Employee SOP for Training
          </button>
          <button
            type="button"
            onClick={() => startBulk('mark-attendance')}
            className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-bold ${
              bulkMode === 'mark-attendance'
                ? 'bg-teal-700 text-white'
                : 'bg-teal-600 text-white hover:bg-teal-700'
            }`}
          >
            <UserCheck className="h-3.5 w-3.5" /> Mark Attendance
          </button>
          <button
            type="button"
            disabled={bulkBusy || displayUniqueSops.length === 0}
            onClick={() => void removeAssignForCodes(displayUniqueSops.map((s) => s.sopCode))}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-2.5 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
            title="Cancel scheduled exam assignments for SOPs in the current filters"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove Assign All
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

      {/* Scheduling status filters */}
      <div className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            Scheduling status
          </p>
          {scheduleFilterLabel ? (
            <button
              type="button"
              onClick={() => {
                setScheduleMain('all');
                setScheduleSub('all');
              }}
              className="text-[11px] font-semibold text-indigo-600 hover:underline"
            >
              Clear · showing {displayUniqueSops.length} of {uniqueSops.length}
            </button>
          ) : (
            <span className="text-[11px] text-gray-400">
              {uniqueSops.length} SOP{uniqueSops.length === 1 ? '' : 's'} this month
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {([
            { id: 'all' as const, label: 'All SOPs', count: scheduleCounts.all },
            { id: 'scheduled' as const, label: 'Scheduled', count: scheduleCounts.scheduled },
            { id: 'not_scheduled' as const, label: 'Not Scheduled', count: scheduleCounts.notScheduled },
          ]).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setScheduleMain(tab.id);
                if (tab.id !== 'scheduled') setScheduleSub('all');
              }}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                scheduleMain === tab.id
                  ? tab.id === 'not_scheduled'
                    ? 'bg-amber-600 text-white'
                    : tab.id === 'scheduled'
                      ? 'bg-emerald-700 text-white'
                      : 'bg-gray-800 text-white'
                  : 'border border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
              }`}
            >
              {tab.label}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                scheduleMain === tab.id ? 'bg-white/20' : 'bg-gray-100 text-gray-500'
              }`}>
                {tab.count}
              </span>
            </button>
          ))}

          {scheduleMain === 'scheduled' && (
            <>
              <span className="mx-0.5 h-4 w-px shrink-0 bg-gray-200" aria-hidden />
              <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                When
              </span>
              {([
                { id: 'all' as const, label: 'All Scheduled', count: scheduleCounts.scheduled },
                { id: 'today' as const, label: 'Today', count: scheduleCounts.today },
                { id: 'week' as const, label: 'This Week', count: scheduleCounts.week },
                { id: 'month' as const, label: 'This Month', count: scheduleCounts.month },
                { id: 'date' as const, label: 'By Date', count: scheduleCounts.availableDates.length },
              ]).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setScheduleSub(tab.id);
                    if (tab.id === 'date' && scheduleCounts.availableDates.length > 0) {
                      const stillValid = scheduleCounts.availableDates.some(
                        (d) => d.date === scheduleSpecificDate,
                      );
                      if (!stillValid) setScheduleSpecificDate(scheduleCounts.availableDates[0].date);
                    }
                  }}
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                    scheduleSub === tab.id
                      ? 'bg-emerald-600 text-white'
                      : 'border border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  }`}
                >
                  {tab.label}
                  <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                    scheduleSub === tab.id ? 'bg-white/20' : 'bg-white text-emerald-700'
                  }`}>
                    {tab.count}
                  </span>
                </button>
              ))}
            </>
          )}
        </div>

        {scheduleMain === 'scheduled' && scheduleSub === 'date' && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {scheduleCounts.availableDates.length === 0 ? (
              <span className="text-[11px] text-gray-400">No exam dates assigned yet</span>
            ) : (
              scheduleCounts.availableDates.map(({ date, count }) => {
                const label = (() => {
                  const d = new Date(`${date}T12:00:00`);
                  if (Number.isNaN(d.getTime())) return date;
                  return d.toLocaleDateString('en-GB', {
                    day: '2-digit',
                    month: 'short',
                    year: 'numeric',
                  });
                })();
                return (
                  <button
                    key={date}
                    type="button"
                    onClick={() => setScheduleSpecificDate(date)}
                    className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold transition ${
                      scheduleSpecificDate === date
                        ? 'bg-teal-700 text-white'
                        : 'border border-teal-200 bg-white text-teal-900 hover:bg-teal-50'
                    }`}
                  >
                    {label}
                    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                      scheduleSpecificDate === date ? 'bg-white/20' : 'bg-teal-50 text-teal-700'
                    }`}>
                      {count}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
        </div>
      )}

      {bulkMsg && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          {bulkMsg}
        </div>
      )}

      {bulkMode !== 'idle' && (
        <div className={`rounded-xl border p-3 ${
          bulkMode === 'mark-attendance'
            ? 'border-teal-200 bg-teal-50/50'
            : 'border-indigo-200 bg-indigo-50/50'
        }`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className={`text-[11px] font-semibold uppercase tracking-wide ${
              bulkMode === 'mark-attendance' ? 'text-teal-800' : 'text-indigo-800'
            }`}>
              {bulkMode === 'mark-attendance'
                ? 'Mark Attendance — click a SOP below to open the attendance sheet'
                : 'Schedule Training — assign date to SOPs below'}
              <span className={`ml-1 font-normal normal-case ${
                bulkMode === 'mark-attendance' ? 'text-teal-700/70' : 'text-indigo-700/70'
              }`}>
                (use My Trainings table)
              </span>
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {bulkMode === 'schedule-training' && (
                <>
                  <label className="text-[11px] font-semibold text-gray-600">
                    Assigned date
                    <input
                      type="date"
                      value={bulkDate}
                      onChange={(e) => setBulkDate(e.target.value)}
                      className="ml-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => setSelectedSopCodes(new Set(displayUniqueSops.map((s) => s.sopCode)))}
                    className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-600"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    disabled={bulkBusy || selectedSopCodes.size === 0}
                    onClick={() => void removeAssignForCodes([...selectedSopCodes])}
                    className="inline-flex items-center gap-1 rounded-lg border border-red-300 bg-white px-2 py-1 text-[11px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                  >
                    <Trash2 className="h-3 w-3" />
                    Remove assign ({selectedSopCodes.size})
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={cancelBulk}
                className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-gray-600"
              >
                Cancel
              </button>
              {bulkMode === 'schedule-training' && (
                <button
                  type="button"
                  disabled={bulkBusy || selectedSopCodes.size === 0 || !bulkDate}
                  onClick={() => void submitBulk()}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                >
                  {bulkBusy ? 'Saving…' : `Assign date (${selectedSopCodes.size})`}
                </button>
              )}
            </div>
          </div>
          {uniqueSops.length === 0 && (
            <p className={`mt-2 text-center text-xs ${
              bulkMode === 'mark-attendance' ? 'text-teal-800/60' : 'text-indigo-800/60'
            }`}>
              No SOPs in {monthLabel}. Switch month filter or choose All.
            </p>
          )}
        </div>
      )}

      {/* Delayed / overdue — closed popup */}
      {overdueOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOverdueOpen(false)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-red-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 border-b border-red-100 bg-red-50 px-4 py-3">
              <div className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                <div>
                  <p className="text-sm font-bold text-red-900">
                    {overdueSopCount} delayed SOP{overdueSopCount === 1 ? '' : 's'}
                    {' · '}
                    {overdueRows.length} sitting{overdueRows.length === 1 ? '' : 's'}
                  </p>
                  <p className="text-[11px] text-red-700/80">
                    {monthLabel} {year}
                    {monthFilter !== 'all' ? ' (includes spillover from earlier cycle months)' : ''}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOverdueOpen(false)}
                className="rounded-lg p-1.5 text-red-400 hover:bg-red-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {overdueRows.length === 0 ? (
                <p className="py-10 text-center text-xs text-gray-400">No delayed items for this month.</p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 border-b border-gray-100 bg-gray-50">
                    <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                      <th className="px-3 py-2">Employee</th>
                      <th className="px-3 py-2">SOP</th>
                      <th className="px-3 py-2">Due</th>
                      <th className="px-3 py-2">Delay</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {overdueRows.map((r) => (
                      <tr key={r.key} className="hover:bg-red-50/40">
                        <td className="px-3 py-2 font-semibold text-gray-900">
                          {r.employeeName}
                          <span className="ml-1 font-normal text-gray-400">{r.department}</span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-mono font-bold text-purple-700">{r.sopCode}</span>
                          <span className="ml-1 text-gray-600">{r.sopName}</span>
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-700">
                          {r.scheduledDate || `${MONTHS[r.month - 1]} ${r.year}`}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap font-bold text-red-600">
                          {r.daysOverdue > 0 ? `+${r.daysOverdue}d` : 'Overdue'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Employees for one SOP — employee-wise capsules (same as Trainer Monthly) */}
      {employeePopup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => {
            setEmployeePopup(null);
            setEmpSopDetail(null);
          }}
        >
          <div
            className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-emerald-100 bg-[#F0F8F5] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-emerald-100 bg-white/70 px-4 py-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                  Employee-wise required SOP exams
                </p>
                <p className="mt-0.5 font-mono text-sm font-bold text-purple-700">
                  {employeePopup.sopCode}
                  <span className="ml-2 font-sans text-[11px] font-normal text-gray-600">
                    {employeePopup.sopName}
                  </span>
                </p>
                <p className="mt-0.5 text-[10px] text-emerald-800/70">
                  How many unique SOP exams each employee must complete in {monthLabel}.
                  Click green or red to see their SOPs.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEmployeePopup(null);
                  setEmpSopDetail(null);
                }}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white hover:text-gray-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {employeePopupBoard.length === 0 ? (
                <p className="py-10 text-center text-xs text-emerald-800/50">
                  No employees assigned to this SOP in {monthLabel}.
                </p>
              ) : (
                <div className="flex flex-wrap content-start gap-2">
                  {employeePopupBoard.map((emp) => {
                    const done = emp.sopStatus === 'completed';
                    return (
                      <div
                        key={emp.employeeId}
                        className="inline-flex items-center gap-1.5"
                      >
                        <button
                          type="button"
                          title={`${emp.employeeName}${emp.department ? ` · ${emp.department}` : ''} — ${done ? 'exam completed' : emp.sopStatus === 'overdue' ? 'exam delayed' : 'exam pending'}`}
                          onClick={() => openEmployeeSopDetail(emp, 'total')}
                          className={`inline-flex max-w-[11rem] truncate rounded-lg border px-2.5 py-1 text-[11px] font-medium ${
                            done
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                              : 'border-red-300 bg-red-50 text-red-800 hover:bg-red-100'
                          }`}
                        >
                          {emp.employeeName}
                        </button>
                        <SplitCountPill
                          done={emp.uniqueCompleted}
                          left={emp.uniqueRemaining}
                          onDoneClick={() => openEmployeeSopDetail(emp, 'completed')}
                          onLeftClick={() => openEmployeeSopDetail(emp, 'remaining')}
                        />
                        <button
                          type="button"
                          onClick={() => openEmployeeSopDetail(emp, 'total')}
                          className="text-[9px] font-semibold text-emerald-800/70 hover:underline"
                        >
                          {emp.uniqueTotal}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Detail: SOPs behind a green/red/total click */}
      {empSopDetail && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setEmpSopDetail(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-100 px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-gray-900">{empSopDetail.title}</h2>
                <p className="mt-0.5 text-[11px] text-gray-500">{empSopDetail.subtitle}</p>
              </div>
              <button
                type="button"
                onClick={() => setEmpSopDetail(null)}
                className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {empSopDetail.rows.length === 0 ? (
                <p className="py-10 text-center text-sm text-gray-400">No SOP exams to show.</p>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 border-b border-gray-100 bg-gray-50">
                    <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                      <th className="px-3 py-2">SOP Code</th>
                      <th className="px-3 py-2">Training / SOP name</th>
                      <th className="px-3 py-2">Assigned</th>
                      <th className="px-3 py-2">Due</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {empSopDetail.rows.map((r) => (
                      <tr key={r.key} className="hover:bg-gray-50/80">
                        <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] font-bold text-purple-700">
                          {r.sopCode}
                        </td>
                        <td className="px-3 py-2 text-gray-800">{r.sopName}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                          {r.assignedAt || '—'}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                          {r.scheduledDate || `${MONTHS[r.month - 1]} ${r.year}`}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              r.status === 'completed'
                                ? 'bg-green-100 text-green-700'
                                : r.status === 'overdue'
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {r.status === 'overdue'
                              ? 'Delayed'
                              : r.status.charAt(0).toUpperCase() + r.status.slice(1)}
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
      )}

      {assignOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !assignBusy && setAssignOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-xl bg-white p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-start justify-between">
              <div>
                <h3 className="text-sm font-bold text-gray-900">Assign Employee SOP for Training</h3>
                <p className="mt-0.5 text-[11px] text-gray-500">
                  Select a department, then the employee. Applicable designation SOPs are assigned automatically.
                </p>
              </div>
              <button type="button" onClick={() => setAssignOpen(false)} className="text-gray-400 hover:text-gray-700">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase text-gray-500">Department</label>
                <select
                  value={assignDept}
                  onChange={(e) => {
                    setAssignDept(e.target.value);
                    setAssignName('');
                    setAssignDesignation('');
                  }}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                >
                  <option value="">Select department…</option>
                  {(trainerDepartments.length > 0 ? trainerDepartments : [...new Set(assignRoster.map((e) => e.department))]).map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold uppercase text-gray-500">Employee</label>
                <select
                  value={assignName}
                  disabled={!assignDept}
                  onChange={(e) => {
                    const name = e.target.value;
                    const live = assignRoster.find(
                      (emp) => emp.name === name && emp.department.toLowerCase() === assignDept.toLowerCase(),
                    );
                    setAssignName(name);
                    setAssignDesignation(live?.designation || '');
                  }}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:bg-gray-50"
                >
                  <option value="">{assignDept ? 'Select employee…' : 'Select a department first'}</option>
                  {assignRoster
                    .filter((e) => e.department.toLowerCase() === assignDept.toLowerCase())
                    .map((e) => (
                      <option key={`${e.department}|${e.name}`} value={e.name}>
                        {e.name}{e.designation ? ` · ${e.designation}` : ''}
                      </option>
                    ))}
                </select>
              </div>
              {assignMsg && (
                <p className={`text-xs ${assignMsg.startsWith('Assigned') ? 'text-green-700' : 'text-red-600'}`}>
                  {assignMsg}
                </p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAssignOpen(false)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700"
              >
                Close
              </button>
              <button
                type="button"
                disabled={assignBusy || !assignDept || !assignName}
                onClick={async () => {
                  setAssignBusy(true);
                  setAssignMsg('');
                  try {
                    const res = await fetch('/api/training-matrix/assign-employee-sops', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        employeeName: assignName,
                        department: assignDept,
                        designation: assignDesignation,
                        assignApplicable: true,
                      }),
                    });
                    const json = await res.json();
                    if (!res.ok) throw new Error(json.error || 'Assign failed');
                    setAssignMsg(
                      json.assigned
                        ? `Assigned ${json.assigned} SOP${json.assigned === 1 ? '' : 's'} to ${assignName}.`
                        : (json.message || 'No applicable SOPs found for this designation.'),
                    );
                    await load();
                  } catch (err) {
                    setAssignMsg(err instanceof Error ? err.message : 'Failed to assign SOPs');
                  } finally {
                    setAssignBusy(false);
                  }
                }}
                className="rounded-lg bg-orange-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {assignBusy ? 'Assigning…' : 'Assign applicable SOPs'}
              </button>
            </div>
          </div>
        </div>
      )}

      {attendancePopup && (
        <MarkAttendanceModal
          sopCode={attendancePopup.sopCode}
          sopName={attendancePopup.sopName}
          trainingDate={todayIso}
          seedEmployees={attendancePopup.employees}
          onClose={() => setAttendancePopup(null)}
          onSaved={() => {
            void load();
            onAttendanceSaved?.();
          }}
        />
      )}
    </section>
  );
}

function SplitCountPill({
  done,
  left,
  onDoneClick,
  onLeftClick,
}: {
  done: number;
  left: number;
  onDoneClick?: () => void;
  onLeftClick?: () => void;
}) {
  return (
    <span className="inline-flex overflow-hidden rounded-full text-[11px] font-bold text-white shadow-sm">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDoneClick?.();
        }}
        title={`${done} completed — click to view SOPs`}
        className="inline-flex items-center gap-0.5 bg-[#008767] px-2 py-0.5 hover:bg-[#007058]"
      >
        <Check className="h-3 w-3" strokeWidth={3} />
        {done}
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onLeftClick?.();
        }}
        title={`${left} remaining — click to view SOPs`}
        className="inline-flex items-center gap-0.5 bg-[#D84339] px-2 py-0.5 hover:bg-[#C0392F]"
      >
        <X className="h-3 w-3" strokeWidth={3} />
        {left}
      </button>
    </span>
  );
}
