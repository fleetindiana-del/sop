import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import { canViewEmployees } from '@/lib/lmsExamReview';
import { rollupExamAttempts, type ExamAttemptEntry } from '@/lib/lmsExamAttempts';
import { sopFamilyIdentifierRegex } from '@/lib/sop-utils';
import LearningProgress from '@/models/lms/LearningProgress';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type QuizStepLean = { passed?: boolean; completed?: boolean; attempts?: number; attemptHistory?: ExamAttemptEntry[] };

/**
 * GET /api/lms/exam-attempts?sopCode=X&employeeIds=a,b,c
 * → { attempts: { [employeeId]: { total, passedOnAttempt } } } for one SOP.
 *
 * Counts for the trainer's employee list; the per-attempt detail comes from
 * /api/lms/acknowledgements. Employees outside the caller's departments are
 * left out.
 */
export async function GET(req: NextRequest) {
  const sopCode = req.nextUrl.searchParams.get('sopCode')?.trim() || '';
  const requested = (req.nextUrl.searchParams.get('employeeIds') || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => mongoose.isValidObjectId(s))
    .slice(0, 500);
  if (!sopCode) return NextResponse.json({ error: 'sopCode is required' }, { status: 400 });
  if (requested.length === 0) return NextResponse.json({ attempts: {} });

  const access = await canViewEmployees(requested);
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const ids = requested.filter((id) => access.ids.has(id));

  try {
    await connectDB();
    const rows = await LearningProgress.find({
      employeeId: { $in: ids },
      sopCode: { $regex: sopFamilyIdentifierRegex(sopCode) },
    })
      .select('employeeId sopCode steps.quiz steps.quizGu updatedAt')
      .sort({ updatedAt: -1 })
      .lean<Array<{ employeeId: unknown; steps?: { quiz?: QuizStepLean; quizGu?: QuizStepLean } }>>();

    const attempts: Record<string, { total: number; passedOnAttempt: number | null }> = {};
    for (const row of rows) {
      const id = String(row.employeeId);
      if (attempts[id]) continue; // newest record per employee
      const r = rollupExamAttempts(row.steps?.quiz, row.steps?.quizGu);
      if (r.total > 0) attempts[id] = { total: r.total, passedOnAttempt: r.passedOnAttempt ?? null };
    }
    return NextResponse.json({ attempts });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
