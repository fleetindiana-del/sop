import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import MatrixSOPAssignment from '@/models/MatrixSOPAssignment';
import MatrixEntryData from '@/models/MatrixEntryData';

export const dynamic = 'force-dynamic';

// PATCH /api/training-matrix/matrix-sop/[id] — update designation applicability or active status
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await connectDB();
    const { id } = await params;
    const body = await req.json();
    const { designationApplicability, isActive, updatedBy } = body;

    if (!updatedBy) {
      return NextResponse.json({ error: 'updatedBy is required' }, { status: 400 });
    }

    const update: Record<string, unknown> = { updatedBy };
    if (designationApplicability !== undefined) update.designationApplicability = designationApplicability;
    if (isActive !== undefined) update.isActive = isActive;

    const assignment = await MatrixSOPAssignment.findByIdAndUpdate(
      id,
      { $set: update },
      { returnDocument: 'after' },
    );
    if (!assignment) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
    }

    return NextResponse.json({ assignment });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// DELETE /api/training-matrix/matrix-sop/[id] — soft-delete: mark inactive, preserve audit data
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await connectDB();
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const deletedBy = searchParams.get('deletedBy') || 'system';

    const assignment = await MatrixSOPAssignment.findById(id);
    if (!assignment) {
      return NextResponse.json({ error: 'Assignment not found' }, { status: 404 });
    }

    // Soft delete: mark inactive and record who/when
    assignment.isActive = false;
    assignment.deletedAt = new Date();
    assignment.deletedBy = deletedBy;
    await assignment.save();

    // Also soft-delete all matrix entry data for this SOP assignment
    await MatrixEntryData.updateMany(
      { sopCode: assignment.sopCode, department: assignment.department, deletedAt: { $exists: false } },
      { $set: { deletedAt: new Date(), deletedBy } },
    );

    return NextResponse.json({ message: `SOP ${assignment.sopCode} removed from ${assignment.department} matrix` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
