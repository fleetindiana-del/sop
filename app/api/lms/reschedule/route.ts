import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import {
  invalidateLmsAdminCaches,
  invalidateLmsServerPrefix,
} from '@/lib/lmsCache';
import {
  createTrainingReschedule,
  listTrainingReschedules,
} from '@/lib/lmsTrainingReschedule';
import Employee from '@/models/Employee';

export const dynamic = 'force-dynamic';

function bustCaches() {
  invalidateLmsServerPrefix('lms:me:');
  invalidateLmsServerPrefix('lms:assets:');
  invalidateLmsServerPrefix('lms:dashboard:');
  invalidateLmsAdminCaches();
}

async function requireActor() {
  // Prefer LMS learner session; fall back to NextAuth admin/trainer.
  const payload = await resolveLmsIdentity();
  if (payload) {
    await connectDB();
    const employee = await Employee.findById(payload.sub).lean<{
      _id: unknown;
      name: string;
      department: string;
      isActive: boolean;
      isTrainer?: boolean;
    }>();
    if (employee?.isActive) {
      return {
        kind: 'lms' as const,
        employeeId: String(employee._id),
        name: employee.name,
        department: employee.department,
        isTrainer: Boolean(employee.isTrainer),
      };
    }
  }

  const session = await getServerSession(authOptions);
  if (session?.user) {
    return {
      kind: 'app' as const,
      employeeId: undefined as string | undefined,
      name: session.user.name || session.user.email || 'Admin',
      department: undefined as string | undefined,
      isTrainer: true,
    };
  }
  return null;
}

// GET /api/lms/reschedule?department=QA
export async function GET(req: NextRequest) {
  const actor = await requireActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const department =
    req.nextUrl.searchParams.get('department')?.trim() ||
    actor.department ||
    undefined;
  const rules = await listTrainingReschedules(department);
  return NextResponse.json({ reschedules: rules, department: department || null });
}

// POST /api/lms/reschedule
// Body: { department, sopCode, fromMonth, fromYear, toMonth, toYear, employeeId?, employeeName?, note? }
export async function POST(req: NextRequest) {
  const actor = await requireActor();
  if (!actor) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const department = String(body.department || actor.department || '').trim();
  const sopCode = String(body.sopCode || '').trim();
  const fromMonth = Number(body.fromMonth);
  const fromYear = Number(body.fromYear);
  const toMonth = Number(body.toMonth);
  const toYear = Number(body.toYear);
  const employeeId = body.employeeId ? String(body.employeeId) : null;
  const employeeName = body.employeeName ? String(body.employeeName) : null;
  const note = body.note ? String(body.note) : '';

  if (!department || !sopCode) {
    return NextResponse.json({ error: 'department and sopCode are required' }, { status: 400 });
  }
  for (const [label, n] of [
    ['fromMonth', fromMonth],
    ['toMonth', toMonth],
  ] as const) {
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      return NextResponse.json({ error: `Invalid ${label}` }, { status: 400 });
    }
  }
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear < 2000 || toYear < 2000) {
    return NextResponse.json({ error: 'Invalid year' }, { status: 400 });
  }
  if (fromYear === toYear && fromMonth === toMonth) {
    return NextResponse.json({ error: 'Destination month must differ from the original month' }, { status: 400 });
  }

  await createTrainingReschedule({
    department,
    sopCode,
    employeeId,
    employeeName,
    fromYear,
    fromMonth,
    toYear,
    toMonth,
    note,
    createdByEmployeeId: actor.employeeId,
    createdByName: actor.name,
  });
  bustCaches();

  return NextResponse.json({
    ok: true,
    department,
    sopCode,
    fromYear,
    fromMonth,
    toYear,
    toMonth,
    employeeId,
  });
}
