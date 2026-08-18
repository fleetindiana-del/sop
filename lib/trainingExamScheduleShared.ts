/** Client-safe constants/helpers for training exam calendar (no mongoose imports). */

export const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const DEPT_COLORS: Record<string, string> = {
  QA: '#6366f1',
  QC: '#92400e',
  Microbiology: '#10b981',
  Production: '#f59e0b',
  Store: '#f97316',
  Engineering: '#64748b',
  Personnel: '#ec4899',
};

/** YYYY-MM-DD in UTC (matches stored training/exam date-only values). */
export function toDateOnlyIso(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseDateOnly(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(Date.UTC(y, mo - 1, d));
}

export function monthOfDate(d: Date): number {
  return d.getUTCMonth() + 1;
}

export function yearOfDate(d: Date): number {
  return d.getUTCFullYear();
}
