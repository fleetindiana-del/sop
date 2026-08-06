import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { connectDB } from '@/lib/mongodb';
import { verifyLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import {
  getOrBuildLmsCache,
  invalidateLmsLearnerCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import LearningProgress from '@/models/lms/LearningProgress';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ sopCode: string }> };

function recalcOverall(steps: Record<string, unknown>, availableSteps: string[]): number {
  if (availableSteps.length === 0) return 0;

  const quizKeys = availableSteps.filter((k) => k === 'quiz' || k === 'quizGu');
  const hasQuiz = quizKeys.length > 0;

  if (hasQuiz) {
    // The assessment is the only mandatory step. For dual (EN + GU) SOPs,
    // passing either language quiz completes training and unlocks the certificate.
    const quizPassed = quizKeys.some((k) => {
      const s = steps[k] as { completed?: boolean } | undefined;
      return s?.completed === true;
    });
    if (quizPassed) return 100;

    // Before passing, show partial progress from optional steps capped at 90%.
    const optionalSteps = availableSteps.filter((k) => k !== 'quiz' && k !== 'quizGu');
    if (optionalSteps.length === 0) return 0;
    const doneOptional = optionalSteps.filter((k) => {
      const s = steps[k] as { completed?: boolean } | undefined;
      return s?.completed === true;
    }).length;
    return Math.round((doneOptional / optionalSteps.length) * 90);
  }

  // No quiz — all steps count equally.
  const completedCount = availableSteps.filter((key) => {
    const step = steps[key] as { completed?: boolean } | undefined;
    return step?.completed === true;
  }).length;
  return Math.round((completedCount / availableSteps.length) * 100);
}

// GET /api/lms/progress/[sopCode]
export async function GET(_req: NextRequest, { params }: Params) {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { sopCode } = await params;

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.progressSop(payload.sub, sopCode),
      lmsServerTtl.userProgress,
      async () => {
        await connectDB();
        const progress = await LearningProgress.findOne({
          employeeId: payload.sub,
          sopCode,
        }).lean();
        return { progress: progress || null };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(30) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// PATCH /api/lms/progress/[sopCode]
// Body examples:
//   { step: 'videoEn', percentage: 45, lastTimestamp: 120 }
//   { step: 'slidesEn', completed: true }
//   { step: 'quiz', completed: true, passed: true, score: 80, attempts: 1 }
//   { availableSteps: ['videoEn', 'slidesEn', 'sopPdf'] }  — first-time init
export async function PATCH(req: NextRequest, { params }: Params) {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { sopCode } = await params;

  try {
    await connectDB();
    const body = await req.json() as Record<string, unknown>;
    const { step, availableSteps: initSteps, ...stepData } = body;

    let progress = await LearningProgress.findOne({ employeeId: payload.sub, sopCode });

    if (!progress) {
      progress = new LearningProgress({
        employeeId: payload.sub,
        sopCode,
        availableSteps: Array.isArray(initSteps) ? initSteps : [],
        status: 'not_started',
        overallPercentage: 0,
      });
    }

    // Initialize available steps if provided and not yet set
    if (Array.isArray(initSteps) && progress.availableSteps.length === 0) {
      progress.availableSteps = initSteps as string[];
    }

    if (typeof step === 'string' && step) {
      const validSteps = ['videoEn', 'videoGu', 'slidesEn', 'slidesGu', 'sopPdf', 'sopPdfGu', 'quiz', 'quizGu'];
      if (!validSteps.includes(step)) {
        return NextResponse.json({ error: 'Invalid step' }, { status: 400 });
      }

      // Merge step data
      const current = (progress.steps as Record<string, unknown>)[step] as Record<string, unknown> || {};
      const merged = { ...current, ...stepData };

      // Quiz: once a user has passed, never allow a failed retake to un-complete their training
      if ((step === 'quiz' || step === 'quizGu') && (current.passed === true || current.completed === true)) {
        merged.completed = true;
        merged.passed = true;
      }

      (progress.steps as Record<string, unknown>)[step] = merged;
      progress.markModified('steps');

      // Mark start time
      if (!progress.startedAt) progress.startedAt = new Date();
    }

    // Recalculate
    const overall = recalcOverall(
      progress.steps as unknown as Record<string, unknown>,
      progress.availableSteps,
    );
    progress.overallPercentage = overall;
    progress.lastAccessedAt = new Date();

    if (overall === 0) {
      progress.status = 'not_started';
    } else if (overall >= 100) {
      progress.status = 'completed';
      if (!progress.completedAt) progress.completedAt = new Date();
    } else {
      progress.status = 'in_progress';
    }

    await progress.save();
    invalidateLmsLearnerCache(payload.sub, sopCode);
    return NextResponse.json({ progress: progress.toObject() });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
