'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import {
  ArrowLeft,
  ChevronRight,
  ChevronLeft,
  Loader2,
  Search,
  FlaskConical,
  CheckCircle2,
  XCircle,
  BookOpen,
  SkipForward,
  RotateCcw,
  Shuffle,
} from 'lucide-react';
import { displaySopCode } from '@/lib/sop-display';

interface RegistryEntry {
  id: string;
  identifier: string;
  sopName: string;
  sopNameGujarati?: string | null;
  department: string;
  language: string;
  totalMcqs: number;
  enMcqCount?: number;
  guMcqCount?: number;
  banks: { id: string; langCode: string }[];
}

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
}

const DIFFICULTIES = ['All', 'Easy', 'Medium', 'Hard'] as const;
type Difficulty = (typeof DIFFICULTIES)[number];

type Step = 'select' | 'practice';

function shuffle<T>(arr: T[]): T[] {
  return [...arr].sort(() => Math.random() - 0.5);
}

export default function PracticeModePage() {
  useAuthGuard();
  const router = useRouter();

  const [step, setStep] = useState<Step>('select');
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [selectedBankIds, setSelectedBankIds] = useState<string[]>([]);
  const [difficulty, setDifficulty] = useState<Difficulty>('All');
  const [search, setSearch] = useState('');
  const [fetchingBanks, setFetchingBanks] = useState(false);

  // Practice session state
  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [correct, setCorrect] = useState(0);
  const [attempted, setAttempted] = useState(0);
  const [loadingQuestions, setLoadingQuestions] = useState(false);

  useEffect(() => {
    setFetchingBanks(true);
    fetch('/api/mcq-bank/registry?all=1')
      .then((r) => r.json())
      .then((d) => {
        const active: RegistryEntry[] = (d.active || []).filter(
          (e: RegistryEntry) => e.totalMcqs > 0 && e.banks?.length > 0,
        );
        const split: RegistryEntry[] = [];
        for (const entry of active) {
          const engBanks = entry.banks.filter((b) => b.langCode === 'ENG');
          const gujBanks = entry.banks.filter((b) => b.langCode === 'GUJ');
          if (engBanks.length > 0 && (entry.enMcqCount ?? 0) > 0) {
            split.push({ ...entry, id: entry.id + '_ENG', banks: engBanks, totalMcqs: entry.enMcqCount ?? 0, language: 'ENG' });
          }
          if (gujBanks.length > 0 && (entry.guMcqCount ?? 0) > 0) {
            split.push({ ...entry, id: entry.id + '_GUJ', banks: gujBanks, totalMcqs: entry.guMcqCount ?? 0, language: 'GUJ' });
          }
        }
        setEntries(split);
      })
      .catch(() => {})
      .finally(() => setFetchingBanks(false));
  }, []);

  const toggleEntry = (entry: RegistryEntry) => {
    const ids = entry.banks.map((b) => b.id);
    setSelectedBankIds((prev) => {
      const already = ids.some((id) => prev.includes(id));
      return already ? prev.filter((id) => !ids.includes(id)) : [...prev, ...ids];
    });
  };

  const isSelected = (entry: RegistryEntry) =>
    entry.banks.some((b) => selectedBankIds.includes(b.id));

  const startPractice = useCallback(async () => {
    if (selectedBankIds.length === 0) return;
    setLoadingQuestions(true);
    try {
      const results = await Promise.all(
        selectedBankIds.map((id) => fetch(`/api/mcq-bank/${id}`).then((r) => r.json())),
      );
      let all: Question[] = [];
      for (const res of results) {
        if (!res.success || !res.mcqBank) continue;
        const bank = res.mcqBank;
        const mcqs: any[] = bank.mcqs || [];
        for (let i = 0; i < mcqs.length; i++) {
          all.push({
            ...mcqs[i],
            mcqBankId: bank._id?.toString(),
            questionIndex: i,
            sopName: bank.sopName,
            sopIdentifier: bank.sopIdentifier,
          });
        }
      }
      if (difficulty !== 'All') {
        all = all.filter((q) => q.difficulty === difficulty);
      }
      if (all.length === 0) {
        alert('No questions found for the selected filters.');
        return;
      }
      setQuestions(shuffle(all));
      setIdx(0);
      setSelectedAnswer(null);
      setRevealed(false);
      setSkipped(new Set());
      setCorrect(0);
      setAttempted(0);
      setStep('practice');
    } catch {
      alert('Failed to load questions.');
    } finally {
      setLoadingQuestions(false);
    }
  }, [selectedBankIds, difficulty]);

  const handleSelect = (opt: string) => {
    if (revealed) return;
    setSelectedAnswer(opt);
    setRevealed(true);
    setAttempted((a) => a + 1);
    if (opt === questions[idx]?.correctAnswer) setCorrect((c) => c + 1);
  };

  const goNext = () => {
    if (idx + 1 < questions.length) {
      setIdx((i) => i + 1);
      setSelectedAnswer(null);
      setRevealed(false);
    }
  };

  const goPrev = () => {
    if (idx > 0) {
      setIdx((i) => i - 1);
      setSelectedAnswer(null);
      setRevealed(false);
    }
  };

  const handleSkip = () => {
    setSkipped((s) => new Set([...s, idx]));
    goNext();
  };

  const handleReshuffle = () => {
    setQuestions((q) => shuffle(q));
    setIdx(0);
    setSelectedAnswer(null);
    setRevealed(false);
  };

  const filteredEntries = entries.filter(
    (e) =>
      !search ||
      e.sopName?.toLowerCase().includes(search.toLowerCase()) ||
      e.identifier?.toLowerCase().includes(search.toLowerCase()) ||
      e.sopNameGujarati?.toLowerCase().includes(search.toLowerCase()),
  );

  // ── Practice session view ──
  if (step === 'practice') {
    const q = questions[idx];
    const accuracy = attempted > 0 ? Math.round((correct / attempted) * 100) : null;

    return (
      <div className="min-h-screen bg-slate-900 flex flex-col">
        {/* Header */}
        <div className="bg-white/10 backdrop-blur-xl border-b border-white/20 px-4 py-3 flex items-center gap-4">
          <button
            onClick={() => setStep('select')}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <FlaskConical className="w-4 h-4 text-violet-400" />
                <span className="text-white font-semibold text-sm">Practice Mode</span>
                <span className="text-slate-500 text-sm">·</span>
                <span className="text-slate-400 text-sm">
                  {idx + 1} / {questions.length}
                </span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                {accuracy !== null && (
                  <span
                    className={`font-semibold ${accuracy >= 70 ? 'text-emerald-400' : accuracy >= 40 ? 'text-amber-400' : 'text-rose-400'}`}
                  >
                    {accuracy}% accuracy
                  </span>
                )}
                <span className="text-slate-500 text-xs">{attempted} answered</span>
              </div>
            </div>
            {/* Progress */}
            <div className="h-1 bg-slate-700 rounded-full mt-2 overflow-hidden">
              <div
                className="h-full bg-linear-to-r from-violet-500 to-purple-500 rounded-full transition-all"
                style={{ width: `${((idx + 1) / questions.length) * 100}%` }}
              />
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleReshuffle}
              title="Reshuffle"
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-all"
            >
              <Shuffle className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-8 max-w-3xl mx-auto w-full">
          {/* Question meta */}
          <div className="flex flex-wrap gap-2 mb-4">
            {q.sopIdentifier && (
              <span className="px-2 py-0.5 bg-violet-500/20 text-violet-300 rounded-full text-xs border border-violet-500/30">
                {displaySopCode(q.sopIdentifier)}
              </span>
            )}
            {q.difficulty && (
              <span className="px-2 py-0.5 bg-slate-700 text-slate-300 rounded-full text-xs">
                {q.difficultyStars} {q.difficulty}
              </span>
            )}
            {skipped.has(idx) && (
              <span className="px-2 py-0.5 bg-amber-500/20 text-amber-300 rounded-full text-xs border border-amber-500/30">
                Previously skipped
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
            {q.options.map((opt, i) => {
              const isCorrectOpt = opt === q.correctAnswer;
              const isSelected = opt === selectedAnswer;
              const isWrong = isSelected && !isCorrectOpt;

              let cls =
                'w-full text-left px-5 py-4 rounded-2xl border transition-all text-sm font-medium ';
              if (!revealed) {
                cls +=
                  'bg-white/5 border-white/15 text-slate-200 hover:bg-white/10 hover:border-white/30 cursor-pointer';
              } else if (isCorrectOpt) {
                cls += 'bg-emerald-500/20 border-emerald-400 text-emerald-200 cursor-default';
              } else if (isWrong) {
                cls += 'bg-rose-500/20 border-rose-400 text-rose-200 cursor-default';
              } else {
                cls += 'bg-white/5 border-white/10 text-slate-500 cursor-default';
              }

              return (
                <button
                  key={i}
                  onClick={() => handleSelect(opt)}
                  className={cls}
                  disabled={revealed}
                >
                  <span className="text-slate-500 mr-3 font-semibold">
                    {String.fromCharCode(65 + i)}.
                  </span>
                  {revealed && isCorrectOpt && (
                    <CheckCircle2 className="inline w-4 h-4 mr-1.5 mb-0.5 text-emerald-400" />
                  )}
                  {revealed && isWrong && (
                    <XCircle className="inline w-4 h-4 mr-1.5 mb-0.5 text-rose-400" />
                  )}
                  {opt}
                </button>
              );
            })}
          </div>

          {/* Explanation */}
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

          {/* Navigation */}
          <div className="flex gap-3">
            <button
              onClick={goPrev}
              disabled={idx === 0}
              className="px-4 py-3 rounded-2xl bg-white/5 border border-white/15 text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-all"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>

            {!revealed && (
              <button
                onClick={handleSkip}
                disabled={idx + 1 >= questions.length}
                className="flex-1 py-3 rounded-2xl bg-white/5 border border-white/15 text-slate-400 hover:text-white hover:bg-white/10 disabled:opacity-30 transition-all flex items-center justify-center gap-2 text-sm"
              >
                <SkipForward className="w-4 h-4" />
                Skip
              </button>
            )}

            {revealed && (
              <button
                onClick={goNext}
                disabled={idx + 1 >= questions.length}
                className="flex-1 py-3.5 rounded-2xl bg-linear-to-r from-violet-600 to-purple-600 text-white font-semibold hover:from-violet-500 hover:to-purple-500 disabled:opacity-40 transition-all flex items-center justify-center gap-2"
              >
                {idx + 1 >= questions.length ? 'Last Question' : 'Next'}
                <ChevronRight className="w-5 h-5" />
              </button>
            )}

            {!revealed && idx + 1 >= questions.length && (
              <button
                onClick={() => setStep('select')}
                className="flex-1 py-3 rounded-2xl bg-violet-600/20 border border-violet-500/30 text-violet-300 hover:bg-violet-600/30 transition-all text-sm flex items-center justify-center gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Done
              </button>
            )}

            {idx + 1 >= questions.length && revealed && (
              <button
                onClick={() => setStep('select')}
                className="px-4 py-3 rounded-2xl bg-violet-600/20 border border-violet-500/30 text-violet-300 hover:bg-violet-600/30 transition-all"
              >
                <RotateCcw className="w-5 h-5" />
              </button>
            )}
          </div>

          {!revealed && (
            <p className="text-center text-slate-500 text-xs mt-4">
              No timer · No pressure · Select an answer to see explanation
            </p>
          )}
        </div>
      </div>
    );
  }

  // ── Selection view ──
  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={() => router.push('/test')}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Test Center
        </button>

        <div className="flex items-center gap-3 mb-2">
          <div className="w-10 h-10 rounded-2xl bg-linear-to-br from-violet-500 to-purple-600 flex items-center justify-center">
            <FlaskConical className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white">Practice Mode</h1>
            <p className="text-slate-400 text-sm">No timer. No scoring. Just learning.</p>
          </div>
        </div>

        <div className="bg-violet-500/10 border border-violet-500/20 rounded-2xl p-4 mb-6 text-sm text-violet-200">
          Select one or more SOP banks and practice answering questions at your own pace. Answers and
          explanations are shown immediately after each selection.
        </div>

        <div className="space-y-5">
          {/* Difficulty filter */}
          <div>
            <span className="text-white font-medium text-sm block mb-3">Difficulty Filter</span>
            <div className="grid grid-cols-4 gap-2">
              {DIFFICULTIES.map((d) => (
                <button
                  key={d}
                  onClick={() => setDifficulty(d)}
                  className={`py-2.5 rounded-xl border text-sm font-semibold transition-all ${
                    difficulty === d
                      ? 'bg-violet-600/30 border-violet-400 text-violet-200'
                      : 'bg-white/5 border-white/20 text-slate-300 hover:bg-white/10'
                  }`}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* SOP search + list */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-white font-medium text-sm">Select SOPs</span>
              {selectedBankIds.length > 0 && (
                <button
                  onClick={() => setSelectedBankIds([])}
                  className="text-slate-500 hover:text-slate-300 text-xs transition-colors"
                >
                  Clear all
                </button>
              )}
            </div>
            <div className="relative mb-2">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search SOPs…"
                className="w-full bg-white/10 border border-white/20 rounded-xl pl-9 pr-4 py-2.5 text-white placeholder-slate-400 text-sm focus:outline-none focus:border-violet-400"
              />
            </div>

            {fetchingBanks ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-6 h-6 text-violet-400 animate-spin" />
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto custom-scrollbar space-y-2">
                {filteredEntries.map((entry) => {
                  const selected = isSelected(entry);
                  return (
                    <button
                      key={entry.id}
                      onClick={() => toggleEntry(entry)}
                      className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition-all ${
                        selected
                          ? 'bg-violet-600/20 border-violet-400 text-violet-200'
                          : 'bg-white/5 border-white/15 text-slate-300 hover:bg-white/10'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
                            selected ? 'border-violet-400 bg-violet-500' : 'border-slate-500'
                          }`}
                        >
                          {selected && (
                            <svg className="w-2.5 h-2.5 text-white" fill="currentColor" viewBox="0 0 12 12">
                              <path
                                d="M10 3L5 8.5 2 5.5"
                                stroke="currentColor"
                                strokeWidth="2"
                                fill="none"
                                strokeLinecap="round"
                              />
                            </svg>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="font-medium truncate flex items-center gap-2">
                            <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${entry.language === 'GUJ' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                              {entry.language === 'GUJ' ? 'GU' : 'EN'}
                            </span>
                            <span className="truncate">{displaySopCode(entry.identifier)} — {entry.language === 'GUJ' && entry.sopNameGujarati ? entry.sopNameGujarati : entry.sopName}</span>
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {entry.totalMcqs} questions · {entry.department}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
                {filteredEntries.length === 0 && !fetchingBanks && (
                  <p className="text-center text-slate-500 py-6 text-sm">No SOP banks found.</p>
                )}
              </div>
            )}
          </div>

          {selectedBankIds.length > 0 && (
            <p className="text-xs text-violet-400">
              {entries.filter(isSelected).length} SOP(s) selected ·{' '}
              {entries.filter(isSelected).reduce((s, e) => s + e.totalMcqs, 0)} questions
              {difficulty !== 'All' ? ` (filtered to ${difficulty})` : ''}
            </p>
          )}

          <button
            onClick={startPractice}
            disabled={selectedBankIds.length === 0 || loadingQuestions}
            className="w-full py-3.5 rounded-2xl bg-linear-to-r from-violet-600 to-purple-600 text-white font-semibold hover:from-violet-500 hover:to-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {loadingQuestions ? (
              <><Loader2 className="w-5 h-5 animate-spin" />Loading…</>
            ) : (
              <><FlaskConical className="w-5 h-5" />Start Practice</>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
