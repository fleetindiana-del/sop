import mongoose from 'mongoose';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import { isAdmin } from '@/lib/roles';
import Employee from '@/models/Employee';
import ExamAcknowledgement, { type IAcknowledgedQuestion } from '@/models/lms/ExamAcknowledgement';

/**
 * Per-attempt exam review records: every question a learner answered wrong in a
 * formal attempt, and whether they acknowledged it. Written when the attempt is
 * submitted (`/api/lms/progress/[sopCode]`) and ticked from the review screen
 * (`/api/lms/acknowledgements`).
 */

const MAX_TEXT = 4000;
const MAX_QUESTIONS = 200;

function text(value: unknown): string {
  return String(value ?? '').trim().slice(0, MAX_TEXT);
}

/** A wrong answer as sent by the exam screen, cleaned; null when unusable. */
export function sanitizeWrongQuestion(raw: unknown): Omit<IAcknowledgedQuestion, 'acknowledged' | 'acknowledgedAt'> | null {
  const q = (raw || {}) as Record<string, unknown>;
  const questionId = text(q.questionId);
  const question = text(q.question);
  const correctAnswer = text(q.correctAnswer).slice(0, 1).toUpperCase();
  if (!questionId || !question || !/^[A-D]$/.test(correctAnswer)) return null;
  const given = text(q.givenAnswer).slice(0, 1).toUpperCase();
  return {
    questionId,
    question,
    givenAnswer: /^[A-D]$/.test(given) ? given : '',
    givenText: text(q.givenText),
    correctAnswer,
    correctText: text(q.correctText),
    sopReference: text(q.sopReference),
    explanation: text(q.explanation),
  };
}

export function sanitizeWrongQuestions(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: NonNullable<ReturnType<typeof sanitizeWrongQuestion>>[] = [];
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    const q = sanitizeWrongQuestion(item);
    if (q && !seen.has(q.questionId)) {
      seen.add(q.questionId);
      out.push(q);
    }
  }
  return out;
}

/**
 * Record the wrong answers of one submitted attempt, all unacknowledged.
 * Idempotent: a retried submit adds only questions not already on file and never
 * resets an acknowledgement.
 */
export async function recordAttemptMistakes(input: {
  employeeId: string;
  sopCode: string;
  sopName?: string;
  step: string;
  attempt: number;
  score: number;
  attemptAt: Date;
  questions: NonNullable<ReturnType<typeof sanitizeWrongQuestion>>[];
}): Promise<void> {
  const filter = { employeeId: input.employeeId, sopCode: input.sopCode, attempt: input.attempt };
  const doc = await ExamAcknowledgement.findOneAndUpdate(
    filter,
    {
      $set: {
        step: input.step,
        score: input.score,
        attemptAt: input.attemptAt,
        ...(input.sopName ? { sopName: input.sopName } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  )
    .select('questions.questionId')
    .lean<{ questions?: Array<{ questionId: string }> } | null>();
  const have = new Set((doc?.questions ?? []).map((q) => q.questionId));
  const missing = input.questions
    .filter((q) => !have.has(q.questionId))
    .map((q) => ({ ...q, acknowledged: false }));
  if (missing.length) {
    await ExamAcknowledgement.updateOne(filter, { $push: { questions: { $each: missing } } });
  }
}

/**
 * Whether the current request may read this employee's exam records: the
 * employee themself, any Super Admin / SOP Admin, or a trainer whose
 * departments include the employee's.
 */
export async function resolveExamRecordSubject(
  requestedEmployeeId: string,
): Promise<{ ok: true; employeeId: string; isSelf: boolean } | { ok: false; status: number; error: string }> {
  const self = await resolveLmsIdentity();
  const requested = requestedEmployeeId.trim();
  if (!requested || requested === self?.sub) {
    if (!self) return { ok: false, status: 401, error: 'Not authenticated' };
    return { ok: true, employeeId: self.sub, isSelf: true };
  }
  if (!mongoose.isValidObjectId(requested)) return { ok: false, status: 400, error: 'Invalid employeeId' };
  const allowed = await canViewEmployees([requested]);
  if (!allowed.ok) return allowed;
  if (!allowed.ids.has(requested)) return { ok: false, status: 403, error: 'Employee is outside your departments' };
  return { ok: true, employeeId: requested, isSelf: false };
}

/** Which of these employees the current manager may view (admins: all; trainers: their departments). */
export async function canViewEmployees(
  employeeIds: string[],
): Promise<{ ok: true; ids: Set<string> } | { ok: false; status: number; error: string }> {
  const valid = employeeIds.filter((id) => mongoose.isValidObjectId(id));
  const session = await getServerSession(authOptions);
  if (session?.user?.role && isAdmin(session.user.role)) return { ok: true, ids: new Set(valid) };

  const trainer = await requireLmsTrainer();
  if (!trainer.ok) {
    return { ok: false, status: trainer.response.status, error: 'Trainer access required' };
  }
  await connectDB();
  const rows = await Employee.find({ _id: { $in: valid } })
    .select('department')
    .lean<Array<{ _id: unknown; department?: string }>>();
  const ids = new Set(
    rows
      .filter((r) => deptMatchesTrainerScope(r.department || '', trainer.trainer.trainerDepartments))
      .map((r) => String(r._id)),
  );
  // A trainer may always see their own record.
  ids.add(trainer.trainer.employeeId);
  return { ok: true, ids };
}
