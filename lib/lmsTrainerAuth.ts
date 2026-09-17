import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import type { Session } from 'next-auth';
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

/**
 * Require Trainer / SOP Admin / Super Admin for LMS management endpoints
 * (exam settings, credentials, practical assessments, employee-training
 * views, …) that must stay reachable even for a Super Admin whose dashboard
 * login has no linked Employee record — `requireLmsTrainer` alone rejects
 * that case since it always requires an LMS employee identity.
 *
 * Admitted: a dashboard session with role admin / sop_admin / trainer, OR
 * anyone `requireLmsTrainer` already admits (trainer-flagged employee, or an
 * admin whose LMS identity IS linked to an employee).
 */
export async function requireLmsManager(): Promise<
  | { ok: true; session: Session | null; actorName: string | null }
  | { ok: false; response: NextResponse }
> {
  const session = await getServerSession(authOptions);
  if (session?.user?.role && (isAdmin(session.user.role) || session.user.role === 'trainer')) {
    return { ok: true, session, actorName: session.user.name ?? null };
  }

  const trainer = await requireLmsTrainer();
  if (trainer.ok) return { ok: true, session, actorName: trainer.trainer.name };

  return {
    ok: false,
    response: session
      ? NextResponse.json({ error: 'Trainer access required' }, { status: 403 })
      : NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
  };
}

