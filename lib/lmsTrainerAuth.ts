import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { getDashboardDepartments } from '@/lib/dashboardDepartments';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import { resolveTrainerDepartments } from '@/lib/employeeTrainer';
import { deptMatchesTrainerScope } from '@/lib/lmsTrainerScope';
import { isAdmin } from '@/lib/roles';
import { parseAssignedDepartments } from '@/lib/access-control';
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
 * Require trainer access for LMS trainer APIs.
 *
 * Admitted:
 *  - an Employee marked `isTrainer`
 *  - Super Admin / SOP Admin (all departments)
 *  - a dashboard login with role `trainer` (scoped to employee + login departments)
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

  // Super Admin / SOP Admin keep all-department trainer scope whenever a
  // dashboard session is present — including when the LMS cookie is their own
  // employee identity. Without this they would be treated as a learner and
  // denied Trainer View unless Employee.isTrainer is set. A learner-only LMS
  // session (no dashboard login) still requires the trainer flag.
  const session = await getServerSession(authOptions);
  const isAppAdmin = Boolean(session?.user?.role && isAdmin(session.user.role));
  const isAppTrainer = session?.user?.role === 'trainer';

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
  if (!employee.isTrainer && !isAppAdmin && !isAppTrainer) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Trainer access required' }, { status: 403 }),
    };
  }

  const loginDepartments = parseAssignedDepartments(session?.user?.department);
  const trainerDepartments = isAppAdmin
    ? await getDashboardDepartments()
    : resolveTrainerDepartments({
        department: employee.department,
        trainerDepartments: [
          ...(employee.trainerDepartments || []),
          ...loginDepartments,
        ],
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

