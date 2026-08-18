import TrainingMatrixUpload from '@/models/TrainingMatrixUpload';
import TrainingMatrixRecord from '@/models/TrainingMatrixRecord';
import type { ITrainingExamSchedule } from '@/models/TrainingExamSchedule';
import {
  MONTH_NAMES,
  DEPT_COLORS,
  toDateOnlyIso,
  parseDateOnly,
  monthOfDate,
  yearOfDate,
} from '@/lib/trainingExamScheduleShared';

export {
  MONTH_NAMES,
  DEPT_COLORS,
  toDateOnlyIso,
  parseDateOnly,
  monthOfDate,
  yearOfDate,
};

export function stripVersion(code: string): string {
  return String(code || '')
    .toUpperCase()
    .replace(/-\d+$/, '')
    .trim();
}

export function normalizeDept(raw: string | undefined | null): string {
  const u = String(raw || '').trim();
  if (!u) return '';
  const up = u.toUpperCase();
  if (up === 'QA') return 'QA';
  if (up === 'QC') return 'QC';
  if (/^MICRO/.test(up)) return 'Microbiology';
  if (/^PROD/.test(up)) return 'Production';
  if (/^STOR/.test(up)) return 'Store';
  if (/^ENG/.test(up)) return 'Engineering';
  if (/^PERSON/.test(up) || up === 'HR') return 'Personnel';
  return u;
}

const MONTH_NAME_TO_NUM: Record<string, number> = Object.fromEntries(
  MONTH_NAMES.slice(1).map((m, i) => [m.toLowerCase(), i + 1]),
);

export function parseScheduleMonthNumbers(monthVal: string): number[] {
  return String(monthVal || '')
    .split(',')
    .map((part) => MONTH_NAME_TO_NUM[part.trim().toLowerCase()])
    .filter((n): n is number => typeof n === 'number' && n >= 1 && n <= 12);
}

export type MonthRequirement = {
  sopCode: string;
  sopName: string;
  department: string;
  plannedMonth: number;
  year: number;
};

type UploadSnap = {
  sopMonthMap?: Record<string, string>;
  sopCodes?: string[];
};

/**
 * Build SOP × department × planned-month requirements from Excel snapshots
 * and manual Manage SOP allocations for a given year (optionally one month).
 */
export async function loadMonthRequirements(
  year: number,
  month?: number,
): Promise<MonthRequirement[]> {
  const [uploads, manualRecords] = await Promise.all([
    TrainingMatrixUpload.find({ 'snapshot.sopMonthMap': { $exists: true } })
      .sort({ uploadedAt: -1 })
      .select('department year snapshot.sopMonthMap snapshot.sopCodes uploadedAt')
      .lean(),
    TrainingMatrixRecord.find({
      year,
      status: { $ne: 'na' },
      sourceFile: 'manage-sop-manual',
      ...(month ? { month } : {}),
    })
      .select('department sopCode sopName month year')
      .lean(),
  ]);

  const latestByDept = new Map<
    string,
    { department: string; year?: number; snapshot?: UploadSnap }
  >();
  for (const upload of uploads as Array<{
    department: string;
    year?: number;
    snapshot?: UploadSnap;
  }>) {
    const dept = normalizeDept(upload.department);
    if (!dept || latestByDept.has(dept)) continue;
    latestByDept.set(dept, upload);
  }

  const reqKeys = new Set<string>();
  const requirements: MonthRequirement[] = [];
  const sopNames = new Map<string, string>();

  const addReq = (
    sopCode: string,
    sopName: string,
    department: string,
    plannedMonth: number,
    y: number,
  ) => {
    const code = stripVersion(sopCode);
    const dept = normalizeDept(department);
    if (!code || !dept || plannedMonth < 1 || plannedMonth > 12) return;
    if (month && plannedMonth !== month) return;
    if (y !== year) return;
    const key = `${code}|${dept}|${plannedMonth}|${y}`;
    if (reqKeys.has(key)) return;
    reqKeys.add(key);
    if (sopName) sopNames.set(code, sopName);
    requirements.push({
      sopCode: code,
      sopName: sopName || sopNames.get(code) || code,
      department: dept,
      plannedMonth,
      year: y,
    });
  };

  for (const upload of latestByDept.values()) {
    const snap = upload.snapshot;
    if (!snap?.sopMonthMap) continue;
    const dept = normalizeDept(upload.department);
    const y = upload.year ?? year;
    if (y !== year) continue;

    for (const [rawKey, monthVal] of Object.entries(snap.sopMonthMap)) {
      const months = parseScheduleMonthNumbers(monthVal);
      const code = stripVersion(rawKey);
      for (const m of months) {
        addReq(code, '', dept, m, y);
      }
    }
  }

  for (const rec of manualRecords as Array<{
    department?: string;
    sopCode?: string;
    sopName?: string;
    month?: number;
    year?: number;
  }>) {
    addReq(
      String(rec.sopCode || ''),
      String(rec.sopName || ''),
      String(rec.department || ''),
      Number(rec.month),
      Number(rec.year) || year,
    );
  }

  for (const r of requirements) {
    if (!r.sopName || r.sopName === r.sopCode) {
      r.sopName = sopNames.get(r.sopCode) || r.sopCode;
    }
  }

  requirements.sort((a, b) => {
    if (a.plannedMonth !== b.plannedMonth) return a.plannedMonth - b.plannedMonth;
    if (a.department !== b.department) return a.department.localeCompare(b.department);
    return a.sopCode.localeCompare(b.sopCode);
  });

  return requirements;
}

export type ScheduleLean = {
  _id: unknown;
  sopCode: string;
  sopName?: string;
  department: string;
  year: number;
  plannedMonth: number;
  examDate: Date;
  scope: 'department' | 'employee';
  employeeName?: string;
  employeeId?: string;
  status: string;
};

export function deptScheduleKey(
  sopCode: string,
  department: string,
  year: number,
  plannedMonth: number,
): string {
  return `${stripVersion(sopCode)}|${normalizeDept(department)}|${year}|${plannedMonth}`;
}

export function employeeOverrideKey(
  sopCode: string,
  department: string,
  year: number,
  plannedMonth: number,
  employeeName: string,
): string {
  return `${deptScheduleKey(sopCode, department, year, plannedMonth)}|${String(employeeName || '')
    .trim()
    .toLowerCase()}`;
}

/** Weekdays (Mon–Sat) in a UTC month, excluding Sundays. */
export function openDaysInMonth(year: number, month: number): Date[] {
  const days: Date[] = [];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = 1; d <= last; d++) {
    const date = new Date(Date.UTC(year, month - 1, d));
    if (date.getUTCDay() === 0) continue; // skip Sunday
    days.push(date);
  }
  return days;
}

/**
 * Auto-assign unassigned requirements across open weekdays in each planned month,
 * round-robin by lowest current event count. Does not overwrite existing dept schedules.
 */
export function pickAutoAssignDates(
  unassigned: MonthRequirement[],
  existingDeptSchedules: Array<{ plannedMonth: number; examDate: Date }>,
): Array<MonthRequirement & { examDate: Date }> {
  const countByDay = new Map<string, number>();
  for (const s of existingDeptSchedules) {
    const key = toDateOnlyIso(new Date(s.examDate));
    countByDay.set(key, (countByDay.get(key) || 0) + 1);
  }

  const byMonth = new Map<number, MonthRequirement[]>();
  for (const req of unassigned) {
    const list = byMonth.get(req.plannedMonth) || [];
    list.push(req);
    byMonth.set(req.plannedMonth, list);
  }

  const results: Array<MonthRequirement & { examDate: Date }> = [];

  for (const [plannedMonth, reqs] of byMonth) {
    const year = reqs[0]?.year;
    if (!year) continue;
    const openDays = openDaysInMonth(year, plannedMonth);
    if (!openDays.length) continue;

    // Seed counts for open days so missing keys start at 0
    for (const day of openDays) {
      const key = toDateOnlyIso(day);
      if (!countByDay.has(key)) countByDay.set(key, 0);
    }

    for (const req of reqs) {
      let best: Date = openDays[0];
      let bestCount = Infinity;
      for (const day of openDays) {
        const key = toDateOnlyIso(day);
        const c = countByDay.get(key) || 0;
        if (c < bestCount) {
          bestCount = c;
          best = day;
        }
      }
      const key = toDateOnlyIso(best);
      countByDay.set(key, (countByDay.get(key) || 0) + 1);
      results.push({ ...req, examDate: best });
    }
  }

  return results;
}

export function serializeSchedule(doc: ScheduleLean | ITrainingExamSchedule) {
  const examDate =
    doc.examDate instanceof Date ? doc.examDate : new Date(doc.examDate as unknown as string);
  return {
    id: String(doc._id),
    sopCode: stripVersion(doc.sopCode),
    sopName: doc.sopName || stripVersion(doc.sopCode),
    department: normalizeDept(doc.department),
    year: doc.year,
    plannedMonth: doc.plannedMonth,
    examDate: toDateOnlyIso(examDate),
    scope: doc.scope,
    employeeName: doc.employeeName || undefined,
    employeeId: doc.employeeId || undefined,
    status: doc.status,
    color: DEPT_COLORS[normalizeDept(doc.department)] || '#6366f1',
  };
}
