import Employee from '@/models/Employee';
import { canonTrainingMatrixDepartment } from '@/lib/trainingMatrixDepartments';

/**
 * Identity used to hide people marked Left (`Employee.isActive = false`) from
 * training-matrix / Manage SOP / LMS views that are still keyed by Excel
 * `department + name` rather than Employee._id.
 */
export function employeeIdentityKey(department: string, name: string): string {
  const dept = canonTrainingMatrixDepartment(department) || String(department || '').trim();
  return `${dept}||${name}`.trim().toLowerCase();
}

export function leftEmployeeKeysFrom(
  employees: Array<{ department?: string; name?: string }>,
): Set<string> {
  const keys = new Set<string>();
  for (const e of employees) {
    const name = String(e.name || '').trim();
    const department = String(e.department || '').trim();
    if (!name || !department) continue;
    keys.add(employeeIdentityKey(department, name));
    keys.add(`${department}||${name}`.trim().toLowerCase());
  }
  return keys;
}

export async function getLeftEmployeeKeys(): Promise<Set<string>> {
  const rows = await Employee.find({ isActive: false })
    .select('name department')
    .lean<Array<{ name?: string; department?: string }>>();
  return leftEmployeeKeysFrom(rows);
}

export function isLeftEmployee(
  keys: Set<string>,
  department: string | undefined | null,
  name: string | undefined | null,
): boolean {
  if (!keys.size) return false;
  const n = String(name || '').trim();
  const d = String(department || '').trim();
  if (!n || !d) return false;
  return keys.has(employeeIdentityKey(d, n)) || keys.has(`${d}||${n}`.trim().toLowerCase());
}

/** True when this name is marked Left in any department (dropdowns / name-only lists). */
export function isLeftEmployeeName(keys: Set<string>, name: string | undefined | null): boolean {
  if (!keys.size) return false;
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  const suffix = `||${n}`;
  for (const key of keys) {
    if (key.endsWith(suffix)) return true;
  }
  return false;
}
