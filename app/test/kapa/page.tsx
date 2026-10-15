'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { useSession } from 'next-auth/react';
import QuestionBasisSelection from '@/components/QuestionBasisSelection';
import TestRunner from '@/components/TestRunner';
import { ArrowLeft, ChevronRight, Loader2, Search } from 'lucide-react';
import { displaySopCode } from '@/lib/sop-display';

type Step = 'selection' | 'criteria' | 'testing';

const DIFFICULTIES = ['Easy', 'Medium', 'Hard', 'Any'] as const;

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
  hasMcq: boolean;
}

export default function KapaTestPage() {
  useAuthGuard();
  const router = useRouter();
  const { data: session } = useSession();

  const [step, setStep] = useState<Step>('selection');
  const [basis, setBasis] = useState<'ai' | 'manual'>('ai');
  const [difficulty, setDifficulty] = useState<string>('Any');
  // For KAPA: single bank selection (first bank of the selected entry)
  const [selectedBankId, setSelectedBankId] = useState<string>('');
  const [questionCount, setQuestionCount] = useState(20);
  const [entries, setEntries] = useState<RegistryEntry[]>([]);
  const [search, setSearch] = useState('');
  const [questions, setQuestions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [fetchingBanks, setFetchingBanks] = useState(false);
  const [error, setError] = useState('');

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

  const handleBasisSelect = (type: 'ai' | 'manual') => {
    setBasis(type);
    setStep('criteria');
  };

  const generate = async () => {
    if (!selectedBankId) {
      setError('Please select a SOP.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/test/kapa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: basis,
          difficulty: basis === 'manual' ? difficulty : undefined,
          bankId: selectedBankId,
          questionCount,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to generate questions');
      setQuestions(data.questions || []);
      setStep('testing');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const handleComplete = async (
    _score: number,
    _total: number,
    answers?: Record<number, string>,
    timeTaken?: number,
  ) => {
    if (!session?.user || !questions.length) return;
    const bankId = questions[0]?.mcqBankId;
    if (!bankId) return;
    try {
      await fetch('/api/mcq-tests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: (session.user as any).id || session.user.email,
          username: (session.user as any).username || session.user.email,
          userFullName: session.user.name,
          mcqBankId: bankId,
          answers: Object.entries(answers || {}).map(([qi, ans]) => ({
            questionIndex: parseInt(qi),
            selectedAnswer: ans,
          })),
          timeTaken: timeTaken || 0,
          startedAt: new Date(Date.now() - (timeTaken || 0) * 1000).toISOString(),
          testName: 'KAPA/Incident Training Test',
        }),
      });
    } catch {
      /* non-fatal */
    }
  };

  if (step === 'testing') {
    return (
      <TestRunner
        questions={questions}
        title="KAPA / Incident Training Test"
        onExit={() => setStep('selection')}
        onComplete={handleComplete}
      />
    );
  }

  if (step === 'selection') {
    return (
      <QuestionBasisSelection
        onSelect={handleBasisSelect}
        onBack={() => router.push('/test')}
        title="KAPA / Incident Test — Choose Question Basis"
      />
    );
  }

  const filteredEntries = entries.filter(
    (e) =>
      !search ||
      e.sopName?.toLowerCase().includes(search.toLowerCase()) ||
      e.identifier?.toLowerCase().includes(search.toLowerCase()) ||
      e.sopNameGujarati?.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-8">
      <div className="max-w-3xl mx-auto">
        <button
          onClick={() => setStep('selection')}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>

        <h2 className="text-2xl font-bold text-white mb-2">Configure KAPA / Incident Test</h2>
        <p className="text-slate-400 text-sm mb-6">
          Select a single SOP for focused reinforcement training. Questions cycle if fewer than
          requested.
        </p>

        <div className="space-y-5">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search SOPs…"
              className="w-full bg-white/10 border border-white/20 rounded-xl pl-9 pr-4 py-2.5 text-white placeholder-slate-400 text-sm focus:outline-none focus:border-red-400"
            />
          </div>

          {fetchingBanks ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-6 h-6 text-red-400 animate-spin" />
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto custom-scrollbar space-y-2">
              {filteredEntries.map((entry) => {
                // Use the first bank's id as the selection target
                const bankId = entry.banks[0]?.id ?? '';
                const selected = selectedBankId === bankId;
                return (
                  <button
                    key={entry.id}
                    onClick={() => setSelectedBankId(bankId)}
                    className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition-all ${
                      selected
                        ? 'bg-red-600/20 border-red-400 text-red-200'
                        : 'bg-white/5 border-white/15 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                          selected ? 'border-red-400 bg-red-500' : 'border-slate-500'
                        }`}
                      >
                        {selected && <div className="w-2 h-2 rounded-full bg-white" />}
                      </div>
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${entry.language === 'GUJ' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'}`}>
                            {entry.language === 'GUJ' ? 'GU' : 'EN'}
                          </span>
                          {displaySopCode(entry.identifier)} — {entry.language === 'GUJ' && entry.sopNameGujarati ? entry.sopNameGujarati : entry.sopName}
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
                <p className="text-center text-slate-500 py-6 text-sm">
                  No SOP banks found. Generate MCQ banks from the SOP dashboard first.
                </p>
              )}
            </div>
          )}

          {basis === 'manual' && (
            <div>
              <span className="text-white font-medium text-sm block mb-3">Difficulty</span>
              <div className="grid grid-cols-4 gap-2">
                {DIFFICULTIES.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDifficulty(d)}
                    className={`py-2.5 rounded-xl border text-sm font-semibold transition-all ${
                      difficulty === d
                        ? 'bg-red-600/30 border-red-400 text-red-200'
                        : 'bg-white/5 border-white/20 text-slate-300 hover:bg-white/10'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white/5 border border-white/10 rounded-2xl p-5">
            <div className="flex justify-between items-center mb-2">
              <span className="text-white font-medium text-sm">Number of Questions</span>
              <span className="text-red-300 font-bold">{questionCount}</span>
            </div>
            <input
              type="range" min={10} max={40} step={5} value={questionCount}
              onChange={(e) => setQuestionCount(parseInt(e.target.value))}
              className="w-full accent-red-500"
            />
            <div className="flex justify-between text-xs text-slate-500 mt-1">
              <span>10</span><span>40</span>
            </div>
          </div>

          {error && (
            <div className="bg-rose-500/10 border border-rose-400/30 rounded-xl p-3 text-rose-300 text-sm">
              {error}
            </div>
          )}

          <button
            onClick={generate}
            disabled={loading || !selectedBankId}
            className="w-full py-3.5 rounded-2xl bg-red-600 hover:bg-red-500 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            {loading ? (
              <><Loader2 className="w-5 h-5 animate-spin" />Generating…</>
            ) : (
              <>Generate {questionCount} Questions<ChevronRight className="w-5 h-5" /></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
