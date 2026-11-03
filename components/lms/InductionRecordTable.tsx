'use client';

/**
 * Induction SOPs of one employee: status, attempts (opens the attempt detail),
 * passing score and completion date. Used by the learner's Induction Training
 * tab and the SOP Admin induction dashboard.
 */

import { useState } from 'react';
import { CheckCircle2, Clock } from 'lucide-react';
import { AttemptCountButton, ExamAttemptsModal, formatAttemptDate } from '@/components/lms/ExamAttemptsModal';
import type { InductionSopRecord } from '@/lib/lmsInduction';

export function InductionRecordTable({
  sops,
  employeeId,
  compact,
}: {
  sops: InductionSopRecord[];
  /** Set when viewing another employee's record. */
  employeeId?: string;
  compact?: boolean;
}) {
  const [attemptsFor, setAttemptsFor] = useState<{ sopCode: string; sopName: string } | null>(null);

  if (sops.length === 0) {
    return <p className="px-3 py-4 text-center text-xs text-gray-400">No induction SOPs assigned.</p>;
  }

  const cell = compact ? 'px-2.5 py-1.5' : 'px-3 py-2';
  return (
    <>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-xs">
          <thead className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
            <tr>
              <th className={`${cell} text-left`}>#</th>
              <th className={`${cell} text-left`}>SOP</th>
              <th className={`${cell} text-left`}>Training</th>
              <th className={`${cell} text-left`}>Status</th>
              <th className={`${cell} text-center`}>Attempts</th>
              <th className={`${cell} text-center`}>Score</th>
              <th className={`${cell} text-left`}>Completed On</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sops.map((s, i) => (
              <tr key={s.sopCode} className="hover:bg-gray-50/60">
                <td className={`${cell} text-gray-400 tabular-nums`}>{i + 1}</td>
                <td className={`${cell} font-mono font-semibold text-purple-700 whitespace-nowrap`}>{s.sopCode}</td>
                <td className={`${cell} text-gray-700`}>{s.sopName}</td>
                <td className={cell}>
                  {s.completed ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                      <CheckCircle2 className="h-3 w-3" /> Completed
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                      <Clock className="h-3 w-3" /> Pending
                    </span>
                  )}
                </td>
                <td className={`${cell} text-center`}>
                  <AttemptCountButton
                    total={s.attempts}
                    passedOnAttempt={s.passedOnAttempt}
                    compact={compact}
                    onClick={() => setAttemptsFor({ sopCode: s.sopCode, sopName: s.sopName })}
                  />
                </td>
                <td className={`${cell} text-center tabular-nums text-gray-700`}>
                  {typeof s.score === 'number' ? `${s.score}%` : '—'}
                </td>
                <td className={`${cell} whitespace-nowrap text-gray-700`}>{formatAttemptDate(s.completedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {attemptsFor && (
        <ExamAttemptsModal
          sopCode={attemptsFor.sopCode}
          sopName={attemptsFor.sopName}
          employeeId={employeeId}
          onClose={() => setAttemptsFor(null)}
        />
      )}
    </>
  );
}
