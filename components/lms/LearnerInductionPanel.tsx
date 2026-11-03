'use client';

/**
 * The learner's induction training record on the Induction Training tab:
 * progress, every induction SOP with attempts and completion dates, and the
 * consolidated induction certificate once all of them are completed.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Award, Loader2, ShieldCheck } from 'lucide-react';
import { InductionRecordTable } from '@/components/lms/InductionRecordTable';
import type { InductionCertificateView, InductionSummary } from '@/lib/lmsInduction';

export function LearnerInductionPanel({ refreshKey }: { refreshKey?: unknown }) {
  const [summary, setSummary] = useState<InductionSummary | null>(null);
  const [certificate, setCertificate] = useState<InductionCertificateView | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/lms/induction', { cache: 'no-store' })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setError(json.error || 'Could not load your induction record.'); return; }
        setSummary(json.summary);
        setCertificate(json.certificate || null);
      })
      .catch(() => { if (!cancelled) setError('Could not reach the server.'); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  if (error) return <p className="py-6 text-center text-xs text-red-600">{error}</p>;
  if (!summary) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
      </div>
    );
  }

  const pct = summary.total > 0 ? Math.round((summary.completedCount / summary.total) * 100) : 0;
  return (
    <section className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-orange-200 bg-orange-50/60 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-orange-600" />
          <div>
            <p className="text-xs font-bold text-gray-800">Induction Training Record</p>
            <p className="text-[11px] text-gray-500">
              {summary.status === 'completed'
                ? `All ${summary.total} induction SOPs completed — regular training is now open.`
                : `${summary.completedCount} of ${summary.total} induction SOPs completed. Regular training opens after all are completed.`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-28 overflow-hidden rounded-full bg-orange-100">
              <div className="h-full rounded-full bg-orange-500" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-[11px] font-bold tabular-nums text-orange-700">{pct}%</span>
          </div>
          {certificate ? (
            <Link
              href="/lms/induction/certificate"
              className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-orange-700"
            >
              <Award className="h-3.5 w-3.5" /> Induction Certificate
            </Link>
          ) : (
            <span
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-gray-400"
              title="Issued once every induction training exam is completed"
            >
              <Award className="h-3.5 w-3.5" /> Certificate after completion
            </span>
          )}
        </div>
      </div>
      <InductionRecordTable sops={summary.sops} />
    </section>
  );
}
