import { NextRequest, NextResponse } from 'next/server';
import { getOrBuildLmsCache, lmsCacheControl, lmsServerKeys, lmsServerTtl } from '@/lib/lmsCache';
import { isAdmin, requireAuth } from '@/lib/withAuth';
import { buildTrainerOverview } from '@/lib/trainerOverview';

export const dynamic = 'force-dynamic';

/**
 * GET /api/lms/admin/trainer-overview?year=&includeIgnored=
 *
 * Super Admin / SOP Admin only. Department trainers cannot call this — they
 * already have `/api/lms/trainer/monthly` for their own scope.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(['admin']);
  if (auth.error) return auth.error;
  if (!isAdmin(auth.session.user.role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const yearRaw = String(req.nextUrl.searchParams.get('year') || '').trim();
  const year = yearRaw.toLowerCase() === 'all' ? 0 : (Number(yearRaw) || undefined);
  const includeIgnored = req.nextUrl.searchParams.get('includeIgnored') === '1';
  const cacheYear: number | 'all' = year === 0 ? 'all' : (year || new Date().getFullYear());

  try {
    const payload = await getOrBuildLmsCache(
      lmsServerKeys.adminTrainerOverview(cacheYear, includeIgnored),
      lmsServerTtl.adminTrainerOverview,
      () => buildTrainerOverview({ year, includeIgnored }),
    );
    return NextResponse.json(payload, { headers: lmsCacheControl(30) });
  } catch (err) {
    console.error('[lms/admin/trainer-overview]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load trainer overview' },
      { status: 500 },
    );
  }
}
