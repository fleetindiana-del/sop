import mongoose from 'mongoose';
import Employee from '@/models/Employee';
import LearningProgress from '@/models/lms/LearningProgress';
import {
  normalizeEmployeeDepartment,
  resolveTrainerDepartments,
} from '@/lib/employeeTrainer';
import { baseIdentifierFromIdentifier, sopFamilyIdentifierRegex } from '@/lib/sop-utils';

export type TrainerExamGateResult = {
  allowed: boolean;
  /** trainer_pending = trainers exist but none completed this SOP yet */
  code?: 'trainer_pending' | 'no_trainer';
  reason?: string;
};

function deptMatches(a: string, b: string): boolean {
  return normalizeEmployeeDepartment(a).toLowerCase() === normalizeEmployeeDepartment(b).toLowerCase();
}

/**
 * Non-trainer employees may sit an SOP exam only after at least one active
 * trainer who covers their department has completed training for that SOP.
 * Designated trainers may always take the exam (they unlock others).
 */
export async function getTrainerExamEligibility(opts: {
  employeeId: string;
  department?: string | null;
  isTrainer?: boolean;
  trainerDepartments?: string[] | null;
  sopCode: string;
}): Promise<TrainerExamGateResult> {
  // Designated trainers may take the exam without waiting — they unlock others.
  if (opts.isTrainer === true) return { allowed: true };

  const dept = normalizeEmployeeDepartment(opts.department);
  if (!dept) {
    return {
      allowed: false,
      code: 'no_trainer',
      reason: 'Your department is not set. Contact your administrator.',
    };
  }

  const trainers = await Employee.find({ isActive: true, isTrainer: true })
    .select('_id department trainerDepartments isTrainer')
    .lean<Array<{
      _id: mongoose.Types.ObjectId;
      department?: string;
      trainerDepartments?: string[];
      isTrainer?: boolean;
    }>>();

  const coveringIds = trainers
    .filter((t) =>
      resolveTrainerDepartments(t).some((d) => deptMatches(d, dept)),
    )
    .map((t) => t._id);

  if (coveringIds.length === 0) {
    return {
      allowed: false,
      code: 'no_trainer',
      reason: 'No department trainer is assigned for your department. Contact your administrator.',
    };
  }

  const familyRe = sopFamilyIdentifierRegex(opts.sopCode);
  const completed = await LearningProgress.findOne({
    employeeId: { $in: coveringIds },
    sopCode: { $regex: familyRe },
    $or: [
      { status: 'completed' },
      { 'steps.quiz.passed': true },
      { 'steps.quiz.completed': true },
      { 'steps.quizGu.passed': true },
      { 'steps.quizGu.completed': true },
    ],
  })
    .select('_id')
    .lean();

  if (completed) return { allowed: true };

  return {
    allowed: false,
    code: 'trainer_pending',
    reason:
      'Exam unlocks after your department trainer completes training for this SOP.',
  };
}

/**
 * Batch eligibility for the LMS assets dashboard.
 * Returns a map keyed by the original sopCode (and family base) → unlocked.
 */
export async function batchTrainerExamUnlocked(
  employee: {
    _id: mongoose.Types.ObjectId | string;
    department?: string | null;
    isTrainer?: boolean;
    trainerDepartments?: string[] | null;
  },
  sopCodes: string[],
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const unique = [...new Set(sopCodes.map((c) => String(c || '').trim()).filter(Boolean))];
  if (unique.length === 0) return out;

  if (employee.isTrainer === true) {
    for (const c of unique) {
      out.set(c, true);
      const fam = (baseIdentifierFromIdentifier(c) || c).toUpperCase();
      out.set(fam, true);
    }
    return out;
  }

  const dept = normalizeEmployeeDepartment(employee.department);
  if (!dept) {
    for (const c of unique) out.set(c, false);
    return out;
  }

  const trainers = await Employee.find({ isActive: true, isTrainer: true })
    .select('_id department trainerDepartments isTrainer')
    .lean<Array<{
      _id: mongoose.Types.ObjectId;
      department?: string;
      trainerDepartments?: string[];
      isTrainer?: boolean;
    }>>();

  const coveringIds = trainers
    .filter((t) =>
      resolveTrainerDepartments(t).some((d) => deptMatches(d, dept)),
    )
    .map((t) => t._id);

  if (coveringIds.length === 0) {
    for (const c of unique) out.set(c, false);
    return out;
  }

  const progresses = await LearningProgress.find({
    employeeId: { $in: coveringIds },
    $or: [
      { status: 'completed' },
      { 'steps.quiz.passed': true },
      { 'steps.quiz.completed': true },
      { 'steps.quizGu.passed': true },
      { 'steps.quizGu.completed': true },
    ],
  })
    .select('sopCode')
    .lean<Array<{ sopCode: string }>>();

  const completedFamilies = new Set<string>();
  for (const p of progresses) {
    const code = String(p.sopCode || '').toUpperCase();
    if (!code) continue;
    completedFamilies.add(code);
    completedFamilies.add((baseIdentifierFromIdentifier(code) || code).toUpperCase());
  }

  for (const c of unique) {
    const fam = (baseIdentifierFromIdentifier(c) || c).toUpperCase();
    const unlocked =
      completedFamilies.has(c.toUpperCase()) || completedFamilies.has(fam);
    out.set(c, unlocked);
    out.set(fam, unlocked || out.get(fam) === true);
  }

  return out;
}
