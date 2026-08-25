import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import { resolveTrainerDepartments } from '@/lib/employeeTrainer';
import { deptMatchesTrainerScope } from '@/lib/lmsTrainerScope';
import Employee from '@/models/Employee';

export { deptMatchesTrainerScope } from '@/lib/lmsTrainerScope';

export type LmsTrainerContext = {
  employeeId: string;
  name: string;
  department: string;
  isTrainer: true;
  trainerDepartments: string[];
};

/**
 * Require an LMS session — the employee login or the main application login —
 * for an active Employee.isTrainer.
 * Returns either the trainer context or a NextResponse error.
 */
export async function requireLmsTrainer(): Promise<
  { ok: true; trainer: LmsTrainerContext } | { ok: false; response: NextResponse }
> {
  const payload = await resolveLmsIdentity();
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

