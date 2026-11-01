/**
 * Exam attempt roll-up shared by the learner's training record, the admin
 * employee grid and the acknowledgement letter, so all three report the same
 * attempt count and passing attempt.
 */

export interface ExamAttemptEntry {
  attempt: number;
  score: number;
  at?: string | Date;
  passed?: boolean;
  wrongQuestionIds?: string[];
}

export interface ExamAttemptRollup {
  /** Formal attempts on record. */
  total: number;
  /** Attempt number that passed the exam, when it has been passed. */
  passedOnAttempt?: number;
  /** Score of the passing attempt. */
  passingScore?: number;
  /** Attempt history, oldest first. */
  history: ExamAttemptEntry[];
}

type QuizLike = {
  passed?: boolean;
  completed?: boolean;
  attempts?: number;
  attemptHistory?: ExamAttemptEntry[];
} | null | undefined;

export function rollupExamAttempts(...quizSteps: QuizLike[]): ExamAttemptRollup {
  const history: ExamAttemptEntry[] = [];
  let recorded = 0;
  let passed = false;
  for (const q of quizSteps) {
    if (!q) continue;
    recorded = Math.max(recorded, Number(q.attempts) || 0);
    if (q.passed === true || q.completed === true) passed = true;
    if (Array.isArray(q.attemptHistory)) history.push(...q.attemptHistory);
  }
  history.sort((a, b) => a.attempt - b.attempt);

  const total = Math.max(recorded, history.length);
  if (!passed) return { total, history };

  // Attempts recorded since the flag existed say which one passed. Older ones do
  // not: passing ends the exam, so the passing attempt is the last one on record
  // that is not explicitly marked as failed.
  const flagged = history.find((h) => h.passed === true);
  const passing = flagged ?? [...history].reverse().find((h) => h.passed !== false);
  return {
    total,
    passedOnAttempt: passing?.attempt ?? (total > 0 ? total : undefined),
    passingScore: passing?.score,
    history,
  };
}

/** "Passed on attempt 2 of 3", "3 attempts, not passed yet", "1 attempt". */
export function describeExamAttempts(r: ExamAttemptRollup): string {
  if (r.total <= 0) return 'Not attempted';
  const tries = `${r.total} attempt${r.total === 1 ? '' : 's'}`;
  if (r.passedOnAttempt) {
    return r.total === 1 ? 'Passed on first attempt' : `Passed on attempt ${r.passedOnAttempt} of ${r.total}`;
  }
  return `${tries}, not passed yet`;
}
