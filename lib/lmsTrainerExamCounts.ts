/**
 * SOP-wise exam counts for the trainer dashboard.
 *
 * A department month with 4 SOP exams and 20 employees is 4 exams, not 80.
 * The same SOP assigned to many people (or listed in more than one selected
 * month) is counted once.
 */

export type ExamSittingLike = {
  month: number;
  sopCode: string;
  status: 'completed' | 'pending' | 'overdue';
  isIgnored?: boolean;
  sopName?: string;
};

export type UniqueSopListItem = {
  sopCode: string;
  sopName: string;
  kind: 'completed' | 'remaining' | 'ignored';
  months: number[];
  /** Employee sittings that contributed (department month view). */
  sittingCount: number;
};

export type SopExamBucket = {
  /** Unique live SOP exams (ignored-only SOPs are excluded). */
  total: number;
  /** Unique SOPs where every live sitting is completed. */
  completed: number;
  /** Unique SOPs still outstanding (not fully completed). */
  remaining: number;
  /** Unique SOPs with at least one pending sitting (subset of remaining). */
  pending: number;
  /** Unique SOPs with at least one overdue sitting (subset of remaining). */
  overdue: number;
  /** Unique SOPs that appear only as pre-cycle / ignored sittings. */
  ignored: number;
};

type SopAgg = {
  completed: number;
  pending: number;
  overdue: number;
  ignored: number;
};

function emptyAgg(): SopAgg {
  return { completed: 0, pending: 0, overdue: 0, ignored: 0 };
}

function emptyBucket(): SopExamBucket {
  return { total: 0, completed: 0, remaining: 0, pending: 0, overdue: 0, ignored: 0 };
}

function addSitting(agg: SopAgg, row: ExamSittingLike): void {
  if (row.isIgnored) agg.ignored++;
  else agg[row.status]++;
}

/** Classify one unique SOP from its employee/month sittings. */
function bucketFromAgg(agg: SopAgg, bucket: SopExamBucket): void {
  const live = agg.completed + agg.pending + agg.overdue;
  if (live === 0) {
    if (agg.ignored > 0) bucket.ignored++;
    return;
  }
  bucket.total++;
  if (agg.pending === 0 && agg.overdue === 0) {
    bucket.completed++;
    return;
  }
  bucket.remaining++;
  if (agg.pending > 0) bucket.pending++;
  if (agg.overdue > 0) bucket.overdue++;
}

type SopAggNamed = SopAgg & {
  sopName: string;
  months: Set<number>;
  sittingCount: number;
};

function aggregateBySop(rows: ExamSittingLike[]): Map<string, SopAggNamed> {
  const bySop = new Map<string, SopAggNamed>();
  for (const row of rows) {
    const key = row.sopCode.trim().toUpperCase();
    if (!key) continue;
    let agg = bySop.get(key);
    if (!agg) {
      agg = {
        ...emptyAgg(),
        sopName: row.sopName || key,
        months: new Set<number>(),
        sittingCount: 0,
      };
      bySop.set(key, agg);
    }
    if (row.sopName && (!agg.sopName || agg.sopName === key)) agg.sopName = row.sopName;
    if (row.month >= 1 && row.month <= 12) agg.months.add(row.month);
    agg.sittingCount++;
    addSitting(agg, row);
  }
  return bySop;
}

function kindFromDeptAgg(agg: SopAgg): UniqueSopListItem['kind'] | null {
  const live = agg.completed + agg.pending + agg.overdue;
  if (live === 0) return agg.ignored > 0 ? 'ignored' : null;
  if (agg.pending === 0 && agg.overdue === 0) return 'completed';
  return 'remaining';
}

function kindFromEmployeeAgg(agg: SopAgg): UniqueSopListItem['kind'] | null {
  const live = agg.completed + agg.pending + agg.overdue;
  if (live === 0) return agg.ignored > 0 ? 'ignored' : null;
  if (agg.completed > 0) return 'completed';
  return 'remaining';
}

function toListItems(
  bySop: Map<string, SopAggNamed>,
  kindOf: (agg: SopAgg) => UniqueSopListItem['kind'] | null,
  filter?: UniqueSopListItem['kind'],
): UniqueSopListItem[] {
  const items: UniqueSopListItem[] = [];
  for (const [sopCode, agg] of bySop) {
    const kind = kindOf(agg);
    if (!kind) continue;
    if (filter && kind !== filter) continue;
    items.push({
      sopCode,
      sopName: agg.sopName,
      kind,
      months: [...agg.months].sort((a, b) => a - b),
      sittingCount: agg.sittingCount,
    });
  }
  return items.sort((a, b) => a.sopCode.localeCompare(b.sopCode));
}

/**
 * Unique SOP exams across the given sittings (deduped by sopCode).
 * Use for a selected employee across selected months, or a department month.
 */
export function countUniqueSops(rows: ExamSittingLike[]): SopExamBucket {
  const bySop = aggregateBySop(rows);
  const bucket = emptyBucket();
  for (const agg of bySop.values()) bucketFromAgg(agg, bucket);
  return bucket;
}

/** List unique SOPs for a department/month scope (all sittings must be done → completed). */
export function listUniqueSops(
  rows: ExamSittingLike[],
  filter?: UniqueSopListItem['kind'],
): UniqueSopListItem[] {
  return toListItems(aggregateBySop(rows), kindFromDeptAgg, filter);
}

/**
 * Unique SOP exams one employee must sit across the given months.
 * Completing the SOP in any selected month counts as done — the same SOP
 * listed in August and September is still one exam.
 */
export function countEmployeeUniqueSops(rows: ExamSittingLike[]): SopExamBucket {
  const bySop = aggregateBySop(rows);
  const bucket = emptyBucket();
  for (const agg of bySop.values()) {
    const live = agg.completed + agg.pending + agg.overdue;
    if (live === 0) {
      if (agg.ignored > 0) bucket.ignored++;
      continue;
    }
    bucket.total++;
    if (agg.completed > 0) {
      bucket.completed++;
      continue;
    }
    bucket.remaining++;
    if (agg.pending > 0) bucket.pending++;
    if (agg.overdue > 0) bucket.overdue++;
  }
  return bucket;
}

/** List unique SOPs for one employee (any completed sitting → completed). */
export function listEmployeeUniqueSops(
  rows: ExamSittingLike[],
  filter?: UniqueSopListItem['kind'],
): UniqueSopListItem[] {
  return toListItems(aggregateBySop(rows), kindFromEmployeeAgg, filter);
}

/** Unique SOP exams in each calendar month. Same SOP × many employees = 1. */
export function countUniqueSopsByMonth(rows: ExamSittingLike[]): SopExamBucket[] {
  const months = Array.from({ length: 12 }, () => aggregateBySop([]));
  for (const row of rows) {
    if (row.month < 1 || row.month > 12) continue;
    const key = row.sopCode.trim().toUpperCase();
    if (!key) continue;
    const map = months[row.month - 1];
    let agg = map.get(key);
    if (!agg) {
      agg = {
        ...emptyAgg(),
        sopName: row.sopName || key,
        months: new Set<number>(),
        sittingCount: 0,
      };
      map.set(key, agg);
    }
    if (row.sopName && (!agg.sopName || agg.sopName === key)) agg.sopName = row.sopName;
    agg.months.add(row.month);
    agg.sittingCount++;
    addSitting(agg, row);
  }
  return months.map((map) => {
    const bucket = emptyBucket();
    for (const agg of map.values()) bucketFromAgg(agg, bucket);
    return bucket;
  });
}

/** List unique SOPs for one calendar month (department SOP-wise). */
export function listUniqueSopsForMonth(
  rows: ExamSittingLike[],
  month: number,
  filter?: UniqueSopListItem['kind'],
): UniqueSopListItem[] {
  return listUniqueSops(
    rows.filter((r) => r.month === month),
    filter,
  );
}
