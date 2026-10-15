import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import MatrixSOPAssignment from '@/models/MatrixSOPAssignment';
import { canonicalSopIdentifier, sopIdentifierEquivalentRegex } from '@/lib/sopIdentifierNormalize';
import SOP from '@/models/SOP';

export const dynamic = 'force-dynamic';

// GET /api/training-matrix/matrix-sop?department=QA&month=5&year=2025
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const { searchParams } = new URL(req.url);
    const department = searchParams.get('department');
    const month = searchParams.get('month');
    const year = searchParams.get('year');
    const includeInactive = searchParams.get('includeInactive') === '1';

    const filter: Record<string, unknown> = {};
    if (department) filter.department = department;
    if (month) filter.effectiveMonth = parseInt(month, 10);
    if (year) filter.effectiveYear = parseInt(year, 10);
    if (!includeInactive) filter.isActive = true;

    const assignments = await MatrixSOPAssignment.find(filter)
      .sort({ department: 1, sopCode: 1 })
      .lean();

    return NextResponse.json({ assignments });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/training-matrix/matrix-sop — assign a SOP from the master DB into a department matrix
export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const body = await req.json();
    const { department, sopId, effectiveMonth, effectiveYear, designationApplicability, createdBy } = body;

    if (!department || !sopId || !effectiveMonth || !effectiveYear || !createdBy) {
      return NextResponse.json(
        { error: 'department, sopId, effectiveMonth, effectiveYear, and createdBy are required' },
        { status: 400 },
      );
    }

    // Fetch SOP metadata from master DB — no manual entry allowed
    const sop = await SOP.findById(sopId).lean();
    if (!sop) {
      return NextResponse.json({ error: 'SOP not found in master database' }, { status: 404 });
    }

    // Check for duplicate active assignment
    const existing = await MatrixSOPAssignment.findOne({
      department,
      sopCode: sopIdentifierEquivalentRegex(sop.identifier),
      isActive: true,
    });
    if (existing) {
      return NextResponse.json(
        { error: `SOP ${sop.identifier} is already assigned to the ${department} matrix` },
        { status: 409 },
      );
    }

    const assignment = await MatrixSOPAssignment.create({
      department,
      sopId: sop._id,
      sopCode: canonicalSopIdentifier(sop.identifier),
      sopName: sop.name,
      effectiveMonth: parseInt(effectiveMonth, 10),
      effectiveYear: parseInt(effectiveYear, 10),
      designationApplicability: designationApplicability ?? [],
      isActive: true,
      createdBy,
    });

    return NextResponse.json({ assignment }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Duplicate key from unique index
    if (msg.includes('duplicate key') || msg.includes('E11000')) {
      return NextResponse.json(
        { error: 'This SOP is already assigned to this department matrix' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
