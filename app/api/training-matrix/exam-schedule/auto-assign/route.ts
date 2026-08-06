import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireAuth } from '@/lib/withAuth';
import TrainingExamSchedule from '@/models/TrainingExamSchedule';
import { invalidateEmployeeAssignmentsCache } from '@/lib/employeeAssignments';
import {
  loadMonthRequirements,
  deptScheduleKey,
  pickAutoAssignDates,
  serializeSchedule,
  MONTH_NAMES,
} from '@/lib/trainingExamSchedule';

export const dynamic = 'force-dynamic';

// POST /api/training-matrix/exam-schedule/auto-assign
// Body: { year: number, month?: number, createdBy?: string }
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(['admin', 'trainer']);
    if (auth.error) return auth.error;

    await connectDB();
    const body = await req.json().catch(() => ({}));
    const year = Number(body.year) || new Date().getFullYear();
    const month = body.month != null ? Number(body.month) : undefined;
    const createdBy =
      body.createdBy ||
      auth.session?.user?.username ||
      auth.session?.user?.name ||
      'manage-sop-calendar';

    const requirements = await loadMonthRequirements(year, month);

    const scheduleFilter: Record<string, unknown> = {
      year,
      scope: 'department',
      status: { $ne: 'cancelled' },
    };
    if (month) scheduleFilter.plannedMonth = month;

    const existing = await TrainingExamSchedule.find(scheduleFilter).lean();
    const assignedKeys = new Set(
      existing.map((s) =>
        deptScheduleKey(s.sopCode, s.department, s.year, s.plannedMonth),
      ),
    );

    const unassigned = requirements.filter(
      (r) => !assignedKeys.has(deptScheduleKey(r.sopCode, r.department, r.year, r.plannedMonth)),
    );

    if (!unassigned.length) {
      return NextResponse.json({
        created: 0,
        schedules: [],
        message: month
          ? `Nothing to assign — all trainings in ${MONTH_NAMES[month]} already have dates`
          : 'Nothing to assign — all trainings already have dates',
      });
    }

    const picks = pickAutoAssignDates(
      unassigned,
      existing.map((s) => ({
        plannedMonth: s.plannedMonth,
        examDate: s.examDate as Date,
      })),
    );

    const created = [];
    for (const pick of picks) {
      const doc = await TrainingExamSchedule.findOneAndUpdate(
        {
          sopCode: pick.sopCode,
          department: pick.department,
          year: pick.year,
          plannedMonth: pick.plannedMonth,
          scope: 'department',
          status: { $ne: 'cancelled' },
        },
        {
          $set: {
            sopCode: pick.sopCode,
            sopName: pick.sopName,
            department: pick.department,
            year: pick.year,
            plannedMonth: pick.plannedMonth,
            examDate: pick.examDate,
            scope: 'department',
            status: 'scheduled',
            updatedBy: createdBy,
          },
          $setOnInsert: { createdBy },
        },
        { upsert: true, returnDocument: 'after' },
      );
      if (doc) created.push(serializeSchedule(doc.toObject()));
    }

    invalidateEmployeeAssignmentsCache();

    return NextResponse.json({
      created: created.length,
      schedules: created,
      message: `Auto-assigned ${created.length} training${created.length === 1 ? '' : 's'}`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
