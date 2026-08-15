import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import { bustTrainerScheduleCaches } from '@/lib/lmsTrainerCache';
import {
  checkEmployeeSelection,
  listTrainerScopedEmployees,
} from '@/lib/lmsTrainerEmployees';
import {
  buildAttendanceRecords,
  isAttendanceStatus,
  listAttendanceSheets,
  serializeAttendance,
  summarizeByEmployee,
} from '@/lib/lmsAttendance';
import TrainingAttendance, {
  type AttendanceStatus,
} from '@/models/lms/TrainingAttendance';
import { resolveTrainingSop } from '@/lib/lmsAttendanceSops';
import {
  monthOfDate,
  parseDateOnly,
  stripVersion,
  yearOfDate,
} from '@/lib/trainingExamSchedule';

export const dynamic = 'force-dynamic';

/**
 * GET /api/lms/trainer/attendance
 *   ?sopCode=&employeeId=&year=&month=&from=&to=
 *
 * Filed attendance sheets in the trainer's departments — the permanent record and
 * the report view. Also returns a per-employee roll-up over the same filter.
 */
export async function GET(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const params = req.nextUrl.searchParams;
  const sopCode = stripVersion(String(params.get('sopCode') || '')) || undefined;
  const employeeId = params.get('employeeId')?.trim() || undefined;
  const year = Number(params.get('year')) || undefined;
  const month = Number(params.get('month')) || undefined;
  const from = parseDateOnly(String(params.get('from') || '')) || undefined;
  const to = parseDateOnly(String(params.get('to') || '')) || undefined;
  const department = String(params.get('department') || '').trim();

  if (department && !deptMatchesTrainerScope(department, auth.trainer.trainerDepartments)) {
    return NextResponse.json(
      { error: 'Department is outside your trainer departments' },
      { status: 403 },
    );
  }

  try {
    await connectDB();
    const sheets = await listAttendanceSheets({
      departments: department ? [department] : auth.trainer.trainerDepartments,
      sopCode,
      employeeId,
      year,
      month,
      from,
      to,
    });

    const totals = sheets.reduce(
      (acc, s) => {
        acc.present += s.presentCount ?? 0;
        acc.absent += s.absentCount ?? 0;
        acc.marked += s.totalCount ?? 0;
        return acc;
      },
      { present: 0, absent: 0, marked: 0 },
    );

    return NextResponse.json({
      departments: auth.trainer.trainerDepartments,
      sheets: sheets.map(serializeAttendance),
      byEmployee: summarizeByEmployee(sheets),
      totals: {
        ...totals,
        sessions: sheets.length,
        attendancePct: totals.marked > 0 ? Math.round((totals.present / totals.marked) * 100) : 0,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/lms/trainer/attendance — file (or re-file) one session's sheet.
 *
 * Body: {
 *   sopCode, trainingDate: 'YYYY-MM-DD', department,
 *   employeeIds: string[],                     // everyone expected at the session
 *   absentEmployeeIds?: string[],              // the ones who did not attend
 *   remarks?: Record<employeeId, string>,
 *   notes?
 * }
 *
 * The client sends the expected roster plus only the absentees, mirroring the
 * workflow: everyone is present until the trainer says otherwise.
 */
export async function POST(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const sopCode = stripVersion(String(body.sopCode || ''));
  const trainingDate = parseDateOnly(String(body.trainingDate || ''));
  const department = String(body.department || '').trim();
  const notes = String(body.notes || '').trim() || undefined;

  const rawIds: unknown[] = Array.isArray(body.employeeIds) ? body.employeeIds : [];
  const employeeIds = [...new Set(rawIds.map((id) => String(id ?? '').trim()).filter(Boolean))];
  const rawAbsent: unknown[] = Array.isArray(body.absentEmployeeIds) ? body.absentEmployeeIds : [];
  const absentIds = new Set(rawAbsent.map((id) => String(id ?? '').trim()).filter(Boolean));
  const remarks: Record<string, unknown> =
    body.remarks && typeof body.remarks === 'object' ? body.remarks : {};

  if (!sopCode || !trainingDate || !department) {
    return NextResponse.json(
      { error: 'sopCode, department and trainingDate (YYYY-MM-DD) are required' },
      { status: 400 },
    );
  }
  if (employeeIds.length === 0) {
    return NextResponse.json({ error: 'Select at least one employee' }, { status: 400 });
  }
  if (!deptMatchesTrainerScope(department, auth.trainer.trainerDepartments)) {
    return NextResponse.json(
      { error: 'Department is outside your trainer departments' },
      { status: 403 },
    );
  }
  // An attendance sheet is a record of something that happened; a future date
  // would mean recording a session nobody has sat through yet.
  const todayIso = new Date().toISOString().slice(0, 10);
  if (String(body.trainingDate).slice(0, 10) > todayIso) {
    return NextResponse.json(
      { error: 'Training date cannot be in the future' },
      { status: 400 },
    );
  }

  const unknownAbsent = [...absentIds].filter((id) => !employeeIds.includes(id));
  if (unknownAbsent.length > 0) {
    return NextResponse.json(
      { error: 'Absent employees must be part of the session roster' },
      { status: 400 },
    );
  }

  try {
    await connectDB();

    // Attendance does not require an LMS login — being in the training room and
    // being able to sit the online exam are different things.
    const scoped = await listTrainerScopedEmployees([department]);

    const resolved = await resolveTrainingSop(sopCode, [department], { employees: scoped });
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    const sop = resolved.sop;

    const check = checkEmployeeSelection(employeeIds, scoped);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: check.status });
    }

    const marks = new Map<string, { status: AttendanceStatus; remark?: string }>();
    for (const emp of check.employees) {
      const remark = remarks[emp.employeeId];
      const status: AttendanceStatus = absentIds.has(emp.employeeId) ? 'absent' : 'present';
      if (status === 'absent' || typeof remark === 'string') {
        marks.set(emp.employeeId, {
          status,
          remark: typeof remark === 'string' ? remark : undefined,
        });
      }
    }

    const records = buildAttendanceRecords(check.employees, marks);

    // Re-filing the same session edits that sheet (the unique index guarantees
    // there is only ever one), so a correction never leaves two versions behind.
    const doc =
      (await TrainingAttendance.findOne({ sopCode, department, trainingDate })) ??
      new TrainingAttendance({ sopCode, department, trainingDate });

    doc.trainerId = auth.trainer.employeeId;
    doc.trainerName = auth.trainer.name;
    doc.sopName = sop.sopName;
    doc.month = monthOfDate(trainingDate);
    doc.year = yearOfDate(trainingDate);
    doc.records = records;
    doc.notes = notes;
    await doc.save();

    bustTrainerScheduleCaches();

    return NextResponse.json({ ok: true, sheet: serializeAttendance(doc) });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/lms/trainer/attendance — correct one employee's mark on a filed sheet.
 * Body: { id, employeeId, status: 'present' | 'absent', remark? }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || '').trim();
  const employeeId = String(body.employeeId || '').trim();
  const status = body.status;

  if (!id || !employeeId || !isAttendanceStatus(status)) {
    return NextResponse.json(
      { error: "id, employeeId and status ('present' | 'absent') are required" },
      { status: 400 },
    );
  }

  try {
    await connectDB();
    const doc = await TrainingAttendance.findById(id);
    if (!doc) return NextResponse.json({ error: 'Attendance sheet not found' }, { status: 404 });
    if (!deptMatchesTrainerScope(doc.department, auth.trainer.trainerDepartments)) {
      return NextResponse.json(
        { error: 'Attendance sheet is outside your trainer departments' },
        { status: 403 },
      );
    }

    const record = doc.records.find((r) => r.employeeId === employeeId);
    if (!record) {
      return NextResponse.json({ error: 'Employee is not on this sheet' }, { status: 404 });
    }

    record.status = status;
    if (body.remark !== undefined) {
      record.remark = String(body.remark || '').trim() || undefined;
    }
    doc.markModified('records');
    await doc.save();

    bustTrainerScheduleCaches();
    return NextResponse.json({ ok: true, sheet: serializeAttendance(doc) });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** DELETE /api/lms/trainer/attendance?id= — withdraw a sheet filed in error. */
export async function DELETE(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const id = req.nextUrl.searchParams.get('id')?.trim() || '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  try {
    await connectDB();
    const doc = await TrainingAttendance.findById(id);
    if (!doc) return NextResponse.json({ error: 'Attendance sheet not found' }, { status: 404 });
    if (!deptMatchesTrainerScope(doc.department, auth.trainer.trainerDepartments)) {
      return NextResponse.json(
        { error: 'Attendance sheet is outside your trainer departments' },
        { status: 403 },
      );
    }

    await doc.deleteOne();
    bustTrainerScheduleCaches();
    return NextResponse.json({ ok: true, deleted: id });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
