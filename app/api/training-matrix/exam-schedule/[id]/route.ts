import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireAuth } from '@/lib/withAuth';
import TrainingExamSchedule from '@/models/TrainingExamSchedule';
import { invalidateEmployeeAssignmentsCache } from '@/lib/employeeAssignments';
import {
  parseDateOnly,
  monthOfDate,
  yearOfDate,
  serializeSchedule,
  toDateOnlyIso,
  MONTH_NAMES,
} from '@/lib/trainingExamSchedule';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/training-matrix/exam-schedule/[id]
// Body: { examDate?: string, status?: 'cancelled' | 'scheduled' | 'completed', updatedBy? }
export async function PATCH(req: NextRequest, context: Ctx) {
  try {
    const auth = await requireAuth(['admin']);
    if (auth.error) return auth.error;

    await connectDB();
    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: 'id is required' }, { status: 400 });
    }

    // Inherited synthetic ids cannot be patched — client should POST an override
    if (id.startsWith('inherited:')) {
      return NextResponse.json(
        { error: 'Cannot patch an inherited event; create an employee override instead' },
        { status: 400 },
      );
    }

    const body = await req.json();
    const doc = await TrainingExamSchedule.findById(id);
    if (!doc || doc.status === 'cancelled') {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    const updatedBy =
      body.updatedBy ||
      auth.session?.user?.username ||
      auth.session?.user?.name ||
      'manage-sop-calendar';

    if (body.status === 'cancelled') {
      doc.status = 'cancelled';
      doc.updatedBy = updatedBy;
      await doc.save();
      invalidateEmployeeAssignmentsCache();
      return NextResponse.json({ schedule: serializeSchedule(doc.toObject()), cancelled: true });
    }

    if (body.examDate) {
      const examDate = parseDateOnly(String(body.examDate));
      if (!examDate) {
        return NextResponse.json({ error: 'examDate must be YYYY-MM-DD' }, { status: 400 });
      }
      const allowOutside = body.allowOutsideMonth === true;
      const dateMonth = monthOfDate(examDate);
      const dateYear = yearOfDate(examDate);
      if (!allowOutside && (dateMonth !== doc.plannedMonth || dateYear !== doc.year)) {
        return NextResponse.json(
          {
            error: `Exam date must stay within ${MONTH_NAMES[doc.plannedMonth]} ${doc.year} (got ${toDateOnlyIso(examDate)}). Pass allowOutsideMonth to override.`,
            plannedMonth: doc.plannedMonth,
            year: doc.year,
          },
          { status: 400 },
        );
      }
      doc.examDate = examDate;
    }

    if (body.status === 'scheduled' || body.status === 'completed') {
      doc.status = body.status;
    }

    doc.updatedBy = updatedBy;
    await doc.save();
    invalidateEmployeeAssignmentsCache();

    return NextResponse.json({ schedule: serializeSchedule(doc.toObject()) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE — soft-cancel
export async function DELETE(req: NextRequest, context: Ctx) {
  try {
    const auth = await requireAuth(['admin']);
    if (auth.error) return auth.error;

    await connectDB();
    const { id } = await context.params;
    if (!id || id.startsWith('inherited:')) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 });
    }

    const doc = await TrainingExamSchedule.findById(id);
    if (!doc) {
      return NextResponse.json({ error: 'Schedule not found' }, { status: 404 });
    }

    doc.status = 'cancelled';
    doc.updatedBy =
      auth.session?.user?.username || auth.session?.user?.name || 'manage-sop-calendar';
    await doc.save();
    invalidateEmployeeAssignmentsCache();

    return NextResponse.json({ ok: true, cancelled: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
