import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsTrainer } from '@/lib/lmsTrainerAuth';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import {
  employeeAssignmentKey,
  listTrainerScopedEmployees,
} from '@/lib/lmsTrainerEmployees';
import { sopFamilyCodesMatch } from '@/lib/sopIdentifierNormalize';
import { baseIdentifierFromIdentifier } from '@/lib/sop-utils';

export const dynamic = 'force-dynamic';

function normalizeSopCode(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return (baseIdentifierFromIdentifier(trimmed) || trimmed).toUpperCase();
}

// GET /api/lms/trainer/meta?sopCode=
export async function GET(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const sopCode = normalizeSopCode(req.nextUrl.searchParams.get('sopCode') || '');
  const depts = auth.trainer.trainerDepartments;

  try {
    await connectDB();
    const employees = await listTrainerScopedEmployees(depts);

    let filtered = employees;
    if (sopCode) {
      const assignmentsMap = await getEmployeeAssignmentsMap();
      filtered = employees.filter((e) => {
        const assignments = assignmentsMap.get(employeeAssignmentKey(e.department, e.name)) ?? [];
        return assignments.some((a) => sopFamilyCodesMatch(a.sopCode, sopCode));
      });
    }

    return NextResponse.json({
      sopCode: sopCode || undefined,
      departments: depts,
      designations: [...new Set(filtered.map((e) => e.designation).filter(Boolean))].sort(),
      employees: filtered.map((e) => ({
        id: e.employeeId,
        name: e.name,
        department: e.department,
        designation: e.designation,
        isTrainer: e.isTrainer,
        hasLmsAccess: e.hasLmsAccess,
      })),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
