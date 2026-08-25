'use client';

/**
 * Employee Training Record — the learner's own completion sheet.
 *
 * The LMS dashboard is organised around *what to do next* (month filters,
 * due / overdue tabs). This page answers the other question: how much of my
 * assigned training is finished and how much is left. Same data sources as the
 * dashboard (`/api/lms/auth/me` + `/api/lms/progress`), same completion rule
 * (`isFullyComplete`), so the two screens never disagree.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, CheckCircle2, ClipboardList, Clock, Loader2,
  RefreshCw, Search, TrendingUp,
} from 'lucide-react';
import {
  buildProgressMap,
  getProgress,
  isFullyComplete,
  type ProgressRecord,
} from '@/lib/lmsProgressLookup';
import { classifyScheduleStatus } from '@/lib/lmsTrainingCycle';
import { getDeptLabelClasses, normalizeDepartment } from '@/lib/department-colors';
import { hasGujaratiScript, isInvalidSopAssignmentCode, isPlaceholderSopName } from '@/lib/sop-name-resolution';

interface SopAssignment {
  sopCode: string;
  sopName?: string;
  sopNameGujarati?: string;
  sopDepartment?: string;
  month: number;
  monthName: string;
  year: number;
  trainingType: 'induction' | 'training';
  examDate?: string;
}

interface Learner {
  id: string;
  name: string;
  designation: string;
  department: string;
}

type RecordTab = 'all' | 'completed' | 'remaining';

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Mirrors the dashboard: fall back to the SOP code when the name is a placeholder. */
function displayName(a: SopAssignment): { english: string; gujarati?: string } {
  let english = cleanText(a.sopName || a.sopCode);
  let gujarati = a.sopNameGujarati ? cleanText(a.sopNameGujarati) : undefined;
  if (hasGujaratiScript(english) && !gujarati) {
    gujarati = english;
    english = a.sopCode;
  }
  if (isPlaceholderSopName(english, a.sopCode)) {
    english = gujarati || a.sopCode;
  }
  return { english, gujarati: gujarati && gujarati !== english ? gujarati : undefined };
}

function dueLabel(a: SopAssignment): string {
  if (a.examDate && /^\d{4}-\d{2}-\d{2}$/.test(a.examDate.slice(0, 10))) {
    const d = new Date(`${a.examDate.slice(0, 10)}T12:00:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
    }
  }
  const month = MONTHS_SHORT[a.month - 1] || a.monthName || '—';
  return `${month} ${a.year}`;
}

function completedLabel(progress?: ProgressRecord): string {
  const iso = progress?.completedAt;
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

function StatCard({
  icon, label, value, tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: 'purple' | 'green' | 'amber' | 'red';
}) {
  const tones: Record<typeof tone, string> = {
    purple: 'border-purple-200 bg-purple-50 text-purple-700',
    green: 'border-green-200 bg-green-50 text-green-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-700',
    red: 'border-red-200 bg-red-50 text-red-700',
  };
  return (
    <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${tones[tone]}`}>
      {icon}
      <div>
        <p className="text-lg font-bold leading-none">{value}</p>
        <p className="mt-1 text-[11px] font-medium opacity-80">{label}</p>
      </div>
    </div>
  );
}

export default function EmployeeTrainingRecordPage() {
  const router = useRouter();
  const [learner, setLearner] = useState<Learner | null>(null);
  const [assignments, setAssignments] = useState<SopAssignment[]>([]);
  const [progressMap, setProgressMap] = useState<Map<string, ProgressRecord>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<RecordTab>('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [meRes, progressRes] = await Promise.all([
        fetch('/api/lms/auth/me'),
        fetch('/api/lms/progress'),
      ]);
      if (meRes.status === 401 || meRes.status === 403) {
        router.push('/lms');
        return;
      }
      if (!meRes.ok) {
        setError('Could not load your training record. Please try again.');
        return;
      }
      const me = await meRes.json();
      const prog = progressRes.ok ? await progressRes.json() : { progress: [] };
      setLearner(me.employee ?? null);
      setAssignments(
        ((me.assignments || []) as SopAssignment[]).filter(
          (a) => !isInvalidSopAssignmentCode(a.sopCode),
        ),
      );
      setProgressMap(buildProgressMap((prog.progress || []) as ProgressRecord[]));
      setError('');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => {
    return assignments.map((a) => {
      const progress = getProgress(progressMap, a.sopCode);
      const completed = isFullyComplete(progress);
      const schedule = classifyScheduleStatus(a, { completed });
      return {
        assignment: a,
        progress,
        completed,
        overdue: !completed && (schedule === 'missed' || schedule === 'overdue'),
        pct: Math.round(progress?.overallPercentage ?? 0),
      };
    });
  }, [assignments, progressMap]);

  const counts = useMemo(() => ({
    all: rows.length,
    completed: rows.filter((r) => r.completed).length,
    remaining: rows.filter((r) => !r.completed).length,
    overdue: rows.filter((r) => r.overdue).length,
  }), [rows]);

  const completionPct = counts.all === 0 ? 0 : Math.round((counts.completed / counts.all) * 100);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) => (tab === 'all' ? true : tab === 'completed' ? r.completed : !r.completed))
      .filter((r) => {
        if (!q) return true;
        const { english, gujarati } = displayName(r.assignment);
        return (
          r.assignment.sopCode.toLowerCase().includes(q) ||
          english.toLowerCase().includes(q) ||
          (gujarati ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        // Outstanding work first, then by due date.
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        if (a.assignment.year !== b.assignment.year) return a.assignment.year - b.assignment.year;
        return a.assignment.month - b.assignment.month;
      });
  }, [rows, tab, search]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2.5 lg:px-4">
          <div className="flex items-center gap-3">
            <Link
              href="/lms"
              className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> My Training
            </Link>
            <div className="h-4 w-px bg-gray-200" />
            <div className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4 text-purple-600" />
              <div>
                <h1 className="text-sm font-bold tracking-tight text-gray-800">
                  Employee Training Record
                </h1>
                {learner && (
                  <p className="text-[11px] text-gray-400">
                    {learner.name} · {learner.designation} · {learner.department}
                  </p>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-lg border border-gray-200 p-1.5 text-gray-400 hover:bg-gray-50 disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      <main className="mx-auto w-full px-3 py-4 lg:px-4">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-6 text-center text-sm text-red-700">
            {error}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                tone="purple"
                icon={<ClipboardList className="h-5 w-5" />}
                label="Trainings assigned"
                value={String(counts.all)}
              />
              <StatCard
                tone="green"
                icon={<CheckCircle2 className="h-5 w-5" />}
                label="Completed"
                value={String(counts.completed)}
              />
              <StatCard
                tone="amber"
                icon={<Clock className="h-5 w-5" />}
                label="Remaining"
                value={String(counts.remaining)}
              />
              <StatCard
                tone={counts.overdue > 0 ? 'red' : 'purple'}
                icon={<TrendingUp className="h-5 w-5" />}
                label={counts.overdue > 0 ? `Overdue · ${completionPct}% done` : 'Overall completion'}
                value={counts.overdue > 0 ? String(counts.overdue) : `${completionPct}%`}
              />
            </div>

            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-green-500 transition-all"
                style={{ width: `${completionPct}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-gray-500">
              {counts.completed} of {counts.all} training{counts.all !== 1 ? 's' : ''} completed
              {counts.remaining > 0 && ` · ${counts.remaining} still to do`}
            </p>

            <div className="mb-2.5 mt-4 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1">
                {(['all', 'completed', 'remaining'] as RecordTab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium transition ${
                      tab === t
                        ? t === 'completed'
                          ? 'bg-green-600 text-white'
                          : t === 'remaining'
                            ? 'bg-amber-600 text-white'
                            : 'bg-purple-600 text-white'
                        : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {t === 'all' ? 'All' : t === 'completed' ? 'Completed' : 'Remaining'}
                    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                      tab === t ? 'bg-white/20' : 'bg-gray-100 text-gray-500'
                    }`}>
                      {counts[t]}
                    </span>
                  </button>
                ))}
              </div>
              <div className="relative w-full max-w-xs sm:w-56">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search SOP code or name…"
                  className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-sm focus:border-purple-300 focus:outline-none"
                />
              </div>
            </div>

            {visible.length === 0 ? (
              <div className="rounded-xl border border-gray-200 bg-white py-16 text-center">
                <ClipboardList className="mx-auto mb-3 h-10 w-10 text-gray-200" />
                <p className="text-sm font-medium text-gray-500">
                  {search ? `No trainings match "${search}"` : 'Nothing to show here'}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="border-b border-gray-200 bg-gray-50 text-[10px] uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-3 py-2 font-semibold">SOP</th>
                      <th className="px-3 py-2 font-semibold">Department</th>
                      <th className="px-3 py-2 font-semibold">Type</th>
                      <th className="px-3 py-2 font-semibold">Due</th>
                      <th className="px-3 py-2 font-semibold">Progress</th>
                      <th className="px-3 py-2 font-semibold">Status</th>
                      <th className="px-3 py-2 font-semibold">Completed on</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((row) => {
                      const { english, gujarati } = displayName(row.assignment);
                      const rawDept = (row.assignment.sopDepartment || '').trim();
                      const dept = rawDept ? normalizeDepartment(rawDept) : '';
                      return (
                        <tr
                          key={`${row.assignment.sopCode}-${row.assignment.month}-${row.assignment.year}`}
                          className="border-b border-gray-100 last:border-0 hover:bg-gray-50"
                        >
                          <td className="px-3 py-2">
                            <Link
                              href={`/lms/journey/${row.assignment.sopCode}`}
                              className="font-semibold text-purple-700 hover:underline"
                            >
                              {row.assignment.sopCode}
                            </Link>
                            <p className="text-gray-600">{english}</p>
                            {gujarati && <p className="text-[11px] text-gray-400">{gujarati}</p>}
                          </td>
                          <td className="px-3 py-2">
                            {dept ? (
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${getDeptLabelClasses(dept)}`}>
                                {dept}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 capitalize text-gray-600">
                            {row.assignment.trainingType}
                          </td>
                          <td className="px-3 py-2 text-gray-600">{dueLabel(row.assignment)}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <div className="h-1.5 w-20 overflow-hidden rounded-full bg-gray-200">
                                <div
                                  className={`h-full rounded-full ${row.completed ? 'bg-green-500' : 'bg-purple-500'}`}
                                  style={{ width: `${Math.min(100, row.pct)}%` }}
                                />
                              </div>
                              <span className="text-[10px] font-semibold text-gray-500">{row.pct}%</span>
                            </div>
                          </td>
                          <td className="px-3 py-2">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              row.completed
                                ? 'bg-green-100 text-green-700'
                                : row.overdue
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-amber-100 text-amber-700'
                            }`}>
                              {row.completed ? 'Completed' : row.overdue ? 'Overdue' : 'Remaining'}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-gray-600">
                            {row.completed ? completedLabel(row.progress) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
