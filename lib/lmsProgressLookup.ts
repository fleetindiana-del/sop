/**
 * Learner progress lookup helpers.
 *
 * SOP codes reach the LMS in several shapes for the same document — versioned
 * (`QAGE4-02`), zero-padded (`QAGE04`) and bare (`QAGE4`) — so progress is
 * indexed under every form and read back through the same normalisation.
 *
 * Shared by the LMS dashboard (`app/lms/page.tsx`) and the employee training
 * record (`app/lms/my-record/page.tsx`) so both report the same status.
 */

export interface ProgressRecord {
  sopCode: string;
  status: 'not_started' | 'in_progress' | 'completed';
  overallPercentage: number;
  lastAccessedAt: string;
  completedAt?: string;
}

export function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

/** Normalize SOP codes so QAGE4 and QAGE04 resolve to the same progress lookup. */
export function progressLookupKey(code: string): string {
  return stripVersion(code).replace(/^([A-Z]+)0+(\d+)/, '$1$2');
}

export function buildProgressMap(records: ProgressRecord[]): Map<string, ProgressRecord> {
  const map = new Map<string, ProgressRecord>();
  for (const p of records) {
    const exact = String(p.sopCode || '').trim();
    if (!exact) continue;
    const norm = progressLookupKey(exact);
    const prefer = (existing: ProgressRecord | undefined, next: ProgressRecord) => {
      if (!existing) return next;
      // Keep the more advanced / more recently accessed record for a SOP family.
      if ((next.overallPercentage ?? 0) !== (existing.overallPercentage ?? 0)) {
        return (next.overallPercentage ?? 0) > (existing.overallPercentage ?? 0) ? next : existing;
      }
      return new Date(next.lastAccessedAt ?? 0).getTime() >= new Date(existing.lastAccessedAt ?? 0).getTime()
        ? next
        : existing;
    };
    map.set(exact, prefer(map.get(exact), p));
    map.set(norm, prefer(map.get(norm), p));
    const stripped = stripVersion(exact);
    if (stripped !== exact && stripped !== norm) {
      map.set(stripped, prefer(map.get(stripped), p));
    }
  }
  return map;
}

export function getProgress(
  map: Map<string, ProgressRecord>,
  sopCode: string,
): ProgressRecord | undefined {
  const exact = String(sopCode || '').trim();
  if (!exact) return undefined;
  return (
    map.get(exact) ||
    map.get(progressLookupKey(exact)) ||
    map.get(stripVersion(exact))
  );
}

/** True only when the learner has real started progress on this SOP. */
export function isActivelyInProgress(progress?: ProgressRecord): boolean {
  if (!progress) return false;
  if (progress.status !== 'in_progress') return false;
  if ((progress.overallPercentage ?? 0) <= 0) return false;
  return true;
}

/** Certificate only when training is fully done (100%), not the 90% pre-quiz cap. */
export function isFullyComplete(progress?: ProgressRecord): boolean {
  return progress?.status === 'completed' && (progress.overallPercentage ?? 0) >= 100;
}
