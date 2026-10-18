/**
 * Induction comes first: an employee flagged `inductionTrainingRequired` sits
 * the exams for their induction SOPs (Manage SOP induction ticks, month-wise
 * from joining) before any regular training exam unlocks. Induction exams keep
 * their usual gates; only regular training exams wait on this one.
 * Designated trainers are exempt, as with the other exam gates.
 */

import type { EmployeeSopAssignment } from '@/lib/employeeAssignments';
import { isExamCompleted, loadExamProgressMap, stripVersion } from '@/lib/lmsExamScheduling';

export type InductionGate = {
  /** Induction SOP families (version-stripped) still awaiting a completed exam. */
  pending: string[];
  /** Whether the exam for `sopCode` may start as far as induction is concerned. */
  unlocked: (sopCode: string) => boolean;
};

const OPEN: InductionGate = { pending: [], unlocked: () => true };

export const INDUCTION_PENDING_REASON =
  'Complete your induction training exams first — regular training exams unlock after induction.';

export async function getInductionGate(
  employee: {
    _id: unknown;
    isTrainer?: boolean;
    inductionTrainingRequired?: boolean;
  },
  assignments: EmployeeSopAssignment[],
): Promise<InductionGate> {
  if (employee.isTrainer === true || employee.inductionTrainingRequired !== true) return OPEN;

  const inductionCodes = new Set(
    assignments
      .filter((a) => a.trainingType === 'induction')
      .map((a) => stripVersion(a.sopCode))
      .filter(Boolean),
  );
  if (inductionCodes.size === 0) return OPEN;

  const employeeId = String(employee._id);
  const progress = await loadExamProgressMap([employeeId]);
  const pending = [...inductionCodes].filter(
    (code) => !isExamCompleted(progress.get(`${employeeId}::${code}`)),
  );
  if (pending.length === 0) return OPEN;

  return {
    pending,
    unlocked: (sopCode) => inductionCodes.has(stripVersion(sopCode)),
  };
}
