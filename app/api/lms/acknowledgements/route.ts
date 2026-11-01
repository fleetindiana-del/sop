import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import { rollupExamAttempts, type ExamAttemptEntry } from '@/lib/lmsExamAttempts';
import { resolveExamRecordSubject, sanitizeWrongQuestion } from '@/lib/lmsExamReview';
import { sopFamilyIdentifierRegex } from '@/lib/sop-utils';
import { getJourneyContent } from '@/lib/lmsJourneyContent';
import Employee from '@/models/Employee';
import LearningProgress from '@/models/lms/LearningProgress';
import ExamAcknowledgement, {
  type IAcknowledgedQuestion,
  type IExamAcknowledgement,
} from '@/models/lms/ExamAcknowledgement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const QUIZ_STEPS = ['quiz', 'quizGu'] as const;

type QuizStepLean = {
  passed?: boolean;
  completed?: boolean;
  attempts?: number;
  attemptHistory?: ExamAttemptEntry[];
};

type ProgressLean = { sopCode: string; steps?: Record<string, QuizStepLean | undefined> };

type EmployeeLean = {
  _id: unknown;
  name: string;
  employeeId?: string;
  designation?: string;
  department?: string;
};

type AckLean = Pick<IExamAcknowledgement, 'attempt' | 'score' | 'attemptAt' | 'sopName' | 'questions'>;

/** Entries saved before the flag existed were stored only once ticked. */
function isAcknowledged(q: IAcknowledgedQuestion): boolean {
  return q.acknowledged === true || (q.acknowledged === undefined && Boolean(q.acknowledgedAt));
}

/**
 * GET /api/lms/acknowledgements?sopCode=X[&employeeId=Y]
 *   → exam history for one SOP: every attempt (date, score, result) and, per
 *     attempt, every incorrectly answered question with its acknowledgement.
 *     Feeds both the attempt detail view and the Acknowledgement Letter.
 * GET /api/lms/acknowledgements[?employeeId=Y]
 *   → per-SOP totals (wrong / acknowledged), for record screens.
 */
export async function GET(req: NextRequest) {
  const subject = await resolveExamRecordSubject(req.nextUrl.searchParams.get('employeeId') || '');
  if (!subject.ok) return NextResponse.json({ error: subject.error }, { status: subject.status });
  const { employeeId, isSelf } = subject;
  const sopCode = req.nextUrl.searchParams.get('sopCode')?.trim() || '';

  try {
    await connectDB();

    if (!sopCode) {
      const rows = await ExamAcknowledgement.aggregate<{
        _id: string;
        wrong: number;
        acknowledged: number;
        attempts: number[];
      }>([
        { $match: { employeeId: new mongoose.Types.ObjectId(employeeId), 'questions.0': { $exists: true } } },
        {
          $project: {
            sopCode: 1,
            attempt: 1,
            wrong: { $size: '$questions' },
            acknowledged: {
              $size: {
                $filter: {
                  input: '$questions',
                  cond: {
                    $or: [
                      { $eq: ['$$this.acknowledged', true] },
                      {
                        $and: [
                          { $eq: [{ $type: '$$this.acknowledged' }, 'missing'] },
                          { $ne: [{ $ifNull: ['$$this.acknowledgedAt', null] }, null] },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        {
          $group: {
            _id: '$sopCode',
            wrong: { $sum: '$wrong' },
            acknowledged: { $sum: '$acknowledged' },
            attempts: { $push: '$attempt' },
          },
        },
      ]);
      return NextResponse.json({
        summaries: rows.map((r) => ({
          sopCode: r._id,
          wrong: r.wrong,
          acknowledged: r.acknowledged,
          attempts: [...r.attempts].sort((a, b) => a - b),
        })),
      });
    }

    const family = sopFamilyIdentifierRegex(sopCode);
    const [employee, progress, acks] = await Promise.all([
      Employee.findById(employeeId)
        .select('name employeeId designation department')
        .lean<EmployeeLean | null>(),
      // The link may carry the assignment's versioned code (QAGE124-04) while the
      // exam was recorded under another form of it (QAGE124) — match the family.
      LearningProgress.find({ employeeId, sopCode: { $regex: family } })
        .select('sopCode steps.quiz steps.quizGu updatedAt')
        .sort({ updatedAt: -1 })
        .lean<ProgressLean[]>()
        .then((rows) => rows.find((r) => r.sopCode === sopCode) ?? rows[0] ?? null),
      ExamAcknowledgement.find({ employeeId, sopCode: { $regex: family } })
        .sort({ attempt: 1 })
        .lean<AckLean[]>(),
    ]);
    if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

    const rollup = rollupExamAttempts(progress?.steps?.quiz, progress?.steps?.quizGu);
    const recordedCode = progress?.sopCode || sopCode;
    let sopName = acks.find((a) => a.sopName)?.sopName || '';
    if (!sopName) {
      try {
        sopName = (await getJourneyContent(recordedCode)).sop?.name || '';
      } catch { /* the code is still shown */ }
    }

    const ackByAttempt = new Map(acks.map((a) => [a.attempt, a]));
    let totalWrong = 0;
    let totalAcknowledged = 0;

    const attempts = rollup.history.map((h) => {
      const review = ackByAttempt.get(h.attempt);
      const questions = (review?.questions ?? []).map((q) => {
        const acknowledged = isAcknowledged(q);
        return {
          questionId: q.questionId,
          question: q.question,
          givenAnswer: q.givenAnswer,
          givenText: q.givenText,
          correctAnswer: q.correctAnswer,
          correctText: q.correctText,
          sopReference: q.sopReference || '',
          acknowledged,
          acknowledgedAt: acknowledged ? q.acknowledgedAt ?? null : null,
        };
      });
      const acknowledgedCount = questions.filter((q) => q.acknowledged).length;
      totalWrong += questions.length;
      totalAcknowledged += acknowledgedCount;
      // An attempt has question detail when its wrong questions were saved at
      // submit, or when it was recorded with a wrong-question list (a perfect
      // score records an empty one).
      const detailRecorded = Boolean(review) || Array.isArray(h.wrongQuestionIds);
      return {
        attempt: h.attempt,
        score: h.score,
        passed: h.passed ?? (rollup.passedOnAttempt === h.attempt),
        at: h.at ?? null,
        isPassingAttempt: rollup.passedOnAttempt === h.attempt,
        questionDetailRecorded: detailRecorded,
        wrongCount: detailRecorded ? questions.length : null,
        acknowledgedCount: detailRecorded ? acknowledgedCount : null,
        questions,
      };
    });

    return NextResponse.json({
      employee: {
        id: String(employee._id),
        name: employee.name,
        employeeCode: employee.employeeId || '',
        designation: employee.designation || '',
        department: employee.department || '',
      },
      isSelf,
      sopCode: recordedCode,
      sopName,
      exam: {
        totalAttempts: rollup.total,
        passedOnAttempt: rollup.passedOnAttempt ?? null,
        totalWrong,
        totalAcknowledged,
        attempts,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

/**
 * POST /api/lms/acknowledgements — the learner ticks (or unticks) the
 * acknowledgement on one incorrect question of a formal exam attempt.
 *
 * Body: { sopCode, step?, attempt, acknowledged, questionId, question? }
 * `question` (the full wrong-answer detail) is only needed when the attempt's
 * wrong questions were not saved at submit, e.g. a submit still in flight.
 *
 * Accepted only for the learner's own attempt, and only for a question that
 * attempt recorded as answered incorrectly.
 */
export async function POST(req: NextRequest) {
  const self = await resolveLmsIdentity();
  if (!self) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const body = await req.json() as Record<string, unknown>;
    const sopCode = String(body.sopCode ?? '').trim();
    const step = (QUIZ_STEPS as readonly string[]).includes(String(body.step)) ? String(body.step) : 'quiz';
    const attempt = Number(body.attempt);
    const acknowledged = body.acknowledged === true;
    const detail = sanitizeWrongQuestion(body.question);
    const questionId = String(body.questionId ?? detail?.questionId ?? '').trim();

    if (!sopCode || !Number.isInteger(attempt) || attempt < 1 || !questionId) {
      return NextResponse.json({ error: 'sopCode, attempt and questionId are required' }, { status: 400 });
    }

    await connectDB();
    const filter = { employeeId: self.sub, sopCode, attempt };
    const now = new Date();

    // Normal path: the question was saved when the attempt was submitted.
    const hit = await ExamAcknowledgement.updateOne(
      {
        ...filter,
        // Re-ticking keeps the original acknowledgement time.
        questions: acknowledged
          ? { $elemMatch: { questionId, acknowledged: { $ne: true } } }
          : { $elemMatch: { questionId } },
      },
      acknowledged
        ? { $set: { 'questions.$.acknowledged': true, 'questions.$.acknowledgedAt': now } }
        : { $set: { 'questions.$.acknowledged': false }, $unset: { 'questions.$.acknowledgedAt': 1 } },
    );
    if (hit.matchedCount > 0) return NextResponse.json({ ok: true, acknowledged });
    if (await ExamAcknowledgement.exists({ ...filter, 'questions.questionId': questionId })) {
      return NextResponse.json({ ok: true, acknowledged });
    }

    // Fallback: verify against the attempt record, then file the question.
    const progress = await LearningProgress.findOne({ employeeId: self.sub, sopCode })
      .select(`steps.${step}`)
      .lean<ProgressLean | null>();
    const record = progress?.steps?.[step]?.attemptHistory?.find((h) => h.attempt === attempt);
    if (!record) {
      // The attempt's result may still be on its way to the server — the client retries.
      return NextResponse.json({ error: 'Attempt not recorded yet' }, { status: 409 });
    }
    if (!Array.isArray(record.wrongQuestionIds) || !record.wrongQuestionIds.includes(questionId)) {
      return NextResponse.json(
        { error: 'This question was not answered incorrectly in that attempt' },
        { status: 422 },
      );
    }
    if (!detail || detail.questionId !== questionId) {
      return NextResponse.json({ error: 'Question details are required' }, { status: 400 });
    }

    await ExamAcknowledgement.updateOne(
      filter,
      {
        $setOnInsert: { step },
        $set: { score: record.score, ...(record.at ? { attemptAt: new Date(record.at) } : {}) },
      },
      { upsert: true },
    );
    await ExamAcknowledgement.updateOne(
      { ...filter, 'questions.questionId': { $ne: questionId } },
      {
        $push: {
          questions: { ...detail, acknowledged, ...(acknowledged ? { acknowledgedAt: now } : {}) },
        },
      },
    );
    return NextResponse.json({ ok: true, acknowledged });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
