/**
 * The active department-trainer directory.
 *
 * A trainer can exist as an `Employee.isTrainer` record, as a `User` with the
 * trainer role/flag, or both — the two are linked by `userTrainerSync`. Every
 * admin-facing view that lists trainers must agree on that resolution, so it
 * lives here rather than in one route.
 */

import Employee from '@/models/Employee';
import User from '@/models/User';
import { resolveTrainerDepartments } from '@/lib/employeeTrainer';
import { findEmployeeForTrainerUser } from '@/lib/userTrainerSync';

export interface TrainerDirectoryEntry {
  id: string;
  name: string;
  /** Home department of the trainer's own employee record. */
  department: string;
  /** Departments the trainer is responsible for (falls back to `department`). */
  trainerDepartments: string[];
}

/** Active department trainers, sorted by name. */
export async function listActiveTrainers(): Promise<TrainerDirectoryEntry[]> {
  const [empDocs, trainerUsers] = await Promise.all([
    Employee.find({ isActive: true, isTrainer: true })
      .select('_id name department trainerDepartments isTrainer')
      .sort({ name: 1 })
      .lean<Array<{
        _id: unknown;
        name?: string;
        department?: string;
        trainerDepartments?: string[];
        isTrainer?: boolean;
      }>>(),
    User.find({ $or: [{ isTrainer: true }, { role: 'trainer' }] })
      .select('username name department lmsEmployeeId')
      .lean<Array<{
        username?: string;
        name?: string;
        department?: string;
        lmsEmployeeId?: unknown;
      }>>(),
  ]);

  const byId = new Map<string, TrainerDirectoryEntry>();
  const add = (emp: {
    _id: unknown;
    name?: string;
    department?: string;
    trainerDepartments?: string[];
  }) => {
    const id = String(emp._id || '');
    const name = String(emp.name || '').trim();
    if (!id || !name || byId.has(id)) return;
    byId.set(id, {
      id,
      name,
      department: String(emp.department || '').trim(),
      trainerDepartments: resolveTrainerDepartments({
        department: emp.department,
        trainerDepartments: emp.trainerDepartments,
        isTrainer: true,
      }),
    });
  };

  for (const t of empDocs) add(t);

  const linked = await Promise.all(trainerUsers.map((u) => findEmployeeForTrainerUser(u)));
  for (const emp of linked) {
    if (emp) add(emp);
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
