'use client';

import React, {
  useState,
  useMemo,
  useEffect,
  useRef,
  useLayoutEffect,
  useCallback,
  useDeferredValue,
  useContext,
  createContext,
  memo,
  Suspense,
} from 'react';
import { Search, Download, ArrowLeft, Filter, ScrollText, Users, Tag, Wand2, Calendar, ChevronDown, ChevronUp } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import * as XLSX from 'xlsx';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { sopCodeMatchesSearch } from '@/lib/sopIdentifierNormalize';
import TrainingCalendar from '@/components/training-matrix/TrainingCalendar';

const MONTH_SHORT = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_FULL = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

const DEPT_ABBR: Record<string, string> = {
  QA: 'QA',
  QC: 'QC',
  Microbiology: 'MICR',
  Production: 'PROD',
  Store: 'STOR',
  Engineering: 'ENGI',
  Personnel: 'PERS'
};

// Compact 2-letter codes used inside MONTHS blocks
const DEPT_SHORT: Record<string, string> = {
  QA: 'QA',
  QC: 'QC',
  Microbiology: 'MI',
  Production: 'PR',
  Store: 'ST',
  Engineering: 'EN',
  Personnel: 'PE'
};

const DEPT_COLORS: Record<string, string> = {
  QA: '#6366f1',
  QC: '#92400e',
  Microbiology: '#10b981',
  Production: '#f59e0b',
  Store: '#f97316',
  Engineering: '#64748b',
  Personnel: '#ec4899',
};

function deptAbbrLabel(dept: string): string {
  if (DEPT_ABBR[dept]) return DEPT_ABBR[dept];
  const letters = dept.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 4) return letters.slice(0, 4).toUpperCase();
  if (letters.length >= 2) return letters.toUpperCase();
  return (dept.slice(0, 4) || dept).toUpperCase();
}

function deptShortLabel(dept: string): string {
  if (DEPT_SHORT[dept]) return DEPT_SHORT[dept];
  if (/engineer/i.test(dept)) return 'EN';
  if (/micro/i.test(dept)) return 'MI';
  if (/person|hr/i.test(dept)) return 'PE';
  if (/prod/i.test(dept)) return 'PR';
  if (/store/i.test(dept)) return 'ST';
  const letters = dept.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 2) return letters.slice(0, 2).toUpperCase();
  return (dept.slice(0, 2) || '??').toUpperCase();
}

function deptColor(dept: string): string {
  return DEPT_COLORS[dept] || '#7c3aed';
}

// 2-letter abbreviation for designation (Sr Executive -> SE, Officer -> OF, Chemist -> CH)
function desigAbbr(designation: string): string {
  const cleaned = designation.replace(/[^a-zA-Z ]/g, '').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '--';
  if (parts.length === 1) {
    const p = parts[0];
    if (p.length >= 2) return (p[0] + p[1]).toUpperCase();
    return p.toUpperCase();
  }
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Pattern list used by sortDesignations to rank designations by seniority.
const DESIG_ORDER_PATTERNS: RegExp[] = [
  /sr\.?\s*executive|senior\s*executive/i,
  /executive/i,
  /chemist/i,
  /sr\.?\s*officer|senior\s*officer/i,
  /officer/i,
  /operator/i,
  /worker/i,
];

function desigPriority(designation: string): number {
  for (let i = 0; i < DESIG_ORDER_PATTERNS.length; i++) {
    if (DESIG_ORDER_PATTERNS[i].test(designation)) return i;
  }
  return DESIG_ORDER_PATTERNS.length;
}

function sortDesignations(list: string[]): string[] {
  return [...list].sort((a, b) => {
    const pa = desigPriority(a);
    const pb = desigPriority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
}

function designationsOverlap(left: string, right: string): boolean {
  const tokens = (input: string): string[] => {
    const raw = String(input || '').trim();
    if (!raw) return [];
    const out = new Set<string>();
    for (const part of raw.split(/[;,/|]/).map((p) => p.trim()).filter(Boolean)) {
      const full = part.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (full) out.add(full);
      const abbr = desigAbbr(part).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (abbr) out.add(abbr);
    }
    return [...out];
  };
  const a = tokens(left);
  if (a.length === 0) return false;
  const b = new Set(tokens(right));
  return a.some((t) => b.has(t));
}

// Strip the leading "CODE-VV_" prefix (e.g. "BSGE01-05_Handling..." -> "Handling...")
// Match server manualAllocations / manualDesignations keys (stripVersion + uppercase).
function sopCacheKey(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

function cleanSopName(raw: string): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  // Match patterns like "QAGE01-10_", "BSGE01-05_", "ABC123_" etc. at the start
  const stripped = trimmed.replace(/^[A-Za-z]+\d+(?:[-.]\d+)*_+\s*/, '');
  return stripped || trimmed;
}

interface ManageSOPViewResponse {
  sops: Array<{
    sopCode: string;
    displaySopCode?: string;
    sopName: string;
    gujaratiName?: string;
    isDualLanguage?: boolean;
    primaryDepartment?: string;
    deptStats: Array<{
      department: string;
      isAssigned: boolean;
      designations: Array<{
        designation: string;
        isAssigned: boolean;
        count: number;
      }>;
      monthlyCounts: Record<number, number>;
      total: number;
      scheduledMonth?: number | null;
      isScheduled?: boolean;
    }>;
    grandTotal: number;
  }>;
  departments: string[];
  designationsByDept: Record<string, string[]>;
  employeeCountsByDeptDesig: Record<string, Record<string, number>>;
  employeesByDept?: Record<string, Array<{ name: string; designation: string; isTrainer?: boolean; assignedSopCodes?: string[] }>>;
  unassignedEmployees?: Array<{ name: string; designation: string; department: string }>;
  stats: { total: number; assigned: number; unassigned: number; unassignedEmployees?: number };
  sopCountsByDeptMonth?: Record<string, Record<number, number>>;
  sopCountsByMonth?: Record<number, number>;
  sopCountsByDept?: Record<string, number>;
  unassignedSopCodes?: string[];
  manualAllocations?: Record<string, Record<string, number[]>>;
  manualDesignations?: Record<string, Record<string, string[]>>;
  year: number | 'all';
}

const MANAGE_SOP_VIEW_LOCAL_CACHE_KEY = 'manage_sop_view_cache_v12';
const TRAINING_MATRIX_OVERVIEW_CACHE_KEY = 'training_matrix_overview_cache_v6';
const TRAINING_MATRIX_NEEDS_REFRESH_KEY = 'training_matrix_needs_refresh_v1';
const EMPLOYEE_DISPLAY_COLUMNS = 3;

function chunkIntoColumns<T>(items: T[], columnCount: number): T[][] {
  if (items.length === 0) return Array.from({ length: columnCount }, () => []);
  const perColumn = Math.ceil(items.length / columnCount);
  return Array.from({ length: columnCount }, (_, i) =>
    items.slice(i * perColumn, (i + 1) * perColumn),
  );
}

const desigKeyHelper = (dept: string, abbr: string) => `${dept}|${abbr}`;
const cellInnerKeyHelper = (dept: string, month: number) => `${dept}|${month}`;
// Employee-view ticks are per person, not per designation — names are stored as
// typed, so the key is lowercased to survive casing drift between sources.
const empOverrideKeyHelper = (dept: string, employeeName: string) =>
  `${dept}|${String(employeeName || '').trim().toLowerCase()}`;

type EmployeeSopEdit = {
  employeeName: string;
  department: string;
  designation?: string;
  sops: Array<{ sopCode: string; sopName?: string; months?: number[] }>;
};

/**
 * Turn the pending per-employee ticks into save payloads, dropping ticks that
 * already match what is stored. Shared by the Update button's pending count and
 * by the save itself so the badge can never disagree with what gets sent.
 */
function buildEmployeeSopEdits(
  employeeOverrides: Record<string, Record<string, boolean>>,
  viewData: ManageSOPViewResponse | null,
): {
  employeeSopAssignments: EmployeeSopEdit[];
  employeeSopRemovals: Array<{ employeeName: string; department: string; sops: Array<{ sopCode: string }> }>;
  employeeSopCodes: Set<string>;
} {
  const assignByKey = new Map<string, EmployeeSopEdit>();
  const removeByKey = new Map<string, EmployeeSopEdit>();
  const employeeSopCodes = new Set<string>();
  if (!viewData) {
    return { employeeSopAssignments: [], employeeSopRemovals: [], employeeSopCodes };
  }

  for (const [sopCode, inner] of Object.entries(employeeOverrides)) {
    const sop = viewData.sops.find((s) => s.sopCode === sopCode);
    if (!sop) continue;
    for (const [key, value] of Object.entries(inner || {})) {
      const sepIdx = key.indexOf('|');
      if (sepIdx < 0) continue;
      const dept = key.slice(0, sepIdx);
      const nameKey = key.slice(sepIdx + 1);
      const emp = (viewData.employeesByDept?.[dept] || []).find(
        (e) => e.name.trim().toLowerCase() === nameKey,
      );
      if (!emp) continue;
      const assigned = (emp.assignedSopCodes || []).some(
        (c) => sopCacheKey(c) === sopCacheKey(sopCode),
      );
      // Ticks that already match what is stored are not edits.
      if (value === assigned) continue;
      const target = value ? assignByKey : removeByKey;
      const bucketKey = `${dept}|${emp.name}`;
      let bucket = target.get(bucketKey);
      if (!bucket) {
        bucket = { employeeName: emp.name, department: dept, designation: emp.designation, sops: [] };
        target.set(bucketKey, bucket);
      }
      const ds = sop.deptStats.find((d) => d.department === dept);
      bucket.sops.push({
        sopCode,
        sopName: sop.sopName,
        months: ds?.scheduledMonth ? [ds.scheduledMonth] : [],
      });
      employeeSopCodes.add(sopCode);
    }
  }

  return {
    employeeSopAssignments: [...assignByKey.values()],
    employeeSopRemovals: [...removeByKey.values()].map((b) => ({
      employeeName: b.employeeName,
      department: b.department,
      sops: b.sops.map((x) => ({ sopCode: x.sopCode })),
    })),
    employeeSopCodes,
  };
}

function isValidManageSopViewResponse(parsed: unknown): parsed is ManageSOPViewResponse {
  if (!parsed || typeof parsed !== 'object') return false;
  const p = parsed as ManageSOPViewResponse;
  if (!Array.isArray(p.sops) || p.sops.length === 0) return false;
  if (!Array.isArray(p.departments) || p.departments.length === 0) return false;
  // Reject truncated / corrupt snapshots missing per-row dept stats.
  return p.sops.every(
    (s) =>
      typeof s.sopCode === 'string' &&
      s.sopCode.trim().length > 0 &&
      Array.isArray(s.deptStats) &&
      s.deptStats.length > 0,
  );
}

function readManageSopLocalCache(): ManageSOPViewResponse | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(MANAGE_SOP_VIEW_LOCAL_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidManageSopViewResponse(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

type SortKey = 'sr' | 'sopCode' | 'sopName' | 'dept' | 'designation' | 'months' | 'total';
type SortDir = 'asc' | 'desc';

// Popup scope — shared between parent and SopRow so the row's click handlers can
// describe what was clicked without the row needing to know about popup state.
type CountScope =
  | { kind: 'dept-month'; dept: string; month: number; monthName: string }
  | { kind: 'month-total'; month: number; monthName: string }
  | { kind: 'dept-total'; dept: string }
  | { kind: 'grand-total' };

// Counts API exposed to row leaves via Context. The functions read from a ref-backed
// snapshot so the API itself is reference-stable across renders — only the lightweight
// CountValue subscribers re-render when a count actually changes.
interface CountsAPI {
  cellCount: (dept: string, month: number) => number;
  deptTotal: (dept: string) => number;
  monthTotal: (month: number) => number;
  grandTotal: () => number;
  assigned: () => number;
  unassigned: () => number;
  total: () => number;
  // Bumped on any change so consumers can resubscribe; values themselves change too.
  version: number;
}

const CountsContext = createContext<CountsAPI | null>(null);

function useCounts(): CountsAPI {
  const ctx = useContext(CountsContext);
  if (!ctx) throw new Error('CountsContext missing');
  return ctx;
}

// Leaf consumers — re-render on any context change, but render only a number.
// Cheap diffs even when hundreds are mounted at once.
const CellCountText = memo(function CellCountText({ dept, month }: { dept: string; month: number }) {
  const c = useCounts();
  return <>({c.cellCount(dept, month)})</>;
});

const DeptTotalText = memo(function DeptTotalText({ dept }: { dept: string }) {
  const c = useCounts();
  return <>({c.deptTotal(dept)})</>;
});

const MonthSumText = memo(function MonthSumText({ month }: { month: number }) {
  const c = useCounts();
  return <>({c.monthTotal(month)})</>;
});

const GrandTotalText = memo(function GrandTotalText() {
  const c = useCounts();
  return <>({c.grandTotal()})</>;
});

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const idx = text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 text-yellow-900 rounded-sm px-0">{text.slice(idx, idx + query.trim().length)}</mark>
      {text.slice(idx + query.trim().length)}
    </>
  );
}

function ManageSOPDashboard() {
  useAuthGuard();
  const searchParams = useSearchParams();
  const backHref = searchParams.get('returnTo') === 'induction'
    ? '/induction-training-matrix'
    : '/training-matrix';

  // Always start with null/true so the server and client render the same initial HTML
  // (localStorage is client-only; reading it in useState initializer causes hydration mismatch).
  const [viewData, setViewData] = useState<ManageSOPViewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('sr');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  // Card filter — drives which SOPs the table shows when the user clicks a stat card.
  //   'all'                   → no extra filter (default)
  //   'assigned'              → only SOPs in the snapshot (NOT in unassignedSopCodes)
  //   'unassigned'            → only SOPs in unassignedSopCodes
  //   'unassigned-employees'  → highlight Unassigned Employees card + open that list
  const [cardFilter, setCardFilter] = useState<'all' | 'assigned' | 'unassigned' | 'unassigned-employees'>('all');
  // Table view mode — 'designation' renders the canonical 6-designation grid,
  // 'employee' replaces the inner column with the resolved employee roster per dept.
  // Checkboxes still operate on the underlying designation overrides, so toggling
  // an employee toggles their designation (and every other employee of that designation).
  const [viewMode, setViewMode] = useState<'designation' | 'employee' | 'calendar'>('designation');
  const [unassignedEmpModalOpen, setUnassignedEmpModalOpen] = useState(false);
  const [autoAssigningEmployees, setAutoAssigningEmployees] = useState(false);
  // Collapse KPI + search/actions so Calendar fits on one screen.
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  // Editing state — per-SOP slices so React.memo on rows works.
  //   overrides[sopCode]["dept|abbr"]            -> training-check checkbox
  //   inductionOverrides[sopCode]["dept|abbr"]   -> induction checkbox
  //   monthCells[sopCode]["dept|month"]          -> selected month cell
  // Other rows keep reference equality on state changes — only the touched SOP's
  // inner object reference changes.
  type PerSop = Record<string, Record<string, boolean>>;
  const EMPTY_INNER: Record<string, boolean> = useMemo(() => ({}), []);
  const EMPTY_MANUAL: Record<string, number[]> = useMemo(() => ({}), []);
  const EMPTY_MANUAL_DESIG: Record<string, string[]> = useMemo(() => ({}), []);
  const EMPTY_EMP_BY_DEPT: Record<string, Array<{ name: string; designation: string; assignedSopCodes?: string[] }>> = useMemo(() => ({}), []);
  const [overrides, setOverrides] = useState<PerSop>({});
  const [inductionOverrides, setInductionOverrides] = useState<PerSop>({});
  const [monthCells, setMonthCells] = useState<PerSop>({});
  // employeeOverrides[sopCode]["dept|employee name"] -> per-person training tick.
  // The employee view needs its own buffer: writing employee ticks into
  // `overrides` toggled every colleague sharing that designation.
  const [employeeOverrides, setEmployeeOverrides] = useState<PerSop>({});
  // Save completion is tied to the database write; the expensive view rebuild
  // runs afterward. Ignore stale rebuilds when another save starts meanwhile.
  const postSaveRefreshIdRef = useRef(0);

  // Applied (committed) snapshots — used to derive displayed counts/totals
  const [appliedOverrides, setAppliedOverrides] = useState<PerSop>({});
  const [appliedMonthCells, setAppliedMonthCells] = useState<PerSop>({});

  // Popup state — clicking a count opens this. Items are SOP-level rows with
  // optional per-row metadata (scheduled month, designations, training events).
  interface PopupItem {
    sopCode: string;
    sopName: string;
    count: number;
    scheduledMonthName?: string;
    designations?: string[];
    trainingEvents?: number;
  }
  const [popup, setPopup] = useState<{
    title: string;
    subtitle: string;
    dept: string;
    items: PopupItem[];
  } | null>(null);

  // Keys use the FULL designation name (e.g. "QA|Sr Executive") so they are
  // collision-free across all departments without needing abbreviation lookup.
  const desigKey = (dept: string, fullName: string) => `${dept}|${fullName}`;
  const cellInnerKey = (dept: string, month: number) => `${dept}|${month}`;

  // Stable refs so useCallback handlers always read the latest designation lists
  // without becoming stale.
  //   designationsByDeptRef  — per-dept lists fetched from employee data
  //   allDesignationsRef     — sorted UNION of every designation across all depts;
  //                            used by "Toggle all" and the month-active check so
  //                            cross-dept designations can be assigned to any SOP.
  const designationsByDeptRef = useRef<Record<string, string[]>>({});
  const allDesignationsRef = useRef<string[]>([]);
  useEffect(() => {
    const byDept = viewData?.designationsByDept ?? {};
    designationsByDeptRef.current = byDept;
    allDesignationsRef.current = sortDesignations([
      ...new Set(Object.values(byDept).flat()),
    ]);
  }, [viewData]);

  const setDesigChecked = useCallback((sopCode: string, dept: string, fullName: string, value: boolean) => {
    setOverrides(prev => {
      const inner = prev[sopCode] || {};
      return { ...prev, [sopCode]: { ...inner, [desigKey(dept, fullName)]: value } };
    });
  }, []);

  const setEmployeeChecked = useCallback(
    (sopCode: string, dept: string, employeeName: string, value: boolean) => {
      setEmployeeOverrides(prev => {
        const inner = prev[sopCode] || {};
        return {
          ...prev,
          [sopCode]: { ...inner, [empOverrideKeyHelper(dept, employeeName)]: value },
        };
      });
    },
    [],
  );

  const setInductionChecked = useCallback((sopCode: string, dept: string, fullName: string, value: boolean) => {
    setInductionOverrides(prev => {
      const inner = prev[sopCode] || {};
      return { ...prev, [sopCode]: { ...inner, [desigKey(dept, fullName)]: value } };
    });
  }, []);

  // "Toggle all" covers the global union so the user can batch-assign every
  // designation (including cross-dept ones) to this (sop, dept) in one click.
  const setDeptChecked = useCallback((sopCode: string, dept: string, value: boolean) => {
    const allDesigs = allDesignationsRef.current;
    setOverrides(prev => {
      const inner = { ...(prev[sopCode] || {}) };
      for (const fullName of allDesigs) inner[desigKey(dept, fullName)] = value;
      return { ...prev, [sopCode]: inner };
    });
  }, []);

  const setDeptInductionChecked = useCallback((sopCode: string, dept: string, value: boolean) => {
    const allDesigs = allDesignationsRef.current;
    setInductionOverrides(prev => {
      const inner = { ...(prev[sopCode] || {}) };
      for (const fullName of allDesigs) inner[desigKey(dept, fullName)] = value;
      return { ...prev, [sopCode]: inner };
    });
  }, []);

  // Explicit-value setter: the caller passes the new value. We always store it so
  // unchecking a backend-persisted cell (where there'd be no prior local key) still
  // produces a falsy override, instead of being a no-op.
  const toggleMonthCell = useCallback((sopCode: string, dept: string, month: number, value: boolean) => {
    setMonthCells(prev => {
      const inner = { ...(prev[sopCode] || {}) };
      inner[cellInnerKey(dept, month)] = value;
      return { ...prev, [sopCode]: inner };
    });
  }, []);

  const [applying, setApplying] = useState(false);
  const [autoAssigning, setAutoAssigning] = useState(false);
  const [applyMsg, setApplyMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Audit-log modal — lists every (sop, dept, month, year) the user has allocated
  // via this page. Populated lazily when the user opens the panel.
  interface LogEntry {
    sopCode: string;
    sopName: string;
    department: string;
    month: number;
    monthName: string;
    year: number;
    designations: string[];
    employees: string[];
    employeeCount: number;
    createdAt: string;
    updatedAt: string;
  }
  const [logsOpen, setLogsOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const [logs, setLogs] = useState<LogEntry[] | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState('');
  const [logSearch, setLogSearch] = useState('');

  // Employee-detail modal — same data shape the main training-matrix page renders.
  // The overview payload is fetched lazily on first open and cached so subsequent
  // employee clicks reuse it.
  interface EmpSopRow {
    sopCode: string;
    sopName: string;
    month: string;
    symbol: '√' | 'X';
    targetDate: string | null;
    expired: boolean;
    totalMcq: number;
    approvedMcq: number;
  }
  type EmpFilter = 'all' | 'due' | 'assigned';
  const [overviewCache, setOverviewCache] = useState<any | null>(null);
  const [empModal, setEmpModal] = useState<{
    name: string;
    dept: string;
    designation: string;
    sops: EmpSopRow[];
    loading: boolean;
    error: string;
  } | null>(null);
  const [empModalSearch, setEmpModalSearch] = useState('');
  const [empModalFilter, setEmpModalFilter] = useState<EmpFilter>('all');
  const [addEmpModal, setAddEmpModal] = useState<{
    sopCode: string;
    sopName: string;
    dept: string;
  } | null>(null);
  const [addEmpSearch, setAddEmpSearch] = useState('');
  const [addEmpSelected, setAddEmpSelected] = useState<Record<string, boolean>>({});
  const [assignEmp, setAssignEmp] = useState<{
    name: string;
    designation: string;
    department: string;
  } | null>(null);
  const [assignEmpSearch, setAssignEmpSearch] = useState('');
  const [assignEmpSelected, setAssignEmpSelected] = useState<Record<string, boolean>>({});
  const [assignEmpSaving, setAssignEmpSaving] = useState(false);

  const stripCodeVersion = useCallback((code: string) => code.split('-').shift() || code, []);

  const openEmployeeModal = useCallback(async (name: string, dept: string, designation: string) => {
    setEmpModalSearch('');
    setEmpModalFilter('all');
    setEmpModal({ name, dept, designation, sops: [], loading: true, error: '' });
    try {
      let overview = overviewCache;
      if (!overview) {
        const res = await fetch('/api/training-matrix/overview', { cache: 'no-store' });
        if (!res.ok) throw new Error('Failed to load overview');
        overview = await res.json();
        setOverviewCache(overview);
      }
      const monthMap: Record<string, string> = overview?.sopMonthMapByDept?.[dept] || {};
      const sopStatusByCode: Record<string, any> = overview?.sopStatusByCode || {};
      const sops: EmpSopRow[] = [];
      const seen = new Set<string>();

      const pushRow = (code: string, sopName: string, month: string, assigned: boolean) => {
        const key = (code.split('-')[0] || code).toUpperCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        const status = sopStatusByCode[code] || sopStatusByCode[key] || {};
        sops.push({
          sopCode: code,
          sopName: status.title || sopName || code,
          month: month || monthMap[code] || monthMap[key] || '',
          symbol: assigned ? '√' : 'X',
          targetDate: status.targetDate || null,
          expired: !!status.expired,
          totalMcq: status.totalQuestions || 0,
          approvedMcq: status.approvedCount || 0,
        });
      };

      const roster = viewData?.employeesByDept?.[dept] || [];
      const rosterEmp = roster.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase());
      for (const code of rosterEmp?.assignedSopCodes || []) {
        const sop = viewData?.sops.find((s) => sopCacheKey(s.sopCode) === sopCacheKey(code));
        const deptStat = sop?.deptStats.find((d) => d.department === dept);
        const monthNum = deptStat?.scheduledMonth || 0;
        pushRow(
          sop?.displaySopCode || sop?.sopCode || code,
          sop?.sopName || code,
          monthNum ? MONTH_FULL[monthNum - 1] : '',
          true,
        );
      }

      for (const sop of viewData?.sops || []) {
        const deptStat = sop.deptStats.find((d) => d.department === dept);
        const manualDesigList = viewData?.manualDesignations?.[sopCacheKey(sop.sopCode)]?.[dept] || [];
        const sopOverrides = overrides[sop.sopCode] || {};
        const key = `${dept}|${designation}`;
        const fallback =
          (deptStat?.designations || []).some(
            (d) => designationsOverlap(d.designation, designation) && (d.isAssigned || (d.count || 0) > 0),
          ) || manualDesigList.some((d) => designationsOverlap(d, designation));
        const checked = Object.keys(sopOverrides).some(
          (k) => k.startsWith(`${dept}|`) && sopOverrides[k] && designationsOverlap(k.slice(dept.length + 1), designation),
        )
          ? true
          : key in sopOverrides
            ? !!sopOverrides[key]
            : fallback;
        if (!checked) continue;
        const monthNum = deptStat?.scheduledMonth || 0;
        pushRow(
          sop.displaySopCode || sop.sopCode,
          sop.sopName,
          monthNum ? MONTH_FULL[monthNum - 1] : '',
          true,
        );
      }

      const empRow = overview?.perDept?.[dept]?.employees?.find(
        (e: any) => String(e.name || '').trim().toLowerCase() === name.trim().toLowerCase(),
      );
      if (empRow) {
        for (const [code, v] of Object.entries(empRow.training || {})) {
          const status = sopStatusByCode[code] || sopStatusByCode[stripCodeVersion(code)] || {};
          pushRow(code, status.title || code, monthMap[code] || monthMap[stripCodeVersion(code)] || '', !!v);
        }
      }

      sops.sort((a, b) => a.sopCode.localeCompare(b.sopCode));
      setEmpModal(prev => (prev ? { ...prev, sops, loading: false } : null));
    } catch (err) {
      setEmpModal(prev =>
        prev ? { ...prev, loading: false, error: err instanceof Error ? err.message : 'Failed to load' } : null
      );
    }
  }, [overviewCache, stripCodeVersion, viewData, overrides]);

  const openAddEmployeeModal = useCallback((sopCode: string, sopName: string, dept: string) => {
    setAddEmpModal({ sopCode, sopName, dept });
    setAddEmpSearch('');
    setAddEmpSelected({});
  }, []);

  const addEmpCandidates = useMemo(() => {
    if (!addEmpModal || !viewData) return [];
    const q = addEmpSearch.trim().toLowerCase();
    const list = viewData.employeesByDept?.[addEmpModal.dept] || [];
    return list.filter((emp) => {
      if (!q) return true;
      return (
        String(emp.name || '').toLowerCase().includes(q) ||
        String(emp.designation || '').toLowerCase().includes(q)
      );
    });
  }, [addEmpModal, addEmpSearch, viewData]);

  const applyAddEmployees = useCallback(() => {
    if (!addEmpModal || !viewData) return;
    const selected = addEmpCandidates.filter((emp, idx) => {
      const key = `${emp.name}__${emp.designation}__${idx}`;
      return !!addEmpSelected[key];
    });
    if (selected.length === 0) {
      setAddEmpModal(null);
      return;
    }

    for (const emp of selected) {
      setEmployeeChecked(addEmpModal.sopCode, addEmpModal.dept, emp.name, true);
    }

    const sop = viewData.sops.find((s) => s.sopCode === addEmpModal.sopCode);
    const deptStat = sop?.deptStats.find((d) => d.department === addEmpModal.dept);
    const manualMonths =
      viewData.manualAllocations?.[sopCacheKey(addEmpModal.sopCode)]?.[addEmpModal.dept] || [];
    const sopMonth = monthCells[addEmpModal.sopCode] || EMPTY_INNER;
    let hasSelectedMonth = false;
    for (let m = 1; m <= 12; m++) {
      const key = cellInnerKey(addEmpModal.dept, m);
      const persisted = manualMonths.includes(m) || deptStat?.scheduledMonth === m;
      const selected = key in sopMonth ? !!sopMonth[key] : persisted;
      if (selected) {
        hasSelectedMonth = true;
        break;
      }
    }
    if (!hasSelectedMonth) {
      const fallbackMonth = deptStat?.scheduledMonth || (new Date().getMonth() + 1);
      toggleMonthCell(addEmpModal.sopCode, addEmpModal.dept, fallbackMonth, true);
    }

    setAddEmpModal(null);
  }, [addEmpModal, addEmpCandidates, addEmpSelected, viewData, monthCells, EMPTY_INNER, setEmployeeChecked, toggleMonthCell]);

  const empModalDerived = useMemo(() => {
    if (!empModal) return null;
    const all = empModal.sops;
    const totalAssigned = all.filter(r => r.symbol === '√').length;
    const totalDue = all.length - totalAssigned;
    const examCoveragePct = all.length > 0 ? Math.round((totalAssigned / all.length) * 100) : 0;
    const q = empModalSearch.trim().toLowerCase();
    let rows = all.filter(r => {
      if (empModalFilter === 'due' && r.symbol === '√') return false;
      if (empModalFilter === 'assigned' && r.symbol !== '√') return false;
      if (q) {
        return (
          r.sopCode.toLowerCase().includes(q) ||
          r.sopName.toLowerCase().includes(q) ||
          (r.month || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
    if (empModalFilter === 'all' && !q) {
      rows = [...rows.filter(r => r.symbol !== '√'), ...rows.filter(r => r.symbol === '√')];
    }
    return { rows, totalAssigned, totalDue, examCoveragePct, allCount: all.length };
  }, [empModal, empModalSearch, empModalFilter]);

  const openLogs = useCallback(async () => {
    setLogsOpen(true);
    setLogsLoading(true);
    setLogsError('');
    try {
      const res = await fetch('/api/training-matrix/manage-sop-view/logs', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to fetch logs');
      const data = await res.json();
      setLogs(Array.isArray(data?.logs) ? data.logs : []);
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : 'Failed to load logs');
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const filteredLogs = useMemo(() => {
    if (!logs) return [];
    const q = logSearch.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter(l =>
      l.sopCode.toLowerCase().includes(q) ||
      l.sopName.toLowerCase().includes(q) ||
      l.department.toLowerCase().includes(q) ||
      l.monthName.toLowerCase().includes(q) ||
      l.designations.some(d => d.toLowerCase().includes(q))
    );
  }, [logs, logSearch]);

  // Build the persistence payload:
  //   - `entries`: selected month cells + checked designations to upsert.
  //   - `removals`: unchecked month cells (or unchecked designations) to delete from
  //     manual allocations.
  // This ensures unchecking is persisted instead of being treated as "nothing to save".
  const applyChanges = async (
    monthCellsArg: PerSop = monthCells,
    overridesArg: PerSop = overrides,
  ) => {
    if (!viewData) return;
    setApplyMsg(null);

    const designationsByDept = viewData.designationsByDept || {};
    const manualDesignations = viewData.manualDesignations || {};
    const manualAllocations = viewData.manualAllocations || {};
    const departments = viewData.departments || [];
    const allDesignations = sortDesignations([
      ...new Set(Object.values(designationsByDept).flat()),
    ]);
    const currentYear = new Date().getFullYear();
    const grouped = new Map<
      string,
      { sopCode: string; sopName: string; department: string; designations: Set<string>; months: Set<number> }
    >();
    const removals: Array<{
      sopCode: string;
      sopName: string;
      department: string;
      designations?: string[];
      months: number[];
      removeAllDesignations?: boolean;
      year: number;
    }> = [];

    const sopCodesToProcess = new Set<string>();
    for (const k of Object.keys(overridesArg)) {
      if (JSON.stringify(overridesArg[k] || {}) !== JSON.stringify(appliedOverrides[k] || {})) {
        sopCodesToProcess.add(k);
      }
    }
    for (const k of Object.keys(monthCellsArg)) {
      if (JSON.stringify(monthCellsArg[k] || {}) !== JSON.stringify(appliedMonthCells[k] || {})) {
        sopCodesToProcess.add(k);
      }
    }

    // Per-employee ticks travel on their own channel: the designation payload
    // below cannot express "this one person only" without moving colleagues.
    const { employeeSopAssignments, employeeSopRemovals, employeeSopCodes } =
      buildEmployeeSopEdits(employeeOverrides, viewData);
    const hasEmployeeEdits =
      employeeSopAssignments.length > 0 || employeeSopRemovals.length > 0;

    if (sopCodesToProcess.size === 0 && !hasEmployeeEdits) {
      setApplyMsg({ kind: 'ok', text: 'No changes to apply.' });
      return;
    }

    const resolveCheckedDesignations = (
      dept: string,
      sopOverrides: Record<string, boolean>,
      deptStat: ManageSOPViewResponse['sops'][0]['deptStats'][0] | undefined,
      manualDesigList: string[],
    ): string[] =>
      allDesignations.filter((fullName) => {
        const key = desigKey(dept, fullName);
        if (key in sopOverrides) return !!sopOverrides[key];
        return (
          (deptStat?.designations || []).some(
            (d) => d.designation === fullName && (d.isAssigned || (d.count || 0) > 0),
          ) || manualDesigList.includes(fullName)
        );
      });

    const resolveMonthSelected = (
      dept: string,
      month: number,
      sopMonthCells: Record<string, boolean>,
      manualMonths: number[],
      scheduledMonth?: number | null,
    ): boolean => {
      const key = cellInnerKey(dept, month);
      const persisted = manualMonths.includes(month) || scheduledMonth === month;
      return key in sopMonthCells ? !!sopMonthCells[key] : persisted;
    };

  // Walk every edited SOP × dept × month using the same effective state the grid shows.
    // Previously we only iterated explicit monthCells edits, so designation-only
    // changes against persisted schedule/month cells produced "0 updates".
    for (const sop of viewData.sops) {
      if (!sopCodesToProcess.has(sop.sopCode)) continue;
      const sopCode = sop.sopCode;
      const sopOverrides = overridesArg[sopCode] || {};
      const sopMonthCells = monthCellsArg[sopCode] || {};
      const manualMonthsByDept = manualAllocations[sopCacheKey(sopCode)] || {};
      const manualDesigsByDept = manualDesignations[sopCacheKey(sopCode)] || {};

      for (const dept of departments) {
        const deptStat = sop.deptStats.find((s) => s.department === dept);
        const manualMonths = manualMonthsByDept[dept] || [];
        const manualDesigList = manualDesigsByDept[dept] || [];
        const realDesigs = resolveCheckedDesignations(dept, sopOverrides, deptStat, manualDesigList);
        const hasDesigOverride = Object.keys(sopOverrides).some((k) => k.startsWith(`${dept}|`));

        let monthsToProcess = Array.from({ length: 12 }, (_, i) => {
          const month = i + 1;
          return {
            month,
            on: resolveMonthSelected(dept, month, sopMonthCells, manualMonths, deptStat?.scheduledMonth),
          };
        });

        if (!monthsToProcess.some((m) => m.on) && realDesigs.length > 0 && hasDesigOverride) {
          const fallback = deptStat?.scheduledMonth || manualMonths[0] || (new Date().getMonth() + 1);
          monthsToProcess = monthsToProcess.map((m) =>
            m.month === fallback ? { ...m, on: true } : m,
          );
        }

        for (const { month, on } of monthsToProcess) {
          if (!on) {
            if (manualMonths.includes(month) || sopMonthCells[cellInnerKey(dept, month)] === false) {
              removals.push({
                sopCode,
                sopName: sop.sopName,
                department: dept,
                months: [month],
                removeAllDesignations: true,
                year: currentYear,
              });
            }
            continue;
          }

          if (realDesigs.length === 0) {
            removals.push({
              sopCode,
              sopName: sop.sopName,
              department: dept,
              months: [month],
              removeAllDesignations: true,
              year: currentYear,
            });
            continue;
          }

          const groupKey = `${sopCode}|${dept}`;
          let entry = grouped.get(groupKey);
          if (!entry) {
            entry = {
              sopCode,
              sopName: sop.sopName,
              department: dept,
              designations: new Set<string>(),
              months: new Set<number>(),
            };
            grouped.set(groupKey, entry);
          }
          realDesigs.forEach((d) => entry!.designations.add(d));
          entry.months.add(month);

          const realSet = new Set(realDesigs);
          const deselectedDesigs = allDesignations.filter((d) => !realSet.has(d));
          if (deselectedDesigs.length > 0) {
            removals.push({
              sopCode,
              sopName: sop.sopName,
              department: dept,
              designations: deselectedDesigs,
              months: [month],
              removeAllDesignations: false,
              year: currentYear,
            });
          }
        }
      }
    }

    const entries = Array.from(grouped.values()).map(g => ({
      sopCode: g.sopCode,
      sopName: g.sopName,
      department: g.department,
      designations: Array.from(g.designations),
      months: Array.from(g.months).sort((a, b) => a - b),
      year: currentYear,
    }));

    if (entries.length === 0 && removals.length === 0 && !hasEmployeeEdits) {
      setAppliedOverrides({ ...overridesArg });
      setAppliedMonthCells({ ...monthCellsArg });
      setApplyMsg({ kind: 'ok', text: 'No changes to apply.' });
      return;
    }

    try {
      setApplying(true);
      const res = await fetch('/api/training-matrix/manage-sop-view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entries,
          removals,
          ...(employeeSopAssignments.length > 0 ? { employeeSopAssignments } : {}),
          ...(employeeSopRemovals.length > 0 ? { employeeSopRemovals } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Apply failed');

      const warnings: string[] = Array.isArray(data?.warnings) ? data.warnings : [];
      setApplyMsg({
        kind: warnings.length > 0 ? 'err' : 'ok',
        text:
          `Updated training records: ${data.inserted || 0} added${data.updated ? `, ${data.updated} updated` : ''}${data.removed ? `, ${data.removed} removed` : ''}${data.unchanged ? `; ${data.unchanged} already existed` : ''}${data.inserted === 0 && !data.updated && !data.removed && !data.unchanged ? ' — no matching employees or records found' : ''}.` +
          // Surface the per-entry warnings (e.g. ticked a designation with no employees in
          // that department) so a partial/no-op save isn't a silent revert of the ticks.
          (warnings.length > 0
            ? ` Some selections were not saved: ${warnings.join('; ')}`
            : ''),
      });

      // Bust client + matrix overview caches so reload and navigation see fresh data.
      try {
        if (typeof window !== 'undefined') {
          localStorage.removeItem(MANAGE_SOP_VIEW_LOCAL_CACHE_KEY);
          localStorage.removeItem(TRAINING_MATRIX_OVERVIEW_CACHE_KEY);
          localStorage.removeItem('induction_training_matrix_overview_cache_v5');
          localStorage.setItem(TRAINING_MATRIX_NEEDS_REFRESH_KEY, String(Date.now()));
          // Drop LMS session caches so trainer / All Exams refetch assignment maps.
          sessionStorage.removeItem('lms-portal-cache-v8');
        }
      } catch { /* storage unavailable — non-fatal */ }

      // Commit the just-saved edits as the new baseline immediately. This keeps the
      // ticks/counts the user set on screen even if the rebuild below is slow or fails —
      // the local override buffers (overrides/monthCells) still drive the checkboxes,
      // and appliedOverrides/appliedMonthCells keep the live counts in sync.
      setAppliedOverrides({ ...overridesArg });
      setAppliedMonthCells({ ...monthCellsArg });

      // Rebuild from DB (await) — do not rely on optimistic patches that can drift.
      // The write is complete. Let the user continue immediately while the
      // expensive derived-view rebuild runs in the background.
      setApplying(false);
      const refreshId = ++postSaveRefreshIdRef.current;
      setRefreshing(true);
      void (async () => {
        let fresh: ManageSOPViewResponse | null = null;
        try {
          const freshRes = await fetch('/api/training-matrix/manage-sop-view?year=all&refresh=1', {
            cache: 'no-store',
          });
          fresh = freshRes.ok ? await freshRes.json() : null;
        } catch {
          fresh = null;
        }

        if (refreshId !== postSaveRefreshIdRef.current) return;

        if (fresh && isValidManageSopViewResponse(fresh)) {
          setViewData(fresh);
          try {
            if (typeof window !== 'undefined') {
              localStorage.setItem(MANAGE_SOP_VIEW_LOCAL_CACHE_KEY, JSON.stringify(fresh));
            }
          } catch { /* non-fatal */ }

        // Prime the training-matrix overview cache so assigned-SOP counts match
        // manage-sops when the user navigates back to the main matrix page.
        // No ?refresh=1: the manage-sop-view rebuild above already recomputed the
        // overview server-side, so this reads that warm result instead of paying
        // for a third full recompute.
        try {
          const overviewRes = await fetch('/api/training-matrix/overview', {
            cache: 'no-store',
          });
          if (overviewRes.ok && typeof window !== 'undefined') {
            const overview = await overviewRes.json();
            if (overview?.success) {
              localStorage.setItem(
                TRAINING_MATRIX_OVERVIEW_CACHE_KEY,
                JSON.stringify({ payload: overview, cachedAt: Date.now() }),
              );
              localStorage.removeItem(TRAINING_MATRIX_NEEDS_REFRESH_KEY);
            }
          }
        } catch { /* non-fatal */ }

        // Server truth now includes these edits — drop the local edit buffers so the
        // checkboxes read straight from the refreshed snapshot. Only safe to clear AFTER
        // fresh data has been applied; otherwise the grid would revert to the pre-save
        // view and the just-made ticks would disappear.
        const savedOverrides = Object.fromEntries(
          [...sopCodesToProcess].map((code) => [code, overridesArg[code] || {}]),
        ) as PerSop;
        const savedMonthCells = Object.fromEntries(
          [...sopCodesToProcess].map((code) => [code, monthCellsArg[code] || {}]),
        ) as PerSop;
        const savedEmployeeOverrides = Object.fromEntries(
          [...employeeSopCodes].map((code) => [code, employeeOverrides[code] || {}]),
        ) as PerSop;
        const clearSopLocalState = (prev: PerSop, saved: PerSop) => {
          const next = { ...prev };
          for (const [code, savedInner] of Object.entries(saved)) {
            // A newer click replaces the SOP's inner object. Never clear it
            // when this older background refresh completes.
            if (prev[code] === savedInner) delete next[code];
          }
          return next;
        };
        setOverrides((prev) => clearSopLocalState(prev, savedOverrides));
        setMonthCells((prev) => clearSopLocalState(prev, savedMonthCells));
        setEmployeeOverrides((prev) => clearSopLocalState(prev, savedEmployeeOverrides));
        setAppliedOverrides((prev) => clearSopLocalState(prev, savedOverrides));
        setAppliedMonthCells((prev) => clearSopLocalState(prev, savedMonthCells));
      } else {
        // Rebuild failed/aborted: keep the local edit buffers so the ticks the user just
        // saved stay visible. The next page load reads the persisted records from the DB.
        setApplyMsg((prev) => ({
          kind: 'ok',
          text: `${prev?.text ? prev.text + ' ' : ''}(Saved — the view will fully refresh on next reload.)`,
        }));
      }
      })().finally(() => {
        if (refreshId === postSaveRefreshIdRef.current) setRefreshing(false);
      });
    } catch (err) {
      setApplyMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to apply changes',
      });
    } finally {
      setApplying(false);
    }
  };

  // ─── Auto-Assign ──────────────────────────────────────────────────────────────
  // Spread every currently-unassigned SOP across the calendar year. The allocator is
  // a greedy least-loaded-month pass:
  //   • monthLoad is seeded from the existing per-month SOP counts, so already-scheduled
  //     SOPs are respected and the spread balances on top of them.
  //   • Each SOP is placed in the lightest month, breaking ties toward its department's
  //     existing timeframe so SOPs of the same department cluster together.
  // Only unassigned SOPs are touched; existing assignments are never modified. The
  // computed selection is fed through the same persistence path as a manual Update.
  const AUTO_ASSIGN_AFFINITY_WEIGHT = 0.5;
  const autoAssign = async () => {
    if (!viewData || autoAssigning || applying) return;
    setApplyMsg(null);

    const designationsByDept = viewData.designationsByDept || {};
    const deptHasDesigs = (d: string) => (designationsByDept[d]?.length || 0) > 0;

    // Resolve each unassigned SOP to a target department that actually has employees
    // (designations). Without a resolvable department we can't create training records,
    // so such SOPs are reported as skipped rather than mis-assigned.
    type Plan = { sopCode: string; sopName: string; dept: string; designations: string[] };
    const plans: Plan[] = [];
    let skipped = 0;
    for (const sop of viewData.sops) {
      if (!unassignedSet.has(sop.sopCode.toUpperCase())) continue;
      // Defensive: never touch an SOP that is already scheduled somewhere.
      if (sop.deptStats.some((ds) => ds.scheduledMonth)) continue;

      let dept =
        sop.primaryDepartment && deptHasDesigs(sop.primaryDepartment)
          ? sop.primaryDepartment
          : '';
      if (!dept) {
        let best = '';
        let bestScore = -1;
        for (const ds of sop.deptStats) {
          if (!deptHasDesigs(ds.department)) continue;
          const score = ds.designations.filter((d) => d.isAssigned || (d.count || 0) > 0).length;
          if (score > bestScore) {
            bestScore = score;
            best = ds.department;
          }
        }
        dept = best;
      }
      if (!dept) {
        skipped += 1;
        continue;
      }
      plans.push({
        sopCode: sop.sopCode,
        sopName: sop.sopName,
        dept,
        designations: sortDesignations(designationsByDept[dept] || []),
      });
    }

    if (plans.length === 0) {
      setApplyMsg({
        kind: 'ok',
        text: skipped > 0
          ? `No assignable SOPs — ${skipped} unassigned SOP(s) have no department with employees.`
          : 'No unassigned SOPs to assign.',
      });
      return;
    }

    const ok = typeof window === 'undefined'
      ? true
      : window.confirm(
          `Auto-assign ${plans.length} unassigned SOP(s) across the year?\n\n` +
          `Each is scheduled into the least-busy month for its department and saved into ` +
          `the training matrix. Existing assignments are not changed.` +
          (skipped > 0 ? `\n\n${skipped} SOP(s) will be skipped (no department with employees).` : ''),
        );
    if (!ok) return;

    // monthLoad[1..12] — existing global SOP count per month, grown as we place SOPs.
    const monthLoad: number[] = Array.from({ length: 13 }, (_, m) =>
      m === 0 ? 0 : viewData.sopCountsByMonth?.[m] || 0,
    );

    // Group by department and process in the canonical department order so each
    // department is laid down as one timeframe-clustered block.
    const byDept = new Map<string, Plan[]>();
    for (const p of plans) {
      const list = byDept.get(p.dept);
      if (list) list.push(p);
      else byDept.set(p.dept, [p]);
    }

    const chosenMonth = new Map<Plan, number>();
    for (const dept of viewData.departments || []) {
      const group = byDept.get(dept);
      if (!group) continue;
      group.sort((a, b) => a.sopCode.localeCompare(b.sopCode));

      // Seed the affinity centre from the department's EXISTING assignments so new
      // SOPs cluster near where the department already trains.
      const existing = viewData.sopCountsByDeptMonth?.[dept] || {};
      let sumMonth = 0;
      let cnt = 0;
      for (let m = 1; m <= 12; m++) {
        const c = existing[m] || 0;
        sumMonth += m * c;
        cnt += c;
      }

      for (const p of group) {
        const center = cnt > 0 ? sumMonth / cnt : null;
        let best = 1;
        let bestScore = Infinity;
        for (let m = 1; m <= 12; m++) {
          const affinity = center === null ? 0 : Math.abs(m - center);
          const score = monthLoad[m] + affinity * AUTO_ASSIGN_AFFINITY_WEIGHT;
          if (score < bestScore - 1e-9) {
            bestScore = score;
            best = m;
          }
        }
        chosenMonth.set(p, best);
        monthLoad[best] += 1;
        sumMonth += best;
        cnt += 1;
      }
    }

    // Translate the plan into the same month-cell + designation selections the manual
    // editor produces, then drive it through applyChanges with an explicit payload
    // (state updates are async, so we can't rely on monthCells/overrides being set yet).
    const newMonthCells: PerSop = { ...monthCells };
    const newOverrides: PerSop = { ...overrides };
    for (const [p, month] of chosenMonth) {
      newMonthCells[p.sopCode] = {
        ...(newMonthCells[p.sopCode] || {}),
        [cellInnerKey(p.dept, month)]: true,
      };
      const inner = { ...(newOverrides[p.sopCode] || {}) };
      for (const d of p.designations) inner[desigKey(p.dept, d)] = true;
      newOverrides[p.sopCode] = inner;
    }

    setAutoAssigning(true);
    try {
      setMonthCells(newMonthCells);
      setOverrides(newOverrides);
      await applyChanges(newMonthCells, newOverrides);
    } finally {
      setAutoAssigning(false);
    }
  };

  // ─── Auto-Assign Employees ────────────────────────────────────────────────────
  // For every employee with no SOP assignments, tick their designation onto every
  // SOP already scheduled in their department (existing months preserved), then
  // persist through the same apply path as a manual Update.
  const autoAssignEmployees = async () => {
    if (!viewData || autoAssigningEmployees || autoAssigning || applying) return;
    setApplyMsg(null);

    const unassigned = viewData.unassignedEmployees || [];
    if (unassigned.length === 0) {
      setApplyMsg({ kind: 'ok', text: 'No unassigned employees to assign.' });
      return;
    }

    const ok = typeof window === 'undefined'
      ? true
      : window.confirm(
          `Auto-assign ${unassigned.length} unassigned employee(s) to SOPs already scheduled in their department?\n\n` +
          `Each employee's designation is ticked on those SOPs and saved into the training matrix. ` +
          `Existing SOP schedules are not changed.`,
        );
    if (!ok) return;

    const newMonthCells: PerSop = { ...monthCells };
    const newOverrides: PerSop = { ...overrides };
    let planned = 0;
    let skipped = 0;

    for (const emp of unassigned) {
      const dept = emp.department;
      const desig = String(emp.designation || '').trim();
      if (!dept || !desig) {
        skipped += 1;
        continue;
      }

      let touched = false;
      for (const sop of viewData.sops) {
        const deptStat = sop.deptStats.find((ds) => ds.department === dept);
        const manualMonths =
          viewData.manualAllocations?.[sopCacheKey(sop.sopCode)]?.[dept] || [];
        const months: number[] = [];
        if (deptStat?.scheduledMonth) months.push(deptStat.scheduledMonth);
        for (const m of manualMonths) {
          if (!months.includes(m)) months.push(m);
        }
        if (months.length === 0) continue;

        const monthInner = { ...(newMonthCells[sop.sopCode] || {}) };
        for (const m of months) monthInner[cellInnerKey(dept, m)] = true;
        newMonthCells[sop.sopCode] = monthInner;

        const desigInner = { ...(newOverrides[sop.sopCode] || {}) };
        desigInner[desigKey(dept, desig)] = true;
        newOverrides[sop.sopCode] = desigInner;
        touched = true;
      }

      if (touched) planned += 1;
      else skipped += 1;
    }

    if (planned === 0) {
      setApplyMsg({
        kind: 'ok',
        text: skipped > 0
          ? `No assignable employees — ${skipped} have no scheduled SOPs in their department.`
          : 'No unassigned employees to assign.',
      });
      return;
    }

    setAutoAssigningEmployees(true);
    try {
      setMonthCells(newMonthCells);
      setOverrides(newOverrides);
      await applyChanges(newMonthCells, newOverrides);
      setUnassignedEmpModalOpen(false);
    } finally {
      setAutoAssigningEmployees(false);
    }
  };

  const reloadManageSopView = useCallback(async () => {
    try {
      if (typeof window !== 'undefined') {
        localStorage.removeItem(MANAGE_SOP_VIEW_LOCAL_CACHE_KEY);
        localStorage.removeItem(TRAINING_MATRIX_OVERVIEW_CACHE_KEY);
        localStorage.setItem(TRAINING_MATRIX_NEEDS_REFRESH_KEY, String(Date.now()));
        sessionStorage.removeItem('lms-portal-cache-v8');
      }
    } catch { /* storage unavailable */ }
    setOverviewCache(null);
    const freshRes = await fetch('/api/training-matrix/manage-sop-view?year=all&refresh=1', {
      cache: 'no-store',
    });
    if (!freshRes.ok) throw new Error('Failed to refresh view');
    const fresh = await freshRes.json();
    if (isValidManageSopViewResponse(fresh)) {
      setViewData(fresh);
      try {
        if (typeof window !== 'undefined') {
          localStorage.setItem(MANAGE_SOP_VIEW_LOCAL_CACHE_KEY, JSON.stringify(fresh));
        }
      } catch { /* non-fatal */ }
    }
  }, []);

  const assignEmpSops = useMemo(() => {
    if (!assignEmp || !viewData) return [];
    const dept = assignEmp.department;
    const q = assignEmpSearch.trim().toLowerCase();
    return viewData.sops.filter((sop) => {
      const ds = sop.deptStats.find((d) => d.department === dept);
      const relevant =
        sop.primaryDepartment === dept ||
        !!(ds && (ds.isScheduled || ds.isAssigned || ds.scheduledMonth || (ds.total || 0) > 0));
      if (!relevant) return false;
      if (!q) return true;
      return (
        sop.sopCode.toLowerCase().includes(q) ||
        sop.sopName.toLowerCase().includes(q) ||
        (sop.displaySopCode || '').toLowerCase().includes(q)
      );
    });
  }, [assignEmp, assignEmpSearch, viewData]);

  const openAssignEmployee = useCallback((emp: { name: string; designation: string; department: string }) => {
    setAssignEmp(emp);
    setAssignEmpSearch('');
    const selected: Record<string, boolean> = {};
    const roster = viewData?.employeesByDept?.[emp.department] || [];
    const live = roster.find((e) => e.name.trim().toLowerCase() === emp.name.trim().toLowerCase());
    for (const code of live?.assignedSopCodes || []) {
      selected[sopCacheKey(code)] = true;
    }
    setAssignEmpSelected(selected);
  }, [viewData]);

  const saveAssignEmployee = async () => {
    if (!assignEmp || assignEmpSaving || applying) return;
    const selected = assignEmpSops.filter((sop) => assignEmpSelected[sopCacheKey(sop.sopCode)]);
    if (selected.length === 0) {
      setApplyMsg({ kind: 'err', text: 'Select at least one SOP to assign.' });
      return;
    }
    setAssignEmpSaving(true);
    setApplyMsg(null);
    try {
      const res = await fetch('/api/training-matrix/manage-sop-view', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeSopAssignments: [{
            employeeName: assignEmp.name,
            department: assignEmp.department,
            designation: assignEmp.designation,
            sops: selected.map((sop) => {
              const ds = sop.deptStats.find((d) => d.department === assignEmp.department);
              const months = ds?.scheduledMonth ? [ds.scheduledMonth] : [];
              return {
                sopCode: sop.sopCode,
                sopName: sop.sopName,
                months,
              };
            }),
          }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Assign failed');
      await reloadManageSopView();
      setAssignEmp(null);
      setUnassignedEmpModalOpen(false);
      setApplyMsg({
        kind: 'ok',
        text: `Assigned ${selected.length} SOP${selected.length === 1 ? '' : 's'} to ${assignEmp.name}.`,
      });
    } catch (err) {
      setApplyMsg({
        kind: 'err',
        text: err instanceof Error ? err.message : 'Failed to assign SOPs',
      });
    } finally {
      setAssignEmpSaving(false);
    }
  };

  // Pending per-employee ticks waiting for Update — shown on the button so a
  // click is confirmed as queued even before the row is saved.
  const pendingEmployeeEdits = useMemo(() => {
    const { employeeSopAssignments, employeeSopRemovals } = buildEmployeeSopEdits(
      employeeOverrides,
      viewData,
    );
    let count = 0;
    for (const b of employeeSopAssignments) count += b.sops.length;
    for (const b of employeeSopRemovals) count += b.sops.length;
    return count;
  }, [employeeOverrides, viewData]);

  // Has the user toggled any designation in (sop, dept) — used for "highlighted" state.
  // Checks the full global union so cross-dept assignments are also reflected.
  const isDeptActive = (sopCode: string, dept: string): boolean => {
    const inner = overrides[sopCode];
    if (!inner) return false;
    return allDesignationsRef.current.some(fullName => inner[desigKey(dept, fullName)]);
  };

  // Count of *applied* designations checked under (sop, dept).
  const appliedCheckedDesigCount = (sopCode: string, dept: string): number => {
    const inner = appliedOverrides[sopCode];
    if (!inner) return 0;
    return allDesignationsRef.current.reduce(
      (sum, fullName) => sum + (inner[desigKey(dept, fullName)] ? 1 : 0),
      0
    );
  };

  // Effective count for (sop, dept, month) — uses applied state to override original
  const effectiveCount = (
    sop: ManageSOPViewResponse['sops'][0],
    dept: string,
    month: number
  ): number => {
    const innerApplied = appliedMonthCells[sop.sopCode];
    const desigCount = appliedCheckedDesigCount(sop.sopCode, dept);
    if (innerApplied && innerApplied[cellInnerKey(dept, month)] && desigCount > 0) {
      return desigCount;
    }
    const ds = sop.deptStats.find(s => s.department === dept);
    return ds?.monthlyCounts[month] || 0;
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  useEffect(() => {
    // Seed from localStorage on first client paint — avoids loading flash while
    // keeping the initial SSR render (null/true) matching the client's first pass.
    const cached = readManageSopLocalCache();
    if (cached) {
      setViewData(cached);
      setLoading(false);
    }

    const controller = new AbortController();
    const fetchData = async () => {
      let hadData = !!cached;
      try {
        if (!cached) setLoading(true);
        else setRefreshing(true);

        // Fast path: serve the server snapshot immediately (no heavy rebuild).
        const fastRes = await fetch('/api/training-matrix/manage-sop-view?year=all', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (fastRes.ok) {
          const fast = (await fastRes.json()) as ManageSOPViewResponse;
          if (isValidManageSopViewResponse(fast)) {
            setViewData(fast);
            hadData = true;
            setLoading(false);
          }
        }

        // Fresh rebuild so reload never keeps a stale snapshot after an Update.
        const freshRes = await fetch('/api/training-matrix/manage-sop-view?year=all&refresh=1', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (freshRes.ok) {
          const data = (await freshRes.json()) as ManageSOPViewResponse;
          if (isValidManageSopViewResponse(data)) {
            setViewData(data);
            try {
              if (typeof window !== 'undefined') {
                localStorage.setItem(MANAGE_SOP_VIEW_LOCAL_CACHE_KEY, JSON.stringify(data));
              }
            } catch {
              // Non-fatal cache write failure.
            }
            setError('');
          } else if (!hadData) {
            throw new Error('Incomplete SOP data received from server');
          }
        } else if (!hadData) {
          throw new Error('Failed to fetch');
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!hadData) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
        console.error(err);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    };
    void fetchData();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Defer the search term — typing stays snappy, the heavy filter happens off the input
  const deferredSearch = useDeferredValue(search);

  // Set of unassigned SOP codes from the overview API — used by the card filter so
  // "Unassigned SOPs" lists exactly the codes the main training-matrix page counts.
  const unassignedSet = useMemo(
    () => new Set((viewData?.unassignedSopCodes || []).map(c => c.toUpperCase())),
    [viewData]
  );

  const filteredSops = useMemo(() => {
    if (!viewData) return [];
    const q = deferredSearch.toLowerCase();
    const primaryDeptCache = new Map<string, string>();
    const designationCountCache = new Map<string, number>();
    const norm = (v: unknown) => String(v || '').trim().toLowerCase();
    const primaryDeptForSort = (sop: ManageSOPViewResponse['sops'][0]): string => {
      const cacheKey = sop.sopCode || '';
      if (primaryDeptCache.has(cacheKey)) return primaryDeptCache.get(cacheKey)!;
      if (sop.primaryDepartment) {
        primaryDeptCache.set(cacheKey, sop.primaryDepartment);
        return sop.primaryDepartment;
      }
      let best = '';
      let bestScore = -1;
      for (const ds of sop.deptStats) {
        const score = ds.designations.filter(d => d.isAssigned || (d.count || 0) > 0).length;
        if (score > bestScore) {
          bestScore = score;
          best = ds.department;
        }
      }
      const resolved = bestScore > 0 ? best : '';
      primaryDeptCache.set(cacheKey, resolved);
      return resolved;
    };

    const base = viewData.sops.filter(sop => {
      const code = (sop.sopCode || '').trim();
      const name = (sop.sopName || '').trim();

      if (!code || !name || /^[-–—√✓✗×•·*]+$/.test(code) || /^[-–—√✓✗×•·*]+$/.test(name)) {
        return false;
      }

      if (cardFilter === 'unassigned' && !unassignedSet.has(code.toUpperCase())) return false;
      if (cardFilter === 'assigned' && unassignedSet.has(code.toUpperCase())) return false;
      // 'unassigned-employees' keeps the full SOP list; the employee list opens in a modal.

      if (q) {
        const textMatch =
          sopCodeMatchesSearch(q, code, sop.displaySopCode) ||
          name.toLowerCase().includes(q);
        if (textMatch) return true;

        // Employee-name search should match only when that employee is actually
        // allocated (training checked + at least one selected month in that dept).
        const sopOverrides = overrides[sop.sopCode] || EMPTY_INNER;
        const sopMonth = monthCells[sop.sopCode] || EMPTY_INNER;
        const sopManual = viewData.manualAllocations?.[sopCacheKey(sop.sopCode)] || EMPTY_MANUAL;
        const sopManualDesigs =
          viewData.manualDesignations?.[sopCacheKey(sop.sopCode)] || EMPTY_MANUAL_DESIG;
        const employeesByDept = viewData.employeesByDept || EMPTY_EMP_BY_DEPT;

        for (const dept of viewData.departments || []) {
          const deptStat = sop.deptStats.find(s => s.department === dept);
          const manualMonths = sopManual[dept] || [];
          let hasSelectedMonth = false;
          for (let m = 1; m <= 12; m++) {
            const key = cellInnerKey(dept, m);
            const persisted = manualMonths.includes(m) || deptStat?.scheduledMonth === m;
            const selected = key in sopMonth ? !!sopMonth[key] : persisted;
            if (selected) { hasSelectedMonth = true; break; }
          }
          if (!hasSelectedMonth) continue;

          const selectedDesigs = new Set(
            allDesignationsRef.current.filter((fullName) => {
              const key = desigKey(dept, fullName);
              if (key in sopOverrides) return !!sopOverrides[key];
              return (deptStat?.designations || []).some(
                (d) => d.designation === fullName && (d.isAssigned || (d.count || 0) > 0),
              ) || (sopManualDesigs[dept] || []).some((d) => d === fullName);
            }).map(norm),
          );

          if (selectedDesigs.size === 0) continue;
          const emps = employeesByDept[dept] || [];
          const hasEmpMatch = emps.some((emp) =>
            norm(emp.name).includes(q) && selectedDesigs.has(norm(emp.designation)),
          );
          if (hasEmpMatch) return true;
        }
        return false;
      }
      return true;
    });

    const designationCount = (sop: ManageSOPViewResponse['sops'][0]) => {
      const cacheKey = sop.sopCode || '';
      if (designationCountCache.has(cacheKey)) return designationCountCache.get(cacheKey)!;
      const total = sop.deptStats.reduce(
        (sum, ds) => sum + ds.designations.filter(d => d.isAssigned || (d.count || 0) > 0).length,
        0
      );
      designationCountCache.set(cacheKey, total);
      return total;
    };

    const cmp = (a: ManageSOPViewResponse['sops'][0], b: ManageSOPViewResponse['sops'][0]) => {
      let va: string | number = 0;
      let vb: string | number = 0;
      switch (sortKey) {
        case 'sopCode':
          va = (a.sopCode || '').toLowerCase();
          vb = (b.sopCode || '').toLowerCase();
          break;
        case 'sopName':
          va = (a.sopName || '').toLowerCase();
          vb = (b.sopName || '').toLowerCase();
          break;
        case 'dept':
          va = primaryDeptForSort(a).toLowerCase();
          vb = primaryDeptForSort(b).toLowerCase();
          break;
        case 'designation':
          va = designationCount(a);
          vb = designationCount(b);
          break;
        case 'months':
        case 'total':
          va = a.grandTotal || 0;
          vb = b.grandTotal || 0;
          break;
        case 'sr':
        default:
          return 0;
      }
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    };

    return sortKey === 'sr' ? base : [...base].sort(cmp);
  }, [viewData, deferredSearch, sortKey, sortDir, cardFilter, unassignedSet, overrides, monthCells, EMPTY_INNER, EMPTY_MANUAL, EMPTY_MANUAL_DESIG, EMPTY_EMP_BY_DEPT]);

  // Per-SOP per-dept "counts toward this department" predicate.
  // True if the SOP is scheduled for the dept, OR assigned to the dept, OR if the dept
  // is the SOP's registry-based primary department. This ensures the TOTAL block is
  // populated even if the optional schedule snapshot is missing.
  const countsForDept = (sop: ManageSOPViewResponse['sops'][0], dept: string): boolean => {
    const ds = sop.deptStats.find(s => s.department === dept);
    if (ds?.isScheduled) return true;
    if (ds?.isAssigned) return true;
    if ((ds?.total || 0) > 0) return true;
    if (sop.primaryDepartment === dept) return true;
    return false;
  };

  // ─── Live deltas ────────────────────────────────────────────────────────────
  // Real-time count adjustments based on the user's pending checkbox overrides:
  //   • Checking a cell NOT in the baseline schedule → +1 to (dept,month)/(dept)/(month)
  //   • Unchecking a cell that IS in the baseline schedule → -1 from same buckets
  //   • Otherwise (no effective change vs baseline) → 0
  // Baseline = `scheduledMonth === month` on the dept stat, i.e. what
  // `sopCountsByDeptMonth` was computed from on the server.
  const deltas = useMemo(() => {
    const byDeptMonth: Record<string, Record<number, number>> = {};
    const byDept: Record<string, number> = {};
    const byMonth: Record<number, number> = {};
    let sopsNewlyAssigned = 0;
    let sopsNewlyUnassigned = 0;

    if (!viewData) return { byDeptMonth, byDept, byMonth, sopsNewlyAssigned, sopsNewlyUnassigned };

    const wasUnassigned = new Set<string>();
    for (const sop of viewData.sops) {
      if (!sop.deptStats.some(ds => ds.scheduledMonth)) wasUnassigned.add(sop.sopCode);
    }

    // Only applied (committed) month selections affect global counts/cards.
    // This prevents unrelated numbers from changing while the user is still editing.
    for (const [sopCode, inner] of Object.entries(appliedMonthCells)) {
      const sop = viewData.sops.find(s => s.sopCode === sopCode);
      if (!sop) continue;
      let anyAdded = false;
      let anyRemoved = false;
      let stillScheduledSomewhere = sop.deptStats.some(ds => ds.scheduledMonth);
      for (const [k, on] of Object.entries(inner)) {
        const [dept, monthStr] = k.split('|');
        const month = parseInt(monthStr, 10);
        if (!dept || !Number.isInteger(month)) continue;
        const ds = sop.deptStats.find(s => s.department === dept);
        const inBaseline = ds?.scheduledMonth === month;
        let d = 0;
        if (on && !inBaseline) d = 1;
        else if (!on && inBaseline) d = -1;
        if (d === 0) continue;
        if (!byDeptMonth[dept]) byDeptMonth[dept] = {};
        byDeptMonth[dept][month] = (byDeptMonth[dept][month] || 0) + d;
        byDept[dept] = (byDept[dept] || 0) + d;
        byMonth[month] = (byMonth[month] || 0) + d;
        if (d > 0) anyAdded = true;
        if (d < 0) anyRemoved = true;
        if (d < 0) stillScheduledSomewhere = false;
      }
      if (anyAdded && wasUnassigned.has(sopCode)) sopsNewlyAssigned += 1;
      if (anyRemoved && !anyAdded && !stillScheduledSomewhere && !wasUnassigned.has(sopCode)) {
        sopsNewlyUnassigned += 1;
      }
    }
    return { byDeptMonth, byDept, byMonth, sopsNewlyAssigned, sopsNewlyUnassigned };
  }, [appliedMonthCells, viewData]);

  const countsAPI: CountsAPI = useMemo(() => {
    const baseAssigned = viewData?.stats.assigned ?? 0;
    const baseUnassigned =
      viewData?.unassignedSopCodes?.length ?? (viewData?.stats.unassigned ?? 0);
    const baseTotal = viewData?.stats.total ?? 0;
    const deltaAssigned = Object.values(deltas.byDept).reduce((a, b) => a + b, 0);
    return {
      cellCount: (dept, month) =>
        (viewData?.sopCountsByDeptMonth?.[dept]?.[month] ?? 0) +
        (deltas.byDeptMonth[dept]?.[month] || 0),
      deptTotal: (dept) =>
        (viewData?.sopCountsByDept?.[dept] ?? 0) + (deltas.byDept[dept] || 0),
      monthTotal: (month) =>
        (viewData?.sopCountsByMonth?.[month] ?? 0) + (deltas.byMonth[month] || 0),
      grandTotal: () => baseAssigned + deltaAssigned,
      assigned: () => baseAssigned + deltaAssigned,
      unassigned: () =>
        Math.max(0, baseUnassigned - deltas.sopsNewlyAssigned + deltas.sopsNewlyUnassigned),
      total: () => baseTotal,
      version: 0,
    };
  }, [viewData, deltas]);

  // Primary department: prefer the API-provided value (sourced from MasterSOPRepository /
  // SOPLibrary), then fall back to dept with most assigned designations.
  const getPrimaryDept = useCallback((sop: ManageSOPViewResponse['sops'][0]): string => {
    if (sop.primaryDepartment) return sop.primaryDepartment;
    let best = '';
    let bestScore = -1;
    for (const ds of sop.deptStats) {
      const score = ds.designations.filter(d => d.isAssigned).length;
      if (score > bestScore) {
        bestScore = score;
        best = ds.department;
      }
    }
    return bestScore > 0 ? best : '';
  }, []);


  const collectDesignations = (
    sop: ManageSOPViewResponse['sops'][0],
    deptFilter?: string
  ): string[] => {
    const out = new Set<string>();
    for (const ds of sop.deptStats) {
      if (deptFilter && ds.department !== deptFilter) continue;
      const manualDesigList = (viewData?.manualDesignations?.[sopCacheKey(sop.sopCode)]?.[ds.department] || []);
      const sopOverrides = overrides[sop.sopCode] || {};
      const deptUniverse = sortDesignations(designationsByDeptRef.current[ds.department] || []);

      // Match the same effective assignment logic used in the row checkboxes:
      // explicit override > assignment/manual/training-count fallback.
      for (const fullName of deptUniverse) {
        const key = desigKey(ds.department, fullName);
        const inFallback =
          ds.designations.some(d => d.designation === fullName && (d.isAssigned || (d.count || 0) > 0)) ||
          manualDesigList.includes(fullName);
        const isChecked = key in sopOverrides ? !!sopOverrides[key] : inFallback;
        if (isChecked) out.add(fullName);
      }
    }
    return Array.from(out);
  };

  const sumTrainingEvents = (
    sop: ManageSOPViewResponse['sops'][0],
    deptFilter?: string,
    monthFilter?: number
  ): number => {
    let n = 0;
    for (const ds of sop.deptStats) {
      if (deptFilter && ds.department !== deptFilter) continue;
      if (monthFilter) n += ds.monthlyCounts[monthFilter] || 0;
      else n += ds.total || 0;
    }
    return n;
  };

  const buildPopupItems = (scope: CountScope): PopupItem[] => {
    if (!viewData) return [];

    if (scope.kind === 'dept-month') {
      // SOPs scheduled in (dept, month) per the training-matrix snapshot
      return viewData.sops
        .filter(sop => sop.deptStats.find(s => s.department === scope.dept)?.scheduledMonth === scope.month)
        .map(sop => ({
          sopCode: sop.sopCode,
          sopName: sop.sopName,
          count: 1,
          scheduledMonthName: scope.monthName,
          designations: collectDesignations(sop, scope.dept),
          trainingEvents: sumTrainingEvents(sop, scope.dept, scope.month),
        }))
        .sort((a, b) => a.sopCode.localeCompare(b.sopCode));
    }

    if (scope.kind === 'month-total') {
      // SOPs scheduled in this month for ANY dept
      return viewData.sops
        .filter(sop => sop.deptStats.some(ds => ds.scheduledMonth === scope.month))
        .map(sop => {
          const ds = sop.deptStats.find(s => s.scheduledMonth === scope.month);
          return {
            sopCode: sop.sopCode,
            sopName: sop.sopName,
            count: 1,
            scheduledMonthName: scope.monthName,
            designations: ds ? collectDesignations(sop, ds.department) : [],
            trainingEvents: sumTrainingEvents(sop, ds?.department, scope.month),
          };
        })
        .sort((a, b) => a.sopCode.localeCompare(b.sopCode));
    }

    if (scope.kind === 'dept-total') {
      // All SOPs that belong to this dept (schedule, assignment, records, or primary dept)
      return viewData.sops
        .filter(sop => countsForDept(sop, scope.dept))
        .map(sop => {
          const ds = sop.deptStats.find(s => s.department === scope.dept);
          const m = ds?.scheduledMonth || 0;
          return {
            sopCode: sop.sopCode,
            sopName: sop.sopName,
            count: 1,
            scheduledMonthName: m ? MONTH_SHORT[m - 1] : '',
            designations: collectDesignations(sop, scope.dept),
            trainingEvents: sumTrainingEvents(sop, scope.dept),
          };
        })
        .sort((a, b) => {
          const am = MONTH_SHORT.indexOf(a.scheduledMonthName || '');
          const bm = MONTH_SHORT.indexOf(b.scheduledMonthName || '');
          if (am !== bm) return am - bm;
          return a.sopCode.localeCompare(b.sopCode);
        });
    }

    // grand-total — every SOP that belongs to any dept
    const depts = viewData.departments || [];
    return viewData.sops
      .filter(sop => depts.some(d => countsForDept(sop, d)))
      .map(sop => {
        const dept = depts.find(d => countsForDept(sop, d)) || '';
        const ds = sop.deptStats.find(s => s.department === dept);
        const m = ds?.scheduledMonth || 0;
        return {
          sopCode: sop.sopCode,
          sopName: sop.sopName,
          count: 1,
          scheduledMonthName: m ? MONTH_SHORT[m - 1] : '',
          designations: collectDesignations(sop),
          trainingEvents: sumTrainingEvents(sop),
        };
      })
      .sort((a, b) => a.sopCode.localeCompare(b.sopCode));
  };

  const popupHeader = (scope: CountScope): { title: string; subtitle: string; dept: string } => {
    if (scope.kind === 'dept-month')
      return {
        title: `${deptAbbrLabel(scope.dept)} · ${scope.monthName}`,
        subtitle: `SOPs scheduled in ${scope.monthName} for ${scope.dept}`,
        dept: scope.dept,
      };
    if (scope.kind === 'month-total')
      return {
        title: `${scope.monthName} — All Departments`,
        subtitle: `SOPs scheduled in ${scope.monthName} across all departments`,
        dept: '',
      };
    if (scope.kind === 'dept-total')
      return {
        title: `${deptAbbrLabel(scope.dept)} — Total`,
        subtitle: `All SOPs scheduled for ${scope.dept}`,
        dept: scope.dept,
      };
    return {
      title: `All SOPs — Grand Total`,
      subtitle: `Every SOP scheduled in the training matrix`,
      dept: '',
    };
  };

  const openCountPopup = (e: React.MouseEvent, scope: CountScope) => {
    e.preventDefault();
    e.stopPropagation();
    const items = buildPopupItems(scope);
    if (items.length === 0) return;
    const meta = popupHeader(scope);
    setPopup({
      title: meta.title,
      subtitle: meta.subtitle,
      dept: meta.dept,
      items,
    });
  };

  // Stable wrapper for openCountPopup so memo'd SopRow doesn't bust on every render.
  // The latest closure is always reachable via the ref; the function we hand to rows
  // never changes identity.
  const openCountPopupRef = useRef(openCountPopup);
  openCountPopupRef.current = openCountPopup;
  const stableOpenCountPopup = useCallback(
    (e: React.MouseEvent, scope: CountScope) => openCountPopupRef.current(e, scope),
    []
  );


  // Close popup on Escape
  useEffect(() => {
    if (!popup) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPopup(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [popup]);

  // Close the export dropdown on outside click.
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [exportMenuOpen]);

  // Build a department training-matrix worksheet matching the reference Excel format
  // (docs/excel/*.xlsx):
  //   • Row 1: "Employee Name" | "Designation" | <MONTH names> (each month merged
  //            across the SOP columns scheduled in that month)
  //   • Row 2: blank | blank | <SOP codes>
  //   • Body : one row per employee → name, designation, then √ / X per SOP
  //            (√ when the SOP is assigned to that employee's designation in this dept).
  // Returns null when the department has no assigned SOPs so it can be skipped.
  const buildDeptMatrixSheet = (dept: string): XLSX.WorkSheet | null => {
    if (!viewData) return null;
    const designationsByDept = viewData.designationsByDept || {};
    const manualDesignations = viewData.manualDesignations || {};
    const manualAllocations = viewData.manualAllocations || {};
    const employees = viewData.employeesByDept?.[dept] || [];
    const deptDesigs = sortDesignations(designationsByDept[dept] || []);

    type Col = { code: string; month: number; assigned: Set<string> };
    const cols: Col[] = [];
    for (const sop of viewData.sops) {
      const cacheKey = sopCacheKey(sop.sopCode);
      const deptStat = sop.deptStats.find(s => s.department === dept);
      const manualDesigList = manualDesignations[cacheKey]?.[dept] || [];
      const assigned = new Set(
        deptDesigs.filter(fullName =>
          (deptStat?.designations || []).some(
            d => d.designation === fullName && (d.isAssigned || (d.count || 0) > 0),
          ) || manualDesigList.includes(fullName),
        ),
      );
      if (assigned.size === 0) continue; // not assigned to this department

      let month = deptStat?.scheduledMonth || 0;
      if (!month) {
        const ms = manualAllocations[cacheKey]?.[dept] || [];
        if (ms.length) month = Math.min(...ms);
      }
      cols.push({ code: sop.sopCode, month, assigned });
    }

    if (cols.length === 0) return null;

    // Scheduled SOPs first (Jan → Dec), unscheduled (month 0) last; sopCode within a month.
    cols.sort((a, b) => {
      const ma = a.month || 13;
      const mb = b.month || 13;
      if (ma !== mb) return ma - mb;
      return a.code.localeCompare(b.code);
    });

    const monthLabel = (m: number) => (m >= 1 && m <= 12 ? MONTH_FULL[m - 1] : 'NOT SCHEDULED');

    // Header rows.
    const headerMonths: (string | number)[] = ['Employee Name', 'Designation'];
    const headerCodes: (string | number)[] = ['', ''];
    const merges: XLSX.Range[] = [
      { s: { c: 0, r: 0 }, e: { c: 0, r: 1 } }, // Employee Name
      { s: { c: 1, r: 0 }, e: { c: 1, r: 1 } }, // Designation
    ];
    let groupStart = 0;
    cols.forEach((col, i) => {
      const colIdx = i + 2; // SOP columns start at column C
      headerCodes.push(col.code);
      const isGroupStart = i === 0 || col.month !== cols[i - 1].month;
      headerMonths.push(isGroupStart ? monthLabel(col.month) : '');
      // When a month group ends, emit its horizontal merge across the header row.
      const isGroupEnd = i === cols.length - 1 || col.month !== cols[i + 1].month;
      if (isGroupStart) groupStart = colIdx;
      if (isGroupEnd && colIdx > groupStart) {
        merges.push({ s: { c: groupStart, r: 0 }, e: { c: colIdx, r: 0 } });
      }
    });

    const aoa: (string | number)[][] = [headerMonths, headerCodes];
    for (const emp of employees) {
      const row: (string | number)[] = [emp.name, emp.designation];
      for (const col of cols) {
        row.push(col.assigned.has(emp.designation) ? '√' : 'X');
      }
      aoa.push(row);
    }

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = merges;
    ws['!cols'] = [{ wch: 22 }, { wch: 16 }, ...cols.map(() => ({ wch: 9 }))];
    return ws;
  };

  // target: 'all' → one workbook with a sheet per department; otherwise a single dept file.
  const handleExport = (target: 'all' | string = 'all') => {
    if (!viewData) return;
    setExportMenuOpen(false);
    const departments = viewData.departments || [];
    const wb = XLSX.utils.book_new();
    const date = new Date().toISOString().split('T')[0];

    if (target === 'all') {
      let any = false;
      for (const dept of departments) {
        const ws = buildDeptMatrixSheet(dept);
        if (!ws) continue;
        XLSX.utils.book_append_sheet(wb, ws, dept.slice(0, 31));
        any = true;
      }
      if (!any) {
        setApplyMsg({ kind: 'err', text: 'No assigned SOPs to export.' });
        return;
      }
      XLSX.writeFile(wb, `Training Matrix_All Departments_${date}.xlsx`);
    } else {
      const ws = buildDeptMatrixSheet(target);
      if (!ws) {
        setApplyMsg({ kind: 'err', text: `No assigned SOPs for ${target}.` });
        return;
      }
      XLSX.utils.book_append_sheet(wb, ws, target.slice(0, 31));
      XLSX.writeFile(wb, `Training Matrix_${target}_${date}.xlsx`);
    }
  };

  // Single horizontal scroll bar pinned to the viewport bottom. The bar is a
  // fixed-position proxy whose scrollLeft mirrors the main table's scrollLeft,
  // so users can scroll left/right at any point without scrolling to the
  // bottom of a tall table to find the native bar.
  const tableScrollRef = useRef<HTMLDivElement>(null);
  const proxyScrollRef = useRef<HTMLDivElement>(null);
  const [scrollWidth, setScrollWidth] = useState(0);
  const syncing = useRef<'main' | 'proxy' | null>(null);

  useLayoutEffect(() => {
    const el = tableScrollRef.current;
    if (!el) return;
    const updateWidth = () => setScrollWidth(el.scrollWidth);
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewData, sortKey, sortDir, search, filteredSops.length, viewMode]);

  const mirrorScroll = (source: 'main' | 'proxy', from: HTMLDivElement | null) => {
    if (!from) return;
    syncing.current = source;
    const left = from.scrollLeft;
    if (source !== 'main' && tableScrollRef.current) tableScrollRef.current.scrollLeft = left;
    if (source !== 'proxy' && proxyScrollRef.current) proxyScrollRef.current.scrollLeft = left;
  };
  const onMainScroll = () => {
    if (syncing.current && syncing.current !== 'main') { syncing.current = null; return; }
    mirrorScroll('main', tableScrollRef.current);
  };
  const onProxyScroll = () => {
    if (syncing.current && syncing.current !== 'proxy') { syncing.current = null; return; }
    mirrorScroll('proxy', proxyScrollRef.current);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="mb-4 h-8 w-8 animate-spin rounded-full border-4 border-gray-300 border-t-blue-600 mx-auto"></div>
          <p className="text-gray-600">Loading Manage SOP data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 p-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-red-600 text-center p-4 bg-red-50 rounded-lg">
            <p className="font-semibold">{error}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!viewData) return null;

  const departments = viewData.departments || [];

  return (
    <div className="h-screen flex flex-col bg-gray-50 overflow-hidden">
      {/* Header — title + view tabs always visible; KPI/search collapse for calendar space */}
      <div className="bg-white border-b border-gray-200 shrink-0 z-50 shadow-sm">
        <div className={`max-w-full mx-auto px-6 ${headerCollapsed ? 'py-2' : 'py-4'}`}>
          {/* Title row + collapse toggle */}
          <div className={`flex items-center justify-between gap-3 ${headerCollapsed ? 'mb-2' : 'mb-4'}`}>
            <div className="flex items-center gap-3 min-w-0">
              <Link href={backHref} className="text-blue-600 hover:text-blue-700 shrink-0">
                <ArrowLeft size={headerCollapsed ? 18 : 20} />
              </Link>
              <h1 className={`font-bold text-gray-900 truncate ${headerCollapsed ? 'text-lg' : 'text-2xl'}`}>
                Manage SOP Training Data
              </h1>
              {refreshing && (
                <span className="text-xs font-medium text-blue-600 animate-pulse shrink-0">Updating…</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setHeaderCollapsed((c) => !c)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 shrink-0"
              title={headerCollapsed ? 'Expand header' : 'Collapse header for more calendar space'}
              aria-expanded={!headerCollapsed}
            >
              {headerCollapsed ? (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  Expand
                </>
              ) : (
                <>
                  <ChevronUp className="w-3.5 h-3.5" />
                  Collapse
                </>
              )}
            </button>
          </div>

          {!headerCollapsed && (
            <>
              {/* Stats Cards — clicking filters the SOP table to that bucket. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <button
                  type="button"
                  onClick={() => {
                    setCardFilter('all');
                    setUnassignedEmpModalOpen(false);
                  }}
                  className={`text-left bg-purple-50 border rounded-lg p-3 transition hover:bg-purple-100 ${
                    cardFilter === 'all' ? 'border-purple-500 ring-2 ring-purple-300' : 'border-purple-200'
                  }`}
                >
                  <div className="text-sm text-purple-600 font-medium">Total SOPs</div>
                  <div className="text-2xl font-bold text-purple-900">{countsAPI.total()}</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCardFilter('assigned');
                    setUnassignedEmpModalOpen(false);
                  }}
                  className={`text-left bg-blue-50 border rounded-lg p-3 transition hover:bg-blue-100 ${
                    cardFilter === 'assigned' ? 'border-blue-500 ring-2 ring-blue-300' : 'border-blue-200'
                  }`}
                >
                  <div className="text-sm text-blue-600 font-medium">Assigned SOPs</div>
                  <div className="text-2xl font-bold text-blue-900">{countsAPI.assigned()}</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCardFilter('unassigned');
                    setUnassignedEmpModalOpen(false);
                  }}
                  className={`text-left bg-red-50 border rounded-lg p-3 transition hover:bg-red-100 ${
                    cardFilter === 'unassigned' ? 'border-red-500 ring-2 ring-red-300' : 'border-red-200'
                  }`}
                >
                  <div className="text-sm text-red-600 font-medium">Unassigned SOPs</div>
                  <div className="text-2xl font-bold text-red-900">{countsAPI.unassigned()}</div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCardFilter('unassigned-employees');
                    setViewMode('employee');
                    setUnassignedEmpModalOpen(true);
                  }}
                  className={`text-left bg-orange-50 border rounded-lg p-3 transition hover:bg-orange-100 ${
                    cardFilter === 'unassigned-employees' ? 'border-orange-500 ring-2 ring-orange-300' : 'border-orange-200'
                  }`}
                >
                  <div className="text-sm text-orange-600 font-medium">Unassigned Employees</div>
                  <div className="text-2xl font-bold text-orange-900">
                    {viewData?.stats.unassignedEmployees ?? viewData?.unassignedEmployees?.length ?? 0}
                  </div>
                </button>
              </div>

              {/* Search + matrix actions (hidden on calendar — calendar has its own tools) */}
              {viewMode !== 'calendar' && (
                <div className="flex gap-3 items-center mb-3 flex-wrap">
                  <div className="flex-1 relative min-w-[200px]">
                    <Search className="absolute left-3 top-2.5 text-gray-400 w-5 h-5" />
                    <input
                      type="text"
                      placeholder="Search SOP No or Name..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <button className="p-2 border border-gray-300 rounded hover:bg-gray-50 text-gray-600">
                    <Filter className="w-4 h-4" />
                  </button>
                  <button
                    onClick={autoAssign}
                    disabled={autoAssigning || autoAssigningEmployees || applying}
                    className="px-3 py-2 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-medium"
                    title="Automatically schedule every unassigned SOP across the year, balanced per month and grouped by department"
                  >
                    <Wand2 className="w-4 h-4" />
                    {autoAssigning ? 'Assigning…' : 'Auto-Assign'}
                  </button>
                  {(cardFilter === 'unassigned-employees' || unassignedEmpModalOpen) && (
                    <button
                      onClick={autoAssignEmployees}
                      disabled={autoAssigningEmployees || autoAssigning || applying || !(viewData?.unassignedEmployees?.length)}
                      className="px-3 py-2 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-medium"
                      title="Assign unassigned employees onto SOPs already scheduled in their department"
                    >
                      <Users className="w-4 h-4" />
                      {autoAssigningEmployees ? 'Assigning…' : 'Auto Assign Employees'}
                    </button>
                  )}
                  <button
                    onClick={() => applyChanges()}
                    disabled={applying || autoAssigning || autoAssigningEmployees}
                    className="px-3 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-medium"
                    title="Persist checked designation × month selections into the training matrix"
                  >
                    {applying ? 'Saving…' : 'Update'}
                    {!applying && pendingEmployeeEdits > 0 && (
                      <span className="rounded-full bg-white/25 px-1.5 text-[11px] font-bold">
                        {pendingEmployeeEdits}
                      </span>
                    )}
                  </button>
                  {applyMsg && (
                    <span
                      className={`text-[11px] font-medium ${applyMsg.kind === 'ok' ? 'text-green-700' : 'text-red-600'}`}
                      role="status"
                    >
                      {applyMsg.text}
                    </span>
                  )}
                  <button
                    onClick={openLogs}
                    className="px-3 py-2 bg-gray-700 text-white rounded hover:bg-gray-800 flex items-center gap-2 text-sm font-medium"
                    title="View audit log of allocations made via this page"
                  >
                    <ScrollText className="w-4 h-4" />
                    Logs
                  </button>
                  <div className="relative" ref={exportMenuRef}>
                    <button
                      onClick={() => setExportMenuOpen(o => !o)}
                      className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 flex items-center gap-2 text-sm font-medium"
                      title="Export the assigned SOPs as a training matrix (same format as the reference Excel files)"
                    >
                      <Download className="w-4 h-4" />
                      Export to Excel
                    </button>
                    {exportMenuOpen && (
                      <div className="absolute right-0 mt-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg z-[60] py-1 max-h-96 overflow-auto">
                        <button
                          onClick={() => handleExport('all')}
                          className="w-full text-left px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100"
                        >
                          All Departments (one sheet each)
                        </button>
                        <div className="my-1 border-t border-gray-100" />
                        <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-gray-400">
                          Department-wise
                        </div>
                        {departments.map(dept => (
                          <button
                            key={dept}
                            onClick={() => handleExport(dept)}
                            className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2"
                          >
                            <span
                              className="inline-block w-2 h-2 rounded-full"
                              style={{ background: deptColor(dept) }}
                            />
                            {dept}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="text-sm text-gray-600">
                    {filteredSops.length} SOPs
                  </div>
                </div>
              )}
            </>
          )}

          {/* View toggle — Designations / Employees / Calendar */}
          <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-sm">
            <button
              type="button"
              onClick={() => {
                setViewMode('designation');
                setHeaderCollapsed(false);
              }}
              className={`px-3 py-1.5 inline-flex items-center gap-1.5 transition ${
                viewMode === 'designation'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
              title="Show designations under each department"
            >
              <Tag className="w-3.5 h-3.5" />
              Designations
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode('employee');
                setHeaderCollapsed(false);
              }}
              className={`px-3 py-1.5 inline-flex items-center gap-1.5 border-l border-gray-300 transition ${
                viewMode === 'employee'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
              title="Show employee names under each department"
            >
              <Users className="w-3.5 h-3.5" />
              Employees
            </button>
            <button
              type="button"
              onClick={() => {
                setViewMode('calendar');
                setHeaderCollapsed(true);
              }}
              className={`px-3 py-1.5 inline-flex items-center gap-1.5 border-l border-gray-300 transition ${
                viewMode === 'calendar'
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-50'
              }`}
              title="Assign exam dates on a calendar"
            >
              <Calendar className="w-3.5 h-3.5" />
              Calendar
            </button>
          </div>
        </div>
      </div>

      {viewMode === 'calendar' ? (
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
          <TrainingCalendar />
        </div>
      ) : (
      <>
      {/* Table Container — reserve space at the bottom so the fixed scrollbar +
          footer don't overlap the last rows of the table. */}
      <div
        ref={tableScrollRef}
        onScroll={onMainScroll}
        className="flex-1 overflow-auto overscroll-contain [overflow-anchor:none]"
        style={{ paddingBottom: 48 }}
      >
        <div className="inline-block min-w-full p-6">
          <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="bg-gray-100 border-b border-gray-300">
                  <SortableTh label="SR" sortKey="sr" current={sortKey} dir={sortDir} onClick={toggleSort} className="w-10 px-2 text-center" />
                  <SortableTh label="SOP NO" sortKey="sopCode" current={sortKey} dir={sortDir} onClick={toggleSort} className="w-24 px-3 text-left border-l border-gray-200" />
                  <SortableTh label="SOP NAME" sortKey="sopName" current={sortKey} dir={sortDir} onClick={toggleSort} className="w-56 px-3 text-left border-l border-gray-200" />
                  <SortableTh label="DEPT" sortKey="dept" current={sortKey} dir={sortDir} onClick={toggleSort} className="w-16 px-2 text-left border-l border-gray-200" />
                  <th className={`py-3 font-semibold bg-gray-100 text-gray-900 px-3 text-left border-l border-gray-200 whitespace-nowrap ${viewMode === 'employee' ? 'min-w-[420px]' : ''}`}>
                    <div>{viewMode === 'employee' ? 'DEPARTMENT WITH EMPLOYEES' : 'DEPARTMENT WITH DESIGNATION'}</div>
                    <div className="mt-0.5 text-[10px] font-normal text-gray-600 flex items-center gap-2">
                      <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm border border-blue-500 bg-white" />Training Check</span>
                      <span className="inline-flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-sm border border-orange-500 bg-white" />Induction Training</span>
                    </div>
                  </th>
                  <th className="py-3 font-semibold bg-gray-100 text-gray-900 px-3 text-left border-l border-gray-200 whitespace-nowrap">
                    MONTHS
                  </th>
                </tr>
              </thead>

              <CountsContext.Provider value={countsAPI}>
              <SopRowsBody
                filteredSops={filteredSops}
                viewMode={viewMode}
                unassignedSet={unassignedSet}
                departments={departments}
                designationsByDept={viewData.designationsByDept || {}}
                allDesignations={allDesignationsRef.current}
                overrides={overrides}
                inductionOverrides={inductionOverrides}
                employeeOverrides={employeeOverrides}
                monthCells={monthCells}
                manualAllocations={viewData.manualAllocations}
                manualDesignations={viewData.manualDesignations}
                employeesByDept={viewData.employeesByDept || EMPTY_EMP_BY_DEPT}
                emptyInner={EMPTY_INNER}
                emptyManual={EMPTY_MANUAL}
                emptyManualDesig={EMPTY_MANUAL_DESIG}
                getPrimaryDept={getPrimaryDept}
                onEmployeeClick={openEmployeeModal}
                onOpenAddEmployee={openAddEmployeeModal}
                setDesigChecked={setDesigChecked}
                setEmployeeChecked={setEmployeeChecked}
                setInductionChecked={setInductionChecked}
                setDeptChecked={setDeptChecked}
                setDeptInductionChecked={setDeptInductionChecked}
                toggleMonthCell={toggleMonthCell}
                openCountPopup={stableOpenCountPopup}
                searchQuery={deferredSearch}
              />
              </CountsContext.Provider>
            </table>
          </div>
        </div>
      </div>


      {/* Footer + fixed horizontal scrollbar — both pinned to the viewport
          bottom so they remain visible regardless of vertical scroll position.
          The scrollbar mirrors the main table's scrollLeft, so users can
          navigate the table horizontally without scrolling to its end. */}
      <div className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200">
        <div
          ref={proxyScrollRef}
          onScroll={onProxyScroll}
          className="overflow-x-auto bg-gray-100/95 border-b border-gray-200"
          style={{ height: 14 }}
        >
          <div style={{ width: scrollWidth, height: 1 }} />
        </div>
        <div className="px-6 py-2 text-xs text-gray-600">
          Showing all {filteredSops.length} SOPs
        </div>
      </div>
      </>
      )}

      {/* Employee SOP detail modal — opened by clicking an employee name in Employees view */}
      {empModal && empModalDerived && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setEmpModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-lg shadow-2xl flex flex-col w-full max-w-5xl"
            style={{ maxHeight: '85vh' }}
          >
            {/* Header */}
            <div
              className="flex items-start justify-between px-5 py-3 border-b border-gray-200 rounded-t-lg"
              style={{ backgroundColor: `${deptColor(empModal.dept)}12` }}
            >
              <div className="min-w-0">
                <div className="text-base font-bold text-gray-900 truncate">{empModal.name}</div>
                <div className="text-xs text-gray-600 truncate">
                  {deptAbbrLabel(empModal.dept)}
                  {empModal.designation ? ` · ${empModal.designation}` : ''}
                </div>
              </div>
              <button
                onClick={() => setEmpModal(null)}
                className="text-gray-400 hover:text-gray-700 text-2xl leading-none p-1"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {empModal.loading ? (
              <div className="p-10 text-center text-gray-600">Loading employee SOPs…</div>
            ) : empModal.error ? (
              <div className="p-10 text-center text-red-600">{empModal.error}</div>
            ) : (
              <>
                {/* Filter pills + search */}
                <div className="px-5 py-3 border-b border-gray-200 bg-white flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEmpModalFilter(f => (f === 'due' ? 'all' : 'due'))}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition ${
                      empModalFilter === 'due'
                        ? 'bg-amber-500 border-amber-500 text-white shadow-sm'
                        : 'bg-gray-100 border-gray-200 text-gray-800 hover:border-amber-300 hover:text-amber-700'
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${empModalFilter === 'due' ? 'bg-white' : 'bg-gray-400'}`} />
                    Due SOPs: {empModalDerived.totalDue}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEmpModalFilter(f => (f === 'assigned' ? 'all' : 'assigned'))}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-bold transition ${
                      empModalFilter === 'assigned'
                        ? 'bg-emerald-500 border-emerald-500 text-white shadow-sm'
                        : 'bg-gray-100 border-gray-200 text-gray-800 hover:border-emerald-300 hover:text-emerald-600'
                    }`}
                  >
                    <span className={`h-2 w-2 rounded-full ${empModalFilter === 'assigned' ? 'bg-white' : 'bg-gray-400'}`} />
                    Assigned SOPs: {empModalDerived.totalAssigned}
                  </button>
                  <span className="inline-flex items-center gap-1.5 rounded-full border bg-gray-100 border-gray-200 px-3 py-1 text-xs font-bold text-gray-800">
                    Scheduled: {empModalDerived.allCount}
                  </span>
                  {empModalDerived.allCount > 0 && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-purple-50 border border-purple-200 px-3 py-1 text-xs font-bold text-purple-700">
                      Exam Coverage: {empModalDerived.examCoveragePct}%
                    </span>
                  )}
                  <div className="ml-auto relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
                    <input
                      value={empModalSearch}
                      onChange={(e) => setEmpModalSearch(e.target.value)}
                      placeholder="Search SOP code or name…"
                      className="rounded-lg border border-gray-200 py-1.5 pl-7 pr-3 text-xs focus:border-purple-300 focus:outline-none w-56"
                    />
                  </div>
                </div>

                {(empModalFilter !== 'all' || empModalSearch.trim()) && (
                  <div className="px-5 py-1.5 text-[11px] text-gray-700 border-b border-gray-100 bg-gray-50">
                    Showing {empModalDerived.rows.length} of {empModalDerived.allCount} SOPs
                    {empModalFilter !== 'all' && (
                      <button
                        type="button"
                        onClick={() => setEmpModalFilter('all')}
                        className="ml-2 text-purple-600 hover:underline font-medium"
                      >
                        Clear filter
                      </button>
                    )}
                  </div>
                )}

                <div className="flex-1 overflow-auto">
                  <table className="w-full text-xs text-left">
                    <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-3 py-2 font-semibold text-gray-700 w-24">Status</th>
                        <th className="px-3 py-2 font-semibold text-gray-700 w-28">SOP Code</th>
                        <th className="px-3 py-2 font-semibold text-gray-700">SOP Name</th>
                        <th className="px-3 py-2 font-semibold text-gray-700 w-24">Month</th>
                        <th className="px-3 py-2 font-semibold text-gray-700 w-32">Expiry</th>
                        <th className="px-3 py-2 font-semibold text-gray-700 w-20">MCQs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {empModalDerived.rows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-3 py-10 text-center text-gray-500">
                            {empModalDerived.allCount === 0
                              ? 'No SOP schedule found for this employee.'
                              : 'No results match your search / filter.'}
                          </td>
                        </tr>
                      ) : (
                        empModalDerived.rows.map((r, idx) => {
                          const isDue = r.symbol !== '√';
                          return (
                            <tr
                              key={`emp-sop-${r.sopCode}-${idx}`}
                              className={`border-b border-gray-100 align-top ${
                                isDue ? 'bg-amber-50/30 hover:bg-amber-50/60' : 'hover:bg-emerald-50/30'
                              }`}
                            >
                              <td className="px-3 py-2">
                                {isDue ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-200 px-2 py-0.5 text-[10px] font-black text-amber-800">
                                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                                    Due
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 border border-emerald-200 px-2 py-0.5 text-[10px] font-black text-emerald-700">
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    Assigned
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-2 font-mono font-bold text-blue-700 whitespace-nowrap">{r.sopCode}</td>
                              <td className="px-3 py-2 text-gray-800 break-words" title={r.sopName}>{r.sopName}</td>
                              <td className="px-3 py-2 font-semibold text-gray-800 whitespace-nowrap">{r.month || '—'}</td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {r.expired ? (
                                  <span className="text-red-600 font-bold">
                                    Expired{r.targetDate ? ` (${r.targetDate.slice(0, 10)})` : ''}
                                  </span>
                                ) : r.targetDate ? (
                                  <span className="text-gray-800">{r.targetDate.slice(0, 10)}</span>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </td>
                              <td className="px-3 py-2 whitespace-nowrap">
                                {r.totalMcq > 0 ? (
                                  <span
                                    className={`font-semibold ${
                                      r.approvedMcq === r.totalMcq
                                        ? 'text-emerald-700'
                                        : r.approvedMcq > 0
                                        ? 'text-amber-700'
                                        : 'text-red-700'
                                    }`}
                                  >
                                    {r.approvedMcq}/{r.totalMcq}
                                  </span>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="px-5 py-2 border-t border-gray-200 bg-gray-50 rounded-b-lg flex items-center justify-between text-xs text-gray-600">
                  <span>
                    Total <span className="font-bold text-gray-900">{empModalDerived.allCount}</span> SOPs ·
                    {' '}<span className="font-bold text-emerald-700">{empModalDerived.totalAssigned}</span> assigned ·
                    {' '}<span className="font-bold text-amber-700">{empModalDerived.totalDue}</span> due
                  </span>
                  <button
                    onClick={() => setEmpModal(null)}
                    className="px-3 py-1 bg-gray-900 text-white rounded hover:bg-black"
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Unassigned Employees modal — list + Auto Assign Employees */}
      {unassignedEmpModalOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setUnassignedEmpModalOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-lg shadow-2xl flex flex-col w-full max-w-2xl"
            style={{ maxHeight: '80vh' }}
          >
            <div className="flex items-start justify-between px-5 py-3 border-b border-orange-100 bg-orange-50 rounded-t-lg">
              <div className="min-w-0">
                <div className="text-base font-bold text-gray-900 flex items-center gap-2">
                  <Users className="w-4 h-4 text-orange-600" />
                  Unassigned Employees
                </div>
                <div className="text-xs text-gray-600 mt-0.5">
                  {(viewData?.unassignedEmployees || []).length} employee
                  {(viewData?.unassignedEmployees || []).length === 1 ? '' : 's'} with no SOP assignments
                </div>
              </div>
              <button
                onClick={() => setUnassignedEmpModalOpen(false)}
                className="text-gray-400 hover:text-gray-700 text-2xl leading-none p-1"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="flex-1 overflow-auto">
              {(viewData?.unassignedEmployees || []).length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-gray-500">
                  All active employees have at least one SOP assignment.
                </div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    <tr>
                      <th className="px-5 py-2.5 w-10">#</th>
                      <th className="px-3 py-2.5">Name</th>
                      <th className="px-3 py-2.5">Designation</th>
                      <th className="px-3 py-2.5">Department</th>
                      <th className="px-3 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {(viewData?.unassignedEmployees || []).map((emp, idx) => (
                      <tr key={`${emp.department}|${emp.name}|${idx}`} className="hover:bg-orange-50/40">
                        <td className="px-5 py-2 text-gray-400">{idx + 1}</td>
                        <td className="px-3 py-2 font-medium text-gray-900">{emp.name}</td>
                        <td className="px-3 py-2 text-gray-700">{emp.designation}</td>
                        <td className="px-3 py-2">
                          <span
                            className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded text-white"
                            style={{ backgroundColor: deptColor(emp.department) }}
                          >
                            {deptAbbrLabel(emp.department)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => openAssignEmployee(emp)}
                            className="px-2.5 py-1 text-xs font-semibold rounded bg-orange-600 text-white hover:bg-orange-700"
                          >
                            Assign
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-lg flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">
                Assign picks department SOPs for one employee. Auto Assign ticks each designation on SOPs already scheduled in their department.
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => setUnassignedEmpModalOpen(false)}
                  className="px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded hover:bg-white"
                >
                  Close
                </button>
                <button
                  onClick={autoAssignEmployees}
                  disabled={
                    autoAssigningEmployees ||
                    autoAssigning ||
                    applying ||
                    !(viewData?.unassignedEmployees?.length)
                  }
                  className="px-3 py-1.5 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-60 disabled:cursor-not-allowed flex items-center gap-2 text-sm font-medium"
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  {autoAssigningEmployees ? 'Assigning…' : 'Auto Assign Employees'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Assign SOPs to one unassigned employee */}
      {assignEmp && (
        <div
          className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4"
          onClick={() => !assignEmpSaving && setAssignEmp(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-lg shadow-2xl flex flex-col w-full max-w-3xl"
            style={{ maxHeight: '85vh' }}
          >
            <div className="flex items-start justify-between px-5 py-3 border-b border-orange-100 bg-orange-50 rounded-t-lg">
              <div className="min-w-0">
                <div className="text-base font-bold text-gray-900">Assign SOPs</div>
                <div className="text-xs text-gray-600 mt-0.5">
                  {assignEmp.name} · {assignEmp.designation} · {deptAbbrLabel(assignEmp.department)}
                </div>
              </div>
              <button
                onClick={() => !assignEmpSaving && setAssignEmp(null)}
                className="text-gray-400 hover:text-gray-700 text-2xl leading-none p-1"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="px-5 py-3 border-b border-gray-200 bg-white">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 text-gray-400 w-4 h-4" />
                <input
                  type="text"
                  value={assignEmpSearch}
                  onChange={(e) => setAssignEmpSearch(e.target.value)}
                  placeholder="Search SOP code or name..."
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded text-sm"
                />
              </div>
              <div className="mt-2 text-xs text-gray-500">
                Showing SOPs already scheduled or owned by {deptAbbrLabel(assignEmp.department)}. Select the ones this employee should take.
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {assignEmpSops.length === 0 ? (
                <div className="px-5 py-10 text-center text-sm text-gray-500">
                  No SOPs found for {deptAbbrLabel(assignEmp.department)}.
                </div>
              ) : (
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-xs font-semibold uppercase tracking-wider text-gray-500">
                    <tr>
                      <th className="px-5 py-2.5 w-10">
                        <input
                          type="checkbox"
                          checked={
                            assignEmpSops.length > 0 &&
                            assignEmpSops.every((sop) => assignEmpSelected[sopCacheKey(sop.sopCode)])
                          }
                          onChange={(e) => {
                            const next: Record<string, boolean> = { ...assignEmpSelected };
                            for (const sop of assignEmpSops) {
                              next[sopCacheKey(sop.sopCode)] = e.target.checked;
                            }
                            setAssignEmpSelected(next);
                          }}
                          className="w-4 h-4"
                          aria-label="Select all SOPs"
                        />
                      </th>
                      <th className="px-3 py-2.5">SOP Code</th>
                      <th className="px-3 py-2.5">SOP Name</th>
                      <th className="px-3 py-2.5 w-24">Month</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {assignEmpSops.map((sop) => {
                      const key = sopCacheKey(sop.sopCode);
                      const ds = sop.deptStats.find((d) => d.department === assignEmp.department);
                      const monthNum = ds?.scheduledMonth || 0;
                      return (
                        <tr key={key} className="hover:bg-orange-50/40">
                          <td className="px-5 py-2">
                            <input
                              type="checkbox"
                              checked={!!assignEmpSelected[key]}
                              onChange={(e) =>
                                setAssignEmpSelected((prev) => ({ ...prev, [key]: e.target.checked }))
                              }
                              className="w-4 h-4"
                            />
                          </td>
                          <td className="px-3 py-2 font-mono font-bold text-blue-700 whitespace-nowrap">
                            {sop.displaySopCode || sop.sopCode}
                          </td>
                          <td className="px-3 py-2 text-gray-800">{sop.sopName}</td>
                          <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                            {monthNum ? MONTH_SHORT[monthNum - 1] : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 rounded-b-lg flex items-center justify-between gap-3">
              <span className="text-xs text-gray-500">
                {Object.values(assignEmpSelected).filter(Boolean).length} selected
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setAssignEmp(null)}
                  disabled={assignEmpSaving}
                  className="px-3 py-1.5 text-sm font-medium text-gray-700 border border-gray-300 rounded hover:bg-white disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveAssignEmployee}
                  disabled={assignEmpSaving || applying || assignEmpSops.length === 0}
                  className="px-3 py-1.5 bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-60 disabled:cursor-not-allowed text-sm font-medium"
                >
                  {assignEmpSaving ? 'Saving…' : 'Assign selected'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Add Employee modal — quick allocation helper for a specific SOP + department */}
      {addEmpModal && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setAddEmpModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-lg shadow-2xl flex flex-col w-full max-w-2xl"
            style={{ maxHeight: '80vh' }}
          >
            <div className="flex items-start justify-between px-5 py-3 border-b border-gray-200 bg-gray-50 rounded-t-lg">
              <div className="min-w-0">
                <div className="text-base font-bold text-gray-900">Add Employee Allocation</div>
                <div className="text-xs text-gray-600">
                  {addEmpModal.sopCode} · {deptAbbrLabel(addEmpModal.dept)}
                </div>
              </div>
              <button
                onClick={() => setAddEmpModal(null)}
                className="text-gray-400 hover:text-gray-700 text-2xl leading-none p-1"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="px-5 py-3 border-b border-gray-200 bg-white">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 text-gray-400 w-4 h-4" />
                <input
                  type="text"
                  value={addEmpSearch}
                  onChange={(e) => setAddEmpSearch(e.target.value)}
                  placeholder="Search employee name or designation..."
                  className="w-full pl-10 pr-3 py-2 border border-gray-300 rounded text-sm"
                />
              </div>
            </div>

            <div className="flex-1 overflow-auto px-5 py-3 space-y-2">
              {addEmpCandidates.length === 0 ? (
                <div className="text-sm text-gray-500">No employees found.</div>
              ) : (
                addEmpCandidates.map((emp, idx) => {
                  const key = `${emp.name}__${emp.designation}__${idx}`;
                  const checked = !!addEmpSelected[key];
                  return (
                    <label
                      key={key}
                      className="flex items-center justify-between gap-3 rounded border border-gray-200 px-3 py-2 hover:bg-gray-50 cursor-pointer"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-gray-900 truncate">{emp.name}</div>
                        <div className="text-xs text-gray-500 truncate">{emp.designation}</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setAddEmpSelected((prev) => ({ ...prev, [key]: e.target.checked }))
                        }
                        className="w-4 h-4"
                      />
                    </label>
                  );
                })
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-200 bg-gray-50 flex items-center justify-end gap-2 rounded-b-lg">
              <button
                type="button"
                onClick={() => setAddEmpModal(null)}
                className="px-3 py-1.5 rounded border border-gray-300 bg-white text-sm text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyAddEmployees}
                className="px-3 py-1.5 rounded bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
              >
                Add Selected
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Audit log modal — manual allocations made via the Manage SOP page */}
      {logsOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setLogsOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-lg shadow-2xl flex flex-col w-full max-w-5xl"
            style={{ maxHeight: '85vh' }}
          >
            <div className="flex items-start justify-between px-5 py-3 border-b border-gray-200 rounded-t-lg bg-gray-50">
              <div className="min-w-0">
                <div className="text-base font-bold text-gray-900">Allocation Logs</div>
                <div className="text-xs text-gray-600">
                  Every SOP allocation persisted from this page · {logs?.length ?? 0} entries
                </div>
              </div>
              <button
                onClick={() => setLogsOpen(false)}
                className="text-gray-400 hover:text-gray-700 text-2xl leading-none p-1"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            <div className="px-5 py-2 border-b border-gray-200 bg-white">
              <div className="relative">
                <Search className="absolute left-3 top-2.5 text-gray-400 w-4 h-4" />
                <input
                  type="text"
                  placeholder="Filter by SOP, dept, month, or designation..."
                  value={logSearch}
                  onChange={(e) => setLogSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 text-sm border border-gray-300 rounded bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              {logsLoading ? (
                <div className="p-8 text-center text-gray-600">Loading logs…</div>
              ) : logsError ? (
                <div className="p-8 text-center text-red-600">{logsError}</div>
              ) : filteredLogs.length === 0 ? (
                <div className="p-8 text-center text-gray-500">No allocations recorded yet.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700 w-12">#</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700 w-28">SOP NO</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700">SOP NAME</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700 w-20">DEPT</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700 w-24">MONTH / YEAR</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700">DESIGNATIONS</th>
                      <th className="px-3 py-2 text-right font-semibold text-gray-700 w-20">EMPLOYEES</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-700 w-40">LAST UPDATE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLogs.map((l, idx) => {
                      const updated = new Date(l.updatedAt);
                      const updatedText = isNaN(updated.getTime())
                        ? '—'
                        : updated.toLocaleString();
                      return (
                        <tr key={`log-${l.sopCode}-${l.department}-${l.month}-${l.year}-${idx}`} className="border-b border-gray-100 hover:bg-gray-50 align-top">
                          <td className="px-3 py-2 text-gray-500">{idx + 1}</td>
                          <td className="px-3 py-2 font-bold text-blue-700">{l.sopCode}</td>
                          <td className="px-3 py-2 text-gray-800 break-words">{l.sopName || '—'}</td>
                          <td className="px-3 py-2">
                            <span
                              className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                              style={{ color: '#fff', backgroundColor: deptColor(l.department) }}
                            >
                              {deptAbbrLabel(l.department)}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-gray-700 whitespace-nowrap">
                            <span className="font-semibold">{l.monthName}</span>
                            <span className="text-gray-400"> · {l.year}</span>
                          </td>
                          <td className="px-3 py-2">
                            {l.designations.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {l.designations.map(d => (
                                  <span
                                    key={`log-d-${l.sopCode}-${l.department}-${l.month}-${d}`}
                                    className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-700 border border-gray-200"
                                    title={d}
                                  >
                                    {d}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right font-bold text-gray-900">
                            {l.employeeCount}
                          </td>
                          <td className="px-3 py-2 text-gray-600 whitespace-nowrap">{updatedText}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            <div className="px-5 py-2 border-t border-gray-200 bg-gray-50 rounded-b-lg flex items-center justify-between text-xs text-gray-600">
              <span>
                Showing <span className="font-bold text-gray-900">{filteredLogs.length}</span>
                {logs && logs.length !== filteredLogs.length ? <> of {logs.length}</> : null} entries
              </span>
              <button
                onClick={() => setLogsOpen(false)}
                className="px-3 py-1 bg-gray-900 text-white rounded hover:bg-black"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SOP details modal — opened by clicking any count in the table */}
      {popup && (
        <div
          className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4"
          onClick={() => setPopup(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white rounded-lg shadow-2xl flex flex-col w-full max-w-3xl"
            style={{ maxHeight: '85vh' }}
          >
            {/* Header */}
            <div
              className="flex items-start justify-between px-5 py-3 border-b border-gray-200 rounded-t-lg"
              style={{ backgroundColor: `${deptColor(popup.dept)}12` }}
            >
              <div className="flex items-center gap-3 min-w-0">
                {popup.dept && (
                  <span
                    className="text-xs font-bold px-2.5 py-1 rounded shrink-0"
                    style={{ color: '#fff', backgroundColor: deptColor(popup.dept) }}
                  >
                    {deptAbbrLabel(popup.dept)}
                  </span>
                )}
                <div className="min-w-0">
                  <div className="text-base font-bold text-gray-900 truncate">{popup.title}</div>
                  <div className="text-xs text-gray-600 truncate">
                    {popup.subtitle} · {popup.items.length} SOP{popup.items.length !== 1 ? 's' : ''}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setPopup(null)}
                className="text-gray-400 hover:text-gray-700 text-2xl leading-none p-1"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* Body — scrollable table */}
            <div className="flex-1 overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700 w-12">#</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700 w-28">SOP NO</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">SOP NAME</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700 w-20">MONTH</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700 w-40">DESIGNATIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {popup.items.map((item, idx) => (
                    <tr
                      key={`pop-${item.sopCode}-${idx}`}
                      className="border-b border-gray-100 hover:bg-gray-50 align-top"
                    >
                      <td className="px-3 py-2 text-gray-500">{idx + 1}</td>
                      <td className="px-3 py-2 font-bold text-blue-700">{item.sopCode}</td>
                      <td className="px-3 py-2 text-gray-800 break-words">{item.sopName}</td>
                      <td className="px-3 py-2 text-gray-700">
                        {item.scheduledMonthName ? (
                          <span className="font-semibold text-blue-700">{item.scheduledMonthName}</span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {item.designations && item.designations.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {item.designations.map(d => (
                              <span
                                key={`pop-d-${item.sopCode}-${d}`}
                                className="px-1.5 py-0.5 rounded text-[10px] bg-gray-100 text-gray-700 border border-gray-200"
                                title={d}
                              >
                                {d}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Footer */}
            <div className="px-5 py-2 border-t border-gray-200 bg-gray-50 rounded-b-lg flex items-center justify-between text-xs text-gray-600">
              <span>
                Total SOPs: <span className="font-bold text-gray-900">{popup.items.length}</span>
              </span>
              <button
                onClick={() => setPopup(null)}
                className="px-3 py-1 bg-gray-900 text-white rounded hover:bg-black"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ManageSOPDashboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-gray-50">
          <div className="text-sm font-semibold text-gray-500">Loading…</div>
        </div>
      }
    >
      <ManageSOPDashboard />
    </Suspense>
  );
}

// ─── SopRowsBody ─────────────────────────────────────────────────────────────
// Renders every filtered row in the DOM. SopRow is memoized so scrolling does not
// re-render the dashboard chrome; table row windowing was removed because spacer
// `<tr>` heights are unreliable in browsers and caused intermittent blank gaps.
interface SopRowsBodyProps {
  filteredSops: ManageSOPViewResponse['sops'];
  viewMode: 'designation' | 'employee';
  unassignedSet: Set<string>;
  departments: string[];
  designationsByDept: Record<string, string[]>;
  allDesignations: string[];
  overrides: Record<string, Record<string, boolean>>;
  inductionOverrides: Record<string, Record<string, boolean>>;
  employeeOverrides: Record<string, Record<string, boolean>>;
  monthCells: Record<string, Record<string, boolean>>;
  manualAllocations?: ManageSOPViewResponse['manualAllocations'];
  manualDesignations?: ManageSOPViewResponse['manualDesignations'];
  employeesByDept: Record<string, Array<{ name: string; designation: string; assignedSopCodes?: string[] }>>;
  emptyInner: Record<string, boolean>;
  emptyManual: Record<string, number[]>;
  emptyManualDesig: Record<string, string[]>;
  getPrimaryDept: (sop: ManageSOPViewResponse['sops'][0]) => string;
  onEmployeeClick: (name: string, dept: string, designation: string) => void;
  onOpenAddEmployee: (sopCode: string, sopName: string, dept: string) => void;
  setDesigChecked: (sopCode: string, dept: string, fullName: string, value: boolean) => void;
  setEmployeeChecked: (sopCode: string, dept: string, employeeName: string, value: boolean) => void;
  setInductionChecked: (sopCode: string, dept: string, fullName: string, value: boolean) => void;
  setDeptChecked: (sopCode: string, dept: string, value: boolean) => void;
  setDeptInductionChecked: (sopCode: string, dept: string, value: boolean) => void;
  toggleMonthCell: (sopCode: string, dept: string, month: number, value: boolean) => void;
  openCountPopup: (e: React.MouseEvent, scope: CountScope) => void;
  searchQuery: string;
}

const SopRowsBody = memo(function SopRowsBody({
  filteredSops,
  viewMode,
  unassignedSet,
  departments,
  designationsByDept,
  allDesignations,
  overrides,
  inductionOverrides,
  employeeOverrides,
  monthCells,
  manualAllocations,
  manualDesignations,
  employeesByDept,
  emptyInner,
  emptyManual,
  emptyManualDesig,
  getPrimaryDept,
  onEmployeeClick,
  onOpenAddEmployee,
  setDesigChecked,
  setEmployeeChecked,
  setInductionChecked,
  setDeptChecked,
  setDeptInductionChecked,
  toggleMonthCell,
  openCountPopup,
  searchQuery,
}: SopRowsBodyProps) {
  if (filteredSops.length === 0) {
    return (
      <tbody>
        <tr>
          <td colSpan={6} className="px-6 py-8 text-center text-gray-500">
            No training data found
          </td>
        </tr>
      </tbody>
    );
  }

  return (
    <tbody>
      {filteredSops.map((sop, idx) => {
        const sopCodeKey = sopCacheKey(sop.sopCode);
        return (
          <SopRow
            key={`sop-${sop.sopCode}`}
            sop={sop}
            idx={idx}
            isUnassigned={unassignedSet.has(sopCodeKey)}
            departments={departments}
            designationsByDept={designationsByDept}
            allDesignations={allDesignations}
            primaryDept={getPrimaryDept(sop)}
            sopOverrides={overrides[sop.sopCode] || emptyInner}
            sopInductionOverrides={inductionOverrides[sop.sopCode] || emptyInner}
            sopEmployeeOverrides={employeeOverrides[sop.sopCode] || emptyInner}
            sopMonthCells={monthCells[sop.sopCode] || emptyInner}
            sopManualAllocations={manualAllocations?.[sopCodeKey] || emptyManual}
            sopManualDesignations={manualDesignations?.[sopCodeKey] || emptyManualDesig}
            viewMode={viewMode}
            employeesByDept={employeesByDept}
            onEmployeeClick={onEmployeeClick}
            onOpenAddEmployee={onOpenAddEmployee}
            setDesigChecked={setDesigChecked}
            setEmployeeChecked={setEmployeeChecked}
            setInductionChecked={setInductionChecked}
            setDeptChecked={setDeptChecked}
            setDeptInductionChecked={setDeptInductionChecked}
            toggleMonthCell={toggleMonthCell}
            openCountPopup={openCountPopup}
            searchQuery={searchQuery}
          />
        );
      })}
    </tbody>
  );
});

function deptHasEmployeeViewActivity(
  dept: string,
  sop: ManageSOPViewResponse['sops'][0],
  allDesignations: string[],
  sopOverrides: Record<string, boolean>,
  sopInductionOverrides: Record<string, boolean>,
  sopMonthCells: Record<string, boolean>,
  sopManualAllocations: Record<string, number[]>,
  sopManualDesignations: Record<string, string[]>,
): boolean {
  const deptStat = sop.deptStats.find((s) => s.department === dept);
  const manualDesigList = sopManualDesignations[dept] || [];
  const manualMonths = sopManualAllocations[dept] || [];

  for (let m = 1; m <= 12; m++) {
    const key = cellInnerKeyHelper(dept, m);
    const persisted = manualMonths.includes(m) || deptStat?.scheduledMonth === m;
    const selected = key in sopMonthCells ? !!sopMonthCells[key] : persisted;
    if (selected) return true;
  }

  return allDesignations.some((fullName) => {
    const key = desigKeyHelper(dept, fullName);
    if (key in sopOverrides) return !!sopOverrides[key];
    if (key in sopInductionOverrides) return !!sopInductionOverrides[key];
    return (
      (deptStat?.designations || []).some(
        (d) => d.designation === fullName && (d.isAssigned || (d.count || 0) > 0),
      ) || manualDesigList.includes(fullName)
    );
  });
}

// ─── SopRow ──────────────────────────────────────────────────────────────────
// Memoized row. Re-renders ONLY when its per-SOP state slices change. Live
// counts come through CountsContext, so changing a global count re-renders
// just the tiny CountValue subscribers, not the whole row body.
interface SopRowProps {
  sop: ManageSOPViewResponse['sops'][0];
  idx: number;
  isUnassigned: boolean;
  departments: string[];
  designationsByDept: Record<string, string[]>;
  /** Sorted union of every designation across all departments. */
  allDesignations: string[];
  primaryDept: string;
  sopOverrides: Record<string, boolean>;
  sopInductionOverrides: Record<string, boolean>;
  sopEmployeeOverrides: Record<string, boolean>;
  sopMonthCells: Record<string, boolean>;
  sopManualAllocations: Record<string, number[]>;
  sopManualDesignations: Record<string, string[]>;
  viewMode: 'designation' | 'employee';
  employeesByDept: Record<string, Array<{ name: string; designation: string; assignedSopCodes?: string[] }>>;
  onEmployeeClick: (name: string, dept: string, designation: string) => void;
  onOpenAddEmployee: (sopCode: string, sopName: string, dept: string) => void;
  setDesigChecked: (sopCode: string, dept: string, abbr: string, value: boolean) => void;
  setEmployeeChecked: (sopCode: string, dept: string, employeeName: string, value: boolean) => void;
  setInductionChecked: (sopCode: string, dept: string, abbr: string, value: boolean) => void;
  setDeptChecked: (sopCode: string, dept: string, value: boolean) => void;
  setDeptInductionChecked: (sopCode: string, dept: string, value: boolean) => void;
  toggleMonthCell: (sopCode: string, dept: string, month: number, value: boolean) => void;
  openCountPopup: (e: React.MouseEvent, scope: CountScope) => void;
  searchQuery: string;
}

const SopRow = memo(function SopRow({
  sop,
  idx,
  isUnassigned,
  departments,
  designationsByDept,
  allDesignations,
  primaryDept,
  sopOverrides,
  sopInductionOverrides,
  sopEmployeeOverrides,
  sopMonthCells,
  sopManualAllocations,
  sopManualDesignations,
  viewMode,
  employeesByDept,
  onEmployeeClick,
  onOpenAddEmployee,
  setDesigChecked,
  setEmployeeChecked,
  setInductionChecked,
  setDeptChecked,
  setDeptInductionChecked,
  toggleMonthCell,
  openCountPopup,
  searchQuery,
}: SopRowProps) {
  // Always color rows from the same source used by the Unassigned card count/filter.
  const rowBg = isUnassigned ? 'bg-red-50' : 'bg-green-50';
  const rowHover = isUnassigned ? 'hover:bg-red-100' : 'hover:bg-green-100';

  const visibleDepartments = useMemo(() => {
    if (viewMode !== 'employee') return departments;
    return departments.filter((dept) =>
      deptHasEmployeeViewActivity(
        dept,
        sop,
        allDesignations,
        sopOverrides,
        sopInductionOverrides,
        sopMonthCells,
        sopManualAllocations,
        sopManualDesignations,
      ),
    );
  }, [
    viewMode,
    departments,
    sop,
    allDesignations,
    sopOverrides,
    sopInductionOverrides,
    sopMonthCells,
    sopManualAllocations,
    sopManualDesignations,
  ]);

  return (
    <tr
      data-row-index={idx}
      className={`border-b border-gray-200 ${rowHover} align-top`}
    >
      {/* SR NO */}
      <td className={`w-10 px-2 py-3 text-center font-medium text-gray-900 ${rowBg} align-top`}>
        {idx + 1}
      </td>

      {/* SOP NO */}
      <td className={`w-24 px-3 py-3 font-bold text-blue-600 ${rowBg} border-l border-gray-200 align-top`}>
        {sop.displaySopCode || sop.sopCode || '—'}
      </td>

      {/* SOP NAME */}
      <td className={`w-56 px-3 py-3 font-semibold text-gray-900 ${rowBg} border-l border-gray-200 align-top`}>
        <div className="whitespace-normal break-words leading-snug text-xs" title={sop.sopName || 'N/A'}>
          {sop.sopName || '—'}
        </div>
        {sop.isDualLanguage && sop.gujaratiName && (
          <div className="mt-0.5 text-[11px] text-indigo-700 font-medium whitespace-normal break-words leading-snug" title={sop.gujaratiName}>
            {sop.gujaratiName}
          </div>
        )}
      </td>

      {/* DEPARTMENT */}
      <td className={`w-16 px-2 py-3 ${rowBg} border-l border-gray-200 align-top`}>
        {primaryDept ? (
          <span
            className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap"
            style={{ color: '#fff', backgroundColor: deptColor(primaryDept) }}
            title={primaryDept}
          >
            {deptAbbrLabel(primaryDept)}
          </span>
        ) : (
          <span className="text-xs text-gray-400">—</span>
        )}
      </td>

      {/* DEPARTMENT WITH DESIGNATION */}
      <td className={`px-3 py-3 ${rowBg} border-l border-gray-200 align-top ${viewMode === 'employee' ? 'min-w-[420px]' : ''}`}>
        <div className="flex flex-col gap-1.5">
          {visibleDepartments.map(dept => {
            const deptStat = sop.deptStats.find(s => s.department === dept);
            const manualDesigList = sopManualDesignations[dept] || [];

            // Native designations for this dept (from its own employees).
            const nativeDeptDesigSet = new Set(designationsByDept[dept] || []);

            // Show ALL designations (global union) so users can assign this SOP to
            // any designation — including ones from other departments.
            // isNative = true  → designation belongs to this dept's employees (dept colour)
            // isNative = false → cross-dept designation (muted grey with italic label)
            const desigStates = allDesignations.map(fullName => {
              const key = desigKeyHelper(dept, fullName);
              const isNative = nativeDeptDesigSet.has(fullName);
              const fallback =
                (deptStat?.designations || []).some(d => d.designation === fullName && d.isAssigned) ||
                // Prefill from Training Matrix history: existing records mean this
                // designation is already trained for this SOP in this department.
                (deptStat?.designations || []).some(d => d.designation === fullName && (d.count || 0) > 0) ||
                manualDesigList.some(d => d === fullName);
              const trainingChecked = key in sopOverrides ? sopOverrides[key] : fallback;
              const inductionChecked = !!sopInductionOverrides[key];
              return { fullName, abbr: desigAbbr(fullName), isNative, trainingChecked, inductionChecked };
            });

            const trainCheckedCount = desigStates.filter(s => s.trainingChecked).length;
            const indCheckedCount = desigStates.filter(s => s.inductionChecked).length;
            const allTrainChecked = allDesignations.length > 0 && trainCheckedCount === allDesignations.length;
            const someTrainChecked = trainCheckedCount > 0 && !allTrainChecked;
            const allIndChecked = allDesignations.length > 0 && indCheckedCount === allDesignations.length;
            const someIndChecked = indCheckedCount > 0 && !allIndChecked;

            return (
              <div key={`dwd-${sop.sopCode}-${dept}`} className={`flex flex-row gap-3 leading-tight ${viewMode === 'employee' ? 'items-start' : 'items-center'}`}>
                <div className="inline-flex items-center gap-1 w-16 shrink-0">
                  <label className="inline-flex items-center cursor-pointer" title={`Toggle all TRAINING designations under ${deptAbbrLabel(dept)}`}>
                    <TriStateCheckbox
                      checked={allTrainChecked}
                      indeterminate={someTrainChecked}
                      onChange={(v) => setDeptChecked(sop.sopCode, dept, v)}
                      className="w-3 h-3"
                    />
                  </label>
                  <span className="text-xs font-bold" style={{ color: deptColor(dept) }}>
                    {deptShortLabel(dept)}
                  </span>
                  <label className="inline-flex items-center cursor-pointer" title={`Toggle all INDUCTION designations under ${deptAbbrLabel(dept)}`}>
                    <TriStateCheckbox
                      checked={allIndChecked}
                      indeterminate={someIndChecked}
                      onChange={(v) => setDeptInductionChecked(sop.sopCode, dept, v)}
                      className="w-3 h-3 accent-orange-500"
                    />
                  </label>
                </div>
                {viewMode === 'designation' ? (
                  <div className="flex flex-row flex-nowrap items-center gap-x-3">
                    {allDesignations.length === 0 ? (
                      <span className="text-[11px] text-gray-400 italic">No designations</span>
                    ) : desigStates.map(({ fullName, abbr, isNative, trainingChecked, inductionChecked }) => (
                      <div
                        key={`dwd-${sop.sopCode}-${dept}-${fullName}`}
                        className="whitespace-nowrap inline-flex items-center gap-1"
                        title={`${fullName}${isNative ? '' : ' (cross-dept)'} — left: Training Check · right: Induction Training`}
                      >
                        <input
                          type="checkbox"
                          checked={trainingChecked}
                          onChange={(e) => setDesigChecked(sop.sopCode, dept, fullName, e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-3 h-3 cursor-pointer"
                          aria-label={`Training: ${fullName}`}
                        />
                        {/* Checked designations should always adopt the dept colour immediately.
                            Unchecked cross-dept labels stay muted to preserve visual distinction. */}
                        <span
                          className={`text-[11px] font-semibold ${!isNative && !trainingChecked && !inductionChecked ? 'italic opacity-60' : ''}`}
                          style={{
                            color: (trainingChecked || inductionChecked)
                              ? deptColor(dept)
                              : (isNative ? deptColor(dept) : '#6b7280'),
                          }}
                        >
                          {abbr}
                        </span>
                        <input
                          type="checkbox"
                          checked={inductionChecked}
                          onChange={(e) => setInductionChecked(sop.sopCode, dept, fullName, e.target.checked)}
                          onClick={(e) => e.stopPropagation()}
                          className="w-3 h-3 cursor-pointer accent-orange-500"
                          aria-label={`Induction: ${fullName}`}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex flex-col gap-1 flex-1 min-w-0">
                    <div className="flex-1 min-w-0">
                      {(() => {
                        const norm = (v: unknown) => String(v || '').trim().toLowerCase();
                        const byDesignation = new Map(
                          desigStates.map((s) => [
                            norm(s.fullName),
                            {
                              trainingChecked: s.trainingChecked,
                              inductionChecked: s.inductionChecked,
                              fullName: s.fullName,
                            },
                          ]),
                        );
                        const hasSelectedMonth = (() => {
                          const manualMonths = sopManualAllocations[dept] || [];
                          for (let m = 1; m <= 12; m++) {
                            const key = cellInnerKeyHelper(dept, m);
                            const persisted = manualMonths.includes(m) || (deptStat?.scheduledMonth === m);
                            const selected = key in sopMonthCells ? !!sopMonthCells[key] : persisted;
                            if (selected) return true;
                          }
                          return false;
                        })();

                        const findDesigState = (empDesignation: string) => {
                          const exact = byDesignation.get(norm(empDesignation));
                          if (exact) return exact;
                          return desigStates.find((s) => designationsOverlap(empDesignation, s.fullName));
                        };
                        const thisSopKey = sopCacheKey(sop.sopCode);
                        const selectedEmployees = (employeesByDept[dept] || []).filter((emp) => {
                          const assignedCodes = new Set((emp.assignedSopCodes || []).map((c) => sopCacheKey(c)));
                          if (assignedCodes.has(thisSopKey)) return true;
                          if (!hasSelectedMonth) return false;
                          if (findDesigState(emp.designation)?.trainingChecked) return true;
                          const overrideKey = desigKeyHelper(dept, emp.designation);
                          return overrideKey in sopOverrides && !!sopOverrides[overrideKey];
                        });

                        if (selectedEmployees.length === 0) {
                          return (
                            <span className="text-[11px] text-gray-400 italic">No assigned employees</span>
                          );
                        }

                        const employeeColumns = chunkIntoColumns(selectedEmployees, EMPLOYEE_DISPLAY_COLUMNS);
                        return (
                          <div className="grid grid-cols-3 gap-x-4 gap-y-1 items-start flex-1 min-w-0">
                            {employeeColumns.map((colEmps, colIdx) => (
                              <div
                                key={`emp-col-${sop.sopCode}-${dept}-${colIdx}`}
                                className="flex flex-col gap-y-0.5 min-w-0"
                              >
                                {colEmps.map((emp, empIdx) => {
                                  const matched = findDesigState(emp.designation);
                                  const assignedToSop = (emp.assignedSopCodes || []).some(
                                    (c) => sopCacheKey(c) === thisSopKey,
                                  );
                                  // Employee mode is strictly per person. A
                                  // designation checkbox must never make every
                                  // same-designation employee look assigned.
                                  const persistedChecked = assignedToSop;
                                  const empOverrideKey = empOverrideKeyHelper(dept, emp.name);
                                  // A pending per-person tick always wins, so
                                  // un-ticking an individually assigned employee
                                  // no longer snaps straight back to checked.
                                  const trainingChecked = empOverrideKey in sopEmployeeOverrides
                                    ? !!sopEmployeeOverrides[empOverrideKey]
                                    : persistedChecked;
                                  const inductionChecked = !!matched?.inductionChecked;
                                  const fullName = matched?.fullName || emp.designation;
                                  // Unsaved edit — flagged so a click is visibly
                                  // registered and queued for Update, not silent.
                                  const pendingEmpEdit =
                                    empOverrideKey in sopEmployeeOverrides &&
                                    !!sopEmployeeOverrides[empOverrideKey] !== assignedToSop;
                                  return (
                                    <div
                                      key={`emp-${sop.sopCode}-${dept}-${emp.name}-${colIdx}-${empIdx}`}
                                      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-0.5 ${
                                        pendingEmpEdit ? 'bg-amber-50 ring-1 ring-amber-300' : ''
                                      }`}
                                      title={
                                        pendingEmpEdit
                                          ? `${emp.name} — ${trainingChecked ? 'will be assigned' : 'will be removed'} on Update`
                                          : `${emp.name} (${emp.designation}) — left: Training Check · right: Induction Training`
                                      }
                                    >
                                      <input
                                        type="checkbox"
                                        checked={trainingChecked}
                                        onChange={(ev) => {
                                          // Per person — toggling one employee must
                                          // not move their same-designation colleagues.
                                          setEmployeeChecked(sop.sopCode, dept, emp.name, ev.target.checked);
                                        }}
                                        className="w-3 h-3 cursor-pointer shrink-0"
                                        aria-label={`Training: ${emp.name}`}
                                      />
                                      <button
                                        type="button"
                                        onClick={(ev) => {
                                          ev.stopPropagation();
                                          onEmployeeClick(emp.name, dept, emp.designation);
                                        }}
                                        className={`font-medium text-[11px] hover:underline cursor-pointer truncate ${
                                          pendingEmpEdit && !trainingChecked
                                            ? 'text-amber-700 line-through'
                                            : 'text-blue-700'
                                        }`}
                                        title={`${emp.name} (${emp.designation})`}
                                      >
                                        {highlightText(emp.name, searchQuery)}
                                      </button>
                                      <input
                                        type="checkbox"
                                        checked={inductionChecked}
                                        onChange={(ev) => {
                                          setInductionChecked(sop.sopCode, dept, fullName, ev.target.checked);
                                        }}
                                        className="w-3 h-3 cursor-pointer accent-orange-500 shrink-0"
                                        aria-label={`Induction: ${emp.name}`}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onOpenAddEmployee(sop.sopCode, sop.sopName || sop.sopCode, dept);
                        }}
                        className="inline-flex items-center rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-700 hover:bg-blue-100"
                        title={`Add employees for ${deptAbbrLabel(dept)} to ${sop.sopCode}`}
                      >
                        + Add Employee
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </td>

      {/* MONTHS */}
      <td className={`px-3 py-3 ${rowBg} border-l border-gray-200 align-top`}>
        <div className="flex flex-row flex-nowrap gap-2 items-stretch">
          {MONTH_SHORT.map((month, mIdx) => {
            const monthNum = mIdx + 1;
            const entries = departments.map(dept => {
              const deptStat = sop.deptStats.find(s => s.department === dept);
              const manualDesigList = sopManualDesignations[dept] || [];
              const active = allDesignations.some(fullName => {
                const key = desigKeyHelper(dept, fullName);
                if (key in sopOverrides) return !!sopOverrides[key];
                return (
                  (deptStat?.designations || []).some(d => d.designation === fullName && d.isAssigned) ||
                  (deptStat?.designations || []).some(d => d.designation === fullName && (d.count || 0) > 0) ||
                  manualDesigList.some(d => d === fullName)
                );
              });
              // Prefill selected state from:
              //   1) Manual allocations done through this page
              //   2) Scheduled month for this dept from the matrix assignment snapshot
              //      (the source-of-truth month mapping shown in Training Matrix).
              const cellKey = cellInnerKeyHelper(dept, monthNum);
              const persistedSelected =
                (sopManualAllocations[dept] || []).includes(monthNum) ||
                (deptStat?.scheduledMonth === monthNum);
              const selected = cellKey in sopMonthCells
                ? !!sopMonthCells[cellKey]
                : persistedSelected;
              return { dept, active: active || selected, selected };
            });
            return (
              <div key={`mo-${sop.sopCode}-${month}`} className="flex flex-col leading-tight min-w-[48px]">
                <div className="text-xs font-bold text-blue-700 mb-1 pb-0.5 border-b-2 border-blue-300">
                  {month}
                </div>
                {entries.map(e => {
                  const baseClasses = 'text-[11px] whitespace-nowrap rounded px-1 inline-flex items-center gap-1 transition-colors';
                  let stateClasses = '';
                  let stateStyle: React.CSSProperties = {};
                  if (e.selected) {
                    stateClasses = 'cursor-pointer';
                    stateStyle = {
                      backgroundColor: `${deptColor(e.dept)}33`,
                      boxShadow: `inset 0 0 0 1.5px ${deptColor(e.dept)}`,
                    };
                  } else if (e.active) {
                    stateClasses = 'cursor-pointer';
                  }
                  return (
                    <label
                      key={`mo-${sop.sopCode}-${month}-${e.dept}`}
                      className={`${baseClasses} ${stateClasses} ${!e.active && !e.selected ? 'opacity-90' : ''}`}
                      style={stateStyle}
                      title={e.active ? `Toggle ${deptAbbrLabel(e.dept)} training in ${month}` : `Check a designation under ${deptAbbrLabel(e.dept)} first`}
                    >
                      <input
                        type="checkbox"
                        checked={e.selected}
                        disabled={!e.active}
                        onChange={(ev) => toggleMonthCell(sop.sopCode, e.dept, monthNum, ev.target.checked)}
                        onClick={(ev) => ev.stopPropagation()}
                        className="w-3 h-3 cursor-pointer"
                      />
                      {/* Color reflects this month's selection state, NOT the dept's
                          overall designation state — otherwise an SOP assigned to QA in
                          Jan/Feb would still paint QA in purple under Mar–Dec, which
                          looks like every month is allocated. Gray = not selected. */}
                      <span className="font-semibold" style={{ color: e.selected ? deptColor(e.dept) : '#9ca3af' }}>
                        {deptShortLabel(e.dept)}
                      </span>
                      <button
                        type="button"
                        onClick={(ev) => openCountPopup(ev, {
                          kind: 'dept-month',
                          dept: e.dept,
                          month: monthNum,
                          monthName: month,
                        })}
                        className="text-gray-500 hover:underline cursor-pointer font-medium px-0.5"
                        title={`View SOPs in ${deptAbbrLabel(e.dept)} for ${month}`}
                      >
                        <CellCountText dept={e.dept} month={monthNum} />
                      </button>
                    </label>
                  );
                })}
                <div className="mt-1 pt-0.5 border-t border-blue-200 text-[11px] font-bold text-blue-700 whitespace-nowrap">
                  Σ{' '}
                  <button
                    type="button"
                    onClick={(ev) => openCountPopup(ev, {
                      kind: 'month-total',
                      month: monthNum,
                      monthName: month,
                    })}
                    className="hover:underline cursor-pointer"
                    title={`View SOPs trained in ${month}`}
                  >
                    <MonthSumText month={monthNum} />
                  </button>
                </div>
              </div>
            );
          })}

          {/* Global TOTAL summary block */}
          <div
            className="flex flex-col leading-tight min-w-[64px] pl-2 ml-1 border-l-2 border-purple-300"
            title="Department-wise totals across all SOPs"
          >
            <div className="text-xs font-bold text-purple-700 mb-1 pb-0.5 border-b-2 border-purple-300">
              TOTAL
            </div>
            {departments.map(dept => (
              <span key={`gtot-${dept}`} className="text-[11px] whitespace-nowrap">
                <span className="font-semibold" style={{ color: deptColor(dept) }}>
                  {deptShortLabel(dept)}
                </span>{' '}
                <button
                  type="button"
                  onClick={(ev) => openCountPopup(ev, { kind: 'dept-total', dept })}
                  className="text-gray-800 font-semibold hover:underline cursor-pointer"
                  title={`View SOPs trained in ${deptAbbrLabel(dept)}`}
                >
                  <DeptTotalText dept={dept} />
                </button>
              </span>
            ))}
            <div className="mt-1 pt-0.5 border-t border-purple-200 text-[11px] font-bold text-purple-700 whitespace-nowrap">
              Σ{' '}
              <button
                type="button"
                onClick={(ev) => openCountPopup(ev, { kind: 'grand-total' })}
                className="hover:underline cursor-pointer"
                title="View all SOPs with training"
              >
                <GrandTotalText />
              </button>
            </div>
          </div>
        </div>
      </td>
    </tr>
  );
});

interface TriStateCheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  className?: string;
}

function TriStateCheckbox({ checked, indeterminate = false, onChange, className = '' }: TriStateCheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className={className}
    />
  );
}

interface SortableThProps {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  dir: SortDir;
  onClick: (k: SortKey) => void;
  className?: string;
  highlighted?: boolean;
}

function SortableTh({ label, sortKey, current, dir, onClick, className = '', highlighted = false }: SortableThProps) {
  const active = current === sortKey;
  const arrow = !active ? '↕' : dir === 'asc' ? '▲' : '▼';
  return (
    <th
      onClick={() => onClick(sortKey)}
      className={`py-3 font-semibold cursor-pointer select-none hover:bg-opacity-80 ${highlighted ? '' : 'bg-gray-100 text-gray-900 hover:bg-gray-200'} ${className}`}
    >
      <span className="inline-flex items-center gap-1">
        <span>{label}</span>
        <span className={`text-[10px] ${active ? 'opacity-100' : 'opacity-40'}`}>{arrow}</span>
      </span>
    </th>
  );
}
