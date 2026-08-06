'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, Download, Award, Check, Loader2, AlertCircle } from 'lucide-react';
import {
  getCachedLmsEmployeeId,
  lmsClientFields,
  LMS_CLIENT_FRESH_MS,
  readLmsClientCache,
  writeLmsClientCache,
} from '@/lib/lmsCache';

interface Certificate {
  _id: string;
  certificateNumber: string;
  employeeName: string;
  designation: string;
  department: string;
  sopCode: string;
  sopName: string;
  sopVersion?: string;
  completedAt: string;
  quizScore: number;
  hasPractical: boolean;
  practicalScore?: number;
  issuedAt: string;
}

export default function CertificatePage() {
  const params = useParams<{ sopCode: string }>();
  const router = useRouter();
  const sopCode = params.sopCode;

  const [cert,    setCert]    = useState<Certificate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async (force = false) => {
    const employeeId = getCachedLmsEmployeeId();
    const field = employeeId
      ? lmsClientFields.certificate(employeeId, sopCode)
      : `certificate::${String(sopCode || '').toUpperCase()}`;
    const cached = !force ? readLmsClientCache<{ certificate: Certificate | null }>(field) : null;
    if (cached?.value?.certificate) {
      setCert(cached.value.certificate);
      setLoading(false);
      if (Date.now() - cached.cachedAt <= LMS_CLIENT_FRESH_MS) return;
    } else if (!cached) {
      setLoading(true);
    }
    try {
      const getRes = await fetch(`/api/lms/certificate/${sopCode}`);
      if (getRes.status === 401) { router.push('/lms'); return; }
      const getData = await getRes.json();

      if (getData.certificate) {
        setCert(getData.certificate);
        if (employeeId) writeLmsClientCache(field, getData);
        return;
      }

      const postRes = await fetch(`/api/lms/certificate/${sopCode}`, { method: 'POST' });
      const postData = await postRes.json();
      if (!postRes.ok) {
        setError(postData.error || 'Certificate could not be issued yet.');
        return;
      }
      setCert(postData.certificate);
      if (employeeId) writeLmsClientCache(field, postData);
    } catch {
      setError('Failed to load certificate.');
    } finally {
      setLoading(false);
    }
  }, [sopCode, router]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
      </div>
    );
  }

  if (error || !cert) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-6">
        <AlertCircle className="h-10 w-10 text-amber-400" />
        <p className="text-center text-gray-700 font-medium">{error || 'Certificate not available'}</p>
        <p className="text-sm text-gray-400 text-center max-w-sm">
          Complete all training steps (including the quiz if applicable) to unlock your certificate.
        </p>
        <button
          onClick={() => router.push(`/lms/journey/${sopCode}`)}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
        >
          Return to Training
        </button>
      </div>
    );
  }

  const completedDate = new Date(cert.completedAt).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const issuedDate = new Date(cert.issuedAt).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      {/* Toolbar — hidden on print */}
      <div className="print:hidden sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <button
            onClick={() => router.push('/lms')}
            className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> My Training
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
          >
            <Download className="h-3.5 w-3.5" /> Download / Print
          </button>
        </div>
      </div>

      {/* Certificate */}
      <div className="mx-auto max-w-4xl px-4 py-10 print:p-0 print:max-w-none">
        <div
          id="certificate"
          className="relative overflow-hidden rounded-2xl bg-white shadow-2xl print:shadow-none print:rounded-none"
          style={{ minHeight: '600px' }}
        >
          {/* Top decorative band */}
          <div className="h-3 bg-gradient-to-r from-purple-700 via-purple-500 to-indigo-600" />

          {/* Border frame */}
          <div className="m-6 rounded-xl border-2 border-purple-200 p-8">
            {/* Header */}
            <div className="mb-6 text-center">
              <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-purple-600 shadow-lg">
                <Award className="h-8 w-8 text-white" />
              </div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-purple-500">
                Certificate of Training Completion
              </p>
              <p className="mt-1 text-xs text-gray-400">This certifies that</p>
            </div>

            {/* Employee name */}
            <div className="mb-5 text-center">
              <h1
                className="text-4xl font-bold text-gray-800"
                style={{ fontFamily: 'Georgia, serif' }}
              >
                {cert.employeeName}
              </h1>
              <p className="mt-1.5 text-sm text-gray-500">
                {cert.designation} &mdash; {cert.department}
              </p>
            </div>

            {/* Statement */}
            <p className="mb-5 text-center text-sm text-gray-600 leading-relaxed">
              has successfully completed the training for
            </p>

            {/* SOP details */}
            <div className="mb-6 rounded-xl border border-purple-100 bg-purple-50 px-6 py-4 text-center">
              <p className="font-mono text-sm font-bold text-purple-700">{cert.sopCode}</p>
              <h2 className="mt-1 text-lg font-bold text-gray-800">{cert.sopName}</h2>
              {cert.sopVersion && (
                <p className="mt-0.5 text-xs text-gray-400">Version {cert.sopVersion}</p>
              )}
            </div>

            {/* Scores */}
            <div className="mb-6 flex flex-wrap justify-center gap-4">
              <div className="flex flex-col items-center rounded-xl border border-gray-200 bg-gray-50 px-5 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">Completed On</p>
                <p className="mt-0.5 text-sm font-bold text-gray-700">{completedDate}</p>
              </div>
              {cert.quizScore > 0 && (
                <div className="flex flex-col items-center rounded-xl border border-green-200 bg-green-50 px-5 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-green-500">Quiz Score</p>
                  <p className="mt-0.5 text-2xl font-bold text-green-700">{cert.quizScore}%</p>
                </div>
              )}
              {cert.hasPractical && (
                <div className="flex flex-col items-center rounded-xl border border-blue-200 bg-blue-50 px-5 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-blue-500">Practical</p>
                  <p className="mt-0.5 text-sm font-bold text-blue-700 flex items-center gap-1">
                    <Check className="h-4 w-4" /> Approved
                    {cert.practicalScore != null && ` · ${cert.practicalScore}%`}
                  </p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="mt-4 border-t border-gray-100 pt-4">
              <div className="flex items-end justify-between text-xs text-gray-400">
                <div>
                  <p className="font-semibold text-gray-500">Certificate No.</p>
                  <p className="font-mono">{cert.certificateNumber}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold text-gray-500">Issued On</p>
                  <p>{issuedDate}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom decorative band */}
          <div className="h-2 bg-gradient-to-r from-purple-700 via-purple-500 to-indigo-600" />
        </div>
      </div>

      {/* Print styles */}
      <style jsx global>{`
        @media print {
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
          #certificate { page-break-inside: avoid; }
        }
      `}</style>
    </div>
  );
}
