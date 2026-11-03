import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { getEmployeeAssignmentsMap, employeeAssignmentMapKey } from '@/lib/employeeAssignments';
import { lmsIdentityProblemMessage, resolveLmsIdentityDetailed } from '@/lib/lmsIdentity';
import {
  getOrBuildLmsCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import { filterIgnoredAssignments, listTrainingIgnores } from '@/lib/lmsTrainingIgnore';
import { applyReschedulesToList, listTrainingReschedules } from '@/lib/lmsTrainingReschedule';
import { formatCycleStart, getTrainingCycleStart } from '@/lib/lmsTrainingCycle';
import { toLmsClientEmployee } from '@/lib/employeeTrainer';
import { getInductionGate } from '@/lib/lmsInductionGate';
import { inductionAssignmentsOf, loadInductionSummaries } from '@/lib/lmsInduction';
import { stripVersion } from '@/lib/lmsExamScheduling';
import Employee from '@/models/Employee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/lms/auth/me — current learner + their assigned SOPs.
export async function GET() {
  const resolved = await resolveLmsIdentityDetailed();
  if (!resolved.ok) {
    // This is the one endpoint whose 401 a person reads, so say what is wrong:
    // a signed-in user with no linked employee record needs an admin, not a
    // second sign-in attempt.
    return NextResponse.json(
      { error: lmsIdentityProblemMessage(resolved.problem), problem: resolved.problem },
      { status: 401 },
    );
  }
  const payload = resolved.identity;

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.me(payload.sub),
      lmsServerTtl.userDashboard,
      async () => {
        await connectDB();
        const employee = await Employee.findById(payload.sub).lean<{
          _id: unknown;
          name: string;
          designation: string;
          department: string;
          isActive: boolean;
          isTrainer?: boolean;
          trainerDepartments?: string[];
          inductionTrainingRequired?: boolean;
        }>();
        if (!employee || !employee.isActive) {
          return null;
        }

        const assignmentsMap = await getEmployeeAssignmentsMap({
          // Learner list is this person's home department only. Including every
          // trainer department rebuilt the plant-wide assignment map on login.
          departments: [employee.department].filter(Boolean),
        });
        const raw =
          assignmentsMap.get(employeeAssignmentMapKey(employee.department, employee.name)) || [];
        const [ignoreRules, rescheduleRules] = await Promise.all([
          listTrainingIgnores(employee.department),
          listTrainingReschedules(employee.department),
        ]);
        const notExplicitlyIgnored = filterIgnoredAssignments(raw, ignoreRules, employee.department);
        const scheduled = applyReschedulesToList(notExplicitlyIgnored, rescheduleRules, {
          employeeId: String(employee._id),
          employeeDepartment: employee.department,
        });
        // Induction is its own track. While its exams are pending (and the gate
        // applies) regular training stays hidden; once induction is completed
        // it is no longer active training and only regular training is listed.
        const gate = await getInductionGate(employee, scheduled);
        const inductionList = inductionAssignmentsOf(scheduled);
        const inductionFamilies = new Set(inductionList.map((a) => stripVersion(a.sopCode)));
        const regular = scheduled.filter(
          (a) => a.trainingType !== 'induction' && !inductionFamilies.has(stripVersion(a.sopCode)),
        );
        const summary = (await loadInductionSummaries([{ id: String(employee._id), assignments: scheduled }]))
          .get(String(employee._id));
        const inductionStatus = employee.inductionTrainingRequired === true && summary
          ? summary.status
          : 'not_assigned';
        const regularLocked = gate.pending.length > 0;

        const cycle = getTrainingCycleStart();

        return {
          employee: toLmsClientEmployee(employee),
          assignments: regularLocked ? [] : regular,
          inductionAssignments: inductionStatus === 'in_progress' ? inductionList : [],
          induction: {
            status: inductionStatus,
            total: summary?.total ?? 0,
            completedCount: summary?.completedCount ?? 0,
            regularLocked,
          },
          trainingCycleStart: formatCycleStart(cycle),
        };
      },
    );

    if (!body) {
      return NextResponse.json({ error: 'Account not found or inactive' }, { status: 401 });
    }

    // Outside the cached body: which login this request used varies per request.
    return NextResponse.json(
      { ...body, authSource: payload.source },
      { headers: lmsCacheControl(60) },
    );
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
