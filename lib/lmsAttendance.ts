/**
 * Trainer-recorded attendance for SOP training sessions.
 *
 * A sheet is the record of one classroom session: SOP × department × date, filed
 * by the trainer who ran it. Every expected employee appears on it exactly once,
 * marked present or absent — an employee missing from the sheet is not "absent",
 * they were never expected, and the two must not be confused in a GMP record.
 *
 * Attendance deliberately does NOT require an LMS login. Sitting in a training
 * room is not the same as being able to take the online exam, and a session
 * record that silently dropped people without credentials would be wrong.
 */

import TrainingAttendance, {
  type AttendanceStatus,
  type IAttendanceRecord,
  type ITrainingAttendance,
} from '@/models/lms/TrainingAttendance';
import { toDateOnlyIso } from '@/lib/trainingExamSchedule';
import type { TrainerScopedEmployee } from '@/lib/lmsTrainerEmployees';
import { departmentAliasStrings } from '@/lib/trainingMatrixDepartments';

export type AttendanceRecordLean = IAttendanceRecord;

export type TrainingAttendanceLean = {
  _id: unknown;
  trainerId: string;
  trainerName: string;
  department: string;
  sopCode: string;
  sopName?: string;
  trainingDate: Date;
  month: number;
  year: number;
  records: AttendanceRecordLean[];
  presentCount: number;
  absentCount: number;
  totalCount: number;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
};

export function isAttendanceStatus(value: unknown): value is AttendanceStatus {
  return value === 'present' || value === 'absent';
}

export interface AttendanceSheetView {
  id: string;
  sopCode: string;
  sopName: string;
  department: string;
  trainerId: string;
  trainerName: string;
  trainingDate: string;
  month: number;
  year: number;
  presentCount: number;
  absentCount: number;
  totalCount: number;
  /** Share of expected employees who attended, 0–100. */
  attendancePct: number;
  notes?: string;
  recordedAt?: string;
  records: Array<{
    employeeId: string;
    employeeName: string;
    designation: string;
    department: string;
    employeeCode?: string;
    status: AttendanceStatus;
    remark?: string;
  }>;
}

export function serializeAttendance(
  doc: TrainingAttendanceLean | ITrainingAttendance,
): AttendanceSheetView {
  const records = (doc.records ?? []) as AttendanceRecordLean[];
  const present = doc.presentCount ?? records.filter((r) => r.status === 'present').length;
  const total = doc.totalCount ?? records.length;

  return {
    id: String(doc._id),
    sopCode: doc.sopCode,
    sopName: doc.sopName || doc.sopCode,
    department: doc.department,
    trainerId: doc.trainerId,
    trainerName: doc.trainerName,
    trainingDate: toDateOnlyIso(new Date(doc.trainingDate)),
    month: doc.month,
    year: doc.year,
    presentCount: present,
    absentCount: doc.absentCount ?? records.filter((r) => r.status === 'absent').length,
    totalCount: total,
    attendancePct: total > 0 ? Math.round((present / total) * 100) : 0,
    notes: doc.notes || undefined,
    recordedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : undefined,
    records: records.map((r) => ({
      employeeId: r.employeeId,
      employeeName: r.employeeName,
      designation: r.designation || '',
      department: r.department,
      employeeCode: r.employeeCode || undefined,
      status: r.status,
      remark: r.remark || undefined,
    })),
  };
}

/**
 * Build the stored records for a session.
 *
 * `marks` carries only what the trainer changed away from the default; everyone
 * in `expected` who is not mentioned stays present. That is what makes
 * "all present by default" a property of the saved record and not merely of the
 * screen the trainer happened to be looking at.
 */
export function buildAttendanceRecords(
  expected: TrainerScopedEmployee[],
  marks: Map<string, { status: AttendanceStatus; remark?: string }>,
): IAttendanceRecord[] {
  return expected.map((emp) => {
    const mark = marks.get(emp.employeeId);
    return {
      employeeId: emp.employeeId,
      employeeName: emp.name,
      designation: emp.designation || undefined,
      department: emp.department,
      employeeCode: emp.employeeCode,
      status: mark?.status ?? 'present',
      remark: mark?.remark?.trim() || undefined,
    };
  });
}

/** Attendance sheets in the given departments, newest session first. */
export async function listAttendanceSheets(opts: {
  departments?: string[];
  sopCode?: string;
  employeeId?: string;
  year?: number;
  month?: number;
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<TrainingAttendanceLean[]> {
  const query: Record<string, unknown> = {};

  if (opts.departments?.length) {
    query.department = {
      $in: departmentAliasStrings(opts.departments).map(
        (d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      ),
    };
  }
  if (opts.sopCode) query.sopCode = opts.sopCode.toUpperCase();
  if (opts.employeeId) query['records.employeeId'] = opts.employeeId;
  if (opts.year) query.year = opts.year;
  if (opts.month) query.month = opts.month;
  if (opts.from || opts.to) {
    const range: Record<string, Date> = {};
    if (opts.from) range.$gte = opts.from;
    if (opts.to) range.$lte = opts.to;
    query.trainingDate = range;
  }

  return TrainingAttendance.find(query)
    .sort({ trainingDate: -1, sopCode: 1 })
    .limit(Math.min(Math.max(opts.limit ?? 200, 1), 500))
    .lean<TrainingAttendanceLean[]>();
}

export interface TrainableSop {
  sopCode: string;
  sopName: string;
  department: string;
  /** An MCQ bank exists, so this SOP also has an online exam. */
  hasExam: boolean;
  /** Employees in scope whose training matrix carries this SOP. */
  assignedCount: number;
}

/**
 * SOPs a trainer can record a session for.
 *
 * Sourced from the department's training matrix rather than the exam catalogue:
 * classroom training happens for SOPs that have no MCQ bank yet, and refusing to
 * record attendance for those would leave real sessions unrecorded. SOPs that do
 * have a bank are merged in and flagged `hasExam`.
 */
export function buildTrainableSopList(
  assignmentsByEmployee: Array<{ department: string; assignments: Array<{ sopCode: string; sopName?: string; sopDepartment?: string }> }>,
  examCatalog: Array<{ sopCode: string; sopName: string; department: string }>,
  stripSopVersion: (code: string) => string,
): TrainableSop[] {
  const byCode = new Map<string, TrainableSop>();

  for (const { department, assignments } of assignmentsByEmployee) {
    for (const a of assignments) {
      const code = stripSopVersion(a.sopCode);
      if (!code) continue;
      const existing = byCode.get(code);
      if (existing) {
        existing.assignedCount++;
        if (!existing.sopName || existing.sopName === code) {
          existing.sopName = a.sopName || existing.sopName;
        }
      } else {
        byCode.set(code, {
          sopCode: code,
          sopName: a.sopName || code,
          department: a.sopDepartment || department,
          hasExam: false,
          assignedCount: 1,
        });
      }
    }
  }

  for (const exam of examCatalog) {
    const code = stripSopVersion(exam.sopCode);
    if (!code) continue;
    const existing = byCode.get(code);
    if (existing) {
      existing.hasExam = true;
      // The exam catalogue carries the registry's canonical name/department.
      existing.sopName = exam.sopName || existing.sopName;
      existing.department = exam.department || existing.department;
    } else {
      byCode.set(code, {
        sopCode: code,
        sopName: exam.sopName || code,
        department: exam.department,
        hasExam: true,
        assignedCount: 0,
      });
    }
  }

  return [...byCode.values()].sort((a, b) => a.sopCode.localeCompare(b.sopCode));
}

/** Per-employee roll-up across the given sheets, for the report view. */
export function summarizeByEmployee(sheets: TrainingAttendanceLean[]) {
  const byEmployee = new Map<
    string,
    {
      employeeId: string;
      employeeName: string;
      department: string;
      designation: string;
      sessions: number;
      present: number;
      absent: number;
    }
  >();

  for (const sheet of sheets) {
    for (const r of sheet.records ?? []) {
      let row = byEmployee.get(r.employeeId);
      if (!row) {
        row = {
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          department: r.department,
          designation: r.designation || '',
          sessions: 0,
          present: 0,
          absent: 0,
        };
        byEmployee.set(r.employeeId, row);
      }
      row.sessions++;
      if (r.status === 'present') row.present++;
      else row.absent++;
    }
  }

  return [...byEmployee.values()]
    .map((row) => ({
      ...row,
      attendancePct: row.sessions > 0 ? Math.round((row.present / row.sessions) * 100) : 0,
    }))
    .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
}
