/**
 * LMS training-cycle window and schedule status classification.
 *
 * Cycle start is controlled by `LMS_TRAINING_CYCLE_START=YYYY-MM` (e.g. 2026-08).
 * When unset, the cycle starts at the first day of the current calendar month
 * (so historical months from before go-live are not treated as overdue).
 *
 * Statuses:
 * - ignored  — scheduled before the active training cycle (excluded from overdue)
 * - upcoming — scheduled after the current month
 * - due      — scheduled for the current month
 * - overdue / missed — incomplete and scheduled in a past month within the cycle
 *   (`missed` is the trainer-facing label for the same condition)
 */

export type LmsScheduleStatus = 'ignored' | 'upcoming' | 'due' | 'overdue' | 'missed';

export type TrainingCycleStart = {
  year: number;
  month: number; // 1–12
};

function parseCycleEnv(raw: string | undefined): TrainingCycleStart | null {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = /^(\d{4})-(\d{1,2})$/.exec(s);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return null;
  return { year, month };
}

/** First month of the active LMS training cycle (inclusive). */
export function getTrainingCycleStart(now = new Date()): TrainingCycleStart {
  const fromEnv = parseCycleEnv(
    process.env.NEXT_PUBLIC_LMS_TRAINING_CYCLE_START ||
      process.env.LMS_TRAINING_CYCLE_START,
  );
  if (fromEnv) return fromEnv;
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export function currentMonthStart(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function monthStart(year: number, month: number): Date {
  return new Date(year, month - 1, 1);
}

export function isBeforeCycle(
  assignment: { year: number; month: number },
  cycle: TrainingCycleStart = getTrainingCycleStart(),
): boolean {
  return monthStart(assignment.year, assignment.month) < monthStart(cycle.year, cycle.month);
}

export function isFutureScheduled(
  assignment: { year: number; month: number },
  now = new Date(),
): boolean {
  return monthStart(assignment.year, assignment.month) > currentMonthStart(now);
}

export function isCurrentMonth(
  assignment: { year: number; month: number },
  now = new Date(),
): boolean {
  const cur = currentMonthStart(now);
  const a = monthStart(assignment.year, assignment.month);
  return a.getTime() === cur.getTime();
}

/**
 * Classify a scheduled assignment relative to the training cycle.
 * Pass `completed=true` only when the learner finished the SOP (≥100%).
 * Completed items should not use this for tabs that exclude finished work.
 */
export function classifyScheduleStatus(
  assignment: { year: number; month: number },
  opts?: { now?: Date; cycle?: TrainingCycleStart; completed?: boolean },
): LmsScheduleStatus {
  if (opts?.completed) return 'due'; // caller usually filters completed separately
  const now = opts?.now ?? new Date();
  const cycle = opts?.cycle ?? getTrainingCycleStart(now);

  if (isBeforeCycle(assignment, cycle)) return 'ignored';
  if (isFutureScheduled(assignment, now)) return 'upcoming';
  if (isCurrentMonth(assignment, now)) return 'due';

  // Past month inside the active cycle → overdue / missed
  return 'missed';
}

/** Overdue in the learner UI = missed within the active cycle (not pre-cycle). */
export function isOverdueInCycle(
  assignment: { year: number; month: number },
  opts?: { now?: Date; cycle?: TrainingCycleStart; completed?: boolean },
): boolean {
  if (opts?.completed) return false;
  const status = classifyScheduleStatus(assignment, opts);
  return status === 'missed' || status === 'overdue';
}

export function scheduleStatusLabel(status: LmsScheduleStatus): string {
  switch (status) {
    case 'ignored':
      return 'Ignored';
    case 'upcoming':
      return 'Upcoming';
    case 'due':
      return 'Due';
    case 'overdue':
      return 'Overdue';
    case 'missed':
      return 'Missed';
    default:
      return 'Due';
  }
}

/** YYYY-MM for cycle start (for API responses / UI). */
export function formatCycleStart(cycle: TrainingCycleStart = getTrainingCycleStart()): string {
  return `${cycle.year}-${String(cycle.month).padStart(2, '0')}`;
}
