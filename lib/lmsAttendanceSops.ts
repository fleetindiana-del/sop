/**
 * The SOP universe for trainer attendance, resolved in one place so the picker,
 * the employee list and the save endpoint can never disagree about which SOPs a
 * trainer may record a session for.
 */

import { connectDB } from '@/lib/mongodb';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { getOrBuildLmsCache, lmsServerKeys, lmsServerTtl } from '@/lib/lmsCache';
import { deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import {
  employeeAssignmentKey,
  listTrainerScopedEmployees,
  type TrainerScopedEmployee,
} from '@/lib/lmsTrainerEmployees';
import { buildTrainableSopList, type TrainableSop } from '@/lib/lmsAttendance';
import { stripVersion } from '@/lib/trainingExamSchedule';

export async function listTrainableSops(
  departments: string[],
  opts?: { employees?: TrainerScopedEmployee[] },
): Promise<{ sops: TrainableSop[]; employees: TrainerScopedEmployee[] }> {
  await connectDB();

  // The exam catalogue lives behind the admin settings route; importing it here
  // rather than at module scope keeps this lib usable from any caller.
  const { buildSopList } = await import('@/app/api/lms/admin/sop-exam-settings/route');

  const [employees, assignmentsMap, catalog] = await Promise.all([
    opts?.employees ? Promise.resolve(opts.employees) : listTrainerScopedEmployees(departments),
    getEmployeeAssignmentsMap(),
    getOrBuildLmsCache(
      lmsServerKeys.adminSopExamSettings(),
      lmsServerTtl.adminSopExamSettings,
      buildSopList,
    ),
  ]);

  const assignmentsByEmployee = employees.map((emp) => ({
    department: emp.department,
    assignments: assignmentsMap.get(employeeAssignmentKey(emp.department, emp.name)) || [],
  }));

  const examCatalog = catalog.sops
    .filter((s) => deptMatchesTrainerScope(s.department, departments))
    .map((s) => ({ sopCode: s.sopCode, sopName: s.sopName, department: s.department }));

  return {
    sops: buildTrainableSopList(assignmentsByEmployee, examCatalog, stripVersion),
    employees,
  };
}

/**
 * Resolve one SOP within the trainer's scope. Returns a precise error rather than
 * a bare null so endpoints can report *why* a SOP was rejected.
 */
export async function resolveTrainingSop(
  sopCode: string,
  departments: string[],
  opts?: { employees?: TrainerScopedEmployee[] },
): Promise<
  | { ok: true; sop: TrainableSop; employees: TrainerScopedEmployee[] }
  | { ok: false; error: string; status: 403 | 404 }
> {
  const code = stripVersion(sopCode);
  const { sops, employees } = await listTrainableSops(departments, opts);
  const sop = sops.find((s) => s.sopCode === code);

  if (!sop) {
    return {
      ok: false,
      error: 'SOP is not trained in your departments',
      status: 404,
    };
  }
  return { ok: true, sop, employees };
}
