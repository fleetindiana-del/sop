import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import MCQBank from '@/models/MCQBank';
import Employee from '@/models/Employee';
import SOP from '@/models/SOP';
import LearningProgress from '@/models/lms/LearningProgress';
import {
  resolveExamSettingsForSop,
  sampleTrainerExamQuestions,
  toLearnerQuizSettings,
  TRAINER_EXAM_QUESTION_COUNT,
} from '@/lib/lms-exam-settings';
import { baseIdentifierFromIdentifier, sopFamilyIdentifierRegex } from '@/lib/sop-utils';
import { selectCanonicalBanksByLang } from '@/lib/mcq-bank-utils';
import type { ShuffleMode } from '@/models/lms/SopExamSettings';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ sopCode: string }> };

type RawMcq = {
  bankId: unknown;
  /** Stable master-question id. Identical across languages — the EN and GU
   *  versions of one MCQ carry the same id. */
  mcqId?: string;
  /** Position inside its bank — stable fallback id for MCQs without an mcqId. */
  mcqIndex?: number;
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
  sopReference?: string;
  /** Second-language rendering of THIS question, when a bilingual view was asked
   *  for. Same options in the same order, so the master's letter still scores. */
  altQuestion?: string | null;
  altOptions?: string[] | null;
};

function toAbcdQuestions(raw: RawMcq[]) {
  return raw.map((q, i) => {
    const opts: string[] = Array.isArray(q.options) ? q.options : [];
    let letter: 'A' | 'B' | 'C' | 'D' = 'A';
    const letters = ['A', 'B', 'C', 'D'] as const;
    if (['A', 'B', 'C', 'D'].includes(q.correctAnswer)) {
      letter = q.correctAnswer as 'A' | 'B' | 'C' | 'D';
    } else {
      const idx = opts.findIndex(
        (o) => o.trim().toLowerCase() === String(q.correctAnswer).trim().toLowerCase(),
      );
      if (idx >= 0 && idx < 4) letter = letters[idx];
    }
    // The alt options sit at the SAME indexes as the master's, so `letter` above
    // is the correct answer in both languages — one MCQ, one answer key.
    const altOpts = Array.isArray(q.altOptions) ? q.altOptions : [];
    const alt = q.altQuestion && altOpts.length === 4
      ? {
          question: q.altQuestion,
          optionA: altOpts[0] ?? '',
          optionB: altOpts[1] ?? '',
          optionC: altOpts[2] ?? '',
          optionD: altOpts[3] ?? '',
        }
      : undefined;
    return {
      _id: `${String(q.bankId)}_${q.mcqId ?? `i${q.mcqIndex ?? i}`}`,
      question: q.question,
      optionA: opts[0] ?? '',
      optionB: opts[1] ?? '',
      optionC: opts[2] ?? '',
      optionD: opts[3] ?? '',
      correctAnswer: letter,
      explanation: q.explanation ?? '',
      sopReference: String(q.sopReference || '').trim(),
      ...(alt ? { alt } : {}),
    };
  });
}

/**
 * Pull MCQs for a SOP. Shuffle mode controls selection:
 * - questions / both → random sample (different set per employee)
 * - options / none   → stable ordered slice (same set for everyone)
 * - all=true         → full non-similar pool (trainers); still shuffled when mode says so,
 *                      then capped at TRAINER_EXAM_QUESTION_COUNT with a random sample
 *
 * `source` picks where the text comes from:
 * - 'master'      → the English master questions
 * - 'translation' → the master questions rendered in `lang` (same questions, same
 *                   answers, translated text)
 * - 'legacy'      → a standalone Gujarati bank generated before translations existed
 */
type QuestionSource = 'master' | 'translation' | 'legacy';

async function fetchQuestions(
  sopCode: string,
  language: 'English' | 'Gujarati',
  count: number,
  shuffleMode: ShuffleMode,
  all = false,
  source: QuestionSource = 'master',
  lang: 'gu' = 'gu',
  /** Also project the `lang` rendering alongside the master (trainer view). */
  withAlt = false,
): Promise<RawMcq[]> {
  if (!all && count <= 0) return [];

  const familyRegex = sopFamilyIdentifierRegex(sopCode);
  const randomize = shuffleMode === 'questions' || shuffleMode === 'both';
  const translated = source === 'translation';
  const tPath = `mcqs.translations.${lang}`;

  // A family can still hold an active bank for a prior revision (QAGE82-06 next to
  // QAGE82-7). Exam only the current revision's bank — never a mix of versions.
  const candidates = await MCQBank.find({
    sopIdentifier: { $regex: familyRegex },
    isObsolete: { $ne: true },
    // Translations hang off the English master bank, so that is what we read
    // even when the learner asked for Gujarati.
    ...(translated
      ? { $or: [{ language: 'English' }, { language: { $exists: false } }] }
      : { language }),
  })
    .select('_id sopIdentifier language totalQuestions updatedAt')
    .lean<Array<{ _id: mongoose.Types.ObjectId; sopIdentifier: string; language?: string; totalQuestions?: number; updatedAt?: Date }>>();
  const [canonical] = selectCanonicalBanksByLang(candidates);
  if (!canonical) return [];
  const canonicalId = String(canonical.sopIdentifier).trim().toUpperCase();
  const bankIds = candidates
    .filter((b) => String(b.sopIdentifier).trim().toUpperCase() === canonicalId)
    .map((b) => b._id);

  const pipeline: mongoose.PipelineStage[] = [
    { $match: { _id: { $in: bankIds } } },
    { $unwind: { path: '$mcqs', includeArrayIndex: 'mcqIndex' } },
    {
      $match: {
        'mcqs.isSimilar': { $ne: true },
        // A translation of an edited master is stale — never serve it in an exam.
        ...(translated
          ? { [tPath]: { $exists: true, $ne: null }, [`${tPath}.isStale`]: { $ne: true } }
          : {}),
      },
    },
  ];

  if (all) {
    // Full bank — stable fetch, shuffle in memory when needed so we never under-sample.
    pipeline.push({ $sort: { 'mcqs.question': 1, 'mcqs.sopReference': 1 } });
  } else if (randomize) {
    pipeline.push({ $sample: { size: count } });
  } else {
    // Stable order so every employee gets the same questions.
    pipeline.push({ $sort: { 'mcqs.question': 1, 'mcqs.sopReference': 1 } });
    pipeline.push({ $limit: count });
  }

  // Sorting always keys off the MASTER text, so the stable (non-shuffled) question
  // order is the same set in the same sequence in every language.
  pipeline.push({
    $project: {
      _id: 0,
      bankId: '$_id',
      mcqId: '$mcqs.mcqId',
      mcqIndex: 1,
      question: translated ? `$${tPath}.question` : '$mcqs.question',
      options: translated ? `$${tPath}.options` : '$mcqs.options',
      correctAnswer: translated ? `$${tPath}.correctAnswer` : '$mcqs.correctAnswer',
      explanation: translated ? `$${tPath}.explanation` : '$mcqs.explanation',
      // Clause reference is language-neutral — keep the master's.
      sopReference: '$mcqs.sopReference',
      // Bilingual view: attach the translation when there is a fresh one. Stale or
      // missing translations simply yield null, so the question is still asked —
      // just in the master language only.
      ...(withAlt
        ? {
            altQuestion: {
              $cond: [{ $eq: [`$${tPath}.isStale`, true] }, null, `$${tPath}.question`],
            },
            altOptions: {
              $cond: [{ $eq: [`$${tPath}.isStale`, true] }, null, `$${tPath}.options`],
            },
          }
        : {}),
    },
  });

  const rows = await MCQBank.aggregate<RawMcq>(pipeline);
  if (all && randomize) {
    for (let i = rows.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rows[i], rows[j]] = [rows[j], rows[i]];
    }
  }
  return rows;
}

// GET /api/lms/quiz/[sopCode]?mode=trial|exam&lang=en|gu
export async function GET(req: NextRequest, { params }: Params) {
  const payload = await resolveLmsIdentity();
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { sopCode } = await params;
  let mode: 'trial' | 'exam' = req.nextUrl.searchParams.get('mode') === 'trial' ? 'trial' : 'exam';
  const language = req.nextUrl.searchParams.get('lang') === 'gu' ? 'Gujarati' : 'English';

  try {
    await connectDB();

    const employee = await Employee.findById(payload.sub)
      .select('name department designation isTrainer trainerDepartments')
      .lean();

    const resolved = await resolveExamSettingsForSop(sopCode, {
      id: payload.sub,
      department: employee?.department ?? '',
      designation: employee?.designation ?? '',
      isTrainer: employee?.isTrainer === true,
    });

    // A failed attempt leaves its missed questions pending: the next attempt (even
    // after a reload or on another day) retests only those, and needs 100%.
    const progress = await LearningProgress.findOne({ employeeId: payload.sub, sopCode })
      .select('steps.quiz steps.quizGu')
      .lean<{ steps?: Record<string, { passed?: boolean; pendingRetestIds?: string[] } | undefined> }>();
    const quizSteps = [progress?.steps?.quiz, progress?.steps?.quizGu];
    const retestIds = quizSteps.some((q) => q?.passed === true)
      ? new Set<string>()
      : new Set(quizSteps.flatMap((q) => q?.pendingRetestIds ?? []));
    if (retestIds.size > 0) mode = 'exam';

    const family = (baseIdentifierFromIdentifier(sopCode) || sopCode).toUpperCase();
    const sopDoc = await SOP.findOne({
      isObsolete: { $ne: true },
      $or: [
        { sopBaseId: family },
        { identifier: new RegExp(`^${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`, 'i') },
      ],
    })
      .select('expiryDate versionNum')
      .sort({ versionNum: -1 })
      .lean<{ expiryDate?: Date }>();

    if (mode === 'exam' && sopDoc?.expiryDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const exp = new Date(sopDoc.expiryDate);
      exp.setHours(0, 0, 0, 0);
      if (exp < today) {
        return NextResponse.json(
          {
            error: 'This SOP has expired. The exam is locked until the document is renewed.',
            settings: toLearnerQuizSettings(resolved),
            sopExpired: true,
          },
          { status: 403 },
        );
      }
    }

    if (mode === 'exam') {
      const { getTrainerExamEligibility } = await import('@/lib/lmsTrainerGate');
      const gate = await getTrainerExamEligibility({
        employeeId: payload.sub,
        department: employee?.department,
        isTrainer: employee?.isTrainer === true,
        trainerDepartments: employee?.trainerDepartments,
        sopCode,
      });
      if (!gate.allowed) {
        return NextResponse.json(
          {
            error: gate.reason || 'Exam is locked until your department trainer completes this SOP.',
            settings: toLearnerQuizSettings(resolved),
            trainerPending: true,
            trainerGateCode: gate.code,
          },
          { status: 403 },
        );
      }

      const { getExamAttendanceEligibility } = await import('@/lib/lmsAttendanceGate');
      let examDate: string | null = null;
      if (employee?.name && employee?.department) {
        const { getEmployeeAssignmentsMap } = await import('@/lib/employeeAssignments');
        const assignmentsMap = await getEmployeeAssignmentsMap();
        const key = `${employee.department}||${employee.name}`.trim().toLowerCase();
        const familyRe = sopFamilyIdentifierRegex(sopCode);
        const hit = (assignmentsMap.get(key) || []).find(
          (a) => familyRe.test(a.sopCode)
            || (baseIdentifierFromIdentifier(a.sopCode) || a.sopCode).toUpperCase() === family,
        );
        examDate = hit?.examDate || null;
      }
      const attendanceGate = await getExamAttendanceEligibility({
        employeeId: payload.sub,
        department: employee?.department,
        isTrainer: employee?.isTrainer === true,
        trainerDepartments: employee?.trainerDepartments,
        sopCode,
        examDate,
      });
      if (!attendanceGate.allowed) {
        return NextResponse.json(
          {
            error: attendanceGate.reason || 'Exam unlocks after your trainer marks attendance.',
            settings: toLearnerQuizSettings(resolved),
            attendanceRequired: true,
            attendanceGateCode: attendanceGate.code,
          },
          { status: 403 },
        );
      }
    }

    const count = mode === 'trial'
      ? resolved.trialQuestionCount
      : resolved.examQuestionCount;

    const isRetest = retestIds.size > 0;
    // Retests need the full pool so the saved missed questions can be found in it.
    const useAllExamQuestions = mode === 'exam' && (resolved.allExamQuestions || isRetest);

    const learnerSettings = toLearnerQuizSettings(resolved);

    if (!useAllExamQuestions && count <= 0) {
      return NextResponse.json({
        questions: [],
        mode,
        settings: learnerSettings,
      });
    }

    const wanted = useAllExamQuestions ? Number.MAX_SAFE_INTEGER : count;

    // English reads the master bank. Gujarati prefers translations of that same
    // master (one MCQ, two languages); SOPs not translated yet still fall back to
    // their legacy standalone Gujarati bank so no learner loses their exam.
    // Trainers verify the translated paper, so they always sit the bilingual view:
    // the English master with its Gujarati rendering attached to each question.
    // It is still ONE question with one answer key — never two exams.
    let source: QuestionSource = 'master';
    let raw: RawMcq[] = [];
    let bilingual = false;
    if (resolved.isTrainer) {
      raw = await fetchQuestions(sopCode, 'English', wanted, resolved.shuffleMode, useAllExamQuestions, 'master', 'gu', true);
      bilingual = raw.some((r) => typeof r.altQuestion === 'string' && r.altQuestion.trim() !== '');
      // A SOP that only ever had a standalone Gujarati bank has no master to pair.
      if (raw.length === 0) {
        source = 'legacy';
        raw = await fetchQuestions(sopCode, 'Gujarati', wanted, resolved.shuffleMode, useAllExamQuestions, 'legacy');
      }
    } else if (language === 'Gujarati') {
      source = 'translation';
      raw = await fetchQuestions(sopCode, language, wanted, resolved.shuffleMode, useAllExamQuestions, 'translation');
      if (raw.length === 0) {
        source = 'legacy';
        raw = await fetchQuestions(sopCode, language, wanted, resolved.shuffleMode, useAllExamQuestions, 'legacy');
      }
    } else {
      raw = await fetchQuestions(sopCode, language, wanted, resolved.shuffleMode, useAllExamQuestions, 'master');
    }
    const pool = toAbcdQuestions(raw);
    const retestQuestions = isRetest ? pool.filter((q) => retestIds.has(q._id)) : [];
    // Missed questions no longer in the bank (e.g. regenerated) → normal full attempt.
    const retest = retestQuestions.length > 0;
    const questions = retest
      ? retestQuestions
      : resolved.allExamQuestions && mode === 'exam'
        ? sampleTrainerExamQuestions(pool, TRAINER_EXAM_QUESTION_COUNT)
        : useAllExamQuestions
          ? pool.slice(0, count)
          : pool;

    // Reflect the real set size so the learner UI / timer pacing stay accurate.
    if (useAllExamQuestions) {
      learnerSettings.examQuestionCount = questions.length;
    }
    if (retest) learnerSettings.passingScore = 100;

    return NextResponse.json({
      questions,
      mode,
      retest,
      settings: learnerSettings,
      language: bilingual ? 'both' : source === 'master' ? 'en' : 'gu',
      // The UI renders both renderings of every question when this is set.
      bilingual,
      // Lets the UI (and support) tell a translated exam from a legacy standalone
      // Gujarati bank without inspecting the questions.
      questionSource: source,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
