import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import Employee from '@/models/Employee';
import {
  resolveExamSettingsForSop,
  toLearnerQuizSettings,
} from '@/lib/lms-exam-settings';

export const dynamic = 'force-dynamic';

// GET /api/lms/quiz/settings?sopCode=PEGE11 — resolved settings for the learner
export async function GET(req: NextRequest) {
  const payload = await resolveLmsIdentity();
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    await connectDB();
    const sopCode = req.nextUrl.searchParams.get('sopCode') || '';
    const employee = await Employee.findById(payload.sub)
      .select('department designation isTrainer')
      .lean();

    const resolved = await resolveExamSettingsForSop(sopCode, {
      id: payload.sub,
      department: employee?.department ?? '',
      designation: employee?.designation ?? '',
      isTrainer: employee?.isTrainer === true,
    });

    return NextResponse.json({ settings: toLearnerQuizSettings(resolved) });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
