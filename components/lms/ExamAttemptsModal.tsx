'use client';

/**
 * Attempt detail for one SOP exam: every formal attempt with its date, score,
 * result and the questions answered incorrectly (with acknowledgement ticks).
 * Reads `/api/lms/acknowledgements`, the same record the Acknowledgement Letter
 * is printed from. Pass `employeeId` to view another employee's attempts
 * (administrators, or trainers for their departments).
 */

import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, Circle, FileCheck2, Loader2, X } from 'lucide-react';

export interface ExamAttemptQuestion {
  questionId: string;
  question: string;
  givenAnswer: string;
  givenText: string;
  correctAnswer: string;
  correctText: string;
  sopReference: string;
  acknowledged: boolean;
  acknowledgedAt: string | null;
}

export interface ExamAttemptDetail {
  attempt: number;
  score: number;
  passed: boolean;
  at: string | null;
  isPassingAttempt: boolean;
  questionDetailRecorded: boolean;
  wrongCount: number | null;
  acknowledgedCount: number | null;
  questions: ExamAttemptQuestion[];
}

export interface ExamHistoryResponse {
  employee: { id: string; name: string; employeeCode: string; designation: string; department: string };
  isSelf: boolean;
  sopCode: string;
  sopName: string;
  exam: {
    totalAttempts: number;
    passedOnAttempt: number | null;
    totalWrong: number;
    totalAcknowledged: number;
    attempts: ExamAttemptDetail[];
  };
}

/** Query string for the exam history / letter of one SOP. */
export function examHistoryQuery(sopCode: string, employeeId?: string): string {
  const qs = new URLSearchParams({ sopCode });
  if (employeeId) qs.set('employeeId', employeeId);
  return qs.toString();
}

export function acknowledgementLetterHref(sopCode: string, employeeId?: string): string {
  const qs = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : '';
  return `/lms/acknowledgement/${encodeURIComponent(sopCode)}${qs}`;
}

export function formatAttemptDate(iso?: string | null, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const date = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  return withTime ? `${date} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : date;
}

function answerLabel(letter: string, text: string): string {
  if (!letter) return 'Not answered';
  return text ? `${letter}. ${text}` : letter;
}

/** "3 attempts" button used in exam tables; opens the detail view. */
export function AttemptCountButton({
  total,
  passedOnAttempt,
  onClick,
  compact,
}: {
  total: number;
  passedOnAttempt?: number | null;
  onClick: () => void;
  compact?: boolean;
}) {
  if (total <= 0) return <span className="text-xs text-gray-300">—</span>;
  const title = passedOnAttempt
    ? `${total} attempt${total === 1 ? '' : 's'} — passed on attempt ${passedOnAttempt}. Click for details.`
    : `${total} attempt${total === 1 ? '' : 's'} — not passed yet. Click for details.`;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 font-bold tabular-nums transition ${
        compact ? 'text-[10px]' : 'text-[11px]'
      } ${
        passedOnAttempt
          ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
          : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
      }`}
    >
      {total} {compact ? '' : total === 1 ? 'Attempt' : 'Attempts'}
    </button>
  );
}

export function ExamAttemptsModal({
  sopCode,
  sopName,
  employeeId,
  onClose,
}: {
  sopCode: string;
  sopName?: string;
  employeeId?: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<ExamHistoryResponse | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/lms/acknowledgements?${examHistoryQuery(sopCode, employeeId)}`)
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) { setError(json.error || 'Could not load the exam attempts.'); return; }
        setData(json as ExamHistoryResponse);
      })
      .catch(() => { if (!cancelled) setError('Could not reach the server.'); });
    return () => { cancelled = true; };
  }, [sopCode, employeeId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const toggle = (attempt: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(attempt)) next.delete(attempt);
      else next.add(attempt);
      return next;
    });

  const exam = data?.exam;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-100 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-indigo-700">Exam attempt history</p>
            <p className="mt-0.5 font-mono text-sm font-bold text-purple-700">
              {data?.sopCode || sopCode}
              <span className="ml-2 font-sans text-[11px] font-normal text-gray-600">{data?.sopName || sopName}</span>
            </p>
            {data && (
              <p className="mt-0.5 text-[11px] text-gray-500">
                {data.employee.name}
                {data.employee.employeeCode ? ` · ${data.employee.employeeCode}` : ''}
                {data.employee.department ? ` · ${data.employee.department}` : ''}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error ? (
            <p className="py-10 text-center text-sm text-red-600">{error}</p>
          ) : !exam ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-indigo-400" /></div>
          ) : exam.totalAttempts === 0 ? (
            <p className="py-10 text-center text-sm text-gray-400">No formal exam attempts on record.</p>
          ) : (
            <>
              <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Total attempts" value={String(exam.totalAttempts)} />
                <Stat
                  label="Result"
                  value={exam.passedOnAttempt ? `Passed on #${exam.passedOnAttempt}` : 'Not passed yet'}
                  tone={exam.passedOnAttempt ? 'green' : 'amber'}
                />
                <Stat label="Incorrect answers" value={String(exam.totalWrong)} tone={exam.totalWrong ? 'red' : undefined} />
                <Stat
                  label="Acknowledged"
                  value={`${exam.totalAcknowledged} / ${exam.totalWrong}`}
                  tone={exam.totalWrong && exam.totalAcknowledged === exam.totalWrong ? 'green' : 'amber'}
                />
              </div>

              {exam.attempts.length === 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {exam.totalAttempts} attempt{exam.totalAttempts === 1 ? '' : 's'} counted, but per-attempt dates and scores were not recorded.
                </p>
              )}

              <div className="space-y-2">
                {exam.attempts.map((a) => {
                  const expanded = open.has(a.attempt);
                  const canExpand = a.questions.length > 0;
                  return (
                    <div
                      key={a.attempt}
                      className={`rounded-xl border ${a.isPassingAttempt ? 'border-green-300 bg-green-50/40' : 'border-gray-200 bg-white'}`}
                    >
                      <button
                        type="button"
                        disabled={!canExpand}
                        onClick={() => toggle(a.attempt)}
                        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 text-left disabled:cursor-default"
                      >
                        <span className="flex items-center gap-1 text-sm font-bold text-gray-900">
                          {canExpand
                            ? expanded ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />
                            : <span className="w-4" />}
                          Attempt {a.attempt}
                        </span>
                        {a.isPassingAttempt && (
                          <span className="rounded-full bg-green-600 px-2 py-0.5 text-[10px] font-bold text-white">Passing attempt</span>
                        )}
                        <Field label="Date" value={formatAttemptDate(a.at, true)} />
                        <Field label="Score" value={`${a.score}%`} />
                        <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${a.passed ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {a.passed ? 'Pass' : 'Fail'}
                        </span>
                        <Field label="Incorrect" value={a.questionDetailRecorded ? String(a.wrongCount) : 'Not recorded'} />
                        <Field
                          label="Acknowledged"
                          value={a.questionDetailRecorded ? `${a.acknowledgedCount} / ${a.wrongCount}` : 'Not recorded'}
                        />
                      </button>
                      {!a.questionDetailRecorded && (
                        <p className="border-t border-gray-100 px-3 py-1.5 text-[10px] text-gray-500">
                          Taken before individual answers were stored — incorrect questions for this attempt are not on record.
                        </p>
                      )}
                      {expanded && (
                        <ul className="divide-y divide-gray-100 border-t border-gray-100">
                          {a.questions.map((q, i) => (
                            <li key={q.questionId} className="flex gap-2 px-3 py-2 text-xs">
                              {q.acknowledged
                                ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" aria-label="Acknowledged" />
                                : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" aria-label="Not acknowledged" />}
                              <div className="min-w-0 flex-1">
                                <p className="font-medium text-gray-800">{i + 1}. {q.question}</p>
                                <p className="mt-0.5 text-red-700">Answered: {answerLabel(q.givenAnswer, q.givenText)}</p>
                                <p className="text-green-800">Correct: {answerLabel(q.correctAnswer, q.correctText)}</p>
                                <p className={`mt-0.5 text-[10px] font-semibold ${q.acknowledged ? 'text-green-700' : 'text-amber-700'}`}>
                                  {q.acknowledged
                                    ? `Acknowledged ${formatAttemptDate(q.acknowledgedAt, true)}`
                                    : 'Not acknowledged'}
                                </p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {exam && exam.totalAttempts > 0 && (
          <div className="flex shrink-0 justify-end border-t border-gray-100 px-4 py-2.5">
            <a
              href={acknowledgementLetterHref(data!.sopCode, employeeId)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700"
            >
              <FileCheck2 className="h-3.5 w-3.5" /> Acknowledgement letter
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'green' | 'amber' | 'red' }) {
  const tones = {
    green: 'border-green-200 bg-green-50 text-green-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    red: 'border-red-200 bg-red-50 text-red-800',
  };
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone ? tones[tone] : 'border-gray-200 bg-gray-50 text-gray-800'}`}>
      <p className="text-sm font-bold">{value}</p>
      <p className="text-[10px] font-medium opacity-75">{label}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-[11px] text-gray-500">
      {label}: <span className="font-semibold text-gray-800">{value}</span>
    </span>
  );
}
