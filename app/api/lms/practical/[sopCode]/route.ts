import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import PracticalAssessment from '@/models/lms/PracticalAssessment';
import LearningProgress from '@/models/lms/LearningProgress';
import Employee from '@/models/Employee';
import SOP from '@/models/SOP';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ sopCode: string }> };

// GET /api/lms/practical/[sopCode] — get practical status for current employee
export async function GET(_req: NextRequest, { params }: Params) {
  const payload = await resolveLmsIdentity();
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { sopCode } = await params;

  try {
    await connectDB();
    const practical = await PracticalAssessment.findOne(
      { employeeId: payload.sub, sopCode },
    ).sort({ requestedAt: -1 }).lean();

    return NextResponse.json({ practical: practical || null });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// POST /api/lms/practical/[sopCode] — request a practical assessment
export async function POST(_req: NextRequest, { params }: Params) {
  const payload = await resolveLmsIdentity();
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { sopCode } = await params;

  try {
    await connectDB();

    // Must have completed the content first
    const progress = await LearningProgress.findOne({ employeeId: payload.sub, sopCode }).lean();
    if (!progress || progress.overallPercentage < 100) {
      return NextResponse.json({ error: 'Complete all training content before requesting a practical assessment.' }, { status: 400 });
    }

    // Prevent duplicate pending requests
    const pending = await PracticalAssessment.findOne({
      employeeId: payload.sub,
      sopCode,
      status: 'pending',
    }).lean();
    if (pending) {
      return NextResponse.json({ practical: pending, message: 'Request already submitted' });
    }

    const employee = await Employee.findById(payload.sub)
      .select('name designation department')
      .lean<{ name: string; designation: string; department: string }>();
    if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

    const sop = await SOP.findOne({
      $or: [
        { identifier: sopCode },
        { sopBaseId: sopCode },
        { identifier: new RegExp(`^${sopCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') },
      ],
    }).select('name').lean<{ name: string }>();

    const practical = await PracticalAssessment.create({
      employeeId: payload.sub,
      employeeName: employee.name,
      designation: employee.designation,
      department: employee.department,
      sopCode,
      sopName: sop?.name || sopCode,
      status: 'pending',
      requestedAt: new Date(),
    });

    return NextResponse.json({ practical: practical.toObject() }, { status: 201 });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
