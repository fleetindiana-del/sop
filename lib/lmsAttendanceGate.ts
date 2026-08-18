/**
 * Gate formal exams behind an assigned sitting date and trainer-marked attendance.
 *
 * Rule: a learner may start the exam only when (1) a date is assigned and
 * (2) a TrainingAttendance sheet for that SOP × department marks them present.
 * Designated trainers (`isTrainer`) may always start the exam — they unlock it
 * for their department and are not gated on attendance or a sitting date.
 *
 * Attendance may be filed on the scheduled sitting date or later (overdue
 * catch-up). A present mark on or after the earliest assigned sitting unlocks
 * the test; absent-only records stay locked.
 */

import TrainingAttendance from '@/models/lms/TrainingAttendance';
import ScheduledExam from '@/models/lms/ScheduledExam';
import TrainingExamSchedule from '@/models/TrainingExamSchedule';
import { normalizeEmployeeDepartment } from '@/lib/employeeTrainer';
import { baseIdentifierFromIdentifier, sopFamilyIdentifierRegex } from '@/lib/sop-utils';
import { toDateOnlyIso } from '@/lib/trainingExamSchedule';

export type AttendanceGateCode =
  | 'exam_date_required'
  | 'attendance_required'
  | 'attendance_absent';

export type AttendanceGateResult = {
  allowed: boolean;
  code?: AttendanceGateCode;
  reason?: string;
};

type AttendanceMark = { date: string; status: 'present' | 'absent' };

function isDesignatedTrainer(opts: { isTrainer?: boolean }): boolean {
  return opts.isTrainer === true;
}

function toIsoDateOnly(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toDateOnlyIso(value);
  }
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return toDateOnlyIso(parsed);
  return null;
}

function addIso(into: string[], value: unknown): void {
  const iso = toIsoDateOnly(value);
  if (iso && !into.includes(iso)) into.push(iso);
}

function collectSittingIsos(
  doc: { scheduledDate?: unknown; scheduledDate2?: unknown; scheduledDate3?: unknown } | null | undefined,
  hint?: string | null,
): string[] {
  const out: string[] = [];
  if (doc) {
    addIso(out, doc.scheduledDate);
    addIso(out, doc.scheduledDate2);
    addIso(out, doc.scheduledDate3);
  }
  addIso(out, hint);
  return out.sort();
}

function deptRegex(department: string): RegExp {
  return new RegExp(
    `^${normalizeEmployeeDepartment(department).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
    'i',
  );
}

function decideEligibility(dates: string[], marks: AttendanceMark[]): AttendanceGateResult {
  if (dates.length === 0) {
    return {
      allowed: false,
      code: 'exam_date_required',
      reason: 'Test unlocks after your trainer assigns an exam date.',
    };
  }

  const earliest = dates[0];
  const relevant = marks.filter((m) => m.date >= earliest);
  if (relevant.some((m) => m.status === 'present')) return { allowed: true };
  if (relevant.some((m) => m.status === 'absent')) {
    return {
      allowed: false,
      code: 'attendance_absent',
      reason:
        'You were marked absent for this training. Contact your trainer if this is incorrect.',
    };
  }
  return {
    allowed: false,
    code: 'attendance_required',
    reason: 'Test unlocks after your trainer marks you present for this exam.',
  };
}

async function loadScheduledSittings(
  employeeId: string,
  sopCode: string,
  examDateHint?: string | null,
): Promise<string[]> {
  const familyRe = sopFamilyIdentifierRegex(sopCode);
  const schedule = await ScheduledExam.findOne({
    employeeId: String(employeeId),
    status: 'scheduled',
    sopCode: { $regex: familyRe },
  })
    .select('scheduledDate scheduledDate2 scheduledDate3')
    .sort({ year: -1, month: -1 })
    .lean<{ scheduledDate?: Date; scheduledDate2?: Date; scheduledDate3?: Date }>();

  return collectSittingIsos(schedule, examDateHint);
}

async function loadCalendarExamDate(
  employeeId: string,
  department: string,
  sopCode: string,
): Promise<string | null> {
  const family = (baseIdentifierFromIdentifier(sopCode) || sopCode).toUpperCase();
  const familyRe = sopFamilyIdentifierRegex(sopCode);
  const rows = await TrainingExamSchedule.find({
    status: { $ne: 'cancelled' },
    department: deptRegex(department),
    $or: [{ sopCode: family }, { sopCode: { $regex: familyRe } }],
  })
    .select('examDate scope employeeId')
    .lean<Array<{ examDate?: Date; scope?: string; employeeId?: string }>>();

  const dates: string[] = [];
  for (const row of rows) {
    if (
      row.scope === 'employee'
      && row.employeeId
      && String(row.employeeId) !== String(employeeId)
    ) {
      continue;
    }
    addIso(dates, row.examDate);
  }
  dates.sort();
  return dates[0] ?? null;
}

async function loadAttendanceMarks(opts: {
  employeeId: string;
  department: string;
  sopCode: string;
}): Promise<AttendanceMark[]> {
  const family = (baseIdentifierFromIdentifier(opts.sopCode) || opts.sopCode).toUpperCase();
  const familyRe = sopFamilyIdentifierRegex(opts.sopCode);
  const employeeId = String(opts.employeeId);

  const sheets = await TrainingAttendance.find({
    department: deptRegex(opts.department),
    'records.employeeId': employeeId,
    $or: [{ sopCode: family }, { sopCode: { $regex: familyRe } }],
  })
    .select('trainingDate records')
    .lean<Array<{
      trainingDate?: Date;
      records?: Array<{ employeeId: string; status: string }>;
    }>>();

  const marks: AttendanceMark[] = [];
  for (const sheet of sheets) {
    const date = toIsoDateOnly(sheet.trainingDate);
    if (!date) continue;
    const rec = (sheet.records ?? []).find((r) => String(r.employeeId) === employeeId);
    if (!rec) continue;
    marks.push({
      date,
      status: rec.status === 'present' ? 'present' : 'absent',
    });
  }
  return marks;
}

/**
 * Single-learner check used by the quiz API.
 */
export async function getExamAttendanceEligibility(opts: {
  employeeId: string;
  department?: string | null;
  isTrainer?: boolean;
  trainerDepartments?: string[] | null;
  sopCode: string;
  /** Assignment examDate hint (YYYY-MM-DD), when already known. */
  examDate?: string | null;
}): Promise<AttendanceGateResult> {
  if (isDesignatedTrainer(opts)) return { allowed: true };

  const dept = normalizeEmployeeDepartment(opts.department);
  if (!dept) {
    return {
      allowed: false,
      code: 'attendance_required',
      reason: 'Your department is not set. Contact your administrator.',
    };
  }

  let dates = await loadScheduledSittings(opts.employeeId, opts.sopCode, opts.examDate);
  if (dates.length === 0) {
    const calendarDate = await loadCalendarExamDate(opts.employeeId, dept, opts.sopCode);
    if (calendarDate) dates = [calendarDate];
  }

  const marks = await loadAttendanceMarks({
    employeeId: opts.employeeId,
    department: dept,
    sopCode: opts.sopCode,
  });

  return decideEligibility(dates, marks);
}

/**
 * Batch flag for /api/lms/assets — keyed by original sopCode (and family base).
 * `true` = may start exam from an attendance perspective.
 */
export async function batchExamAttendanceUnlocked(
  employee: {
    _id: unknown;
    department?: string | null;
    isTrainer?: boolean;
    trainerDepartments?: string[] | null;
  },
  items: Array<{ sopCode: string; examDate?: string | null }>,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const unique = items.filter((i) => String(i.sopCode || '').trim());
  if (unique.length === 0) return out;

  if (isDesignatedTrainer(employee)) {
    for (const i of unique) {
      const code = i.sopCode.trim();
      out.set(code, true);
      out.set(code.toUpperCase(), true);
      const fam = (baseIdentifierFromIdentifier(code) || code).toUpperCase();
      out.set(fam, true);
    }
    return out;
  }

  const dept = normalizeEmployeeDepartment(employee.department);
  const employeeId = String(employee._id);

  const sittingsByFamily = new Map<string, string[]>();
  const marksByFamily = new Map<string, AttendanceMark[]>();

  if (dept) {
    const schedules = await ScheduledExam.find({
      employeeId,
      status: 'scheduled',
    })
      .select('sopCode year month scheduledDate scheduledDate2 scheduledDate3')
      .lean<Array<{
        sopCode: string;
        year?: number;
        month?: number;
        scheduledDate?: Date;
        scheduledDate2?: Date;
        scheduledDate3?: Date;
      }>>();

    const latestByFamily = new Map<string, { year: number; month: number; dates: string[] }>();
    for (const s of schedules) {
      const fam = (baseIdentifierFromIdentifier(s.sopCode) || s.sopCode).toUpperCase();
      const year = Number(s.year) || 0;
      const month = Number(s.month) || 0;
      const prev = latestByFamily.get(fam);
      if (prev && (year < prev.year || (year === prev.year && month < prev.month))) continue;
      latestByFamily.set(fam, { year, month, dates: collectSittingIsos(s, null) });
    }
    for (const [fam, latest] of latestByFamily) {
      sittingsByFamily.set(fam, latest.dates);
    }

    const sheets = await TrainingAttendance.find({
      department: deptRegex(dept),
      'records.employeeId': employeeId,
    })
      .select('sopCode trainingDate records')
      .lean<Array<{
        sopCode: string;
        trainingDate?: Date;
        records?: Array<{ employeeId: string; status: string }>;
      }>>();

    for (const sheet of sheets) {
      const date = toIsoDateOnly(sheet.trainingDate);
      if (!date) continue;
      const rec = (sheet.records ?? []).find((r) => String(r.employeeId) === employeeId);
      if (!rec) continue;
      const fam = (baseIdentifierFromIdentifier(sheet.sopCode) || sheet.sopCode).toUpperCase();
      const mark: AttendanceMark = {
        date,
        status: rec.status === 'present' ? 'present' : 'absent',
      };
      const list = marksByFamily.get(fam) || [];
      list.push(mark);
      marksByFamily.set(fam, list);
      marksByFamily.set(String(sheet.sopCode).toUpperCase(), list);
    }
  }

  for (const item of unique) {
    const code = item.sopCode.trim();
    const fam = (baseIdentifierFromIdentifier(code) || code).toUpperCase();
    const dates = collectSittingIsos(
      null,
      item.examDate,
    );
    for (const d of sittingsByFamily.get(fam) || sittingsByFamily.get(code.toUpperCase()) || []) {
      addIso(dates, d);
    }
    dates.sort();

    const marks = marksByFamily.get(fam) || marksByFamily.get(code.toUpperCase()) || [];
    const unlocked = dept ? decideEligibility(dates, marks).allowed : false;

    out.set(code, unlocked);
    out.set(code.toUpperCase(), unlocked);
    out.set(fam, unlocked);
  }

  return out;
}
