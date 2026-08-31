/* ─── User access cache invalidation ─────────────────────────────────────────
 * The login half of a person — role, assigned departments, designation, the
 * Trainer flag and page access. Mirrors `employeeCacheInvalidation.ts`, which
 * covers the Employee Master half.
 *
 * A role change (Trainer → Viewer, say) is not only a label on Login &
 * Passwords: it decides who appears in the trainer directory
 * (`lib/lmsTrainerDirectory.ts` matches `role: 'trainer'` OR `isTrainer`), which
 * rosters and dashboards a person owns, and which pages they may reach. Those
 * reads sit behind short-lived server caches, so without this fan-out the old
 * designation keeps being served until each cache's TTL runs out.
 *
 * Call it from ANY write that changes a user's role, departments, designation,
 * trainer flag or page access. New caches derived from `User` must be wired in
 * here. Server-only: it pulls Mongoose models transitively.
 */
import { bustTrainerScheduleCaches } from "@/lib/lmsTrainerCache";

export function invalidateUserAccessCaches(): void {
  // Trainer dashboards and rosters, LMS admin views, learner dashboards and the
  // derived employee-assignments map. The Employee-side fan-out
  // (`invalidateEmployeeDerivedCaches`) is already fired by
  // `syncEmployeeTrainerFlag` when the flag reaches an employee record.
  bustTrainerScheduleCaches();
}
