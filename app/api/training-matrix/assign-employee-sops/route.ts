import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/withAuth';
import {
  requireLmsTrainer,
  deptMatchesTrainerScope,
  type LmsTrainerContext,
} from '@/lib/lmsTrainerAuth';
import {
  listSopsApplicableToDesignation,
  listSopsAssignedToEmployee,
  persistEmployeeSopAssignments,
} from '@/lib/assignEmployeeSops';
import type { Session } from 'next-auth';

export const dynamic = 'force-dynamic';

type AssignGate =
  | { ok: true; session: Session; trainer?: undefined }
  | { ok: true; session?: undefined; trainer: LmsTrainerContext }
  | { ok: false; response: NextResponse };

async function canAssignSops(): Promise<AssignGate> {
  const auth = await requireAuth(['admin', 'sop_admin', 'trainer']);
  if (!auth.error) return { ok: true, session: auth.session };

  const trainer = await requireLmsTrainer();
  if (trainer.ok) return { ok: true, trainer: trainer.trainer };

  return { ok: false, response: auth.error };
}

function trainerDepartmentsFromGate(gate: Extract<AssignGate, { ok: true }>): string[] | undefined {
  return gate.trainer?.trainerDepartments;
}

function scopedDepartment(
  department: string,
  trainerDepartments?: string[],
): string | null {
  const dept = String(department || '').trim();
  if (!dept) return null;
  if (!trainerDepartments) return dept;
  return deptMatchesTrainerScope(dept, trainerDepartments) ? dept : null;
}

// GET ?department=&designation=  → SOPs applicable to that designation
// GET ?department=&employeeName= → SOPs already assigned to that employee
export async function GET(req: NextRequest) {
  const gate = await canAssignSops();
  if (!gate.ok) return gate.response;

  const department = req.nextUrl.searchParams.get('department') || '';
  const designation = req.nextUrl.searchParams.get('designation') || '';
  const employeeName = req.nextUrl.searchParams.get('employeeName') || '';
  const trainerDepts = trainerDepartmentsFromGate(gate);
  const dept = scopedDepartment(department, trainerDepts);
  if (!dept) {
    return NextResponse.json({ error: 'Department is required' }, { status: 400 });
  }

  try {
    const sops = employeeName.trim()
      ? await listSopsAssignedToEmployee(dept, employeeName)
      : await listSopsApplicableToDesignation(dept, designation);
    return NextResponse.json({ department: dept, designation, employeeName, sops });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load SOPs' },
      { status: 500 },
    );
  }
}

// POST — assign selected SOPs (or all designation-applicable SOPs) to one employee.
export async function POST(req: NextRequest) {
  const gate = await canAssignSops();
  if (!gate.ok) return gate.response;

  try {
    const body = await req.json();
    const employeeName = String(body?.employeeName || '').trim();
    const department = String(body?.department || '').trim();
    const designation = String(body?.designation || '').trim();
    const trainerDepts = trainerDepartmentsFromGate(gate);
    const dept = scopedDepartment(department, trainerDepts);
    if (!employeeName || !dept) {
      return NextResponse.json(
        { error: 'employeeName and department are required' },
        { status: 400 },
      );
    }

    let sops = Array.isArray(body?.sops)
      ? body.sops.map((s: { sopCode?: string; sopName?: string; months?: number[] }) => ({
          sopCode: String(s?.sopCode || '').trim(),
          sopName: String(s?.sopName || s?.sopCode || '').trim(),
          months: Array.isArray(s?.months) ? s.months.map(Number) : [],
        })).filter((s: { sopCode: string }) => s.sopCode)
      : [];

    if (body?.assignApplicable === true || sops.length === 0) {
      const applicable = await listSopsApplicableToDesignation(dept, designation);
      if (sops.length === 0) sops = applicable;
      else {
        const seen = new Set(sops.map((s: { sopCode: string }) => s.sopCode.toUpperCase()));
        for (const extra of applicable) {
          if (!seen.has(extra.sopCode.toUpperCase())) sops.push(extra);
        }
      }
    }

    if (sops.length === 0) {
      return NextResponse.json({
        assigned: 0,
        message: 'No SOPs are applicable to this designation in the selected department.',
      });
    }

    const result = await persistEmployeeSopAssignments({
      employeeName,
      department: dept,
      designation,
      sops,
    });
    if (!result.ok) {
      return NextResponse.json(
        { error: result.body.error || 'Failed to assign SOPs' },
        { status: result.status },
      );
    }
    return NextResponse.json({
      assigned: sops.length,
      employeeName,
      department: dept,
      ...result.body,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to assign SOPs' },
      { status: 500 },
    );
  }
}
