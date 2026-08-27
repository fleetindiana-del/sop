/**
 * Admin-only trainer overview: Trainer → Department → Employees → Training /
 * Exam status → month-by-month completion.
 *
 * The completion rules are deliberately the same ones the Trainer View uses
 * (`/api/lms/trainer/monthly`), so an administrator and a department trainer
 * never see different numbers for the same people:
 *
 * 1. Assignments come from `getEmployeeAssignmentsMap` (training matrix +
 *    induction + trainer-scheduled exams).
 * 2. Admin ignore rules are applied first, then reschedules — the same order
 *    the learner's own LMS applies.
 * 3. Completion is derived live from `LearningProgress`, never stored.
 * 4. Pre-cycle assignments are "ignored": the learner sees them under Ignored,
 *    so they are excluded from live counts unless `includeIgnored` is set.
 *
 * Trainers themselves are not listed as learners on a department roster (they
 * are not trained by themselves); a trainer's own training is reported in the
 * trainer node's `own` block.
 */

import { connectDB } from '@/lib/mongodb';
import { getDashboardDepartments } from '@/lib/dashboardDepartments';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { listActiveTrainers, type TrainerDirectoryEntry } from '@/lib/lmsTrainerDirectory';
import {
  employeeAssignmentKey,
  listTrainerScopedEmployees,
  type TrainerScopedEmployee,
} from '@/lib/lmsTrainerEmployees';
import { deptMatchesTrainerScope } from '@/lib/lmsTrainerScope';
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
import { countUniqueSops, countUniqueSopsByMonth } from '@/lib/lmsTrainerExamCounts';
import { isInvalidSopAssignmentCode } from '@/lib/sop-name-resolution';
import { toDateOnlyIso } from '@/lib/trainingExamSchedule';

/** Live exam counts (ignored sittings tracked separately). */
export interface ExamTotals {
  total: number;
  completed: number;
  pending: number;
  overdue: number;
  ignored: number;
}

export interface MonthBucket extends ExamTotals {
  month: number;
}

/** One employee × SOP sitting. */
export interface OverviewExamRow {
  key: string;
  sopCode: string;
  sopName: string;
  sopNameGujarati?: string;
  month: number;
  year: number;
  status: ExamCompletionStatus;
  scheduleStatus: LmsScheduleStatus;
  /** Scheduled before the active training cycle — shown as Ignored, not counted. */
  isIgnored: boolean;
  examDate?: string;
  completedDate?: string;
  score?: number;
  progressPct: number;
  daysOverdue: number;
}

export interface OverviewEmployee {
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  employeeCode?: string;
  isTrainer: boolean;
  hasLmsAccess: boolean;
  totals: ExamTotals;
  completionPct: number;
  /** Every live exam completed (and at least one assigned). */
  fullyCompleted: boolean;
  lastCompletedDate?: string;
  monthly: MonthBucket[];
  exams: OverviewExamRow[];
}

export interface OverviewDepartment {
  department: string;
  /** Trainers responsible for this department, by name. */
  trainers: string[];
  employeeCount: number;
  employeesCompleted: number;
  employeesPending: number;
  totals: ExamTotals;
  completionPct: number;
  /** SOP-wise exam counts — one SOP sat by 20 people is 1 exam, not 20. */
  examSops: { total: number; completed: number; remaining: number };
  monthly: MonthBucket[];
  /** Unique SOP exams per month (same rule as Trainer View month tiles). */
  monthlySops: MonthBucket[];
  employees: OverviewEmployee[];
}

export interface OverviewTrainer {
  trainerId: string;
  name: string;
  /** The trainer's own home department. */
  homeDepartment: string;
  trainerDepartments: string[];
  employeeCount: number;
  employeesCompleted: number;
  employeesPending: number;
  totals: ExamTotals;
  completionPct: number;
  /** The trainer's own training / exams, as a learner. */
  own: {
    totals: ExamTotals;
    completionPct: number;
    hasRecord: boolean;
  };
  monthly: MonthBucket[];
  monthlySops: MonthBucket[];
  departments: OverviewDepartment[];
}

export interface TrainerOverviewPayload {
  generatedAt: string;
  year: number;
  years: number[];
  trainingCycleStart: string;
  includeIgnored: boolean;
  totals: {
    trainers: number;
    departments: number;
    /** Departments with at least one responsible trainer. */
    departmentsCovered: number;
    employees: number;
    employeesCompleted: number;
    employeesPending: number;
    exams: ExamTotals;
    completionPct: number;
  };
  monthly: MonthBucket[];
  monthlySops: MonthBucket[];
  trainers: OverviewTrainer[];
  /** Department-wise exam data for every department, trainer or not. */
  departments: OverviewDepartment[];
  departmentsWithoutTrainer: string[];
}

function emptyTotals(): ExamTotals {
  return { total: 0, completed: 0, pending: 0, overdue: 0, ignored: 0 };
}

function emptyMonthly(): MonthBucket[] {
  return Array.from({ length: 12 }, (_, i) => ({ month: i + 1, ...emptyTotals() }));
}

function addRow(totals: ExamTotals, row: OverviewExamRow): void {
  if (row.isIgnored) {
    totals.ignored++;
    return;
  }
  totals.total++;
  if (row.status === 'completed') totals.completed++;
  else if (row.status === 'overdue') totals.overdue++;
  else totals.pending++;
}

function mergeTotals(target: ExamTotals, source: ExamTotals): void {
  target.total += source.total;
  target.completed += source.completed;
  target.pending += source.pending;
  target.overdue += source.overdue;
  target.ignored += source.ignored;
}

function mergeMonthly(target: MonthBucket[], source: MonthBucket[]): void {
  for (let i = 0; i < 12; i++) mergeTotals(target[i], source[i]);
}

function pct(totals: ExamTotals): number {
  return totals.total > 0 ? Math.round((totals.completed / totals.total) * 100) : 0;
}

function monthlySopsFrom(exams: OverviewExamRow[]): MonthBucket[] {
  return countUniqueSopsByMonth(exams).map((b, i) => ({
    month: i + 1,
    total: b.total,
    completed: b.completed,
    pending: b.pending,
    overdue: b.overdue,
    ignored: b.ignored,
  }));
}

/** Build one employee's exam rows plus their roll-up. */
function buildEmployee(
  emp: TrainerScopedEmployee,
  rows: OverviewExamRow[],
): OverviewEmployee {
  const totals = emptyTotals();
  const monthly = emptyMonthly();
  let lastCompletedDate: string | undefined;

  for (const row of rows) {
    addRow(totals, row);
    if (row.month >= 1 && row.month <= 12) addRow(monthly[row.month - 1], row);
    if (row.completedDate && (!lastCompletedDate || row.completedDate > lastCompletedDate)) {
      lastCompletedDate = row.completedDate;
    }
  }

  return {
    employeeId: emp.employeeId,
    name: emp.name,
    designation: emp.designation,
    department: emp.department,
    employeeCode: emp.employeeCode,
    isTrainer: emp.isTrainer,
    hasLmsAccess: emp.hasLmsAccess,
    totals,
    completionPct: pct(totals),
    fullyCompleted: totals.total > 0 && totals.completed === totals.total,
    lastCompletedDate,
    monthly,
    exams: rows,
  };
}

function buildDepartment(
  department: string,
  employees: OverviewEmployee[],
  trainers: string[],
): OverviewDepartment {
  const totals = emptyTotals();
  const monthly = emptyMonthly();
  let employeesCompleted = 0;
  let employeesPending = 0;

  for (const emp of employees) {
    mergeTotals(totals, emp.totals);
    mergeMonthly(monthly, emp.monthly);
    if (emp.totals.total === 0) continue;
    if (emp.fullyCompleted) employeesCompleted++;
    else employeesPending++;
  }

  const sittings = employees.flatMap((e) => e.exams);
  const uniqueSops = countUniqueSops(sittings);

  return {
    department,
    trainers,
    employeeCount: employees.length,
    employeesCompleted,
    employeesPending,
    totals,
    completionPct: pct(totals),
    examSops: {
      total: uniqueSops.total,
      completed: uniqueSops.completed,
      remaining: uniqueSops.remaining,
    },
    monthly,
    monthlySops: monthlySopsFrom(sittings),
    employees,
  };
}

/** Month-wise, SOP-wise exam counts for a department (same rule as month tiles). */
export function departmentMonthlySopCounts(dept: OverviewDepartment): ExamTotals[] {
  return countUniqueSopsByMonth(dept.employees.flatMap((e) => e.exams)).map((b) => ({
    total: b.total,
    completed: b.completed,
    pending: b.pending,
    overdue: b.overdue,
    ignored: b.ignored,
  }));
}

export interface TrainerOverviewOptions {
  /** Calendar year to report on; 0 → every year. Defaults to the current year. */
  year?: number;
  /** Include pre-cycle (ignored) sittings in the rows. They never count as live. */
  includeIgnored?: boolean;
}

export async function buildTrainerOverview(
  opts: TrainerOverviewOptions = {},
): Promise<TrainerOverviewPayload> {
  await connectDB();

  const now = new Date();
  const cycle = getTrainingCycleStart(now);
  const today = utcToday(now);
  const yearFilter = opts.year === 0 ? 0 : (opts.year || now.getFullYear());
  const includeIgnored = opts.includeIgnored === true;

  const [departments, trainers] = await Promise.all([
    getDashboardDepartments(),
    listActiveTrainers(),
  ]);

  // Departments an employee may belong to: every dashboard department plus any
  // department a trainer covers that the dashboard list does not know about.
  const scopeDepts = [...new Set([
    ...departments,
    ...trainers.flatMap((t) => t.trainerDepartments),
  ].map((d) => String(d || '').trim()).filter(Boolean))];

  const employees = await listTrainerScopedEmployees(scopeDepts);
  const employeeIds = employees.map((e) => e.employeeId);

  const [assignmentsMap, rescheduleRules, ignoreRules, progressMap, schedules] =
    await Promise.all([
      getEmployeeAssignmentsMap({ departments: scopeDepts }),
      listTrainingReschedules(),
      listTrainingIgnores(),
      loadExamProgressMap(employeeIds),
      listScheduledExams({ departments: scopeDepts }),
    ]);

  const scheduleByKey = new Map(
    schedules.map((s) => [`${s.employeeId}::${stripVersion(s.sopCode)}`, s]),
  );

  const yearSet = new Set<number>();
  const built: OverviewEmployee[] = [];

  for (const emp of employees) {
    const raw = assignmentsMap.get(employeeAssignmentKey(emp.department, emp.name)) || [];
    // Ignore rules first, then reschedules — the order /api/lms/auth/me uses.
    const notIgnored = filterIgnoredAssignments(raw, ignoreRules, emp.department);
    const assignments = applyReschedulesToList(notIgnored, rescheduleRules, {
      employeeId: emp.employeeId,
      employeeDepartment: emp.department,
    });

    const rows: OverviewExamRow[] = [];
    for (const a of assignments) {
      if (isInvalidSopAssignmentCode(a.sopCode)) continue;
      const code = stripVersion(a.sopCode);

      yearSet.add(a.year);
      if (yearFilter && a.year !== yearFilter) continue;

      const progress = progressMap.get(`${emp.employeeId}::${code}`);
      const completed = isExamCompleted(progress);
      const scheduleStatus = classifyScheduleStatus(
        { year: a.year, month: a.month },
        { now, cycle, completed },
      );
      const isIgnored = !completed && scheduleStatus === 'ignored';
      if (isIgnored && !includeIgnored) continue;

      const scheduled = scheduleByKey.get(`${emp.employeeId}::${code}`);
      // Sitting 1 is a trainer-assigned date only; matrix calendar placeholders
      // are not sittings.
      const sitting1 = scheduled
        ? toDateOnlyIso(new Date(scheduled.scheduledDate))
        : a.scheduledByTrainer
          ? a.examDate
          : undefined;
      const dueDate = latestSittingIso([
        scheduled?.scheduledDate3,
        scheduled?.scheduledDate2,
        sitting1,
      ]);

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
        status = scheduleStatus === 'missed' || scheduleStatus === 'overdue'
          ? 'overdue'
          : 'pending';
      }

      rows.push({
        key: `${emp.employeeId}:${code}:${a.year}:${a.month}`,
        sopCode: code,
        sopName: a.sopName || code,
        sopNameGujarati: a.sopNameGujarati,
        month: a.month,
        year: a.year,
        status,
        scheduleStatus: scheduleStatus === 'missed' ? 'overdue' : scheduleStatus,
        isIgnored,
        examDate: dueDate || a.examDate,
        completedDate: completed ? examCompletionDate(progress) : undefined,
        score: completed ? examScore(progress) : undefined,
        progressPct: completed
          ? 100
          : Math.max(0, Math.min(100, progress?.overallPercentage ?? 0)),
        daysOverdue,
      });
    }

    rows.sort((a, b) => {
      if (a.month !== b.month) return a.month - b.month;
      return a.sopCode.localeCompare(b.sopCode);
    });
    built.push(buildEmployee(emp, rows));
  }

  const byId = new Map(built.map((e) => [e.employeeId, e]));

  const trainerNamesFor = (department: string): string[] =>
    trainers
      .filter((t) => deptMatchesTrainerScope(department, t.trainerDepartments))
      .map((t) => t.name);

  // Learners in a department: everyone except designated trainers, who are
  // reported through their own trainer node instead.
  const learnersIn = (department: string): OverviewEmployee[] =>
    built
      .filter((e) => !e.isTrainer && deptMatchesTrainerScope(e.department, [department]))
      .sort((a, b) => a.name.localeCompare(b.name));

  const trainerNodes: OverviewTrainer[] = trainers.map((t) =>
    buildTrainerNode(t, learnersIn, trainerNamesFor, byId),
  );

  const departmentNodes = departments
    .map((d) => buildDepartment(d, learnersIn(d), trainerNamesFor(d)))
    .sort((a, b) => a.department.localeCompare(b.department));

  // Org totals count each employee once, however many trainers cover them.
  const orgTotals = emptyTotals();
  const orgMonthly = emptyMonthly();
  let employeesCompleted = 0;
  const learners = built.filter((e) => !e.isTrainer);
  for (const emp of learners) {
    mergeTotals(orgTotals, emp.totals);
    mergeMonthly(orgMonthly, emp.monthly);
    if (emp.totals.total === 0) continue;
    if (emp.fullyCompleted) employeesCompleted++;
  }

  const employeesPending = learners.filter((e) => e.totals.total > 0 && !e.fullyCompleted).length;

  const departmentsWithoutTrainer = departments.filter(
    (d) => trainerNamesFor(d).length === 0,
  );

  return {
    generatedAt: toDateOnlyIso(today),
    year: yearFilter || now.getFullYear(),
    years: [...yearSet].sort((a, b) => b - a),
    trainingCycleStart: formatCycleStart(cycle),
    includeIgnored,
    totals: {
      trainers: trainers.length,
      departments: departments.length,
      departmentsCovered: departments.length - departmentsWithoutTrainer.length,
      employees: learners.length,
      employeesCompleted,
      employeesPending,
      exams: orgTotals,
      completionPct: pct(orgTotals),
    },
    monthly: orgMonthly,
    monthlySops: monthlySopsFrom(learners.flatMap((e) => e.exams)),
    trainers: trainerNodes,
    departments: departmentNodes,
    departmentsWithoutTrainer,
  };
}

function buildTrainerNode(
  trainer: TrainerDirectoryEntry,
  learnersIn: (department: string) => OverviewEmployee[],
  trainerNamesFor: (department: string) => string[],
  byId: Map<string, OverviewEmployee>,
): OverviewTrainer {
  const departments = trainer.trainerDepartments.map((d) =>
    buildDepartment(d, learnersIn(d), trainerNamesFor(d)),
  );

  const totals = emptyTotals();
  const monthly = emptyMonthly();
  let employeeCount = 0;
  let employeesCompleted = 0;
  let employeesPending = 0;
  // A trainer covering two departments can meet the same person twice only if
  // the departments overlap — dedupe so the headline count stays honest.
  const seen = new Set<string>();
  for (const dept of departments) {
    for (const emp of dept.employees) {
      if (seen.has(emp.employeeId)) continue;
      seen.add(emp.employeeId);
      employeeCount++;
      if (emp.totals.total === 0) continue;
      if (emp.fullyCompleted) employeesCompleted++;
      else employeesPending++;
      mergeTotals(totals, emp.totals);
      mergeMonthly(monthly, emp.monthly);
    }
  }

  const self = byId.get(trainer.id);
  const ownTotals = self ? self.totals : emptyTotals();

  return {
    trainerId: trainer.id,
    name: trainer.name,
    homeDepartment: trainer.department,
    trainerDepartments: trainer.trainerDepartments,
    employeeCount,
    employeesCompleted,
    employeesPending,
    totals,
    completionPct: pct(totals),
    own: {
      totals: ownTotals,
      completionPct: pct(ownTotals),
      hasRecord: Boolean(self),
    },
    monthly,
    monthlySops: monthlySopsFrom(departments.flatMap((d) => d.employees.flatMap((e) => e.exams))),
    departments,
  };
}
