import bcrypt from 'bcryptjs';
import { escapeRegex, generateUniqueLmsUsername } from '@/lib/lms-credentials';
import { invalidateEmployeeDerivedCaches } from '@/lib/employeeCacheInvalidation';
import Employee from '@/models/Employee';
import type { IUser } from '@/models/User';

/**
 * "Same password for Dashboard and LMS" on Login & Password Admin.
 *
 * The dashboard password lives on `User.passwordHash`, the learning-module one
 * on `Employee.lmsPasswordHash` — two separate records. Sharing them therefore
 * means writing the same password to both whenever it is set or reset here.
 *
 * The dashboard→LMS bridge itself (no second sign-in) is handled by
 * `lib/lmsIdentity.ts`, which reads the same `sharedLmsLogin` flag.
 */

/** Undefined means "created before the flag existed" — those logins are shared. */
export function isSharedLmsLogin(user: { sharedLmsLogin?: boolean }): boolean {
  return user.sharedLmsLogin !== false;
}

export interface LmsPasswordSync {
  matched: boolean;
  employeeName?: string;
  /** The handle the person signs into the LMS with. */
  lmsUsername?: string;
}

function ci(value: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}$`, 'i');
}

/**
 * The employee this login *is*, using the same order as `lib/lmsIdentity.ts`:
 * the administrator-set link first, then the LMS handle, then the display name.
 */
async function employeeForUser(user: Pick<IUser, 'username' | 'name' | 'lmsEmployeeId'>) {
  if (user.lmsEmployeeId) {
    const linked = await Employee.findOne({ _id: user.lmsEmployeeId, isActive: true });
    if (linked) return linked;
  }

  const username = String(user.username || '').trim();
  const name = String(user.name || '').trim();

  return (
    (username ? await Employee.findOne({ lmsUsername: ci(username), isActive: true }) : null)
    || (name ? await Employee.findOne({ name: ci(name), isActive: true }) : null)
  );
}

/**
 * Mirror a newly set dashboard password onto the linked employee's LMS login.
 *
 * Only call this with a plain password the administrator just typed — the
 * dashboard hash cannot be reused, the two records hash separately. When no
 * employee matches, report it so the screen can say the LMS half did not
 * happen rather than implying both passwords changed.
 */
export async function syncLmsPasswordFromUser(
  user: Pick<IUser, 'username' | 'name' | 'lmsEmployeeId'>,
  plainPassword: string,
): Promise<LmsPasswordSync> {
  if (!plainPassword) return { matched: false };

  const employee = await employeeForUser(user);
  if (!employee) return { matched: false };

  // A learner with no handle can never sign in, so mint one now rather than
  // leaving a password nobody can use.
  if (!String(employee.lmsUsername || '').trim()) {
    employee.lmsUsername = await generateUniqueLmsUsername(
      employee.name,
      employee._id.toString(),
    );
  }
  employee.lmsPasswordHash = await bcrypt.hash(plainPassword, 12);
  await employee.save();
  invalidateEmployeeDerivedCaches();

  return {
    matched: true,
    employeeName: employee.name,
    lmsUsername: employee.lmsUsername,
  };
}
