import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import MatrixSOPAssignment from '@/models/MatrixSOPAssignment';
import TrainingMatrixRecord from '@/models/TrainingMatrixRecord';
import {
  employeeAssignmentMapKey,
  getEmployeeAssignmentsMap,
} from '@/lib/employeeAssignments';
import { designationSetsOverlap } from '@/lib/designationMatch';
import {
  getTrainingMatrixDepartments,
} from '@/lib/trainingMatrixDepartments.server';
import {
  resolveTrainingMatrixDepartment,
} from '@/lib/trainingMatrixDepartments';
import { POST as postManageSopView } from '@/app/api/training-matrix/manage-sop-view/route';

export type ApplicableSop = {
  sopCode: string;
  sopName: string;
  months: number[];
};

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

function resolveDept(raw: string, known: string[]): string {
  return (
    resolveTrainingMatrixDepartment(raw, known) || String(raw || '').trim()
  );
}

function mergeSop(
  map: Map<string, ApplicableSop>,
  sopCode: string,
  sopName: string,
  months: number[],
) {
  const key = stripVersion(sopCode);
  if (!key) return;
  const existing = map.get(key);
  const cleanMonths = months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
  if (!existing) {
    map.set(key, {
      sopCode: String(sopCode).trim() || key,
      sopName: String(sopName || sopCode).trim() || key,
      months: [...new Set(cleanMonths)],
    });
    return;
  }
  for (const m of cleanMonths) {
    if (!existing.months.includes(m)) existing.months.push(m);
  }
  if (!existing.sopName && sopName) existing.sopName = sopName;
}

/**
 * SOPs already scheduled in `department` that apply to `designation`
 * (matrix designation applicability, or existing training rows for that title).
 */
export async function listSopsApplicableToDesignation(
  department: string,
  designation: string,
): Promise<ApplicableSop[]> {
  const deptRaw = String(department || '').trim();
  const desig = String(designation || '').trim();
  if (!deptRaw || !desig) return [];

  await connectDB();
  const known = await getTrainingMatrixDepartments();
  const dept = resolveDept(deptRaw, known);

  const deptRe = new RegExp(`^${deptRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const [assignments, records] = await Promise.all([
    MatrixSOPAssignment.find({
      isActive: { $ne: false },
      deletedAt: { $in: [null, undefined] },
      department: deptRe,
    })
      .select('department sopCode sopName effectiveMonth designationApplicability')
      .lean<Array<{
        department?: string;
        sopCode?: string;
        sopName?: string;
        effectiveMonth?: number;
        designationApplicability?: string[];
      }>>(),
    TrainingMatrixRecord.find({
      status: { $ne: 'na' },
      department: deptRe,
    })
      .select('department sopCode sopName designation month')
      .lean<Array<{
        department?: string;
        sopCode?: string;
        sopName?: string;
        designation?: string;
        month?: number;
      }>>(),
  ]);

  const byCode = new Map<string, ApplicableSop>();

  for (const row of assignments) {
    const rowDept = resolveDept(String(row.department || ''), known);
    if (!rowDept || rowDept.toLowerCase() !== dept.toLowerCase()) continue;
    const applicability = Array.isArray(row.designationApplicability)
      ? row.designationApplicability
      : [];
    const applies =
      applicability.length === 0 || designationSetsOverlap(applicability, desig);
    if (!applies) continue;
    const month = Number(row.effectiveMonth);
    mergeSop(
      byCode,
      String(row.sopCode || ''),
      String(row.sopName || ''),
      Number.isInteger(month) ? [month] : [],
    );
  }

  for (const row of records) {
    const rowDept = resolveDept(String(row.department || ''), known);
    if (!rowDept || rowDept.toLowerCase() !== dept.toLowerCase()) continue;
    if (!designationSetsOverlap(String(row.designation || ''), desig)) continue;
    const month = Number(row.month);
    mergeSop(
      byCode,
      String(row.sopCode || ''),
      String(row.sopName || ''),
      Number.isInteger(month) ? [month] : [],
    );
  }

  return [...byCode.values()].sort((a, b) => a.sopCode.localeCompare(b.sopCode));
}

export async function listSopsAssignedToEmployee(
  department: string,
  employeeName: string,
): Promise<ApplicableSop[]> {
  const dept = String(department || '').trim();
  const name = String(employeeName || '').trim();
  if (!dept || !name) return [];

  const map = await getEmployeeAssignmentsMap({ departments: [dept] });
  const rows =
    map.get(employeeAssignmentMapKey(dept, name)) ||
    map.get(`${dept}||${name}`.trim().toLowerCase()) ||
    [];

  const byCode = new Map<string, ApplicableSop>();
  for (const a of rows) {
    if (a.trainingType !== 'training' || a.derivedFrom) continue;
    mergeSop(byCode, a.sopCode, a.sopName || a.sopCode, a.month ? [a.month] : []);
  }
  return [...byCode.values()].sort((a, b) => a.sopCode.localeCompare(b.sopCode));
}

export async function persistEmployeeSopAssignments(opts: {
  employeeName: string;
  department: string;
  designation?: string;
  sops: ApplicableSop[];
}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const sops = (opts.sops || []).filter((s) => String(s.sopCode || '').trim());
  if (!opts.employeeName?.trim() || !opts.department?.trim() || sops.length === 0) {
    return { ok: false, status: 400, body: { error: 'Employee, department and SOPs are required' } };
  }

  const req = new NextRequest('http://localhost/api/training-matrix/manage-sop-view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeSopAssignments: [{
        employeeName: opts.employeeName.trim(),
        department: opts.department.trim(),
        designation: String(opts.designation || '').trim(),
        sops: sops.map((s) => ({
          sopCode: s.sopCode,
          sopName: s.sopName,
          months: s.months,
        })),
      }],
    }),
  });

  const res = await postManageSopView(req);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body };
}
