import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import {
  getOrBuildLmsCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import LearningProgress from '@/models/lms/LearningProgress';

export const dynamic = 'force-dynamic';

// GET /api/lms/progress — all progress records for the current learner
export async function GET() {
  const payload = await resolveLmsIdentity();
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.progress(payload.sub),
      lmsServerTtl.userProgress,
      async () => {
        await connectDB();
        const records = await LearningProgress.find({ employeeId: payload.sub })
          .sort({ lastAccessedAt: -1 })
          .lean();
        return { progress: records };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(30) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
