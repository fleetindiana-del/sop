'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  ChevronLeft,
  ChevronRight,
  Flag,
  XCircle,
  CheckCircle2,
  Clock,
  Award,
  RotateCcw,
  LogOut,
  AlertTriangle,
  BookOpen,
} from 'lucide-react';
import { displaySopCode } from '@/lib/sop-display';

export interface TestQuestion {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
  sopReference?: string;
  sopName?: string;
  sopIdentifier?: string;
  difficulty?: string;
  difficultyStars?: string;
  aiIcon?: string;
  mcqBankId?: string;
  questionIndex?: number;
  _id?: string;
  isReinforcement?: boolean;
  [key: string]: any;
}

interface TestRunnerProps {
  questions: TestQuestion[];
  title: string;
  onExit: () => void;
  onComplete?: (score: number, total: number, answers?: Record<number, string>, timeTaken?: number) => void;
}

const QUESTION_TIME = 30;

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function ScoreRing({ percentage }: { percentage: number }) {
  const radius = 60;
  const circ = 2 * Math.PI * radius;
  const offset = circ - (percentage / 100) * circ;
  const color = percentage >= 70 ? '#22c55e' : percentage >= 40 ? '#f59e0b' : '#f43f5e';

  return (
    <svg width="160" height="160" className="drop-shadow-lg">
      <circle cx="80" cy="80" r={radius} fill="none" stroke="#1e293b" strokeWidth="12" />
      <circle
        cx="80"
        cy="80"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="12"
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 80 80)"
        style={{ transition: 'stroke-dashoffset 1s ease' }}
      />
      <text x="80" y="75" textAnchor="middle" fill="white" fontSize="24" fontWeight="bold">
        {percentage}%
      </text>
      <text x="80" y="96" textAnchor="middle" fill="#94a3b8" fontSize="12">
        Score
      </text>
    </svg>
  );
}

export default function TestRunner({ questions, title, onExit, onComplete }: TestRunnerProps) {
  const router = useRouter();
  const [step, setStep] = useState<'testing' | 'results'>('testing');
  const [currentIdx, setCurrentIdx] = useState(0);
  const [userAnswers, setUserAnswers] = useState<Record<number, string>>({});
  const [markedForReview, setMarkedForReview] = useState<Set<number>>(new Set());
  const [visited, setVisited] = useState<Set<number>>(new Set([0]));
  const [questionTimer, setQuestionTimer] = useState(QUESTION_TIME);
  const [totalElapsed, setTotalElapsed] = useState(0);
  const [startedAt] = useState<Date>(new Date());
  const [resultsFilter, setResultsFilter] = useState<'all' | 'correct' | 'incorrect'>('all');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const goToQuestion = useCallback((idx: number) => {
    setCurrentIdx(idx);
    setVisited((prev) => new Set([...prev, idx]));
    setQuestionTimer(QUESTION_TIME);
  }, []);

  const goNext = useCallback(() => {
    if (currentIdx < questions.length - 1) goToQuestion(currentIdx + 1);
  }, [currentIdx, questions.length, goToQuestion]);

  // Per-question countdown
  useEffect(() => {
    if (step !== 'testing') return;
    setQuestionTimer(QUESTION_TIME);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setQuestionTimer((t) => {
        if (t <= 1) {
          goNext();
          return QUESTION_TIME;
        }
        return t - 1;
      });
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, step]);

  // Total elapsed timer
  useEffect(() => {
    if (step !== 'testing') return;
    const interval = setInterval(() => setTotalElapsed((e) => e + 1), 1000);
    return () => clearInterval(interval);
  }, [step]);

  const selectAnswer = (answer: string) => {
    setUserAnswers((prev) => ({ ...prev, [currentIdx]: answer }));
  };

  const clearResponse = () => {
    setUserAnswers((prev) => {
      const next = { ...prev };
      delete next[currentIdx];
      return next;
    });
  };

  const toggleMarkForReview = async () => {
    const q = questions[currentIdx];
    if (!markedForReview.has(currentIdx)) {
      // Validate required fields before POSTing
      if (!q.mcqBankId || q.questionIndex === undefined || !q.sopName || !q.sopIdentifier) {
        alert('Cannot flag: question is missing bank metadata (mcqBankId / questionIndex / sopName / sopIdentifier).');
        return;
      }
      try {
        await fetch('/api/mcq-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mcqBankId: q.mcqBankId,
            questionIndex: q.questionIndex,
            sopId: q._id,
            sopName: q.sopName,
            sopIdentifier: q.sopIdentifier,
            question: {
              aiIcon: q.aiIcon || '❓',
              question: q.question,
              difficulty: q.difficulty || 'Medium',
              difficultyStars: q.difficultyStars || '⭐⭐',
              options: q.options,
              correctAnswer: q.correctAnswer,
              explanation: q.explanation || '',
              sopReference: q.sopReference || '',
            },
            flaggedBy: 'test-runner',
            reviewNotes: 'Flagged during test',
          }),
        });
      } catch {
        // non-fatal
      }
    }
    setMarkedForReview((prev) => {
      const next = new Set(prev);
      if (next.has(currentIdx)) next.delete(currentIdx);
      else next.add(currentIdx);
      return next;
    });
  };

  const calculateResults = useCallback(() => {
    let correct = 0;
    const detailed: any[] = questions.map((q, i) => {
      const selected = userAnswers[i] || '';
      const isCorrect = selected !== '' && selected === q.correctAnswer;
      if (isCorrect) correct++;
      return { ...q, selectedAnswer: selected, isCorrect, index: i };
    });
    return { correct, total: questions.length, detailed };
  }, [questions, userAnswers]);

  const handleSubmit = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    const { correct, total } = calculateResults();
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;
    onComplete?.(score, total, userAnswers, totalElapsed);
    setStep('results');
  };

  const navState = (idx: number) => {
    if (idx === currentIdx) return 'current';
    if (markedForReview.has(idx)) return 'marked';
    if (userAnswers[idx] !== undefined) return 'answered';
    if (visited.has(idx)) return 'visited';
    return 'pending';
  };

  const navColor = (state: string) => {
    switch (state) {
      case 'current':
        return 'bg-purple-600 border-purple-400 text-white scale-110 shadow-lg shadow-purple-500/40';
      case 'answered':
        return 'bg-emerald-600/80 border-emerald-400 text-white';
      case 'marked':
        return 'bg-amber-500/80 border-amber-400 text-white';
      case 'visited':
        return 'bg-white/20 border-white/40 text-white';
      default:
        return 'bg-white/5 border-white/10 text-slate-400';
    }
  };

  if (step === 'results') {
    const { correct, total, detailed } = calculateResults();
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;
    const incorrect = detailed.filter((d) => d.selectedAnswer && !d.isCorrect).length;
    const skipped = detailed.filter((d) => !d.selectedAnswer).length;

    const filtered =
      resultsFilter === 'correct'
        ? detailed.filter((d) => d.isCorrect)
        : resultsFilter === 'incorrect'
          ? detailed.filter((d) => !d.isCorrect)
          : detailed;

    return (
      <div className="min-h-screen bg-slate-900 p-4 md:p-8">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-6 flex flex-col md:flex-row items-center gap-6">
            <ScoreRing percentage={score} />
            <div className="flex-1 text-center md:text-left">
              <h2 className="text-2xl font-bold text-white mb-1">{title}</h2>
              <p className="text-slate-400 mb-3">
                {score >= 70 ? '🎉 Congratulations! You passed.' : '📚 Keep studying — aim for 70%+.'}
              </p>
              <div className="flex flex-wrap gap-2 justify-center md:justify-start">
                <span className="px-3 py-1 bg-emerald-500/20 text-emerald-300 rounded-full text-sm">
                  ✓ {correct} Correct
                </span>
                <span className="px-3 py-1 bg-rose-500/20 text-rose-300 rounded-full text-sm">
                  ✗ {incorrect} Incorrect
                </span>
                <span className="px-3 py-1 bg-slate-500/20 text-slate-300 rounded-full text-sm">
                  — {skipped} Skipped
                </span>
                <span className="px-3 py-1 bg-blue-500/20 text-blue-300 rounded-full text-sm">
                  ⏱ {formatTime(totalElapsed)}
                </span>
              </div>
            </div>
          </div>

          {/* Filter cards */}
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                { key: 'all', label: 'All', count: total, color: 'blue' },
                { key: 'correct', label: 'Correct', count: correct, color: 'emerald' },
                { key: 'incorrect', label: 'Incorrect', count: incorrect + skipped, color: 'rose' },
              ] as const
            ).map(({ key, label, count, color }) => (
              <button
                key={key}
                onClick={() => setResultsFilter(key)}
                className={`rounded-2xl p-4 border transition-all text-center ${
                  resultsFilter === key
                    ? `bg-${color}-500/30 border-${color}-400 text-${color}-300`
                    : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'
                }`}
              >
                <div className="text-2xl font-bold text-white">{count}</div>
                <div className="text-sm">{label}</div>
              </button>
            ))}
          </div>

          {/* Question review */}
          <div className="space-y-4">
            {filtered.map((q) => (
              <div
                key={q.index}
                className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-2xl p-5"
              >
                <div className="flex items-start gap-3 mb-3">
                  <span className="text-2xl">{q.aiIcon || '❓'}</span>
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="text-xs text-slate-500">Q{q.index + 1}</span>
                      {q.sopIdentifier && (
                        <span className="text-xs bg-slate-700 text-slate-300 px-2 py-0.5 rounded-full">
                          {displaySopCode(q.sopIdentifier)}
                        </span>
                      )}
                      {q.difficulty && (
                        <span className="text-xs text-slate-400">{q.difficultyStars} {q.difficulty}</span>
                      )}
                      {q.isCorrect ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 ml-auto" />
                      ) : (
                        <XCircle className="w-4 h-4 text-rose-400 ml-auto" />
                      )}
                    </div>
                    <p className="text-white font-medium">{q.question}</p>
                  </div>
                </div>

                <div className="space-y-2 mb-3">
                  {q.options.map((opt: string, oi: number) => {
                    const isCorrect = opt === q.correctAnswer;
                    const isSelected = opt === q.selectedAnswer;
                    const isWrong = isSelected && !isCorrect;
                    return (
                      <div
                        key={oi}
                        className={`px-4 py-2.5 rounded-xl border text-sm transition-all ${
                          isCorrect
                            ? 'bg-emerald-500/20 border-emerald-400 text-emerald-200'
                            : isWrong
                              ? 'bg-rose-500/20 border-rose-400 text-rose-200'
                              : 'bg-white/5 border-white/10 text-slate-400'
                        }`}
                      >
                        {isCorrect && <CheckCircle2 className="inline w-3.5 h-3.5 mr-1.5 mb-0.5" />}
                        {isWrong && <XCircle className="inline w-3.5 h-3.5 mr-1.5 mb-0.5" />}
                        {opt}
                      </div>
                    );
                  })}
                </div>

                {(q.explanation || q.sopReference) && (
                  <div className="bg-blue-500/10 border border-blue-400/20 rounded-xl p-3 text-sm">
                    {q.explanation && (
                      <p className="text-blue-200 mb-1">
                        <BookOpen className="inline w-3.5 h-3.5 mr-1 mb-0.5" />
                        {q.explanation}
                      </p>
                    )}
                    {q.sopReference && (
                      <p className="text-blue-400 text-xs">Ref: {q.sopReference}</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex gap-4 pb-8">
            <button
              onClick={onExit}
              className="flex-1 py-3 rounded-2xl bg-white/10 border border-white/20 text-white font-semibold hover:bg-white/20 transition-all flex items-center justify-center gap-2"
            >
              <RotateCcw className="w-5 h-5" />
              Retake Test
            </button>
            <button
              onClick={() => router.push('/test')}
              className="flex-1 py-3 rounded-2xl bg-linear-to-r from-purple-600 to-pink-600 text-white font-semibold hover:from-purple-500 hover:to-pink-500 transition-all flex items-center justify-center gap-2"
            >
              <LogOut className="w-5 h-5" />
              Finish & Exit
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Testing view ──────────────────────────────────────────────────────────
  const q = questions[currentIdx];
  const answered = userAnswers[currentIdx];
  const isMarked = markedForReview.has(currentIdx);
  const answeredCount = Object.keys(userAnswers).length;
  const markedCount = markedForReview.size;

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      {/* Top bar */}
      <div className="bg-white/10 backdrop-blur-xl border-b border-white/20 px-4 py-3 flex items-center gap-4 sticky top-0 z-10">
        <div className="flex-1">
          <h1 className="text-white font-bold text-sm md:text-base truncate">{title}</h1>
          <p className="text-slate-400 text-xs">
            <span className="text-emerald-400">+1 Correct</span>
            {' · '}
            <span className="text-rose-400">-0 Incorrect</span>
          </p>
        </div>

        {/* Per-question timer */}
        <div
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border font-mono font-bold text-sm ${
            questionTimer <= 5
              ? 'bg-rose-500/20 border-rose-400 text-rose-300 animate-pulse'
              : 'bg-slate-800 border-white/20 text-white'
          }`}
        >
          <Clock className="w-4 h-4" />
          {questionTimer}s
        </div>

        <button
          onClick={handleSubmit}
          className="px-4 py-2 rounded-xl bg-linear-to-r from-purple-600 to-pink-600 text-white font-semibold text-sm hover:from-purple-500 hover:to-pink-500 transition-all"
        >
          Submit Test
        </button>
      </div>

      <div className="flex flex-1 gap-0 overflow-hidden">
        {/* Main question area */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          {/* Question meta */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-slate-400 text-sm font-semibold">
              Question {currentIdx + 1} / {questions.length}
            </span>
            {q.sopIdentifier && (
              <span className="px-2 py-0.5 bg-purple-500/20 text-purple-300 rounded-full text-xs border border-purple-500/30">
                {displaySopCode(q.sopIdentifier)}
              </span>
            )}
            {q.sopName && (
              <span className="px-2 py-0.5 bg-slate-700 text-slate-300 rounded-full text-xs max-w-xs truncate">
                {q.sopName}
              </span>
            )}
            {q.isReinforcement && (
              <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 rounded-full text-xs border border-amber-500/30">
                Reinforcement
              </span>
            )}
          </div>

          {/* Question card */}
          <div className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-6 mb-5">
            <div className="flex items-start gap-3">
              {q.aiIcon && <span className="text-3xl">{q.aiIcon}</span>}
              <p className="text-white text-lg font-medium leading-relaxed">{q.question}</p>
            </div>
          </div>

          {/* Options */}
          <div className="space-y-3 mb-6">
            {q.options.map((opt, i) => (
              <button
                key={i}
                onClick={() => selectAnswer(opt)}
                className={`w-full text-left px-5 py-4 rounded-2xl border transition-all text-sm font-medium ${
                  answered === opt
                    ? 'bg-purple-600/30 border-purple-400 text-purple-100 shadow-lg shadow-purple-500/20'
                    : 'bg-white/5 border-white/15 text-slate-200 hover:bg-white/10 hover:border-white/30'
                }`}
              >
                <span className="text-slate-500 mr-3 font-semibold">
                  {String.fromCharCode(65 + i)}.
                </span>
                {opt}
              </button>
            ))}
          </div>

          {/* Action bar */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={clearResponse}
              disabled={!answered}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl border border-white/20 text-slate-300 text-sm hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <XCircle className="w-4 h-4" />
              Clear Response
            </button>

            <button
              onClick={toggleMarkForReview}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl border text-sm transition-all ${
                isMarked
                  ? 'bg-amber-500/20 border-amber-400 text-amber-300'
                  : 'border-white/20 text-slate-300 hover:bg-white/10'
              }`}
            >
              <Flag className="w-4 h-4" />
              {isMarked ? 'Marked for Review' : 'Mark for Review'}
            </button>

            <div className="flex gap-2 ml-auto">
              <button
                onClick={() => goToQuestion(currentIdx - 1)}
                disabled={currentIdx === 0}
                className="flex items-center gap-1 px-4 py-2 rounded-xl bg-white/10 border border-white/20 text-white text-sm hover:bg-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
              >
                <ChevronLeft className="w-4 h-4" />
                Previous
              </button>
              <button
                onClick={() => {
                  if (currentIdx === questions.length - 1) {
                    handleSubmit();
                  } else {
                    goNext();
                  }
                }}
                className="flex items-center gap-1 px-4 py-2 rounded-xl bg-linear-to-r from-purple-600 to-pink-600 text-white text-sm hover:from-purple-500 hover:to-pink-500 transition-all"
              >
                {currentIdx === questions.length - 1 ? 'Finish' : 'Save & Next'}
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* Right panel — Question Navigator */}
        <div className="w-64 shrink-0 hidden lg:flex flex-col border-l border-white/10 bg-slate-900/50 p-4 overflow-y-auto">
          <h3 className="text-white font-semibold text-sm mb-1">Question Navigator</h3>
          <p className="text-slate-500 text-xs mb-3">
            {answeredCount} answered · {markedCount} marked
          </p>

          {/* Legend */}
          <div className="grid grid-cols-2 gap-1 mb-4 text-xs">
            {[
              { color: 'bg-purple-600', label: 'Current' },
              { color: 'bg-emerald-600', label: 'Answered' },
              { color: 'bg-amber-500', label: 'Marked' },
              { color: 'bg-white/20', label: 'Visited' },
            ].map(({ color, label }) => (
              <div key={label} className="flex items-center gap-1 text-slate-400">
                <div className={`w-2.5 h-2.5 rounded-sm ${color}`} />
                {label}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-5 gap-1.5">
            {questions.map((_, i) => {
              const state = navState(i);
              return (
                <button
                  key={i}
                  onClick={() => goToQuestion(i)}
                  title={`Question ${i + 1}${
                    state === 'answered' ? ' — answered' : state === 'marked' ? ' — marked' : ''
                  }`}
                  className={`w-10 h-10 rounded-xl border text-xs font-semibold transition-all ${navColor(state)}`}
                >
                  {i + 1}
                </button>
              );
            })}
          </div>

          <div className="mt-6 space-y-2">
            <div className="flex justify-between text-xs text-slate-400">
              <span>Progress</span>
              <span>{Math.round((answeredCount / questions.length) * 100)}%</span>
            </div>
            <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-linear-to-r from-purple-500 to-emerald-500 rounded-full transition-all"
                style={{ width: `${(answeredCount / questions.length) * 100}%` }}
              />
            </div>
          </div>

          <div className="mt-4 bg-white/5 rounded-xl p-3 text-xs text-slate-400">
            <div className="flex items-center gap-1 mb-1">
              <AlertTriangle className="w-3 h-3 text-amber-400" />
              <span className="text-amber-300 font-semibold">Timer</span>
            </div>
            Each question auto-advances after {QUESTION_TIME}s.
          </div>

          <button
            onClick={handleSubmit}
            className="mt-4 w-full py-2.5 rounded-xl bg-linear-to-r from-purple-600 to-pink-600 text-white font-semibold text-sm hover:from-purple-500 hover:to-pink-500 transition-all flex items-center justify-center gap-2"
          >
            <Award className="w-4 h-4" />
            Submit Test
          </button>
        </div>
      </div>
    </div>
  );
}
