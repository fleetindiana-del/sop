'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, CalendarPlus, ChevronDown, ClipboardList,
  Loader2, Pencil, Plus, RefreshCw, Search, Target, Trash2, X,
} from 'lucide-react';
import { TrainerExamCalendar } from '@/components/lms/TrainerExamCalendar';
import { countEmployeeUniqueSops, countUniqueSops, countUniqueSopsByMonth, listEmployeeUniqueSops, listUniqueSops, listUniqueSopsForMonth } from '@/lib/lmsTrainerExamCounts';
import { localDateOnlyIso } from '@/lib/lmsTrainingCycle';
import { displaySopCode } from '@/lib/sop-display';
import { getExpiryTier } from '@/lib/sop-utils';

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
  scheduledDate2?: string;
  scheduledDate3?: string;
  /** ISO date of the current SOP document expiry, if known. */
  expiryDate?: string;
  /** Date the trainer assigned the exam (YYYY-MM-DD). */
  assignedAt?: string;
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
  /** Set when an incomplete exam from an earlier month appears in a later month view. */
  carriedFromMonth?: number;
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

/** Include incomplete exams from earlier months when a later month is selected. */
function rowsForSelectedMonths(
  rows: MonthlyExamRow[],
  selectedMonths: number[],
  viewYear: number | 'all',
): MonthlyExamRow[] {
  if (selectedMonths.length === 0) return rows;
  const selectedSet = new Set(selectedMonths);
  const out: MonthlyExamRow[] = [];
  for (const r of rows) {
    if (selectedSet.has(r.month)) {
      out.push(r);
      continue;
    }
    if (r.isIgnored || r.status === 'completed') continue;
    if (viewYear !== 'all' && r.year !== viewYear) continue;
    if (!selectedMonths.some((m) => m > r.month)) continue;
    out.push({ ...r, carriedFromMonth: r.month });
  }
  return out;
}

function unionRowsByKey(groups: MonthlyExamRow[][]): MonthlyExamRow[] {
  const map = new Map<string, MonthlyExamRow>();
  for (const group of groups) {
    for (const r of group) map.set(r.key, r);
  }
  return [...map.values()];
}

/**
 * Incomplete sittings from earlier months that roll into the selected month
 * (or the current calendar month when "All" is selected).
 */
function carriedForwardRows(
  rows: MonthlyExamRow[],
  selectedMonths: number[],
  viewYear: number | 'all',
  currentMonth: number,
): MonthlyExamRow[] {
  const months = selectedMonths.length > 0 ? selectedMonths : [currentMonth];
  const out: MonthlyExamRow[] = [];
  for (const r of rows) {
    if (r.isIgnored || r.status === 'completed') continue;
    if (viewYear !== 'all' && r.year !== viewYear) continue;
    if (!months.some((m) => m > r.month)) continue;
    out.push({ ...r, carriedFromMonth: r.month });
  }
  return out;
}

function expiryFallsInMonths(
  expiryDate: string | undefined,
  months: number[],
  expiryYear: number,
): boolean {
  if (!expiryDate) return false;
  const [yy, mm] = expiryDate.split('-').map(Number);
  if (!yy || !mm) return false;
  if (yy !== expiryYear) return false;
  return months.includes(mm);
}

/** Near-expiry: document expires in the selected month(s), or within 30 days. */
function isNearExpiryDate(
  expiryDate: string | undefined,
  months: number[],
  expiryYear: number,
): boolean {
  if (!expiryDate) return false;
  if (expiryFallsInMonths(expiryDate, months, expiryYear)) return true;
  return getExpiryTier(expiryDate) === 'high';
}

function nearExpiryRowsForView(
  source: MonthlyExamRow[],
  monthViewRows: MonthlyExamRow[],
  months: number[],
  expiryYear: number,
): MonthlyExamRow[] {
  const viewKeys = new Set(monthViewRows.map((r) => r.key));
  return source.filter((r) => {
    if (!r.expiryDate) return false;
    if (expiryFallsInMonths(r.expiryDate, months, expiryYear)) return true;
    return viewKeys.has(r.key) && getExpiryTier(r.expiryDate) === 'high';
  });
}

type LayerCounts = {
  completed: number;
  remaining: number;
  total: number;
  rows: MonthlyExamRow[];
};

type FourLayerSet = {
  due: LayerCounts;
  carried: LayerCounts;
  near: LayerCounts;
  total: LayerCounts;
};

type MonthScopeExtras = {
  dueRows: MonthlyExamRow[];
  carriedRows: MonthlyExamRow[];
  nearRows: MonthlyExamRow[];
  totalRows: MonthlyExamRow[];
  due: ReturnType<typeof countUniqueSops>;
  carried: ReturnType<typeof countUniqueSops>;
  near: ReturnType<typeof countUniqueSops>;
  total: ReturnType<typeof countUniqueSops>;
};

function layerFromEmployeeSops(rows: MonthlyExamRow[]): LayerCounts {
  const c = countEmployeeUniqueSops(rows);
  return { completed: c.completed, remaining: c.remaining, total: c.total, rows };
}

function layerFromSopEmployees(rows: MonthlyExamRow[]): LayerCounts {
  const c = uniqueEmployeesForSop(rows);
  return {
    completed: c.uniqueCompleted,
    remaining: c.uniqueRemaining + c.later,
    total: c.uniqueTotal,
    rows,
  };
}

function fourLayersFromExtras(
  extras: MonthScopeExtras,
  layerOf: (rows: MonthlyExamRow[]) => LayerCounts,
): FourLayerSet {
  return {
    due: layerOf(extras.dueRows),
    carried: layerOf(extras.carriedRows),
    near: layerOf(extras.nearRows),
    // Employee/SOP pills: Total = month ∪ carried. Near-expiry is a separate watch list.
    total: layerOf(unionRowsByKey([extras.dueRows, extras.carriedRows])),
  };
}

const ALL_CALENDAR_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

type CountScope = {
  months: number[];
  viewYear: number | 'all';
  expiryYear: number;
  carryIntoMonth: number;
};

function buildMonthScopeExtras(
  rows: MonthlyExamRow[],
  months: number[],
  viewYear: number | 'all',
  expiryYear: number,
  carryIntoMonth: number,
): MonthScopeExtras {
  const dueRows = months.length === ALL_CALENDAR_MONTHS.length
    ? rows
    : rows.filter((r) => months.includes(r.month));
  const carriedRows = carriedForwardRows(
    rows,
    months.length === ALL_CALENDAR_MONTHS.length ? [] : months,
    viewYear,
    carryIntoMonth,
  );
  const monthViewRows = unionRowsByKey([dueRows, carriedRows]);
  const nearRows = nearExpiryRowsForView(rows, monthViewRows, months, expiryYear);
  const totalRows = unionRowsByKey([dueRows, carriedRows, nearRows]);
  return {
    dueRows,
    carriedRows,
    nearRows,
    totalRows,
    due: countUniqueSops(dueRows),
    carried: countUniqueSops(carriedRows),
    near: countUniqueSops(nearRows),
    total: countUniqueSops(totalRows),
  };
}

/** Compact ~4-character department label; full name belongs in a tooltip. */
function shortDepartmentName(name: string): string {
  const trimmed = String(name || '').trim();
  if (!trimmed || trimmed === '—') return trimmed;
  if (trimmed.includes(',')) {
    return trimmed.split(',').map((part) => abbreviateDeptToken(part.trim())).join(', ');
  }
  return abbreviateDeptToken(trimmed);
}

function abbreviateDeptToken(name: string): string {
  if (!name) return name;
  if (name.length <= 4) return name.toUpperCase();
  const words = name
    .split(/[\s/&,._-]+/)
    .filter((w) => w && !/^(and|of|the|&)$/i.test(w));
  if (words.length >= 2) {
    let out = words.map((w) => w[0]!.toUpperCase()).join('');
    let i = 1;
    while (out.length < 4) {
      let added = false;
      for (const w of words) {
        if (out.length >= 4) break;
        if (i < w.length) {
          out += w[i]!.toUpperCase();
          added = true;
        }
      }
      if (!added) break;
      i++;
    }
    return out.slice(0, 4);
  }
  return name.slice(0, 4).toUpperCase();
}

function formatSopNoWithVersion(identifier: string, version?: string): string {
  const code = displaySopCode(identifier || '') || identifier;
  const ver = String(version || '').trim().replace(/^v/i, '');
  if (!ver) return code;
  if (/-\d+$/.test(code)) return code;
  if (code.toUpperCase().includes(`-${ver}`.toUpperCase())) return code;
  return `${code} · v${ver}`;
}

function sopNumberPart(identifier: string): string {
  const code = displaySopCode(identifier || '') || identifier;
  return String(code || '').replace(/-\d+$/, '') || code;
}

function sopVersionPart(identifier: string, version?: string): string {
  const ver = String(version || '').trim().replace(/^v/i, '');
  if (ver) return ver;
  const code = displaySopCode(identifier || '') || identifier;
  const match = String(code || '').match(/-(\d+)$/);
  return match?.[1] || '—';
}

function delayedFromLabel(month: number): string {
  return `delayed from ${MONTHS[month - 1] ?? month}`;
}

function carryForwardTag(sop: SopLineItem): { label: string; title: string } | null {
  if (sop.carriedCount <= 0) return null;
  const months = [...new Set(
    sop.employees
      .map((e) => e.carriedFromMonth)
      .filter((m): m is number => typeof m === 'number' && m >= 1 && m <= 12),
  )].sort((a, b) => a - b);
  const from = months.map((m) => MONTHS[m - 1]).join(', ');
  const who = sop.carriedCount === 1
    ? '1 employee'
    : `${sop.carriedCount} employees`;
  return {
    label: months.length === 1 ? `Carry forward · ${MONTHS[months[0]! - 1]}` : 'Carry forward',
    title: from
      ? `Carry-forward SOP — originally due ${from} · ${who} still incomplete`
      : `Carry-forward SOP — incomplete exam rolled in from an earlier month · ${who}`,
  };
}

type SopLineKind = 'completed' | 'remaining' | 'total' | 'scheduled' | 'unscheduled' | 'later' | 'present' | 'absent' | 'sitting2' | 'sitting3';

type SopLineOpenOpts = { employeeId?: string; layerRows?: MonthlyExamRow[]; heading?: string };

function sortExamRows(a: MonthlyExamRow, b: MonthlyExamRow): number {
  const byName = a.employeeName.localeCompare(b.employeeName);
  if (byName !== 0) return byName;
  const aMonth = a.year * 12 + a.month;
  const bMonth = b.year * 12 + b.month;
  if (aMonth !== bMonth) return aMonth - bMonth;
  return a.sopCode.localeCompare(b.sopCode);
}

const EXAM_STATUS_RANK: Record<ExamStatus, number> = {
  overdue: 0,
  pending: 1,
  completed: 2,
};

function pickRepresentativeExamRow(empRows: MonthlyExamRow[]): MonthlyExamRow {
  const live = empRows.filter((r) => !r.isIgnored);
  const pool = live.length > 0 ? live : empRows;
  return [...pool].sort((a, b) => {
    const byStatus = EXAM_STATUS_RANK[a.status] - EXAM_STATUS_RANK[b.status];
    if (byStatus !== 0) return byStatus;
    if (a.carriedFromMonth && !b.carriedFromMonth) return -1;
    if (!a.carriedFromMonth && b.carriedFromMonth) return 1;
    if (a.scheduledDate && !b.scheduledDate) return -1;
    if (!a.scheduledDate && b.scheduledDate) return 1;
    return sortExamRows(a, b);
  })[0];
}

function dedupeRowsByEmployee(rows: MonthlyExamRow[]): MonthlyExamRow[] {
  const byEmp = new Map<string, MonthlyExamRow[]>();
  for (const r of rows) {
    if (r.isIgnored) continue;
    const list = byEmp.get(r.employeeId);
    if (list) list.push(r);
    else byEmp.set(r.employeeId, [r]);
  }
  return [...byEmp.values()]
    .map(pickRepresentativeExamRow)
    .sort(sortExamRows);
}

type SopEmpPreview = {
  employeeId: string;
  employeeName: string;
  kind: 'completed' | 'pending' | 'later';
  scheduledDate?: string;
  carriedFromMonth?: number;
};

type SummaryScope = 'month' | 'carried' | 'nearExpiry' | 'total';

type SittingColumn = {
  dates: string[];
  assigned: number;
  needed: number;
  assignedIds: string[];
  neededIds: string[];
  present: number;
  absent: number;
  presentIds: string[];
  absentIds: string[];
  filled: boolean;
};

type SopLineItem = {
  sopCode: string;
  /** Registry identifier with current revision — dashboard SOP No. */
  sopIdentifier: string;
  sopVersion?: string;
  sopName: string;
  department: string;
  sopNameGujarati?: string;
  isDualLanguage: boolean;
  rows: MonthlyExamRow[];
  uniqueTotal: number;
  uniqueCompleted: number;
  uniqueRemaining: number;
  later: number;
  scheduled: number;
  unscheduled: number;
  scheduledDates: string[];
  sitting1: SittingColumn;
  sitting2: SittingColumn;
  sitting3: SittingColumn;
  employees: SopEmpPreview[];
  expiryDate?: string;
  layers: FourLayerSet;
  mcqNeedsEn: boolean;
  mcqNeedsGu: boolean;
  mcqEng: McqLangSlot;
  mcqGuj: McqLangSlot;
  pdfEng: AssetLangSlot;
  pdfGuj: AssetLangSlot;
  videoEng: AssetLangSlot;
  videoGuj: AssetLangSlot;
  attendance: SopAttendance;
  /** Employees whose exam rolled in from an earlier due month. */
  carriedCount: number;
};

type AttendanceRecordLite = {
  employeeId: string;
  employeeName: string;
  status: 'present' | 'absent';
};

type AttendanceSheetLite = {
  sopCode: string;
  trainingDate: string;
  presentCount: number;
  absentCount: number;
  records: AttendanceRecordLite[];
};

type SopAttendance = {
  filled: boolean;
  present: number;
  absent: number;
  presentIds: string[];
  absentIds: string[];
};

type McqLangSlot = {
  questionCount: number;
  lmsApproved: boolean;
};

type AssetLangSlot = {
  available: boolean;
};

const EMPTY_ASSET_LANG: AssetLangSlot = { available: false };

type McqCatalogEntry = {
  sopIdentifier?: string;
  sopVersion?: string;
  department?: string;
  sopNameGujarati?: string;
  isDualLanguage: boolean;
  needsEn: boolean;
  needsGu: boolean;
  eng: McqLangSlot;
  guj: McqLangSlot;
  pdfEng: AssetLangSlot;
  pdfGuj: AssetLangSlot;
  videoEng: AssetLangSlot;
  videoGuj: AssetLangSlot;
  questionCount: number;
  lmsApproved: boolean;
};

export function TrainerMonthlyExams({
  onUnauthorized,
  dept: deptProp,
  onDeptChange,
}: {
  onUnauthorized?: () => void;
  dept?: string;
  onDeptChange?: (dept: string) => void;
}) {
  const [data, setData] = useState<MonthlyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // Land on "what is due right now" rather than the whole year.
  const [year, setYear] = useState<number | 'all'>(new Date().getFullYear());
  /** Empty = all months. Otherwise one or more selected calendar months (1–12). */
  const [selectedMonths, setSelectedMonths] = useState<number[]>([new Date().getMonth() + 1]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [includeIgnored, setIncludeIgnored] = useState(false);
  const [deptInternal, setDeptInternal] = useState('All');
  const dept = deptProp ?? deptInternal;
  const setDept = onDeptChange ?? setDeptInternal;
  const [designation, setDesignation] = useState('All');
  const [examFilter, setExamFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [selectedSopCode, setSelectedSopCode] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [busyId, setBusyId] = useState('');
  const [mcqByCode, setMcqByCode] = useState<Record<string, McqCatalogEntry>>({});
  const [attendanceSheets, setAttendanceSheets] = useState<AttendanceSheetLite[]>([]);
  const [sopSort, setSopSort] = useState<{ key: SopSortKey; dir: 'asc' | 'desc' }>({
    key: 'sop',
    dir: 'asc',
  });
  const [summaryFocus, setSummaryFocus] = useState<SummaryScope>('total');
  const [sopPopup, setSopPopup] = useState<{
    title: string;
    subtitle: string;
    rows: MonthlyExamRow[];
    showEmployee: boolean;
    groupBy?: 'month' | 'sop' | 'employee';
  } | null>(null);
  const [sopDateEdit, setSopDateEdit] = useState<{
    sop: SopLineItem;
    sitting: 1 | 2 | 3;
    mode: 'add' | 'edit';
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (dept !== 'All') qs.set('department', dept);
      qs.set('year', year === 'all' ? 'all' : String(year));
      if (includeIgnored) qs.set('includeIgnored', '1');
      const attQs = new URLSearchParams();
      if (dept !== 'All') attQs.set('department', dept);
      if (year !== 'all') attQs.set('year', String(year));
      attQs.set('limit', '500');
      const [monthlyRes, catalogRes, attendanceRes] = await Promise.all([
        fetch(`/api/lms/trainer/monthly?${qs}`, { cache: 'no-store' }),
        fetch('/api/lms/trainer/exam-catalog', { cache: 'no-store' }),
        fetch(`/api/lms/trainer/attendance?${attQs}`, { cache: 'no-store' }),
      ]);
      const json = await monthlyRes.json();
      if (monthlyRes.status === 401) {
        onUnauthorized?.();
        return;
      }
      if (!monthlyRes.ok) throw new Error(json.error || 'Failed to load monthly exams');
      setData(json);
      if (catalogRes.ok) {
        const catalogJson = await catalogRes.json();
        const map: Record<string, McqCatalogEntry> = {};
        for (const exam of catalogJson.exams ?? []) {
          const key = String(exam.sopCode || '').trim().toUpperCase();
          if (!key) continue;
          map[key] = {
            sopIdentifier: exam.sopIdentifier || key,
            sopVersion: exam.sopVersion || undefined,
            department: exam.department || undefined,
            sopNameGujarati: exam.sopNameGujarati || undefined,
            isDualLanguage: exam.isDualLanguage === true,
            needsEn: exam.needsEn !== false,
            needsGu: exam.needsGu === true,
            eng: {
              questionCount: Number(exam.eng?.questionCount) || 0,
              lmsApproved: exam.eng?.lmsApproved === true,
            },
            guj: {
              questionCount: Number(exam.guj?.questionCount) || 0,
              lmsApproved: exam.guj?.lmsApproved === true,
            },
            pdfEng: { available: exam.pdfEng?.available === true },
            pdfGuj: { available: exam.pdfGuj?.available === true },
            videoEng: { available: exam.videoEng?.available === true },
            videoGuj: { available: exam.videoGuj?.available === true },
            questionCount: Number(exam.questionCount) || 0,
            lmsApproved: exam.lmsApproved === true,
          };
        }
        setMcqByCode(map);
      }
      if (attendanceRes.ok) {
        const attJson = await attendanceRes.json();
        const sheets: AttendanceSheetLite[] = [];
        for (const sheet of attJson.sheets ?? []) {
          const sopCode = String(sheet.sopCode || '').trim().toUpperCase();
          const trainingDate = String(sheet.trainingDate || '').slice(0, 10);
          if (!sopCode || !trainingDate) continue;
          sheets.push({
            sopCode,
            trainingDate,
            presentCount: Number(sheet.presentCount) || 0,
            absentCount: Number(sheet.absentCount) || 0,
            records: (sheet.records ?? []).map((r: { employeeId?: string; employeeName?: string; status?: string }) => ({
              employeeId: String(r.employeeId || ''),
              employeeName: String(r.employeeName || ''),
              status: r.status === 'absent' ? 'absent' : 'present',
            })),
          });
        }
        setAttendanceSheets(sheets);
      } else {
        setAttendanceSheets([]);
      }
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

  const toggleMonth = (month: number) => {
    setSelectedMonths((prev) => {
      if (prev.length === 0) return [month];
      if (prev.includes(month)) return prev.filter((m) => m !== month);
      return [...prev, month].sort((a, b) => a - b);
    });
  };

  const searchFilteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => {
      if (designation !== 'All' && r.designation !== designation) return false;
      if (examFilter !== 'All' && r.sopCode !== examFilter) return false;
      if (q && !`${r.employeeName} ${r.designation} ${r.sopCode} ${r.sopName} ${r.sopNameGujarati ?? ''}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [data, designation, examFilter, search]);

  const monthFilteredRows = useMemo(() => {
    const viewYear = year === 'all' ? 'all' as const : year;
    return rowsForSelectedMonths(searchFilteredRows, selectedMonths, viewYear);
  }, [searchFilteredRows, selectedMonths, year]);

  /** Department rows for the selected months — before an employee is picked. */
  const monthDueRows = useMemo(() => {
    if (selectedMonths.length === 0) return searchFilteredRows;
    return searchFilteredRows.filter((r) => selectedMonths.includes(r.month));
  }, [searchFilteredRows, selectedMonths]);

  const countScope = useMemo<CountScope>(() => {
    const viewYear = year === 'all' ? 'all' as const : year;
    const expiryYear = year === 'all'
      ? (data?.currentYear ?? new Date().getFullYear())
      : year;
    const currentMonth = data?.currentMonth ?? new Date().getMonth() + 1;
    const months = selectedMonths.length > 0 ? selectedMonths : ALL_CALENDAR_MONTHS;
    const carryIntoMonth = selectedMonths.length === 1 ? selectedMonths[0] : currentMonth;
    return { months, viewYear, expiryYear, carryIntoMonth };
  }, [selectedMonths, year, data]);

  const selectedScopeExtras = useMemo(
    () => buildMonthScopeExtras(
      searchFilteredRows,
      countScope.months,
      countScope.viewYear,
      countScope.expiryYear,
      countScope.carryIntoMonth,
    ),
    [searchFilteredRows, countScope],
  );

  const carriedRows = selectedScopeExtras.carriedRows;
  const nearExpiryRows = selectedScopeExtras.nearRows;
  const totalScopeRows = selectedScopeExtras.totalRows;
  const nearExpiryViewMonths = selectedMonths.length > 0 ? selectedMonths : ALL_CALENDAR_MONTHS;
  const nearExpiryYear = year === 'all'
    ? (data?.currentYear ?? new Date().getFullYear())
    : year;
  const dashboardSopTotal = selectedScopeExtras.total;
  const carriedSopTotal = selectedScopeExtras.carried;
  const nearExpirySopTotal = selectedScopeExtras.near;

  const extrasByMonth = useMemo(() => {
    const viewYear = year === 'all' ? 'all' as const : year;
    const expiryYear = year === 'all'
      ? (data?.currentYear ?? new Date().getFullYear())
      : year;
    const rows = searchFilteredRows;
    return ALL_CALENDAR_MONTHS.map((month) =>
      buildMonthScopeExtras(rows, [month], viewYear, expiryYear, month),
    );
  }, [searchFilteredRows, year, data]);

  const extrasAll = useMemo(() => {
    const viewYear = year === 'all' ? 'all' as const : year;
    const expiryYear = year === 'all'
      ? (data?.currentYear ?? new Date().getFullYear())
      : year;
    const currentMonth = data?.currentMonth ?? new Date().getMonth() + 1;
    return buildMonthScopeExtras(
      searchFilteredRows,
      ALL_CALENDAR_MONTHS,
      viewYear,
      expiryYear,
      currentMonth,
    );
  }, [searchFilteredRows, year, data]);

  const monthSopCounts = useMemo(
    () => countUniqueSopsByMonth(data?.rows ?? []),
    [data],
  );

  const yearSopTotal = useMemo(
    () => countUniqueSops(data?.rows ?? []),
    [data],
  );

  const scopedExamRows = useMemo(() => {
    if (summaryFocus === 'carried') return carriedRows;
    if (summaryFocus === 'nearExpiry') return nearExpiryRows;
    if (summaryFocus === 'month') return monthDueRows;
    return monthFilteredRows;
  }, [summaryFocus, carriedRows, nearExpiryRows, monthDueRows, monthFilteredRows]);

  const byEmployeeAll = useMemo(() => {
    const inScope = new Set(scopedExamRows.map((r) => r.employeeId));
    const map = new Map<string, {
      employeeId: string;
      employeeName: string;
      designation: string;
      department: string;
      hasLmsAccess: boolean;
      rows: MonthlyExamRow[];
      uniqueTotal: number;
      uniqueCompleted: number;
      uniqueRemaining: number;
      completed: number;
      pending: number;
      overdue: number;
      ignored: number;
    }>();
    for (const r of searchFilteredRows) {
      if (!inScope.has(r.employeeId)) continue;
      let entry = map.get(r.employeeId);
      if (!entry) {
        entry = {
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          designation: r.designation,
          department: r.department,
          hasLmsAccess: r.hasLmsAccess,
          rows: [],
          uniqueTotal: 0,
          uniqueCompleted: 0,
          uniqueRemaining: 0,
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
    return [...map.values()]
      .map((entry) => {
        const extras = buildMonthScopeExtras(
          entry.rows,
          countScope.months,
          countScope.viewYear,
          countScope.expiryYear,
          countScope.carryIntoMonth,
        );
        const layers = fourLayersFromExtras(extras, layerFromEmployeeSops);
        const unique = layers.total;
        return {
          ...entry,
          uniqueTotal: unique.total,
          uniqueCompleted: unique.completed,
          uniqueRemaining: unique.remaining,
          layers,
        };
      })
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  }, [searchFilteredRows, scopedExamRows, countScope]);

  const byEmployee = useMemo(() => {
    if (!selectedSopCode) return byEmployeeAll;
    const code = selectedSopCode.trim().toUpperCase();
    return byEmployeeAll.flatMap((emp) => {
      const sopRows = emp.rows.filter((r) => r.sopCode.trim().toUpperCase() === code);
      if (sopRows.length === 0) return [];
      const extras = buildMonthScopeExtras(
        sopRows,
        countScope.months,
        countScope.viewYear,
        countScope.expiryYear,
        countScope.carryIntoMonth,
      );
      const layers = fourLayersFromExtras(extras, layerFromEmployeeSops);
      return [{
        ...emp,
        rows: sopRows,
        uniqueTotal: layers.total.total,
        uniqueCompleted: layers.total.completed,
        uniqueRemaining: layers.total.remaining,
        layers,
      }];
    });
  }, [byEmployeeAll, selectedSopCode, countScope]);

  const bySopAll = useMemo(
    () => groupSopLines(scopedExamRows, mcqByCode, attendanceSheets, countScope),
    [scopedExamRows, mcqByCode, attendanceSheets, countScope],
  );

  const bySop = useMemo(() => {
    if (!selectedEmployeeId) return bySopAll;
    return bySopAll.flatMap((sop) => {
      const empRows = sop.rows.filter((r) => r.employeeId === selectedEmployeeId);
      if (empRows.length === 0) return [];
      return [toSopLine(sop.sopCode, empRows, mcqByCode, attendanceSheets, countScope)];
    });
  }, [bySopAll, selectedEmployeeId, mcqByCode, attendanceSheets, countScope]);

  const approachingSops = useMemo(() => {
    if (summaryFocus === 'carried' || summaryFocus === 'month') return [];
    const dueCodes = new Set(bySopAll.map((s) => s.sopCode));
    const source = selectedEmployeeId
      ? nearExpiryRows.filter((r) => r.employeeId === selectedEmployeeId)
      : nearExpiryRows;
    const extra = source.filter((r) => {
      const code = r.sopCode.trim().toUpperCase();
      return Boolean(code) && !dueCodes.has(code);
    });
    return groupSopLines(extra, mcqByCode, attendanceSheets, countScope);
  }, [summaryFocus, bySopAll, nearExpiryRows, selectedEmployeeId, mcqByCode, attendanceSheets, countScope]);

  const toggleSopSort = (key: SopSortKey) => {
    setSopSort((prev) => (
      prev.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: key === 'sop' || key === 'version' || key === 'name' || key === 'dept' || key === 'date' || key === 'date2' || key === 'date3' ? 'asc' : 'desc' }
    ));
  };

  const sortedBySop = useMemo(
    () => sortSopLines(bySop, sopSort.key, sopSort.dir),
    [bySop, sopSort],
  );

  const sortedApproachingSops = useMemo(
    () => sortSopLines(approachingSops, sopSort.key, sopSort.dir),
    [approachingSops, sopSort],
  );

  const selectedEmployee = byEmployeeAll.find((e) => e.employeeId === selectedEmployeeId) ?? null;
  const selectedSop =
    bySopAll.find((s) => s.sopCode === selectedSopCode)
    ?? approachingSops.find((s) => s.sopCode === selectedSopCode)
    ?? null;

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

  const openMonthSopPopup = (
    scopeLabel: string,
    scopeRows: MonthlyExamRow[],
    kind: 'completed' | 'remaining' | 'total',
    month?: number,
  ) => {
    const list =
      month != null
        ? listUniqueSopsForMonth(scopeRows, month, kind === 'total' ? undefined : kind)
        : listUniqueSops(scopeRows, kind === 'total' ? undefined : kind);
    const live = list.filter((i) => i.kind !== 'ignored');
    const codes = new Set(live.map((i) => i.sopCode));
    // Full assignment rows for every unique SOP in this capsule count.
    const detailRows = scopeRows
      .filter((r) => !r.isIgnored && codes.has(r.sopCode.trim().toUpperCase()))
      .sort((a, b) => {
        const byCode = a.sopCode.localeCompare(b.sopCode);
        if (byCode !== 0) return byCode;
        return a.employeeName.localeCompare(b.employeeName);
      });
    setSopPopup({
      title: kind === 'completed'
        ? `Completed SOP exams · ${scopeLabel}`
        : kind === 'remaining'
          ? `Remaining SOP exams · ${scopeLabel}`
          : `Unique SOP exams · ${scopeLabel}`,
      subtitle: `${live.length} unique SOP${live.length === 1 ? '' : 's'} · ${detailRows.length} assignment row${detailRows.length === 1 ? '' : 's'}`,
      rows: detailRows,
      showEmployee: true,
      groupBy: 'sop',
    });
  };

  const openEmployeeSopPopup = (
    emp: { employeeName: string; rows: MonthlyExamRow[] },
    kind: 'completed' | 'remaining' | 'total',
  ) => {
    const list = listEmployeeUniqueSops(emp.rows, kind === 'total' ? undefined : kind);
    const live = list.filter((i) => i.kind !== 'ignored');
    const codes = new Set(live.map((i) => i.sopCode));
    const detailRows = emp.rows
      .filter((r) => !r.isIgnored && codes.has(r.sopCode.trim().toUpperCase()))
      .sort((a, b) => a.sopCode.localeCompare(b.sopCode));
    setSopPopup({
      title: kind === 'completed'
        ? `Completed · ${emp.employeeName}`
        : kind === 'remaining'
          ? `Remaining · ${emp.employeeName}`
          : `Required SOP exams · ${emp.employeeName}`,
      subtitle: `${live.length} unique SOP${live.length === 1 ? '' : 's'} · ${detailRows.length} row${detailRows.length === 1 ? '' : 's'} · ${selectedMonthLabel}`,
      rows: detailRows,
      showEmployee: false,
      groupBy: 'sop',
    });
  };

  const openSopEmployeePopup = (
    sop: Pick<SopLineItem, 'sopCode' | 'sopIdentifier' | 'sopVersion' | 'sopName' | 'rows' | 'attendance'>,
    kind: SopLineKind,
    opts?: SopLineOpenOpts,
  ) => {
    const sourceRows = opts?.layerRows ?? sop.rows;
    const counts = uniqueEmployeesForSop(sourceRows);
    const notCompletedRows = [...counts.remainingRows, ...counts.laterRows];
    const presentRows = sourceRows.filter((r) => sop.attendance.presentIds.includes(r.employeeId));
    const absentRows = sourceRows.filter((r) => sop.attendance.absentIds.includes(r.employeeId));
    let detailRows = (
      kind === 'completed' ? counts.completedRows
        : kind === 'remaining' ? notCompletedRows
          : kind === 'later' ? counts.laterRows
            : kind === 'present' ? presentRows
              : kind === 'absent' ? absentRows
                : kind === 'sitting2' ? sourceRows.filter((r) => Boolean(r.scheduledDate2))
                  : kind === 'sitting3' ? sourceRows.filter((r) => Boolean(r.scheduledDate3))
                    : kind === 'scheduled' ? counts.scheduledRows
                      : kind === 'unscheduled' ? counts.unscheduledRows
                        : counts.liveRows
    );

    if (opts?.employeeId) {
      detailRows = sourceRows
        .filter((r) => r.employeeId === opts.employeeId && !r.isIgnored)
        .sort(sortExamRows);
    } else {
      detailRows = dedupeRowsByEmployee(detailRows).sort(sortExamRows);
    }

    const uniqueCount = opts?.employeeId
      ? 1
      : new Set(detailRows.map((r) => r.employeeId)).size;
    const label = `${formatSopNoWithVersion(sop.sopIdentifier || sop.sopCode, sop.sopVersion)} — ${sop.sopName}`;
    const employeeName = opts?.employeeId
      ? detailRows[0]?.employeeName
        || sop.rows.find((r) => r.employeeId === opts.employeeId)?.employeeName
      : undefined;
    const title =
      opts?.heading
        ? `${opts.heading} · ${label}`
        : employeeName
        ? `${employeeName} · ${label}`
        : kind === 'completed' ? `Completed · ${label}`
          : kind === 'remaining' ? `Not completed · ${label}`
            : kind === 'later' ? `Later · ${label}`
              : kind === 'present' ? `Present on exam date · ${label}`
                : kind === 'absent' ? `Absent on exam date · ${label}`
                  : kind === 'sitting2' ? `Schedule 2 · ${label}`
                    : kind === 'sitting3' ? `Schedule 3 · ${label}`
                      : kind === 'scheduled' ? `Scheduled · ${label}`
                        : kind === 'unscheduled' ? `Unscheduled · ${label}`
                          : `Assigned employees · ${label}`;
    setSopPopup({
      title,
      subtitle: `${uniqueCount} unique employee${uniqueCount === 1 ? '' : 's'} · ${detailRows.length} row${detailRows.length === 1 ? '' : 's'} · ${selectedMonthLabel}`,
      rows: detailRows,
      showEmployee: true,
      groupBy: 'employee',
    });
  };

  const isAllMonths = selectedMonths.length === 0;
  const selectedMonthLabel = isAllMonths
    ? 'all months'
    : selectedMonths.map((m) => MONTHS_FULL[m - 1]).join(', ');

  const headerScopeRows =
    summaryFocus === 'carried' ? carriedRows
      : summaryFocus === 'nearExpiry' ? nearExpiryRows
        : totalScopeRows;
  const headerScopeCounts =
    summaryFocus === 'carried' ? carriedSopTotal
      : summaryFocus === 'nearExpiry' ? nearExpirySopTotal
        : dashboardSopTotal;
  const headerScopeLabel =
    summaryFocus === 'carried' ? `carried-forward · ${selectedMonthLabel}`
      : summaryFocus === 'nearExpiry' ? `near-expiry · ${selectedMonthLabel}`
        : selectedMonthLabel;

  const activateMonthScope = (month: number | 'all', scope: SummaryScope) => {
    if (month === 'all') setSelectedMonths([]);
    else setSelectedMonths([month]);
    setSummaryFocus(scope);
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      {/* Month-wise unique SOP exams — select one or more months */}
      <div className="overflow-hidden border border-gray-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-300 bg-gray-100 px-3 py-1.5">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-700">
            Month-wise SOP exams
            {year !== 'all' && <span className="ml-1 font-normal text-gray-500">· {year}</span>}
          </h2>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <TotalPill
              icon={ClipboardList}
              onClick={() => openMonthSopPopup(headerScopeLabel, headerScopeRows, 'total')}
            >
              {headerScopeCounts.total} unique SOP exam{headerScopeCounts.total === 1 ? '' : 's'}
              <span className="font-normal text-gray-500"> · {headerScopeLabel}</span>
            </TotalPill>
            {selectedEmployee && (
              <TotalPill
                icon={Target}
                onClick={() => openEmployeeSopPopup(selectedEmployee, 'total')}
              >
                {selectedEmployee.uniqueTotal} for {selectedEmployee.employeeName}
              </TotalPill>
            )}
            {selectedSop && (
              <TotalPill
                icon={ClipboardList}
                onClick={() => openSopEmployeePopup(selectedSop, 'total')}
              >
                {selectedSop.uniqueTotal} on {formatSopNoWithVersion(selectedSop.sopIdentifier || selectedSop.sopCode, selectedSop.sopVersion)}
              </TotalPill>
            )}
            <label className="inline-flex items-center gap-1 text-[10px] font-medium text-gray-600">
              <input
                type="checkbox"
                checked={includeIgnored}
                onChange={(e) => setIncludeIgnored(e.target.checked)}
                className="h-3 w-3 rounded border-gray-300"
              />
              Show pre-cycle (ignored)
            </label>
            <button
              type="button"
              onClick={() => setScheduleOpen(true)}
              className="inline-flex items-center gap-1 rounded bg-purple-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-purple-700"
            >
              <CalendarPlus className="h-3 w-3" /> Calendar
            </button>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="rounded border border-gray-300 bg-white p-1 text-gray-400 hover:bg-gray-50"
            >
              <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
        <div className="bg-gray-50 px-1 py-2 sm:px-2">
          <div
            className="flex gap-2 overflow-x-auto pb-1"
            style={{ scrollbarWidth: 'thin', scrollbarColor: '#d1d5db transparent' }}
          >
            <div className={monthColumnClass(isAllMonths)}>
              <button
                type="button"
                onClick={() => setSelectedMonths([])}
                className="mb-0.5 w-full text-left text-[11px] font-bold leading-tight text-gray-800"
              >
                All
              </button>
              <ScopeCapsule
                compact
                hideLabel
                label="Month"
                title="SOP exams due across all months"
                active={false}
                done={yearSopTotal.completed}
                left={yearSopTotal.remaining}
                onSelect={() => openMonthSopPopup('all months', data?.rows ?? [], 'total')}
                onDoneClick={() => openMonthSopPopup('all months', data?.rows ?? [], 'completed')}
                onLeftClick={() => openMonthSopPopup('all months', data?.rows ?? [], 'remaining')}
              />
              <MonthExtraCapsules
                extras={extrasAll}
                monthSelected={isAllMonths}
                activeScope={summaryFocus}
                onActivate={(scope) => activateMonthScope('all', scope)}
                onOpen={(scope, kind) => {
                  activateMonthScope('all', scope);
                  const rows = scope === 'carried' ? extrasAll.carriedRows
                    : scope === 'nearExpiry' ? extrasAll.nearRows
                      : extrasAll.totalRows;
                  const label = scope === 'carried' ? 'carried-forward · all months'
                    : scope === 'nearExpiry' ? 'near-expiry · all months'
                      : 'total · all months';
                  openMonthSopPopup(label, rows, kind);
                }}
              />
            </div>
            {MONTHS.map((m, i) => {
              const c = monthSopCounts[i] ?? {
                total: 0, completed: 0, remaining: 0, pending: 0, overdue: 0, ignored: 0,
              };
              const active = !isAllMonths && selectedMonths.includes(i + 1);
              const isCurrent =
                data?.currentMonth === i + 1 &&
                (year === 'all' || year === data?.currentYear);
              const monthRows = (data?.rows ?? []).filter((r) => r.month === i + 1);
              const extras = extrasByMonth[i];
              if (!extras) return null;
              const monthName = MONTHS_FULL[i];
              return (
                <div key={m} className={monthColumnClass(active, isCurrent)}>
                  <button
                    type="button"
                    onClick={() => toggleMonth(i + 1)}
                    className="mb-0.5 w-full text-left text-[11px] font-bold leading-tight text-gray-800"
                  >
                    {m}
                    {isCurrent && <span className="ml-0.5 text-purple-500">•</span>}
                  </button>
                  <ScopeCapsule
                    compact
                    hideLabel
                    label="Month"
                    title={`SOP exams due in ${monthName}`}
                    active={false}
                    done={c.completed}
                    left={c.remaining}
                    onSelect={() => openMonthSopPopup(monthName, monthRows, 'total', i + 1)}
                    onDoneClick={() => openMonthSopPopup(monthName, monthRows, 'completed', i + 1)}
                    onLeftClick={() => openMonthSopPopup(monthName, monthRows, 'remaining', i + 1)}
                  />
                  <MonthExtraCapsules
                    extras={extras}
                    monthSelected={active}
                    activeScope={summaryFocus}
                    onActivate={(scope) => activateMonthScope(i + 1, scope)}
                    onOpen={(scope, kind) => {
                      activateMonthScope(i + 1, scope);
                      const rows = scope === 'carried' ? extras.carriedRows
                        : scope === 'nearExpiry' ? extras.nearRows
                          : extras.totalRows;
                      const label = scope === 'carried' ? `carried-forward · ${monthName}`
                        : scope === 'nearExpiry' ? `near-expiry · ${monthName}`
                          : `total · ${monthName}`;
                      openMonthSopPopup(label, rows, kind);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Employee-wise required exams for the selected months */}
      <div className="overflow-hidden border border-gray-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-300 bg-gray-100 px-3 py-1.5">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-700">
            Employee-wise required SOP exams
            {summaryFocus === 'carried' && (
              <span className="ml-1 font-normal normal-case tracking-normal text-amber-800">· carried-forward</span>
            )}
            {summaryFocus === 'nearExpiry' && (
              <span className="ml-1 font-normal normal-case tracking-normal text-amber-800">· near-expiry</span>
            )}
          </h2>
          {selectedEmployee && (
            <div className="flex items-center gap-2 rounded border border-gray-200 bg-white px-2 py-0.5 text-[10px] text-gray-700">
              <span>
                <span className="font-bold">{selectedEmployee.employeeName}</span>
                {': '}
                <span className="text-emerald-700">{selectedEmployee.uniqueCompleted}</span>
                {' + '}
                <span className="text-red-600">{selectedEmployee.uniqueRemaining}</span>
                {' = '}
                <span className="font-bold">{selectedEmployee.uniqueTotal} unique</span>
                {' across '}
                {selectedMonthLabel}
              </span>
              <button
                type="button"
                onClick={() => setSelectedEmployeeId(null)}
                className="rounded p-0.5 text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                title="Clear employee"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
        {byEmployee.length === 0 ? (
          <p className="py-8 text-center text-xs text-gray-500">
            {selectedSopCode
              ? 'No employees are assigned this SOP exam in the selected months.'
              : 'No employees have SOP exams in the selected months.'}
          </p>
        ) : (
          <div className="flex max-h-96 flex-wrap content-start gap-2 overflow-y-auto bg-gray-50 px-1 py-2 sm:px-2">
            {byEmployee.map((emp) => {
              const active = selectedEmployeeId === emp.employeeId;
              return (
                <div
                  key={emp.employeeId}
                  className={`flex w-[7.25rem] flex-col rounded-[10px] border px-1.5 py-1 text-left shadow-sm ${
                    active ? 'border-purple-300 bg-purple-50 ring-1 ring-purple-300' : 'border-gray-200 bg-white'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedEmployeeId((prev) => (prev === emp.employeeId ? null : emp.employeeId));
                    }}
                    className="mb-0.5 w-full truncate text-left text-[11px] font-bold leading-tight text-gray-800"
                  >
                    {emp.employeeName}
                  </button>
                  <FourLayerPills
                    layers={emp.layers}
                    onOpen={(scope, kind) => {
                      openEmployeeSopPopup(
                        { employeeName: emp.employeeName, rows: emp.layers[scope].rows },
                        kind,
                      );
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* SOP-wise required exams for the selected months */}
      <div className="overflow-hidden border border-gray-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-300 bg-gray-100 px-3 py-2">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-700">
            SOP-wise required exams
            {summaryFocus === 'carried' && (
              <span className="ml-1 font-normal normal-case tracking-normal text-amber-800">· carried-forward</span>
            )}
            {summaryFocus === 'nearExpiry' && (
              <span className="ml-1 font-normal normal-case tracking-normal text-amber-800">· near-expiry</span>
            )}
          </h2>
          {selectedSop && (
            <div className="flex items-center gap-2 rounded border border-gray-200 bg-white px-2 py-0.5 text-[11px] text-gray-700">
              <span>
                <span className="font-mono font-bold text-purple-700">
                  {formatSopNoWithVersion(selectedSop.sopIdentifier || selectedSop.sopCode, selectedSop.sopVersion)}
                </span>
                {': '}
                {selectedSop.uniqueTotal} tot
                {' · '}
                <span className="text-emerald-700">{selectedSop.uniqueCompleted} done</span>
                {' · '}
                <span className="text-red-600">{selectedSop.uniqueRemaining} delayed</span>
                {selectedSop.carriedCount > 0 && (
                  <>
                    {' · '}
                    <span className="text-amber-700">
                      {selectedSop.carriedCount} from prior month{selectedSop.carriedCount === 1 ? '' : 's'}
                    </span>
                  </>
                )}
                {' · '}
                <span className={selectedSop.attendance.filled ? 'text-emerald-700' : 'text-gray-500'}>
                  {selectedSop.attendance.filled
                    ? `${selectedSop.attendance.present} present · ${selectedSop.attendance.absent} absent`
                    : 'no attendance'}
                </span>
                {' · '}
                {selectedSop.scheduled} scheduled
                {' · '}
                {selectedSop.unscheduled} unscheduled
              </span>
              <button
                type="button"
                onClick={() => setSelectedSopCode(null)}
                className="rounded p-0.5 text-gray-400 hover:bg-gray-50 hover:text-gray-700"
                title="Clear SOP"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
          <span className="ml-auto rounded bg-purple-50 px-2 py-0.5 text-[10px] font-semibold text-purple-800">
            {sortedBySop.length} results
          </span>
        </div>
        {bySop.length === 0 ? (
          <p className="py-12 text-center text-xs text-gray-500">
            {selectedEmployeeId
              ? 'This employee has no SOP exams in the selected months.'
              : 'No SOP exams in the selected months.'}
          </p>
        ) : (
          <div className="max-h-[28rem] min-w-0 overflow-auto">
            <table className="w-full min-w-[96rem] border-collapse text-left">
              <SopTableHeader sort={sopSort} onSort={toggleSopSort} />
              <tbody className="text-[10px] text-gray-700">
                {sortedBySop.map((sop, i) => (
                  <SopLineRow
                    key={sop.sopCode}
                    index={i + 1}
                    isEven={i % 2 === 0}
                    sop={sop}
                    active={selectedSopCode === sop.sopCode}
                    showExpiry={Boolean(sop.expiryDate) && isNearExpiryDate(sop.expiryDate, nearExpiryViewMonths, nearExpiryYear)}
                    onSelect={() => setSelectedSopCode((prev) => (prev === sop.sopCode ? null : sop.sopCode))}
                    onOpen={(kind, opts) => openSopEmployeePopup(sop, kind, opts)}
                    onAssignDate={(sitting, mode) => setSopDateEdit({ sop, sitting, mode })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sortedApproachingSops.length > 0 && (
        <div className="overflow-hidden border border-amber-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2">
            <h2 className="text-xs font-bold uppercase tracking-widest text-amber-900">
              Approaching expiry
            </h2>
            <span className="text-[10px] font-normal text-amber-800/80">
              document expires in {selectedMonthLabel}
            </span>
            <span className="ml-auto rounded bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-900">
              {sortedApproachingSops.length} result{sortedApproachingSops.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="max-h-[28rem] min-w-0 overflow-auto">
            <table className="w-full min-w-[96rem] border-collapse text-left">
              <SopTableHeader sort={sopSort} onSort={toggleSopSort} />
              <tbody className="text-[10px] text-gray-700">
                {sortedApproachingSops.map((sop, i) => (
                  <SopLineRow
                    key={`exp-${sop.sopCode}`}
                    index={i + 1}
                    isEven={i % 2 === 0}
                    sop={sop}
                    active={selectedSopCode === sop.sopCode}
                    showExpiry
                    onSelect={() => setSelectedSopCode((prev) => (prev === sop.sopCode ? null : sop.sopCode))}
                    onOpen={(kind, opts) => openSopEmployeePopup(sop, kind, opts)}
                    onAssignDate={(sitting, mode) => setSopDateEdit({ sop, sitting, mode })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Filters removed — tables below use their own inline filters */}

      {loading && !data && (
        <div className="flex justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
        </div>
      )}

      {scheduleOpen && (
        <TrainerExamCalendar
          onClose={() => setScheduleOpen(false)}
          onChanged={() => {
            void load();
          }}
        />
      )}

      {sopPopup && (
        <SopListPopup
          title={sopPopup.title}
          subtitle={sopPopup.subtitle}
          rows={sopPopup.rows}
          showEmployee={sopPopup.showEmployee}
          groupBy={sopPopup.groupBy}
          catalog={mcqByCode}
          onCancel={cancelSchedule}
          busyId={busyId}
          onClose={() => setSopPopup(null)}
        />
      )}

      {sopDateEdit && (
        <SopDateAssignDialog
          sop={sopDateEdit.sop}
          sitting={sopDateEdit.sitting}
          mode={sopDateEdit.mode}
          viewYear={year === 'all' ? (data?.currentYear ?? new Date().getFullYear()) : year}
          selectedMonths={selectedMonths}
          onClose={() => setSopDateEdit(null)}
          onSaved={() => {
            setSopDateEdit(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function monthEndIso(year: number, month: number): string {
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

/** Scheduled after today and after the sitting's own training month. */
function isLaterSitting(row: MonthlyExamRow, todayIso: string): boolean {
  const when = String(row.scheduledDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(when)) return false;
  if (when <= todayIso) return false;
  return when > monthEndIso(row.year, row.month);
}

function uniqueEmployeesForSop(rows: MonthlyExamRow[]) {
  const byEmp = new Map<string, MonthlyExamRow[]>();
  for (const r of rows) {
    const list = byEmp.get(r.employeeId);
    if (list) list.push(r);
    else byEmp.set(r.employeeId, [r]);
  }
  const todayIso = localDateOnlyIso();
  let uniqueCompleted = 0;
  let uniqueRemaining = 0;
  let later = 0;
  let scheduled = 0;
  let unscheduled = 0;
  const completedRows: MonthlyExamRow[] = [];
  const remainingRows: MonthlyExamRow[] = [];
  const laterRows: MonthlyExamRow[] = [];
  const scheduledRows: MonthlyExamRow[] = [];
  const unscheduledRows: MonthlyExamRow[] = [];
  const liveRows: MonthlyExamRow[] = [];
  const employees: SopEmpPreview[] = [];
  const scheduledDateSet = new Set<string>();
  let expiryDate: string | undefined;
  for (const empRows of byEmp.values()) {
    const live = empRows.filter((r) => !r.isIgnored);
    if (live.length === 0) continue;
    liveRows.push(...live);
    const dated = live.filter((r) => hasTrainerSitting1(r));
    if (dated.length > 0) {
      scheduled++;
      scheduledRows.push(...dated);
      for (const r of dated) {
        if (r.scheduledDate) scheduledDateSet.add(r.scheduledDate);
      }
    } else {
      unscheduled++;
      unscheduledRows.push(...live);
    }
    const name = live[0]?.employeeName || empRows[0]?.employeeName || '';
    const employeeId = live[0]?.employeeId || empRows[0]?.employeeId || '';
    const soonestDate = dated
      .map((r) => r.scheduledDate!)
      .sort()[0];
    const completedLive = live.filter((r) => r.status === 'completed');
    const incompleteLive = live.filter((r) => r.status !== 'completed');
    if (incompleteLive.length === 0 && completedLive.length > 0) {
      uniqueCompleted++;
      completedRows.push(...live);
      employees.push({ employeeId, employeeName: name, kind: 'completed', scheduledDate: soonestDate });
    } else if (
      incompleteLive.length > 0
      && incompleteLive.every((r) => isLaterSitting(r, todayIso))
      && incompleteLive.every((r) => !r.carriedFromMonth)
    ) {
      later++;
      laterRows.push(...incompleteLive);
      employees.push({ employeeId, employeeName: name, kind: 'later', scheduledDate: soonestDate });
    } else {
      uniqueRemaining++;
      remainingRows.push(...incompleteLive);
      const carriedFromMonth = incompleteLive.find((r) => r.carriedFromMonth)?.carriedFromMonth;
      employees.push({
        employeeId,
        employeeName: name,
        kind: 'pending',
        scheduledDate: soonestDate,
        carriedFromMonth,
      });
    }
    for (const r of empRows) {
      if (r.expiryDate && (!expiryDate || r.expiryDate < expiryDate)) expiryDate = r.expiryDate;
    }
  }
  employees.sort((a, b) => {
    const rank = (k: SopEmpPreview['kind']) => (k === 'completed' ? 1 : 0);
    const byStatus = rank(a.kind) - rank(b.kind);
    if (byStatus !== 0) return byStatus;
    return a.employeeName.localeCompare(b.employeeName);
  });
  return {
    uniqueCompleted,
    uniqueRemaining,
    later,
    uniqueTotal: uniqueCompleted + uniqueRemaining + later,
    scheduled,
    unscheduled,
    completedRows,
    remainingRows,
    laterRows,
    scheduledRows,
    unscheduledRows,
    liveRows,
    scheduledDates: [...scheduledDateSet].sort(),
    employees,
    expiryDate,
  };
}

const EMPTY_MCQ_LANG: McqLangSlot = { questionCount: 0, lmsApproved: false };

function lookupMcqMeta(
  sopCode: string,
  catalog: Record<string, McqCatalogEntry>,
): McqCatalogEntry {
  const key = sopCode.trim().toUpperCase();
  return catalog[key] ?? {
    sopIdentifier: key,
    sopVersion: undefined,
    department: undefined,
    isDualLanguage: false,
    needsEn: true,
    needsGu: false,
    eng: EMPTY_MCQ_LANG,
    guj: EMPTY_MCQ_LANG,
    pdfEng: EMPTY_ASSET_LANG,
    pdfGuj: EMPTY_ASSET_LANG,
    videoEng: EMPTY_ASSET_LANG,
    videoGuj: EMPTY_ASSET_LANG,
    questionCount: 0,
    lmsApproved: false,
  };
}

function summarizeSopAttendance(
  sopCode: string,
  rows: MonthlyExamRow[],
  sheets: AttendanceSheetLite[],
): SopAttendance {
  const code = sopCode.trim().toUpperCase();
  const scheduledByEmp = new Map<string, string>();
  for (const r of rows) {
    if (r.isIgnored) continue;
    const date = String(r.scheduledDate || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const prev = scheduledByEmp.get(r.employeeId);
    if (!prev || date < prev) scheduledByEmp.set(r.employeeId, date);
  }

  if (scheduledByEmp.size === 0) {
    return { filled: false, present: 0, absent: 0, presentIds: [], absentIds: [] };
  }

  const sheetsByDate = new Map<string, AttendanceSheetLite>();
  for (const sheet of sheets) {
    if (sheet.sopCode !== code) continue;
    sheetsByDate.set(sheet.trainingDate, sheet);
  }

  const presentIds: string[] = [];
  const absentIds: string[] = [];

  for (const [employeeId, date] of scheduledByEmp) {
    const sheet = sheetsByDate.get(date);
    if (!sheet) continue;
    const rec = sheet.records.find((r) => r.employeeId === employeeId);
    if (!rec) continue;
    if (rec.status === 'present') presentIds.push(employeeId);
    else absentIds.push(employeeId);
  }

  if (presentIds.length === 0 && absentIds.length === 0) {
    return { filled: false, present: 0, absent: 0, presentIds: [], absentIds: [] };
  }

  return {
    filled: true,
    present: presentIds.length,
    absent: absentIds.length,
    presentIds,
    absentIds,
  };
}

function isoDateOnly(value?: string): string {
  const d = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
}

/** Sitting 1 is a real assignment only when a trainer scheduled it. */
function hasTrainerSitting1(row: MonthlyExamRow): boolean {
  if (!isoDateOnly(row.scheduledDate)) return false;
  return row.source === 'trainer' || Boolean(row.scheduleId);
}

function attendanceMarkOnDate(
  sheets: AttendanceSheetLite[],
  sopCode: string,
  employeeId: string,
  date?: string,
): 'present' | 'absent' | null {
  const code = sopCode.trim().toUpperCase();
  const day = isoDateOnly(date);
  if (!day) return null;
  for (const sheet of sheets) {
    if (sheet.sopCode !== code || sheet.trainingDate !== day) continue;
    const rec = sheet.records.find((r) => r.employeeId === employeeId);
    if (!rec) return null;
    return rec.status;
  }
  return null;
}

function emptySittingColumn(): SittingColumn {
  return {
    dates: [],
    assigned: 0,
    needed: 0,
    assignedIds: [],
    neededIds: [],
    present: 0,
    absent: 0,
    presentIds: [],
    absentIds: [],
    filled: false,
  };
}

function buildSittingColumns(
  sopCode: string,
  sopRows: MonthlyExamRow[],
  sheets: AttendanceSheetLite[],
): { sitting1: SittingColumn; sitting2: SittingColumn; sitting3: SittingColumn } {
  const live = dedupeRowsByEmployee(sopRows);
  const column = (
    dateOf: (r: MonthlyExamRow) => string | undefined,
    neededRows: MonthlyExamRow[],
    isAssigned?: (r: MonthlyExamRow) => boolean,
  ): SittingColumn => {
    const assignedRows = live.filter(
      (r) => isoDateOnly(dateOf(r)) && (isAssigned ? isAssigned(r) : true),
    );
    const presentIds: string[] = [];
    const absentIds: string[] = [];
    for (const r of assignedRows) {
      const mark = attendanceMarkOnDate(sheets, sopCode, r.employeeId, dateOf(r));
      if (mark === 'present') presentIds.push(r.employeeId);
      else if (mark === 'absent') absentIds.push(r.employeeId);
    }
    return {
      dates: [...new Set(assignedRows.map((r) => isoDateOnly(dateOf(r))).filter(Boolean))].sort(),
      assigned: assignedRows.length,
      needed: neededRows.length,
      assignedIds: assignedRows.map((r) => r.employeeId),
      neededIds: neededRows.map((r) => r.employeeId),
      present: presentIds.length,
      absent: absentIds.length,
      presentIds,
      absentIds,
      filled: presentIds.length + absentIds.length > 0,
    };
  };

  const sitting1Needed = live.filter((r) => !hasTrainerSitting1(r) && r.status !== 'completed');
  const sitting1 = column((r) => r.scheduledDate, sitting1Needed, hasTrainerSitting1);
  const sitting1Absent = new Set(sitting1.absentIds);
  const sitting2Needed = live.filter(
    (r) => sitting1Absent.has(r.employeeId) && !isoDateOnly(r.scheduledDate2) && r.status !== 'completed',
  );
  const sitting2 = column((r) => r.scheduledDate2, sitting2Needed);
  const sitting2Absent = new Set(sitting2.absentIds);
  const sitting3Needed = live.filter(
    (r) => sitting2Absent.has(r.employeeId) && !isoDateOnly(r.scheduledDate3) && r.status !== 'completed',
  );
  const sitting3 = column((r) => r.scheduledDate3, sitting3Needed);
  return { sitting1, sitting2, sitting3 };
}

function resolveSopDepartment(
  sopRows: MonthlyExamRow[],
  catalogDept?: string,
): string {
  if (catalogDept) return catalogDept;
  const depts = [...new Set(sopRows.map((r) => r.department).filter(Boolean))].sort();
  if (depts.length === 0) return '—';
  if (depts.length === 1) return depts[0];
  return depts.join(', ');
}

function toSopLine(
  sopCode: string,
  sopRows: MonthlyExamRow[],
  catalog: Record<string, McqCatalogEntry>,
  sheets: AttendanceSheetLite[],
  scope: CountScope,
): SopLineItem {
  const counts = uniqueEmployeesForSop(sopRows);
  const extras = buildMonthScopeExtras(
    sopRows,
    scope.months,
    scope.viewYear,
    scope.expiryYear,
    scope.carryIntoMonth,
  );
  const layers = fourLayersFromExtras(extras, layerFromSopEmployees);
  const mcq = lookupMcqMeta(sopCode, catalog);
  const rowGujarati = sopRows.find((r) => r.sopNameGujarati)?.sopNameGujarati;
  const sopNameGujarati = rowGujarati || mcq.sopNameGujarati;
  const isDualLanguage = mcq.isDualLanguage || Boolean(sopNameGujarati);
  const attendance = summarizeSopAttendance(sopCode, sopRows, sheets);
  const sittings = buildSittingColumns(sopCode, sopRows, sheets);
  return {
    sopCode,
    sopIdentifier: mcq.sopIdentifier || sopCode,
    sopVersion: mcq.sopVersion,
    sopName: sopRows.find((r) => r.sopName)?.sopName || sopCode,
    department: resolveSopDepartment(sopRows, mcq.department),
    sopNameGujarati,
    isDualLanguage,
    rows: sopRows,
    uniqueTotal: counts.uniqueTotal,
    uniqueCompleted: counts.uniqueCompleted,
    uniqueRemaining: counts.uniqueRemaining,
    later: counts.later,
    scheduled: counts.scheduled,
    unscheduled: counts.unscheduled,
    scheduledDates: counts.scheduledDates,
    sitting1: sittings.sitting1,
    sitting2: sittings.sitting2,
    sitting3: sittings.sitting3,
    employees: counts.employees,
    expiryDate: counts.expiryDate,
    mcqNeedsEn: mcq.needsEn,
    mcqNeedsGu: mcq.needsGu && (mcq.isDualLanguage || !mcq.needsEn),
    mcqEng: mcq.eng,
    mcqGuj: mcq.guj,
    pdfEng: mcq.pdfEng,
    pdfGuj: mcq.pdfGuj,
    videoEng: mcq.videoEng,
    videoGuj: mcq.videoGuj,
    attendance,
    carriedCount: counts.employees.filter((e) => e.carriedFromMonth).length,
    layers,
  };
}

function groupSopLines(
  rows: MonthlyExamRow[],
  catalog: Record<string, McqCatalogEntry>,
  sheets: AttendanceSheetLite[],
  scope: CountScope,
): SopLineItem[] {
  const grouped = new Map<string, MonthlyExamRow[]>();
  for (const r of rows) {
    const code = r.sopCode.trim().toUpperCase();
    if (!code) continue;
    const list = grouped.get(code);
    if (list) list.push(r);
    else grouped.set(code, [r]);
  }
  return [...grouped.entries()]
    .map(([sopCode, sopRows]) => toSopLine(sopCode, sopRows, catalog, sheets, scope))
    .sort((a, b) => a.sopCode.localeCompare(b.sopCode));
}

function formatShortDate(iso: string) {
  const parts = iso.slice(0, 10).split('-');
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!month || !day || month < 1 || month > 12) return iso.slice(0, 10);
  return `${day} ${MONTHS[month - 1]}`;
}

function SolidPill({
  tone,
  title,
  onClick,
  className = '',
  children,
}: {
  tone: 'green' | 'sky' | 'gray' | 'indigo' | 'red';
  title?: string;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const toneClass =
    tone === 'green' ? 'text-emerald-700'
      : tone === 'sky' ? 'text-sky-700'
        : tone === 'indigo' ? 'text-purple-700'
          : tone === 'red' ? 'text-red-600'
            : 'text-gray-600';
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      className={`inline-flex min-w-[1.75rem] items-center justify-center rounded-full border border-gray-200/90 bg-white px-2 py-0.5 text-[10px] font-bold tabular-nums shadow-sm ${toneClass} hover:bg-gray-50 ${className}`}
    >
      {children}
    </button>
  );
}

const SOP_TH =
  'sticky top-0 z-30 bg-gray-100 px-1.5 py-0.5 align-top text-[9px] font-bold text-gray-600 uppercase tracking-wide whitespace-nowrap';
const SOP_TD = 'px-1.5 py-1 align-middle';

function monthColumnClass(active: boolean, isCurrent = false): string {
  const base = 'flex w-[7.25rem] shrink-0 flex-col rounded-[10px] border px-1.5 py-1 shadow-sm';
  if (active) return `${base} border-purple-300 bg-purple-50 ring-1 ring-purple-300`;
  if (isCurrent) return `${base} border-gray-200 bg-white ring-1 ring-purple-200`;
  return `${base} border-gray-200 bg-white`;
}

type SopSortKey =
  | 'sop'
  | 'version'
  | 'name'
  | 'dept'
  | 'mcq'
  | 'pdf'
  | 'video'
  | 'emps'
  | 'completed'
  | 'pending'
  | 'sched1'
  | 'unsched1'
  | 'date'
  | 'attnd1'
  | 'sched2'
  | 'unsched2'
  | 'date2'
  | 'attnd2'
  | 'sched3'
  | 'unsched3'
  | 'date3'
  | 'attnd3';

function mcqApprovedCount(slot: McqLangSlot): number {
  if (!slot.questionCount) return 0;
  return slot.lmsApproved ? slot.questionCount : 0;
}

function mcqPendingCount(slot: McqLangSlot): number {
  if (!slot.questionCount) return 0;
  return slot.lmsApproved ? 0 : slot.questionCount;
}

function assetMissingCount(
  needsEn: boolean,
  needsGu: boolean,
  eng: AssetLangSlot,
  guj: AssetLangSlot,
): number {
  return (needsEn && !eng.available ? 1 : 0) + (needsGu && !guj.available ? 1 : 0);
}

function assetAvailableCount(
  needsEn: boolean,
  needsGu: boolean,
  eng: AssetLangSlot,
  guj: AssetLangSlot,
): number {
  return (needsEn && eng.available ? 1 : 0) + (needsGu && guj.available ? 1 : 0);
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function sittingSortKeys(col: SittingColumn | undefined, part: 'sched' | 'unsched' | 'date' | 'attnd'): number[] {
  const sitting = col ?? emptySittingColumn();
  if (part === 'sched') return [sitting.assigned, sitting.needed];
  if (part === 'unsched') return [sitting.needed, sitting.assigned];
  if (part === 'attnd') {
    return sitting.filled ? [1, sitting.absent, sitting.present] : [0, 0, 0];
  }
  const iso = [...sitting.dates].sort()[0] || '';
  const ts = iso ? Date.parse(`${iso}T00:00:00`) : Number.POSITIVE_INFINITY;
  return [Number.isFinite(ts) ? ts : Number.POSITIVE_INFINITY];
}

function sopSortKeys(sop: SopLineItem, key: SopSortKey): { nums: number[]; text: string } {
  const id = sop.sopIdentifier || sop.sopCode;
  const code = sopNumberPart(id);
  switch (key) {
    case 'sop':
      return { nums: [], text: code };
    case 'version':
      return { nums: [], text: sopVersionPart(id, sop.sopVersion) };
    case 'name':
      return { nums: [], text: sop.sopName || '' };
    case 'dept':
      return { nums: [], text: sop.department || '' };
    case 'emps':
      return { nums: [sop.uniqueTotal, sop.uniqueRemaining], text: code };
    case 'completed':
      return { nums: [sop.uniqueCompleted, sop.uniqueRemaining], text: code };
    case 'pending':
      return { nums: [sop.uniqueRemaining, sop.uniqueTotal], text: code };
    case 'mcq':
      return {
        nums: [
          (sop.mcqNeedsEn ? mcqPendingCount(sop.mcqEng) : 0)
            + (sop.mcqNeedsGu ? mcqPendingCount(sop.mcqGuj) : 0),
          (sop.mcqNeedsEn ? mcqApprovedCount(sop.mcqEng) : 0)
            + (sop.mcqNeedsGu ? mcqApprovedCount(sop.mcqGuj) : 0),
          (sop.mcqNeedsEn ? sop.mcqEng.questionCount || 0 : 0)
            + (sop.mcqNeedsGu ? sop.mcqGuj.questionCount || 0 : 0),
        ],
        text: code,
      };
    case 'pdf':
      return {
        nums: [
          assetMissingCount(sop.mcqNeedsEn, sop.mcqNeedsGu, sop.pdfEng, sop.pdfGuj),
          assetAvailableCount(sop.mcqNeedsEn, sop.mcqNeedsGu, sop.pdfEng, sop.pdfGuj),
        ],
        text: code,
      };
    case 'video':
      return {
        nums: [
          assetMissingCount(sop.mcqNeedsEn, sop.mcqNeedsGu, sop.videoEng, sop.videoGuj),
          assetAvailableCount(sop.mcqNeedsEn, sop.mcqNeedsGu, sop.videoEng, sop.videoGuj),
        ],
        text: code,
      };
    case 'sched1':
      return { nums: sittingSortKeys(sop.sitting1, 'sched'), text: code };
    case 'unsched1':
      return { nums: sittingSortKeys(sop.sitting1, 'unsched'), text: code };
    case 'date':
      return { nums: sittingSortKeys(sop.sitting1, 'date'), text: code };
    case 'attnd1':
      return { nums: sittingSortKeys(sop.sitting1, 'attnd'), text: code };
    case 'sched2':
      return { nums: sittingSortKeys(sop.sitting2, 'sched'), text: code };
    case 'unsched2':
      return { nums: sittingSortKeys(sop.sitting2, 'unsched'), text: code };
    case 'date2':
      return { nums: sittingSortKeys(sop.sitting2, 'date'), text: code };
    case 'attnd2':
      return { nums: sittingSortKeys(sop.sitting2, 'attnd'), text: code };
    case 'sched3':
      return { nums: sittingSortKeys(sop.sitting3, 'sched'), text: code };
    case 'unsched3':
      return { nums: sittingSortKeys(sop.sitting3, 'unsched'), text: code };
    case 'date3':
      return { nums: sittingSortKeys(sop.sitting3, 'date'), text: code };
    case 'attnd3':
      return { nums: sittingSortKeys(sop.sitting3, 'attnd'), text: code };
  }
}

function sortSopLines(sops: SopLineItem[], key: SopSortKey, dir: 'asc' | 'desc'): SopLineItem[] {
  const sign = dir === 'asc' ? 1 : -1;
  const textUsesDir = key === 'sop' || key === 'version' || key === 'name' || key === 'dept';
  return [...sops].sort((a, b) => {
    const A = sopSortKeys(a, key);
    const B = sopSortKeys(b, key);
    const len = Math.max(A.nums.length, B.nums.length);
    for (let i = 0; i < len; i++) {
      const av = A.nums[i] ?? 0;
      const bv = B.nums[i] ?? 0;
      if (av === bv) continue;
      if (!Number.isFinite(av) && Number.isFinite(bv)) return 1;
      if (!Number.isFinite(bv) && Number.isFinite(av)) return -1;
      return (av - bv) * sign;
    }
    const byText = compareText(A.text, B.text);
    if (byText !== 0) return textUsesDir ? byText * sign : byText;
    return compareText(a.sopName, b.sopName) * (textUsesDir ? sign : 1);
  });
}

function SopSortBtn({
  label,
  sortKey,
  sort,
  onSort,
  className = '',
  title,
}: {
  label: string;
  sortKey: SopSortKey;
  sort: { key: SopSortKey; dir: 'asc' | 'desc' };
  onSort: (key: SopSortKey) => void;
  className?: string;
  title?: string;
}) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      title={title ?? `Sort by ${label}`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSort(sortKey);
      }}
      className={`inline-flex w-full min-w-0 items-center gap-0.5 rounded px-0.5 py-1 text-left text-[9px] font-bold uppercase tracking-wide hover:bg-purple-50/80 hover:text-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-400 ${
        active ? 'text-purple-700' : 'text-gray-600'
      } ${className}`}
    >
      {label}
      {active
        ? sort.dir === 'asc'
          ? <ArrowUp className="h-3 w-3 shrink-0 text-purple-600" />
          : <ArrowDown className="h-3 w-3 shrink-0 text-purple-600" />
        : <ArrowUpDown className="h-3 w-3 shrink-0 text-gray-400 opacity-60" />}
    </button>
  );
}

function SopTableHeader({
  sort,
  onSort,
}: {
  sort: { key: SopSortKey; dir: 'asc' | 'desc' };
  onSort: (key: SopSortKey) => void;
}) {
  return (
    <thead>
      <tr>
        <th className={`${SOP_TH} text-center`}>#</th>
        <th className={SOP_TH}><SopSortBtn label="SOP No" sortKey="sop" sort={sort} onSort={onSort} /></th>
        <th className={`${SOP_TH} text-center`}><SopSortBtn label="Ver" sortKey="version" sort={sort} onSort={onSort} title="Sort by SOP version" className="justify-center" /></th>
        <th className={SOP_TH}><SopSortBtn label="SOP Name" sortKey="name" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Dept" sortKey="dept" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="MCQs" sortKey="mcq" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="PDF" sortKey="pdf" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Video" sortKey="video" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Tot emp" sortKey="emps" sort={sort} onSort={onSort} title="Sort by total employees" /></th>
        <th className={SOP_TH}><SopSortBtn label="Completed" sortKey="completed" sort={sort} onSort={onSort} title="Sort by completed employees" /></th>
        <th className={SOP_TH}><SopSortBtn label="Pending" sortKey="pending" sort={sort} onSort={onSort} title="Sort by pending employees" /></th>
        <th className={SOP_TH}><SopSortBtn label="Sch 1" sortKey="sched1" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Unsch 1" sortKey="unsched1" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Date 1" sortKey="date" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Att 1" sortKey="attnd1" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Sch 2" sortKey="sched2" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Unsch 2" sortKey="unsched2" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Date 2" sortKey="date2" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Att 2" sortKey="attnd2" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Sch 3" sortKey="sched3" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Unsch 3" sortKey="unsched3" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Date 3" sortKey="date3" sort={sort} onSort={onSort} /></th>
        <th className={SOP_TH}><SopSortBtn label="Att 3" sortKey="attnd3" sort={sort} onSort={onSort} /></th>
      </tr>
    </thead>
  );
}

function formatSchedDisplay(dates: string[]): string {
  if (dates.length === 0) return '—';
  const sorted = [...dates].sort();
  const first = formatShortDate(sorted[0]);
  if (sorted.length === 1) return first;
  const last = formatShortDate(sorted[sorted.length - 1]);
  if (first === last) return first;
  return `${first} – ${last}`;
}

function SittingDateCell({
  dates,
  assigned,
  needed,
  viewKind,
  onOpen,
  onAssign,
  editTitle,
  addTitle,
  emptyLabel = '—',
}: {
  dates: string[];
  assigned: number;
  needed: number;
  viewKind: SopLineKind;
  onOpen: (kind: SopLineKind) => void;
  onAssign: (mode: 'add' | 'edit') => void;
  editTitle: string;
  addTitle: string;
  emptyLabel?: string;
}) {
  const text = formatSchedDisplay(dates);
  const title = dates.length ? dates.map(formatShortDate).join(', ') : emptyLabel;
  return (
    <div className="inline-flex min-w-0 items-center gap-0.5">
      {dates.length > 0 ? (
        <button
          type="button"
          title={title}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(viewKind);
          }}
          className="truncate text-left text-[10px] font-semibold leading-tight text-purple-700 hover:underline"
        >
          {text}
        </button>
      ) : (
        <span className="text-[10px] text-gray-400">{emptyLabel}</span>
      )}
      {assigned > 0 ? (
        <button
          type="button"
          title={editTitle}
          onClick={(e) => {
            e.stopPropagation();
            onAssign('edit');
          }}
          className="inline-flex shrink-0 items-center justify-center rounded p-0.5 text-purple-600 hover:bg-purple-50 hover:text-purple-800"
        >
          <Pencil className="h-3 w-3" />
        </button>
      ) : null}
      {needed > 0 ? (
        <button
          type="button"
          title={addTitle}
          onClick={(e) => {
            e.stopPropagation();
            onAssign('add');
          }}
          className="inline-flex shrink-0 items-center justify-center rounded p-0.5 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-900"
        >
          <Plus className="h-3 w-3" />
        </button>
      ) : null}
    </div>
  );
}

function SittingAttendanceCell({
  sitting,
  sittingNo,
  sop,
  onOpen,
}: {
  sitting: SittingColumn;
  sittingNo: 1 | 2 | 3;
  sop: SopLineItem;
  onOpen: (kind: SopLineKind, opts?: SopLineOpenOpts) => void;
}) {
  if (!sitting.filled) {
    return (
      <span className="text-[10px] text-gray-400">
        {sitting.assigned > 0 ? 'No attendance' : '—'}
      </span>
    );
  }
  const rowsFor = (ids: string[]) => sop.rows.filter((r) => ids.includes(r.employeeId));
  return (
    <SplitCountPill
      done={sitting.present}
      left={sitting.absent}
      doneTitle={`${sitting.present} present on sitting ${sittingNo}`}
      leftTitle={`${sitting.absent} absent on sitting ${sittingNo}`}
      onDoneClick={() => onOpen('total', {
        layerRows: rowsFor(sitting.presentIds),
        heading: `Present · sitting ${sittingNo}`,
      })}
      onLeftClick={() => onOpen('total', {
        layerRows: rowsFor(sitting.absentIds),
        heading: `Absent · sitting ${sittingNo}`,
      })}
    />
  );
}

function SopLineRow({
  index,
  isEven,
  sop,
  active,
  showExpiry,
  onSelect,
  onOpen,
  onAssignDate,
}: {
  index: number;
  isEven: boolean;
  sop: SopLineItem;
  active: boolean;
  showExpiry?: boolean;
  onSelect: () => void;
  onOpen: (kind: SopLineKind, opts?: SopLineOpenOpts) => void;
  onAssignDate: (sitting: 1 | 2 | 3, mode: 'add' | 'edit') => void;
}) {
  const id = sop.sopIdentifier || sop.sopCode;
  const s1 = sop.sitting1 ?? emptySittingColumn();
  const s2 = sop.sitting2 ?? emptySittingColumn();
  const s3 = sop.sitting3 ?? emptySittingColumn();
  const rowsFor = (ids: string[]) => sop.rows.filter((r) => ids.includes(r.employeeId));
  const carryTag = carryForwardTag(sop);
  return (
    <tr
      onClick={onSelect}
      className={`cursor-pointer border-b border-gray-100/80 transition-colors hover:bg-purple-50/80 ${
        active ? 'bg-purple-50' : isEven ? 'bg-white' : 'bg-gray-50/60'
      }`}
    >
      <td className={`${SOP_TD} text-center text-[10px] font-bold text-gray-600 tabular-nums`}>
        {index}
      </td>
      <td className={`${SOP_TD} whitespace-nowrap font-mono text-[13px] font-bold tracking-wider text-purple-700 hover:underline`}>
        <div className="flex flex-col items-start gap-0.5">
          <button
            type="button"
            onClick={onSelect}
            title={`${formatSopNoWithVersion(id, sop.sopVersion)} — ${sop.sopName}`}
            className="text-left font-mono text-[13px] font-bold tracking-wider text-purple-700"
          >
            {sopNumberPart(id)}
          </button>
          {carryTag ? (
            <span
              className="rounded border border-amber-300 bg-amber-100 px-1 py-px text-[9px] font-bold uppercase tracking-wide text-amber-900"
              title={carryTag.title}
            >
              {carryTag.label}
            </span>
          ) : null}
        </div>
      </td>
      <td className={`${SOP_TD} text-center`}>
        <span className="text-[11px] font-bold text-gray-800 tabular-nums">
          {sopVersionPart(id, sop.sopVersion)}
        </span>
      </td>
      <td className={`${SOP_TD} min-w-[12rem] max-w-[22rem] font-medium text-gray-800`}>
        <button type="button" onClick={onSelect} className="min-w-0 text-left">
          <span
            className="block whitespace-normal text-[12px] font-bold leading-tight text-gray-900 wrap-break-word"
            title={sop.sopName}
          >
            {sop.sopName}
          </span>
          {sop.sopNameGujarati ? (
            <span
              className="block whitespace-normal text-[10px] font-bold leading-tight text-indigo-700 wrap-break-word"
              title={sop.sopNameGujarati}
            >
              {sop.sopNameGujarati}
            </span>
          ) : null}
          {showExpiry && sop.expiryDate ? (
            <span className="mt-0.5 inline-block rounded border border-amber-200 bg-amber-50 px-1 py-px text-[8px] font-semibold text-amber-800">
              expires {formatShortDate(sop.expiryDate)}
            </span>
          ) : null}
        </button>
      </td>

      <td className={`${SOP_TD} whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-gray-700`} title={sop.department}>
        {shortDepartmentName(sop.department)}
      </td>

      <td className={SOP_TD}>
        <McqLangPanel
          sopCode={sop.sopCode}
          needsEn={sop.mcqNeedsEn}
          needsGu={sop.mcqNeedsGu}
          eng={sop.mcqEng}
          guj={sop.mcqGuj}
        />
      </td>
      <td className={SOP_TD}>
        <AssetLangPanel
          sopCode={sop.sopCode}
          needsEn={sop.mcqNeedsEn}
          needsGu={sop.mcqNeedsGu}
          eng={sop.pdfEng}
          guj={sop.pdfGuj}
          assetLabel="PDF"
        />
      </td>
      <td className={SOP_TD}>
        <AssetLangPanel
          sopCode={sop.sopCode}
          needsEn={sop.mcqNeedsEn}
          needsGu={sop.mcqNeedsGu}
          eng={sop.videoEng}
          guj={sop.videoGuj}
          assetLabel="video"
        />
      </td>

      <td className={SOP_TD}>
        <SolidPill tone="green" title="Total assigned employees" onClick={() => onOpen('total')}>
          {sop.uniqueTotal}
        </SolidPill>
      </td>
      <td className={SOP_TD}>
        <SolidPill
          tone="green"
          title="Employees who have completed this SOP exam"
          onClick={() => onOpen('completed')}
        >
          {sop.uniqueCompleted}
        </SolidPill>
      </td>
      <td className={SOP_TD}>
        <SolidPill
          tone="red"
          title="Employees who have not completed this SOP exam"
          onClick={() => onOpen('remaining')}
        >
          {sop.uniqueRemaining + sop.later}
        </SolidPill>
      </td>

      <td className={SOP_TD}>
        <SolidPill
          tone="indigo"
          title="Employees scheduled for sitting 1"
          onClick={() => onOpen('scheduled')}
        >
          {s1.assigned}
        </SolidPill>
      </td>
      <td className={SOP_TD}>
        <SolidPill
          tone="red"
          title="Employees with no sitting 1 date"
          onClick={() => onOpen('unscheduled')}
        >
          {s1.needed}
        </SolidPill>
      </td>
      <td className={SOP_TD}>
        <SittingDateCell
          dates={s1.dates}
          assigned={s1.assigned}
          needed={s1.needed}
          viewKind="scheduled"
          onOpen={onOpen}
          onAssign={(mode) => onAssignDate(1, mode)}
          editTitle="Change sitting 1 date"
          addTitle="Assign sitting 1 date"
        />
      </td>
      <td className={SOP_TD}>
        <SittingAttendanceCell sitting={s1} sittingNo={1} sop={sop} onOpen={onOpen} />
      </td>

      <td className={SOP_TD}>
        <SolidPill
          tone="indigo"
          title="Employees scheduled for sitting 2"
          onClick={() => onOpen('sitting2')}
        >
          {s2.assigned}
        </SolidPill>
      </td>
      <td className={SOP_TD}>
        <SolidPill
          tone="red"
          title="Absentees from sitting 1 with no sitting 2 date"
          onClick={() => onOpen('total', { layerRows: rowsFor(s2.neededIds), heading: 'Unscheduled · sitting 2' })}
        >
          {s2.needed}
        </SolidPill>
      </td>
      <td className={SOP_TD}>
        <SittingDateCell
          dates={s2.dates}
          assigned={s2.assigned}
          needed={s2.needed}
          viewKind="sitting2"
          onOpen={onOpen}
          onAssign={(mode) => onAssignDate(2, mode)}
          editTitle="Change sitting 2 date"
          addTitle="Assign sitting 2 date to sitting 1 absentees"
        />
      </td>
      <td className={SOP_TD}>
        <SittingAttendanceCell sitting={s2} sittingNo={2} sop={sop} onOpen={onOpen} />
      </td>

      <td className={SOP_TD}>
        <SolidPill
          tone="indigo"
          title="Employees scheduled for sitting 3"
          onClick={() => onOpen('sitting3')}
        >
          {s3.assigned}
        </SolidPill>
      </td>
      <td className={SOP_TD}>
        <SolidPill
          tone="red"
          title="Absentees from sitting 2 with no sitting 3 date"
          onClick={() => onOpen('total', { layerRows: rowsFor(s3.neededIds), heading: 'Unscheduled · sitting 3' })}
        >
          {s3.needed}
        </SolidPill>
      </td>
      <td className={SOP_TD}>
        <SittingDateCell
          dates={s3.dates}
          assigned={s3.assigned}
          needed={s3.needed}
          viewKind="sitting3"
          onOpen={onOpen}
          onAssign={(mode) => onAssignDate(3, mode)}
          editTitle="Change sitting 3 date"
          addTitle="Assign sitting 3 date to sitting 2 absentees"
        />
      </td>
      <td className={SOP_TD}>
        <SittingAttendanceCell sitting={s3} sittingNo={3} sop={sop} onOpen={onOpen} />
      </td>
    </tr>
  );
}

function TotalPill({
  icon: Icon,
  children,
  onClick,
}: {
  icon: typeof ClipboardList;
  children: ReactNode;
  onClick?: () => void;
}) {
  const className = 'inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-gray-700';
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${className} hover:bg-gray-50`}>
        <Icon className="h-3 w-3 shrink-0 text-purple-600" />
        {children}
      </button>
    );
  }
  return (
    <span className={className}>
      <Icon className="h-3 w-3 shrink-0 text-purple-600" />
      {children}
    </span>
  );
}

function ScopeCapsule({
  label,
  title,
  active,
  done,
  left,
  compact,
  hideLabel,
  onSelect,
  onDoneClick,
  onLeftClick,
}: {
  label: string;
  title: string;
  active: boolean;
  done: number;
  left: number;
  compact?: boolean;
  hideLabel?: boolean;
  onSelect: () => void;
  onDoneClick: () => void;
  onLeftClick: () => void;
}) {
  return (
    <div
      className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-[5px] px-0.5 py-px text-[10px] ${
        active ? 'border border-purple-400 bg-purple-100/90' : 'border border-transparent'
      }`}
      title={title}
    >
      {hideLabel ? (
        <span />
      ) : (
        <button
          type="button"
          onClick={onSelect}
          className={`min-w-0 truncate text-left font-medium text-gray-600 hover:text-purple-800 ${
            compact ? 'text-[9px] uppercase tracking-wide' : 'text-[10px]'
          }`}
        >
          {label}
        </button>
      )}
      <SplitCountPill
        done={done}
        left={left}
        doneTitle={`${done} completed — click to view`}
        leftTitle={`${left} not completed — click to view`}
        onDoneClick={onDoneClick}
        onLeftClick={onLeftClick}
      />
    </div>
  );
}

function FourLayerPills({
  layers,
  onOpen,
}: {
  layers: FourLayerSet;
  onOpen: (scope: keyof FourLayerSet, kind: 'completed' | 'remaining' | 'total') => void;
}) {
  const items: Array<{ key: keyof FourLayerSet; label: string; title: string }> = [
    { key: 'due', label: 'Month', title: 'SOP exams due in the selected month' },
    { key: 'carried', label: 'Carried', title: 'Incomplete SOP exams rolled in from earlier months' },
    { key: 'total', label: 'Total', title: 'Unique union of month and carried-forward' },
  ];
  return (
    <div className="flex w-full flex-col gap-0">
      {items.map((item) => (
        <ScopeCapsule
          key={item.key}
          compact
          label={item.label}
          title={item.title}
          active={false}
          done={layers[item.key].completed}
          left={layers[item.key].remaining}
          onSelect={() => onOpen(item.key, 'total')}
          onDoneClick={() => onOpen(item.key, 'completed')}
          onLeftClick={() => onOpen(item.key, 'remaining')}
        />
      ))}
    </div>
  );
}

function MonthExtraCapsules({
  extras,
  monthSelected,
  activeScope,
  onActivate,
  onOpen,
}: {
  extras: MonthScopeExtras;
  monthSelected: boolean;
  activeScope: SummaryScope;
  onActivate: (scope: SummaryScope) => void;
  onOpen: (scope: SummaryScope, kind: 'completed' | 'remaining' | 'total') => void;
}) {
  return (
    <div className="mt-0.5 flex w-full flex-col gap-0 border-t border-gray-100 pt-0.5">
      <ScopeCapsule
        compact
        label="Carried"
        title="Incomplete SOP exams from earlier months, rolled into this month"
        active={monthSelected && activeScope === 'carried'}
        done={extras.carried.completed}
        left={extras.carried.remaining}
        onSelect={() => onActivate(monthSelected && activeScope === 'carried' ? 'total' : 'carried')}
        onDoneClick={() => onOpen('carried', 'completed')}
        onLeftClick={() => onOpen('carried', 'remaining')}
      />
      <ScopeCapsule
        compact
        label="Near-exp."
        title="SOP exams that expire this month or within 30 days"
        active={monthSelected && activeScope === 'nearExpiry'}
        done={extras.near.completed}
        left={extras.near.remaining}
        onSelect={() => onActivate(monthSelected && activeScope === 'nearExpiry' ? 'total' : 'nearExpiry')}
        onDoneClick={() => onOpen('nearExpiry', 'completed')}
        onLeftClick={() => onOpen('nearExpiry', 'remaining')}
      />
      <ScopeCapsule
        compact
        label="Total"
        title="Unique union of this month, carried-forward, and near-expiry SOP exams"
        active={monthSelected && activeScope === 'total'}
        done={extras.total.completed}
        left={extras.total.remaining}
        onSelect={() => onActivate('total')}
        onDoneClick={() => onOpen('total', 'completed')}
        onLeftClick={() => onOpen('total', 'remaining')}
      />
    </div>
  );
}

function McqLangPanel({
  sopCode,
  needsEn,
  needsGu,
  eng,
  guj,
}: {
  sopCode: string;
  needsEn: boolean;
  needsGu: boolean;
  eng: McqLangSlot;
  guj: McqLangSlot;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {needsEn ? <McqLangRow lang="EN" sopCode={sopCode} slot={eng} /> : null}
      {needsGu ? <McqLangRow lang="GU" sopCode={sopCode} slot={guj} /> : null}
    </div>
  );
}

function McqLangRow({
  lang,
  sopCode,
  slot,
}: {
  lang: 'EN' | 'GU';
  sopCode: string;
  slot: McqLangSlot;
}) {
  const href = `/mcq-bank?search=${encodeURIComponent(sopCode)}`;
  const created = slot.questionCount > 0;
  const approvedCount = created && slot.lmsApproved ? slot.questionCount : 0;
  const pendingCount = created && !slot.lmsApproved ? slot.questionCount : 0;
  return (
    <div className="flex items-center gap-0.5">
      <span className="min-w-fit text-[9px] font-medium uppercase tracking-wide text-gray-500">{lang}</span>
      {!created ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={`No ${lang === 'EN' ? 'English' : 'Gujarati'} MCQs exist for this SOP`}
          className="whitespace-nowrap text-[10px] font-medium leading-tight text-gray-400 hover:text-purple-700"
        >
          No MCQs
        </a>
      ) : (
        <SplitCountPill
          done={approvedCount}
          left={pendingCount}
          doneHref={href}
          leftHref={href}
          doneTitle={approvedCount > 0 ? `${approvedCount} ${lang} MCQs approved` : `No approved ${lang} MCQs`}
          leftTitle={pendingCount > 0 ? `${pendingCount} ${lang} MCQs pending approval` : `No ${lang} MCQs awaiting approval`}
        />
      )}
    </div>
  );
}

function AssetLangPanel({
  sopCode,
  needsEn,
  needsGu,
  eng,
  guj,
  assetLabel,
}: {
  sopCode: string;
  needsEn: boolean;
  needsGu: boolean;
  eng: AssetLangSlot;
  guj: AssetLangSlot;
  assetLabel: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {needsEn ? (
        <AssetLangRow lang="EN" sopCode={sopCode} slot={eng} assetLabel={assetLabel} />
      ) : null}
      {needsGu ? (
        <AssetLangRow lang="GU" sopCode={sopCode} slot={guj} assetLabel={assetLabel} />
      ) : null}
    </div>
  );
}

function AssetLangRow({
  lang,
  sopCode,
  slot,
  assetLabel,
}: {
  lang: 'EN' | 'GU';
  sopCode: string;
  slot: AssetLangSlot;
  assetLabel: string;
}) {
  const href = `/lms/journey/${encodeURIComponent(sopCode)}`;
  const label = assetLabel === 'PDF' ? 'PDF' : 'video';
  return (
    <div className="flex items-center gap-0.5">
      <span className="min-w-fit text-[9px] font-medium uppercase tracking-wide text-gray-500">{lang}</span>
      <SplitCountPill
        done={slot.available ? 1 : 0}
        left={slot.available ? 0 : 1}
        doneHref={href}
        leftHref={href}
        doneTitle={slot.available ? `${lang} ${label} available` : `No ${lang} ${label}`}
        leftTitle={slot.available ? `${lang} ${label} available` : `No ${lang === 'EN' ? 'English' : 'Gujarati'} ${label} for this SOP`}
      />
    </div>
  );
}

function SplitCountPill({
  done,
  left,
  onDoneClick,
  onLeftClick,
  doneTitle,
  leftTitle,
  doneHref,
  leftHref,
}: {
  done: number;
  left: number;
  onDoneClick?: () => void;
  onLeftClick?: () => void;
  doneTitle?: string;
  leftTitle?: string;
  doneHref?: string;
  leftHref?: string;
}) {
  const half = (side: 'done' | 'left') => {
    const n = side === 'done' ? done : left;
    const color = side === 'done'
      ? 'text-emerald-700 hover:bg-emerald-50 focus:ring-emerald-500/70'
      : 'text-red-600 hover:bg-red-50 focus:ring-red-400/70';
    const title = side === 'done' ? doneTitle : leftTitle;
    const href = side === 'done' ? doneHref : leftHref;
    const onClick = side === 'done' ? onDoneClick : onLeftClick;
    const className = `min-w-[1.35rem] cursor-pointer rounded px-1 py-0.5 text-center text-[10px] font-bold leading-none tabular-nums focus:z-10 focus:outline-none focus:ring-1 ${color}`;
    if (href) {
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          title={title}
          className={className}
          onClick={(e) => e.stopPropagation()}
        >
          {n}
        </a>
      );
    }
    return (
      <button
        type="button"
        title={title ?? (side === 'done' ? `${done} completed — click to view` : `${left} remaining — click to view`)}
        className={className}
        onClick={(e) => {
          e.stopPropagation();
          onClick?.();
        }}
      >
        {n}
      </button>
    );
  };
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-gray-200/90 bg-white/95 px-0.5 py-px shadow-sm tabular-nums">
      {half('done')}
      <span className="select-none text-[8px] font-light text-gray-300" aria-hidden>|</span>
      {half('left')}
    </span>
  );
}

function defaultExamDeadline(year: number, month: number): string {
  const last = new Date(year, month, 0);
  while (last.getDay() === 0) last.setDate(last.getDate() - 1);
  const y = last.getFullYear();
  const m = String(last.getMonth() + 1).padStart(2, '0');
  const d = String(last.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function targetRowsForSopDateAssign(
  sop: SopLineItem,
  sitting: 1 | 2 | 3,
  mode: 'add' | 'edit',
): MonthlyExamRow[] {
  if (sitting === 1) {
    const counts = uniqueEmployeesForSop(sop.rows);
    const pool = mode === 'add' ? counts.unscheduledRows : counts.scheduledRows;
    return dedupeRowsByEmployee(
      pool.filter((r) => !r.isIgnored && r.status !== 'completed'),
    );
  }
  const live = dedupeRowsByEmployee(
    sop.rows.filter((r) => !r.isIgnored && r.status !== 'completed'),
  );
  const col = sitting === 2 ? sop.sitting2 : sop.sitting3;
  const ids = new Set(mode === 'edit' ? col.assignedIds : col.neededIds);
  return live.filter((r) => ids.has(r.employeeId));
}

async function assignSopBulkDate(
  rows: MonthlyExamRow[],
  examDate: string,
  sitting: 1 | 2 | 3 = 1,
): Promise<{ ok: number; failed: string[] }> {
  const failed: string[] = [];
  let ok = 0;

  const withSchedule = rows.filter((r) => r.scheduleId);
  for (const row of withSchedule) {
    try {
      const res = await fetch('/api/lms/trainer/scheduled-exams', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.scheduleId, scheduledDate: examDate, sitting }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to update schedule');
      ok++;
    } catch (err) {
      failed.push(`${row.employeeName}: ${err instanceof Error ? err.message : 'Failed'}`);
    }
  }

  const withoutSchedule = rows.filter((r) => !r.scheduleId);
  const groups = new Map<string, MonthlyExamRow[]>();
  for (const row of withoutSchedule) {
    const key = `${row.year}:${row.month}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  for (const group of groups.values()) {
    const eligible = group.filter((r) => r.hasLmsAccess);
    const ineligible = group.filter((r) => !r.hasLmsAccess);
    for (const row of ineligible) {
      failed.push(`${row.employeeName}: no LMS login`);
    }
    if (eligible.length === 0) continue;

    let bulkOk = false;
    try {
      const res = await fetch('/api/lms/trainer/scheduled-exams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeIds: eligible.map((r) => r.employeeId),
          sopCode: eligible[0].sopCode,
          scheduledDate: examDate,
          month: eligible[0].month,
          year: eligible[0].year,
          sitting,
          sitting1Date: eligible[0].scheduledDate || examDate,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to schedule');
      ok += eligible.length;
      bulkOk = true;
    } catch {
      bulkOk = false;
    }

    if (bulkOk) continue;
    if (sitting !== 1) {
      for (const row of eligible) {
        failed.push(`${row.employeeName}: Failed to save schedule ${sitting}`);
      }
      continue;
    }

    for (const row of eligible) {
      try {
        const res = await fetch('/api/lms/trainer/exam-date', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            employeeId: row.employeeId,
            sopCode: row.sopCode,
            department: row.department,
            plannedMonth: row.month,
            year: row.year,
            examDate,
            allowOutsideMonth: true,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'Failed to assign date');
        ok++;
      } catch (err) {
        failed.push(`${row.employeeName}: ${err instanceof Error ? err.message : 'Failed'}`);
      }
    }
  }

  return { ok, failed };
}

function SopDateAssignDialog({
  sop,
  sitting,
  mode,
  viewYear,
  selectedMonths,
  onClose,
  onSaved,
}: {
  sop: SopLineItem;
  sitting: 1 | 2 | 3;
  mode: 'add' | 'edit';
  viewYear: number;
  selectedMonths: number[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const targetRows = useMemo(
    () => targetRowsForSopDateAssign(sop, sitting, mode),
    [sop, sitting, mode],
  );
  const primaryMonth = selectedMonths[0] ?? targetRows[0]?.month ?? new Date().getMonth() + 1;
  const primaryYear = targetRows[0]?.year ?? viewYear;
  const existingDates = sitting === 1
    ? sop.scheduledDates
    : sitting === 2
      ? sop.sitting2.dates
      : sop.sitting3.dates;
  const initialDate = mode === 'edit' && existingDates.length > 0
    ? existingDates[0]
    : defaultExamDeadline(primaryYear, primaryMonth);

  const [examDate, setExamDate] = useState(initialDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const eligibleCount = targetRows.filter((r) => r.hasLmsAccess).length;
  const ineligibleCount = targetRows.length - eligibleCount;
  const sittingLabel = sitting === 1 ? 'exam date' : `schedule ${sitting}`;

  const save = async () => {
    if (!examDate || targetRows.length === 0) return;
    setBusy(true);
    setError('');
    try {
      const { ok, failed } = await assignSopBulkDate(targetRows, examDate, sitting);
      if (ok === 0) {
        throw new Error(failed[0] || 'No dates were assigned');
      }
      if (failed.length > 0) {
        window.alert(`Assigned ${ok} employee${ok === 1 ? '' : 's'}. Failed: ${failed.slice(0, 3).join('; ')}${failed.length > 3 ? '…' : ''}`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign date');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => !busy && onClose()}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-bold text-gray-900">
          {mode === 'add'
            ? sitting === 1 ? 'Assign exam date' : `Assign schedule ${sitting}`
            : sitting === 1 ? 'Change exam date' : `Change schedule ${sitting}`}
        </h2>
        <p className="mt-1 text-xs text-gray-500">
          <span className="font-mono font-bold text-emerald-800">
            {formatSopNoWithVersion(sop.sopIdentifier || sop.sopCode, sop.sopVersion)}
          </span>
          {' · '}
          {sop.sopName}
        </p>
        <p className="mt-2 text-xs text-gray-600">
          {mode === 'add'
            ? sitting === 1
              ? `Sets a date for ${eligibleCount} unscheduled employee${eligibleCount === 1 ? '' : 's'}`
              : `Sets ${sittingLabel} for ${eligibleCount} absent employee${eligibleCount === 1 ? '' : 's'}`
            : `Updates ${sittingLabel} for ${eligibleCount} employee${eligibleCount === 1 ? '' : 's'}`}
          {ineligibleCount > 0 && (
            <span className="text-amber-700">
              {' '}
              ({ineligibleCount} skipped — no LMS login)
            </span>
          )}
        </p>
        {targetRows.length === 0 && (
          <p className="mt-2 text-xs font-medium text-amber-700">
            {sitting === 1
              ? `No eligible employees to ${mode === 'add' ? 'assign' : 'update'}.`
              : sitting === 2
                ? 'No absentees from schedule 1 need a makeup date.'
                : 'No absentees from schedule 2 need a makeup date.'}
          </p>
        )}
        {error && (
          <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {error}
          </p>
        )}
        <label className="mt-3 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          {sitting === 1 ? 'Exam date' : `Schedule ${sitting} date`}
          <input
            type="date"
            value={examDate}
            onChange={(e) => setExamDate(e.target.value)}
            disabled={busy || targetRows.length === 0}
            className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !examDate || eligibleCount === 0}
            onClick={() => void save()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {busy ? 'Saving…' : 'Save date'}
          </button>
        </div>
      </div>
    </div>
  );
}

function groupRowsByMonth(rows: MonthlyExamRow[]) {
  const map = new Map<string, MonthlyExamRow[]>();
  for (const r of rows) {
    const key = `${MONTHS_FULL[r.month - 1]} ${r.year}`;
    const list = map.get(key) ?? [];
    list.push(r);
    map.set(key, list);
  }
  return map;
}

function groupRowsBySop(rows: MonthlyExamRow[]) {
  const map = new Map<string, { label: string; rows: MonthlyExamRow[] }>();
  for (const r of rows) {
    const code = r.sopCode.trim().toUpperCase();
    const entry = map.get(code) ?? { label: `${r.sopCode} — ${r.sopName}`, rows: [] };
    entry.rows.push(r);
    map.set(code, entry);
  }
  return map;
}

function groupRowsByEmployee(rows: MonthlyExamRow[]) {
  const map = new Map<string, MonthlyExamRow[]>();
  for (const r of rows) {
    const list = map.get(r.employeeId) ?? [];
    list.push(r);
    map.set(r.employeeId, list);
  }
  return map;
}

function SopWiseSummaryTable({ rows }: { rows: MonthlyExamRow[] }) {
  const groups = groupRowsBySop(rows);
  const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      <div className="max-h-[min(75vh,44rem)] overflow-auto">
        <table className="w-full min-w-[700px] text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-gray-100 bg-gray-50">
            <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              <th className="px-3 py-2 w-8">#</th>
              <th className="px-3 py-2">SOP Code</th>
              <th className="px-3 py-2">Training / SOP Name</th>
              <th className="px-3 py-2 text-center">Employees</th>
              <th className="px-3 py-2 text-center">Completed</th>
              <th className="px-3 py-2 text-center">Remaining</th>
              <th className="px-3 py-2 text-center">Progress</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map(([code, { label, rows: gRows }], i) => {
              const uniqueEmployees = new Set(gRows.map((r) => r.employeeId)).size;
              const done = new Set(gRows.filter((r) => r.status === 'completed').map((r) => r.employeeId)).size;
              const remaining = uniqueEmployees - done;
              const pct = uniqueEmployees > 0 ? Math.round((done / uniqueEmployees) * 100) : 0;
              return (
                <tr key={code} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                  <td className="px-3 py-2 text-[10px] font-bold text-gray-500 tabular-nums">{i + 1}</td>
                  <td className="px-3 py-2 font-mono text-[11px] font-bold text-purple-700 whitespace-nowrap">{code}</td>
                  <td className="px-3 py-2 text-gray-800 max-w-[20rem]">
                    <span className="line-clamp-2 text-[11px] font-medium" title={label}>{gRows[0].sopName}</span>
                  </td>
                  <td className="px-3 py-2 text-center font-bold text-gray-900 tabular-nums">{uniqueEmployees}</td>
                  <td className="px-3 py-2 text-center font-bold text-emerald-700 tabular-nums">{done}</td>
                  <td className="px-3 py-2 text-center font-bold text-red-600 tabular-nums">{remaining}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200">
                        <div className="h-full rounded-full bg-purple-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-8 text-right text-[10px] tabular-nums text-gray-500">{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmployeeWiseSummaryTable({ rows }: { rows: MonthlyExamRow[] }) {
  const groups = groupRowsByEmployee(rows);
  const sorted = [...groups.entries()].sort((a, b) => a[1][0].employeeName.localeCompare(b[1][0].employeeName));
  return (
    <div className="overflow-hidden rounded-xl border border-gray-200">
      <div className="max-h-[min(75vh,44rem)] overflow-auto">
        <table className="w-full min-w-[600px] text-left text-xs">
          <thead className="sticky top-0 z-10 border-b border-gray-100 bg-gray-50">
            <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
              <th className="px-3 py-2 w-8">#</th>
              <th className="px-3 py-2">Employee</th>
              <th className="px-3 py-2">Designation</th>
              <th className="px-3 py-2">Dept</th>
              <th className="px-3 py-2 text-center">SOPs</th>
              <th className="px-3 py-2 text-center">Completed</th>
              <th className="px-3 py-2 text-center">Remaining</th>
              <th className="px-3 py-2 text-center">Progress</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sorted.map(([empId, gRows], i) => {
              const uniqueSops = new Set(gRows.map((r) => r.sopCode.trim().toUpperCase())).size;
              const doneSops = new Set(gRows.filter((r) => r.status === 'completed').map((r) => r.sopCode.trim().toUpperCase())).size;
              const remaining = uniqueSops - doneSops;
              const pct = uniqueSops > 0 ? Math.round((doneSops / uniqueSops) * 100) : 0;
              return (
                <tr key={empId} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                  <td className="px-3 py-2 text-[10px] font-bold text-gray-500 tabular-nums">{i + 1}</td>
                  <td className="px-3 py-2 font-semibold text-gray-900 whitespace-nowrap">{gRows[0].employeeName}</td>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{gRows[0].designation || '—'}</td>
                  <td className="px-3 py-2 text-gray-600 whitespace-nowrap" title={gRows[0].department}>{shortDepartmentName(gRows[0].department)}</td>
                  <td className="px-3 py-2 text-center font-bold text-gray-900 tabular-nums">{uniqueSops}</td>
                  <td className="px-3 py-2 text-center font-bold text-emerald-700 tabular-nums">{doneSops}</td>
                  <td className="px-3 py-2 text-center font-bold text-red-600 tabular-nums">{remaining}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200">
                        <div className="h-full rounded-full bg-purple-500" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-8 text-right text-[10px] tabular-nums text-gray-500">{pct}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SopListPopup({
  title,
  subtitle,
  rows,
  showEmployee,
  groupBy,
  catalog,
  onCancel,
  busyId,
  onClose,
}: {
  title: string;
  subtitle: string;
  rows: MonthlyExamRow[];
  showEmployee: boolean;
  groupBy?: 'month' | 'sop' | 'employee';
  catalog: Record<string, McqCatalogEntry>;
  onCancel: (row: MonthlyExamRow) => void | Promise<void>;
  busyId: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3 sm:p-4" onClick={onClose}>
      <div
        className="flex max-h-[min(92vh,56rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-2xl bg-white shadow-xl xl:max-w-7xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-bold text-gray-900">{title}</h2>
            <p className="mt-0.5 text-[11px] text-gray-500">{subtitle}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {rows.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-400">No assignment rows to show.</p>
          ) : groupBy === 'sop' ? (
            <SopWiseSummaryTable rows={rows} />
          ) : groupBy === 'employee' ? (
            <EmployeeWiseSummaryTable rows={rows} />
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-200">
              <div className="max-h-[min(75vh,44rem)] overflow-auto">
                <ExamTable
                  rows={rows}
                  onCancel={onCancel}
                  busyId={busyId}
                  showEmployee={showEmployee}
                  showFullNames
                  catalog={catalog}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function DeptFilterBtn({
  value,
  onChange,
  departments,
}: {
  value: string;
  onChange: (v: string) => void;
  departments: string[];
}) {
  if (departments.length <= 1) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-purple-200 bg-white p-0.5">
      <button
        type="button"
        onClick={() => onChange('All')}
        className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition ${
          value === 'All'
            ? 'bg-purple-600 text-white shadow-sm'
            : 'text-purple-700 hover:bg-purple-50'
        }`}
      >
        All depts
      </button>
      {departments.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          className={`rounded-md px-2.5 py-1 text-[10px] font-semibold transition ${
            value === d
              ? 'bg-purple-600 text-white shadow-sm'
              : 'text-purple-700 hover:bg-purple-50'
          }`}
        >
          {d}
        </button>
      ))}
    </span>
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
  showFullNames = false,
  catalog,
}: {
  rows: MonthlyExamRow[];
  onCancel: (row: MonthlyExamRow) => void | Promise<void>;
  busyId: string;
  showEmployee?: boolean;
  /** Popup mode: never truncate names; show every available field. */
  showFullNames?: boolean;
  catalog?: Record<string, McqCatalogEntry>;
}) {
  return (
    <div className={showEmployee || showFullNames ? 'overflow-auto' : 'overflow-auto rounded-lg border border-gray-200 bg-white'}>
      <table className={`w-full text-left text-xs ${showFullNames ? 'min-w-[1400px]' : 'min-w-[1000px]'}`}>
        <thead className={`border-b border-gray-100 bg-gray-50 ${showEmployee || showFullNames ? 'sticky top-0 z-10' : ''}`}>
          <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            {showEmployee && <th className="px-3 py-2">Employee</th>}
            {showEmployee && <th className="px-3 py-2">Designation</th>}
            {showEmployee && <th className="px-3 py-2">Dept</th>}
            <th className="px-3 py-2">SOP Code</th>
            <th className="px-3 py-2">Training / SOP name</th>
            {showFullNames && <th className="px-3 py-2">Gujarati name</th>}
            <th className="px-3 py-2">Month</th>
            <th className="px-3 py-2">Assigned date</th>
            <th className="px-3 py-2">Due / exam date</th>
            <th className="px-3 py-2">Status</th>
            {showFullNames && <th className="px-3 py-2">Schedule</th>}
            <th className="px-3 py-2">Completed on</th>
            <th className="px-3 py-2">Score</th>
            <th className="px-3 py-2">Progress</th>
            <th className="px-3 py-2">Source</th>
            {showFullNames && <th className="px-3 py-2">LMS login</th>}
            {showFullNames && <th className="px-3 py-2">Roster</th>}
            <th className="px-3 py-2 w-10" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map((r) => (
            <tr key={r.key} className="hover:bg-gray-50/80">
              {showEmployee && (
                <td className="px-3 py-2 font-semibold text-gray-900 whitespace-nowrap">
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
              {showEmployee && <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{r.designation || '—'}</td>}
              {showEmployee && (
                <td
                  className="px-3 py-2 text-gray-600 whitespace-nowrap"
                  title={r.department}
                >
                  {shortDepartmentName(r.department)}
                </td>
              )}
              <td className="px-3 py-2 font-mono text-[11px] font-bold text-purple-700 whitespace-nowrap">
                {formatSopNoWithVersion(
                  catalog?.[r.sopCode.trim().toUpperCase()]?.sopIdentifier || r.sopCode,
                  catalog?.[r.sopCode.trim().toUpperCase()]?.sopVersion,
                )}
              </td>
              <td className={`px-3 py-2 text-gray-800 ${showFullNames ? 'whitespace-normal break-words min-w-[16rem]' : ''}`}>
                {showFullNames ? (
                  <p className="font-medium">{r.sopName}</p>
                ) : (
                  <p className="max-w-sm truncate text-gray-700" title={r.sopName}>{r.sopName}</p>
                )}
              </td>
              {showFullNames && (
                <td className="px-3 py-2 text-indigo-700 whitespace-normal break-words min-w-[12rem]">
                  {r.sopNameGujarati || '—'}
                </td>
              )}
              <td className="whitespace-nowrap px-3 py-2 text-gray-600">
                {MONTHS_FULL[r.month - 1]} {r.year}
                {r.carriedFromMonth ? (
                  <span
                    className="ml-1 rounded bg-amber-100 px-1 py-0.5 text-[10px] font-semibold text-amber-800"
                    title={`Originally due ${MONTHS_FULL[r.carriedFromMonth - 1]} ${r.year}`}
                  >
                    {delayedFromLabel(r.carriedFromMonth)}
                  </span>
                ) : null}
              </td>
              <td className="whitespace-nowrap px-3 py-2 text-gray-700">
                {r.assignedAt || <span className="text-gray-400">—</span>}
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
              {showFullNames && (
                <td className="px-3 py-2 whitespace-nowrap text-gray-600 capitalize">{r.scheduleStatus || '—'}</td>
              )}
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
                    Scheduled{r.scheduledBy ? ` · ${r.scheduledBy}` : ''}
                  </span>
                ) : (
                  <span className="text-[10px] text-gray-400">Matrix</span>
                )}
              </td>
              {showFullNames && (
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.hasLmsAccess ? (
                    <span className="text-[10px] font-semibold text-emerald-700">Yes</span>
                  ) : (
                    <span className="text-[10px] font-semibold text-red-600">No</span>
                  )}
                </td>
              )}
              {showFullNames && (
                <td className="px-3 py-2 whitespace-nowrap">
                  {r.onRoster ? (
                    <span className="text-[10px] font-semibold text-indigo-700">On roster</span>
                  ) : (
                    <span className="text-[10px] text-gray-400">—</span>
                  )}
                </td>
              )}
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
