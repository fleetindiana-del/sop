'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, ArrowLeft, Award, Download, Loader2 } from 'lucide-react';
import type { InductionCertificateView, InductionSummary } from '@/lib/lmsInduction';
import { formatAttemptDate } from '@/components/lms/ExamAttemptsModal';

type InductionResponse = {
  employee: { id: string; name: string; designation: string; department: string };
  isSelf: boolean;
  summary: InductionSummary;
  certificate: InductionCertificateView | null;
};

function longDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

function InductionCertificateContent() {
  const router = useRouter();
  const employeeId = useSearchParams().get('employeeId') || '';
  const [data, setData] = useState<InductionResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    const qs = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : '';
    fetch(`/api/lms/induction${qs}`, { cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 401) { router.push('/lms'); return; }
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setError(json.error || 'Could not load the induction certificate.'); return; }
        setData(json as InductionResponse);
      })
      .catch(() => { if (!cancelled) setError('Could not reach the server.'); });
    return () => { cancelled = true; };
  }, [employeeId, router]);

  const backHref = employeeId ? '/lms/admin/induction' : '/lms';
  const backLabel = employeeId ? 'Induction Training' : 'My Training';

  if (!data && !error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
      </div>
    );
  }

  const cert = data?.certificate;
  if (error || !cert) {
    const summary = data?.summary;
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-6">
        <AlertCircle className="h-10 w-10 text-amber-400" />
        <p className="text-center font-medium text-gray-700">
          {error || 'The induction training certificate is not issued yet.'}
        </p>
        {summary && summary.total > 0 && (
          <p className="max-w-sm text-center text-sm text-gray-400">
            {summary.completedCount} of {summary.total} induction SOPs completed. The consolidated certificate is
            issued once every induction training exam is completed.
          </p>
        )}
        <button
          onClick={() => router.push(backHref)}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
        >
          Back to {backLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      <div className="print:hidden sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <button
            onClick={() => router.push(backHref)}
            className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {backLabel}
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
          >
            <Download className="h-3.5 w-3.5" /> Download / Print
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-4 py-10 print:max-w-none print:p-0">
        <div id="certificate" className="relative overflow-hidden rounded-2xl bg-white shadow-2xl print:rounded-none print:shadow-none">
          <div className="h-3 bg-gradient-to-r from-orange-600 via-amber-500 to-purple-600" />
          <div className="m-6 rounded-xl border-2 border-orange-200 p-8">
            <div className="mb-6 text-center">
              <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-orange-500 shadow-lg">
                <Award className="h-8 w-8 text-white" />
              </div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-orange-600">
                Certificate of Induction Training Completion
              </p>
              <p className="mt-1 text-xs text-gray-400">This certifies that</p>
            </div>

            <div className="mb-5 text-center">
              <h1 className="text-4xl font-bold text-gray-800" style={{ fontFamily: 'Georgia, serif' }}>
                {cert.employeeName}
              </h1>
              <p className="mt-1.5 text-sm text-gray-500">
                {cert.designation} &mdash; {cert.department}
                {cert.employeeCode ? ` · Emp. Code ${cert.employeeCode}` : ''}
              </p>
              {cert.dateOfJoining && (
                <p className="mt-0.5 text-xs text-gray-400">Date of Joining: {longDate(cert.dateOfJoining)}</p>
              )}
            </div>

            <p className="mb-4 text-center text-sm leading-relaxed text-gray-600">
              has successfully completed the induction training on the following
              {' '}{cert.sops.length} Standard Operating Procedure{cert.sops.length === 1 ? '' : 's'}
            </p>

            <table className="mb-6 w-full border border-orange-100 text-xs">
              <thead className="bg-orange-50 text-[10px] font-semibold uppercase tracking-wide text-orange-700">
                <tr>
                  <th className="px-2.5 py-1.5 text-left">#</th>
                  <th className="px-2.5 py-1.5 text-left">SOP No.</th>
                  <th className="px-2.5 py-1.5 text-left">Training</th>
                  <th className="px-2.5 py-1.5 text-center">Attempts</th>
                  <th className="px-2.5 py-1.5 text-center">Score</th>
                  <th className="px-2.5 py-1.5 text-left">Completed On</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-orange-50">
                {cert.sops.map((s, i) => (
                  <tr key={s.sopCode}>
                    <td className="px-2.5 py-1.5 text-gray-400">{i + 1}</td>
                    <td className="px-2.5 py-1.5 font-mono font-semibold text-gray-800">{s.sopCode}</td>
                    <td className="px-2.5 py-1.5 text-gray-700">{s.sopName}</td>
                    <td className="px-2.5 py-1.5 text-center tabular-nums">{s.attempts || '—'}</td>
                    <td className="px-2.5 py-1.5 text-center tabular-nums">
                      {typeof s.score === 'number' ? `${s.score}%` : '—'}
                    </td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">{formatAttemptDate(s.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mb-6 flex justify-center">
              <div className="flex flex-col items-center rounded-xl border border-gray-200 bg-gray-50 px-5 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Induction Completed On</p>
                <p className="mt-0.5 text-sm font-bold text-gray-700">{longDate(cert.completedAt)}</p>
              </div>
            </div>

            <div className="mt-4 border-t border-gray-100 pt-4">
              <div className="flex items-end justify-between text-xs text-gray-400">
                <div>
                  <p className="font-semibold text-gray-500">Certificate No.</p>
                  <p className="font-mono">{cert.certificateNumber}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-gray-500">Issued On</p>
                  <p>{longDate(cert.issuedAt)}</p>
                </div>
              </div>
            </div>
          </div>
          <div className="h-2 bg-gradient-to-r from-orange-600 via-amber-500 to-purple-600" />
        </div>
      </div>

      <style jsx global>{`
        @media print {
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
        }
      `}</style>
    </div>
  );
}

export default function InductionCertificatePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-gray-50">
          <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
        </div>
      }
    >
      <InductionCertificateContent />
    </Suspense>
  );
}
