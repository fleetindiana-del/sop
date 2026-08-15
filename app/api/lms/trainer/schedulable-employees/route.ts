import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsTrainer } from '@/lib/lmsTrainerAuth';
import {
  listTrainerScopedEmployees,
  employeeAssignmentKey,
} from '@/lib/lmsTrainerEmployees';
import TrainerEmployee from '@/models/lms/TrainerEmployee';
import ScheduledExam from '@/models/lms/ScheduledExam';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import {
  isExamCompleted,
  loadExamProgressMap,
  stripVersion,
} from '@/lib/lmsExamScheduling';
import { sopFamilyCodesMatch } from '@/lib/sopIdentifierNormalize';
import { toDateOnlyIso } from '@/lib/trainingExamSchedule';

export const dynamic = 'force-dynamic';

export interface SchedulableEmployee {
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  employeeCode?: string;
  isTrainer: boolean;
  hasLmsAccess: boolean;
  lmsAccessIssue?: string;
  /** On the trainer's curated "My employees" list. */
  onRoster: boolean;
  /** This SOP is already on the employee's training matrix. */
  inTrainingMatrix: boolean;
  /** Already scheduled for this SOP in the requested month. */
  alreadyScheduled: boolean;
  /** Deadline of that existing schedule, when present. */
  scheduledDate?: string;
  /** Already passed this SOP's exam — rescheduling is usually unnecessary. */
  completed: boolean;
}

/**
 * GET /api/lms/trainer/schedulable-employees?sopCode=&month=&year=
 *
 * Every active employee in the trainer's departments, annotated with everything
 * the scheduler needs to make an accurate selection: LMS access, roster
 * membership, whether the SOP is already on their matrix, whether they are
 * already scheduled for the chosen month, and whether they already passed it.
 */
export async function GET(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const params = req.nextUrl.searchParams;
  const sopCode = stripVersion(params.get('sopCode') || '');
  const month = Number(params.get('month')) || 0;
  const year = Number(params.get('year')) || 0;
  const deptParam = params.get('department')?.trim() || '';

  try {
    await connectDB();
    const scopedDepts = auth.trainer.trainerDepartments.filter(
      (d) => !deptParam || d.toLowerCase() === deptParam.toLowerCase(),
    );
    // A department filter outside the trainer's scope is a client bug, not an
    // empty result — say so rather than silently returning nobody.
    if (deptParam && scopedDepts.length === 0) {
      return NextResponse.json(
        { error: `${deptParam} is not one of your trainer departments` },
        { status: 403 },
      );
    }
    const employees = await listTrainerScopedEmployees(scopedDepts);

    const [roster, schedules, assignmentsMap, progressMap] = await Promise.all([
      TrainerEmployee.find({ trainerId: auth.trainer.employeeId })
        .select('employeeId')
        .lean<Array<{ employeeId: string }>>(),
      sopCode
        ? ScheduledExam.find({
            status: 'scheduled',
            sopCode,
            ...(month ? { month } : {}),
            ...(year ? { year } : {}),
          })
            .select('employeeId scheduledDate')
            .lean<Array<{ employeeId: string; scheduledDate: Date }>>()
        : Promise.resolve([]),
      sopCode ? getEmployeeAssignmentsMap() : Promise.resolve(null),
      sopCode
        ? loadExamProgressMap(employees.map((e) => e.employeeId))
        : Promise.resolve(new Map()),
    ]);

    const rosterIds = new Set(roster.map((r) => r.employeeId));
    const scheduledByEmployee = new Map(
      schedules.map((s) => [s.employeeId, toDateOnlyIso(new Date(s.scheduledDate))]),
    );

    const rows: SchedulableEmployee[] = employees
      // Trainers are managers on this screen, not exam takers.
      .filter((e) => !e.isTrainer && e.employeeId !== auth.trainer.employeeId)
      .map((e) => {
        const matrix = assignmentsMap?.get(employeeAssignmentKey(e.department, e.name)) ?? [];
        const inTrainingMatrix = sopCode
          ? matrix.some((a) => sopFamilyCodesMatch(a.sopCode, sopCode))
          : false;
        const scheduledDate = scheduledByEmployee.get(e.employeeId);
        return {
          employeeId: e.employeeId,
          name: e.name,
          designation: e.designation,
          department: e.department,
          employeeCode: e.employeeCode,
          isTrainer: e.isTrainer,
          hasLmsAccess: e.hasLmsAccess,
          lmsAccessIssue: e.lmsAccessIssue,
          onRoster: rosterIds.has(e.employeeId),
          inTrainingMatrix,
          alreadyScheduled: Boolean(scheduledDate),
          scheduledDate,
          completed: sopCode
            ? isExamCompleted(progressMap.get(`${e.employeeId}::${sopCode}`))
            : false,
        };
      });

    return NextResponse.json({
      sopCode: sopCode || undefined,
      month: month || undefined,
      year: year || undefined,
      departments: scopedDepts,
      designations: [...new Set(rows.map((r) => r.designation).filter(Boolean))].sort(),
      employees: rows,
      counts: {
        total: rows.length,
        withLmsAccess: rows.filter((r) => r.hasLmsAccess).length,
        withoutLmsAccess: rows.filter((r) => !r.hasLmsAccess).length,
        onRoster: rows.filter((r) => r.onRoster).length,
      },
      // Echoed so the client can show which departments were in play.
      trainerDepartments: auth.trainer.trainerDepartments,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
