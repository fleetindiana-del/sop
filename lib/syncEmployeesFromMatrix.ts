import TrainingMatrixUpload from '@/models/TrainingMatrixUpload';
import TrainingMatrixRecord from '@/models/TrainingMatrixRecord';
import Employee from '@/models/Employee';
import { invalidateEmployeeMasterIndex } from '@/lib/employeeMaster';

export interface SyncEmployeesResult {
  /** distinct departments the roster was drawn from */
  departments: number;
  /** new employees created */
  inserted: number;
  /** existing employees touched by the upsert (identity fields are never overwritten) */
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
 * over so the Employee page always reflects it. It only ADDS new people — it
 * never overwrites the identity of somebody already in Employee Master, and
 * never removes, deactivates, or re-activates anybody.
 *
 * Employee Master is the single source of truth for a person's CURRENT name,
 * designation and department. Matrix rows carry the designation held when each
 * row was recorded, so writing them back silently reverted admin edits.
 * Designation is therefore seeded on insert only.
 *
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
    // Seed designation on INSERT ONLY. The matrix carries the designation a
    // person held when each row was recorded, so $set-ing it here reverted every
    // designation change made in Employee Master the next time this sync ran
    // (within 30s of any Employees-page load or trainer request). Employee
    // Master owns the current designation; the matrix owns history.
    // Never $set isActive either — that was re-activating people marked Left.
    const setOnInsert: Record<string, unknown> = {
      name,
      department,
      isActive: true,
      designation,
    };
    const update: Record<string, unknown> = { $setOnInsert: setOnInsert };
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

  // New people must appear in the Employee Master lookup the read paths use.
  if (inserted > 0 || updated > 0) invalidateEmployeeMasterIndex();

  return {
    departments: departments.size,
    inserted,
    updated,
    upserted: inserted + updated,
  };
}
