import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import { bustTrainerScheduleCaches } from '@/lib/lmsTrainerCache';
import ScheduledExam from '@/models/lms/ScheduledExam';
import {
  checkEmployeeSelection,
  listTrainerScopedEmployees,
} from '@/lib/lmsTrainerEmployees';
import {
  buildScheduledExamView,
  listScheduledExams,
  loadExamProgressMap,
  serializeScheduledExam,
  stripVersion,
} from '@/lib/lmsExamScheduling';
import {
  parseDateOnly,
  monthOfDate,
  yearOfDate,
  toDateOnlyIso,
} from '@/lib/trainingExamSchedule';
import { buildSopList } from '@/app/api/lms/admin/sop-exam-settings/route';
import { getOrBuildLmsCache, lmsServerKeys, lmsServerTtl } from '@/lib/lmsCache';

export const dynamic = 'force-dynamic';

/** Resolve the SOP a trainer is scheduling, enforcing department scope. */
async function resolveExam(sopCode: string, trainerDepts: string[]) {
  const list = await getOrBuildLmsCache(
    lmsServerKeys.adminSopExamSettings(),
    lmsServerTtl.adminSopExamSettings,
    buildSopList,
  );
  const target = list.sops.find((s) => s.sopCode.toUpperCase() === sopCode);
  if (!target) return { ok: false as const, error: 'No exam (MCQ bank) exists for this SOP' };
  if (!deptMatchesTrainerScope(target.department, trainerDepts)) {
    return { ok: false as const, error: 'SOP is outside your trainer departments' };
  }
  return { ok: true as const, exam: target };
}

/**
 * GET /api/lms/trainer/scheduled-exams?year=&month=&employeeId=
 * Live schedules in the trainer's departments, with derived completion status.
 */
export async function GET(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const params = req.nextUrl.searchParams;
  const year = Number(params.get('year')) || undefined;
  const month = Number(params.get('month')) || undefined;
  const employeeId = params.get('employeeId')?.trim() || undefined;

  try {
    await connectDB();
    const docs = await listScheduledExams({
      departments: auth.trainer.trainerDepartments,
      year,
      month,
      employeeIds: employeeId ? [employeeId] : undefined,
    });
    const progress = await loadExamProgressMap([...new Set(docs.map((d) => d.employeeId))]);
    const now = new Date();

    return NextResponse.json({
      exams: docs.map((d) =>
        buildScheduledExamView(d, progress.get(`${d.employeeId}::${stripVersion(d.sopCode)}`), now),
      ),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * POST /api/lms/trainer/scheduled-exams — schedule one exam for many employees.
 * Body: { employeeIds: string[], sopCode, scheduledDate: 'YYYY-MM-DD', notes? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const rawIds: unknown[] = Array.isArray(body.employeeIds) ? body.employeeIds : [];
  const employeeIds: string[] = [
    ...new Set(rawIds.map((id) => String(id ?? '').trim()).filter(Boolean)),
  ];
  const sopCode = stripVersion(String(body.sopCode || ''));
  const scheduledDate = parseDateOnly(String(body.scheduledDate || ''));
  const notes = String(body.notes || '').trim() || undefined;
  const sitting = Number(body.sitting) === 2 || Number(body.sitting) === 3
    ? (Number(body.sitting) as 2 | 3)
    : 1;
  const sitting1Date = parseDateOnly(String(body.sitting1Date || '')) || scheduledDate;
  // The trainer schedules *into a month*; the date is the deadline within it.
  // When the client sends both, the month/year drive where it lands so a
  // deliberate early/late deadline cannot silently move the assignment.
  const requestedMonth = Number(body.month) || 0;
  const requestedYear = Number(body.year) || 0;

  if (employeeIds.length === 0 || !sopCode || !scheduledDate) {
    return NextResponse.json(
      { error: 'employeeIds, sopCode and scheduledDate (YYYY-MM-DD) are required' },
      { status: 400 },
    );
  }
  if (requestedMonth && (requestedMonth < 1 || requestedMonth > 12)) {
    return NextResponse.json({ error: 'month must be 1–12' }, { status: 400 });
  }

  try {
    await connectDB();
    const resolved = await resolveExam(sopCode, auth.trainer.trainerDepartments);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 403 });

    const scoped = await listTrainerScopedEmployees(auth.trainer.trainerDepartments);
    // Scheduling requires a working LMS login — an employee who cannot sign in
    // could never take the exam, so this is rejected rather than silently saved.
    const check = checkEmployeeSelection(employeeIds, scoped, { requireLmsAccess: true });
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: check.status });
    }
    const employees = check.employees;

    const month = requestedMonth || monthOfDate(scheduledDate);
    const year = requestedYear || yearOfDate(scheduledDate);

    const result = await ScheduledExam.bulkWrite(
      employees.map((e) => {
        const dateField = sitting === 1 ? 'scheduledDate' : sitting === 2 ? 'scheduledDate2' : 'scheduledDate3';
        return {
          updateOne: {
            // Rescheduling within the same month updates the existing row so the
            // unique (employee, SOP, month, year) index is never violated and the
            // same employee can never appear twice for one exam in one month.
            filter: {
              employeeId: e.employeeId,
              sopCode,
              year,
              month,
              status: 'scheduled',
            },
            update: {
              $set: {
                trainerId: auth.trainer.employeeId,
                trainerName: auth.trainer.name,
                employeeId: e.employeeId,
                employeeName: e.name,
                department: e.department,
                designation: e.designation,
                sopCode,
                sopName: resolved.exam.sopName,
                [dateField]: scheduledDate,
                ...(sitting === 1 ? { scheduledDate, month, year } : {}),
                status: 'scheduled',
                notes,
              },
              ...(sitting === 1
                ? {}
                : {
                    $setOnInsert: {
                      scheduledDate: sitting1Date ?? scheduledDate,
                      month,
                      year,
                    },
                  }),
            },
            upsert: true,
          },
        };
      }),
    );

    bustTrainerScheduleCaches();

    return NextResponse.json({
      ok: true,
      scheduled: employees.length,
      created: result.upsertedCount ?? 0,
      updated: result.modifiedCount ?? 0,
      sopCode,
      sopName: resolved.exam.sopName,
      scheduledDate: toDateOnlyIso(scheduledDate),
      month,
      year,
      employees: employees.map((e) => ({ id: e.employeeId, name: e.name })),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * PATCH /api/lms/trainer/scheduled-exams — reschedule one exam sitting.
 * Body: { id, scheduledDate?: 'YYYY-MM-DD', sitting?: 1|2|3, notes? }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const id = String(body.id || '').trim();
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  try {
    await connectDB();
    const doc = await ScheduledExam.findById(id);
    if (!doc) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    if (!deptMatchesTrainerScope(doc.department, auth.trainer.trainerDepartments)) {
      return NextResponse.json(
        { error: 'Schedule is outside your trainer departments' },
        { status: 403 },
      );
    }

    if (body.scheduledDate !== undefined) {
      const next = parseDateOnly(String(body.scheduledDate || ''));
      if (!next) {
        return NextResponse.json({ error: 'scheduledDate must be YYYY-MM-DD' }, { status: 400 });
      }
      const sitting = Number(body.sitting) === 2 || Number(body.sitting) === 3
        ? (Number(body.sitting) as 2 | 3)
        : 1;
      if (sitting === 2) {
        doc.scheduledDate2 = next;
      } else if (sitting === 3) {
        doc.scheduledDate3 = next;
      } else {
        doc.scheduledDate = next;
        doc.month = monthOfDate(next);
        doc.year = yearOfDate(next);
      }
    }
    if (body.notes !== undefined) {
      doc.notes = String(body.notes || '').trim() || undefined;
    }
    await doc.save();

    bustTrainerScheduleCaches();
    return NextResponse.json({ ok: true, exam: serializeScheduledExam(doc) });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/lms/trainer/scheduled-exams?id=
 * Cancels the schedule (kept for audit) and removes it from the learner's LMS.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const id = req.nextUrl.searchParams.get('id')?.trim() || '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  try {
    await connectDB();
    const doc = await ScheduledExam.findById(id);
    if (!doc) return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    if (!deptMatchesTrainerScope(doc.department, auth.trainer.trainerDepartments)) {
      return NextResponse.json(
        { error: 'Schedule is outside your trainer departments' },
        { status: 403 },
      );
    }

    doc.status = 'cancelled';
    await doc.save();

    bustTrainerScheduleCaches();
    return NextResponse.json({ ok: true, cancelled: id });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
