import { escapeRegex } from '@/lib/lms-credentials';
import { invalidateEmployeeDerivedCaches } from '@/lib/employeeCacheInvalidation';
import Employee from '@/models/Employee';

/**
 * The Trainer checkbox on Login & Password Admin lives on the User record, but
 * LMS trainer access reads `Employee.isTrainer`. This mirrors the flag onto the
 * employee the login maps to, using the same match order as the LMS login
 * bridge in `lib/lmsIdentity.ts`: LMS handle first, then name.
 */
export async function syncEmployeeTrainerFlag(
  user: { username: string; name: string },
  isTrainer: boolean,
): Promise<{ matched: boolean; employeeName?: string }> {
  const ci = (value: string) => new RegExp(`^${escapeRegex(value)}$`, 'i');
  const username = String(user.username || '').trim();
  const name = String(user.name || '').trim();

  const employee =
    (username
      ? await Employee.findOne({ lmsUsername: ci(username), isActive: true })
      : null)
    || (name ? await Employee.findOne({ name: ci(name), isActive: true }) : null);

  if (!employee) return { matched: false };
  if (employee.isTrainer === isTrainer) {
    return { matched: true, employeeName: employee.name };
  }

  employee.isTrainer = isTrainer;
  // Clearing the flag also clears the scope, so a re-tick does not silently
  // restore departments an admin removed the trainer from.
  if (!isTrainer) employee.trainerDepartments = [];
  await employee.save();
  invalidateEmployeeDerivedCaches();

  return { matched: true, employeeName: employee.name };
}
