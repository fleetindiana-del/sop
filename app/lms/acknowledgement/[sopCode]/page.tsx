'use client';

/**
 * Acknowledgement Letter — every question an employee answered incorrectly in
 * the formal exam for one SOP, each with a tick showing whether the employee
 * acknowledged it, plus the attempt history. Built from the exam records
 * (`/api/lms/acknowledgements`): a question is ticked only when the employee
 * ticked it on the review screen (or on this letter, viewing their own).
 *
 * Exams sat before individual answers were stored have no question detail; for
 * those attempts the letter says so instead of reconstructing anything.
 *
 * `?employeeId=` lets an administrator or the employee's trainer open someone
 * else's letter (read-only); `?print=1` opens the print dialog once loaded.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, Download, FileCheck2, Loader2 } from 'lucide-react';
import {
  examHistoryQuery,
  formatAttemptDate,
  type ExamHistoryResponse,
} from '@/components/lms/ExamAttemptsModal';

function answerLabel(letter: string, text: string): string {
  if (!letter) return 'Not answered';
  return text ? `${letter}. ${text}` : letter;
}

export default function AcknowledgementLetterPage() {
  const params = useParams<{ sopCode: string }>();
  const router = useRouter();
  const sopCode = decodeURIComponent(params.sopCode);
  const printStarted = useRef(false);

  const [data, setData] = useState<ExamHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    const employeeId = new URLSearchParams(window.location.search).get('employeeId') || undefined;
    try {
      const res = await fetch(`/api/lms/acknowledgements?${examHistoryQuery(sopCode, employeeId)}`);
      if (res.status === 401) { router.push('/lms'); return; }
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not load the acknowledgement letter.'); return; }
      setData(json as ExamHistoryResponse);
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [sopCode, router]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (data?.exam.totalAttempts && new URLSearchParams(window.location.search).get('print') === '1' && !printStarted.current) {
      printStarted.current = true;
      const timer = window.setTimeout(() => window.print(), 250);
      return () => window.clearTimeout(timer);
    }
  }, [data]);

  /** The employee acknowledges a mistake from their own letter. */
  const acknowledge = async (attempt: number, questionId: string) => {
    if (!data) return;
    setSaving(questionId);
    try {
      const res = await fetch('/api/lms/acknowledgements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sopCode: data.sopCode, attempt, questionId, acknowledged: true }),
      });
      if (res.ok) await load();
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
      </div>
    );
  }

  if (error || !data || data.exam.totalAttempts === 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 p-6">
        <AlertCircle className="h-10 w-10 text-amber-400" />
        <p className="text-center font-medium text-gray-700">{error || 'No exam attempts on record for this SOP'}</p>
        {!error && (
          <p className="max-w-sm text-center text-sm text-gray-400">
            The letter is available once a formal exam for this SOP has been attempted.
          </p>
        )}
        <button
          onClick={() => router.push('/lms')}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
        >
          My Training
        </button>
      </div>
    );
  }

  const { employee, exam } = data;
  const sopName = data.sopName || data.sopCode;
  const attemptsWithMistakes = exam.attempts.filter((a) => a.questions.length > 0);
  const legacyAttempts = exam.attempts.filter((a) => !a.questionDetailRecorded).map((a) => a.attempt);
  const unrecordedCount = Math.max(0, exam.totalAttempts - exam.attempts.length);
  const legacyTotal = legacyAttempts.length + unrecordedCount;
  const pending = exam.totalWrong - exam.totalAcknowledged;
  const lastExamAt = exam.attempts.map((a) => a.at).filter((d): d is string => Boolean(d)).sort().at(-1) ?? null;
  const reference = `ACK/${data.sopCode}/${employee.employeeCode || employee.id.slice(-6).toUpperCase()}`;

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      <div className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur print:hidden">
        <div className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <button
            onClick={() => (window.history.length > 1 ? router.back() : router.push('/lms'))}
            className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </button>
          <button
            onClick={() => window.print()}
            className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-purple-700"
          >
            <Download className="h-3.5 w-3.5" /> Download / Print
          </button>
        </div>
      </div>

      <div className="mx-auto max-w-4xl px-4 py-8 print:max-w-none print:p-0">
        <article className="rounded-2xl bg-white px-10 py-9 text-[13px] leading-relaxed text-gray-800 shadow-xl print:rounded-none print:px-0 print:py-0 print:shadow-none">
          <header className="flex items-start justify-between gap-6 border-b-2 border-purple-700 pb-4">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-full bg-purple-600 print:border print:border-purple-600 print:bg-white">
                <FileCheck2 className="h-6 w-6 text-white print:text-purple-700" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight text-gray-900">Acknowledgement Letter</h1>
                <p className="text-xs text-gray-500">Incorrectly answered exam questions and their acknowledgement</p>
              </div>
            </div>
            <dl className="text-right text-xs">
              <div>
                <dt className="inline font-semibold text-gray-500">Ref. No.: </dt>
                <dd className="inline font-mono">{reference}</dd>
              </div>
              <div>
                <dt className="inline font-semibold text-gray-500">Generated: </dt>
                <dd className="inline">{formatAttemptDate(new Date().toISOString())}</dd>
              </div>
            </dl>
          </header>

          <section className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 print:grid-cols-2">
            <div className="rounded-lg border border-gray-200 p-3">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">Employee details</p>
              <table className="w-full text-xs">
                <tbody>
                  <tr><td className="w-28 py-0.5 text-gray-500">Name</td><td className="font-semibold">{employee.name}</td></tr>
                  <tr><td className="py-0.5 text-gray-500">Employee code</td><td>{employee.employeeCode || '—'}</td></tr>
                  <tr><td className="py-0.5 text-gray-500">Designation</td><td>{employee.designation || '—'}</td></tr>
                  <tr><td className="py-0.5 text-gray-500">Department</td><td>{employee.department || '—'}</td></tr>
                </tbody>
              </table>
            </div>
            <div className="rounded-lg border border-gray-200 p-3">
              <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">SOP / exam details</p>
              <table className="w-full text-xs">
                <tbody>
                  <tr><td className="w-28 py-0.5 text-gray-500">SOP No.</td><td className="font-mono font-semibold">{data.sopCode}</td></tr>
                  <tr><td className="py-0.5 align-top text-gray-500">SOP title</td><td>{sopName}</td></tr>
                  <tr><td className="py-0.5 text-gray-500">Attempts</td><td>{exam.totalAttempts}</td></tr>
                  <tr>
                    <td className="py-0.5 text-gray-500">Result</td>
                    <td>{exam.passedOnAttempt ? `Passed on attempt ${exam.passedOnAttempt}` : 'Not passed yet'}</td>
                  </tr>
                  <tr><td className="py-0.5 text-gray-500">Last exam</td><td>{formatAttemptDate(lastExamAt)}</td></tr>
                </tbody>
              </table>
            </div>
          </section>

          <section className="mt-4 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 print:bg-white">
              <p className="text-xl font-bold text-red-700">{exam.totalWrong}</p>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-red-700/80">Incorrect questions</p>
            </div>
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 print:bg-white">
              <p className="text-xl font-bold text-green-700">{exam.totalAcknowledged}</p>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-green-700/80">Acknowledged</p>
            </div>
            <div className={`rounded-lg border px-3 py-2 print:bg-white ${pending > 0 ? 'border-amber-200 bg-amber-50' : 'border-gray-200 bg-gray-50'}`}>
              <p className={`text-xl font-bold ${pending > 0 ? 'text-amber-700' : 'text-gray-500'}`}>{pending}</p>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Not acknowledged</p>
            </div>
          </section>

          {exam.attempts.length > 0 && (
            <section className="mt-5">
              <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-gray-600">Exam attempt history</h2>
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="bg-gray-50 text-left text-[10px] uppercase tracking-wide text-gray-500">
                    <th className="border border-gray-200 px-2 py-1.5">Attempt</th>
                    <th className="border border-gray-200 px-2 py-1.5">Date</th>
                    <th className="border border-gray-200 px-2 py-1.5">Score</th>
                    <th className="border border-gray-200 px-2 py-1.5">Result</th>
                    <th className="border border-gray-200 px-2 py-1.5">Incorrect</th>
                    <th className="border border-gray-200 px-2 py-1.5">Acknowledged</th>
                  </tr>
                </thead>
                <tbody>
                  {exam.attempts.map((a) => (
                    <tr key={a.attempt}>
                      <td className="border border-gray-200 px-2 py-1.5 font-semibold">
                        {a.attempt}
                        {a.isPassingAttempt && <span className="ml-1.5 text-[10px] font-bold text-green-700">(passing attempt)</span>}
                      </td>
                      <td className="border border-gray-200 px-2 py-1.5">{formatAttemptDate(a.at, true)}</td>
                      <td className="border border-gray-200 px-2 py-1.5 tabular-nums">{a.score}%</td>
                      <td className={`border border-gray-200 px-2 py-1.5 font-semibold ${a.passed ? 'text-green-700' : 'text-red-700'}`}>
                        {a.passed ? 'Pass' : 'Fail'}
                      </td>
                      <td className="border border-gray-200 px-2 py-1.5 tabular-nums">
                        {a.questionDetailRecorded ? a.wrongCount : <span className="text-gray-400">Not recorded</span>}
                      </td>
                      <td className="border border-gray-200 px-2 py-1.5 tabular-nums">
                        {a.questionDetailRecorded
                          ? `${a.acknowledgedCount} / ${a.wrongCount}`
                          : <span className="text-gray-400">Not recorded</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {legacyTotal > 0 && (
            <section className="mt-4 break-inside-avoid rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 print:bg-white">
              <p className="font-bold uppercase tracking-wide">Attempts before individual answers were stored</p>
              <p className="mt-1">
                {legacyAttempts.length > 0
                  ? `Attempt${legacyAttempts.length === 1 ? '' : 's'} ${legacyAttempts.join(', ')}`
                  : `${unrecordedCount} attempt${unrecordedCount === 1 ? '' : 's'}`}
                {legacyTotal === 1 ? ' was' : ' were'} taken before the system stored individual answers. The
                questions answered incorrectly in {legacyTotal === 1 ? 'that attempt' : 'those attempts'} were not
                recorded and are therefore not listed below.
              </p>
            </section>
          )}

          {attemptsWithMistakes.length > 0 ? (
            <>
              <p className="mt-5">
                The questions below were answered incorrectly during the formal examination for the above SOP.
                A ticked box (☑) means the employee reviewed the correct answer and acknowledged the mistake;
                an empty box (☐) means it has not been acknowledged.
              </p>
              {attemptsWithMistakes.map((a) => (
                <section key={a.attempt} className="mt-4">
                  <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-gray-600">
                    Attempt {a.attempt} · {formatAttemptDate(a.at)} · Score {a.score}% · {a.passed ? 'Pass' : 'Fail'}
                    <span className="ml-2 font-semibold normal-case text-gray-500">
                      ({a.acknowledgedCount} of {a.wrongCount} acknowledged)
                    </span>
                  </h2>
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="bg-gray-50 text-left text-[10px] uppercase tracking-wide text-gray-500">
                        <th className="w-8 border border-gray-200 px-2 py-1.5">#</th>
                        <th className="border border-gray-200 px-2 py-1.5">Question</th>
                        <th className="border border-gray-200 px-2 py-1.5">Employee&apos;s answer</th>
                        <th className="border border-gray-200 px-2 py-1.5">Correct answer</th>
                        <th className="w-32 border border-gray-200 px-2 py-1.5 text-center">Acknowledged</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.questions.map((q, i) => (
                        <tr key={q.questionId} className="break-inside-avoid align-top">
                          <td className="border border-gray-200 px-2 py-1.5 tabular-nums">{i + 1}</td>
                          <td className="border border-gray-200 px-2 py-1.5">
                            <p>{q.question}</p>
                            {q.sopReference && (
                              <p className="mt-0.5 text-[10px] text-gray-500">SOP reference: {q.sopReference}</p>
                            )}
                          </td>
                          <td className="border border-gray-200 px-2 py-1.5 text-red-700">{answerLabel(q.givenAnswer, q.givenText)}</td>
                          <td className="border border-gray-200 px-2 py-1.5 font-medium text-green-800">{answerLabel(q.correctAnswer, q.correctText)}</td>
                          <td className="border border-gray-200 px-2 py-1.5 text-center">
                            <span
                              className={`text-lg leading-none ${q.acknowledged ? 'text-green-700' : 'text-gray-400'}`}
                              aria-label={q.acknowledged ? 'Acknowledged' : 'Not acknowledged'}
                            >
                              {q.acknowledged ? '☑' : '☐'}
                            </span>
                            <p className={`text-[10px] ${q.acknowledged ? 'text-gray-600' : 'text-amber-700'}`}>
                              {q.acknowledged ? formatAttemptDate(q.acknowledgedAt, true) : 'Not acknowledged'}
                            </p>
                            {!q.acknowledged && data.isSelf && (
                              <button
                                type="button"
                                disabled={saving === q.questionId}
                                onClick={() => void acknowledge(a.attempt, q.questionId)}
                                className="mt-1 rounded border border-purple-300 bg-purple-50 px-1.5 py-0.5 text-[10px] font-semibold text-purple-700 hover:bg-purple-100 disabled:opacity-50 print:hidden"
                                title="I have reviewed the correct answer and acknowledge this mistake"
                              >
                                {saving === q.questionId ? 'Saving…' : 'Acknowledge'}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </>
          ) : (
            <p className="mt-5">
              {legacyTotal > 0
                ? 'No incorrectly answered questions are on record for this exam.'
                : 'The employee answered every question correctly — there are no mistakes to acknowledge.'}
            </p>
          )}

          <section className="mt-6 break-inside-avoid rounded-lg border border-purple-200 bg-purple-50/50 p-4 print:bg-white">
            <h2 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-purple-800">Declaration</h2>
            <p>
              I, <strong>{employee.name}</strong>
              {employee.employeeCode ? ` (Employee code ${employee.employeeCode})` : ''}
              {employee.designation ? `, ${employee.designation}` : ''}
              {employee.department ? `, ${employee.department} department` : ''}, confirm that the exam
              attempt history above is a true record of my formal examination for SOP{' '}
              <strong>{data.sopCode}</strong> — {sopName}
              {exam.totalAcknowledged > 0
                ? `, and that I have reviewed the correct answer to each of the ${exam.totalAcknowledged} question${exam.totalAcknowledged === 1 ? '' : 's'} marked ☑ above, understand the mistake I made, and will follow the procedure as described in the SOP.`
                : '.'}
            </p>
            {pending > 0 && (
              <p className="mt-2 text-xs font-semibold text-amber-800">
                {pending} incorrect question{pending === 1 ? ' is' : 's are'} not yet acknowledged (☐).
              </p>
            )}
          </section>

          <section className="mt-10 grid grid-cols-2 gap-10 text-xs break-inside-avoid">
            <div>
              <div className="h-10 border-b border-gray-400" />
              <p className="mt-1 font-semibold">Employee signature &amp; date</p>
              <p className="text-gray-500">{employee.name}</p>
            </div>
            <div>
              <div className="h-10 border-b border-gray-400" />
              <p className="mt-1 font-semibold">Reviewed by (Trainer / QA) &amp; date</p>
              <p className="text-gray-500">Name: ____________________</p>
            </div>
          </section>

          <footer className="mt-8 border-t border-gray-200 pt-2 text-[10px] text-gray-400">
            System-generated record from the SOP Learning Management System. Attempt results and incorrect answers are
            as recorded when each exam was submitted; acknowledgements were recorded electronically by the employee at
            the times shown. Ref. {reference}.
          </footer>
        </article>
      </div>

      <style jsx global>{`
        @media print {
          @page { size: A4; margin: 14mm; }
          body { background: white !important; }
        }
      `}</style>
    </div>
  );
}
