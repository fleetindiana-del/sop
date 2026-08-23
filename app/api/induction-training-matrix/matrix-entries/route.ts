import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import InductionMatrixEntryData from '@/models/InductionMatrixEntryData';
import { getLeftEmployeeKeys, isLeftEmployee } from '@/lib/leftEmployees';

export const dynamic = 'force-dynamic';

// GET /api/induction-training-matrix/matrix-entries?department=QA&month=5&year=2025&employee=John&sopCode=QAGE01
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const { searchParams } = new URL(req.url);
    const department  = searchParams.get('department');
    const month       = searchParams.get('month');
    const year        = searchParams.get('year');
    const employee    = searchParams.get('employee');
    const sopCode     = searchParams.get('sopCode');
    const includeDeleted = searchParams.get('includeDeleted') === '1';

    const filter: Record<string, unknown> = {};
    if (department) filter.department = department;
    if (month)      filter.month = parseInt(month, 10);
    if (year)       filter.year = parseInt(year, 10);
    if (employee)   filter.employeeName = { $regex: employee, $options: 'i' };
    if (sopCode)    filter.sopCode = sopCode.toUpperCase();
    if (!includeDeleted) filter.deletedAt = { $exists: false };

    const [entriesRaw, leftKeys] = await Promise.all([
      InductionMatrixEntryData.find(filter)
        .sort({ employeeName: 1, sopCode: 1 })
        .lean<Array<{ department?: string; employeeName?: string }>>(),
      getLeftEmployeeKeys(),
    ]);
    const entries = entriesRaw.filter(
      (e) => !isLeftEmployee(leftKeys, e.department, e.employeeName),
    );

    return NextResponse.json({ entries });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/induction-training-matrix/matrix-entries — create a single matrix entry
export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const body = await req.json();
    const {
      department, employeeName, designation, sopCode, sopAssignmentId,
      month, year, trainingStatus, qualificationStatus,
      trainingDate, retrainingDate, trainerName, evaluationResult,
      competencyStatus, remarks, createdBy,
    } = body;

    if (!department || !employeeName || !sopCode || !month || !year || !createdBy) {
      return NextResponse.json(
        { error: 'department, employeeName, sopCode, month, year, and createdBy are required' },
        { status: 400 },
      );
    }

    const entry = await InductionMatrixEntryData.create({
      department,
      employeeName,
      designation: designation ?? '',
      sopCode: String(sopCode).toUpperCase(),
      sopAssignmentId,
      month: parseInt(month, 10),
      year: parseInt(year, 10),
      trainingStatus: trainingStatus ?? 'not_started',
      qualificationStatus: qualificationStatus ?? 'pending',
      trainingDate: trainingDate ? new Date(trainingDate) : undefined,
      retrainingDate: retrainingDate ? new Date(retrainingDate) : undefined,
      trainerName,
      evaluationResult,
      competencyStatus,
      remarks,
      createdBy,
    });

    return NextResponse.json({ entry }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('duplicate key') || msg.includes('E11000')) {
      return NextResponse.json(
        { error: 'A matrix entry for this employee/SOP/month/year already exists' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// PUT /api/induction-training-matrix/matrix-entries — upsert or bulk-update entries
// Body: { entries: [...], updatedBy: string }  OR single entry update with { id, ...fields, updatedBy }
export async function PUT(req: NextRequest) {
  try {
    await connectDB();
    const body = await req.json();

    // Bulk upsert mode
    if (Array.isArray(body.entries)) {
      const { entries, updatedBy } = body;
      if (!updatedBy) return NextResponse.json({ error: 'updatedBy is required' }, { status: 400 });

      const ops = entries.map((e: Record<string, unknown>) => ({
        updateOne: {
          filter: {
            employeeName: e.employeeName,
            sopCode: String(e.sopCode).toUpperCase(),
            month: parseInt(String(e.month), 10),
            year: parseInt(String(e.year), 10),
            department: e.department,
            deletedAt: { $exists: false },
          },
          update: {
            $set: {
              designation:         e.designation ?? '',
              sopAssignmentId:     e.sopAssignmentId,
              trainingStatus:      e.trainingStatus ?? 'not_started',
              qualificationStatus: e.qualificationStatus ?? 'pending',
              trainingDate:        e.trainingDate ? new Date(e.trainingDate as string) : undefined,
              retrainingDate:      e.retrainingDate ? new Date(e.retrainingDate as string) : undefined,
              trainerName:         e.trainerName,
              evaluationResult:    e.evaluationResult,
              competencyStatus:    e.competencyStatus,
              remarks:             e.remarks,
              updatedBy,
            },
            $setOnInsert: {
              createdBy: updatedBy,
            },
          },
          upsert: true,
        },
      }));

      const result = await InductionMatrixEntryData.bulkWrite(ops);
      return NextResponse.json({
        upserted: result.upsertedCount,
        modified: result.modifiedCount,
      });
    }

    // Single entry update by id
    const { id, updatedBy, ...fields } = body;
    if (!id || !updatedBy) {
      return NextResponse.json({ error: 'id and updatedBy are required for single update' }, { status: 400 });
    }

    const allowedFields = [
      'trainingStatus', 'qualificationStatus', 'trainingDate', 'retrainingDate',
      'trainerName', 'evaluationResult', 'competencyStatus', 'remarks', 'designation',
    ];
    const update: Record<string, unknown> = { updatedBy };
    for (const f of allowedFields) {
      if (fields[f] !== undefined) {
        update[f] = (f === 'trainingDate' || f === 'retrainingDate') && fields[f]
          ? new Date(fields[f] as string)
          : fields[f];
      }
    }

    const entry = await InductionMatrixEntryData.findByIdAndUpdate(
      id,
      { $set: update },
      { returnDocument: 'after' },
    );
    if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });

    return NextResponse.json({ entry });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/induction-training-matrix/matrix-entries?id=xxx&deletedBy=admin  (soft delete)
export async function DELETE(req: NextRequest) {
  try {
    await connectDB();
    const { searchParams } = new URL(req.url);
    const id        = searchParams.get('id');
    const deletedBy = searchParams.get('deletedBy') || 'system';

    if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

    const entry = await InductionMatrixEntryData.findByIdAndUpdate(
      id,
      { $set: { deletedAt: new Date(), deletedBy } },
      { returnDocument: 'after' },
    );
    if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 });

    return NextResponse.json({ message: 'Entry deleted', entry });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
