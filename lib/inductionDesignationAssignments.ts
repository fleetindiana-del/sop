import InductionMatrixSOPAssignment from '@/models/InductionMatrixSOPAssignment';
import { canonTrainingMatrixDepartment } from '@/lib/trainingMatrixDepartments';
import { designationSetsOverlap } from '@/lib/designationMatch';

/**
 * Induction SOPs assigned per department × designation — the induction ticks on
 * Manage SOP, stored as one active `InductionMatrixSOPAssignment` per
 * (department, SOP). These are the live induction assignments: the Excel
 * upload / per-employee record sources were never wired up and stay empty.
 * Only employees flagged `inductionTrainingRequired` receive them.
 */
export interface InductionDesignationRow {
  department: string;
  sopCode: string;
  sopName: string;
  effectiveMonth: number;
  effectiveYear: number;
  designationApplicability: string[];
}

export function stripInductionSopVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

export function inductionDeptKey(dept: string): string {
  return (canonTrainingMatrixDepartment(dept) || String(dept || '').trim()).toLowerCase();
}

export async function listInductionDesignationRows(): Promise<InductionDesignationRow[]> {
  const rows = await InductionMatrixSOPAssignment.find({
    isActive: true,
    deletedAt: { $in: [null, undefined] },
  })
    .select('department sopCode sopName effectiveMonth effectiveYear designationApplicability')
    .lean<Array<Partial<InductionDesignationRow>>>();

  return rows
    .map((r) => ({
      department: String(r.department || '').trim(),
      sopCode: stripInductionSopVersion(String(r.sopCode || '')),
      sopName: String(r.sopName || '').trim(),
      effectiveMonth: Number(r.effectiveMonth) || 1,
      effectiveYear: Number(r.effectiveYear) || new Date().getFullYear(),
      designationApplicability: (r.designationApplicability || []).map((d) => String(d).trim()).filter(Boolean),
    }))
    .filter((r) => r.department && r.sopCode);
}

/** An empty applicability list (rows added without designations) covers everyone. */
export function inductionRowApplies(
  row: InductionDesignationRow,
  employee: { department?: string | null; designation?: string | null },
): boolean {
  if (inductionDeptKey(row.department) !== inductionDeptKey(String(employee.department || ''))) return false;
  if (row.designationApplicability.length === 0) return true;
  return designationSetsOverlap(row.designationApplicability, String(employee.designation || ''));
}
