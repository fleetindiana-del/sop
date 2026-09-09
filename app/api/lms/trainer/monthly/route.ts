import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { lmsCacheControl } from '@/lib/lmsCache';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import { listActiveTrainers, type TrainerDirectoryEntry } from '@/lib/lmsTrainerDirectory';
import TrainerEmployee from '@/models/lms/TrainerEmployee';
import {
  employeeAssignmentKey,
  listTrainerScopedEmployees,
  type TrainerScopedEmployee,
} from '@/lib/lmsTrainerEmployees';
import { getEmployeeAssignmentsMap, type EmployeeSopAssignment } from '@/lib/employeeAssignments';
import { applyReschedulesToList, listTrainingReschedules } from '@/lib/lmsTrainingReschedule';
import { filterIgnoredAssignments, listTrainingIgnores } from '@/lib/lmsTrainingIgnore';
import {
  classifyScheduleStatus,
  formatCycleStart,
  getTrainingCycleStart,
  type LmsScheduleStatus,
} from '@/lib/lmsTrainingCycle';
import {
  computeExamStatus,
  examCompletionDate,
  examScore,
  isExamCompleted,
  latestSittingIso,
  listScheduledExams,
  loadExamProgressMap,
  stripVersion,
  utcToday,
  type ExamCompletionStatus,
  type ExamProgress,
  type ScheduledExamLean,
} from '@/lib/lmsExamScheduling';
import { isInvalidSopAssignmentCode } from '@/lib/sop-name-resolution';
import { toDateOnlyIso } from '@/lib/trainingExamSchedule';
import { countUniqueSops, countUniqueSopsByMonth } from '@/lib/lmsTrainerExamCounts';
import { getJourneyContentBatch } from '@/lib/lmsJourneyContent';
import { compareSopCodes } from '@/lib/sop-utils';

export const dynamic = 'force-dynamic';

/** One employee × exam row for the month-wise trainer dashboard. */
export interface MonthlyExamRow {
  key: string;
  employeeId: string;
  employeeName: string;
  designation: string;
  department: string;
  sopCode: string;
  sopName: string;
  sopNameGujarati?: string;
  month: number;
  year: number;
  /** Deadline the employee must finish by, when one has been set. Sitting 1. */
  scheduledDate?: string;
  /** Makeup date after an absence on sitting 1. */
  scheduledDate2?: string;
  /** Makeup date after an absence on sitting 2. */
  scheduledDate3?: string;
  /** ISO date of the current SOP document expiry, if known. */
  expiryDate?: string;
  /**
   * When the trainer (or system) assigned this exam date — ScheduledExam.createdAt
   * when the row came from a trainer schedule.
   */
  assignedAt?: string;
  status: ExamCompletionStatus;
  /** Cycle-relative schedule state (due / upcoming / ignored / overdue). */
  scheduleStatus: LmsScheduleStatus;
  /**
   * Outside the active training cycle — the learner sees this under "Ignored",
   * so it is excluded from month counts unless explicitly requested.
   */
  isIgnored: boolean;
  completedDate?: string;
  score?: number;
  progressPct: number;
  daysOverdue: number;
  /** 'trainer' when a trainer scheduled it, otherwise from the training matrix. */
  source: 'trainer' | 'matrix';
  /** ScheduledExam id — present only for trainer-scheduled rows (reschedule/cancel). */
  scheduleId?: string;
  scheduledBy?: string;
  /** True when this employee is on the trainer's curated roster. */
  onRoster: boolean;
  /** False when the employee has no LMS login and cannot sit the exam. */
  hasLmsAccess: boolean;
}

const EMPTY_MONTH_COUNTS = () =>
  Array.from({ length: 12 }, () => ({
    total: 0,
    completed: 0,
    pending: 0,
    overdue: 0,
    /** Pre-cycle exams, counted separately so a month tile shows live work only. */
    ignored: 0,
  }));

/** Active department trainers — used by Super Admin / SOP Admin to filter the employee board. */
export type MonthlyTrainerSummary = TrainerDirectoryEntry;

interface ExamRowContext {
  now: Date;
  today: Date;
  cycle: ReturnType<typeof getTrainingCycleStart>;
  yearParam: number;
  includeIgnored: boolean;
  progressMap: Map<string, ExamProgress>;
  availableByCode: Map<string, string[]>;
  scheduleByKey: Map<string, ScheduledExamLean>;
  rosterIds: Set<string>;
}

/**
 * One employee × SOP row, live-derived from assignment + progress.
 *
 * Shared by the department roster loop and the trainer's-own-training loop
 * (a trainer's own required SOPs, per Super Admin / SOP Admin request) so
 * both agree on the exact same completion, scheduling and sitting rules.
 */
function buildExamRow(
  emp: Pick<TrainerScopedEmployee, 'employeeId' | 'name' | 'designation' | 'department' | 'hasLmsAccess'>,
  a: EmployeeSopAssignment & { rescheduledFrom?: { year: number; month: number } },
  ctx: ExamRowContext,
): MonthlyExamRow | null {
  const code = stripVersion(a.sopCode);
  const scheduled = ctx.scheduleByKey.get(`${emp.employeeId}::${code}`);

  if (ctx.yearParam && a.year !== ctx.yearParam) return null;

  const progress = ctx.progressMap.get(`${emp.employeeId}::${code}`);
  const completed = isExamCompleted(progress, ctx.availableByCode.get(a.sopCode));
  const scheduleStatus = classifyScheduleStatus(
    { year: a.year, month: a.month },
    { now: ctx.now, cycle: ctx.cycle, completed },
  );
  // Scheduled before the active cycle started: the learner lists this under
  // "Ignored", never as work to do.
  const isIgnored = !completed && scheduleStatus === 'ignored';
  if (isIgnored && !ctx.includeIgnored) return null;

  // Sitting 1 is only a trainer-assigned exam date. Matrix/calendar
  // placeholders (often the last day of the month) are not sittings.
  const sitting1 = scheduled
    ? toDateOnlyIso(new Date(scheduled.scheduledDate))
    : a.scheduledByTrainer
      ? a.examDate
      : undefined;
  const sitting2 = scheduled?.scheduledDate2
    ? toDateOnlyIso(new Date(scheduled.scheduledDate2))
    : undefined;
  const sitting3 = scheduled?.scheduledDate3
    ? toDateOnlyIso(new Date(scheduled.scheduledDate3))
    : undefined;
  const dueDate = latestSittingIso([sitting3, sitting2, sitting1]);

  let status: ExamCompletionStatus;
  let daysOverdue = 0;
  if (completed) {
    status = 'completed';
  } else if (dueDate) {
    status = computeExamStatus(dueDate, false, ctx.now);
    if (status === 'overdue') {
      daysOverdue = Math.max(
        0,
        Math.round((ctx.today.getTime() - new Date(dueDate).getTime()) / 86_400_000),
      );
    }
  } else {
    // No deadline set — fall back to the cycle month classification.
    status = scheduleStatus === 'missed' || scheduleStatus === 'overdue'
      ? 'overdue'
      : 'pending';
  }

  return {
    key: `${emp.employeeId}:${code}:${a.year}:${a.month}`,
    employeeId: emp.employeeId,
    employeeName: emp.name,
    designation: emp.designation || '',
    department: emp.department,
    sopCode: code,
    sopName: a.sopName || code,
    sopNameGujarati: a.sopNameGujarati,
    month: a.month,
    year: a.year,
    scheduledDate: sitting1,
    scheduledDate2: sitting2,
    scheduledDate3: sitting3,
    expiryDate: a.expiryDate,
    assignedAt: scheduled?.createdAt
      ? toDateOnlyIso(new Date(scheduled.createdAt))
      : undefined,
    status,
    scheduleStatus: scheduleStatus === 'missed' ? 'overdue' : scheduleStatus,
    isIgnored,
    completedDate: completed ? examCompletionDate(progress) : undefined,
    score: completed ? examScore(progress) : undefined,
    progressPct: completed
      ? 100
      : Math.max(0, Math.min(100, progress?.overallPercentage ?? 0)),
    daysOverdue,
    source: a.scheduledByTrainer || scheduled ? 'trainer' : 'matrix',
    scheduleId: scheduled ? String(scheduled._id) : undefined,
    scheduledBy: a.scheduledBy || scheduled?.trainerName,
    onRoster: ctx.rosterIds.has(emp.employeeId),
    hasLmsAccess: emp.hasLmsAccess,
  };
}

/**
 * GET /api/lms/trainer/monthly?year=&department=
 *
 * Month-wise, employee-wise exam board: every exam assigned to an employee in
 * the trainer's departments — from the training matrix and from the trainer's
 * own scheduler — with completion derived live from learner progress.
 */
export async function GET(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const { trainer } = auth;
  const params = req.nextUrl.searchParams;
  const deptParam = params.get('department')?.trim() || '';
  // Default to the current year: mixing years piles every year's schedule into
  // the same twelve month buckets and inflates every count.
  const yearParam = params.get('year') === 'all'
    ? 0
    : Number(params.get('year')) || new Date().getFullYear();
  const includeIgnored = params.get('includeIgnored') === '1';

  try {
    const body = await (async () => {
        await connectDB();
        const now = new Date();
        const cycle = getTrainingCycleStart(now);
        const today = utcToday(now);

        const scopedDepts = trainer.trainerDepartments.filter(
          (d) => !deptParam || d.toLowerCase() === deptParam.toLowerCase(),
        );
        const adminTrainers = trainer.allDepartments ? await listActiveTrainers() : [];

        const base = {
          trainer: {
            id: trainer.employeeId,
            name: trainer.name,
            department: trainer.department,
            trainerDepartments: trainer.trainerDepartments,
            allDepartments: trainer.allDepartments === true,
          },
          trainers: adminTrainers,
          trainingCycleStart: formatCycleStart(cycle),
          year: yearParam || now.getFullYear(),
          /** The month the trainer should land on — "what is due right now". */
          currentMonth: now.getMonth() + 1,
          currentYear: now.getFullYear(),
          includeIgnored,
        };

        if (scopedDepts.length === 0) {
          return {
            ...base,
            rows: [] as MonthlyExamRow[],
            trainerOwnRows: [] as MonthlyExamRow[],
            monthCounts: EMPTY_MONTH_COUNTS(),
            totals: {
              total: 0, completed: 0, pending: 0, overdue: 0, ignored: 0, scheduled: 0,
            },
            filters: { departments: [], designations: [], exams: [], years: [] },
          };
        }

        // Data-fetch scope: the filtered departments plus each Super Admin / SOP
        // Admin trainer's own home department, so a trainer's own required SOPs
        // are still found when the board is filtered to a department that isn't
        // their home one. `scopedEmployees` below still limits the displayed
        // roster to `scopedDepts` — this only widens what is available to look up.
        const fetchDepts = [...new Set([
          ...scopedDepts,
          ...adminTrainers.map((t) => t.department).filter(Boolean),
        ])];

        // Same synced, deduplicated roster the Employees page and the scheduler use.
        const employees = await listTrainerScopedEmployees(fetchDepts);
        const employeeIds = employees.map((e) => e.employeeId);
        const [assignmentsMap, rescheduleRules, ignoreRules, progressMap, roster, schedules] =
          await Promise.all([
            getEmployeeAssignmentsMap({ departments: fetchDepts }),
            listTrainingReschedules(),
            // Same admin ignore rules the learner's own LMS applies.
            listTrainingIgnores(),
            loadExamProgressMap(employeeIds),
            TrainerEmployee.find({ trainerId: trainer.employeeId })
              .select('employeeId')
              .lean<Array<{ employeeId: string }>>(),
            listScheduledExams({ departments: fetchDepts }),
          ]);

        const rosterIds = new Set(roster.map((r) => r.employeeId));
        // employeeId::SOPBASE → ScheduledExam, so rows can carry an action id.
        const scheduleByKey = new Map(
          schedules.map((s) => [`${s.employeeId}::${stripVersion(s.sopCode)}`, s]),
        );

        const rows: MonthlyExamRow[] = [];
        const yearSet = new Set<number>();

        // Resolved once up front so the SOP-code set below (for the
        // completion check) and the row-building loop agree on the exact
        // same assignments.
        const scopedEmployees = employees.filter(
          (emp) => !emp.isTrainer && deptMatchesTrainerScope(emp.department, scopedDepts),
        );
        const assignmentsByEmployee = new Map<
          string,
          Array<EmployeeSopAssignment & { rescheduledFrom?: { year: number; month: number } }>
        >();
        const allSopCodes = new Set<string>();
        for (const emp of scopedEmployees) {
          const raw = assignmentsMap.get(employeeAssignmentKey(emp.department, emp.name)) || [];
          const notIgnored = filterIgnoredAssignments(raw, ignoreRules, emp.department);
          const assignments = applyReschedulesToList(notIgnored, rescheduleRules, {
            employeeId: emp.employeeId,
            employeeDepartment: emp.department,
          });
          assignmentsByEmployee.set(emp.employeeId, assignments);
          for (const a of assignments) allSopCodes.add(a.sopCode);
        }

        // Available steps per SOP, so completion agrees with the learner's own
        // LMS (lib/lmsCompletion.ts) instead of only recognizing quiz-bearing SOPs.
        const contentByCode = await getJourneyContentBatch(allSopCodes);
        const availableByCode = new Map<string, string[]>(
          [...contentByCode.entries()].map(([code, content]) => [code, content.availableStepIds]),
        );

        const rowCtx: ExamRowContext = {
          now, today, cycle, yearParam, includeIgnored, progressMap, availableByCode, scheduleByKey, rosterIds,
        };

        for (const emp of scopedEmployees) {
          // Every SOP assigned to that employee — including company-wide QA
          // documents Store/Production staff still sit. Scope is the person,
          // not the SOP's owning department (that filter emptied this board).
          const assignments = assignmentsByEmployee.get(emp.employeeId) || [];

          for (const a of assignments) {
            if (isInvalidSopAssignmentCode(a.sopCode)) continue;
            yearSet.add(a.year);
            const row = buildExamRow(emp, a, rowCtx);
            if (row) rows.push(row);
          }
        }

        // Each Super Admin / SOP Admin trainer's own required SOPs — trainers
        // are excluded from the department roster above (they are not trained
        // by themselves), so without this a trainer's own training/exam status
        // has nowhere to show on this board at all.
        const trainerOwnRows: MonthlyExamRow[] = [];
        if (adminTrainers.length > 0) {
          const employeesById = new Map(employees.map((e) => [e.employeeId, e]));
          const trainerAssignments = new Map<
            string,
            Array<EmployeeSopAssignment & { rescheduledFrom?: { year: number; month: number } }>
          >();
          const trainerSopCodes = new Set<string>();
          for (const t of adminTrainers) {
            const emp = employeesById.get(t.id);
            if (!emp) continue;
            const raw = assignmentsMap.get(employeeAssignmentKey(emp.department, emp.name)) || [];
            const notIgnored = filterIgnoredAssignments(raw, ignoreRules, emp.department);
            const assignments = applyReschedulesToList(notIgnored, rescheduleRules, {
              employeeId: emp.employeeId,
              employeeDepartment: emp.department,
            });
            trainerAssignments.set(t.id, assignments);
            for (const a of assignments) trainerSopCodes.add(a.sopCode);
          }

          const trainerContentByCode = await getJourneyContentBatch(trainerSopCodes);
          const trainerAvailableByCode = new Map<string, string[]>(
            [...trainerContentByCode.entries()].map(([code, content]) => [code, content.availableStepIds]),
          );
          const trainerRowCtx: ExamRowContext = { ...rowCtx, availableByCode: trainerAvailableByCode };

          for (const t of adminTrainers) {
            const emp = employeesById.get(t.id);
            if (!emp) continue;
            for (const a of trainerAssignments.get(t.id) || []) {
              if (isInvalidSopAssignmentCode(a.sopCode)) continue;
              yearSet.add(a.year);
              const row = buildExamRow(emp, a, trainerRowCtx);
              if (row) trainerOwnRows.push(row);
            }
          }
        }

        rows.sort((a, b) => {
          if (a.year !== b.year) return a.year - b.year;
          if (a.month !== b.month) return a.month - b.month;
          if (a.employeeName !== b.employeeName) {
            return a.employeeName.localeCompare(b.employeeName);
          }
          return compareSopCodes(a.sopCode, b.sopCode);
        });

        // Month tiles are SOP-wise: 4 August exams × 20 employees = 4, not 80.
        const uniqueByMonth = countUniqueSopsByMonth(rows);
        const uniqueYear = countUniqueSops(rows);
        const monthCounts = EMPTY_MONTH_COUNTS();
        for (let i = 0; i < 12; i++) {
          const u = uniqueByMonth[i];
          monthCounts[i] = {
            total: u.total,
            completed: u.completed,
            pending: u.remaining,
            overdue: u.overdue,
            ignored: u.ignored,
          };
        }
        let scheduled = 0;
        for (const r of rows) {
          if (!r.isIgnored && r.source === 'trainer') scheduled++;
        }
        const totals = {
          total: uniqueYear.total,
          completed: uniqueYear.completed,
          pending: uniqueYear.remaining,
          overdue: uniqueYear.overdue,
          ignored: uniqueYear.ignored,
          scheduled,
        };

        const examMap = new Map<string, string>();
        for (const r of rows) examMap.set(r.sopCode, r.sopName);

        return {
          ...base,
          rows,
          trainerOwnRows,
          monthCounts,
          totals,
          filters: {
            departments: scopedDepts,
            designations: [
              ...new Set(rows.map((r) => r.designation).filter(Boolean)),
            ].sort(),
            exams: [...examMap.entries()]
              .map(([sopCode, sopName]) => ({ sopCode, sopName }))
              .sort((a, b) => compareSopCodes(a.sopCode, b.sopCode)),
            years: [...yearSet].sort((a, b) => b - a),
          },
          generatedAt: toDateOnlyIso(today),
        };
    })();

    return NextResponse.json(body, { headers: lmsCacheControl(0) });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
