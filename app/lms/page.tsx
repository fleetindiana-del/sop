'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import {
  GraduationCap, LogOut, Search, PlayCircle, BookOpen, Clock,
  CheckCircle2, AlertCircle, Loader2, RefreshCw,
  FileText, ClipboardList, TrendingUp, Award, Calendar,
  ArrowDown, ArrowUp, ChevronsUpDown, Check, X, EyeOff,
} from 'lucide-react';
import {
  clearLmsClientCache,
  lmsClientFields,
  LMS_CLIENT_FRESH_MS,
  readLmsClientCache,
  writeLmsClientCache,
} from '@/lib/lmsCache';
import { hasGujaratiScript, isPlaceholderSopName, isInvalidSopAssignmentCode } from '@/lib/sop-name-resolution';
import { getDeptLabelClasses, normalizeDepartment } from '@/lib/department-colors';
import type { SopAssetFlags } from '@/app/api/lms/assets/route';

const LearnerTrainingCalendar = dynamic(
  () => import('@/components/lms/LearnerTrainingCalendar'),
  { ssr: false },
);

// ─── Types ────────────────────────────────────────────────────────────────────

interface SopAssignment {
  sopCode: string;
  sopName?: string;
  sopNameGujarati?: string;
  sopDepartment?: string;
  month: number;
  monthName: string;
  year: number;
  trainingType: 'induction' | 'training';
  status?: string;
  examDate?: string;
  /** YYYY-MM-DD — document expiry from SOP registry/family. */
  expiryDate?: string;
}

interface Employee {
  id: string;
  name: string;
  designation: string;
  department: string;
}

interface CertRecord {
  _id: string;
  certificateNumber: string;
  sopCode: string;
  sopName: string;
  completedAt: string;
  quizScore: number;
  hasPractical: boolean;
}

interface ProgressRecord {
  sopCode: string;
  status: 'not_started' | 'in_progress' | 'completed';
  overallPercentage: number;
  lastAccessedAt: string;
  completedAt?: string;
}

type FilterTab = 'all' | 'in_progress' | 'completed' | 'overdue' | 'due' | 'upcoming';
type SortKey = 'sopCode' | 'sopName' | 'department' | 'type' | 'status' | 'approved' | 'due' | 'progress';
type SortDir = 'asc' | 'desc';
interface SortState { key: SortKey; dir: SortDir; }

/** Due column: month name only (e.g. "August"). */
function formatDueMonth(a: SopAssignment): string {
  if (a.monthName?.trim()) {
    const name = a.monthName.trim();
    // Prefer full month; fall back if stored as "Jan".
    if (name.length <= 3) {
      const d = new Date(a.year, a.month - 1, 1);
      return d.toLocaleString('en-US', { month: 'long' });
    }
    return name;
  }
  const d = new Date(a.year, a.month - 1, 1);
  return d.toLocaleString('en-US', { month: 'long' });
}

interface DashboardCache {
  assignments: SopAssignment[];
  progress: ProgressRecord[];
  certificates: CertRecord[];
  assets?: Record<string, SopAssetFlags>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function currentMonthStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function assignmentMonthStart(a: SopAssignment): Date {
  return new Date(a.year, a.month - 1, 1);
}

/** Scheduled for a month after the current calendar month. */
function isFutureScheduled(a: SopAssignment): boolean {
  return assignmentMonthStart(a) > currentMonthStart();
}

/** Due now — scheduled for the current month or earlier. */
function isDue(a: SopAssignment): boolean {
  return assignmentMonthStart(a) <= currentMonthStart();
}

function isOverdue(a: SopAssignment): boolean {
  if (!isDue(a)) return false;
  return assignmentMonthStart(a) < currentMonthStart();
}

type ScheduleStatus = 'upcoming' | 'due' | 'overdue';

function scheduleStatus(a: SopAssignment): ScheduleStatus {
  if (isFutureScheduled(a)) return 'upcoming';
  if (isOverdue(a)) return 'overdue';
  return 'due';
}

function statusLabel(s: FilterTab): string {
  if (s === 'in_progress')  return 'In Progress';
  if (s === 'completed')    return 'Completed';
  if (s === 'overdue')      return 'Overdue';
  if (s === 'due')          return 'Due';
  if (s === 'upcoming')     return 'Upcoming';
  return 'All';
}

function validAssignments(list: SopAssignment[]): SopAssignment[] {
  return list.filter((a) => !isInvalidSopAssignmentCode(a.sopCode));
}

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

/** Normalize SOP codes so QAGE4 and QAGE04 resolve to the same progress lookup. */
function progressLookupKey(code: string): string {
  return stripVersion(code).replace(/^([A-Z]+)0+(\d+)/, '$1$2');
}

function buildProgressMap(records: ProgressRecord[]): Map<string, ProgressRecord> {
  const map = new Map<string, ProgressRecord>();
  for (const p of records) {
    const exact = String(p.sopCode || '').trim();
    if (!exact) continue;
    const norm = progressLookupKey(exact);
    const prefer = (existing: ProgressRecord | undefined, next: ProgressRecord) => {
      if (!existing) return next;
      // Keep the more advanced / more recently accessed record for a SOP family.
      if ((next.overallPercentage ?? 0) !== (existing.overallPercentage ?? 0)) {
        return (next.overallPercentage ?? 0) > (existing.overallPercentage ?? 0) ? next : existing;
      }
      return new Date(next.lastAccessedAt ?? 0).getTime() >= new Date(existing.lastAccessedAt ?? 0).getTime()
        ? next
        : existing;
    };
    map.set(exact, prefer(map.get(exact), p));
    map.set(norm, prefer(map.get(norm), p));
    const stripped = stripVersion(exact);
    if (stripped !== exact && stripped !== norm) {
      map.set(stripped, prefer(map.get(stripped), p));
    }
  }
  return map;
}

function getProgress(
  map: Map<string, ProgressRecord>,
  sopCode: string,
): ProgressRecord | undefined {
  const exact = String(sopCode || '').trim();
  if (!exact) return undefined;
  return (
    map.get(exact) ||
    map.get(progressLookupKey(exact)) ||
    map.get(stripVersion(exact))
  );
}

/** True only when the learner has real started progress on this SOP. */
function isActivelyInProgress(progress?: ProgressRecord): boolean {
  if (!progress) return false;
  if (progress.status !== 'in_progress') return false;
  if ((progress.overallPercentage ?? 0) <= 0) return false;
  return true;
}

function cleanDisplayText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function displayTrainingName(a: SopAssignment): { english: string; gujarati?: string } {
  let english = cleanDisplayText(a.sopName || a.sopCode);
  let gujarati = a.sopNameGujarati ? cleanDisplayText(a.sopNameGujarati) : undefined;
  if (hasGujaratiScript(english) && !gujarati) {
    gujarati = english;
    english = a.sopCode;
  }
  if (isPlaceholderSopName(english, a.sopCode)) {
    english = gujarati || a.sopCode;
  }
  return { english, gujarati: gujarati && gujarati !== english ? gujarati : undefined };
}

/** Certificate only when training is fully done (100%), not the 90% pre-quiz cap. */
function isFullyComplete(progress?: ProgressRecord): boolean {
  return progress?.status === 'completed' && (progress.overallPercentage ?? 0) >= 100;
}

/** Document expiry (calendar day), independent of training-schedule due/overdue. */
function isSopDocumentExpired(a: Pick<SopAssignment, 'expiryDate'>): boolean {
  if (!a.expiryDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(`${a.expiryDate}T00:00:00`);
  return exp < today;
}

function statusSortRank(
  status: ProgressRecord['status'],
  schedule: ScheduleStatus,
): number {
  if (status === 'completed') return 0;
  if (status === 'in_progress') return 1;
  if (schedule === 'overdue') return 2;
  if (schedule === 'due') return 3;
  return 4;
}

function nextSort(prev: SortState, key: SortKey): SortState {
  if (prev.key === key) return { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' };
  const ascKeys: SortKey[] = ['sopCode', 'sopName', 'department', 'type', 'status', 'approved', 'due'];
  return { key, dir: ascKeys.includes(key) ? 'asc' : 'desc' };
}

function ProgressBar({ pct, color = 'purple' }: { pct: number; color?: string }) {
  const bg =
    color === 'green' ? 'bg-green-500'
    : color === 'amber' ? 'bg-amber-500'
    : color === 'sky' ? 'bg-sky-500'
    : 'bg-purple-500';
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
      <div className={`h-full rounded-full transition-all duration-500 ${bg}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function StatusIcon({
  status,
  schedule,
}: {
  status: ProgressRecord['status'];
  schedule: ScheduleStatus;
}) {
  return (
    <div className={`mx-auto flex h-7 w-7 items-center justify-center rounded-md ${
      status === 'completed' ? 'bg-green-50'
        : status === 'in_progress' ? 'bg-purple-50'
        : schedule === 'overdue' ? 'bg-red-50'
        : schedule === 'due' ? 'bg-amber-50'
        : 'bg-sky-50'
    }`}>
      {status === 'completed'
        ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
        : status === 'in_progress'
        ? <PlayCircle className="h-3.5 w-3.5 text-purple-600" />
        : schedule === 'overdue'
        ? <AlertCircle className="h-3.5 w-3.5 text-red-500" />
        : schedule === 'due'
        ? <Clock className="h-3.5 w-3.5 text-amber-600" />
        : <Clock className="h-3.5 w-3.5 text-sky-500" />}
    </div>
  );
}

function SortHeader({
  label, sortKey, sort, onSort, align = 'left',
}: {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: 'left' | 'right' | 'center';
}) {
  const active = sort.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={`cursor-pointer select-none px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider transition hover:text-gray-700 ${
        active ? 'text-gray-700' : 'text-gray-500'
      } ${align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'}`}
    >
      <span className={`inline-flex items-center gap-0.5 ${align === 'right' ? 'w-full justify-end' : align === 'center' ? 'w-full justify-center' : ''}`}>
        {label}
        {active
          ? (sort.dir === 'asc' ? <ArrowUp className="h-2.5 w-2.5 shrink-0" /> : <ArrowDown className="h-2.5 w-2.5 shrink-0" />)
          : <ChevronsUpDown className="h-2.5 w-2.5 shrink-0 opacity-30" />}
      </span>
    </th>
  );
}

function TrainingNameCell({ assignment }: { assignment: SopAssignment }) {
  const { english, gujarati } = displayTrainingName(assignment);
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-gray-800" title={english}>{english}</p>
      {gujarati && (
        <p className="truncate text-[11px] font-medium text-indigo-700" title={gujarati}>{gujarati}</p>
      )}
    </div>
  );
}

function DepartmentCell({ department }: { department?: string }) {
  const dept = department?.trim() ? normalizeDepartment(department) : '—';
  const labelCls = department?.trim() ? getDeptLabelClasses(dept) : 'bg-gray-100 text-gray-500';
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${labelCls}`} title={dept}>
      {dept}
    </span>
  );
}

function trainingStatusLabel(
  status: ProgressRecord['status'],
  schedule: ScheduleStatus,
): string {
  if (status === 'completed') return 'Completed';
  if (status === 'in_progress') return 'In Progress';
  if (schedule === 'upcoming') return 'Upcoming';
  if (schedule === 'overdue') return 'Overdue';
  return 'Due';
}

// ─── Per-SOP resource quick actions ──────────────────────────────────────────

interface ResourceDef {
  kind: string;
  label: string;
  Icon: typeof PlayCircle;
  enFlag: keyof SopAssetFlags;
  guFlag: keyof SopAssetFlags;
  enStep: string;        // journey step id for the English variant
  guStep: string;        // journey step id for the Gujarati variant
  primary?: boolean;     // emphasised styling for the assessment
}

const RESOURCE_DEFS: ResourceDef[] = [
  { kind: 'video', label: 'Video',      Icon: PlayCircle,    enFlag: 'videoEn',  guFlag: 'videoGu',  enStep: 'videoEn',  guStep: 'videoGu' },
  { kind: 'ppt',   label: 'PPT',        Icon: FileText,      enFlag: 'slidesEn', guFlag: 'slidesGu', enStep: 'slidesEn', guStep: 'slidesGu' },
  { kind: 'sop',   label: 'SOP',        Icon: BookOpen,      enFlag: 'sop',      guFlag: 'sopGu',    enStep: 'sopPdf',   guStep: 'sopPdfGu' },
  { kind: 'test',  label: 'Start Test', Icon: ClipboardList, enFlag: 'mcqEn',    guFlag: 'mcqGu',    enStep: 'quiz',     guStep: 'quizGu', primary: true },
];

function ResourceButtons({
  asset,
  examLocked,
  lockReason,
  onSelect,
}: {
  asset: SopAssetFlags;
  examLocked?: boolean;
  lockReason?: string;
  onSelect: (def: ResourceDef) => void;
}) {
  const items = RESOURCE_DEFS.filter((d) => asset[d.enFlag] || asset[d.guFlag]);
  if (items.length === 0) return null;

  return (
    <div className="flex flex-nowrap items-center justify-end gap-1">
      {items.map((d) => {
        const Icon = d.Icon;
        const both = asset[d.enFlag] && asset[d.guFlag];
        const locked = d.kind === 'test' && examLocked;
        return (
          <button
            key={d.kind}
            onClick={() => { if (!locked) onSelect(d); }}
            disabled={locked}
            title={locked ? (lockReason || 'Exam locked') : d.label}
            className={`inline-flex items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] font-semibold transition ${
              locked
                ? 'cursor-not-allowed border-red-200 bg-red-50 text-red-400'
                : d.primary
                ? 'border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100'
                : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
            }`}
          >
            <Icon className="h-3 w-3" />
            {d.label}
            {both && !locked && (
              <span className="rounded bg-indigo-50 px-0.5 text-[8px] font-bold text-indigo-500">EN/ગુજ</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Language chooser shown when a resource exists in both English and Gujarati.
function LanguagePicker({
  def,
  onPick,
  onClose,
}: {
  def: ResourceDef;
  onPick: (stepId: string) => void;
  onClose: () => void;
}) {
  const Icon = def.Icon;
  const what = def.kind === 'test' ? 'the assessment' : `the ${def.label}`;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-xs rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-purple-100">
          <Icon className="h-6 w-6 text-purple-600" />
        </div>
        <h3 className="text-base font-bold text-gray-800">Choose language</h3>
        <p className="mt-1 text-sm text-gray-500">
          {def.kind === 'test'
            ? 'Dual SOP — complete either English or Gujarati. Passing one issues your certificate.'
            : `Select the language for ${what}.`}
        </p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            onClick={() => onPick(def.enStep)}
            className="rounded-lg border border-gray-200 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            English
          </button>
          <button
            onClick={() => onPick(def.guStep)}
            className="rounded-lg bg-purple-600 py-2.5 text-sm font-semibold text-white hover:bg-purple-700"
          >
            ગુજરાતી
          </button>
        </div>
        <button
          onClick={onClose}
          className="mt-3 w-full rounded-lg py-2 text-xs font-medium text-gray-500 hover:bg-gray-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function TrainingTable({
  rows,
  progressMap,
  certMap,
  assetsMap,
  onOpenStep,
  onCertificate,
  onPrefetch,
  onIgnoreSop,
  ignoringKey,
}: {
  rows: SopAssignment[];
  progressMap: Map<string, ProgressRecord>;
  certMap: Map<string, CertRecord>;
  assetsMap: Record<string, SopAssetFlags>;
  onOpenStep: (sopCode: string, stepId: string) => void;
  onCertificate: (sopCode: string) => void;
  onPrefetch?: (sopCode: string) => void;
  onIgnoreSop?: (a: SopAssignment) => void;
  ignoringKey?: string | null;
}) {
  const [sort, setSort] = useState<SortState>({ key: 'sopCode', dir: 'asc' });
  const [picker, setPicker] = useState<{ sopCode: string; def: ResourceDef } | null>(null);

  // Open a resource: jump straight to it, or ask which language when both exist.
  const selectResource = (sopCode: string, def: ResourceDef) => {
    const asset = assetsMap[sopCode];
    const hasEn = Boolean(asset?.[def.enFlag]);
    const hasGu = Boolean(asset?.[def.guFlag]);
    if (hasEn && hasGu) {
      setPicker({ sopCode, def });
    } else {
      onOpenStep(sopCode, hasEn ? def.enStep : def.guStep);
    }
  };

  const sortedRows = useMemo(() => {
    const list = [...rows];
    const dir = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const pa = getProgress(progressMap, a.sopCode);
      const pb = getProgress(progressMap, b.sopCode);
      const sa = pa?.status ?? 'not_started';
      const sb = pb?.status ?? 'not_started';
      const schedA = scheduleStatus(a);
      const schedB = scheduleStatus(b);

      let cmp = 0;
      switch (sort.key) {
        case 'sopCode':
          cmp = a.sopCode.localeCompare(b.sopCode);
          break;
        case 'sopName':
          cmp = displayTrainingName(a).english.localeCompare(displayTrainingName(b).english);
          break;
        case 'department':
          cmp = (a.sopDepartment || '').localeCompare(b.sopDepartment || '');
          break;
        case 'type':
          cmp = a.trainingType.localeCompare(b.trainingType);
          break;
        case 'status':
          cmp = statusSortRank(sa, schedA) - statusSortRank(sb, schedB);
          break;
        case 'approved': {
          const aa = assetsMap[a.sopCode]?.lmsApproved !== false ? 1 : 0;
          const ab = assetsMap[b.sopCode]?.lmsApproved !== false ? 1 : 0;
          cmp = aa - ab;
          break;
        }
        case 'due':
          cmp = a.year !== b.year ? a.year - b.year : a.month - b.month;
          break;
        case 'progress':
          cmp = (pa?.overallPercentage ?? 0) - (pb?.overallPercentage ?? 0);
          break;
      }
      return cmp * dir;
    });
    return list;
  }, [rows, progressMap, sort]);

  return (
    <>
    <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-gray-200 bg-gray-50">
              <th className="w-9 px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-gray-500" />
              <SortHeader label="SOP Code" sortKey="sopCode" sort={sort} onSort={(k) => setSort((p) => nextSort(p, k))} />
              <SortHeader label="Training Name" sortKey="sopName" sort={sort} onSort={(k) => setSort((p) => nextSort(p, k))} />
              <SortHeader label="Dept" sortKey="department" sort={sort} onSort={(k) => setSort((p) => nextSort(p, k))} />
              <SortHeader label="Type" sortKey="type" sort={sort} onSort={(k) => setSort((p) => nextSort(p, k))} />
              <SortHeader label="Status" sortKey="status" sort={sort} onSort={(k) => setSort((p) => nextSort(p, k))} />
              <SortHeader label="Approved" sortKey="approved" sort={sort} onSort={(k) => setSort((p) => nextSort(p, k))} />
              <SortHeader label="Due" sortKey="due" sort={sort} onSort={(k) => setSort((p) => nextSort(p, k))} />
              <SortHeader label="Progress" sortKey="progress" sort={sort} onSort={(k) => setSort((p) => nextSort(p, k))} />
              <th className="whitespace-nowrap px-2 py-1.5 text-right text-[10px] font-semibold uppercase tracking-wider text-gray-500">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sortedRows.map((assignment) => {
              const progress = getProgress(progressMap, assignment.sopCode);
              const pct = progress?.overallPercentage ?? 0;
              const status = progress?.status ?? 'not_started';
              const schedule = scheduleStatus(assignment);
              const cert = certMap.get(assignment.sopCode) || certMap.get(stripVersion(assignment.sopCode));
              const showCertificate = isFullyComplete(progress) && Boolean(cert);
              const asset = assetsMap[assignment.sopCode];
              const docExpired = isSopDocumentExpired(assignment) || asset?.sopExpired === true;
              const notApproved = asset?.lmsApproved === false;
              const trainerLocked = asset?.trainerUnlocked === false;
              // Exams lock when the SOP document is expired, or when the department
              // trainer has not yet completed training for this SOP.
              const examLocked = docExpired || trainerLocked;
              const lockReason = docExpired
                ? 'SOP expired — renew the document before taking the exam'
                : trainerLocked
                  ? 'Exam unlocks after your department trainer completes training for this SOP'
                  : undefined;
              const highlightExpiredDue =
                docExpired && !isFullyComplete(progress) && (schedule === 'due' || schedule === 'overdue');

              return (
                <tr
                  key={`${assignment.sopCode}-${assignment.month}-${assignment.year}`}
                  onMouseEnter={() => onPrefetch?.(assignment.sopCode)}
                  onFocus={() => onPrefetch?.(assignment.sopCode)}
                  className={`transition hover:bg-gray-50/80 ${
                    highlightExpiredDue
                      ? 'bg-red-100/80 ring-1 ring-inset ring-red-200'
                      : status !== 'completed' && status !== 'in_progress'
                      ? schedule === 'overdue' ? 'bg-red-50/40'
                        : schedule === 'due' ? 'bg-amber-50/30'
                        : schedule === 'upcoming' ? 'bg-sky-50/30'
                        : ''
                      : ''
                  }`}
                >
                  <td className="px-2 py-1.5">
                    <StatusIcon status={status} schedule={schedule} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 font-mono text-xs font-bold text-gray-700">
                    {assignment.sopCode}
                  </td>
                  <td className="max-w-[220px] px-2 py-1.5">
                    <TrainingNameCell assignment={assignment} />
                    {highlightExpiredDue && (
                      <p className="mt-0.5 text-[10px] font-semibold text-red-700">
                        Expired{assignment.expiryDate ? ` ${assignment.expiryDate}` : ''} — exam locked until renewed
                      </p>
                    )}
                    {!docExpired && trainerLocked && !isFullyComplete(progress) && (
                      <p className="mt-0.5 text-[10px] font-semibold text-amber-700">
                        Waiting for department trainer to complete this SOP
                      </p>
                    )}
                    {progress?.lastAccessedAt && status === 'in_progress' && (
                      <p className="mt-0.5 truncate text-[10px] text-gray-400">
                        Last opened {new Date(progress.lastAccessedAt).toLocaleDateString()}
                      </p>
                    )}
                    {isFullyComplete(progress) && progress?.completedAt && (
                      <p className="mt-0.5 truncate text-[10px] text-gray-400">
                        Completed {new Date(progress.completedAt).toLocaleDateString()}
                      </p>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <DepartmentCell department={assignment.sopDepartment} />
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      assignment.trainingType === 'induction'
                        ? 'bg-orange-100 text-orange-700'
                        : 'bg-sky-100 text-sky-700'
                    }`}>
                      {assignment.trainingType === 'induction' ? 'Induction' : 'Training'}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      isFullyComplete(progress)
                        ? 'bg-green-100 text-green-700'
                        : status === 'in_progress'
                        ? 'bg-purple-100 text-purple-700'
                        : schedule === 'upcoming'
                        ? 'bg-sky-100 text-sky-700'
                        : schedule === 'due'
                        ? 'bg-amber-100 text-amber-800'
                        : schedule === 'overdue'
                        ? 'bg-red-100 text-red-700'
                        : 'bg-gray-100 text-gray-600'
                    }`}>
                      {trainingStatusLabel(isFullyComplete(progress) ? 'completed' : status, schedule)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-center">
                    {notApproved ? (
                      <span className="inline-flex items-center justify-center text-red-600" title="Not Approved">
                        <X className="h-4 w-4 stroke-[2.5]" aria-label="Not Approved" />
                      </span>
                    ) : (
                      <span className="inline-flex items-center justify-center text-green-600" title="Approved">
                        <Check className="h-4 w-4 stroke-[2.5]" aria-label="Approved" />
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <span className={`text-xs ${schedule === 'upcoming' ? 'text-gray-400' : 'text-gray-500'}`}>
                      {formatDueMonth(assignment)}
                    </span>
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <ProgressBar
                        pct={pct}
                        color={
                          isFullyComplete(progress) ? 'green'
                            : schedule === 'overdue' ? 'amber'
                            : schedule === 'due' ? 'amber'
                            : schedule === 'upcoming' ? 'sky'
                            : 'purple'
                        }
                      />
                      <span className="w-8 shrink-0 text-right text-[10px] font-semibold text-gray-400">{pct}%</span>
                    </div>
                  </td>
                  <td className="px-2 py-1.5 text-right">
                    <div className="flex flex-nowrap items-center justify-end gap-1">
                      {assetsMap[assignment.sopCode] && (
                        <ResourceButtons
                          asset={assetsMap[assignment.sopCode]}
                          examLocked={examLocked}
                          lockReason={lockReason}
                          onSelect={(def) => selectResource(assignment.sopCode, def)}
                        />
                      )}
                      {showCertificate && (
                        <button
                          onClick={() => onCertificate(cert!.sopCode)}
                          className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-100"
                          title="View certificate"
                        >
                          <Award className="h-3.5 w-3.5" />
                          Cert
                        </button>
                      )}
                      {onIgnoreSop && !isFullyComplete(progress) && (
                        <button
                          type="button"
                          onClick={() => onIgnoreSop(assignment)}
                          disabled={ignoringKey === `${assignment.sopCode}-${assignment.month}-${assignment.year}`}
                          className="inline-flex items-center gap-0.5 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 transition hover:border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                          title="Ignore this SOP for the department (rollout)"
                        >
                          <EyeOff className="h-3 w-3" />
                          Ignore
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    {picker && (
      <LanguagePicker
        def={picker.def}
        onPick={(stepId) => { onOpenStep(picker.sopCode, stepId); setPicker(null); }}
        onClose={() => setPicker(null)}
      />
    )}
    </>
  );
}

// ─── Continue learning strip ──────────────────────────────────────────────────

function ContinueLearning({
  assignments,
  progressMap,
  onOpen,
  onPrefetch,
}: {
  assignments: SopAssignment[];
  progressMap: Map<string, ProgressRecord>;
  onOpen: (sopCode: string) => void;
  onPrefetch?: (sopCode: string) => void;
}) {
  const inProgress = assignments
    .filter((a) => isActivelyInProgress(getProgress(progressMap, a.sopCode)))
    .sort((a, b) => {
      const pa = getProgress(progressMap, a.sopCode);
      const pb = getProgress(progressMap, b.sopCode);
      return new Date(pb?.lastAccessedAt ?? 0).getTime() - new Date(pa?.lastAccessedAt ?? 0).getTime();
    })
    // One card per SOP family (e.g. QAGE4 vs QAGE04) — progress is per learner+SOP, not shared.
    .filter((a, idx, arr) => {
      const key = progressLookupKey(a.sopCode);
      return arr.findIndex((x) => progressLookupKey(x.sopCode) === key) === idx;
    })
    .slice(0, 3);

  if (inProgress.length === 0) return null;

  return (
    <section className="mb-4">
      <div className="mb-2 flex items-center gap-1.5">
        <PlayCircle className="h-3.5 w-3.5 text-purple-600" />
        <h2 className="text-xs font-bold text-gray-800">Continue Learning</h2>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {inProgress.map((a) => {
          const p = getProgress(progressMap, a.sopCode)!;
          return (
            <button
              key={`${a.sopCode}::${progressLookupKey(a.sopCode)}`}
              onClick={() => onOpen(a.sopCode)}
              onMouseEnter={() => onPrefetch?.(a.sopCode)}
              onFocus={() => onPrefetch?.(a.sopCode)}
              className="group relative overflow-hidden rounded-lg border border-purple-200 bg-linear-to-br from-purple-50 to-white p-3 text-left transition hover:border-purple-400"
            >
              <div className="mb-1.5 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-[11px] font-bold text-purple-700">{a.sopCode}</p>
                  <p className="mt-0.5 truncate text-xs font-semibold text-gray-800">{cleanDisplayText(a.sopName || a.sopCode)}</p>
                </div>
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-purple-600 text-white">
                  <PlayCircle className="h-3.5 w-3.5" />
                </div>
              </div>
              <ProgressBar pct={p.overallPercentage} />
              <div className="mt-1 flex items-center justify-between text-[10px] text-gray-400">
                <span>Resume</span>
                <span className="font-semibold text-purple-600">{p.overallPercentage}%</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ─── Stats row ────────────────────────────────────────────────────────────────

function StatsRow({
  assignments,
  progressMap,
  activeFilter,
  onStatClick,
}: {
  assignments: SopAssignment[];
  progressMap: Map<string, ProgressRecord>;
  activeFilter: FilterTab;
  onStatClick: (filter: FilterTab) => void;
}) {
  const total      = assignments.length;
  const completed  = assignments.filter((a) => isFullyComplete(getProgress(progressMap, a.sopCode))).length;
  const inProgress = assignments.filter((a) => isActivelyInProgress(getProgress(progressMap, a.sopCode))).length;
  const overdue    = assignments.filter((a) => isOverdue(a) && !isFullyComplete(getProgress(progressMap, a.sopCode))).length;

  const stats: { label: string; value: number; filter: FilterTab; Icon: typeof FileText; color: string; bg: string; ring: string }[] = [
    { label: 'Total Assigned', value: total,      filter: 'all',         Icon: FileText,      color: 'text-gray-600',   bg: 'bg-gray-50',    ring: 'ring-gray-400' },
    { label: 'In Progress',    value: inProgress,  filter: 'in_progress', Icon: TrendingUp,    color: 'text-purple-600', bg: 'bg-purple-50', ring: 'ring-purple-400' },
    { label: 'Completed',      value: completed,   filter: 'completed',   Icon: CheckCircle2,  color: 'text-green-600',  bg: 'bg-green-50',  ring: 'ring-green-400' },
    { label: 'Overdue',        value: overdue,     filter: 'overdue',     Icon: AlertCircle,   color: 'text-red-600',    bg: 'bg-red-50',    ring: 'ring-red-400' },
  ];

  return (
    <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      {stats.map(({ label, value, filter: tab, Icon, color, bg, ring }) => {
        const active = activeFilter === tab;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onStatClick(tab)}
            aria-pressed={active}
            className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition hover:shadow-sm ${bg} ${
              active
                ? `border-transparent ring-2 ${ring}`
                : 'border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${bg} ring-1 ring-inset ring-gray-200`}>
              <Icon className={`h-4 w-4 ${color}`} />
            </div>
            <div>
              <p className="text-xl font-bold leading-none text-gray-800">{value}</p>
              <p className="mt-0.5 text-[10px] text-gray-500">{label}</p>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ─── Login card ───────────────────────────────────────────────────────────────

function LoginCard({ onLogin }: { onLogin: (emp: Employee) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setError('Enter your username and password.'); return; }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/lms/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      let json: { error?: string; employee?: Employee } = {};
      try {
        json = await res.json();
      } catch {
        setError('Sign-in failed — invalid server response. Please try again.');
        return;
      }
      if (!res.ok) { setError(json.error || 'Login failed'); return; }
      if (!json.employee) { setError('Login failed — no employee returned.'); return; }
      // Drop any previous learner's cached progress/assignments before writing this session.
      clearLmsClientCache();
      writeLmsClientCache(lmsClientFields.employee, { employee: json.employee });
      onLogin(json.employee);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the learning portal. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-xl">
        <div className="mb-6 flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-purple-600 shadow-lg">
            <GraduationCap className="h-7 w-7 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold text-gray-800">Learning Portal</h1>
            <p className="mt-0.5 text-xs text-gray-400">Sign in to access your training</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. Abbas.Mehdi"
              autoComplete="username"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm font-mono focus:border-purple-300 focus:outline-none"
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm focus:border-purple-300 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-600 py-2.5 text-sm font-semibold text-white shadow hover:bg-purple-700 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

function Dashboard({ employee, onLogout }: { employee: Employee; onLogout: () => void }) {
  const router = useRouter();
  const [assignments, setAssignments] = useState<SopAssignment[]>([]);
  const [progressMap, setProgressMap] = useState<Map<string, ProgressRecord>>(new Map());
  const [certificates, setCertificates] = useState<CertRecord[]>([]);
  const [assetsMap, setAssetsMap] = useState<Record<string, SopAssetFlags>>({});
  const [loading,  setLoading]  = useState(true);
  const [search,   setSearch]   = useState('');
  const [filter,   setFilter]   = useState<FilterTab>('all');
  const [showCalendar, setShowCalendar] = useState(false);
  const [ignoringKey, setIgnoringKey] = useState<string | null>(null);
  const [ignoreMonthBusy, setIgnoreMonthBusy] = useState(false);
  const trainingsRef = useRef<HTMLElement>(null);

  const handleStatClick = useCallback((tab: FilterTab) => {
    setFilter(tab);
    // Defer scroll so the filtered list has painted before we jump.
    requestAnimationFrame(() => {
      trainingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const load = useCallback(async (force = false) => {
    const dashField = lmsClientFields.dashboard(employee.id);
    const cached = !force ? readLmsClientCache<DashboardCache>(dashField) : null;
    if (cached?.value) {
      setAssignments(validAssignments(cached.value.assignments || []));
      setProgressMap(buildProgressMap(cached.value.progress || []));
      setCertificates(cached.value.certificates || []);
      setAssetsMap(cached.value.assets || {});
      setLoading(false);
      if (Date.now() - cached.cachedAt <= LMS_CLIENT_FRESH_MS) return;
    } else {
      setLoading(true);
    }
    try {
      const [meRes, progressRes, certRes, assetsRes] = await Promise.all([
        fetch('/api/lms/auth/me'),
        fetch('/api/lms/progress'),
        fetch('/api/lms/certificates'),
        fetch('/api/lms/assets'),
      ]);
      if (meRes.status === 401) { router.push('/lms'); return; }
      const meData    = await meRes.json();
      const progData  = await progressRes.json();
      const certData  = certRes.ok ? await certRes.json() : { certificates: [] };
      const assetData = assetsRes.ok ? await assetsRes.json() : { assets: {} };
      const assignments = validAssignments(meData.assignments || []);
      const progress = (progData.progress || []) as ProgressRecord[];
      const certificates = certData.certificates || [];
      const assets = (assetData.assets || {}) as Record<string, SopAssetFlags>;
      setAssignments(assignments);
      setProgressMap(buildProgressMap(progress));
      setCertificates(certificates);
      setAssetsMap(assets);
      writeLmsClientCache(dashField, { assignments, progress, certificates, assets });
    } finally {
      setLoading(false);
    }
  }, [router, employee.id]);

  useEffect(() => { load(); }, [load]);

  const handleSignOut = async () => {
    await fetch('/api/lms/auth/logout', { method: 'POST' });
    clearLmsClientCache();
    onLogout();
  };

  const handleOpen = useCallback((sopCode: string) => {
    router.push(`/lms/journey/${sopCode}`);
  }, [router]);

  // Deep-link straight to a specific resource (video / PPT / SOP / assessment).
  const handleOpenStep = useCallback((sopCode: string, stepId: string) => {
    router.push(`/lms/journey/${sopCode}?step=${stepId}`);
  }, [router]);

  const handleCertificate = useCallback((sopCode: string) => {
    router.push(`/lms/certificate/${sopCode}`);
  }, [router]);

  const handleIgnoreSop = useCallback(async (a: SopAssignment) => {
    const label = `${a.sopCode} (${formatDueMonth(a)} ${a.year})`;
    if (!window.confirm(
      `Ignore ${label} for the entire ${employee.department} department?\n\nThis hides it from Due / In Progress / Upcoming for all staff in this department (rollout cleanup).`,
    )) return;
    const key = `${a.sopCode}-${a.month}-${a.year}`;
    setIgnoringKey(key);
    try {
      const res = await fetch('/api/lms/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'sop', sopCode: a.sopCode, month: a.month, year: a.year }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        window.alert(json.error || 'Failed to ignore SOP');
        return;
      }
      clearLmsClientCache();
      await load(true);
    } finally {
      setIgnoringKey(null);
    }
  }, [employee.department, load]);

  const handleIgnoreMonth = useCallback(async () => {
    // Build unique month options from current assignments (oldest first).
    const months = Array.from(
      new Map(
        assignments.map((a) => [`${a.year}-${a.month}`, { month: a.month, year: a.year, label: `${formatDueMonth(a)} ${a.year}` }]),
      ).values(),
    ).sort((a, b) => (a.year !== b.year ? a.year - b.year : a.month - b.month));

    if (months.length === 0) {
      window.alert('No trainings to ignore.');
      return;
    }

    const list = months.map((m, i) => `${i + 1}. ${m.label}`).join('\n');
    const pick = window.prompt(
      `Ignore ALL SOPs for one month across ${employee.department}.\n\nEnter the number of the month to ignore:\n${list}`,
      '1',
    );
    if (pick == null) return;
    const idx = Number(pick) - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx >= months.length) {
      window.alert('Invalid selection.');
      return;
    }
    const chosen = months[idx];
    if (!window.confirm(
      `Ignore every SOP scheduled for ${chosen.label} in ${employee.department}?\n\nThis cannot be undone from this screen.`,
    )) return;

    setIgnoreMonthBusy(true);
    try {
      const res = await fetch('/api/lms/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'month', month: chosen.month, year: chosen.year }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        window.alert(json.error || 'Failed to ignore month');
        return;
      }
      clearLmsClientCache();
      await load(true);
    } finally {
      setIgnoreMonthBusy(false);
    }
  }, [assignments, employee.department, load]);

  // Warm the journey cache on hover/focus so clicking "Start"/"Continue" paints
  // the journey page instantly instead of waiting on the fetch. Purely additive:
  // it writes the same client-cache field the journey page already reads, and
  // each SOP is fetched at most once per session.
  const prefetched = useRef<Set<string>>(new Set());
  const prefetchJourney = useCallback((sopCode: string) => {
    if (!sopCode || prefetched.current.has(sopCode)) return;
    const field = lmsClientFields.journey(employee.id, sopCode);
    const cached = readLmsClientCache(field);
    if (cached && Date.now() - cached.cachedAt <= LMS_CLIENT_FRESH_MS) return;
    prefetched.current.add(sopCode);
    fetch(`/api/lms/journey/${sopCode}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json && !json.error) writeLmsClientCache(field, json);
      })
      .catch(() => { prefetched.current.delete(sopCode); });
  }, [employee.id]);

  const certMap = useMemo(() => {
    const m = new Map<string, CertRecord>();
    for (const c of certificates) {
      m.set(c.sopCode, c);
      m.set(stripVersion(c.sopCode), c);
    }
    return m;
  }, [certificates]);

  const filtered = useMemo(() => {
    let list = assignments;
    if (filter === 'in_progress')  list = list.filter((a) => isActivelyInProgress(getProgress(progressMap, a.sopCode)));
    if (filter === 'completed')    list = list.filter((a) => isFullyComplete(getProgress(progressMap, a.sopCode)));
    if (filter === 'due')          list = list.filter((a) => {
      const st = getProgress(progressMap, a.sopCode)?.status;
      return scheduleStatus(a) === 'due' && st !== 'completed' && st !== 'in_progress';
    });
    if (filter === 'upcoming')     list = list.filter((a) => {
      const st = getProgress(progressMap, a.sopCode)?.status;
      return scheduleStatus(a) === 'upcoming' && st !== 'completed';
    });
    if (filter === 'overdue')      list = list.filter((a) => {
      return scheduleStatus(a) === 'overdue' && !isFullyComplete(getProgress(progressMap, a.sopCode));
    });
    if (search.trim()) {
      const term = search.trim().toLowerCase();
      list = list.filter((a) => {
        const { english, gujarati } = displayTrainingName(a);
        return (
          a.sopCode.toLowerCase().includes(term) ||
          english.toLowerCase().includes(term) ||
          (gujarati || '').toLowerCase().includes(term) ||
          (a.sopDepartment || '').toLowerCase().includes(term) ||
          a.monthName.toLowerCase().includes(term)
        );
      });
    }
    return list;
  }, [assignments, progressMap, filter, search]);

  const earnedCertificates = useMemo(
    () => certificates.filter((c) => isFullyComplete(getProgress(progressMap, c.sopCode))),
    [certificates, progressMap],
  );

  const tabCounts = useMemo(() => ({
    all:         assignments.length,
    in_progress: assignments.filter((a) => isActivelyInProgress(getProgress(progressMap, a.sopCode))).length,
    completed:   assignments.filter((a) => isFullyComplete(getProgress(progressMap, a.sopCode))).length,
    due:         assignments.filter((a) => {
      const st = getProgress(progressMap, a.sopCode)?.status;
      return scheduleStatus(a) === 'due' && st !== 'completed' && st !== 'in_progress';
    }).length,
    upcoming:    assignments.filter((a) => {
      const st = getProgress(progressMap, a.sopCode)?.status;
      return scheduleStatus(a) === 'upcoming' && st !== 'completed';
    }).length,
    overdue:     assignments.filter((a) => {
      return scheduleStatus(a) === 'overdue' && !isFullyComplete(getProgress(progressMap, a.sopCode));
    }).length,
  }), [assignments, progressMap]);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-600">
              <GraduationCap className="h-4 w-4 text-white" />
            </div>
            <div>
              <p className="text-sm font-bold text-gray-800">My Training</p>
              <p className="text-[11px] text-gray-400">{employee.name} · {employee.department}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowCalendar(true)}
              className="flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-2.5 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100"
            >
              <Calendar className="h-3.5 w-3.5" /> Calendar
            </button>
            <button
              onClick={() => load(true)}
              disabled={loading}
              className="rounded-lg border border-gray-200 p-1.5 text-gray-400 hover:bg-gray-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={handleSignOut}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-screen-2xl px-3 py-4 sm:px-5 lg:px-6">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
          </div>
        ) : (
          <>
            {/* Stats */}
            <StatsRow
              assignments={assignments}
              progressMap={progressMap}
              activeFilter={filter}
              onStatClick={handleStatClick}
            />

            {/* Continue learning */}
            <ContinueLearning assignments={assignments} progressMap={progressMap} onOpen={handleOpen} onPrefetch={prefetchJourney} />

            {/* Certificates — only for fully completed (100%) trainings */}
            {earnedCertificates.length > 0 && (
              <section className="mb-4">
                <div className="mb-2 flex items-center gap-1.5">
                  <Award className="h-3.5 w-3.5 text-amber-500" />
                  <h2 className="text-xs font-bold text-gray-800">My Certificates</h2>
                  <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                    {earnedCertificates.length}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {earnedCertificates.map((cert) => (
                    <button
                      key={cert._id}
                      onClick={() => router.push(`/lms/certificate/${cert.sopCode}`)}
                      className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-linear-to-br from-amber-50 to-white p-3 text-left transition hover:border-amber-400"
                    >
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-amber-100">
                        <Award className="h-4 w-4 text-amber-600" />
                      </div>
                      <div className="min-w-0">
                        <p className="font-mono text-[11px] font-bold text-amber-700">{cert.sopCode}</p>
                        <p className="truncate text-xs font-semibold text-gray-800">{cleanDisplayText(cert.sopName)}</p>
                        <p className="mt-0.5 text-[10px] text-gray-400">
                          {new Date(cert.completedAt).toLocaleDateString()}
                          {cert.quizScore > 0 && ` · Score: ${cert.quizScore}%`}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {/* My Trainings section */}
            <section ref={trainingsRef} className="scroll-mt-16">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-1.5 text-xs font-bold text-gray-800">
                  <ClipboardList className="h-3.5 w-3.5 text-purple-600" /> My Trainings
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={handleIgnoreMonth}
                    disabled={ignoreMonthBusy || assignments.length === 0}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                    title="Ignore all SOPs for a selected month across your department"
                  >
                    <EyeOff className="h-3.5 w-3.5" />
                    {ignoreMonthBusy ? 'Ignoring…' : 'Ignore month'}
                  </button>
                  <div className="relative w-full max-w-xs sm:w-56">
                    <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search SOP code or name…"
                      className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-sm focus:border-purple-300 focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Filter tabs */}
              <div className="mb-2.5 flex flex-wrap gap-1">
                {(['all', 'in_progress', 'due', 'upcoming', 'completed', 'overdue'] as FilterTab[]).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setFilter(tab)}
                    className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
                      filter === tab
                        ? tab === 'overdue'
                          ? 'bg-red-600 text-white'
                          : tab === 'completed'
                          ? 'bg-green-600 text-white'
                          : tab === 'due'
                          ? 'bg-amber-600 text-white'
                          : tab === 'upcoming'
                          ? 'bg-sky-600 text-white'
                          : 'bg-purple-600 text-white'
                        : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {statusLabel(tab)}
                    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                      filter === tab ? 'bg-white/20' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {tabCounts[tab]}
                    </span>
                  </button>
                ))}
              </div>

              {/* Training list */}
              {filtered.length === 0 ? (
                <div className="rounded-xl border border-gray-200 bg-white py-16 text-center">
                  <BookOpen className="mx-auto mb-3 h-10 w-10 text-gray-200" />
                  <p className="text-sm font-medium text-gray-500">
                    {search ? `No trainings match "${search}"` : `No ${filter !== 'all' ? statusLabel(filter).toLowerCase() : ''} trainings`}
                  </p>
                </div>
              ) : (
                <TrainingTable
                  rows={filtered}
                  progressMap={progressMap}
                  certMap={certMap}
                  assetsMap={assetsMap}
                  onOpenStep={handleOpenStep}
                  onCertificate={handleCertificate}
                  onPrefetch={prefetchJourney}
                  onIgnoreSop={handleIgnoreSop}
                  ignoringKey={ignoringKey}
                />
              )}

              <div className="mt-3 text-center text-xs text-gray-400">
                {filtered.length} of {assignments.length} training{assignments.length !== 1 ? 's' : ''}
              </div>
            </section>

            {/* Overdue warning */}
            {tabCounts.overdue > 0 && (
              <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                <p className="text-[11px] text-amber-800">
                  You have <strong>{tabCounts.overdue} overdue</strong> training{tabCounts.overdue !== 1 ? 's' : ''}.
                  Please complete them as soon as possible to remain compliant.
                </p>
              </div>
            )}
          </>
        )}
      </main>

      {showCalendar && (
        <LearnerTrainingCalendar
          assignments={assignments}
          progressMap={progressMap}
          onOpen={handleOpen}
          onClose={() => setShowCalendar(false)}
        />
      )}
    </div>
  );
}

// ─── Root page ────────────────────────────────────────────────────────────────

export default function LmsPage() {
  const [employee, setEmployee] = useState<Employee | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const cached = readLmsClientCache<{ employee: Employee }>(lmsClientFields.employee);
    if (cached?.value?.employee) {
      setEmployee(cached.value.employee);
      setChecking(false);
      if (Date.now() - cached.cachedAt <= LMS_CLIENT_FRESH_MS) return;
    }
    fetch('/api/lms/auth/me')
      .then((r) => r.json())
      .then((d) => {
        if (d.employee) {
          setEmployee(d.employee);
          writeLmsClientCache(lmsClientFields.employee, { employee: d.employee });
        }
      })
      .catch(() => { /* not logged in */ })
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
      </div>
    );
  }

  if (!employee) {
    return <LoginCard onLogin={setEmployee} />;
  }

  return <Dashboard employee={employee} onLogout={() => setEmployee(null)} />;
}
