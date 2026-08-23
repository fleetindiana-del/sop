import TrainingMatrixUpload from '@/models/TrainingMatrixUpload';
import TrainingMatrixRecord from '@/models/TrainingMatrixRecord';
import Employee from '@/models/Employee';

export interface SyncEmployeesResult {
  /** distinct departments the roster was drawn from */
  departments: number;
  /** new employees created */
  inserted: number;
  /** existing employees whose designation / active flag changed */
  updated: number;
  /** inserted + updated */
  upserted: number;
}

interface RosterEntry {
  name: string;
  department: string;
  designation: string;
}

function rosterKey(department: string, name: string): string {
  return `${department}||${name}`.trim().toLowerCase();
}

// The roster sync scans the whole training matrix and issues a bulk upsert on
// every employees-page load, which is wasteful when nothing has changed. Throttle
// it so repeated reads within a short window skip the heavy work.
const SYNC_THROTTLE_MS = 30_000;

declare global {
  // eslint-disable-next-line no-var
  var __lastEmployeeMatrixSyncAt: number | undefined;
}

/**
 * Runs {@link syncEmployeesFromMatrix} at most once per throttle window. Returns
 * `true` when the sync actually ran, `false` when it was skipped. Never throws —
 * a sync hiccup must not block listing employees.
 */
export async function syncEmployeesFromMatrixThrottled(): Promise<boolean> {
  const now = Date.now();
  const last = global.__lastEmployeeMatrixSyncAt ?? 0;
  if (now - last < SYNC_THROTTLE_MS) return false;
  global.__lastEmployeeMatrixSyncAt = now;
  try {
    await syncEmployeesFromMatrix();
    return true;
  } catch (err) {
    // Allow a retry on the next request rather than waiting out the window.
    global.__lastEmployeeMatrixSyncAt = last;
    console.error('Auto-sync from matrix failed:', err);
    return false;
  }
}

/**
 * Mirrors the live training-matrix roster into the Employee collection.
 *
 * The matrix is the source of truth for *who* exists; this copies that roster
 * over so the Employee page always reflects it. It only ADDS new people and
 * UPDATES designation — it never removes, deactivates, or re-activates anybody.
 * "Mark as Left" (isActive: false) must persist even if that person is still
 * on the training-matrix roster. New inserts default to active.
 *
 * Source of truth, matching what the matrix page shows:
 *   1. TrainingMatrixRecord  (per-cell records, the live matrix)
 *   2. TrainingMatrixUpload.snapshot.employees  (uploaded snapshots)
 */
export async function syncEmployeesFromMatrix(): Promise<SyncEmployeesResult> {
  const roster = new Map<string, RosterEntry>();

  const upsertRoster = (rawDept: string, rawName: string, rawDesig: string) => {
    const name = String(rawName || '').trim();
    const department = String(rawDept || '').trim();
    if (!name || !department) return;
    const key = rosterKey(department, name);
    const designation = String(rawDesig || '').trim();
    const existing = roster.get(key);
    if (!existing) {
      roster.set(key, { name, department, designation });
    } else if (!existing.designation && designation) {
      // keep the first non-empty designation we encounter
      existing.designation = designation;
    }
  };

  // 1. Live matrix records (skip 'na' so the roster matches the matrix view).
  const records = await TrainingMatrixRecord.find({ status: { $ne: 'na' } })
    .select('employeeName department designation')
    .lean();
  for (const r of records as Array<{ employeeName?: string; department?: string; designation?: string }>) {
    upsertRoster(r.department || '', r.employeeName || '', r.designation || '');
  }

  // 2. Uploaded snapshots — latest upload per department.
  const uploads = await TrainingMatrixUpload.find({
    fileType: 'main',
    'snapshot.employees': { $exists: true, $not: { $size: 0 } },
  })
    .sort({ uploadedAt: -1 })
    .lean();

  const seenDept = new Set<string>();
  for (const up of uploads as Array<{
    department?: string;
    snapshot?: { employees?: Array<{ name?: string; designation?: string }> };
  }>) {
    const dept = String(up.department || '').trim();
    if (!dept || seenDept.has(dept)) continue;
    seenDept.add(dept);
    for (const emp of up.snapshot?.employees || []) {
      upsertRoster(dept, emp.name || '', emp.designation || '');
    }
  }

  if (roster.size === 0) {
    return { departments: 0, inserted: 0, updated: 0, upserted: 0 };
  }

  const departments = new Set<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ops: any[] = [];
  for (const { name, department, designation } of roster.values()) {
    departments.add(department);
    // When the matrix has a designation, write it on both insert and update.
    // When it's blank, only seed it on insert so an existing one isn't wiped.
    // (A field may not appear in both $set and $setOnInsert.)
    // Never $set isActive — that was re-activating people marked Left.
    const setOnInsert: Record<string, unknown> = { name, department, isActive: true };
    const update: Record<string, unknown> = { $setOnInsert: setOnInsert };
    if (designation) {
      update.$set = { designation };
    } else {
      setOnInsert.designation = '';
    }
    ops.push({
      updateOne: {
        filter: { name, department },
        update,
        upsert: true,
      },
    });
  }

  const result = await Employee.bulkWrite(ops, { ordered: false });
  const inserted = result.upsertedCount || 0;
  const updated = result.modifiedCount || 0;

  return {
    departments: departments.size,
    inserted,
    updated,
    upserted: inserted + updated,
  };
}
