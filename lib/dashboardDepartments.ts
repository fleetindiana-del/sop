import Department from '@/models/Department';
import { getGroupedRegistryRows } from '@/lib/dashboardRegistrySource';
import { sortByDeptOrder } from '@/lib/sop-utils';

/** Departments that must never appear in LMS / MCQ / exam-settings UI. */
const EXCLUDED_DEPTS = new Set(['other', 'unknown', 'general', 'total', '']);

export function isDashboardDepartmentName(name: string): boolean {
  const t = String(name || '').trim();
  if (!t) return false;
  return !EXCLUDED_DEPTS.has(t.toLowerCase());
}

/**
 * Same department universe as the SOP Dashboard capsules / dropdowns:
 * active (non-obsolete) registry departments ∪ persisted Department names,
 * excluding junk buckets like Other / Unknown.
 */
export async function getDashboardDepartments(): Promise<string[]> {
  const [grouped, persistedDepts] = await Promise.all([
    getGroupedRegistryRows(),
    Department.distinct('name') as Promise<string[]>,
  ]);

  const sopDepts = grouped
    .filter((r) => !r.isObsolete)
    .map((r) => String(r.department || '').trim())
    .filter(isDashboardDepartmentName);

  const extra = (persistedDepts || [])
    .map((d) => String(d || '').trim())
    .filter(isDashboardDepartmentName);

  return sortByDeptOrder([...new Set([...sopDepts, ...extra])]);
}

export function filterToDashboardDepartments(
  names: Iterable<string>,
  allowed: ReadonlySet<string> | readonly string[],
): string[] {
  const allow: ReadonlySet<string> =
    allowed instanceof Set
      ? allowed
      : new Set([...allowed].map((d) => d.toLowerCase()));
  const out: string[] = [];
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!isDashboardDepartmentName(name)) continue;
    if (![...allow].some((a) => a.toLowerCase() === name.toLowerCase())) continue;
    out.push(name);
  }
  return sortByDeptOrder([...new Set(out)]);
}
