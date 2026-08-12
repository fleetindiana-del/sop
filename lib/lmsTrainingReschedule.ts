import { connectDB } from '@/lib/mongodb';
import LmsTrainingReschedule from '@/models/lms/LmsTrainingReschedule';
import { invalidateLmsServerPrefix } from '@/lib/lmsCache';

const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

function deptKey(d: string): string {
  return String(d || '').trim().toLowerCase();
}

export type TrainingRescheduleRule = {
  department: string;
  sopCode: string;
  employeeId?: string | null;
  fromYear: number;
  fromMonth: number;
  toYear: number;
  toMonth: number;
};

export async function listTrainingReschedules(department?: string): Promise<TrainingRescheduleRule[]> {
  await connectDB();
  const filter = department
    ? { department: new RegExp(`^${escapeRegex(department.trim())}$`, 'i') }
    : {};
  const rows = await LmsTrainingReschedule.find(filter)
    .select('department sopCode employeeId fromYear fromMonth toYear toMonth')
    .lean<Array<{
      department: string;
      sopCode: string;
      employeeId?: { toString(): string } | null;
      fromYear: number;
      fromMonth: number;
      toYear: number;
      toMonth: number;
    }>>();

  return rows.map((r) => ({
    department: r.department,
    sopCode: stripVersion(r.sopCode),
    employeeId: r.employeeId ? String(r.employeeId) : null,
    fromYear: r.fromYear,
    fromMonth: r.fromMonth,
    toYear: r.toYear,
    toMonth: r.toMonth,
  }));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Apply the latest matching reschedule onto an assignment (mutates a copy).
 * Prefer employee-specific rules over department-wide ones.
 */
export function applyRescheduleToAssignment<T extends {
  sopCode: string;
  month: number;
  monthName: string;
  year: number;
  sopDepartment?: string;
}>(
  assignment: T,
  rules: TrainingRescheduleRule[],
  opts: { employeeId?: string; employeeDepartment: string },
): T & { rescheduledFrom?: { year: number; month: number } } {
  if (!rules.length) return assignment;

  const dept = deptKey(opts.employeeDepartment || assignment.sopDepartment || '');
  const code = stripVersion(assignment.sopCode);
  const empId = opts.employeeId ? String(opts.employeeId) : '';

  let match: TrainingRescheduleRule | null = null;
  for (const r of rules) {
    if (deptKey(r.department) !== dept) continue;
    if (stripVersion(r.sopCode) !== code) continue;
    if (r.fromYear !== assignment.year || r.fromMonth !== assignment.month) continue;
    if (r.employeeId && empId && r.employeeId !== empId) continue;
    if (r.employeeId && !empId) continue;
    // Prefer employee-specific
    if (r.employeeId && empId && r.employeeId === empId) {
      match = r;
      break;
    }
    if (!r.employeeId) match = r;
  }

  if (!match) return assignment;

  return {
    ...assignment,
    year: match.toYear,
    month: match.toMonth,
    monthName: MONTH_NAMES[match.toMonth] || assignment.monthName,
    rescheduledFrom: { year: match.fromYear, month: match.fromMonth },
  };
}

export function applyReschedulesToList<T extends {
  sopCode: string;
  month: number;
  monthName: string;
  year: number;
  sopDepartment?: string;
}>(
  assignments: T[],
  rules: TrainingRescheduleRule[],
  opts: { employeeId?: string; employeeDepartment: string },
): Array<T & { rescheduledFrom?: { year: number; month: number } }> {
  if (!rules.length) return assignments;
  return assignments.map((a) => applyRescheduleToAssignment(a, rules, opts));
}

export async function createTrainingReschedule(input: {
  department: string;
  sopCode: string;
  employeeId?: string | null;
  employeeName?: string | null;
  fromYear: number;
  fromMonth: number;
  toYear: number;
  toMonth: number;
  note?: string;
  createdByEmployeeId?: string;
  createdByName?: string;
}): Promise<void> {
  await connectDB();
  await LmsTrainingReschedule.create({
    department: input.department.trim(),
    sopCode: stripVersion(input.sopCode),
    employeeId: input.employeeId || null,
    employeeName: input.employeeName || null,
    fromYear: input.fromYear,
    fromMonth: input.fromMonth,
    toYear: input.toYear,
    toMonth: input.toMonth,
    note: input.note || '',
    createdByEmployeeId: input.createdByEmployeeId || undefined,
    createdByName: input.createdByName || undefined,
  });
  invalidateLmsServerPrefix('lms:');
}
