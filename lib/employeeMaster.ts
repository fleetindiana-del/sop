/**
 * Employee Master is the single source of truth for an employee's *current*
 * identity (name, designation, department).
 *
 * Every other collection that carries a `designation` column holds either
 *   a) a historical snapshot that must never be rewritten
 *      (TrainingMatrixRecord, MatrixEntryData, Certificate, PracticalAssessment,
 *      TrainingAttendance.records), or
 *   b) a denormalised convenience copy that must be re-resolved on read
 *      (TrainerEmployee, ScheduledExam, matrix grid rows, filter dropdowns).
 *
 * This module serves (b): a short-lived lookup of the live designation, keyed
 * both by `department||name` (how the Excel-derived collections identify a
 * person) and by `Employee._id` (how the LMS collections do).
 */

import Employee from '@/models/Employee';
import { connectDB } from '@/lib/mongodb';
import { canonTrainingMatrixDepartment } from '@/lib/trainingMatrixDepartments';

export interface EmployeeMasterEntry {
  id: string;
  name: string;
  department: string;
  designation: string;
  isActive: boolean;
}

export interface EmployeeMasterIndex {
  /** canonical `department||name` (lowercased) → live record */
  byIdentity: Map<string, EmployeeMasterEntry>;
  /** `Employee._id` → live record */
  byId: Map<string, EmployeeMasterEntry>;
  /** Every distinct designation currently in use, sorted. */
  designations: string[];
  /** canonical department → sorted designations currently in use there. */
  designationsByDepartment: Map<string, string[]>;
}

/** Same identity key the matrix / Manage SOP / left-employee lookups use. */
export function employeeMasterKey(department: string, name: string): string {
  const dept = canonTrainingMatrixDepartment(department) || String(department || '').trim();
  return `${dept}||${name}`.trim().toLowerCase();
}

// The index is rebuilt on demand and dropped by invalidateEmployeeMasterIndex(),
// so a designation edit is visible on the very next request rather than after a TTL.
const INDEX_TTL_MS = 30_000;

interface IndexCache {
  value: EmployeeMasterIndex;
  expiresAt: number;
}

declare global {
  var __employeeMasterIndex: IndexCache | undefined;
  var __employeeMasterIndexInFlight: Promise<EmployeeMasterIndex> | undefined;
}

/**
 * Live name/designation/department for every employee, including inactive ones —
 * a person marked Left still has to render with their final designation on the
 * screens that list them.
 */
export async function getEmployeeMasterIndex(): Promise<EmployeeMasterIndex> {
  const cached = globalThis.__employeeMasterIndex;
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const existing = globalThis.__employeeMasterIndexInFlight;
  if (existing) return existing;

  const promise = (async (): Promise<EmployeeMasterIndex> => {
    try {
      await connectDB();
      const rows = await Employee.find({})
        .select('_id name department designation isActive')
        .lean<Array<{
          _id: unknown;
          name?: string;
          department?: string;
          designation?: string;
          isActive?: boolean;
        }>>();

      const byIdentity = new Map<string, EmployeeMasterEntry>();
      const byId = new Map<string, EmployeeMasterEntry>();
      const designations = new Set<string>();
      const perDept = new Map<string, Set<string>>();

      for (const row of rows) {
        const name = String(row.name || '').trim();
        const department = String(row.department || '').trim();
        const designation = String(row.designation || '').trim();
        if (!name || !department) continue;

        const entry: EmployeeMasterEntry = {
          id: String(row._id),
          name,
          department,
          designation,
          isActive: row.isActive !== false,
        };
        byId.set(entry.id, entry);

        const canonKey = employeeMasterKey(department, name);
        const rawKey = `${department}||${name}`.trim().toLowerCase();
        const prior = byIdentity.get(canonKey);
        // The collection has no unique (name, department) index. Prefer the
        // active row so a stale duplicate cannot mask a live designation.
        if (!prior || (!prior.isActive && entry.isActive)) {
          byIdentity.set(canonKey, entry);
          byIdentity.set(rawKey, entry);
        }

        if (designation && entry.isActive) {
          designations.add(designation);
          const canonDept = canonTrainingMatrixDepartment(department) || department;
          if (!perDept.has(canonDept)) perDept.set(canonDept, new Set<string>());
          perDept.get(canonDept)!.add(designation);
        }
      }

      const designationsByDepartment = new Map<string, string[]>();
      for (const [dept, set] of perDept) {
        designationsByDepartment.set(dept, [...set].sort());
      }

      const value: EmployeeMasterIndex = {
        byIdentity,
        byId,
        designations: [...designations].sort(),
        designationsByDepartment,
      };
      globalThis.__employeeMasterIndex = { value, expiresAt: Date.now() + INDEX_TTL_MS };
      return value;
    } finally {
      globalThis.__employeeMasterIndexInFlight = undefined;
    }
  })();

  globalThis.__employeeMasterIndexInFlight = promise;
  return promise;
}

export function invalidateEmployeeMasterIndex(): void {
  globalThis.__employeeMasterIndex = undefined;
}

/**
 * Current designation for a person, falling back to the stored (historical)
 * value only when Employee Master has no record of them — e.g. an Excel-only
 * roster row that was never mirrored into the Employee collection.
 */
export function currentDesignation(
  index: EmployeeMasterIndex,
  department: string | undefined | null,
  name: string | undefined | null,
  fallback?: string | null,
): string {
  const dept = String(department || '').trim();
  const person = String(name || '').trim();
  if (dept && person) {
    const hit =
      index.byIdentity.get(employeeMasterKey(dept, person)) ||
      index.byIdentity.get(`${dept}||${person}`.trim().toLowerCase());
    if (hit && hit.designation) return hit.designation;
  }
  return String(fallback || '').trim();
}

/** Current designation for an `Employee._id`, with the stored value as fallback. */
export function currentDesignationById(
  index: EmployeeMasterIndex,
  employeeId: string | undefined | null,
  fallback?: string | null,
): string {
  const hit = index.byId.get(String(employeeId || '').trim());
  if (hit && hit.designation) return hit.designation;
  return String(fallback || '').trim();
}

/**
 * Identity keys of everyone currently holding `designation`. Filtering the
 * historical collections by their own stored designation would miss people who
 * have since been re-designated, so filters resolve names through this instead.
 */
export function identityKeysForDesignation(
  index: EmployeeMasterIndex,
  designation: string,
  department?: string | null,
): { keys: Set<string>; names: string[] } {
  const wanted = String(designation || '').trim().toLowerCase();
  const dept = String(department || '').trim();
  const canonDept = dept ? canonTrainingMatrixDepartment(dept) || dept : '';
  const keys = new Set<string>();
  const names = new Set<string>();
  if (!wanted) return { keys, names: [] };

  for (const entry of index.byId.values()) {
    if (entry.designation.trim().toLowerCase() !== wanted) continue;
    if (canonDept) {
      const entryDept = canonTrainingMatrixDepartment(entry.department) || entry.department;
      if (entryDept.toLowerCase() !== canonDept.toLowerCase()) continue;
    }
    keys.add(employeeMasterKey(entry.department, entry.name));
    keys.add(`${entry.department}||${entry.name}`.trim().toLowerCase());
    names.add(entry.name);
  }
  return { keys, names: [...names] };
}
