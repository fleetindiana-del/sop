import { canonTrainingMatrixDepartment } from '@/lib/trainingMatrixDepartments';

/**
 * True when `department` falls within the trainer's eligible departments.
 * Uses training-matrix canonical names so "Prod" matches "Production", etc.
 */
export function deptMatchesTrainerScope(
  department: string,
  trainerDepartments: string[],
): boolean {
  const d = canonTrainingMatrixDepartment(department);
  if (!d) return false;
  const dl = d.toLowerCase();
  return trainerDepartments.some((td) => {
    const canon = canonTrainingMatrixDepartment(td);
    return canon && canon.toLowerCase() === dl;
  });
}

/** Resolve the active department filter for trainer UI ("All" → all trainer depts). */
export function resolveTrainerDeptFilter(
  trainerDepartments: string[],
  deptParam: string,
): string[] {
  const all = trainerDepartments.map((d) => String(d || '').trim()).filter(Boolean);
  const picked = String(deptParam || '').trim();
  if (!picked || picked.toLowerCase() === 'all') return all;
  return all.filter((d) => d.toLowerCase() === picked.toLowerCase());
}
