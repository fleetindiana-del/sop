import { NextResponse } from 'next/server';
import { withActivityLog } from '@/lib/activity-log';

export const dynamic = 'force-dynamic';

// STUB: bulk-assign a SOP into a department matrix for all employees.
async function handlePOST() {
  return NextResponse.json(
    { error: 'Assigning a SOP to the matrix is not wired up yet (stub endpoint).' },
    { status: 501 },
  );
}

export const POST = withActivityLog(handlePOST);
