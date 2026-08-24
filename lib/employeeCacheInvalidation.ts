/* ─── Employee-derived cache invalidation ────────────────────────────────────
 * Single place that drops every cache whose contents are computed from
 * Employee Master, so any change to an employee's identity (name, designation,
 * department, trainer scope, left/active) reflects instantly in:
 *   - the Employees page + employee→SOP assignment map
 *   - the training matrix and induction training matrix    (grids + filters)
 *   - the manage-SOPs view                                 (designation rosters)
 *   - the LMS admin views                                  (meta, training status,
 *                                                           employee training)
 *   - trainer dashboards, rosters, schedulers and learner dashboards
 *
 * Mirrors `sopCacheInvalidation.ts`. Server-only: it pulls Mongoose models
 * transitively.
 */
import { invalidateEmployeeMasterIndex } from "@/lib/employeeMaster";
import { invalidateEmployeeAssignmentsCache } from "@/lib/employeeAssignments";
import { invalidateLmsAdminCaches, invalidateLmsServerPrefix } from "@/lib/lmsCache";
import { invalidateManageSopViewCache } from "@/lib/manageSopViewCache";
import { invalidateTrainingMatrixCache } from "@/lib/trainingMatrixCache";
import { invalidateInductionTrainingMatrixCache } from "@/lib/inductionTrainingMatrixCache";

/**
 * Invalidate every employee-derived cache. In-memory caches are cleared
 * synchronously; durable MongoDB snapshots are marked stale best-effort and
 * fired-and-forgotten so callers stay synchronous and a cache hiccup never
 * fails the underlying write.
 *
 * Call this from ANY write that changes who an employee is. Designation is the
 * field most likely to be missed: it is denormalised into matrix rows, filter
 * dropdowns and trainer rosters, so a designation-only edit needs exactly the
 * same fan-out as a department change or a Mark-as-Left.
 */
export function invalidateEmployeeDerivedCaches(): void {
  // The live name/designation/department lookup every read path resolves through.
  invalidateEmployeeMasterIndex();

  // Employee→SOP assignment map is keyed by department||name and carries
  // designation-driven applicability.
  invalidateEmployeeAssignmentsCache();

  // LMS server caches that embed employee identity: admin meta / training
  // status / employee training, trainer dashboards and rosters, learner
  // dashboards and asset lists.
  invalidateLmsAdminCaches();
  invalidateLmsServerPrefix("lms:trainer:");
  invalidateLmsServerPrefix("lms:me:");
  invalidateLmsServerPrefix("lms:assets:");
  invalidateLmsServerPrefix("lms:dashboard:");

  // Matrix + manage-SOPs overviews keep durable snapshots; their invalidators
  // are async (they touch MongoDB). Run them in the background.
  void Promise.allSettled([
    invalidateTrainingMatrixCache(),
    invalidateInductionTrainingMatrixCache(),
    invalidateManageSopViewCache(),
  ]);
}

/** Employee identity fields whose change must trigger the full fan-out. */
export const EMPLOYEE_IDENTITY_FIELDS = [
  "name",
  "designation",
  "department",
  "employeeId",
  "isActive",
  "isTrainer",
  "trainerDepartments",
] as const;

/** True when `update` touches any field that other modules denormalise. */
export function touchesEmployeeIdentity(update: Record<string, unknown>): boolean {
  return EMPLOYEE_IDENTITY_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(update, field),
  );
}
