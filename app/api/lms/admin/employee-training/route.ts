import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import {
  getOrBuildLmsCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import Employee from '@/models/Employee';
import SOP from '@/models/SOP';
import LearningProgress from '@/models/lms/LearningProgress';
import TrainingMatrixUpload from '@/models/TrainingMatrixUpload';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { resolveTrainerDepartments } from '@/lib/employeeTrainer';
import { getJourneyContentBatch } from '@/lib/lmsJourneyContent';
import {
  hasGujaratiScript,
  isInvalidSopAssignmentCode,
  isPlaceholderSopName,
  resolveSopFamilyNames,
} from '@/lib/sop-name-resolution';
import {
  applyReschedulesToList,
  listTrainingReschedules,
} from '@/lib/lmsTrainingReschedule';
import {
  classifyScheduleStatus,
  formatCycleStart,
  getTrainingCycleStart,
  type LmsScheduleStatus,
} from '@/lib/lmsTrainingCycle';
import {
  COMPONENT_GROUPS,
  componentStatuses,
  isSopComplete,
  isStepDone,
  type ComponentKey,
  type ComponentStatus,
  type SopStatus,
} from '@/lib/lmsCompletion';
import type { ISOP } from '@/models/SOP';

export const dynamic = 'force-dynamic';

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function monthNameToNum(name: string): number | null {
  const idx = MONTH_NAMES.findIndex(
    (m) => m && m.toLowerCase() === String(name || '').trim().toLowerCase(),
  );
  return idx > 0 ? idx : null;
}

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

/**
 * The training-matrix records store one row per SOP per *tracking* month, so a
 * single SOP repeats across several months. The authoritative *scheduled* month
 * for each SOP lives in the latest upload snapshot's `sopMonthMap`. This builds
 * department → (base SOP code → scheduled month numbers) from those snapshots,
 * mirroring how the matrix UI lays SOPs out across Jan–Dec. A SOP scheduled in
 * multiple months (e.g. "January,March") maps to each of those months.
 */
async function buildSopScheduleByDept(): Promise<Map<string, Map<string, number[]>>> {
  const uploads = await TrainingMatrixUpload.find({
    fileType: 'main',
    'snapshot.sopMonthMap': { $exists: true },
  })
    .sort({ uploadedAt: -1 })
    .select('department snapshot.sopMonthMap')
    .lean<Array<{ department?: string; snapshot?: { sopMonthMap?: Record<string, string> } }>>();

  const byDept = new Map<string, Map<string, number[]>>();
  for (const up of uploads) {
    const dept = String(up.department || '').trim().toLowerCase();
    const sopMonthMap = up.snapshot?.sopMonthMap;
    if (!dept || byDept.has(dept) || !sopMonthMap) continue; // keep latest upload per dept

    const sched = new Map<string, number[]>();
    for (const [rawKey, monthVal] of Object.entries(sopMonthMap)) {
      const base = stripVersion(rawKey);
      const months = String(monthVal)
        .split(',')
        .map((s) => monthNameToNum(s.trim()))
        .filter((m): m is number => m !== null);
      if (!base || months.length === 0) continue;
      sched.set(base, [...new Set(months)]);
    }
    byDept.set(dept, sched);
  }
  return byDept;
}

export type { ComponentStatus, SopStatus } from '@/lib/lmsCompletion';

export interface SopBreakdown {
  sopCode: string;
  /** Canonical registry identity (sopBaseId) for distinct counting; absent when the code matches no SOP. */
  sopKey?: string;
  sopName: string;
  /** Gujarati display name when a Gujarati registry record exists. */
  sopNameGujarati?: string;
  status: SopStatus;
  /** Scheduled month numbers (1 = Jan … 12 = Dec) from the matrix snapshot. */
  months: number[];
  /** Primary planned year for schedule classification. */
  year?: number;
  /** Cycle-aware schedule status for the primary month (ignored/due/missed/upcoming). */
  scheduleStatus?: LmsScheduleStatus;
  /** SOP has an MCQ assessment / exam. */
  hasExam: boolean;
  components: Record<ComponentKey, ComponentStatus>;
}

export interface EmployeeTrainingRecord {
  employeeId: string;
  employeeName: string;
  designation: string;
  /** Designation held before the most recent change, if there has been one. */
  previousDesignation?: string;
  /** ISO timestamp of the most recent designation change. */
  designationUpdatedAt?: string;
  department: string;
  isActive: boolean;
  isTrainer: boolean;
  totalSops: number;
  completedSops: number;
  notCompletedSops: number;
  missedSops: number;
  ignoredSops: number;
  overallPct: number;
  /** Count of assigned SOPs per month, index 0 = Jan … 11 = Dec. */
  monthlyCounts: number[];
  /** Status breakdown per month for the employee grid. */
  monthlyBreakdown: Array<{ completed: number; notCompleted: number }>;
  sops: SopBreakdown[];
  /** Employee has at least one regular training SOP assigned. */
  hasTraining: boolean;
  /** Employee has at least one induction SOP assigned. */
  hasInduction: boolean;
}

function empKey(department: string, name: string): string {
  return `${department}||${name}`.trim().toLowerCase();
}

function buildMonthlyBreakdown(sops: SopBreakdown[]) {
  const breakdown = Array.from({ length: 12 }, () => ({
    completed: 0,
    notCompleted: 0,
  }));
  for (const sop of sops) {
    for (const m of sop.months) {
      const idx = m - 1;
      if (idx < 0 || idx > 11) continue;
      if (sop.status === 'completed') breakdown[idx].completed++;
      else breakdown[idx].notCompleted++;
    }
  }
  return breakdown;
}

// GET /api/lms/admin/employee-training?department=QA
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const department = searchParams.get('department');

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.adminEmployeeTraining(department || 'all'),
      lmsServerTtl.adminEmployeeTraining,
      async () => {
        await connectDB();

        const empFilter: Record<string, unknown> = { isActive: { $ne: false } };
        if (department) empFilter.department = { $regex: new RegExp(`^${department}$`, 'i') };

        const employees = await Employee.find(empFilter)
          .select(
            '_id name designation previousDesignation designationUpdatedAt ' +
            'department isActive isTrainer trainerDepartments',
          )
          .sort({ name: 1 })
          .lean<{
            _id: unknown;
            name: string;
            designation: string;
            previousDesignation?: string;
            designationUpdatedAt?: Date;
            department: string;
            isActive: boolean;
            isTrainer?: boolean;
            trainerDepartments?: string[];
          }[]>();

        const employeeIds = employees.map((e) => e._id);
        const [assignmentsMap, scheduleByDept, rescheduleRules] = await Promise.all([
          getEmployeeAssignmentsMap(),
          buildSopScheduleByDept(),
          listTrainingReschedules(department || undefined),
        ]);
        const cycle = getTrainingCycleStart();

        // Progress keyed by employeeId + uppercased SOP code (matches the
        // convention used by the training-status endpoint).
        // `status` / `overallPercentage` are the learner's own stored result —
        // what they were shown and what their certificate was issued against.
        // Without them this roll-up recomputed completion from raw steps alone
        // and disagreed with the learner's own screen.
        const progressList = await LearningProgress.find({ employeeId: { $in: employeeIds } })
          .select('employeeId sopCode steps status overallPercentage')
          .lean();
        const progressMap = new Map<string, {
          steps: Record<string, unknown>;
          status?: string;
          overallPercentage?: number;
        }>();
        for (const p of progressList) {
          const id  = String((p as { employeeId: unknown }).employeeId);
          const sop = String((p as { sopCode: string }).sopCode).toUpperCase();
          progressMap.set(`${id}::${sop}`, {
            steps: (p as { steps?: Record<string, unknown> }).steps || {},
            status: (p as { status?: string }).status,
            overallPercentage: (p as { overallPercentage?: number }).overallPercentage,
          });
        }

        const assignmentKeyLocal = (code: string) =>
          String(code || '').toUpperCase().replace(/-\d+$/, '').trim();

        const resolveAssignmentsForEmployee = (emp: {
          name: string;
          department: string;
          isTrainer?: boolean;
          trainerDepartments?: string[];
        }) => {
          // Primary lookup is always home department (trainers merge into this key).
          const primary = assignmentsMap.get(empKey(emp.department, emp.name)) ?? [];
          if (!emp.isTrainer) return primary;

          // Defensive merge: also pull any leftovers keyed under other trainer depts.
          const byCode = new Map<string, (typeof primary)[number]>();
          for (const a of primary) byCode.set(assignmentKeyLocal(a.sopCode), a);
          for (const dept of resolveTrainerDepartments({ ...emp, isTrainer: true })) {
            if (dept.toLowerCase() === String(emp.department || '').trim().toLowerCase()) continue;
            for (const a of assignmentsMap.get(empKey(dept, emp.name)) ?? []) {
              const k = assignmentKeyLocal(a.sopCode);
              if (!byCode.has(k)) byCode.set(k, a);
            }
          }
          return [...byCode.values()];
        };

        // Available steps only depend on the SOP, so resolve each unique code once.
        const uniqueSopCodes = new Set<string>();
        for (const emp of employees) {
          for (const a of resolveAssignmentsForEmployee(emp)) uniqueSopCodes.add(a.sopCode);
        }
        const contentByCode = await getJourneyContentBatch(uniqueSopCodes);
        const availableByCode = new Map<string, string[]>(
          [...contentByCode.entries()].map(([code, content]) => [code, content.availableStepIds]),
        );
        const nameByCode = new Map<string, string>(
          [...contentByCode.entries()]
            .filter(([, content]) => content.sop?.name)
            .map(([code, content]) => [code, content.sop!.name]),
        );
        const keyByCode = new Map<string, string>(
          [...contentByCode.entries()]
            .filter(([, content]) => content.sop)
            .map(([code, content]) => [
              code,
              (content.sop!.sopBaseId || content.sop!.identifier).toUpperCase(),
            ]),
        );

        const basesNeeded = new Set<string>();
        for (const code of uniqueSopCodes) {
          const base = keyByCode.get(code) || stripVersion(code);
          if (base && !isInvalidSopAssignmentCode(base)) basesNeeded.add(base);
        }
        const sopFamilies = new Map<string, ISOP[]>();
        if (basesNeeded.size > 0) {
          const familyRows = await SOP.find({
            isObsolete: { $ne: true },
            $or: [
              { sopBaseId: { $in: [...basesNeeded] } },
              { identifier: { $in: [...uniqueSopCodes] } },
            ],
          })
            .select('name identifier sopBaseId language')
            .lean<ISOP[]>();
          for (const row of familyRows) {
            const base = String(row.sopBaseId || stripVersion(row.identifier || '')).toUpperCase();
            if (!base) continue;
            if (!sopFamilies.has(base)) sopFamilies.set(base, []);
            sopFamilies.get(base)!.push(row);
          }
        }
        const resolvedByBase = new Map<string, ReturnType<typeof resolveSopFamilyNames>>();
        for (const base of basesNeeded) {
          resolvedByBase.set(base, resolveSopFamilyNames(sopFamilies.get(base) || [], base));
        }
        const resolveAssignmentNames = (sopCode: string, matrixName?: string) => {
          const base = keyByCode.get(sopCode) || stripVersion(sopCode);
          const resolved = base ? resolvedByBase.get(base) : undefined;
          const english =
            (resolved?.englishName && !isPlaceholderSopName(resolved.englishName, sopCode) ? resolved.englishName : '') ||
            (() => {
              const raw = nameByCode.get(sopCode) || matrixName || '';
              if (!raw || isPlaceholderSopName(raw, sopCode)) return '';
              return hasGujaratiScript(raw) ? '' : raw;
            })() ||
            sopCode;
          const gujarati =
            resolved?.gujaratiName ||
            (() => {
              const raw = nameByCode.get(sopCode) || matrixName || '';
              if (raw && hasGujaratiScript(raw) && !isPlaceholderSopName(raw, sopCode)) return raw;
              return undefined;
            })();
          return { english, gujarati: gujarati && gujarati !== english ? gujarati : undefined };
        };

        const records: EmployeeTrainingRecord[] = employees.map((emp) => {
          const id          = String(emp._id);
          const rawAssignments = resolveAssignmentsForEmployee(emp);
          const assignments = applyReschedulesToList(rawAssignments, rescheduleRules, {
            employeeId: id,
            employeeDepartment: emp.department,
          });

          let completedSops = 0;
          let notCompletedSops = 0;
          let missedSops = 0;
          let ignoredSops = 0;
          let totalSteps = 0;
          let doneSteps = 0;

          // Per-month assigned-SOP counts come from the scheduled month
          // (sopMonthMap). Trainers may span multiple departments — look up
          // each SOP against its own department schedule first.
          const homeSched = scheduleByDept.get(String(emp.department || '').trim().toLowerCase());
          const trainerScheds = emp.isTrainer
            ? resolveTrainerDepartments({ ...emp, isTrainer: true }).map((d) =>
                scheduleByDept.get(d.toLowerCase()),
              )
            : [];

          const monthsForSop = (sopCode: string, sopDepartment?: string, fallbackMonth?: number): number[] => {
            if (sopDepartment) {
              const byDept = scheduleByDept.get(sopDepartment.trim().toLowerCase());
              const months = byDept?.get(stripVersion(sopCode));
              if (months?.length) return months;
            }
            for (const sched of trainerScheds) {
              const months = sched?.get(stripVersion(sopCode));
              if (months?.length) return months;
            }
            const fromHome = homeSched?.get(stripVersion(sopCode));
            if (fromHome?.length) return fromHome;
            return fallbackMonth ? [fallbackMonth] : [];
          };

          const monthlyCounts = new Array(12).fill(0) as number[];
          for (const a of assignments) {
            if (isInvalidSopAssignmentCode(a.sopCode)) continue;
            const months = monthsForSop(a.sopCode, a.sopDepartment, a.month);
            for (const m of months) monthlyCounts[m - 1]++;
          }

          const sops: SopBreakdown[] = assignments.flatMap((a) => {
            if (isInvalidSopAssignmentCode(a.sopCode)) return [];

            const available = availableByCode.get(a.sopCode) ?? [];
            const availableSet = new Set(available);
            const prog = progressMap.get(`${id}::${a.sopCode.toUpperCase()}`);
            const steps = prog?.steps;

            const doneCount = available.filter((s) => isStepDone(steps, s)).length;
            totalSteps += available.length;
            doneSteps += doneCount;

            const status: SopStatus = isSopComplete({
              steps,
              availableSteps: available,
              status: prog?.status,
              overallPercentage: prog?.overallPercentage,
            })
              ? 'completed'
              : 'not_completed';

            if (status === 'completed') completedSops++;
            else notCompletedSops++;

            const months = monthsForSop(a.sopCode, a.sopDepartment, a.month);
            const primaryMonth = months[0] ?? a.month;
            const scheduleStatus = classifyScheduleStatus(
              { year: a.year, month: primaryMonth },
              { cycle, completed: status === 'completed' },
            );
            if (status !== 'completed') {
              if (scheduleStatus === 'missed' || scheduleStatus === 'overdue') missedSops++;
              if (scheduleStatus === 'ignored') ignoredSops++;
            }

            const components = componentStatuses(availableSet, steps);

            const { english, gujarati } = resolveAssignmentNames(a.sopCode, a.sopName);

            return [{
              sopCode: a.sopCode,
              sopKey: keyByCode.get(a.sopCode) || stripVersion(a.sopCode).toUpperCase(),
              sopName: english,
              sopNameGujarati: gujarati,
              status,
              months,
              year: a.year,
              scheduleStatus,
              hasExam: availableSet.has('quiz') || availableSet.has('quizGu'),
              components,
            }];
          });

          const overallPct = totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0;

          return {
            employeeId:       id,
            employeeName:     emp.name,
            designation:      emp.designation,
            // Lets the LMS view confirm a designation change actually landed.
            previousDesignation: emp.previousDesignation || undefined,
            designationUpdatedAt: emp.designationUpdatedAt
              ? new Date(emp.designationUpdatedAt).toISOString()
              : undefined,
            department:       emp.department,
            isActive:         emp.isActive,
            isTrainer:        Boolean(emp.isTrainer),
            totalSops:        sops.length,
            completedSops,
            notCompletedSops,
            missedSops,
            ignoredSops,
            overallPct,
            monthlyCounts,
            monthlyBreakdown: buildMonthlyBreakdown(sops),
            sops,
            hasTraining:  assignments.some((a) => a.trainingType === 'training'),
            hasInduction: assignments.some((a) => a.trainingType === 'induction'),
          };
        });

        // Month → count of SOP exams scheduled (distinct SOP×employee with exam in that month).
        const monthExamCounts = new Array(12).fill(0) as number[];
        for (const r of records) {
          for (const s of r.sops) {
            if (!s.hasExam) continue;
            for (const m of s.months) {
              if (m >= 1 && m <= 12) monthExamCounts[m - 1]++;
            }
          }
        }

        return {
          records,
          trainingCycleStart: formatCycleStart(cycle),
          monthExamCounts,
        };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(120) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
