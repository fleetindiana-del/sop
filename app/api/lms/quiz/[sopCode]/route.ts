import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { cookies } from 'next/headers';
import { connectDB } from '@/lib/mongodb';
import { verifyLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import MCQBank from '@/models/MCQBank';
import Employee from '@/models/Employee';
import SOP from '@/models/SOP';
import {
  resolveExamSettingsForSop,
  toLearnerQuizSettings,
} from '@/lib/lms-exam-settings';
import { baseIdentifierFromIdentifier, sopFamilyIdentifierRegex } from '@/lib/sop-utils';
import type { ShuffleMode } from '@/models/lms/SopExamSettings';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ sopCode: string }> };

type RawMcq = {
  bankId: unknown;
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
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
    return {
      _id: `${String(q.bankId)}_${i}`,
      question: q.question,
      optionA: opts[0] ?? '',
      optionB: opts[1] ?? '',
      optionC: opts[2] ?? '',
      optionD: opts[3] ?? '',
      correctAnswer: letter,
      explanation: q.explanation ?? '',
    };
  });
}

/**
 * Pull MCQs for a SOP. Shuffle mode controls selection:
 * - questions / both → random sample (different set per employee)
 * - options / none   → stable ordered slice (same set for everyone)
 * - all=true         → every non-similar question (trainers); still shuffled when mode says so
 */
async function fetchQuestions(
  sopCode: string,
  language: string,
  count: number,
  shuffleMode: ShuffleMode,
  all = false,
): Promise<RawMcq[]> {
  if (!all && count <= 0) return [];

  const familyRegex = sopFamilyIdentifierRegex(sopCode);
  const randomize = shuffleMode === 'questions' || shuffleMode === 'both';

  const pipeline: mongoose.PipelineStage[] = [
    {
      $match: {
        sopIdentifier: { $regex: familyRegex },
        isObsolete: { $ne: true },
        language,
      },
    },
    { $unwind: '$mcqs' },
    { $match: { 'mcqs.isSimilar': { $ne: true } } },
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

  pipeline.push({
    $project: {
      _id: 0,
      bankId: '$_id',
      question: '$mcqs.question',
      options: '$mcqs.options',
      correctAnswer: '$mcqs.correctAnswer',
      explanation: '$mcqs.explanation',
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
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { sopCode } = await params;
  const mode = req.nextUrl.searchParams.get('mode') === 'trial' ? 'trial' : 'exam';
  const language = req.nextUrl.searchParams.get('lang') === 'gu' ? 'Gujarati' : 'English';

  try {
    await connectDB();

    const employee = await Employee.findById(payload.sub)
      .select('department designation isTrainer')
      .lean();

    const resolved = await resolveExamSettingsForSop(sopCode, {
      id: payload.sub,
      department: employee?.department ?? '',
      designation: employee?.designation ?? '',
      isTrainer: employee?.isTrainer === true,
    });

    if (mode === 'exam' && resolved.lmsApproved === false) {
      return NextResponse.json(
        { error: 'This SOP is not approved for LMS exams yet.', settings: toLearnerQuizSettings(resolved) },
        { status: 403 },
      );
    }

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

    const count = mode === 'trial'
      ? resolved.trialQuestionCount
      : resolved.examQuestionCount;

    const useAllExamQuestions = mode === 'exam' && resolved.allExamQuestions;

    const learnerSettings = toLearnerQuizSettings(resolved);

    if (!useAllExamQuestions && count <= 0) {
      return NextResponse.json({
        questions: [],
        mode,
        settings: learnerSettings,
      });
    }

    const raw = await fetchQuestions(
      sopCode,
      language,
      useAllExamQuestions ? Number.MAX_SAFE_INTEGER : count,
      resolved.shuffleMode,
      useAllExamQuestions,
    );
    const questions = toAbcdQuestions(raw);

    // Reflect the real set size so the learner UI / timer pacing stay accurate.
    if (useAllExamQuestions) {
      learnerSettings.examQuestionCount = questions.length;
    }

    return NextResponse.json({
      questions,
      mode,
      settings: learnerSettings,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
