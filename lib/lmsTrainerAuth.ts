import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { getDashboardDepartments } from '@/lib/dashboardDepartments';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import { resolveTrainerDepartments } from '@/lib/employeeTrainer';
import { deptMatchesTrainerScope } from '@/lib/lmsTrainerScope';
import { isAdmin } from '@/lib/roles';
import Employee from '@/models/Employee';

export { deptMatchesTrainerScope } from '@/lib/lmsTrainerScope';

export type LmsTrainerContext = {
  employeeId: string;
  name: string;
  department: string;
  isTrainer: true;
  trainerDepartments: string[];
  /**
   * True when the scope came from the Super Admin / SOP Admin role rather than
   * from `Employee.trainerDepartments` — i.e. every department, not an
   * assignment. UI uses it to label the view.
   */
  allDepartments?: boolean;
};

/**
 * Require an LMS session — the employee login or the main application login —
 * for an active Employee.isTrainer.
 *
 * Super Admin and SOP Admin are admitted whether or not their employee record
 * carries the trainer flag, and are scoped to every department rather than to
 * an assignment: an administrator is not a department trainer, so restricting
 * them to their own employee record's department would hide most of the estate
 * from the only roles meant to see all of it.
 *
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

  // Only the application login carries the admin role. A learner-cookie session
  // is deliberately acting as one specific employee — even in an admin's own
  // browser — so it keeps that employee's department scope.
  const session = payload.source === 'app' ? await getServerSession(authOptions) : null;
  const isAppAdmin = Boolean(session?.user?.role && isAdmin(session.user.role));

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
  if (!employee.isTrainer && !isAppAdmin) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Trainer access required' }, { status: 403 }),
    };
  }

  const trainerDepartments = isAppAdmin
    ? await getDashboardDepartments()
    : resolveTrainerDepartments({
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
      allDepartments: isAppAdmin || undefined,
    },
  };
}

