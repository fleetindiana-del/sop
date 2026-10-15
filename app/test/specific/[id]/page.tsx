'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  CheckCircle2,
  XCircle,
  ChevronRight,
  ArrowLeft,
  Loader2,
  AlertTriangle,
  BookOpen,
  Clock,
} from 'lucide-react';
import { displaySopCode } from '@/lib/sop-display';

interface Question {
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
  [key: string]: any;
}

export default function SpecificTrainingTestSessionPage() {
  const params = useParams();
  const router = useRouter();

  const [questions, setQuestions] = useState<Question[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [correct, setCorrect] = useState(0);
  const [finished, setFinished] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const rawId = typeof params.id === 'string' ? params.id : (params.id as string[])?.join(',');
    if (!rawId) {
      setLoadError('No bank IDs provided.');
      setLoading(false);
      return;
    }

    const ids = decodeURIComponent(rawId)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    Promise.all(ids.map((id) => fetch(`/api/mcq-bank/${id}`).then((r) => r.json())))
      .then((results) => {
        let allMcqs: Question[] = [];
        for (const res of results) {
          if (!res.success || !res.mcqBank) continue;
          const bank = res.mcqBank;
          const mcqs: any[] = bank.mcqs || [];
          for (let i = 0; i < mcqs.length; i++) {
            allMcqs.push({
              ...mcqs[i],
              mcqBankId: bank._id?.toString() || bank._id,
              questionIndex: i,
              sopName: bank.sopName,
              sopIdentifier: bank.sopIdentifier,
            });
          }
        }

        // Filter to Medium/Hard only
        const filtered = allMcqs.filter(
          (q) => q.difficulty === 'Medium' || q.difficulty === 'Hard',
        );

        if (filtered.length === 0) {
          setLoadError('No Medium or Hard difficulty questions found in the selected banks.');
          setLoading(false);
          return;
        }

        // Shuffle and take up to 100
        const shuffled = filtered.sort(() => 0.5 - Math.random()).slice(0, 100);
        setQuestions(shuffled);
        setLoading(false);
      })
      .catch((err) => {
        setLoadError(err.message || 'Failed to load questions.');
        setLoading(false);
      });
  }, [params.id]);

  // Timer
  useEffect(() => {
    if (loading || finished) return;
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [loading, finished]);

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const handleSelect = (opt: string) => {
    if (revealed) return;
    setSelectedAnswer(opt);
    setRevealed(true);
    if (opt === questions[currentIdx]?.correctAnswer) {
      setCorrect((c) => c + 1);
    }
  };

  const handleNext = useCallback(() => {
    if (currentIdx + 1 >= questions.length) {
      if (timerRef.current) clearInterval(timerRef.current);
      setFinished(true);
    } else {
      setCurrentIdx((i) => i + 1);
      setSelectedAnswer(null);
      setRevealed(false);
    }
  }, [currentIdx, questions.length]);

  // ── Loading ──
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-10 h-10 text-yellow-400 animate-spin mx-auto mb-3" />
          <p className="text-slate-400">Loading questions…</p>
        </div>
      </div>
    );
  }

  // ── Error ──
  if (loadError) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
        <div className="bg-white/10 border border-white/20 rounded-3xl p-8 max-w-md text-center">
          <AlertTriangle className="w-10 h-10 text-rose-400 mx-auto mb-4" />
          <h2 className="text-xl font-bold text-white mb-2">Could Not Load Questions</h2>
          <p className="text-slate-400 text-sm mb-6">{loadError}</p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-xl bg-white/10 border border-white/20 text-white text-sm hover:bg-white/20 transition-all"
            >
              Try Again
            </button>
            <button
              onClick={() => router.push('/test/specific')}
              className="px-4 py-2 rounded-xl bg-yellow-600 text-white text-sm hover:bg-yellow-500 transition-all"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Finished ──
  if (finished) {
    const score = questions.length > 0 ? Math.round((correct / questions.length) * 100) : 0;
    const passed = score >= 70;
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center p-6">
        <div className="bg-white/10 border border-white/20 rounded-3xl p-8 max-w-md text-center">
          <div className="text-5xl mb-4">{passed ? '🎉' : '📚'}</div>
          <h2 className="text-2xl font-bold text-white mb-2">Test Complete!</h2>
          <div className="text-5xl font-bold mb-1" style={{ color: passed ? '#22c55e' : '#f43f5e' }}>
            {score}%
          </div>
          <p className="text-slate-400 text-sm mb-4">
            {correct} / {questions.length} correct · {formatTime(elapsed)}
          </p>
          <p className="text-slate-400 text-sm mb-6">
            {passed ? 'Excellent work! You passed this assessment.' : 'Keep studying — you need 70% to pass.'}
          </p>
          <button
            onClick={() => router.push('/test/specific')}
            className="w-full py-3 rounded-2xl bg-linear-to-r from-yellow-600 to-orange-600 text-white font-semibold hover:from-yellow-500 hover:to-orange-500 transition-all"
          >
            Back to Test Selection
          </button>
        </div>
      </div>
    );
  }

  // ── Question view ──
  const q = questions[currentIdx];
  const percentage = Math.round((currentIdx / questions.length) * 100);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col">
      {/* Header */}
      <div className="bg-white/10 backdrop-blur-xl border-b border-white/20 px-4 py-3 flex items-center gap-4">
        <button
          onClick={() => router.push('/test/specific')}
          className="text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex-1">
          <div className="flex items-center justify-between">
            <span className="text-white text-sm font-semibold">
              Q{currentIdx + 1} / {questions.length}
            </span>
            <div className="flex items-center gap-3">
              <span className="text-emerald-400 text-sm font-semibold">
                ✓ {correct}
              </span>
              <div className="flex items-center gap-1 text-slate-400 text-sm">
                <Clock className="w-3.5 h-3.5" />
                {formatTime(elapsed)}
              </div>
            </div>
          </div>
          {/* Progress bar */}
          <div className="h-1.5 bg-slate-700 rounded-full mt-2 overflow-hidden">
            <div
              className="h-full bg-linear-to-r from-yellow-500 to-orange-500 rounded-full transition-all"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-8 max-w-3xl mx-auto w-full">
        {/* Question meta */}
        <div className="flex flex-wrap gap-2 mb-4">
          {q.sopIdentifier && (
            <span className="px-2 py-0.5 bg-yellow-500/20 text-yellow-300 rounded-full text-xs border border-yellow-500/30">
              {displaySopCode(q.sopIdentifier)}
            </span>
          )}
          {q.difficulty && (
            <span className="px-2 py-0.5 bg-slate-700 text-slate-300 rounded-full text-xs">
              {q.difficultyStars} {q.difficulty}
            </span>
          )}
        </div>

        {/* Question */}
        <div className="bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-6 mb-5">
          <div className="flex items-start gap-3">
            {q.aiIcon && <span className="text-3xl">{q.aiIcon}</span>}
            <p className="text-white text-lg font-medium leading-relaxed">{q.question}</p>
          </div>
        </div>

        {/* Options with instant feedback */}
        <div className="space-y-3 mb-6">
          {q.options.map((opt, i) => {
            const isCorrectOpt = opt === q.correctAnswer;
            const isSelected = opt === selectedAnswer;
            const isWrong = isSelected && !isCorrectOpt;

            let className =
              'w-full text-left px-5 py-4 rounded-2xl border transition-all text-sm font-medium ';
            if (!revealed) {
              className += 'bg-white/5 border-white/15 text-slate-200 hover:bg-white/10 hover:border-white/30 cursor-pointer';
            } else if (isCorrectOpt) {
              className += 'bg-emerald-500/20 border-emerald-400 text-emerald-200 cursor-default';
            } else if (isWrong) {
              className += 'bg-rose-500/20 border-rose-400 text-rose-200 cursor-default';
            } else {
              className += 'bg-white/5 border-white/10 text-slate-500 cursor-default';
            }

            return (
              <button key={i} onClick={() => handleSelect(opt)} className={className} disabled={revealed}>
                <span className="text-slate-500 mr-3 font-semibold">{String.fromCharCode(65 + i)}.</span>
                {revealed && isCorrectOpt && <CheckCircle2 className="inline w-4 h-4 mr-1.5 mb-0.5 text-emerald-400" />}
                {revealed && isWrong && <XCircle className="inline w-4 h-4 mr-1.5 mb-0.5 text-rose-400" />}
                {opt}
              </button>
            );
          })}
        </div>

        {/* Explanation (revealed after answer) */}
        {revealed && (q.explanation || q.sopReference) && (
          <div className="bg-blue-500/10 border border-blue-400/20 rounded-2xl p-4 mb-5 text-sm">
            {q.explanation && (
              <p className="text-blue-200 mb-1">
                <BookOpen className="inline w-3.5 h-3.5 mr-1.5 mb-0.5" />
                {q.explanation}
              </p>
            )}
            {q.sopReference && (
              <p className="text-blue-400 text-xs">Ref: {q.sopReference}</p>
            )}
          </div>
        )}

        {/* Next / Finish button (shown after answer) */}
        {revealed && (
          <button
            onClick={handleNext}
            className="w-full py-3.5 rounded-2xl bg-linear-to-r from-yellow-600 to-orange-600 text-white font-semibold hover:from-yellow-500 hover:to-orange-500 transition-all flex items-center justify-center gap-2"
          >
            {currentIdx + 1 >= questions.length ? 'Finish Test' : 'Next Question'}
            <ChevronRight className="w-5 h-5" />
          </button>
        )}

        {!revealed && (
          <p className="text-center text-slate-500 text-sm">Select an answer to continue</p>
        )}
      </div>
    </div>
  );
}
