import { CheckCircle2 } from 'lucide-react';

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Confirms in the LMS view that a designation change has actually propagated.
 *
 * The LMS reads the employee's designation from Employee Master on every load,
 * so if this badge shows the new title next to "Updated", the change has landed
 * everywhere the LMS reads from — that is the point of the indicator.
 *
 * Historical training, attendance, assessment and certificate records keep the
 * designation captured at the time and are unaffected.
 */
export function DesignationUpdatedBadge({
  designation,
  previousDesignation,
  designationUpdatedAt,
}: {
  designation: string;
  previousDesignation?: string;
  designationUpdatedAt?: string;
}) {
  if (!designationUpdatedAt) return null;

  const when = new Date(designationUpdatedAt);
  if (Number.isNaN(when.getTime())) return null;

  const from = (previousDesignation || '').trim() || '(none)';
  const to = (designation || '').trim() || '(none)';
  const stamp = formatWhen(designationUpdatedAt);
  // The timestamp carries recency on its own; deriving "is this recent?" would
  // mean reading the clock during render, which is not pure.
  const title = `Designation updated ${stamp} — ${from} → ${to}. Historical records keep the earlier designation.`;

  return (
    <span
      title={title}
      className="ml-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-green-300 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold text-green-900"
    >
      <CheckCircle2 className="h-3 w-3" />
      Updated {stamp}
    </span>
  );
}
