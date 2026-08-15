/**
 * The one place trainer-facing features resolve "which employees can I manage".
 *
 * Rules enforced here so every trainer endpoint agrees:
 * 1. Department scope — only employees whose home department is one of the
 *    trainer's `trainerDepartments`.
 * 2. Same roster as the Employees page — the matrix→Employee sync runs first
 *    (throttled), so the trainer never sees a staler list than the admin does.
 * 3. LMS access — an employee can only be scheduled for an exam when they can
 *    actually sign in: active, with an `lmsUsername` and a password hash.
 * 4. No duplicates — the Employee collection has no unique (name, department)
 *    index, so same-person rows are collapsed, preferring the one that can log in.
 */

import Employee from '@/models/Employee';
import { connectDB } from '@/lib/mongodb';
import { syncEmployeesFromMatrixThrottled } from '@/lib/syncEmployeesFromMatrix';

export interface TrainerScopedEmployee {
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  employeeCode?: string;
  isTrainer: boolean;
  /** Can sign in to the LMS: active + username + password set. */
  hasLmsAccess: boolean;
  /** Why access is missing, for an actionable message in the UI. */
  lmsAccessIssue?: 'no-username' | 'no-password';
}

type EmployeeLean = {
  _id: unknown;
  name: string;
  designation?: string;
  department: string;
  employeeId?: string;
  isActive: boolean;
  isTrainer?: boolean;
  lmsUsername?: string;
  lmsPasswordHash?: string;
};

export function escapeRegex(s: string): string {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function departmentRegexes(departments: string[]): RegExp[] {
  return departments
    .map((d) => String(d || '').trim())
    .filter(Boolean)
    .map((d) => new RegExp(`^${escapeRegex(d)}$`, 'i'));
}

/** Same identity key the assignment map uses: `department||name`, lowercased. */
export function employeeAssignmentKey(department: string, name: string): string {
  return `${department}||${name}`.trim().toLowerCase();
}

function toScoped(emp: EmployeeLean): TrainerScopedEmployee {
  const hasUsername = Boolean(String(emp.lmsUsername || '').trim());
  const hasPassword = Boolean(String(emp.lmsPasswordHash || '').trim());
  return {
    employeeId: String(emp._id),
    name: String(emp.name || '').trim(),
    designation: String(emp.designation || '').trim(),
    department: String(emp.department || '').trim(),
    employeeCode: emp.employeeId ? String(emp.employeeId).trim() : undefined,
    isTrainer: Boolean(emp.isTrainer),
    hasLmsAccess: hasUsername && hasPassword,
    lmsAccessIssue: !hasUsername ? 'no-username' : !hasPassword ? 'no-password' : undefined,
  };
}

/**
 * Active employees in the trainer's departments, deduplicated, sorted by name.
 *
 * @param opts.skipSync  skip the matrix→Employee mirror (for hot paths that
 *                       already ran it in the same request cycle)
 */
export async function listTrainerScopedEmployees(
  trainerDepartments: string[],
  opts?: { skipSync?: boolean },
): Promise<TrainerScopedEmployee[]> {
  const departments = trainerDepartments.map((d) => String(d || '').trim()).filter(Boolean);
  if (departments.length === 0) return [];

  if (!opts?.skipSync) {
    // Mirrors what GET /api/employees does, so both pages list the same people.
    await syncEmployeesFromMatrixThrottled();
  }

  await connectDB();
  const rows = await Employee.find({
    isActive: true,
    department: { $in: departmentRegexes(departments) },
  })
    // lmsPasswordHash is select:false — needed to tell real LMS access apart
    // from an employee who merely has a username.
    .select('_id name designation department employeeId isActive isTrainer lmsUsername +lmsPasswordHash')
    .sort({ name: 1 })
    .lean<EmployeeLean[]>();

  // Collapse duplicate person rows (same department + name). Keep the record
  // that can actually sign in, so scheduling never targets a dead duplicate.
  const byIdentity = new Map<string, TrainerScopedEmployee>();
  for (const row of rows) {
    const scoped = toScoped(row);
    if (!scoped.name || !scoped.department) continue;
    const key = employeeAssignmentKey(scoped.department, scoped.name);
    const existing = byIdentity.get(key);
    if (!existing || (!existing.hasLmsAccess && scoped.hasLmsAccess)) {
      byIdentity.set(key, scoped);
    }
  }

  return [...byIdentity.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Employees who can be scheduled for an exam: in scope, with LMS access. */
export function filterSchedulable(
  employees: TrainerScopedEmployee[],
): TrainerScopedEmployee[] {
  return employees.filter((e) => e.hasLmsAccess);
}

export type ScopeCheck =
  | { ok: true; employees: TrainerScopedEmployee[] }
  | { ok: false; error: string; status: 400 | 403 | 404 };

/**
 * Validate a caller-supplied list of employee ids against the trainer's scope
 * and LMS access, returning a precise error rather than silently dropping rows.
 */
export function checkEmployeeSelection(
  employeeIds: string[],
  scoped: TrainerScopedEmployee[],
  opts?: { requireLmsAccess?: boolean },
): ScopeCheck {
  const byId = new Map(scoped.map((e) => [e.employeeId, e]));
  const unique = [...new Set(employeeIds.map((id) => String(id || '').trim()).filter(Boolean))];
  if (unique.length === 0) {
    return { ok: false, error: 'Select at least one employee', status: 400 };
  }

  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `${missing.length} selected employee(s) are not active in your departments`,
      status: 403,
    };
  }

  const employees = unique.map((id) => byId.get(id)!);

  if (opts?.requireLmsAccess) {
    const noAccess = employees.filter((e) => !e.hasLmsAccess);
    if (noAccess.length > 0) {
      return {
        ok: false,
        error:
          `No LMS login for: ${noAccess.map((e) => e.name).join(', ')}. ` +
          'Generate learning-module credentials on the Employees page first.',
        status: 400,
      };
    }
  }

  return { ok: true, employees };
}
