import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import {
  getOrBuildLmsCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import Employee from '@/models/Employee';
import SOP from '@/models/SOP';
import LearningProgress from '@/models/lms/LearningProgress';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { getJourneyContentBatch } from '@/lib/lmsJourneyContent';
import {
  hasGujaratiScript,
  isInvalidSopAssignmentCode,
  isPlaceholderSopName,
  resolveSopFamilyNames,
} from '@/lib/sop-name-resolution';
import { applyReschedulesToList, listTrainingReschedules } from '@/lib/lmsTrainingReschedule';
import { filterIgnoredAssignments, listTrainingIgnores } from '@/lib/lmsTrainingIgnore';
import {
  classifyScheduleStatus,
  formatCycleStart,
  getTrainingCycleStart,
  type LmsScheduleStatus,
} from '@/lib/lmsTrainingCycle';
import { baseIdentifierFromIdentifier } from '@/lib/sop-utils';
import type { ISOP } from '@/models/SOP';

export const dynamic = 'force-dynamic';

type ComponentStatus = 'completed' | 'not_completed' | 'na';
type SopStatus = 'completed' | 'not_completed';

const COMPONENT_GROUPS = {
  videos: ['videoEn', 'videoGu'],
  slides: ['slidesEn', 'slidesGu'],
  sopDoc: ['sopPdf', 'sopPdfGu'],
  mcq: ['quiz', 'quizGu'],
} as const;

type ComponentKey = keyof typeof COMPONENT_GROUPS;

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

function empKey(department: string, name: string): string {
  return `${department}||${name}`.trim().toLowerCase();
}

function isStepDone(steps: Record<string, unknown> | undefined, stepId: string): boolean {
  const s = steps?.[stepId] as { completed?: boolean } | undefined;
  return Boolean(s && s.completed);
}

function componentStatus(
  availableSet: Set<string>,
  steps: Record<string, unknown> | undefined,
  groupSteps: readonly string[],
): ComponentStatus {
  const present = groupSteps.filter((s) => availableSet.has(s));
  if (present.length === 0) return 'na';
  const done = present.filter((s) => isStepDone(steps, s)).length;
  if (done === present.length) return 'completed';
  return 'not_completed';
}

export interface TrainerSopRow {
  sopCode: string;
  sopKey: string;
  sopName: string;
  sopNameGujarati?: string;
  status: SopStatus;
  scheduleStatus: LmsScheduleStatus;
  months: number[];
  year: number;
  examDate?: string;
  hasExam: boolean;
  /** Languages this SOP's exam can be taken in, e.g. ['en','gu']. */
  examLanguages: Array<'en' | 'gu'>;
  progressPct: number;
  components: Record<ComponentKey, ComponentStatus>;
}

export interface TrainerEmployeeRecord {
  employeeId: string;
  employeeName: string;
  designation: string;
  department: string;
  isActive: boolean;
  isTrainer: boolean;
  totalSops: number;
  completedSops: number;
  notCompletedSops: number;
  dueSops: number;
  overdueSops: number;
  ignoredSops: number;
  upcomingSops: number;
  overallPct: number;
  sops: TrainerSopRow[];
}

// GET /api/lms/trainer/dashboard
export async function GET(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const { trainer } = auth;
  const deptParam = req.nextUrl.searchParams.get('department')?.trim() || '';

  try {
    const body = await getOrBuildLmsCache(
      `${lmsServerKeys.trainerDashboard(trainer.employeeId)}:${deptParam || 'all'}`,
      lmsServerTtl.adminEmployeeTraining,
      async () => {
        await connectDB();
        const cycle = getTrainingCycleStart();
        const scopedDepts = trainer.trainerDepartments.filter((d) =>
          !deptParam || d.toLowerCase() === deptParam.toLowerCase(),
        );
        if (scopedDepts.length === 0) {
          return {
            trainer: {
              id: trainer.employeeId,
              name: trainer.name,
              department: trainer.department,
              trainerDepartments: trainer.trainerDepartments,
            },
            trainingCycleStart: formatCycleStart(cycle),
            records: [] as TrainerEmployeeRecord[],
            monthExamCounts: Array(12).fill(0),
            statusTotals: {
              due: 0, overdue: 0, completed: 0, ignored: 0, upcoming: 0, notCompleted: 0,
            },
          };
        }

        const deptRegex = scopedDepts.map(
          (d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        );
        const employees = await Employee.find({
          isActive: true,
          department: { $in: deptRegex },
        })
          .select('_id name designation department isActive isTrainer')
          .sort({ name: 1 })
          .lean<{
            _id: unknown;
            name: string;
            designation: string;
            department: string;
            isActive: boolean;
            isTrainer?: boolean;
          }[]>();

        const employeeIds = employees.map((e) => e._id);
        const [assignmentsMap, rescheduleRules, ignoreRules, progressList] = await Promise.all([
          getEmployeeAssignmentsMap({ departments: scopedDepts }),
          listTrainingReschedules(),
          // Same admin ignore rules the learner's LMS applies, so the trainer's
          // totals cannot drift from what the employee actually sees.
          listTrainingIgnores(),
          LearningProgress.find({ employeeId: { $in: employeeIds } })
            .select('employeeId sopCode steps status overallPercentage')
            .lean(),
        ]);

        const progressMap = new Map<string, {
          steps: Record<string, unknown>;
          status?: string;
          overallPercentage?: number;
        }>();
        for (const p of progressList) {
          const id = String((p as { employeeId: unknown }).employeeId);
          const sop = String((p as { sopCode: string }).sopCode).toUpperCase();
          progressMap.set(`${id}::${sop}`, {
            steps: (p as { steps?: Record<string, unknown> }).steps || {},
            status: (p as { status?: string }).status,
            overallPercentage: (p as { overallPercentage?: number }).overallPercentage,
          });
        }

        const uniqueCodes = new Set<string>();
        for (const emp of employees) {
          const raw = assignmentsMap.get(empKey(emp.department, emp.name)) || [];
          for (const a of raw) uniqueCodes.add(a.sopCode);
        }
        const contentByCode = await getJourneyContentBatch(uniqueCodes);
        const availableByCode = new Map(
          [...contentByCode.entries()].map(([code, c]) => [code, c.availableStepIds]),
        );
        // Languages the SOP's single exam can be taken in — trainers need to see
        // which of their SOPs are not yet available in Gujarati.
        const examLangsByCode = new Map(
          [...contentByCode.entries()].map(([code, c]) => [code, c.quizLanguages]),
        );
        const keyByCode = new Map(
          [...contentByCode.entries()]
            .filter(([, c]) => c.sop)
            .map(([code, c]) => [
              code,
              (c.sop!.sopBaseId || c.sop!.identifier).toUpperCase(),
            ]),
        );

        const basesNeeded = new Set<string>();
        for (const code of uniqueCodes) {
          const base = keyByCode.get(code) || stripVersion(code);
          if (base && !isInvalidSopAssignmentCode(base)) basesNeeded.add(base);
        }
        const sopFamilies = new Map<string, ISOP[]>();
        if (basesNeeded.size > 0) {
          const familyRows = await SOP.find({
            isObsolete: { $ne: true },
            $or: [
              { sopBaseId: { $in: [...basesNeeded] } },
              { identifier: { $in: [...uniqueCodes] } },
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

        const records: TrainerEmployeeRecord[] = employees.map((emp) => {
          const id = String(emp._id);
          const raw = assignmentsMap.get(empKey(emp.department, emp.name)) || [];
          const notIgnored = filterIgnoredAssignments(raw, ignoreRules, emp.department);
          const assignments = applyReschedulesToList(notIgnored, rescheduleRules, {
            employeeId: id,
            employeeDepartment: emp.department,
          }).filter((a) =>
            // Only SOPs in the trainer's departments (not every SOP on an
            // in-scope employee's matrix from other departments).
            deptMatchesTrainerScope(a.sopDepartment || emp.department, scopedDepts),
          );

          let completedSops = 0;
          let notCompletedSops = 0;
          let dueSops = 0;
          let overdueSops = 0;
          let ignoredSops = 0;
          let upcomingSops = 0;
          let totalSteps = 0;
          let doneSteps = 0;

          const sops: TrainerSopRow[] = assignments.flatMap((a) => {
            if (isInvalidSopAssignmentCode(a.sopCode)) return [];
            const available = availableByCode.get(a.sopCode) ?? [];
            const availableSet = new Set(available);
            const prog = progressMap.get(`${id}::${a.sopCode.toUpperCase()}`);
            const steps = prog?.steps;
            const doneCount = available.filter((s) => isStepDone(steps, s)).length;
            totalSteps += available.length;
            doneSteps += doneCount;

            const fullyDone =
              (prog?.status === 'completed' && (prog.overallPercentage ?? 0) >= 100) ||
              (available.length > 0 && doneCount === available.length);
            const status: SopStatus = fullyDone ? 'completed' : 'not_completed';
            if (status === 'completed') completedSops++;
            else notCompletedSops++;

            const scheduleStatus = classifyScheduleStatus(
              { year: a.year, month: a.month },
              { cycle, completed: status === 'completed' },
            );
            if (status !== 'completed') {
              if (scheduleStatus === 'due') dueSops++;
              if (scheduleStatus === 'missed' || scheduleStatus === 'overdue') overdueSops++;
              if (scheduleStatus === 'ignored') ignoredSops++;
              if (scheduleStatus === 'upcoming') upcomingSops++;
            }

            const base = keyByCode.get(a.sopCode) || stripVersion(a.sopCode);
            const resolved = base ? resolvedByBase.get(base) : undefined;
            let english =
              (resolved?.englishName && !isPlaceholderSopName(resolved.englishName, a.sopCode)
                ? resolved.englishName
                : '') ||
              a.sopName ||
              a.sopCode;
            if (hasGujaratiScript(english)) english = a.sopCode;
            const gujarati = resolved?.gujaratiName;

            const components = Object.fromEntries(
              (Object.keys(COMPONENT_GROUPS) as ComponentKey[]).map((key) => [
                key,
                componentStatus(availableSet, steps, COMPONENT_GROUPS[key]),
              ]),
            ) as Record<ComponentKey, ComponentStatus>;

            const progressPct =
              available.length > 0
                ? Math.round((doneCount / available.length) * 100)
                : fullyDone
                  ? 100
                  : 0;

            return [{
              sopCode: a.sopCode,
              sopKey: (keyByCode.get(a.sopCode) || baseIdentifierFromIdentifier(a.sopCode) || a.sopCode).toUpperCase(),
              sopName: english,
              sopNameGujarati: gujarati && gujarati !== english ? gujarati : undefined,
              status,
              scheduleStatus: scheduleStatus === 'missed' ? 'overdue' : scheduleStatus,
              months: [a.month],
              year: a.year,
              examDate: a.examDate,
              hasExam: availableSet.has('quiz') || availableSet.has('quizGu'),
              examLanguages: examLangsByCode.get(a.sopCode) ?? [],
              progressPct,
              components,
            }];
          });

          return {
            employeeId: id,
            employeeName: emp.name,
            designation: emp.designation,
            department: emp.department,
            isActive: emp.isActive,
            isTrainer: Boolean(emp.isTrainer),
            totalSops: sops.length,
            completedSops,
            notCompletedSops,
            dueSops,
            overdueSops,
            ignoredSops,
            upcomingSops,
            overallPct: totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0,
            sops,
          };
        });

        // SOP-wise month chips: the same exam assigned to many employees counts once.
        const monthSops = Array.from({ length: 12 }, () => new Set<string>());
        let due = 0;
        let overdue = 0;
        let completed = 0;
        let ignored = 0;
        let upcoming = 0;
        let notCompleted = 0;
        for (const r of records) {
          if (r.isTrainer) continue;
          for (const s of r.sops) {
            const preCycle = s.status !== 'completed' && s.scheduleStatus === 'ignored';
            // Pre-cycle SOPs show as "Ignored" in the learner's LMS — counting
            // them here would inflate every month chip with dormant history.
            if (s.hasExam && !preCycle) {
              for (const m of s.months) {
                if (m >= 1 && m <= 12) monthSops[m - 1].add(s.sopKey || s.sopCode);
              }
            }
            if (s.status === 'completed') {
              completed++;
              continue;
            }
            notCompleted++;
            if (s.scheduleStatus === 'due') due++;
            else if (s.scheduleStatus === 'overdue' || s.scheduleStatus === 'missed') overdue++;
            else if (s.scheduleStatus === 'ignored') ignored++;
            else if (s.scheduleStatus === 'upcoming') upcoming++;
          }
        }

        return {
          trainer: {
            id: trainer.employeeId,
            name: trainer.name,
            department: trainer.department,
            trainerDepartments: trainer.trainerDepartments,
          },
          trainingCycleStart: formatCycleStart(cycle),
          records,
          monthExamCounts: monthSops.map((set) => set.size),
          statusTotals: { due, overdue, completed, ignored, upcoming, notCompleted },
        };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(60) });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
