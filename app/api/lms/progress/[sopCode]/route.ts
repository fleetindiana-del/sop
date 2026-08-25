import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import {
  getOrBuildLmsCache,
  invalidateLmsLearnerCache,
  invalidateLmsServerPrefix,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import { LMS_STEP_IDS, recalcOverallPercent } from '@/lib/lmsCompletion';
import LearningProgress from '@/models/lms/LearningProgress';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ sopCode: string }> };

// GET /api/lms/progress/[sopCode]
export async function GET(_req: NextRequest, { params }: Params) {
  const payload = await resolveLmsIdentity();
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
  const payload = await resolveLmsIdentity();
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

    // Keep availableSteps in sync with the current journey (quiz added later, etc.)
    if (Array.isArray(initSteps) && initSteps.length > 0) {
      if (progress.availableSteps.length === 0) {
        progress.availableSteps = initSteps as string[];
      } else {
        const mergedSteps = new Set([
          ...(progress.availableSteps as string[]),
          ...(initSteps as string[]),
        ]);
        progress.availableSteps = Array.from(mergedSteps);
      }
    }

    if (typeof step === 'string' && step) {
      if (!(LMS_STEP_IDS as readonly string[]).includes(step)) {
        return NextResponse.json({ error: 'Invalid step' }, { status: 400 });
      }

      // Ensure the step being updated is counted toward overall progress / certificate.
      if (!progress.availableSteps.includes(step)) {
        progress.availableSteps = [...progress.availableSteps, step];
      }

      // Merge step data
      const current = (progress.steps as Record<string, unknown>)[step] as Record<string, unknown> || {};
      const merged = { ...current, ...stepData };

      // Quiz: once a user has passed, never allow a failed retake to un-complete their training
      if ((step === 'quiz' || step === 'quizGu') && (current.passed === true || current.completed === true)) {
        merged.completed = true;
        merged.passed = true;
      }

      // Append / upsert per-attempt score history for formal exam submits.
      if (
        (step === 'quiz' || step === 'quizGu') &&
        typeof stepData.score === 'number' &&
        typeof stepData.attempts === 'number' &&
        stepData.attempts > 0
      ) {
        const prev = Array.isArray(current.attemptHistory)
          ? ([...current.attemptHistory] as Array<{ attempt: number; score: number; at?: Date }>)
          : [];
        const entry = {
          attempt: stepData.attempts as number,
          score: stepData.score as number,
          at: new Date(),
        };
        const existingIdx = prev.findIndex((h) => h.attempt === entry.attempt);
        if (existingIdx >= 0) prev[existingIdx] = entry;
        else prev.push(entry);
        prev.sort((a, b) => a.attempt - b.attempt);
        merged.attemptHistory = prev;
      }

      (progress.steps as Record<string, unknown>)[step] = merged;
      progress.markModified('steps');

      // Mark start time
      if (!progress.startedAt) progress.startedAt = new Date();
    }

    // Recalculate
    const overall = recalcOverallPercent(
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

    // When a trainer completes an SOP, unlock exams for their department learners.
    if (progress.status === 'completed') {
      try {
        const emp = await (await import('@/models/Employee')).default
          .findById(payload.sub)
          .select('isTrainer')
          .lean<{ isTrainer?: boolean }>();
        if (emp?.isTrainer === true) {
          invalidateLmsServerPrefix('lms:assets:');
        }
      } catch {
        /* non-critical */
      }
    }

    return NextResponse.json({ progress: progress.toObject() });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
