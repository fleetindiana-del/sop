import { connectDB } from '@/lib/mongodb';
import LmsTrainingIgnore from '@/models/lms/LmsTrainingIgnore';

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

export type TrainingIgnoreRule = {
  department: string;
  year: number;
  month: number;
  sopCode?: string | null;
};

function deptKey(d: string): string {
  return String(d || '').trim().toLowerCase();
}

/** Load ignore rules for one department (or all if department omitted). */
export async function listTrainingIgnores(department?: string): Promise<TrainingIgnoreRule[]> {
  await connectDB();
  const filter = department ? { department: new RegExp(`^${escapeRegex(department.trim())}$`, 'i') } : {};
  const rows = await LmsTrainingIgnore.find(filter)
    .select('department year month sopCode')
    .lean<TrainingIgnoreRule[]>();
  return rows.map((r) => ({
    department: r.department,
    year: r.year,
    month: r.month,
    sopCode: r.sopCode ? stripVersion(String(r.sopCode)) : null,
  }));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assignmentIsIgnored(
  assignment: { sopCode: string; month: number; year: number; sopDepartment?: string },
  rules: TrainingIgnoreRule[],
  employeeDepartment: string,
): boolean {
  const dept = deptKey(employeeDepartment || assignment.sopDepartment || '');
  const code = stripVersion(assignment.sopCode);
  for (const r of rules) {
    if (deptKey(r.department) !== dept) continue;
    if (r.year !== assignment.year || r.month !== assignment.month) continue;
    if (!r.sopCode) return true; // whole month for department
    if (stripVersion(r.sopCode) === code) return true;
  }
  return false;
}

export function filterIgnoredAssignments<T extends {
  sopCode: string;
  month: number;
  year: number;
  sopDepartment?: string;
}>(
  assignments: T[],
  rules: TrainingIgnoreRule[],
  employeeDepartment: string,
): T[] {
  if (!rules.length) return assignments;
  return assignments.filter((a) => !assignmentIsIgnored(a, rules, employeeDepartment));
}
