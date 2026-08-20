import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import {
  employeeAssignmentKey,
  listTrainerScopedEmployees,
} from '@/lib/lmsTrainerEmployees';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { listAttendanceSheets, serializeAttendance } from '@/lib/lmsAttendance';
import { resolveTrainingSop } from '@/lib/lmsAttendanceSops';
import { parseDateOnly, stripVersion } from '@/lib/trainingExamSchedule';

export const dynamic = 'force-dynamic';

/**
 * GET /api/lms/trainer/attendance/eligible?sopCode=&date=YYYY-MM-DD&department=
 *
 * The employee list for an attendance sheet, everyone defaulted to PRESENT — the
 * trainer only unmarks the people who did not attend.
 *
 * When a sheet already exists for this SOP × department × date, its saved marks
 * come back as `existing` so the trainer edits that session rather than
 * unknowingly filing a second sheet for the same room.
 */
export async function GET(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const params = req.nextUrl.searchParams;
  const sopCode = stripVersion(String(params.get('sopCode') || ''));
  const date = parseDateOnly(String(params.get('date') || ''));
  const department = String(params.get('department') || '').trim();

  if (!sopCode) {
    return NextResponse.json({ error: 'sopCode is required' }, { status: 400 });
  }
  if (department && !deptMatchesTrainerScope(department, auth.trainer.trainerDepartments)) {
    return NextResponse.json(
      { error: 'Department is outside your trainer departments' },
      { status: 403 },
    );
  }

  try {
    await connectDB();

    const departments = department ? [department] : auth.trainer.trainerDepartments;

    // Fire all independent queries in parallel.
    const [scoped, assignments, existingSheets] = await Promise.all([
      listTrainerScopedEmployees(departments),
      getEmployeeAssignmentsMap(),
      date
        ? listAttendanceSheets({ departments, sopCode, from: date, to: date, limit: 1 })
        : Promise.resolve([]),
    ]);

    const resolved = await resolveTrainingSop(sopCode, departments, { employees: scoped });
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }

    const employees = scoped
      .map((emp) => {
        const assigned = (assignments.get(employeeAssignmentKey(emp.department, emp.name)) || [])
          .some((a) => stripVersion(a.sopCode) === sopCode);
        return {
          employeeId: emp.employeeId,
          name: emp.name,
          designation: emp.designation,
          department: emp.department,
          employeeCode: emp.employeeCode,
          isTrainer: emp.isTrainer,
          hasLmsAccess: emp.hasLmsAccess,
          assignedThisSop: assigned,
          defaultStatus: 'present' as const,
        };
      })
      .filter((e) => e.assignedThisSop);

    const existing = existingSheets[0] ? serializeAttendance(existingSheets[0]) : null;

    return NextResponse.json({
      sop: resolved.sop,
      departments: auth.trainer.trainerDepartments,
      employees,
      counts: {
        total: employees.length,
        assigned: employees.filter((e) => e.assignedThisSop).length,
      },
      existing,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
