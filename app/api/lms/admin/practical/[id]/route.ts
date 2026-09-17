import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsManager } from '@/lib/lmsTrainerAuth';
import PracticalAssessment from '@/models/lms/PracticalAssessment';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

// PATCH /api/lms/admin/practical/[id]
// Body: { action: 'approve' | 'reject', score?: number, remarks?: string }
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireLmsManager();
  if (!auth.ok) return auth.response;

  const { id } = await params;

  try {
    await connectDB();
    const body = await req.json() as { action: string; score?: number; remarks?: string };
    const { action, score, remarks } = body;

    if (action !== 'approve' && action !== 'reject') {
      return NextResponse.json({ error: 'action must be approve or reject' }, { status: 400 });
    }

    const assessment = await PracticalAssessment.findById(id);
    if (!assessment) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (assessment.status !== 'pending') {
      return NextResponse.json({ error: 'Assessment already reviewed' }, { status: 409 });
    }

    assessment.status     = action === 'approve' ? 'approved' : 'rejected';
    assessment.reviewedBy = auth.actorName || auth.session?.user?.email || 'Admin';
    assessment.reviewedAt = new Date();
    if (typeof score === 'number') assessment.score = score;
    if (remarks) assessment.remarks = remarks;
    await assessment.save();

    return NextResponse.json({ assessment: assessment.toObject() });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
