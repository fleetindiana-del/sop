import { parseAssignedDepartments, departmentsMatch } from '@/lib/access-control';
import { escapeRegex } from '@/lib/lms-credentials';
import { invalidateEmployeeDerivedCaches } from '@/lib/employeeCacheInvalidation';
import Employee from '@/models/Employee';

/**
 * The Trainer checkbox on Login & Password Admin lives on the User record, but
 * LMS trainer access reads `Employee.isTrainer`. This mirrors the flag onto the
 * employee the login maps to, using the same match order as the LMS login
 * bridge in `lib/lmsIdentity.ts`.
 */

function ci(value: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}$`, 'i');
}

function usernameAsName(username: string): string {
  return username.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export type TrainerEmployeeMatch = {
  _id: unknown;
  name: string;
  department?: string;
  trainerDepartments?: string[];
  isTrainer?: boolean;
};

type TrainerUserRef = {
  username?: string;
  name?: string;
  department?: string;
  lmsEmployeeId?: unknown;
};

const EMP_FIELDS = '_id name department trainerDepartments isTrainer';

function pickUnique(
  rows: TrainerEmployeeMatch[],
  department?: string,
): TrainerEmployeeMatch | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0] ?? null;
  const assigned = parseAssignedDepartments(department);
  if (!assigned.length) return null;
  const scoped = rows.filter((row) =>
    assigned.some((d) => departmentsMatch(d, row.department || '')),
  );
  return scoped.length === 1 ? scoped[0] ?? null : null;
}

/**
 * Resolve the Employee a login *is*, so Trainer View and the LMS trainer flag
 * agree with Login & Passwords. "Jignesh" must still find "Jignesh Trivedi"
 * when that is the only active match.
 */
export async function findEmployeeForTrainerUser(
  user: TrainerUserRef,
): Promise<TrainerEmployeeMatch | null> {
  if (user.lmsEmployeeId) {
    const linked = await Employee.findOne({ _id: user.lmsEmployeeId, isActive: true })
      .select(EMP_FIELDS)
      .lean<TrainerEmployeeMatch | null>();
    if (linked) return linked;
  }

  const username = String(user.username || '').trim();
  const name = String(user.name || '').trim();

  if (username) {
    const byHandle = await Employee.findOne({ lmsUsername: ci(username), isActive: true })
      .select(EMP_FIELDS)
      .lean<TrainerEmployeeMatch | null>();
    if (byHandle) return byHandle;

    const byCode = await Employee.findOne({ employeeId: ci(username), isActive: true })
      .select(EMP_FIELDS)
      .lean<TrainerEmployeeMatch | null>();
    if (byCode) return byCode;
  }

  const nameCandidates = [...new Set(
    [name, username ? usernameAsName(username) : ''].map((s) => s.trim()).filter(Boolean),
  )];

  for (const candidate of nameCandidates) {
    const rows = await Employee.find({ name: ci(candidate), isActive: true })
      .select(EMP_FIELDS)
      .lean<TrainerEmployeeMatch[]>();
    const picked = pickUnique(rows, user.department);
    if (picked) return picked;
  }

  // Display name on the login is often the first name only ("Jignesh") while
  // Employee Master stores the full name ("Jignesh Trivedi").
  for (const candidate of nameCandidates) {
    if (candidate.length < 2) continue;
    const rows = await Employee.find({
      isActive: true,
      name: new RegExp(`^${escapeRegex(candidate)}(\\s|$)`, 'i'),
    })
      .select(EMP_FIELDS)
      .lean<TrainerEmployeeMatch[]>();
    const picked = pickUnique(rows, user.department);
    if (picked) return picked;
  }

  return null;
}

export async function syncEmployeeTrainerFlag(
  user: TrainerUserRef,
  isTrainer: boolean,
): Promise<{ matched: boolean; employeeName?: string }> {
  const employee = await findEmployeeForTrainerUser(user);
  if (!employee) return { matched: false };

  const doc = await Employee.findById(employee._id);
  if (!doc) return { matched: false };
  if (doc.isTrainer === isTrainer) {
    return { matched: true, employeeName: doc.name };
  }

  doc.isTrainer = isTrainer;
  // Clearing the flag also clears the scope, so a re-tick does not silently
  // restore departments an admin removed the trainer from.
  if (!isTrainer) doc.trainerDepartments = [];
  await doc.save();
  invalidateEmployeeDerivedCaches();

  return { matched: true, employeeName: doc.name };
}
