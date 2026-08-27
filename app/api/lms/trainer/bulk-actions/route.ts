import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import { bustTrainerScheduleCaches } from '@/lib/lmsTrainerCache';
import ScheduledExam from '@/models/lms/ScheduledExam';
import TrainingAttendance from '@/models/lms/TrainingAttendance';
import {
  checkEmployeeSelection,
  employeeAssignmentKey,
  listTrainerScopedEmployees,
} from '@/lib/lmsTrainerEmployees';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { stripVersion } from '@/lib/lmsExamScheduling';
import { resolveTrainingSop } from '@/lib/lmsAttendanceSops';
import { buildSopList } from '@/app/api/lms/admin/sop-exam-settings/route';
import { getOrBuildLmsCache, lmsServerKeys, lmsServerTtl } from '@/lib/lmsCache';
import {
  parseDateOnly,
  monthOfDate,
  yearOfDate,
  toDateOnlyIso,
} from '@/lib/trainingExamSchedule';
import { getJourneyContentBatch } from '@/lib/lmsJourneyContent';
import { expiredSopCodeSet } from '@/lib/assignEmployeeSops';
import { isSopDocumentExpired } from '@/lib/sop-utils';

export const dynamic = 'force-dynamic';

type Action = 'assign-exam' | 'schedule-training' | 'remove-assign';

/**
 * POST /api/lms/trainer/bulk-actions
 *
 * Body: {
 *   action: 'assign-exam' | 'schedule-training' | 'remove-assign',
 *   sopCodes: string[],
 *   date?: 'YYYY-MM-DD',   // required for assign-exam / schedule-training
 *   month?: number,
 *   year?: number,
 *   notes?: string,
 * }
 *
 * - assign-exam: create/update a ScheduledExam (exam date) for every employee
 *   who has each SOP on their matrix (LMS login + MCQ required).
 * - schedule-training: assign the chosen date as the ScheduledExam date for
 *   matrix employees (same as assigned/scheduled date in My Trainings), and
 *   file an attendance sheet per SOP × department.
 * - remove-assign: cancel live ScheduledExam rows for the given SOPs in the
 *   trainer's departments (optionally scoped to month/year).
 */
export async function POST(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || '') as Action;
  const rawCodes: unknown[] = Array.isArray(body.sopCodes) ? body.sopCodes : [];
  const sopCodes = [
    ...new Set(rawCodes.map((c) => stripVersion(String(c ?? ''))).filter(Boolean)),
  ];
  const date = parseDateOnly(String(body.date || ''));
  const notes = String(body.notes || '').trim() || undefined;
  const requestedMonth = Number(body.month) || 0;
  const requestedYear = Number(body.year) || 0;

  if (action !== 'assign-exam' && action !== 'schedule-training' && action !== 'remove-assign') {
    return NextResponse.json(
      { error: 'action must be assign-exam, schedule-training, or remove-assign' },
      { status: 400 },
    );
  }
  if (sopCodes.length === 0) {
    return NextResponse.json({ error: 'sopCodes are required' }, { status: 400 });
  }
  if (action !== 'remove-assign' && !date) {
    return NextResponse.json(
      { error: 'sopCodes and date (YYYY-MM-DD) are required' },
      { status: 400 },
    );
  }
  if (requestedMonth && (requestedMonth < 1 || requestedMonth > 12)) {
    return NextResponse.json({ error: 'month must be 1–12' }, { status: 400 });
  }

  try {
    await connectDB();
    const trainerDepts = auth.trainer.trainerDepartments;
    const employees = await listTrainerScopedEmployees(trainerDepts);
    const assignmentsMap = await getEmployeeAssignmentsMap();
    const month = requestedMonth || (date ? monthOfDate(date) : 0);
    const year = requestedYear || (date ? yearOfDate(date) : 0);

    if (action === 'remove-assign') {
      const deptRes = trainerDepts.map(
        (d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      );
      const filter: Record<string, unknown> = {
        sopCode: { $in: sopCodes },
        status: 'scheduled',
        department: { $in: deptRes },
      };
      if (month >= 1 && month <= 12) filter.month = month;
      if (year > 0) filter.year = year;

      const result = await ScheduledExam.updateMany(filter, {
        $set: {
          status: 'cancelled',
          notes: notes || `Cancelled in bulk by ${auth.trainer.name}`,
        },
      });

      bustTrainerScheduleCaches();
      return NextResponse.json({
        ok: true,
        action,
        month: month || undefined,
        year: year || undefined,
        cancelled: result.modifiedCount ?? 0,
        matched: result.matchedCount ?? 0,
        sopCodes,
      });
    }

    if (!date) {
      return NextResponse.json({ error: 'date is required' }, { status: 400 });
    }

    if (action === 'assign-exam' || action === 'schedule-training') {
      const catalog = await getOrBuildLmsCache(
        lmsServerKeys.adminSopExamSettings(),
        lmsServerTtl.adminSopExamSettings,
        buildSopList,
      );
      const examByCode = new Map(
        catalog.sops.map((s) => [stripVersion(s.sopCode), s]),
      );
      const content = await getJourneyContentBatch(sopCodes);
      const expiredCodes = await expiredSopCodeSet(sopCodes);
      const hasExam = (code: string) => {
        const c = content.get(code);
        return Boolean(c?.availableStepIds.includes('quiz') || c?.availableStepIds.includes('quizGu'));
      };

      let scheduled = 0;
      let created = 0;
      let updated = 0;
      const skipped: string[] = [];
      const perSop: Array<{ sopCode: string; sopName: string; employees: number }> = [];

      for (const sopCode of sopCodes) {
        const exam = examByCode.get(sopCode);
        const deptOk = exam
          ? deptMatchesTrainerScope(exam.department, trainerDepts)
          : true;
        if (exam && !deptOk) {
          skipped.push(`${sopCode} (not in your departments)`);
          continue;
        }
        if (expiredCodes.has(sopCode) || expiredCodes.has(sopCode.toUpperCase())) {
          skipped.push(`${sopCode} (expired — locked)`);
          continue;
        }
        // Assign Exam requires an MCQ bank; Schedule Training still assigns the
        // date so it shows in Sched / filters even before MCQs are ready.
        if (action === 'assign-exam' && !hasExam(sopCode) && !(exam?.bankQuestionCount)) {
          skipped.push(`${sopCode} (no MCQ exam)`);
          continue;
        }

        const eligibleIds: string[] = [];
        let sopName = exam?.sopName || sopCode;
        for (const emp of employees) {
          if (emp.isTrainer) continue;
          if (action === 'assign-exam' && !emp.hasLmsAccess) continue;
          const assigns = assignmentsMap.get(employeeAssignmentKey(emp.department, emp.name)) || [];
          const hit = assigns.find((a) => stripVersion(a.sopCode) === sopCode);
          if (!hit) continue;
          if (hit.derivedFrom) continue;
          if (isSopDocumentExpired(hit.expiryDate)) continue;
          if (hit.sopName) sopName = hit.sopName;
          if (!deptMatchesTrainerScope(emp.department, trainerDepts)) continue;
          eligibleIds.push(emp.employeeId);
        }
        if (eligibleIds.length === 0) {
          skipped.push(
            action === 'assign-exam'
              ? `${sopCode} (no assigned employees with LMS login)`
              : `${sopCode} (no assigned employees)`,
          );
          continue;
        }

        const check = checkEmployeeSelection(eligibleIds, employees, {
          requireLmsAccess: action === 'assign-exam',
        });
        if (!check.ok) {
          skipped.push(`${sopCode} (${check.error})`);
          continue;
        }

        const result = await ScheduledExam.bulkWrite(
          check.employees.map((e) => ({
            updateOne: {
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
                  sopName,
                  scheduledDate: date,
                  month,
                  year,
                  status: 'scheduled',
                  notes,
                },
              },
              upsert: true,
            },
          })),
        );

        scheduled += check.employees.length;
        created += result.upsertedCount ?? 0;
        updated += result.modifiedCount ?? 0;
        perSop.push({
          sopCode,
          sopName,
          employees: check.employees.length,
        });
      }

      if (action === 'assign-exam') {
        bustTrainerScheduleCaches();
        return NextResponse.json({
          ok: true,
          action,
          date: toDateOnlyIso(date!),
          month,
          year,
          scheduled,
          created,
          updated,
          perSop,
          skipped,
        });
      }

      // schedule-training → also file attendance sheets per SOP × department
      let sessions = 0;
      let employeesMarked = 0;
      const attendanceSkipped: string[] = [];
      const attendancePerSop: Array<{
        sopCode: string;
        sopName: string;
        departments: number;
        employees: number;
      }> = [];

      for (const sopCode of sopCodes) {
        if (expiredCodes.has(sopCode) || expiredCodes.has(sopCode.toUpperCase())) {
          continue;
        }
        const byDept = new Map<string, string[]>();
        let sopName = sopCode;
        for (const emp of employees) {
          if (emp.isTrainer) continue;
          const assigns = assignmentsMap.get(employeeAssignmentKey(emp.department, emp.name)) || [];
          const hit = assigns.find((a) => stripVersion(a.sopCode) === sopCode);
          if (!hit) continue;
          if (hit.derivedFrom) continue;
          if (isSopDocumentExpired(hit.expiryDate)) continue;
          if (hit.sopName) sopName = hit.sopName;
          const dept = emp.department;
          if (!deptMatchesTrainerScope(dept, trainerDepts)) continue;
          const list = byDept.get(dept) || [];
          list.push(emp.employeeId);
          byDept.set(dept, list);
        }

        if (byDept.size === 0) {
          attendanceSkipped.push(`${sopCode} (no assigned employees)`);
          continue;
        }

        let empCount = 0;
        for (const [department, ids] of byDept) {
          const resolved = await resolveTrainingSop(sopCode, [department], {
            employees: employees.filter((e) => e.department === department),
          });
          if (!resolved.ok) {
            attendanceSkipped.push(`${sopCode}/${department} (${resolved.error})`);
            continue;
          }
          const check = checkEmployeeSelection(ids, employees);
          if (!check.ok) {
            attendanceSkipped.push(`${sopCode}/${department} (${check.error})`);
            continue;
          }

          const records = check.employees.map((e) => ({
            employeeId: e.employeeId,
            employeeName: e.name,
            designation: e.designation,
            department: e.department,
            employeeCode: e.employeeCode,
            status: 'present' as const,
          }));

          const doc =
            (await TrainingAttendance.findOne({ sopCode, department, trainingDate: date })) ??
            new TrainingAttendance({ sopCode, department, trainingDate: date });

          doc.trainerId = auth.trainer.employeeId;
          doc.trainerName = auth.trainer.name;
          doc.sopName = resolved.sop.sopName || sopName;
          doc.month = monthOfDate(date!);
          doc.year = yearOfDate(date!);
          doc.records = records;
          doc.presentCount = records.length;
          doc.absentCount = 0;
          doc.totalCount = records.length;
          doc.notes = notes
            || (toDateOnlyIso(date!) > new Date().toISOString().slice(0, 10)
              ? 'Planned training session (scheduled from Trainer View)'
              : undefined);
          await doc.save();

          sessions++;
          empCount += records.length;
          employeesMarked += records.length;
        }

        attendancePerSop.push({
          sopCode,
          sopName,
          departments: byDept.size,
          employees: empCount,
        });
      }

      bustTrainerScheduleCaches();
      return NextResponse.json({
        ok: true,
        action,
        date: toDateOnlyIso(date!),
        month,
        year,
        scheduled,
        created,
        updated,
        sessions,
        employeesMarked,
        perSop,
        attendancePerSop,
        skipped: [...skipped, ...attendanceSkipped],
      });
    }

    return NextResponse.json({ error: 'Unsupported action' }, { status: 400 });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
