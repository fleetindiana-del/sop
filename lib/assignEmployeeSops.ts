import { NextRequest } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import MatrixSOPAssignment from '@/models/MatrixSOPAssignment';
import TrainingMatrixRecord from '@/models/TrainingMatrixRecord';
import Employee from '@/models/Employee';
import {
  employeeAssignmentMapKey,
  getEmployeeAssignmentsMap,
  invalidateEmployeeAssignmentsCache,
  trainingExclusionKey,
} from '@/lib/employeeAssignments';
import { designationSetsOverlap } from '@/lib/designationMatch';
import {
  getTrainingMatrixDepartments,
} from '@/lib/trainingMatrixDepartments.server';
import {
  canonTrainingMatrixDepartment,
  resolveTrainingMatrixDepartment,
} from '@/lib/trainingMatrixDepartments';
import { POST as postManageSopView } from '@/app/api/training-matrix/manage-sop-view/route';
import SOP from '@/models/SOP';
import { compareSopCodes, isSopDocumentExpired } from '@/lib/sop-utils';

export type ApplicableSop = {
  sopCode: string;
  sopName: string;
  months: number[];
  expired?: boolean;
  /** Where an assigned SOP comes from (only set by `includeDerived` listings). */
  source?: 'matrix' | 'trainer-coverage' | 'trainer-schedule' | 'designation-applicability' | 'qa-for-qc';
};

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

function resolveDept(raw: string, known: string[]): string {
  return (
    resolveTrainingMatrixDepartment(raw, known) || String(raw || '').trim()
  );
}

export async function expiredSopCodeSet(codes: string[]): Promise<Set<string>> {
  const unique = [...new Set(codes.map(stripVersion).filter(Boolean))];
  if (unique.length === 0) return new Set();
  await connectDB();
  const rows = await SOP.find({
    isObsolete: { $ne: true },
    $or: [
      { sopBaseId: { $in: unique } },
      { identifier: { $in: codes } },
    ],
  })
    .select('identifier sopBaseId versionNum expiryDate')
    .lean<Array<{ identifier?: string; sopBaseId?: string; versionNum?: number; expiryDate?: Date }>>();

  // A base can carry several non-obsolete rows when an older version was never
  // marked obsolete on re-upload (e.g. QAGE119-01/-02 alongside the current
  // -03). Expiry must follow the current (highest-version) row only, same as
  // the LMS dashboard (lib/employeeAssignments.ts) — otherwise a stale,
  // already-superseded version's expiry wrongly locks the live document.
  const latestByBase = new Map<string, { versionNum: number; expiryDate?: Date }>();
  for (const row of rows) {
    const base = String(row.sopBaseId || stripVersion(String(row.identifier || ''))).toUpperCase();
    if (!base) continue;
    const versionNum = Number(row.versionNum ?? -1);
    const existing = latestByBase.get(base);
    if (!existing || versionNum > existing.versionNum) {
      latestByBase.set(base, { versionNum, expiryDate: row.expiryDate });
    }
  }

  const expired = new Set<string>();
  for (const [base, latest] of latestByBase) {
    if (isSopDocumentExpired(latest.expiryDate ?? null)) expired.add(base);
  }
  return expired;
}

async function annotateExpiry(sops: ApplicableSop[]): Promise<ApplicableSop[]> {
  if (sops.length === 0) return sops;
  const expired = await expiredSopCodeSet(sops.map((s) => s.sopCode));
  return sops.map((s) => ({
    ...s,
    expired: expired.has(stripVersion(s.sopCode)),
  }));
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

  return annotateExpiry(
    [...byCode.values()].sort((a, b) => compareSopCodes(a.sopCode, b.sopCode)),
  );
}

/**
 * SOPs assigned to one employee. By default only individual matrix
 * assignments; with `includeDerived` also trainer department coverage and
 * designation-derived SOPs (everything the person actually trains on), each
 * tagged with where it comes from.
 */
export async function listSopsAssignedToEmployee(
  department: string,
  employeeName: string,
  opts?: { includeDerived?: boolean },
): Promise<ApplicableSop[]> {
  const dept = String(department || '').trim();
  const name = String(employeeName || '').trim();
  if (!dept || !name) return [];

  // Trainer coverage spans every department they train, so the scoped map
  // would miss SOPs from their other departments.
  const map = await getEmployeeAssignmentsMap(
    opts?.includeDerived ? undefined : { departments: [dept] },
  );
  const rows =
    map.get(employeeAssignmentMapKey(dept, name)) ||
    map.get(`${dept}||${name}`.trim().toLowerCase()) ||
    [];

  const byCode = new Map<string, ApplicableSop>();
  for (const a of rows) {
    if (a.trainingType !== 'training') continue;
    if (a.derivedFrom && !opts?.includeDerived) continue;
    mergeSop(byCode, a.sopCode, a.sopName || a.sopCode, a.month ? [a.month] : []);
    if (opts?.includeDerived) {
      const entry = byCode.get(stripVersion(a.sopCode));
      if (entry && !entry.source) entry.source = a.derivedFrom || 'matrix';
    }
  }
  return annotateExpiry(
    [...byCode.values()].sort((a, b) => compareSopCodes(a.sopCode, b.sopCode)),
  );
}

/**
 * Add (`exclude: true`) or clear SOP codes in the employee's
 * `excludedTrainingSops`. Removing a SOP must also suppress the synthesized
 * assignments (trainer coverage, designation applicability) — otherwise it
 * reappears on the next load because there is no per-person record to delete.
 */
async function updateTrainingExclusions(opts: {
  employeeName: string;
  department: string;
  sopCodes: string[];
  exclude: boolean;
}): Promise<void> {
  const keys = [...new Set(opts.sopCodes.map(trainingExclusionKey).filter(Boolean))];
  const name = opts.employeeName.trim();
  if (keys.length === 0 || !name) return;

  await connectDB();
  const matches = await Employee.find({
    name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
  })
    .select('_id department')
    .lean<Array<{ _id: mongoose.Types.ObjectId; department?: string }>>();
  const wantDept = canonTrainingMatrixDepartment(opts.department) || opts.department.trim();
  const inDept = matches.filter(
    (e) =>
      (canonTrainingMatrixDepartment(String(e.department || '')) || String(e.department || '').trim())
        .toLowerCase() === wantDept.toLowerCase(),
  );
  const targets = inDept.length > 0 ? inDept : matches.length === 1 ? matches : [];
  if (targets.length === 0) return;

  await Employee.updateMany(
    { _id: { $in: targets.map((t) => t._id) } },
    opts.exclude
      ? { $addToSet: { excludedTrainingSops: { $each: keys } } }
      : { $pull: { excludedTrainingSops: { $in: keys } } },
  );
  invalidateEmployeeAssignmentsCache();
}

export async function persistEmployeeSopAssignments(opts: {
  employeeName: string;
  department: string;
  designation?: string;
  sops: ApplicableSop[];
}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const incoming = (opts.sops || []).filter((s) => String(s.sopCode || '').trim());
  const expired = await expiredSopCodeSet(incoming.map((s) => s.sopCode));
  const sops = incoming.filter((s) => !expired.has(stripVersion(s.sopCode)));
  if (!opts.employeeName?.trim() || !opts.department?.trim() || incoming.length === 0) {
    return { ok: false, status: 400, body: { error: 'Employee, department and SOPs are required' } };
  }
  if (sops.length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Expired SOPs cannot be assigned until the document is renewed.' },
    };
  }

  // Re-assigning undoes any earlier manual removal of the same SOP.
  await updateTrainingExclusions({
    employeeName: opts.employeeName,
    department: opts.department,
    sopCodes: sops.map((s) => s.sopCode),
    exclude: false,
  });

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
  return {
    ok: res.ok,
    status: res.status,
    body: { ...body, assigned: sops.length, skippedExpired: incoming.length - sops.length },
  };
}

export async function persistEmployeeSopRemovals(opts: {
  employeeName: string;
  department: string;
  sopCodes: string[];
}): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const codes = [
    ...new Set((opts.sopCodes || []).map((c) => String(c || '').trim()).filter(Boolean)),
  ];
  if (!opts.employeeName?.trim() || !opts.department?.trim() || codes.length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Employee, department and SOP codes are required' },
    };
  }

  // Recorded before the matrix removal so the rebuilt assignment map no longer
  // re-derives these SOPs from trainer coverage / designation applicability.
  await updateTrainingExclusions({
    employeeName: opts.employeeName,
    department: opts.department,
    sopCodes: codes,
    exclude: true,
  });

  const req = new NextRequest('http://localhost/api/training-matrix/manage-sop-view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeSopRemovals: [{
        employeeName: opts.employeeName.trim(),
        department: opts.department.trim(),
        sops: codes.map((sopCode) => ({ sopCode })),
      }],
    }),
  });

  const res = await postManageSopView(req);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, body: { ...body, removed: codes.length } };
}
