import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import TrainingExamSchedule from '@/models/TrainingExamSchedule';
import Employee from '@/models/Employee';
import { invalidateEmployeeAssignmentsCache } from '@/lib/employeeAssignments';
import {
  invalidateLmsAdminCaches,
  invalidateLmsServerPrefix,
} from '@/lib/lmsCache';
import {
  parseDateOnly,
  monthOfDate,
  yearOfDate,
  stripVersion,
  normalizeDept,
  toDateOnlyIso,
  MONTH_NAMES,
} from '@/lib/trainingExamSchedule';

export const dynamic = 'force-dynamic';

function bustCaches() {
  invalidateEmployeeAssignmentsCache();
  invalidateLmsServerPrefix('lms:me:');
  invalidateLmsServerPrefix('lms:trainer:');
  invalidateLmsServerPrefix('lms:assets:');
  invalidateLmsAdminCaches();
}

/**
 * POST /api/lms/trainer/exam-date
 * Assign / update an employee-scoped LMS exam date for a SOP.
 * Body: { employeeId, sopCode, examDate (YYYY-MM-DD), department?, plannedMonth?, year?, allowOutsideMonth? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const employeeId = String(body.employeeId || '').trim();
  const sopCode = stripVersion(body.sopCode);
  const examDate = parseDateOnly(String(body.examDate || ''));
  const allowOutsideMonth = body.allowOutsideMonth === true;

  if (!employeeId || !sopCode || !examDate) {
    return NextResponse.json(
      { error: 'employeeId, sopCode, and examDate (YYYY-MM-DD) are required' },
      { status: 400 },
    );
  }

  await connectDB();
  const employee = await Employee.findById(employeeId).lean<{
    _id: unknown;
    name: string;
    department: string;
    isActive: boolean;
  }>();
  if (!employee?.isActive) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
  }

  const department = normalizeDept(body.department || employee.department);
  if (!deptMatchesTrainerScope(department, auth.trainer.trainerDepartments)) {
    return NextResponse.json(
      { error: 'You can only assign dates in your trainer departments' },
      { status: 403 },
    );
  }

  const plannedMonth = Number(body.plannedMonth) || monthOfDate(examDate);
  const year = Number(body.year) || yearOfDate(examDate);
  if (plannedMonth < 1 || plannedMonth > 12) {
    return NextResponse.json({ error: 'plannedMonth must be 1–12' }, { status: 400 });
  }

  if (!allowOutsideMonth) {
    const dateMonth = monthOfDate(examDate);
    const dateYear = yearOfDate(examDate);
    if (dateMonth !== plannedMonth || dateYear !== year) {
      return NextResponse.json(
        {
          error: `Exam date should fall in ${MONTH_NAMES[plannedMonth]} ${year} (got ${toDateOnlyIso(examDate)}). Pass allowOutsideMonth=true to override.`,
        },
        { status: 400 },
      );
    }
  }

  const filter = {
    sopCode,
    department,
    year,
    plannedMonth,
    scope: 'employee' as const,
    employeeName: new RegExp(
      `^${employee.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      'i',
    ),
    status: { $ne: 'cancelled' },
  };

  const doc = await TrainingExamSchedule.findOneAndUpdate(
    filter,
    {
      $set: {
        sopCode,
        department,
        year,
        plannedMonth,
        examDate,
        scope: 'employee',
        employeeName: employee.name,
        employeeId: String(employee._id),
        status: 'scheduled',
        createdBy: auth.trainer.name,
      },
    },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
  );

  bustCaches();

  return NextResponse.json({
    ok: true,
    id: String(doc?._id),
    sopCode,
    department,
    employeeId: String(employee._id),
    employeeName: employee.name,
    plannedMonth,
    year,
    examDate: toDateOnlyIso(examDate),
  });
}
