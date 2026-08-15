import { invalidateEmployeeAssignmentsCache } from '@/lib/employeeAssignments';
import { invalidateLmsAdminCaches, invalidateLmsServerPrefix } from '@/lib/lmsCache';

/**
 * Drop every cache that can hold a stale view of trainer schedules or rosters:
 * learner dashboards (`lms:me:`), trainer dashboards, asset lists and the
 * derived employee-assignments map.
 */
export function bustTrainerScheduleCaches(): void {
  invalidateEmployeeAssignmentsCache();
  invalidateLmsServerPrefix('lms:me:');
  invalidateLmsServerPrefix('lms:trainer:');
  invalidateLmsServerPrefix('lms:assets:');
  invalidateLmsServerPrefix('lms:dashboard:');
  invalidateLmsAdminCaches();
}
