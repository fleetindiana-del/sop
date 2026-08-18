import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import {
  getOrBuildLmsCache,
  lmsCacheControl,
  lmsServerTtl,
} from '@/lib/lmsCache';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import TrainerEmployee from '@/models/lms/TrainerEmployee';
import {
  employeeAssignmentKey,
  listTrainerScopedEmployees,
} from '@/lib/lmsTrainerEmployees';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { getJourneyContentBatch } from '@/lib/lmsJourneyContent';
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
} from '@/lib/lmsExamScheduling';
import { isInvalidSopAssignmentCode } from '@/lib/sop-name-resolution';
import { toDateOnlyIso } from '@/lib/trainingExamSchedule';
import { countUniqueSops, countUniqueSopsByMonth } from '@/lib/lmsTrainerExamCounts';

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
    const body = await getOrBuildLmsCache(
          `lms:trainer:monthly:v8:${trainer.employeeId}:${deptParam || 'all'}:${yearParam || 'all'}:${includeIgnored ? 'inc' : 'exc'}`,
      lmsServerTtl.adminEmployeeTraining,
      async () => {
        await connectDB();
        const now = new Date();
        const cycle = getTrainingCycleStart(now);
        const today = utcToday(now);

        const scopedDepts = trainer.trainerDepartments.filter(
          (d) => !deptParam || d.toLowerCase() === deptParam.toLowerCase(),
        );

        const base = {
          trainer: {
            id: trainer.employeeId,
            name: trainer.name,
            department: trainer.department,
            trainerDepartments: trainer.trainerDepartments,
          },
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
            monthCounts: EMPTY_MONTH_COUNTS(),
            totals: {
              total: 0, completed: 0, pending: 0, overdue: 0, ignored: 0, scheduled: 0,
            },
            filters: { departments: [], designations: [], exams: [], years: [] },
          };
        }

        // Same synced, deduplicated roster the Employees page and the scheduler use.
        const employees = await listTrainerScopedEmployees(scopedDepts);
        const employeeIds = employees.map((e) => e.employeeId);
        const [assignmentsMap, rescheduleRules, ignoreRules, progressMap, roster, schedules] =
          await Promise.all([
            getEmployeeAssignmentsMap(),
            listTrainingReschedules(),
            // Same admin ignore rules the learner's own LMS applies.
            listTrainingIgnores(),
            loadExamProgressMap(employeeIds),
            TrainerEmployee.find({ trainerId: trainer.employeeId })
              .select('employeeId')
              .lean<Array<{ employeeId: string }>>(),
            listScheduledExams({ departments: scopedDepts }),
          ]);

        const rosterIds = new Set(roster.map((r) => r.employeeId));
        // employeeId::SOPBASE → ScheduledExam, so rows can carry an action id.
        const scheduleByKey = new Map(
          schedules.map((s) => [`${s.employeeId}::${stripVersion(s.sopCode)}`, s]),
        );

        // Which SOPs actually have an exam (an MCQ bank in either language).
        const uniqueCodes = new Set<string>();
        for (const emp of employees) {
          for (const a of assignmentsMap.get(employeeAssignmentKey(emp.department, emp.name)) || []) {
            uniqueCodes.add(a.sopCode);
          }
        }
        const contentByCode = await getJourneyContentBatch(uniqueCodes);
        const hasExamByCode = new Map(
          [...contentByCode.entries()].map(([code, c]) => [
            code,
            c.availableStepIds.includes('quiz') || c.availableStepIds.includes('quizGu'),
          ]),
        );

        const rows: MonthlyExamRow[] = [];
        const yearSet = new Set<number>();

        for (const emp of employees) {
          if (emp.isTrainer) continue; // trainers are not learners on this board
          const employeeId = emp.employeeId;
          const raw = assignmentsMap.get(employeeAssignmentKey(emp.department, emp.name)) || [];
          // Mirror /api/lms/auth/me exactly: drop admin-ignored assignments
          // first, then apply reschedules. Any other order reports months the
          // employee never sees in their own LMS.
          const notIgnored = filterIgnoredAssignments(raw, ignoreRules, emp.department);
          const assignments = applyReschedulesToList(notIgnored, rescheduleRules, {
            employeeId,
            employeeDepartment: emp.department,
          }).filter((a) =>
            // Only SOPs that belong to the trainer's departments — not every SOP
            // an in-scope employee happens to carry from another department.
            deptMatchesTrainerScope(a.sopDepartment || emp.department, scopedDepts),
          );

          for (const a of assignments) {
            if (isInvalidSopAssignmentCode(a.sopCode)) continue;
            const code = stripVersion(a.sopCode);
            const scheduled = scheduleByKey.get(`${employeeId}::${code}`);
            // Only rows that represent an actual exam: the SOP has an MCQ bank,
            // or a trainer explicitly scheduled it.
            if (!hasExamByCode.get(a.sopCode) && !scheduled) continue;

            yearSet.add(a.year);
            if (yearParam && a.year !== yearParam) continue;

            const progress = progressMap.get(`${employeeId}::${code}`);
            const completed = isExamCompleted(progress);
            const scheduleStatus = classifyScheduleStatus(
              { year: a.year, month: a.month },
              { now, cycle, completed },
            );
            // Scheduled before the active cycle started: the learner lists this
            // under "Ignored", never as work to do.
            const isIgnored = !completed && scheduleStatus === 'ignored';
            if (isIgnored && !includeIgnored) continue;

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
              status = computeExamStatus(dueDate, false, now);
              if (status === 'overdue') {
                daysOverdue = Math.max(
                  0,
                  Math.round((today.getTime() - new Date(dueDate).getTime()) / 86_400_000),
                );
              }
            } else {
              // No deadline set — fall back to the cycle month classification.
              status = scheduleStatus === 'missed' || scheduleStatus === 'overdue'
                ? 'overdue'
                : 'pending';
            }

            rows.push({
              key: `${employeeId}:${code}:${a.year}:${a.month}`,
              employeeId,
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
              onRoster: rosterIds.has(employeeId),
              hasLmsAccess: emp.hasLmsAccess,
            });
          }
        }

        rows.sort((a, b) => {
          if (a.year !== b.year) return a.year - b.year;
          if (a.month !== b.month) return a.month - b.month;
          if (a.employeeName !== b.employeeName) {
            return a.employeeName.localeCompare(b.employeeName);
          }
          return a.sopCode.localeCompare(b.sopCode);
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
          monthCounts,
          totals,
          filters: {
            departments: scopedDepts,
            designations: [
              ...new Set(rows.map((r) => r.designation).filter(Boolean)),
            ].sort(),
            exams: [...examMap.entries()]
              .map(([sopCode, sopName]) => ({ sopCode, sopName }))
              .sort((a, b) => a.sopCode.localeCompare(b.sopCode)),
            years: [...yearSet].sort((a, b) => b - a),
          },
          generatedAt: toDateOnlyIso(today),
        };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(30) });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
