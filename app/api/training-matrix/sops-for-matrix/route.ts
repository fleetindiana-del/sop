import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import SOP from '@/models/SOP';
import { sopIdentifierEquivalentRegex } from '@/lib/sopIdentifierNormalize';

export const dynamic = 'force-dynamic';

// GET /api/training-matrix/sops-for-matrix?department=QA&search=QAGE&includeObsolete=1
// Read-only master SOP list for the "assign SOP to matrix" dropdown.
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const { searchParams } = new URL(req.url);
    const department = searchParams.get('department');
    const search = searchParams.get('search');
    const includeObsolete = searchParams.get('includeObsolete') === '1';

    const filter: Record<string, unknown> = { status: 'completed' };
    if (department) filter.department = { $regex: department, $options: 'i' };
    if (!includeObsolete) filter.isObsolete = { $ne: true };
    if (search) {
      filter.$or = [
        { identifier: { $regex: search, $options: 'i' } },
        // Full SOP code: also match other zero-padding spellings (QAGE01-1 ≡ QAGE01-01).
        ...(/^[A-Za-z]{2,6}\d+-\d+$/.test(search.trim())
          ? [{ identifier: sopIdentifierEquivalentRegex(search) }]
          : []),
        { name: { $regex: search, $options: 'i' } },
      ];
    }

    const sops = await SOP.find(filter)
      .select('_id identifier name department version effectiveDate isObsolete')
      .sort({ identifier: 1 })
      .limit(200)
      .lean();

    return NextResponse.json({ sops });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
