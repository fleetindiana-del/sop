import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsTrainer } from '@/lib/lmsTrainerAuth';
import { bustTrainerScheduleCaches } from '@/lib/lmsTrainerCache';
import {
  checkEmployeeSelection,
  listTrainerScopedEmployees,
} from '@/lib/lmsTrainerEmployees';
import TrainerEmployee from '@/models/lms/TrainerEmployee';

export const dynamic = 'force-dynamic';

/**
 * GET /api/lms/trainer/roster
 * The trainer's curated employee list plus every employee they may add — drawn
 * from the same synced Employee roster the Employees page renders.
 */
export async function GET() {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  try {
    await connectDB();
    const depts = auth.trainer.trainerDepartments;
    const [employees, roster] = await Promise.all([
      listTrainerScopedEmployees(depts),
      TrainerEmployee.find({ trainerId: auth.trainer.employeeId })
        .sort({ employeeName: 1 })
        .lean<Array<{ _id: unknown; employeeId: string; createdAt?: Date }>>(),
    ]);

    const byId = new Map(employees.map((e) => [e.employeeId, e]));
    // Employees who left the trainer's departments (or were deactivated) stay
    // listed but are flagged, so the trainer can clean them up deliberately.
    const seen = new Set<string>();
    const rosterRows = roster
      .filter((r) => {
        if (seen.has(r.employeeId)) return false;
        seen.add(r.employeeId);
        return true;
      })
      .map((r) => {
        const emp = byId.get(r.employeeId);
        return {
          id: String(r._id),
          employeeId: r.employeeId,
          name: emp?.name || '(no longer in your departments)',
          designation: emp?.designation || '',
          department: emp?.department || '',
          employeeCode: emp?.employeeCode,
          isTrainer: Boolean(emp?.isTrainer),
          hasLmsAccess: Boolean(emp?.hasLmsAccess),
          lmsAccessIssue: emp?.lmsAccessIssue,
          inScope: Boolean(emp),
          addedAt: r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : undefined,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const rosterIds = new Set(roster.map((r) => r.employeeId));
    const available = employees.filter(
      (e) =>
        !rosterIds.has(e.employeeId) &&
        e.employeeId !== auth.trainer.employeeId &&
        !e.isTrainer,
    );

    return NextResponse.json({
      trainer: {
        id: auth.trainer.employeeId,
        name: auth.trainer.name,
        departments: depts,
      },
      roster: rosterRows,
      available,
      designations: [...new Set(employees.map((e) => e.designation).filter(Boolean))].sort(),
      counts: {
        scoped: employees.length,
        withLmsAccess: employees.filter((e) => e.hasLmsAccess).length,
        withoutLmsAccess: employees.filter((e) => !e.hasLmsAccess).length,
        onRoster: rosterRows.length,
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
 * POST /api/lms/trainer/roster — add employees to the trainer's roster.
 * Body: { employeeIds: string[] }
 */
export async function POST(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const rawIds: unknown[] = Array.isArray(body.employeeIds) ? body.employeeIds : [];
  const employeeIds: string[] = [
    ...new Set(rawIds.map((id) => String(id ?? '').trim()).filter(Boolean)),
  ];

  try {
    await connectDB();
    const scoped = await listTrainerScopedEmployees(auth.trainer.trainerDepartments);
    // A roster entry is an ownership record, not a login — LMS access is only
    // required at scheduling time, so it is surfaced but not enforced here.
    const check = checkEmployeeSelection(employeeIds, scoped);
    if (!check.ok) {
      return NextResponse.json({ error: check.error }, { status: check.status });
    }

    await TrainerEmployee.bulkWrite(
      check.employees.map((e) => ({
        updateOne: {
          filter: { trainerId: auth.trainer.employeeId, employeeId: e.employeeId },
          update: {
            $set: {
              employeeName: e.name,
              department: e.department,
              designation: e.designation,
              addedBy: auth.trainer.name,
            },
          },
          upsert: true,
        },
      })),
    );

    bustTrainerScheduleCaches();
    return NextResponse.json({
      ok: true,
      added: check.employees.length,
      withoutLmsAccess: check.employees.filter((e) => !e.hasLmsAccess).map((e) => e.name),
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

/** DELETE /api/lms/trainer/roster?employeeId= — remove one employee. */
export async function DELETE(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const employeeId = req.nextUrl.searchParams.get('employeeId')?.trim() || '';
  if (!employeeId) {
    return NextResponse.json({ error: 'employeeId is required' }, { status: 400 });
  }

  try {
    await connectDB();
    // Scoped by trainerId, so a trainer can only ever drop their own entry.
    const res = await TrainerEmployee.deleteMany({
      trainerId: auth.trainer.employeeId,
      employeeId,
    });
    bustTrainerScheduleCaches();
    return NextResponse.json({ ok: true, removed: res.deletedCount ?? 0 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
