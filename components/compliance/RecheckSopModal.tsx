'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  UploadCloud,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  History,
  ExternalLink,
  EyeOff,
  Eye,
  FileDown,
  Copy,
  Check,
  Paperclip,
  Plus,
  FileText,
} from 'lucide-react';
import FindingCard from '@/app/compliance/components/FindingCard';
import { exportComplianceReportToPdf } from '@/lib/complianceReportPdf';

type FindingShape = React.ComponentProps<typeof FindingCard>['finding'];

interface RunPoint {
  finding: FindingShape;
  status: 'addressed' | 'open';
  evidence: string;
  note: string;
  revisedExcerpt?: string;
  ignored: boolean;
  /** Solved in an earlier run — kept as-is so progress never regresses. */
  carriedForward?: boolean;
  /** Raised as a new issue by an earlier re-check and tracked as a point from then on. */
  origin?: 'report' | 'new-issue';
}

interface RunIssue {
  clauseNumber: string;
  clauseTitle: string;
  guidelineName: string;
  issue: string;
  severity: 'low' | 'medium' | 'high';
  suggestion: string;
  ignored: boolean;
}

interface RecheckRun {
  id: string;
  fileName: string;
  fileUrl?: string;
  score: number;
  verdict: 'compliant' | 'issues';
  resolvedCount: number;
  openCount: number;
  createdAt?: string;
  summary?: string;
  results: RunPoint[];
  newIssues: RunIssue[];
  annexuresIncluded?: {
    label: string;
    fileName: string;
    chars: number;
    source?: 'uploaded' | 'linked';
    fileUrl?: string;
  }[];
  annexuresSkipped?: { label: string; fileName: string; reason: string }[];
  annexureChars?: number;
  annexuresRead?: boolean;
  /** How many included annexures were uploaded with the run (rest come from the SOP record). */
  uploadedAnnexureCount?: number;
  /** False for older history rows created before annexure tracking existed. */
  annexureStatusTracked?: boolean;
}

interface RecheckSopModalProps {
  isOpen: boolean;
  onClose: () => void;
  reportId: string;
  sopIdentifier: string;
  sopName: string;
  /** Open directly on history (e.g. from Generated Reports table). */
  initialView?: 'run' | 'history';
  onRechecked?: () => void;
}

const severityStyle: Record<string, string> = {
  high: 'bg-rose-50 text-rose-700 border-rose-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  low: 'bg-slate-50 text-slate-700 border-slate-200',
};

type PointFilter = 'all' | 'solved' | 'open';

function matchesPointFilter(point: RunPoint, filter: PointFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'solved' ? point.status === 'addressed' : point.status === 'open';
}

function scoreColor(score: number): string {
  if (score >= 8) return 'text-emerald-700 bg-emerald-50 border-emerald-200';
  if (score >= 5) return 'text-amber-700 bg-amber-50 border-amber-200';
  return 'text-rose-700 bg-rose-50 border-rose-200';
}

function normalizeRun(raw: Record<string, unknown>): RecheckRun {
  const included =
    (raw.annexuresIncluded as RecheckRun['annexuresIncluded']) ?? [];
  const skipped =
    (raw.annexuresSkipped as RecheckRun['annexuresSkipped']) ?? [];
  const annexureChars = Number(raw.annexureChars ?? 0);
  const annexureStatusTracked =
    Object.prototype.hasOwnProperty.call(raw, 'annexuresIncluded') ||
    Object.prototype.hasOwnProperty.call(raw, 'annexuresRead') ||
    Object.prototype.hasOwnProperty.call(raw, 'annexureChars');
  return {
    id: String(raw.id ?? raw.runId ?? raw._id ?? ''),
    fileName: String(raw.fileName ?? ''),
    fileUrl: (raw.fileUrl as string) || undefined,
    score: Number(raw.score ?? 0),
    verdict: (raw.verdict as 'compliant' | 'issues') ?? 'issues',
    resolvedCount: Number(raw.resolvedCount ?? 0),
    openCount: Number(raw.openCount ?? 0),
    createdAt: raw.createdAt as string | undefined,
    summary: raw.summary as string | undefined,
    results: (raw.results as RunPoint[]) ?? [],
    newIssues: (raw.newIssues as RunIssue[]) ?? [],
    annexuresIncluded: included,
    annexuresSkipped: skipped,
    annexureChars,
    annexuresRead:
      typeof raw.annexuresRead === 'boolean'
        ? raw.annexuresRead
        : included.length > 0 || annexureChars > 0,
    uploadedAnnexureCount:
      Number(raw.uploadedAnnexureCount ?? 0) ||
      included.filter((a) => a.source === 'uploaded').length,
    annexureStatusTracked,
  };
}

/** Compact verdict + score pill, meant to sit in the modal header. */
function VerdictPill({ run }: { run: RecheckRun }) {
  const isCompliant = run.verdict === 'compliant';
  const activeIssues = run.newIssues.filter((n) => !n.ignored);
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border pl-2 pr-1.5 py-1 ${
        isCompliant ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'
      }`}
    >
      {isCompliant ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
      )}
      <div className="min-w-0">
        <p className={`text-xs font-black whitespace-nowrap leading-tight ${isCompliant ? 'text-emerald-800' : 'text-amber-800'}`}>
          {isCompliant ? 'This SOP looks compliant as per AI' : 'Some points still need attention'}
        </p>
        <p className={`text-[10px] whitespace-nowrap leading-tight ${isCompliant ? 'text-emerald-700' : 'text-amber-700'}`}>
          {run.resolvedCount}/{run.results.length} addressed
          {activeIssues.length ? `, ${activeIssues.length} new` : ''}
        </p>
      </div>
      <div className={`shrink-0 text-center rounded px-1.5 py-0.5 ${scoreColor(run.score)}`}>
        <span className="text-xs font-black">{run.score.toFixed(1)}</span>
        <span className="text-[8px] font-bold opacity-70">/10</span>
      </div>
    </div>
  );
}

/** Renders one re-check run with the exact report card UI + ignore controls. */
function RunView({
  run: initial,
  hideBanner = false,
  compact = false,
  forceExpandCards = false,
  exportMeta,
  statusFilter = 'all',
}: {
  run: RecheckRun;
  hideBanner?: boolean;
  /** Embedded (history) mode — drops the SOP link + prior-points heading; those live in the row header. */
  compact?: boolean;
  /** Expand cards + include modal title so PDF capture mirrors the full UI. */
  forceExpandCards?: boolean;
  exportMeta?: { sopIdentifier: string; sopName: string };
  /** Header filter — limits the prior points shown to solved / not solved. */
  statusFilter?: PointFilter;
}) {
  const [run, setRun] = useState<RecheckRun>(initial);
  useEffect(() => setRun(initial), [initial]);

  const toggleIgnore = async (kind: 'point' | 'issue', index: number, ignored: boolean) => {
    // Optimistic local update.
    setRun((prev) => {
      const next = { ...prev };
      if (kind === 'point') {
        next.results = prev.results.map((r, i) => (i === index ? { ...r, ignored } : r));
      } else {
        next.newIssues = prev.newIssues.map((n, i) => (i === index ? { ...n, ignored } : n));
      }
      return next;
    });
    try {
      const res = await fetch('/api/compliance/recheck/history', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: run.id, kind, index, ignored }),
      });
      const data = await res.json();
      if (data.success) {
        setRun((prev) => ({
          ...prev,
          score: data.score,
          verdict: data.verdict,
          resolvedCount: data.resolvedCount,
          openCount: data.openCount,
        }));
      }
    } catch {
      /* keep optimistic state */
    }
  };

  const isCompliant = run.verdict === 'compliant';
  const activeIssues = run.newIssues.filter((n) => !n.ignored);
  const showBanner = !hideBanner || forceExpandCards;
  const showChrome = !compact || forceExpandCards;
  // Keep the original index so ignore toggles still patch the right row.
  const visiblePoints = run.results
    .map((r, i) => ({ point: r, index: i }))
    .filter(({ point }) => matchesPointFilter(point, statusFilter));

  return (
    <div className="space-y-4 select-text bg-white p-1">
      {forceExpandCards && exportMeta && (
        <div className="rounded-xl border border-purple-200 bg-purple-50 px-4 py-3">
          <p className="text-[10px] font-black uppercase tracking-wide text-purple-700">
            Re-check Revised SOP
          </p>
          <p className="text-sm font-bold text-gray-900 mt-0.5">
            {exportMeta.sopIdentifier}
            {exportMeta.sopName ? ` — ${exportMeta.sopName}` : ''}
          </p>
          {run.createdAt && (
            <p className="text-[11px] text-gray-500 mt-0.5">
              {new Date(run.createdAt).toLocaleString()}
            </p>
          )}
        </div>
      )}

      {/* Verdict + score */}
      {showBanner && (
        <div
          className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
            isCompliant ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'
          }`}
        >
          {isCompliant ? (
            <CheckCircle2 className="h-6 w-6 text-emerald-600 shrink-0" />
          ) : (
            <AlertTriangle className="h-6 w-6 text-amber-600 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className={`text-sm font-black ${isCompliant ? 'text-emerald-800' : 'text-amber-800'}`}>
              {isCompliant ? 'This SOP looks compliant as per AI' : 'Some points still need attention'}
            </p>
            <p className={`text-xs ${isCompliant ? 'text-emerald-700' : 'text-amber-700'}`}>
              {run.resolvedCount}/{run.results.length} prior point(s) addressed
              {activeIssues.length ? `, ${activeIssues.length} new issue(s)` : ''}
            </p>
          </div>
          <div className={`shrink-0 text-center rounded-lg border px-3 py-1.5 ${scoreColor(run.score)}`}>
            <p className="text-lg font-black leading-none">{run.score.toFixed(1)}</p>
            <p className="text-[9px] font-bold opacity-70">/ 10</p>
          </div>
        </div>
      )}

      {showChrome && (
        <div className="flex flex-col lg:flex-row lg:items-stretch gap-2">
          {run.fileUrl && (
            <a
              href={run.fileUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-purple-700 hover:underline shrink-0 lg:self-center"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Open uploaded SOP
            </a>
          )}

          <div
            className={`flex-1 rounded-xl border px-3 py-2 text-xs min-w-0 ${
              !run.annexureStatusTracked
                ? 'border-gray-200 bg-gray-50 text-gray-700'
                : run.annexuresRead
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
            }`}
          >
            {!run.annexureStatusTracked ? (
              <>
                <p className="font-black uppercase tracking-wide text-[10px] text-gray-500">
                  Annexure status not recorded
                </p>
                <p className="mt-0.5 text-[11px] text-gray-600">
                  Older re-check — run again to verify whether Annexure I / forms were read.
                </p>
              </>
            ) : run.annexuresRead ? (
              <>
                <p className="font-black uppercase tracking-wide text-[10px] text-emerald-700">
                  Annexures read ({run.annexuresIncluded?.length ?? 0} file
                  {(run.annexuresIncluded?.length ?? 0) === 1 ? '' : 's'}
                  {run.uploadedAnnexureCount ? ` · ${run.uploadedAnnexureCount} uploaded` : ''}
                  {run.annexureChars ? ` · ${run.annexureChars.toLocaleString()} chars` : ''})
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {(run.annexuresIncluded ?? []).map((a, i) => {
                    const uploaded = a.source === 'uploaded';
                    const chip = (
                      <span
                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                          uploaded
                            ? 'border-purple-200 bg-purple-50 text-purple-800'
                            : 'border-emerald-200 bg-white text-emerald-800'
                        }`}
                        title={`${a.fileName || a.label} — ${uploaded ? 'uploaded with this re-check' : 'linked to the SOP record'}`}
                      >
                        {uploaded ? <UploadCloud className="h-3 w-3" /> : <Paperclip className="h-3 w-3" />}
                        {a.label}
                      </span>
                    );
                    return a.fileUrl ? (
                      <a key={i} href={a.fileUrl} target="_blank" rel="noopener noreferrer">
                        {chip}
                      </a>
                    ) : (
                      <span key={i}>{chip}</span>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <p className="font-black uppercase tracking-wide text-[10px] text-amber-700">
                  No annexures read
                </p>
                <p className="mt-0.5 text-[11px] text-amber-800">
                  {(run.annexuresSkipped?.length ?? 0) > 0
                    ? `Annexure files were present but not usable: ${(run.annexuresSkipped ?? [])
                        .map((s) => `${s.label} — ${s.reason}`)
                        .join('; ')}`
                    : 'No annexures were read. Upload the revised Annexure I / forms with the re-check, or link them to the SOP first.'}
                </p>
              </>
            )}
          </div>
        </div>
      )}

      {/* Prior points — same card UI as the report */}
      {run.results.length > 0 && (
        <div className="space-y-3">
          {showChrome && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs font-black uppercase tracking-wide text-gray-500">
                Prior points ({run.resolvedCount}/{run.results.length} addressed)
              </p>
              <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5">
                {run.resolvedCount} solved
              </span>
              <span className="text-[10px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
                {run.openCount} still open
              </span>
            </div>
          )}
          {visiblePoints.length === 0 && (
            <p className="rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center text-xs text-gray-500">
              No {statusFilter === 'solved' ? 'solved' : 'unsolved'} points in this run.
            </p>
          )}
          {visiblePoints.map(({ point: r, index: i }) => (
            <div key={`${i}-${forceExpandCards ? 'export' : 'live'}`} className={r.ignored ? 'opacity-45' : ''}>
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${
                    r.status === 'addressed'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {r.status === 'addressed' ? 'Solved' : 'Not solved'}
                </span>
                {r.carriedForward && (
                  <span
                    className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 border border-emerald-200"
                    title="Already solved in an earlier re-check — carried forward, not re-audited"
                  >
                    Carried forward
                  </span>
                )}
                {r.origin === 'new-issue' && (
                  <span
                    className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-rose-50 text-rose-600 border border-rose-200"
                    title="Raised as a new issue by an earlier re-check — now tracked here instead of being reported again"
                  >
                    From earlier re-check
                  </span>
                )}
                {r.ignored && (
                  <span className="text-[9px] font-black uppercase px-1.5 py-0.5 rounded bg-gray-200 text-gray-600">
                    Ignored
                  </span>
                )}
                {!forceExpandCards && (
                  <button
                    type="button"
                    onClick={() => toggleIgnore('point', i, !r.ignored)}
                    className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-gray-500 hover:text-gray-800 border border-gray-200 rounded px-1.5 py-0.5"
                  >
                    {r.ignored ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                    {r.ignored ? 'Unignore' : 'Ignore'}
                  </button>
                )}
              </div>
              <FindingCard
                finding={r.finding}
                index={i}
                defaultExpanded={true}
                showCheckbox={false}
                reportContext={{
                  sopIdentifier: run.fileName,
                  sopName: '',
                  department: '',
                  overallScore: 0,
                  complianceStatus: '',
                }}
                recheckOverride={{
                  currentSopText: r.status === 'addressed' ? r.evidence : r.revisedExcerpt || undefined,
                  newGap: r.status === 'open' ? r.note : '',
                }}
              />
            </div>
          ))}
        </div>
      )}

      {/* New issues — conservative */}
      {run.newIssues.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-black uppercase tracking-wide text-gray-500">
            New issues ({activeIssues.length})
          </p>
          {run.newIssues.map((n, i) => (
            <div
              key={i}
              className={`rounded-xl border px-4 py-3 ${
                n.ignored ? 'border-gray-200 bg-gray-50 opacity-45' : 'border-rose-200 bg-rose-50/50'
              }`}
            >
              <div className="flex items-center gap-2 flex-wrap">
                <p className="text-xs font-bold text-gray-800">
                  {[n.guidelineName, n.clauseNumber, n.clauseTitle].filter(Boolean).join(' · ') || 'New issue'}
                </p>
                <span
                  className={`text-[9px] font-black uppercase px-1.5 py-0.5 rounded border ${
                    severityStyle[n.severity] ?? severityStyle.low
                  }`}
                >
                  {n.severity}
                </span>
                <button
                  type="button"
                  onClick={() => toggleIgnore('issue', i, !n.ignored)}
                  className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-gray-500 hover:text-gray-800 border border-gray-200 rounded px-1.5 py-0.5"
                >
                  {n.ignored ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                  {n.ignored ? 'Unignore' : 'Ignore'}
                </button>
              </div>
              <p className="text-xs text-gray-700 mt-1">{n.issue}</p>
              {n.suggestion && (
                <p className="text-[11px] text-rose-700 mt-1 border-l-2 border-rose-300 pl-2">
                  Suggested: {n.suggestion}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RecheckSopModal({
  isOpen,
  onClose,
  reportId,
  sopIdentifier,
  sopName,
  initialView = 'run',
  onRechecked,
}: RecheckSopModalProps) {
  const [view, setView] = useState<'run' | 'history'>(initialView);
  const [file, setFile] = useState<File | null>(null);
  const [annexures, setAnnexures] = useState<File[]>([]);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [activeRun, setActiveRun] = useState<RecheckRun | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const annexureInputRef = useRef<HTMLInputElement>(null);

  const [historyRuns, setHistoryRuns] = useState<RecheckRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [pointFilter, setPointFilter] = useState<PointFilter>('all');
  const [exportingPdf, setExportingPdf] = useState(false);
  const [copyingText, setCopyingText] = useState(false);
  const exportRootRef = useRef<HTMLDivElement | null>(null);
  const scrollBodyRef = useRef<HTMLDivElement | null>(null);

  const exportableRun: RecheckRun | null =
    view === 'run' && status === 'done' && activeRun
      ? activeRun
      : view === 'history' && expandedRun
        ? historyRuns.find((r) => r.id === expandedRun) ?? null
        : null;

  const buildPlainText = (run: RecheckRun): string => {
    const lines: string[] = [
      'RE-CHECK REVISED SOP',
      `${sopIdentifier}${sopName ? ` — ${sopName}` : ''}`,
      `Verdict: ${run.verdict} · Score: ${run.score.toFixed(1)}/10 · ${run.resolvedCount} solved / ${run.openCount} not solved`,
      '',
    ];
    if (run.annexuresRead && run.annexuresIncluded?.length) {
      lines.push(
        `Annexures read: ${run.annexuresIncluded
          .map((a) => `${a.label}${a.source === 'uploaded' ? ' (uploaded with re-check)' : ''}`)
          .join(', ')}`,
        '',
      );
    }
    run.results.forEach((r, i) => {
      const f = r.finding;
      lines.push(
        `── Point ${i + 1}: ${r.status === 'addressed' ? 'SOLVED' : 'NOT SOLVED'}${r.carriedForward ? ' (carried forward)' : ''}${r.ignored ? ' (ignored)' : ''} ──`,
        [f.guidelineName, f.clauseNumber, f.clauseTitle].filter(Boolean).join(' · '),
        f.sopSectionAffected ? `Section: ${f.sopSectionAffected}` : '',
        f.guidelineRequirement ? `Guideline requirement:\n${f.guidelineRequirement}` : '',
        f.sopTextSnippet ? `Previous SOP text:\n${f.sopTextSnippet}` : '',
        (r.status === 'addressed' ? r.evidence : r.revisedExcerpt)
          ? `Current SOP (revised):\n${r.status === 'addressed' ? r.evidence : r.revisedExcerpt}`
          : '',
        f.mismatchExplanation ? `Original gap:\n${f.mismatchExplanation}` : '',
        r.status === 'open' && r.note ? `New gap (re-check):\n${r.note}` : '',
        f.impactAnalysis ? `Impact:\n${f.impactAnalysis}` : '',
        f.suggestedAction || f.suggestedText
          ? `Suggested:\n${[f.suggestedAction, f.suggestedText].filter(Boolean).join('\n')}`
          : '',
        '',
      );
    });
    run.newIssues.forEach((n, i) => {
      lines.push(
        `── New issue ${i + 1}${n.ignored ? ' (ignored)' : ''} ──`,
        [n.guidelineName, n.clauseNumber, n.clauseTitle].filter(Boolean).join(' · '),
        n.issue,
        n.suggestion ? `Suggested: ${n.suggestion}` : '',
        '',
      );
    });
    return lines.filter((l, idx, arr) => !(l === '' && arr[idx - 1] === '')).join('\n');
  };

  const handleCopyAllText = async () => {
    if (!exportableRun || copyingText) return;
    setCopyingText(true);
    try {
      await navigator.clipboard.writeText(buildPlainText(exportableRun));
    } catch (err) {
      console.error('[recheck] copy failed:', err);
      window.alert('Could not copy to clipboard.');
    } finally {
      window.setTimeout(() => setCopyingText(false), 1200);
    }
  };

  /** Auto file name from the SOP identifier + name, e.g. QCGE05-00_Operation...-recheck-2026-07-30.pdf */
  const buildPdfFileName = (run: RecheckRun): string => {
    const stamp = new Date(run.createdAt ?? Date.now()).toISOString().slice(0, 10);
    const base = [sopIdentifier, sopName]
      .filter(Boolean)
      .join('-')
      .replace(/[^\w.-]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^[_.-]+|[_.-]+$/g, '')
      .slice(0, 90);
    return `${base || 'sop'}-recheck-${stamp}.pdf`;
  };

  const handleExportPdf = async () => {
    if (!exportableRun || exportingPdf) return;
    setExportingPdf(true);
    // Let the forceExpandCards re-render flush so the capture matches the UI.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.setTimeout(resolve, 180);
        });
      });
    });
    try {
      if (!exportRootRef.current) {
        throw new Error('Nothing to export — open a completed re-check first.');
      }
      await exportComplianceReportToPdf({
        element: exportRootRef.current,
        fileName: buildPdfFileName(exportableRun),
        unclip: [scrollBodyRef.current],
      });
    } catch (err) {
      console.error('[recheck] PDF export failed:', err);
      window.alert(err instanceof Error ? err.message : 'Failed to export PDF');
    } finally {
      setExportingPdf(false);
    }
  };

  const solvedCount = exportableRun
    ? exportableRun.results.filter((r) => r.status === 'addressed').length
    : 0;
  const notSolvedCount = exportableRun ? exportableRun.results.length - solvedCount : 0;

  const reset = useCallback(() => {
    setFile(null);
    setAnnexures([]);
    setPointFilter('all');
    setStatus('idle');
    setErrorMsg('');
    setActiveRun(null);
    if (inputRef.current) inputRef.current.value = '';
    if (annexureInputRef.current) annexureInputRef.current.value = '';
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setView(initialView);
    setExpandedRun(null);
    setHistoryRuns([]);
    setHistoryError('');
    reset();
  }, [isOpen, reportId, initialView, reset]);

  const handleClose = () => {
    if (status === 'running') return;
    reset();
    setView('run');
    onClose();
  };

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const res = await fetch(`/api/compliance/recheck/history?reportId=${reportId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        // Never fall through to the empty state — a failed load is not "no runs".
        throw new Error(data.error || `Could not load history (HTTP ${res.status}).`);
      }
      setHistoryRuns((data.runs ?? []).map(normalizeRun));
    } catch (e) {
      setHistoryRuns([]);
      setHistoryError(e instanceof Error ? e.message : 'Could not load re-check history.');
    } finally {
      setHistoryLoading(false);
    }
  }, [reportId]);

  useEffect(() => {
    if (isOpen && view === 'history') loadHistory();
  }, [isOpen, view, loadHistory]);

  const runRecheck = async () => {
    if (!file) return;
    setStatus('running');
    setErrorMsg('');
    setActiveRun(null);
    try {
      const fd = new FormData();
      fd.append('reportId', reportId);
      fd.append('file', file);
      annexures.forEach((a) => fd.append('annexures', a));
      const res = await fetch('/api/compliance/recheck', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setErrorMsg(data.error || 'Re-check failed.');
        setStatus('error');
        return;
      }
      setActiveRun(normalizeRun({ ...data, createdAt: new Date().toISOString() }));
      setStatus('done');
      onRechecked?.();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'Re-check failed.');
      setStatus('error');
    }
  };

  if (!isOpen) return null;

  const pickFile = (f: File | null) => {
    setFile(f);
    setStatus('idle');
    setActiveRun(null);
    setErrorMsg('');
  };

  /** Annexures (forms, logs, record templates) audited together with the revised SOP. */
  const addAnnexures = (list: FileList | File[] | null) => {
    if (!list) return;
    const incoming = Array.from(list).filter((f) => /\.(pdf|docx)$/i.test(f.name));
    if (incoming.length) {
      setAnnexures((prev) => {
        const seen = new Set(prev.map((f) => `${f.name}:${f.size}`));
        return [...prev, ...incoming.filter((f) => !seen.has(`${f.name}:${f.size}`))];
      });
    }
    if (annexureInputRef.current) annexureInputRef.current.value = '';
  };

  const removeAnnexure = (index: number) =>
    setAnnexures((prev) => prev.filter((_, i) => i !== index));

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-2 bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-[98vw] h-[96vh] max-w-none flex flex-col overflow-hidden">
        <div className="shrink-0 flex items-center justify-between gap-3 px-6 py-3 border-b border-gray-200">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-lg bg-purple-50 border border-purple-200 shrink-0">
              <ShieldCheck className="h-4 w-4 text-purple-700" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-black text-gray-900 uppercase tracking-wide">Re-check Revised SOP</h2>
              <p className="text-xs text-gray-500 mt-0.5 truncate">
                {sopIdentifier}
                {sopName ? ` — ${sopName}` : ''}
              </p>
            </div>
            {exportableRun && <VerdictPill run={exportableRun} />}
            {exportableRun && exportableRun.results.length > 0 && (
              <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-0.5 shrink-0">
                {([
                  { key: 'all', label: 'All', count: exportableRun.results.length, active: 'bg-gray-800 text-white' },
                  { key: 'solved', label: 'Solved', count: solvedCount, active: 'bg-emerald-600 text-white' },
                  { key: 'open', label: 'Not solved', count: notSolvedCount, active: 'bg-amber-600 text-white' },
                ] as const).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setPointFilter(opt.key)}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-bold whitespace-nowrap transition-colors ${
                      pointFilter === opt.key ? opt.active : 'text-gray-600 hover:bg-gray-100'
                    }`}
                    title={`Show ${opt.label.toLowerCase()} points`}
                  >
                    {opt.label}
                    <span
                      className={`rounded px-1 text-[10px] font-black ${
                        pointFilter === opt.key ? 'bg-white/25' : 'bg-white border border-gray-200'
                      }`}
                    >
                      {opt.count}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {exportableRun && (
              <>
                <button
                  type="button"
                  onClick={() => void handleCopyAllText()}
                  disabled={copyingText}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold border border-gray-200 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  title="Copy all re-check text to the clipboard"
                >
                  {copyingText ? (
                    <Check className="h-3.5 w-3.5 text-emerald-600" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copyingText ? 'Copied' : 'Copy text'}
                </button>
                <button
                  type="button"
                  onClick={() => void handleExportPdf()}
                  disabled={exportingPdf}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50"
                  title="Download this re-check as a PDF named after the SOP"
                >
                  {exportingPdf ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FileDown className="h-3.5 w-3.5" />
                  )}
                  {exportingPdf ? 'Preparing…' : 'Export PDF'}
                </button>
              </>
            )}
            {view === 'run' && file && status !== 'running' && (
              <button
                type="button"
                onClick={reset}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold text-gray-500 border border-gray-200 hover:bg-gray-50"
              >
                Clear
              </button>
            )}
            {view === 'run' && (
              <button
                type="button"
                onClick={() => void runRecheck()}
                disabled={!file || status === 'running'}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-black bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40"
              >
                {status === 'running' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="h-3.5 w-3.5" />
                )}
                {status === 'running' ? 'Re-checking…' : status === 'done' ? 'Re-check again' : 'Run AI Re-check'}
              </button>
            )}
            <button
              type="button"
              onClick={() => setView((v) => (v === 'run' ? 'history' : 'run'))}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold border transition-colors ${
                view === 'history'
                  ? 'bg-purple-600 text-white border-purple-600'
                  : 'text-purple-700 border-purple-200 bg-purple-50 hover:bg-purple-100'
              }`}
            >
              <History className="h-3.5 w-3.5" />
              {view === 'history' ? 'Back to Re-check' : 'History'}
            </button>
            <button
              type="button"
              onClick={handleClose}
              disabled={status === 'running'}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 disabled:opacity-40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div ref={scrollBodyRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-3 select-text">
          {view === 'run' ? (
            <>
              {status !== 'running' && (
                <div className="grid gap-3 lg:grid-cols-2">
                  {!file ? (
                    <label
                      onDragOver={(e) => {
                        e.preventDefault();
                        setDragOver(true);
                      }}
                      onDragLeave={() => setDragOver(false)}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOver(false);
                        pickFile(e.dataTransfer.files?.[0] ?? null);
                      }}
                      className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-6 cursor-pointer transition-all ${
                        dragOver
                          ? 'border-purple-400 bg-purple-50'
                          : 'border-gray-300 hover:border-purple-300 hover:bg-gray-50'
                      }`}
                    >
                      <input
                        ref={inputRef}
                        type="file"
                        accept=".pdf,.docx"
                        className="hidden"
                        onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                      />
                      <UploadCloud className="h-6 w-6 text-gray-400" />
                      <p className="text-sm font-semibold text-gray-700">Upload the revised SOP</p>
                      <p className="text-xs text-gray-400">
                        Drag &amp; drop or click — PDF or DOCX (DOCX recommended)
                      </p>
                    </label>
                  ) : (
                    <div className="flex items-center gap-2 rounded-xl border border-purple-200 bg-purple-50 px-4 py-3">
                      <FileText className="h-5 w-5 text-purple-600 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-black uppercase tracking-wide text-purple-700">
                          Revised SOP
                        </p>
                        <p className="truncate text-xs font-semibold text-gray-800" title={file.name}>
                          {file.name}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => pickFile(null)}
                        className="shrink-0 rounded border border-purple-200 bg-white px-2 py-0.5 text-[10px] font-bold text-purple-700 hover:bg-purple-100"
                      >
                        Change
                      </button>
                    </div>
                  )}

                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      addAnnexures(e.dataTransfer.files);
                    }}
                    className="rounded-xl border-2 border-dashed border-gray-300 px-4 py-3"
                  >
                    <input
                      ref={annexureInputRef}
                      type="file"
                      accept=".pdf,.docx"
                      multiple
                      className="hidden"
                      onChange={(e) => addAnnexures(e.target.files)}
                    />
                    <div className="flex items-center gap-2">
                      <Paperclip className="h-4 w-4 text-gray-400 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-semibold text-gray-700">
                          Annexures (optional)
                        </p>
                        <p className="text-[11px] text-gray-400">
                          Forms, logs and record templates — audited as evidence with the SOP.
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => annexureInputRef.current?.click()}
                        className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] font-bold text-gray-700 hover:bg-gray-50"
                      >
                        <Plus className="h-3 w-3" />
                        Add files
                      </button>
                    </div>
                    {annexures.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {annexures.map((a, i) => (
                          <span
                            key={`${a.name}-${i}`}
                            className="inline-flex items-center gap-1 rounded border border-gray-200 bg-gray-50 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700"
                            title={a.name}
                          >
                            <Paperclip className="h-3 w-3 text-gray-400" />
                            <span className="max-w-[180px] truncate">{a.name}</span>
                            <button
                              type="button"
                              onClick={() => removeAnnexure(i)}
                              className="text-gray-400 hover:text-rose-600"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {file && status === 'idle' && (
                <p className="text-xs text-gray-500">
                  {annexures.length
                    ? `SOP + ${annexures.length} annexure file(s) ready — click `
                    : 'File ready — click '}
                  <span className="font-semibold text-purple-700">Run AI Re-check</span> in the header.
                </p>
              )}

              {status === 'running' && (
                <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
                  <Loader2 className="h-8 w-8 animate-spin text-purple-600" />
                  <p className="text-sm font-semibold text-gray-600">
                    Verifying prior points and scanning for new issues…
                  </p>
                </div>
              )}

              {status === 'error' && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
                  <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                  <p className="text-sm text-rose-700 font-medium">{errorMsg}</p>
                </div>
              )}

              {status === 'done' && activeRun && (
                <div ref={exportRootRef}>
                  <RunView
                    run={activeRun}
                    hideBanner
                    forceExpandCards={exportingPdf}
                    exportMeta={{ sopIdentifier, sopName }}
                    statusFilter={pointFilter}
                  />
                </div>
              )}
            </>
          ) : (
            <>
              {historyLoading ? (
                <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
                  <Loader2 className="h-5 w-5 animate-spin" /> Loading history…
                </div>
              ) : historyError ? (
                <div className="mx-auto max-w-md text-center py-12 space-y-3">
                  <div className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {historyError}
                  </div>
                  <div>
                    <button
                      type="button"
                      onClick={() => void loadHistory()}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100"
                    >
                      Retry
                    </button>
                  </div>
                </div>
              ) : historyRuns.length === 0 ? (
                <div className="text-center py-12 text-sm text-gray-500">
                  No re-check runs yet for this SOP.
                </div>
              ) : (
                <div className="space-y-2">
                  {historyRuns.map((r) => (
                    <div key={r.id} className="rounded-xl border border-gray-200">
                      <div className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
                        <button
                          type="button"
                          onClick={() => {
                            setPointFilter('all');
                            setExpandedRun((cur) => (cur === r.id ? null : r.id));
                          }}
                          className="flex items-center gap-3 text-left min-w-0 flex-1"
                        >
                          <span className={`shrink-0 text-center rounded-lg border px-2.5 py-1 ${scoreColor(r.score)}`}>
                            <span className="text-sm font-black">{r.score.toFixed(1)}</span>
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-bold text-gray-800">
                              Re-check run
                              {r.createdAt ? ` · ${new Date(r.createdAt).toLocaleString()}` : ''}
                            </p>
                            <p className="text-[11px] text-gray-500">
                              {r.resolvedCount}/{r.results.length} addressed
                              {r.newIssues.filter((n) => !n.ignored).length
                                ? ` · ${r.newIssues.filter((n) => !n.ignored).length} new`
                                : ''}
                              {r.annexureStatusTracked
                                ? r.annexuresRead
                                  ? ' · annexures considered'
                                  : ' · annexures not considered'
                                : ''}
                            </p>
                          </div>
                        </button>
                        {r.fileUrl && (
                          <a
                            href={r.fileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="shrink-0 inline-flex items-center gap-1 text-[10px] font-bold text-purple-700 border border-purple-200 bg-purple-50 rounded px-1.5 py-0.5 hover:bg-purple-100"
                          >
                            <ExternalLink className="h-3 w-3" />
                            Open SOP
                          </a>
                        )}
                        <span
                          className={`shrink-0 text-[9px] font-black uppercase px-1.5 py-0.5 rounded ${
                            r.verdict === 'compliant'
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}
                        >
                          {r.verdict === 'compliant' ? 'Compliant' : 'Issues'}
                        </span>
                      </div>
                      {expandedRun === r.id && (
                        <div ref={exportRootRef} className="border-t border-gray-100 px-4 py-4">
                          <RunView
                            run={r}
                            hideBanner
                            compact
                            forceExpandCards={exportingPdf}
                            exportMeta={{ sopIdentifier, sopName }}
                            statusFilter={pointFilter}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="shrink-0 px-6 py-3 border-t border-gray-200 bg-white flex items-center justify-end">
          <button
            type="button"
            onClick={handleClose}
            disabled={status === 'running'}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50 disabled:opacity-40"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
