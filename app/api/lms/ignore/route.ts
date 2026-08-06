import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { connectDB } from '@/lib/mongodb';
import { verifyLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import {
  invalidateLmsAdminCaches,
  invalidateLmsServerPrefix,
} from '@/lib/lmsCache';
import { listTrainingIgnores } from '@/lib/lmsTrainingIgnore';
import Employee from '@/models/Employee';
import LmsTrainingIgnore from '@/models/lms/LmsTrainingIgnore';

export const dynamic = 'force-dynamic';

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

function bustIgnoreCaches() {
  // Department-wide ignores affect every learner in that dept.
  invalidateLmsServerPrefix('lms:me:');
  invalidateLmsServerPrefix('lms:assets:');
  invalidateLmsServerPrefix('lms:dashboard:');
  invalidateLmsAdminCaches();
}

async function requireEmployee() {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) return null;
  await connectDB();
  const employee = await Employee.findById(payload.sub).lean<{
    _id: unknown;
    name: string;
    department: string;
    isActive: boolean;
  }>();
  if (!employee || !employee.isActive) return null;
  return { payload, employee };
}

// GET /api/lms/ignore — list ignore rules for the learner's department
export async function GET() {
  const ctx = await requireEmployee();
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const ignores = await listTrainingIgnores(ctx.employee.department);
  return NextResponse.json({ ignores, department: ctx.employee.department });
}

// POST /api/lms/ignore — ignore one SOP or an entire month for the department
// Body: { month, year, sopCode?: string, scope?: 'sop' | 'month' }
export async function POST(req: NextRequest) {
  const ctx = await requireEmployee();
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const month = Number(body.month);
  const year = Number(body.year);
  const scope = body.scope === 'month' ? 'month' : 'sop';
  const sopCode = scope === 'month' ? null : stripVersion(String(body.sopCode || ''));

  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000) {
    return NextResponse.json({ error: 'Invalid month/year' }, { status: 400 });
  }
  if (scope === 'sop' && !sopCode) {
    return NextResponse.json({ error: 'sopCode is required' }, { status: 400 });
  }

  const department = ctx.employee.department;
  await connectDB();
  await LmsTrainingIgnore.findOneAndUpdate(
    { department, year, month, sopCode: sopCode || null },
    {
      $set: {
        department,
        year,
        month,
        sopCode: sopCode || null,
        ignoredByEmployeeId: ctx.payload.sub,
        ignoredByName: ctx.employee.name,
      },
    },
    { upsert: true, new: true },
  );

  bustIgnoreCaches();
  return NextResponse.json({ ok: true, department, year, month, sopCode, scope });
}

// DELETE /api/lms/ignore — restore a previously ignored SOP or month
export async function DELETE(req: NextRequest) {
  const ctx = await requireEmployee();
  if (!ctx) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const month = Number(body.month);
  const year = Number(body.year);
  const scope = body.scope === 'month' ? 'month' : 'sop';
  const sopCode = scope === 'month' ? null : stripVersion(String(body.sopCode || ''));

  await connectDB();
  await LmsTrainingIgnore.deleteOne({
    department: new RegExp(`^${ctx.employee.department.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    year,
    month,
    sopCode: sopCode || null,
  });

  bustIgnoreCaches();
  return NextResponse.json({ ok: true });
}
