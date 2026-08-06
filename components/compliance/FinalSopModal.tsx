'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Download,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  FileText,
  RefreshCw,
  ThumbsUp,
} from 'lucide-react';

export interface SopFix {
  originalText: string;
  replacementText: string;
  section: string;
  clauseNumber: string;
  clauseTitle: string;
}

interface FinalSopModalProps {
  isOpen: boolean;
  onClose: () => void;
  sopId?: string;
  sopIdentifier?: string;
  sopName?: string;
  department?: string;
  fixes: SopFix[];
  /** Actionable fixes not yet accepted or implemented */
  pendingApprovalCount?: number;
  onApproveAll?: () => Promise<void>;
  onRerunCompliance?: () => void;
  rerunning?: boolean;
}

function parseFilename(cd: string | null, fallback: string): string {
  if (!cd) return fallback;
  const quoted = cd.match(/filename="([^"]+)"/i);
  if (quoted?.[1]) return quoted[1];
  return fallback;
}

const HIGHLIGHT_COLORS = [
  { bg: 'rgba(253, 224, 71, 0.55)', outline: '#f59e0b' },
  { bg: 'rgba(167, 243, 208, 0.55)', outline: '#10b981' },
  { bg: 'rgba(191, 219, 254, 0.55)', outline: '#3b82f6' },
  { bg: 'rgba(254, 205, 211, 0.55)', outline: '#f43f5e' },
];

function highlightChangedTexts(container: HTMLElement, replacementTexts: string[]) {
  const needles = replacementTexts
    .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 80).toLowerCase())
    .filter(Boolean);
  if (!needles.length) return;

  const els = container.querySelectorAll<HTMLElement>('p, span');
  let scrollTarget: HTMLElement | null = null;

  els.forEach((el) => {
    if ((el.children?.length ?? 0) > 5) return;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').toLowerCase();
    const idx = needles.findIndex((needle) => text.includes(needle));
    if (idx >= 0) {
      const color = HIGHLIGHT_COLORS[idx % HIGHLIGHT_COLORS.length];
      el.style.backgroundColor = color.bg;
      el.style.outline = `2px solid ${color.outline}`;
      el.style.borderRadius = '2px';
      if (!scrollTarget) scrollTarget = el;
    }
  });

  if (scrollTarget) {
    (scrollTarget as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

export default function FinalSopModal({
  isOpen,
  onClose,
  sopId,
  sopIdentifier,
  sopName,
  department,
  fixes,
  pendingApprovalCount = 0,
  onApproveAll,
  onRerunCompliance,
  rerunning = false,
}: FinalSopModalProps) {
  const [status, setStatus] = useState<
    'idle' | 'needs-approval' | 'loading' | 'rendering' | 'done' | 'error'
  >('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<{ applied: number; skipped: number } | null>(null);
  const [docxBlob, setDocxBlob] = useState<Blob | null>(null);
  const [filename, setFilename] = useState(`FINAL_SOP_${sopIdentifier ?? 'SOP'}.docx`);
  const [approvingAll, setApprovingAll] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const runIdRef = useRef(0);

  const fixCount = fixes.length;
  const needsApproval = fixCount === 0 && pendingApprovalCount > 0;

  const fetchAndRender = useCallback(async () => {
    if (!sopId || !fixes.length) return;

    const runId = ++runIdRef.current;
    setStatus('loading');
    setErrorMsg(null);
    setExportResult(null);
    setDocxBlob(null);

    let blob: Blob;
    let fname = `FINAL_SOP_${sopIdentifier ?? 'SOP'}.docx`;
    try {
      const res = await fetch('/api/compliance/final-sop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sopId,
          fixes: fixes.map((f) => ({
            originalText: f.originalText,
            replacementText: f.replacementText,
            clauseTitle: f.clauseTitle,
            section: f.section,
          })),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to generate final SOP.');
      }

      const applied = Number(res.headers.get('X-Applied-Count') ?? fixes.length);
      const skipped = Number(res.headers.get('X-Skipped-Count') ?? 0);
      setExportResult({ applied, skipped });
      fname = parseFilename(res.headers.get('Content-Disposition'), fname);
      blob = await res.blob();
    } catch (e: unknown) {
      if (runId !== runIdRef.current) return;
      setErrorMsg(e instanceof Error ? e.message : 'Failed to load final SOP.');
      setStatus('error');
      return;
    }

    if (runId !== runIdRef.current) return;
    setFilename(fname);
    setDocxBlob(blob);
    setStatus('rendering');

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (runId !== runIdRef.current) return;

    const container = containerRef.current;
    if (!container) {
      setErrorMsg('Preview container not available.');
      setStatus('error');
      return;
    }

    try {
      const { renderAsync } = await import('docx-preview');
      container.innerHTML = '';
      await renderAsync(blob, container, undefined, {
        className: 'docx',
        ignoreWidth: false,
        ignoreHeight: true,
        ignoreFonts: false,
        breakPages: true,
        useBase64URL: true,
        renderHeaders: true,
        renderFooters: true,
      });
      highlightChangedTexts(
        container,
        fixes.map((f) => f.replacementText),
      );
    } catch (e: unknown) {
      if (runId !== runIdRef.current) return;
      setErrorMsg(e instanceof Error ? e.message : 'Failed to render document preview.');
      setStatus('error');
      return;
    }

    if (runId !== runIdRef.current) return;
    setStatus('done');
  }, [sopId, fixes, sopIdentifier]);

  useEffect(() => {
    if (!isOpen) {
      runIdRef.current++;
      setStatus('idle');
      setDocxBlob(null);
      setErrorMsg(null);
      setApprovingAll(false);
      if (containerRef.current) containerRef.current.innerHTML = '';
      return;
    }

    if (needsApproval) {
      setStatus('needs-approval');
      setDocxBlob(null);
      setErrorMsg(null);
      if (containerRef.current) containerRef.current.innerHTML = '';
      return;
    }

    if (!fixes.length) {
      setStatus('error');
      setErrorMsg('No approved fixes to include in the final SOP.');
      return;
    }

    void fetchAndRender();
  }, [isOpen, fetchAndRender, needsApproval, fixes.length]);

  const handleApproveAll = async () => {
    if (!onApproveAll) return;
    setApprovingAll(true);
    setErrorMsg(null);
    try {
      await onApproveAll();
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : 'Failed to approve fixes.');
      setStatus('error');
    } finally {
      setApprovingAll(false);
    }
  };

  const handleDownload = () => {
    if (!docxBlob) return;
    const url = URL.createObjectURL(docxBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const summaryLine = useMemo(() => {
    if (needsApproval) {
      return `${pendingApprovalCount} proposed change${pendingApprovalCount !== 1 ? 's' : ''} awaiting approval`;
    }
    if (!exportResult) {
      return `${fixCount} approved change${fixCount !== 1 ? 's' : ''} applied to this preview (highlighted)`;
    }
    return `${exportResult.applied} approved fix${exportResult.applied !== 1 ? 'es' : ''} applied${exportResult.skipped > 0 ? `, ${exportResult.skipped} skipped` : ''} — changed sections highlighted`;
  }, [exportResult, fixCount, needsApproval, pendingApprovalCount]);

  if (!isOpen) return null;

  const isLoading = status === 'loading' || status === 'rendering';

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl h-[92vh] flex flex-col overflow-hidden">
        <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-200 shrink-0">
              <FileText className="h-4 w-4 text-emerald-700" />
            </div>
            <div>
              <h2 className="text-sm font-black text-gray-900 uppercase tracking-wide">Final SOP Preview</h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {sopIdentifier}{sopName ? ` — ${sopName}` : ''}{department ? ` · ${department}` : ''}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          className={`shrink-0 px-6 py-2 border-b flex items-center gap-2 flex-wrap ${
            needsApproval ? 'bg-amber-50 border-amber-100' : 'bg-emerald-50 border-emerald-100'
          }`}
        >
          {needsApproval ? (
            <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
          )}
          <span
            className={`text-[11px] font-semibold ${needsApproval ? 'text-amber-900' : 'text-emerald-900'}`}
          >
            {summaryLine}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto bg-gray-300 relative">
          {status === 'needs-approval' && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 p-8 bg-gray-50">
              <ThumbsUp className="h-10 w-10 text-amber-500" />
              <div className="text-center max-w-md space-y-2">
                <p className="text-sm font-bold text-gray-900">No fixes approved yet</p>
                <p className="text-sm text-gray-600">
                  The final SOP only includes changes you have approved. Review the findings below, or approve all{' '}
                  {pendingApprovalCount} proposed change{pendingApprovalCount !== 1 ? 's' : ''} to generate the preview.
                </p>
              </div>
              {onApproveAll && (
                <button
                  type="button"
                  onClick={() => void handleApproveAll()}
                  disabled={approvingAll}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-black bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 shadow-md shadow-emerald-200"
                >
                  {approvingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}
                  {approvingAll ? 'Approving…' : `Approve all ${pendingApprovalCount} fix${pendingApprovalCount !== 1 ? 'es' : ''}`}
                </button>
              )}
            </div>
          )}
          {isLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-gray-100/90">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-600" />
              <p className="text-sm font-semibold text-gray-600">
                {status === 'loading' ? 'Applying approved fixes and building final SOP…' : 'Rendering preview…'}
              </p>
            </div>
          )}
          {status === 'error' && !needsApproval && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-8 bg-gray-50">
              <AlertTriangle className="h-8 w-8 text-rose-400" />
              <p className="text-sm text-rose-700 text-center max-w-md font-medium">{errorMsg}</p>
              {fixes.length > 0 && (
                <button
                  type="button"
                  onClick={() => void fetchAndRender()}
                  className="mt-2 px-4 py-2 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700"
                >
                  Retry
                </button>
              )}
            </div>
          )}
          <div ref={containerRef} className="min-h-full" />
        </div>

        <div className="shrink-0 px-6 py-4 border-t border-gray-200 bg-white flex items-center justify-between gap-3 flex-wrap">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-600 border border-gray-200 hover:bg-gray-50"
          >
            Close
          </button>

          <div className="flex items-center gap-2 flex-wrap">
            {onRerunCompliance && (
              <button
                type="button"
                onClick={onRerunCompliance}
                disabled={rerunning || isLoading || needsApproval || !docxBlob}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold border border-purple-300 bg-purple-50 text-purple-800 hover:bg-purple-100 disabled:opacity-50"
              >
                {rerunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {rerunning ? 'Starting…' : 'Rerun Compliance'}
              </button>
            )}
            <button
              type="button"
              onClick={handleDownload}
              disabled={!docxBlob || isLoading || needsApproval}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-black bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 shadow-md shadow-emerald-200 transition-all"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              Download Final SOP
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
