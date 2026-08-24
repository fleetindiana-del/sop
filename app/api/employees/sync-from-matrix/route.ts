import { NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { syncEmployeesFromMatrix } from '@/lib/syncEmployeesFromMatrix';
import { invalidateEmployeeDerivedCaches } from '@/lib/employeeCacheInvalidation';

export const dynamic = 'force-dynamic';

// POST /api/employees/sync-from-matrix
// Mirrors the training-matrix roster into the Employee collection: ADDS people
// only. It never overwrites the name / designation / department of somebody
// already in Employee Master (that is the source of truth for current identity)
// and never re-activates anyone marked Left.
// Note: this now also runs automatically on every GET /api/employees, so the
// employee page stays in sync without anyone pressing a button. Kept for
// explicit/manual triggers and backwards compatibility.
export async function POST() {
  try {
    await connectDB();
    const result = await syncEmployeesFromMatrix();
    if (result.upserted > 0) invalidateEmployeeDerivedCaches();

    if (result.departments === 0) {
      return NextResponse.json(
        { success: false, error: 'No training matrix data found. Please upload training matrix files first.' },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, ...result });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
