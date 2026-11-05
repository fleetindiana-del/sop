import { NextResponse } from 'next/server';
import { withActivityLog } from '@/lib/activity-log';

export const dynamic = 'force-dynamic';

// STUB: Excel upload that replaces the matrix. Not wired to a database yet.
async function handlePOST() {
  return NextResponse.json(
    { success: false, error: 'Training Matrix upload is not wired up yet (stub endpoint).' },
    { status: 501 },
  );
}

export const POST = withActivityLog(handlePOST);
