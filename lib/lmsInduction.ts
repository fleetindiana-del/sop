/**
 * Induction training as its own track: which induction SOPs an employee has,
 * how each exam went (attempts, score, completion date), and the one
 * consolidated induction certificate issued once all of them are completed.
 * Shared by the learner's Induction Training tab, the induction certificate
 * page and the SOP Admin induction dashboard so all three agree.
 */

import mongoose from 'mongoose';
import type { EmployeeSopAssignment } from '@/lib/employeeAssignments';
import {
  examCompletionDate,
  examScore,
  isExamCompleted,
  loadExamProgressMap,
  stripVersion,
  type ExamProgress,
} from '@/lib/lmsExamScheduling';
import { rollupExamAttempts, type ExamAttemptEntry } from '@/lib/lmsExamAttempts';
import InductionCertificate, { type IInductionCertificate } from '@/models/lms/InductionCertificate';

export type InductionStatus = 'not_assigned' | 'in_progress' | 'completed';

export interface InductionSopRecord {
  sopCode: string;
  sopName: string;
  sopDepartment?: string;
  month?: number;
  monthName?: string;
  year?: number;
  completed: boolean;
  /** YYYY-MM-DD */
  completedAt?: string;
  attempts: number;
  passedOnAttempt?: number;
  score?: number;
}

export interface InductionSummary {
  status: InductionStatus;
  total: number;
  completedCount: number;
  /** YYYY-MM-DD the last induction SOP was completed, once all are done. */
  completedAt?: string;
  sops: InductionSopRecord[];
}

export interface InductionCertificateView {
  certificateNumber: string;
  employeeName: string;
  employeeCode?: string;
  designation: string;
  department: string;
  dateOfJoining?: string;
  completedAt: string;
  issuedAt: string;
  sops: InductionSopRecord[];
}

type QuizStep = {
  passed?: boolean;
  completed?: boolean;
  attempts?: number;
  attemptHistory?: ExamAttemptEntry[];
};

/** Induction SOPs of an assignment list, one per SOP family. */
export function inductionAssignmentsOf<T extends EmployeeSopAssignment>(assignments: T[]): T[] {
  const seen = new Set<string>();
  return assignments.filter((a) => {
    if (a.trainingType !== 'induction') return false;
    const fam = stripVersion(a.sopCode);
    if (!fam || seen.has(fam)) return false;
    seen.add(fam);
    return true;
  });
}

function toIsoDate(value: Date | string | undefined | null): string | undefined {
  if (!value) return undefined;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export function summarizeInduction(
  employeeId: string,
  assignments: EmployeeSopAssignment[],
  progress: Map<string, ExamProgress>,
): InductionSummary {
  const sops: InductionSopRecord[] = inductionAssignmentsOf(assignments).map((a) => {
    const p = progress.get(`${employeeId}::${stripVersion(a.sopCode)}`);
    const steps = (p?.steps || {}) as { quiz?: QuizStep; quizGu?: QuizStep };
    const rollup = rollupExamAttempts(steps.quiz, steps.quizGu);
    const completed = isExamCompleted(p);
    return {
      sopCode: a.sopCode,
      sopName: a.sopName || a.sopCode,
      sopDepartment: a.sopDepartment,
      month: a.month,
      monthName: a.monthName,
      year: a.year,
      completed,
      completedAt: completed ? examCompletionDate(p) : undefined,
      attempts: rollup.total,
      passedOnAttempt: rollup.passedOnAttempt,
      score: rollup.passingScore ?? (completed ? examScore(p) : undefined),
    };
  });
  sops.sort((x, y) => Number(x.completed) - Number(y.completed) || x.sopCode.localeCompare(y.sopCode));

  const completedCount = sops.filter((s) => s.completed).length;
  const status: InductionStatus =
    sops.length === 0 ? 'not_assigned' : completedCount === sops.length ? 'completed' : 'in_progress';
  const completedAt = status === 'completed'
    ? sops.map((s) => s.completedAt || '').sort().pop() || undefined
    : undefined;
  return { status, total: sops.length, completedCount, completedAt, sops };
}

/** Induction summaries keyed by employee id. */
export async function loadInductionSummaries(
  employees: Array<{ id: string; assignments: EmployeeSopAssignment[] }>,
): Promise<Map<string, InductionSummary>> {
  const progress = await loadExamProgressMap(employees.map((e) => e.id));
  return new Map(employees.map((e) => [e.id, summarizeInduction(e.id, e.assignments, progress)]));
}

export function inductionCertificateView(doc: IInductionCertificate | Record<string, unknown>): InductionCertificateView {
  const c = doc as unknown as IInductionCertificate;
  return {
    certificateNumber: c.certificateNumber,
    employeeName: c.employeeName,
    employeeCode: c.employeeCode || undefined,
    designation: c.designation,
    department: c.department,
    dateOfJoining: toIsoDate(c.dateOfJoining),
    completedAt: toIsoDate(c.completedAt) || '',
    issuedAt: toIsoDate(c.issuedAt) || '',
    sops: (c.sops || []).map((s) => ({
      sopCode: s.sopCode,
      sopName: s.sopName,
      completed: true,
      completedAt: toIsoDate(s.completedAt),
      attempts: s.attempts || 0,
      passedOnAttempt: s.passedOnAttempt ?? undefined,
      score: s.score ?? undefined,
    })),
  };
}

function certificateNumber(now = new Date()): string {
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  return `IND-${ymd}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
}

export async function findInductionCertificates(
  employeeIds: string[],
): Promise<Map<string, InductionCertificateView>> {
  const ids = employeeIds.filter((id) => mongoose.isValidObjectId(id));
  if (ids.length === 0) return new Map();
  const docs = await InductionCertificate.find({ employeeId: { $in: ids } }).lean();
  return new Map(
    (docs as unknown as IInductionCertificate[]).map((d) => [String(d.employeeId), inductionCertificateView(d)]),
  );
}

/**
 * The employee's consolidated induction certificate: returned when already
 * issued, issued now when every induction SOP is completed, otherwise null.
 */
export async function ensureInductionCertificate(
  employee: {
    _id: unknown;
    name: string;
    employeeId?: string;
    designation?: string;
    department?: string;
    dateOfJoining?: Date;
  },
  summary: InductionSummary,
): Promise<InductionCertificateView | null> {
  const employeeId = String(employee._id);
  const existing = await InductionCertificate.findOne({ employeeId }).lean();
  if (existing) return inductionCertificateView(existing as unknown as IInductionCertificate);
  if (summary.status !== 'completed') return null;

  const payload = {
    employeeId,
    employeeName: employee.name,
    employeeCode: employee.employeeId || undefined,
    designation: employee.designation || '',
    department: employee.department || '',
    dateOfJoining: employee.dateOfJoining,
    sops: summary.sops.map((s) => ({
      sopCode: s.sopCode,
      sopName: s.sopName,
      attempts: s.attempts,
      passedOnAttempt: s.passedOnAttempt,
      score: s.score,
      completedAt: s.completedAt ? new Date(`${s.completedAt}T00:00:00Z`) : undefined,
    })),
    completedAt: summary.completedAt ? new Date(`${summary.completedAt}T00:00:00Z`) : new Date(),
    issuedAt: new Date(),
  };
  try {
    const created = await InductionCertificate.create({ ...payload, certificateNumber: certificateNumber() });
    return inductionCertificateView(created.toObject());
  } catch (err: unknown) {
    // A concurrent request issued it first (unique employeeId).
    if (String((err as { code?: number })?.code) === '11000') {
      const doc = await InductionCertificate.findOne({ employeeId }).lean();
      if (doc) return inductionCertificateView(doc as unknown as IInductionCertificate);
    }
    throw err;
  }
}
