/**
 * Trainer-scheduled LMS exams.
 *
 * A scheduled exam is a deadline a trainer sets for one employee × SOP. The
 * completion state is never stored on the schedule — it is derived from the
 * learner's `LearningProgress` quiz step every time it is read, so the trainer
 * dashboard updates itself as soon as the employee finishes the exam.
 *
 * Status rules (requirement: Completed / Pending / Overdue):
 * - completed — the learner passed the SOP assessment (quiz or quizGu)
 * - overdue   — not completed and the scheduled date has passed
 * - pending   — not completed and the scheduled date is today or later
 */

import LearningProgress from '@/models/lms/LearningProgress';
import ScheduledExam, { type IScheduledExam } from '@/models/lms/ScheduledExam';
import { toDateOnlyIso } from '@/lib/trainingExamSchedule';

export type ExamCompletionStatus = 'completed' | 'pending' | 'overdue';

export const EXAM_STATUS_LABEL: Record<ExamCompletionStatus, string> = {
  completed: 'Completed',
  pending: 'Pending',
  overdue: 'Overdue',
};

export type ScheduledExamLean = {
  _id: unknown;
  trainerId: string;
  trainerName: string;
  employeeId: string;
  employeeName: string;
  department: string;
  designation?: string;
  sopCode: string;
  sopName?: string;
  scheduledDate: Date;
  month: number;
  year: number;
  status: string;
  notes?: string;
  createdAt?: Date;
};

export function stripVersion(code: string): string {
  return String(code || '')
    .toUpperCase()
    .replace(/-\d+$/, '')
    .trim();
}

export function empAssignmentKey(department: string, name: string): string {
  return `${department}||${name}`.trim().toLowerCase();
}

/** Start of "today" in UTC, so date-only deadlines compare consistently. */
export function utcToday(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function computeExamStatus(
  scheduledDate: Date | string,
  completed: boolean,
  now = new Date(),
): ExamCompletionStatus {
  if (completed) return 'completed';
  const due = scheduledDate instanceof Date ? scheduledDate : new Date(scheduledDate);
  const dueDay = new Date(
    Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate()),
  );
  // The employee has the whole scheduled day to finish.
  return dueDay < utcToday(now) ? 'overdue' : 'pending';
}

/** True when the learner finished this SOP's assessment in either language. */
export function isExamCompleted(progress: ExamProgress | undefined): boolean {
  if (!progress) return false;
  if (progress.status === 'completed' && (progress.overallPercentage ?? 0) >= 100) return true;
  const steps = progress.steps || {};
  for (const key of ['quiz', 'quizGu'] as const) {
    const step = steps[key] as { completed?: boolean; passed?: boolean } | undefined;
    if (step?.completed === true || step?.passed === true) return true;
  }
  return false;
}

export type ExamProgress = {
  steps?: Record<string, unknown>;
  status?: string;
  overallPercentage?: number;
  completedAt?: Date;
  updatedAt?: Date;
};

/** Latest quiz attempt timestamp, used when `completedAt` was never stamped. */
export function examCompletionDate(progress: ExamProgress | undefined): string | undefined {
  if (!progress) return undefined;
  if (progress.completedAt) return toDateOnlyIso(new Date(progress.completedAt));
  const steps = progress.steps || {};
  let latest: Date | undefined;
  for (const key of ['quiz', 'quizGu'] as const) {
    const step = steps[key] as
      | { attemptHistory?: Array<{ at?: Date | string; score?: number }> }
      | undefined;
    for (const attempt of step?.attemptHistory ?? []) {
      if (!attempt?.at) continue;
      const at = new Date(attempt.at);
      if (!latest || at > latest) latest = at;
    }
  }
  if (latest) return toDateOnlyIso(latest);
  return progress.updatedAt ? toDateOnlyIso(new Date(progress.updatedAt)) : undefined;
}

/** Quiz score of the best-completed language variant, if any. */
export function examScore(progress: ExamProgress | undefined): number | undefined {
  const steps = progress?.steps || {};
  let best: number | undefined;
  for (const key of ['quiz', 'quizGu'] as const) {
    const step = steps[key] as { score?: number } | undefined;
    if (typeof step?.score === 'number' && (best === undefined || step.score > best)) {
      best = step.score;
    }
  }
  return best;
}

/**
 * Progress rows for the given employees, keyed `employeeId::BASESOPCODE`.
 * Versioned SOP codes collapse onto the base so a schedule for `ABC` matches
 * progress recorded against `ABC-00`.
 */
export async function loadExamProgressMap(
  employeeIds: string[],
): Promise<Map<string, ExamProgress>> {
  const map = new Map<string, ExamProgress>();
  if (employeeIds.length === 0) return map;

  const rows = await LearningProgress.find({ employeeId: { $in: employeeIds } })
    .select('employeeId sopCode steps status overallPercentage completedAt updatedAt')
    .lean<Array<{
      employeeId: unknown;
      sopCode: string;
      steps?: Record<string, unknown>;
      status?: string;
      overallPercentage?: number;
      completedAt?: Date;
      updatedAt?: Date;
    }>>();

  for (const row of rows) {
    const key = `${String(row.employeeId)}::${stripVersion(row.sopCode)}`;
    const entry: ExamProgress = {
      steps: row.steps || {},
      status: row.status,
      overallPercentage: row.overallPercentage,
      completedAt: row.completedAt,
      updatedAt: row.updatedAt,
    };
    const existing = map.get(key);
    // Keep the row that shows the most progress when versions collide.
    if (!existing || isExamCompleted(entry)) map.set(key, entry);
  }
  return map;
}

export interface ScheduledExamView {
  id: string;
  employeeId: string;
  employeeName: string;
  designation: string;
  department: string;
  sopCode: string;
  sopName: string;
  scheduledDate: string;
  month: number;
  year: number;
  status: ExamCompletionStatus;
  completedDate?: string;
  score?: number;
  progressPct: number;
  /** Days past the deadline; 0 unless overdue. */
  daysOverdue: number;
  trainerName: string;
  notes?: string;
}

export function buildScheduledExamView(
  doc: ScheduledExamLean,
  progress: ExamProgress | undefined,
  now = new Date(),
): ScheduledExamView {
  const completed = isExamCompleted(progress);
  const status = computeExamStatus(doc.scheduledDate, completed, now);
  const due = new Date(doc.scheduledDate);
  const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const daysOverdue =
    status === 'overdue'
      ? Math.max(0, Math.round((utcToday(now).getTime() - dueDay) / 86_400_000))
      : 0;

  return {
    id: String(doc._id),
    employeeId: doc.employeeId,
    employeeName: doc.employeeName,
    designation: doc.designation || '',
    department: doc.department,
    sopCode: doc.sopCode,
    sopName: doc.sopName || doc.sopCode,
    scheduledDate: toDateOnlyIso(new Date(doc.scheduledDate)),
    month: doc.month,
    year: doc.year,
    status,
    completedDate: completed ? examCompletionDate(progress) : undefined,
    score: completed ? examScore(progress) : undefined,
    progressPct: completed ? 100 : Math.max(0, Math.min(100, progress?.overallPercentage ?? 0)),
    daysOverdue,
    trainerName: doc.trainerName,
    notes: doc.notes || undefined,
  };
}

/** Live (non-cancelled) schedules for a set of departments and an optional year. */
export async function listScheduledExams(opts: {
  departments?: string[];
  year?: number;
  month?: number;
  employeeIds?: string[];
}): Promise<ScheduledExamLean[]> {
  const query: Record<string, unknown> = { status: 'scheduled' };
  if (opts.departments?.length) {
    query.department = {
      $in: opts.departments.map(
        (d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      ),
    };
  }
  if (opts.year) query.year = opts.year;
  if (opts.month) query.month = opts.month;
  if (opts.employeeIds?.length) query.employeeId = { $in: opts.employeeIds };

  return ScheduledExam.find(query)
    .sort({ scheduledDate: 1, employeeName: 1 })
    .lean<ScheduledExamLean[]>();
}

export function serializeScheduledExam(doc: IScheduledExam | ScheduledExamLean) {
  return {
    id: String(doc._id),
    employeeId: doc.employeeId,
    employeeName: doc.employeeName,
    department: doc.department,
    designation: doc.designation || '',
    sopCode: doc.sopCode,
    sopName: doc.sopName || doc.sopCode,
    scheduledDate: toDateOnlyIso(new Date(doc.scheduledDate)),
    month: doc.month,
    year: doc.year,
    status: doc.status,
    notes: doc.notes || undefined,
  };
}
