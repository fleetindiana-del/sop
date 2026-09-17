import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsManager } from '@/lib/lmsTrainerAuth';
import PracticalAssessment from '@/models/lms/PracticalAssessment';

export const dynamic = 'force-dynamic';

// GET /api/lms/admin/practical?status=pending&department=QA
export async function GET(req: NextRequest) {
  const auth = await requireLmsManager();
  if (!auth.ok) return auth.response;

  const { searchParams } = new URL(req.url);
  const status     = searchParams.get('status') || 'pending';
  const department = searchParams.get('department') || '';

  try {
    await connectDB();

    const filter: Record<string, unknown> = { status };
    if (department) filter.department = department;

    const assessments = await PracticalAssessment.find(filter)
      .sort({ requestedAt: -1 })
      .lean();

    return NextResponse.json({ assessments });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
