import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import {
  getOrBuildLmsCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import Certificate from '@/models/lms/Certificate';

export const dynamic = 'force-dynamic';

// GET /api/lms/certificates — all certificates earned by the current learner
export async function GET() {
  const payload = await resolveLmsIdentity();
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.certificates(payload.sub),
      lmsServerTtl.userDashboard,
      async () => {
        await connectDB();
        const certificates = await Certificate.find({ employeeId: payload.sub })
          .sort({ issuedAt: -1 })
          .select('certificateNumber sopCode sopName sopVersion completedAt quizScore hasPractical practicalScore issuedAt')
          .lean();
        return { certificates };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(60) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
