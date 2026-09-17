import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsManager } from '@/lib/lmsTrainerAuth';
import {
  getOrBuildLmsCache,
  invalidateLmsServerKeys,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import ExamSettings from '@/models/lms/ExamSettings';

export const dynamic = 'force-dynamic';

// GET /api/lms/admin/exam-settings
export async function GET() {
  const auth = await requireLmsManager();
  if (!auth.ok) return auth.response;

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.adminExamSettings(),
      lmsServerTtl.adminExamSettings,
      async () => {
        await connectDB();
        const settings = await ExamSettings.findOneAndUpdate(
          { settingsKey: 'global' },
          { $setOnInsert: { settingsKey: 'global' } },
          { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
        ).lean();
        return { settings };
      },
    );
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// PATCH /api/lms/admin/exam-settings
export async function PATCH(req: NextRequest) {
  const auth = await requireLmsManager();
  if (!auth.ok) return auth.response;

  try {
    await connectDB();
    const body = await req.json() as Record<string, unknown>;

    const allowed = [
      'examQuestionCount', 'trialQuestionCount', 'passingScore',
      'timeLimitMinutes', 'shuffleQuestions', 'shuffleOptions',
      'showAnswersAfterTrial', 'allowRetakeAfterPass', 'maxAttempts',
      'passingScoreRules',
    ];
    const update: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in body) update[key] = body[key];
    }

    const settings = await ExamSettings.findOneAndUpdate(
      { settingsKey: 'global' },
      { $set: update },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();

    invalidateLmsServerKeys(
      lmsServerKeys.adminExamSettings(),
      lmsServerKeys.adminSopExamSettings(),
    );
    return NextResponse.json({ settings });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
