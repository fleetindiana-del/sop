import { NextRequest, NextResponse } from 'next/server';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import { listTrainableSops } from '@/lib/lmsAttendanceSops';

export const dynamic = 'force-dynamic';

/**
 * GET /api/lms/trainer/attendance/sop-catalog?department=
 * The SOP/training sessions a trainer can record attendance for.
 */
export async function GET(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const department = String(req.nextUrl.searchParams.get('department') || '').trim();
  if (department && !deptMatchesTrainerScope(department, auth.trainer.trainerDepartments)) {
    return NextResponse.json(
      { error: 'Department is outside your trainer departments' },
      { status: 403 },
    );
  }

  try {
    const departments = department ? [department] : auth.trainer.trainerDepartments;
    const { sops, employees } = await listTrainableSops(departments);

    return NextResponse.json({
      departments: auth.trainer.trainerDepartments,
      employeeCount: employees.length,
      sops,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
