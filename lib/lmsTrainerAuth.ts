import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { verifyLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import { resolveTrainerDepartments } from '@/lib/employeeTrainer';
import Employee from '@/models/Employee';

export type LmsTrainerContext = {
  employeeId: string;
  name: string;
  department: string;
  isTrainer: true;
  trainerDepartments: string[];
};

/**
 * Require an LMS cookie session for an active Employee.isTrainer.
 * Returns either the trainer context or a NextResponse error.
 */
export async function requireLmsTrainer(): Promise<
  { ok: true; trainer: LmsTrainerContext } | { ok: false; response: NextResponse }
> {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    };
  }

  await connectDB();
  const employee = await Employee.findById(payload.sub).lean<{
    _id: unknown;
    name: string;
    department: string;
    isActive: boolean;
    isTrainer?: boolean;
    trainerDepartments?: string[];
  }>();

  if (!employee?.isActive) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Account not found or inactive' }, { status: 401 }),
    };
  }
  if (!employee.isTrainer) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Trainer access required' }, { status: 403 }),
    };
  }

  const trainerDepartments = resolveTrainerDepartments({
    department: employee.department,
    trainerDepartments: employee.trainerDepartments,
    isTrainer: true,
  });

  return {
    ok: true,
    trainer: {
      employeeId: String(employee._id),
      name: employee.name,
      department: employee.department,
      isTrainer: true,
      trainerDepartments,
    },
  };
}

export function deptMatchesTrainerScope(department: string, trainerDepartments: string[]): boolean {
  const d = String(department || '').trim().toLowerCase();
  if (!d) return false;
  return trainerDepartments.some((td) => td.trim().toLowerCase() === d);
}
