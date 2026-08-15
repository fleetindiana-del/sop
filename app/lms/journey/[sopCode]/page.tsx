'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Check, ChevronLeft, ChevronRight, PlayCircle,
  FileText, BookOpen, ClipboardList, Loader2, AlertCircle,
  Volume2, Trophy, X, Award, RefreshCw, Clock,
  Maximize2, Flag, XCircle,
} from 'lucide-react';
import type { JourneyStep } from '@/app/api/lms/journey/[sopCode]/route';
import {
  BrandlessVideoPlayer,
  orderLmsVideos,
} from '@/components/shared/BrandlessVideoPlayer';
import { BrandlessSlidesViewer } from '@/components/shared/BrandlessSlidesViewer';
import { RestrictedLmsDocxPreview } from '@/components/lms/RestrictedLmsDocxPreview';
import {
  getCachedLmsEmployeeId,
  invalidateLmsClientFields,
  lmsClientFields,
  LMS_CLIENT_FRESH_MS,
  readLmsClientCache,
  writeLmsClientCache,
} from '@/lib/lmsCache';

// ─── Types ────────────────────────────────────────────────────────────────────

interface MCQQuestion {
  _id: string;
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: 'A' | 'B' | 'C' | 'D';
  explanation: string;
  /** MCQ Bank SOP section / clause reference, e.g. "4.2.1 — …". */
  sopReference?: string;
  /**
   * Gujarati rendering of this same MCQ (trainer bilingual view only). Its options
   * sit at the same letters as the English ones, so `correctAnswer` scores both.
   */
  alt?: {
    question: string;
    optionA: string;
    optionB: string;
    optionC: string;
    optionD: string;
  };
}

interface AttemptScore {
  attempt: number;
  score: number;
}

interface DisplayOption {
  label: 'A' | 'B' | 'C' | 'D';
  text: string;
  /** Same option in the second language — carried on the same letter. */
  altText?: string;
}
interface PreparedQuestion extends MCQQuestion { displayOptions: DisplayOption[]; }

interface QuizSettings {
  passingScore: number;
  timeLimitMinutes: number;
  shuffleMode?: 'options' | 'questions' | 'both' | 'none';
  shuffleQuestions?: boolean;
  shuffleOptions: boolean;
  showAnswersAfterTrial: boolean;
  allowRetakeAfterPass?: boolean;
  maxAttempts: number;       // total exam attempts before answers are revealed (0 = unlimited)
  examQuestionCount: number; // full-exam question count, used to pace the timer
  trialQuestionCount?: number;
  isTrainer?: boolean;
  allExamQuestions?: boolean;
}

interface JourneyData {
  sop: { name: string; identifier: string; department: string } | null;
  progress: { overallPercentage: number; status: string; steps: Record<string, unknown> } | null;
  steps: JourneyStep[];
  availableSteps: string[];
}

// ─── Step icon mapping ────────────────────────────────────────────────────────

function StepIcon({ type, size = 4 }: { type: string; size?: number }) {
  const cls = `h-${size} w-${size}`;
  if (type === 'video')  return <PlayCircle className={cls} />;
  if (type === 'slides') return <FileText className={cls} />;
  if (type === 'pdf')    return <BookOpen className={cls} />;
  if (type === 'quiz')   return <ClipboardList className={cls} />;
  return <FileText className={cls} />;
}

// ─── Video step ───────────────────────────────────────────────────────────────

const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

function VideoStep({
  step,
  onProgress,
  onComplete,
}: {
  step: JourneyStep;
  onProgress: (pct: number, ts: number) => void;
  onComplete: () => void;
}) {
  const [currentIdx, setCurrentIdx] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [expanded, setExpanded] = useState(false);
  const videos = useMemo(() => orderLmsVideos(step.urls || []), [step.urls]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  if (videos.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-400">
        <p className="text-sm">No video available for this step.</p>
      </div>
    );
  }

  const active = videos[Math.min(currentIdx, videos.length - 1)];

  const handleNearEnd = () => {
    if (currentIdx < videos.length - 1) {
      setCurrentIdx((i) => i + 1);
    } else {
      onProgress(100, 0);
      onComplete();
    }
  };

  const player = (fillParent: boolean) => (
    <BrandlessVideoPlayer
      url={active.url}
      startAt={currentIdx === 0 ? (step.lastTimestamp ?? 0) : 0}
      playbackRate={speed}
      maxHeight={fillParent ? '100%' : '60vh'}
      fillParent={fillParent}
      hideFullscreenButton
      onProgress={onProgress}
      onNearEnd={handleNearEnd}
    />
  );

  return (
    <div className="flex flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {videos.map((v, i) => (
            <button
              key={`${v.label}-${i}`}
              onClick={() => setCurrentIdx(i)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                i === currentIdx ? 'bg-purple-600 text-white' : 'border border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
              title={v.label === 'Short' ? 'Brief video' : 'Explainer video'}
            >
              {v.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100"
        >
          <Maximize2 className="h-3.5 w-3.5" /> Expand View
        </button>
      </div>

      {!expanded && (
        <div className="relative overflow-hidden rounded-xl bg-black shadow-lg select-none">
          {player(false)}
        </div>
      )}
      {expanded && (
        <div className="flex h-[40vh] items-center justify-center rounded-xl border border-dashed border-gray-200 bg-gray-50 text-xs text-gray-400">
          Playing in Expand View…
        </div>
      )}

      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs font-medium text-gray-400">Speed:</span>
        <div className="flex gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                speed === s
                  ? 'bg-purple-600 text-white'
                  : 'border border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
        <span className="ml-auto flex items-center gap-1 text-xs text-gray-400">
          <Volume2 className="h-3.5 w-3.5" /> Audio controls in player
        </span>
      </div>

      {step.completed ? (
        <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700">
          <Check className="h-3.5 w-3.5" /> Marked as watched. You may re-watch anytime.
        </div>
      ) : (
        <button
          onClick={() => { onProgress(100, 0); onComplete(); }}
          className="flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          <Check className="h-4 w-4 text-green-500" /> Mark as Watched
        </button>
      )}

      {expanded && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 bg-black/90 px-3 py-2 sm:px-4">
            <div className="flex min-w-0 items-center gap-2">
              <PlayCircle className="h-4 w-4 shrink-0 text-purple-400" />
              <span className="truncate text-sm font-semibold text-white">
                {step.label || 'Video'} · {active.label}
              </span>
              <div className="ml-2 hidden items-center gap-1 sm:flex">
                {videos.map((v, i) => (
                  <button
                    key={`exp-${v.label}-${i}`}
                    onClick={() => setCurrentIdx(i)}
                    className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition ${
                      i === currentIdx
                        ? 'bg-purple-600 text-white'
                        : 'bg-white/10 text-white/70 hover:bg-white/20'
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
              title="Close (Esc)"
            >
              <X className="h-3.5 w-3.5" /> Close
            </button>
          </div>
          <div className="min-h-0 flex-1 p-2 sm:p-3">
            <div className="h-full overflow-hidden rounded-lg bg-black">
              {player(true)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Slides step ──────────────────────────────────────────────────────────────

function isPptUrl(url: string): boolean {
  return /\.pptx?($|\?)/i.test(String(url || ''));
}

function isPdfUrl(url: string): boolean {
  return /\.pdf($|\?)/i.test(String(url || ''));
}

function officeEmbedUrl(url: string): string {
  return `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;
}

function SlidesStep({
  step,
  onComplete,
}: {
  step: JourneyStep;
  onComplete: () => void;
}) {
  const urls = step.urls || [];
  const [currentIdx, setCurrentIdx] = useState(0);
  const [acknowledged, setAcknowledged] = useState(step.completed);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState('');

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
      if ((e.ctrlKey || e.metaKey) && ['s', 'S', 'p', 'P', 'c', 'C'].includes(e.key)) {
        e.preventDefault();
      }
    };
    const block = (e: Event) => e.preventDefault();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('contextmenu', block);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('contextmenu', block);
    };
  }, [fullscreen]);

  useEffect(() => {
    const raw = urls[currentIdx];
    if (!raw) {
      setViewerSrc(null);
      return;
    }
    let cancelled = false;
    setViewerError('');
    setViewerSrc(null);

    (async () => {
      try {
        if (isPptUrl(raw) && /^https?:\/\//i.test(raw)) {
          // Office Online needs a public URL; download chrome is masked in the UI.
          if (!cancelled) setViewerSrc(officeEmbedUrl(raw));
          return;
        }
        const res = await fetch('/api/lms/media/view', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: raw }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.viewUrl) {
          throw new Error(json.error || 'Could not open slides for viewing.');
        }
        if (!cancelled) setViewerSrc(json.viewUrl as string);
      } catch (e: unknown) {
        if (!cancelled) {
          setViewerError(e instanceof Error ? e.message : 'Failed to load slides.');
          setViewerSrc(isPptUrl(raw) ? officeEmbedUrl(raw) : raw);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [urls, currentIdx]);

  if (urls.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-400">
        <p className="text-sm">No slides available for this step.</p>
      </div>
    );
  }

  const isLast = currentIdx === urls.length - 1;
  const usingOffice = Boolean(viewerSrc && viewerSrc.includes('officeapps.live.com'));
  const rawUrl = urls[currentIdx] || '';
  const viewingPdf = Boolean(viewerSrc && !usingOffice && (isPdfUrl(rawUrl) || viewerSrc.includes('/api/lms/media/view')));
  // Chrome blocks its built-in PDF viewer inside a sandboxed iframe — never sandbox PDF/proxy embeds.
  const frameSrc = viewingPdf && viewerSrc
    ? `${viewerSrc}${viewerSrc.includes('#') ? '' : '#toolbar=0&navpanes=0&scrollbar=1'}`
    : viewerSrc;

  const frame = frameSrc ? (
    <BrandlessSlidesViewer
      src={frameSrc}
      title={`${step.label} - Deck ${currentIdx + 1}`}
      mode={usingOffice ? 'office' : viewingPdf ? 'pdf' : 'iframe'}
      style={fullscreen ? { height: '100%' } : { minHeight: '55vh' }}
    />
  ) : (
    <div className="flex min-h-[55vh] items-center justify-center bg-stone-100">
      {viewerError ? (
        <p className="px-4 text-center text-sm text-red-600">{viewerError}</p>
      ) : (
        <Loader2 className="h-7 w-7 animate-spin text-purple-500" />
      )}
    </div>
  );

  return (
    <div
      className="flex flex-1 flex-col gap-3 select-none"
      onContextMenu={(e) => e.preventDefault()}
      onCopy={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          Presentation · Deck {currentIdx + 1} of {urls.length}
          {isPdfUrl(urls[currentIdx]) ? ' · PDF' : isPptUrl(urls[currentIdx]) ? ' · PPT' : ''}
          {' · view only'}
        </p>
        <button
          type="button"
          onClick={() => setFullscreen(true)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50"
        >
          <Maximize2 className="h-3.5 w-3.5" /> Full Screen
        </button>
      </div>

      {urls.length > 1 && (
        <div className="flex items-center gap-2">
          {urls.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setCurrentIdx(i)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                i === currentIdx ? 'bg-purple-600 text-white' : 'border border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
            >
              Deck {i + 1}
            </button>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        {frame}
      </div>

      {!acknowledged && isLast && (
        <button
          type="button"
          onClick={() => { setAcknowledged(true); onComplete(); }}
          className="flex items-center justify-center gap-2 rounded-lg bg-purple-600 py-2.5 text-sm font-medium text-white hover:bg-purple-700"
        >
          <Check className="h-4 w-4" /> Mark Slides as Viewed
        </button>
      )}
      {(acknowledged || step.completed) && (
        <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700">
          <Check className="h-3.5 w-3.5" /> Slides reviewed. You can revisit them anytime.
        </div>
      )}

      {fullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-stone-900">
          <div className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
            <p className="min-w-0 flex-1 truncate text-sm font-semibold text-white">
              {step.label} · Deck {currentIdx + 1}/{urls.length} · view only
            </p>
            {urls.length > 1 && (
              <div className="flex items-center gap-1">
                {urls.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setCurrentIdx(i)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                      i === currentIdx ? 'bg-white text-stone-900' : 'bg-white/10 text-white/80 hover:bg-white/20'
                    }`}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setFullscreen(false)}
              className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-semibold text-white hover:bg-white/20"
            >
              Exit Full Screen
            </button>
          </div>
          <div className="min-h-0 flex-1 p-2 sm:p-3">
            <div className="h-full overflow-hidden rounded-lg bg-white shadow">{frame}</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PDF / Word step — dashboard docx-preview, view-only (no download) ───────

function PdfStep({
  step,
  sopIdentifier,
  onComplete,
}: {
  step: JourneyStep;
  sopIdentifier?: string | null;
  onComplete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(step.completed);

  const language =
    step.id === 'sopPdfGu' || /guj|gujarati/i.test(step.label || '')
      ? 'Gujarati'
      : 'English';

  const wordPath =
    step.url && /\.docx?($|\?)/i.test(step.url) ? step.url : null;

  useEffect(() => {
    if (!open && !fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (fullscreen && e.key === 'Escape') setFullscreen(false);
      if ((e.ctrlKey || e.metaKey) && ['c', 'C', 'x', 'X', 's', 'S', 'p', 'P', 'a', 'A'].includes(e.key)) {
        e.preventDefault();
      }
    };
    const block = (e: Event) => e.preventDefault();
    const prevOverflow = fullscreen ? document.body.style.overflow : null;
    if (fullscreen) document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('copy', block);
    document.addEventListener('cut', block);
    document.addEventListener('paste', block);
    document.addEventListener('contextmenu', block);
    return () => {
      if (prevOverflow !== null) document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('copy', block);
      document.removeEventListener('cut', block);
      document.removeEventListener('paste', block);
      document.removeEventListener('contextmenu', block);
    };
  }, [open, fullscreen]);

  if (!step.url && !sopIdentifier) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-400">
        <p className="text-sm">SOP document not available.</p>
      </div>
    );
  }

  const reviewed = acknowledged || step.completed;
  const markReviewed = () => { setAcknowledged(true); onComplete(); };

  const preview = (
    <RestrictedLmsDocxPreview
      pathParam={wordPath}
      identifierParam={sopIdentifier || null}
      languageParam={language}
    />
  );

  return (
    <div
      className="flex flex-1 flex-col gap-3 select-none"
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onPaste={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {!open && (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 rounded-2xl border border-gray-200 bg-linear-to-b from-gray-50 to-white py-16">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-md ring-1 ring-gray-100">
            <BookOpen className="h-8 w-8 text-purple-500" />
          </div>
          <div className="text-center">
            <p className="text-base font-semibold text-gray-700">SOP Document</p>
            <p className="mt-0.5 text-xs text-gray-400">
              Word preview · View only — download and copy are disabled
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={() => setOpen(true)}
              className="flex items-center gap-2 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-medium text-white shadow hover:bg-purple-700"
            >
              <BookOpen className="h-4 w-4" /> View Document
            </button>
            <button
              onClick={() => { setOpen(true); setFullscreen(true); }}
              className="flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-4 py-2.5 text-sm font-medium text-purple-700 hover:bg-purple-100"
            >
              <Maximize2 className="h-4 w-4" /> Read Fullscreen
            </button>
          </div>
          {step.completed ? (
            <span className="flex items-center gap-1.5 text-xs text-green-600">
              <Check className="h-3.5 w-3.5" /> Already marked as read
            </span>
          ) : (
            <button
              onClick={markReviewed}
              className="flex items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-green-600"
            >
              <Check className="h-3.5 w-3.5" /> Mark as Read (without opening)
            </button>
          )}
        </div>
      )}

      {/* Single preview instance — fullscreen only changes chrome, not remount. */}
      {open && (
        <>
          {!fullscreen && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <button
                onClick={() => setOpen(false)}
                className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Hide document
              </button>
              <button
                onClick={() => setFullscreen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100"
              >
                <Maximize2 className="h-3.5 w-3.5" /> Fullscreen
              </button>
            </div>
          )}

          <div
            className={
              fullscreen
                ? 'fixed inset-0 z-50 flex flex-col bg-[#e5e7eb]'
                : 'relative flex flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 bg-[#d1d5db] shadow-sm h-[70vh] sm:h-[76vh] lg:h-[80vh]'
            }
          >
            {fullscreen && (
              <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 bg-white px-3 py-2 shadow-sm sm:px-4">
                <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-gray-700">
                  <FileText className="h-4 w-4 shrink-0 text-purple-600" />
                  <span className="truncate">{step.label || 'SOP Document'}</span>
                  <span className="hidden rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 sm:inline">
                    View only
                  </span>
                </span>
                <div className="flex items-center gap-2">
                  {!reviewed && (
                    <button
                      onClick={markReviewed}
                      className="inline-flex items-center gap-1.5 rounded-md bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700"
                    >
                      <Check className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Mark as read</span>
                    </button>
                  )}
                  <button
                    onClick={() => setFullscreen(false)}
                    className="inline-flex items-center justify-center rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                    title="Close (Esc)"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
            <div className={fullscreen ? 'min-h-0 flex-1 overflow-hidden p-2 sm:p-3' : 'min-h-0 flex-1'}>
              <div className={fullscreen ? 'h-full overflow-hidden rounded-lg border border-gray-200 bg-[#d1d5db] shadow' : 'h-full'}>
                {preview}
              </div>
            </div>
          </div>

          {!fullscreen && (
            !reviewed ? (
              <button
                onClick={markReviewed}
                className="flex items-center justify-center gap-2 rounded-lg bg-purple-600 py-2.5 text-sm font-medium text-white hover:bg-purple-700"
              >
                <Check className="h-4 w-4" /> Confirm I have read this document
              </button>
            ) : (
              <div className="flex items-center gap-2 rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700">
                <Check className="h-3.5 w-3.5" /> Document reviewed. You can re-open it anytime.
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

// ─── Quiz step ────────────────────────────────────────────────────────────────

function shuffleArray<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function prepareQuestions(qs: MCQQuestion[], shuffleOpts: boolean): PreparedQuestion[] {
  return qs.map((q) => {
    // Shuffling moves the PAIR, so an option keeps the same letter in both
    // languages and the two panels can never drift apart.
    let opts: DisplayOption[] = [
      { label: 'A', text: q.optionA, altText: q.alt?.optionA },
      { label: 'B', text: q.optionB, altText: q.alt?.optionB },
      { label: 'C', text: q.optionC, altText: q.alt?.optionC },
      { label: 'D', text: q.optionD, altText: q.alt?.optionD },
    ];
    if (shuffleOpts) opts = shuffleArray(opts);
    return { ...q, displayOptions: opts };
  });
}

/** Gujarati line shown under its English counterpart on review cards. */
function AltLine({ text, className = '' }: { text?: string; className?: string }) {
  if (!text) return null;
  return (
    <p lang="gu" className={`mt-1 leading-relaxed text-gray-600 ${className}`}>
      {text}
    </p>
  );
}

/**
 * Trainer status from the LMS session cache. Used only to skip a language picker
 * that would have no effect — the server alone decides what a trainer is served.
 */
function cachedIsTrainer(): boolean {
  const cached = readLmsClientCache<{ employee?: { isTrainer?: boolean } }>(
    lmsClientFields.employee,
  );
  return cached?.value?.employee?.isTrainer === true;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const MAX_TAB_VIOLATIONS = 2; // warnings before auto-submit

/** Seconds allotted for a quiz. `timeLimitMinutes === 0` means no timer. */
function timerSecondsFor(settings: QuizSettings | null, questionCount: number): number {
  if (questionCount <= 0) return 0;
  const configured = settings?.timeLimitMinutes ?? 0;
  if (configured <= 0) return 0; // no limit
  const fullCount = settings?.examQuestionCount && settings.examQuestionCount > 0
    ? settings.examQuestionCount
    : questionCount;
  const perQuestion = (configured * 60) / fullCount;
  return Math.max(30, Math.ceil(perQuestion * questionCount));
}

function QuizStep({
  sopCode,
  sopName,
  step,
  onComplete,
  onExit,
}: {
  sopCode: string;
  sopName?: string;
  step: JourneyStep;
  onComplete: (score: number, passed: boolean, newAttempts: number) => void;
  onExit: () => void;
}) {
  const [localAttempts, setLocalAttempts] = useState(step.attempts ?? 0);
  const [attemptHistory, setAttemptHistory] = useState<AttemptScore[]>(() =>
    (step.attemptHistory || []).map((h) => ({ attempt: h.attempt, score: h.score })),
  );
  const [phase, setPhase] = useState<'loading' | 'intro' | 'answering' | 'review'>('loading');
  const [questions, setQuestions] = useState<PreparedQuestion[]>([]);
  const [settings, setSettings] = useState<QuizSettings | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [score, setScore] = useState(0);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [error, setError] = useState('');
  const submitRef = useRef<(() => void) | null>(null);

  // Retest: after a failed exam the learner re-attempts ONLY the questions they
  // missed, and must answer all of them correctly (100%) to pass.
  const [isRetest, setIsRetest] = useState(false);
  const [retestQueue, setRetestQueue] = useState<PreparedQuestion[]>([]);
  // Exam/retest attempts used this session — drives the attempt allocation.
  const [examAttempts, setExamAttempts] = useState(0);
  /** 'trial' = demo assessment; 'exam' = formal scored attempt. */
  const [quizMode, setQuizMode] = useState<'trial' | 'exam'>('exam');
  /** Per-question acknowledgements on the review screen (wrong + correct cards). */
  const [ackedQuestionIds, setAckedQuestionIds] = useState<Set<string>>(() => new Set());

  const sopTitle = (sopName || '').trim() || sopCode;

  // Tab-switch violation tracking (exam only)
  const violationsRef = useRef(0);
  const [violations, setViolations] = useState(0);
  const [showViolationWarning, setShowViolationWarning] = useState(false);
  const lastViolationTs = useRef(0);

  // Paginated navigator state (one-question-at-a-time test UI)
  const [currentIdx, setCurrentIdx] = useState(0);
  const [marked, setMarked] = useState<Set<number>>(new Set());
  const [visited, setVisited] = useState<Set<number>>(new Set([0]));

  // Reset the navigator whenever a fresh set of questions loads (trial/exam/retest).
  useEffect(() => {
    setCurrentIdx(0);
    setMarked(new Set());
    setVisited(new Set([0]));
  }, [questions]);

  // One assessment, two renderings of the same MCQs. The learner picks a language
  // (or arrives with ?lang=gu from the dashboard); the questions, their order and
  // the correct answers are identical either way.
  const offeredLangs: Array<'en' | 'gu'> = step.languages?.length ? step.languages : ['en'];
  const [lang, setLang] = useState<'en' | 'gu' | null>(() => {
    const deepLink = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('lang')
      : null;
    if (deepLink === 'gu' && offeredLangs.includes('gu')) return 'gu';
    if (deepLink === 'en' && offeredLangs.includes('en')) return 'en';
    // Trainers get both languages on every question — nothing to choose.
    if (cachedIsTrainer()) return 'en';
    // Only ask when there is genuinely a choice to make.
    return offeredLangs.length === 1 ? offeredLangs[0] : null;
  });
  /** Set when a completed learner retakes and should be asked the language again. */
  const [askLang, setAskLang] = useState(false);
  /** Server paired every question with its Gujarati rendering (trainer view). */
  const [bilingual, setBilingual] = useState(false);

  // `langOverride` lets the language picker start a retake immediately, before the
  // `lang` state update has propagated into this callback.
  const fetchQuestions = useCallback(async (
    mode: 'trial' | 'exam' = 'exam',
    langOverride?: 'en' | 'gu',
  ) => {
    const useLang = langOverride ?? lang;
    if (!useLang) return; // waiting on the language choice
    setPhase('loading');
    setAnswers({});
    setScore(0);
    setError('');
    setIsRetest(false);
    setRetestQueue([]);
    setAckedQuestionIds(new Set());
    if (mode === 'exam') setExamAttempts(0);
    try {
      const res = await fetch(`/api/lms/quiz/${sopCode}?mode=${mode}&lang=${useLang}`);
      const data = await res.json() as {
        questions?: MCQQuestion[];
        settings?: QuizSettings;
        error?: string;
        trainerPending?: boolean;
        sopExpired?: boolean;
        bilingual?: boolean;
      };

      if (!res.ok) {
        setSettings(data.settings ?? null);
        setError(
          data.error
          || (data.trainerPending
            ? 'Exam unlocks after your department trainer completes training for this SOP.'
            : data.sopExpired
              ? 'This SOP has expired. The exam is locked until the document is renewed.'
              : 'Unable to load the exam.'),
        );
        setPhase('review');
        return;
      }

      // Demo disabled or empty → fall through to formal exam.
      if (mode === 'trial') {
        const trialCount = data.settings?.trialQuestionCount ?? 0;
        if (trialCount <= 0 || !data.questions?.length) {
          setSettings(data.settings ?? null);
          const examRes = await fetch(`/api/lms/quiz/${sopCode}?mode=exam&lang=${useLang}`);
          const examData = await examRes.json() as {
            questions?: MCQQuestion[];
            settings?: QuizSettings;
            error?: string;
            trainerPending?: boolean;
            sopExpired?: boolean;
            bilingual?: boolean;
          };
          if (!examRes.ok || !examData.questions?.length) {
            setSettings(examData.settings ?? data.settings ?? null);
            setError(
              examData.error
              || (examData.trainerPending
                ? 'Exam unlocks after your department trainer completes training for this SOP.'
                : 'No questions available.'),
            );
            setPhase('review');
            return;
          }
          setSettings(examData.settings ?? data.settings ?? null);
          setQuizMode('exam');
          setBilingual(examData.bilingual === true);
          setQuestions(prepareQuestions(examData.questions, examData.settings?.shuffleOptions ?? false));
          setPhase('intro');
          return;
        }
      }

      if (!data.questions?.length) {
        setError(data.error || 'No questions available.');
        setPhase('review');
        return;
      }
      setSettings(data.settings ?? null);
      setQuizMode(mode);
      setBilingual(data.bilingual === true);
      setQuestions(prepareQuestions(data.questions, data.settings?.shuffleOptions ?? false));
      setPhase('intro');
    } catch {
      setError('Failed to load quiz. Please try again.');
      setPhase('review');
    }
  }, [sopCode, lang]);

  // Prefer demo first when configured; otherwise start on the formal exam.
  useEffect(() => {
    if (!step.completed && lang) void fetchQuestions('trial');
  }, [fetchQuestions, step.completed, lang]);

  // Countdown timer — only when an admin time limit is set (formal exam only).
  useEffect(() => {
    if (phase !== 'answering' || questions.length === 0 || quizMode === 'trial') {
      setTimeLeft(null);
      return;
    }
    const secs = timerSecondsFor(settings, questions.length);
    if (secs <= 0) { setTimeLeft(null); return; }
    setTimeLeft(secs);
    const interval = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(interval);
          submitRef.current?.();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [phase, settings, questions.length, quizMode]);

  // Tab-switch / focus-loss detection during formal exam only
  useEffect(() => {
    if (phase !== 'answering' || quizMode === 'trial') return;

    const fireViolation = () => {
      const now = Date.now();
      if (now - lastViolationTs.current < 800) return; // debounce
      lastViolationTs.current = now;

      violationsRef.current += 1;
      const v = violationsRef.current;
      setViolations(v);

      if (v > MAX_TAB_VIOLATIONS) {
        submitRef.current?.();
      } else {
        setShowViolationWarning(true);
      }
    };

    const onVisibilityChange = () => { if (document.hidden) fireViolation(); };
    const onBlur = () => fireViolation();

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('blur', onBlur);
    };
  }, [phase, quizMode]);

  const handleSubmit = useCallback(() => {
    let correct = 0;
    const wrong: PreparedQuestion[] = [];
    for (const q of questions) {
      if (answers[q._id] === q.correctAnswer) correct++;
      else wrong.push(q);
    }
    const pct = questions.length > 0 ? Math.round((correct / questions.length) * 100) : 0;
    setScore(pct);
    setRetestQueue(wrong);
    setAckedQuestionIds(new Set());
    setPhase('review');

    // Demo does not count toward attempts / progress.
    if (quizMode === 'trial') return;

    const newAttempts = localAttempts + 1;
    setLocalAttempts(newAttempts);
    setAttemptHistory((prev) => {
      const next = prev.filter((h) => h.attempt !== newAttempts);
      next.push({ attempt: newAttempts, score: pct });
      next.sort((a, b) => a.attempt - b.attempt);
      return next;
    });
    const required = isRetest ? 100 : (settings?.passingScore ?? 80);
    const passed = pct >= required;
    setExamAttempts((n) => n + 1);
    onComplete(pct, passed, newAttempts);
  }, [questions, answers, localAttempts, isRetest, settings, onComplete, quizMode]);

  // Keep ref in sync so timer can auto-submit
  useEffect(() => { submitRef.current = handleSubmit; }, [handleSubmit]);

  // Re-attempt only the questions missed in the previous attempt. Each retest
  // narrows to whatever is still wrong, and requires every answer to be correct.
  const startRetest = () => {
    const allAcked = retestQueue.every((q) => ackedQuestionIds.has(q._id));
    if (!allAcked) return;
    setQuestions(retestQueue);
    setAnswers({});
    setScore(0);
    setError('');
    setIsRetest(true);
    setQuizMode('exam');
    setAckedQuestionIds(new Set());
    setPhase('answering');
  };

  const toggleQuestionAck = (questionId: string, checked: boolean) => {
    setAckedQuestionIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(questionId);
      else next.delete(questionId);
      return next;
    });
  };

  const allowRetake = settings?.allowRetakeAfterPass !== false;

  const attemptHistoryBlock = attemptHistory.length > 0 ? (
    <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white px-4 py-3 text-left shadow-sm">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Attempt history</p>
      <ul className="space-y-1">
        {attemptHistory.map((h) => (
          <li key={h.attempt} className="flex items-center justify-between text-sm text-gray-700">
            <span>Attempt {h.attempt}</span>
            <span className="font-bold tabular-nums text-gray-900">{h.score}%</span>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  const showCompletedSummary =
    step.completed && phase === 'loading' && localAttempts === (step.attempts ?? 0);

  // ── Language selection — same exam, learner's choice of language ────────────
  if (askLang || (!lang && !showCompletedSummary)) {
    const pick = (l: 'en' | 'gu') => {
      setLang(l);
      // A retake is already past the auto-start effect, so kick it off here.
      if (askLang) { setAskLang(false); void fetchQuestions('exam', l); }
    };
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-5 py-12">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-purple-100">
          <ClipboardList className="h-8 w-8 text-purple-600" />
        </div>
        <div className="text-center">
          <p className="text-lg font-bold text-gray-800">Select language</p>
          <p className="mt-1 text-sm text-gray-500">
            The same questions are asked in both languages. / બંને ભાષામાં એક જ પ્રશ્નો પૂછવામાં આવે છે.
          </p>
        </div>
        <div className="grid w-full max-w-md grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            onClick={() => pick('en')}
            disabled={!offeredLangs.includes('en')}
            className="rounded-xl border border-gray-200 bg-white py-4 text-base font-semibold text-gray-700 shadow-sm hover:border-purple-300 hover:bg-purple-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            English
          </button>
          <button
            onClick={() => pick('gu')}
            disabled={!offeredLangs.includes('gu')}
            className="rounded-xl bg-purple-600 py-4 text-base font-semibold text-white shadow-sm hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            ગુજરાતી
          </button>
        </div>
        <button onClick={onExit} className="text-xs font-medium text-gray-500 hover:text-gray-700">
          Back
        </button>
      </div>
    );
  }

  // ── Already passed (step.completed) — show summary ──────────────────────────
  if (showCompletedSummary) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-12">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <Trophy className="h-8 w-8 text-green-600" />
        </div>
        <div className="text-center">
          <p className="font-semibold text-gray-800">Assessment completed</p>
          <p className="mt-1 text-xs font-medium text-gray-500">
            {sopCode} — {sopTitle}
          </p>
          <p className="mt-1 text-sm text-gray-500">
            You passed with {step.percentage ?? '—'}%.
            {allowRetake ? ' Retake anytime below.' : ''}
          </p>
        </div>
        {attemptHistoryBlock}
        {allowRetake && (
          <button
            onClick={() => {
              // Offer the language choice again when the SOP has more than one.
              // Trainers always get both, so there is nothing to ask them.
              if (offeredLangs.length > 1 && !cachedIsTrainer()) setAskLang(true);
              else void fetchQuestions('exam');
            }}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retake Assessment
          </button>
        )}
      </div>
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (phase === 'review' && error) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-red-600">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      </div>
    );
  }

  // ── Pre-exam intro / confirmation ──────────────────────────────────────────
  if (phase === 'intro') {
    const isDemo = quizMode === 'trial';
    const introPassing = isRetest ? 100 : (settings?.passingScore ?? 80);
    const totalSecs = isDemo ? 0 : timerSecondsFor(settings, questions.length);
    const minutes = totalSecs > 0 ? Math.max(1, Math.round(totalSecs / 60)) : null;
    const maxAttempts = settings?.maxAttempts ?? 0;
    const details = isDemo
      ? [
          { Icon: ClipboardList, label: 'Questions', value: `${questions.length}` },
          { Icon: Award, label: 'Type', value: 'Demo (no pass/fail)' },
          { Icon: Clock, label: 'Time limit', value: 'Untimed' },
          { Icon: RefreshCw, label: 'Answers', value: settings?.showAnswersAfterTrial !== false ? 'Shown after' : 'Hidden' },
        ]
      : [
          { Icon: ClipboardList, label: 'Questions', value: `${questions.length}` },
          { Icon: Clock, label: 'Time limit', value: minutes ? `${minutes} min` : 'Untimed' },
          { Icon: Award, label: 'Passing score', value: `${introPassing}%` },
          { Icon: RefreshCw, label: 'Attempts', value: maxAttempts > 0 ? `${maxAttempts}` : 'Unlimited' },
        ];
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-50 p-4">
        <div className="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-7 shadow-xl">
          <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-purple-100">
            <ClipboardList className="h-7 w-7 text-purple-600" />
          </div>
          <p className="text-xs font-semibold uppercase tracking-wide text-purple-600">
            {sopCode}
          </p>
          <h2 className="mt-0.5 text-xl font-bold text-gray-800">
            {isRetest ? 'Start Retest' : isDemo ? 'Demo Assessment' : 'Start Assessment'}
          </h2>
          <p className="mt-1 text-sm font-medium text-gray-700">{sopTitle}</p>
          <p className="mt-1 text-sm text-gray-500">
            {isDemo
              ? 'Practice first — this demo does not count toward your score.'
              : isRetest
              ? `Retest of missed questions · Attempt ${localAttempts + 1}`
              : `Attempt ${localAttempts + 1}${settings?.maxAttempts ? ` of ${settings.maxAttempts}` : ''} — review the details, then begin.`}
          </p>

          {/* Exam details */}
          <div className="mt-5 grid grid-cols-2 gap-3">
            {details.map(({ Icon, label, value }) => (
              <div key={label} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white ring-1 ring-inset ring-gray-200">
                  <Icon className="h-4 w-4 text-purple-600" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] text-gray-400">{label}</p>
                  <p className="truncate text-sm font-bold text-gray-800">{value}</p>
                </div>
              </div>
            ))}
          </div>

          {attemptHistoryBlock && <div className="mt-4">{attemptHistoryBlock}</div>}

          {/* Rules */}
          <ul className="mt-5 space-y-2 text-sm text-gray-600">
            {!isDemo && (
              <li className="flex items-start gap-2">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                Do not switch tabs or windows — you have {MAX_TAB_VIOLATIONS} warnings before the exam auto-submits.
              </li>
            )}
            <li className="flex items-start gap-2">
              <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
              {minutes
                ? `The exam is timed (${minutes} min) and submits automatically when time runs out.`
                : 'Answer all questions, then submit.'}
            </li>
            {!isDemo && (
              <li className="flex items-start gap-2">
                <Award className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                {settings?.isTrainer
                  ? 'As a trainer you must score 100% on the full question bank. Attempts are unlimited until you pass.'
                  : `You must score at least ${introPassing}% to complete this training.`}
              </li>
            )}
          </ul>

          <div className="mt-6 flex gap-3">
            <button
              onClick={onExit}
              className="flex-1 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
            >
              Not now
            </button>
            <button
              onClick={() => setPhase('answering')}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-purple-600 py-2.5 text-sm font-semibold text-white shadow hover:bg-purple-700"
            >
              <ClipboardList className="h-4 w-4" />
              {isRetest ? 'Start Retest' : isDemo ? 'Start Demo' : `Start Attempt ${localAttempts + 1}`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Review after exam ──────────────────────────────────────────────────────
  if (phase === 'review') {
    const isDemo = quizMode === 'trial';
    const passingScore = isRetest ? 100 : (settings?.passingScore ?? 80);
    const passed = isDemo ? false : score >= passingScore;
    const missedCount = retestQueue.length;
    const maxAttempts = settings?.maxAttempts ?? 0;          // 0 = unlimited
    const attemptsExhausted = maxAttempts > 0 && examAttempts >= maxAttempts;
    const attemptsLeft = maxAttempts > 0 ? Math.max(0, maxAttempts - examAttempts) : null;
    const canRetest = !isDemo && !passed && missedCount > 0 && !attemptsExhausted;
    // Demo: reveal when configured. Exam: reveal only after pass or attempts exhausted.
    const revealAnswers = isDemo
      ? (settings?.showAnswersAfterTrial !== false)
      : (passed || attemptsExhausted);
    const ackedWrongCount = retestQueue.filter((q) => ackedQuestionIds.has(q._id)).length;
    const allWrongAcked = missedCount > 0 && ackedWrongCount === missedCount;
    const wrongInFullReview = questions.filter((q) => answers[q._id] !== q.correctAnswer).length;

    if (isDemo) {
      return (
        <div className="flex flex-1 flex-col items-center gap-5 py-6">
          <div className="flex w-full max-w-md flex-col items-center gap-4 rounded-3xl border border-purple-200 bg-linear-to-b from-purple-50 to-white px-8 py-10 text-center shadow-sm">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-purple-100">
              <ClipboardList className="h-8 w-8 text-purple-600" />
            </div>
            <p className="flex items-start justify-center font-black leading-none tracking-tight tabular-nums text-purple-700">
              <span className="text-7xl sm:text-8xl">{score}</span>
              <span className="mt-1 text-3xl font-extrabold sm:text-4xl">%</span>
            </p>
            <p className="text-base font-bold text-purple-800">Demo complete — this does not count</p>
            <span className="inline-flex items-center rounded-full bg-white px-3.5 py-1 text-xs font-semibold text-gray-600 shadow-sm ring-1 ring-inset ring-gray-200">
              {questions.filter((q) => answers[q._id] === q.correctAnswer).length} of {questions.length} correct
            </span>
          </div>

          {revealAnswers && (
            <div className="w-full max-w-2xl space-y-3">
              <p className="text-sm font-semibold text-gray-800">Review answers</p>
              {questions.map((q, i) => {
                const given = answers[q._id];
                const isRight = given === q.correctAnswer;
                const correctOpt = q.displayOptions.find((o) => o.label === q.correctAnswer);
                const givenOpt = q.displayOptions.find((o) => o.label === given);
                const correctText = correctOpt?.text ?? q.correctAnswer;
                const givenText = givenOpt?.text;
                const acked = ackedQuestionIds.has(q._id);
                return (
                  <div
                    key={q._id}
                    className={`rounded-xl border p-3 text-sm ${
                      isRight
                        ? acked ? 'border-emerald-300 bg-emerald-50' : 'border-green-200 bg-green-50'
                        : acked ? 'border-amber-300 bg-amber-50/60' : 'border-red-200 bg-red-50'
                    }`}
                  >
                    <p className="font-medium text-gray-800">{i + 1}. {q.question}</p>
                    <AltLine text={q.alt?.question} className="text-sm font-medium" />
                    {q.sopReference && (
                      <p className="mt-1.5 rounded-md bg-white/70 px-2 py-1 text-[11px] leading-snug text-slate-600 ring-1 ring-inset ring-slate-200">
                        <span className="font-semibold text-slate-700">SOP reference: </span>
                        {q.sopReference}
                      </p>
                    )}
                    <div className="mt-2 space-y-1.5">
                      {isRight ? (
                        <div className="rounded-md border border-emerald-200 bg-white/80 px-2.5 py-1.5">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Correct answer</p>
                          <p className="text-xs text-emerald-900">{correctText}</p>
                          <AltLine text={correctOpt?.altText} className="text-xs text-emerald-800" />
                        </div>
                      ) : (
                        <>
                          <div className="rounded-md border border-red-200 bg-white/80 px-2.5 py-1.5">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-red-600">Your answer (wrong)</p>
                            <p className="text-xs text-red-800">{givenText || '—'}</p>
                            <AltLine text={givenOpt?.altText} className="text-xs text-red-700" />
                          </div>
                          <div className="rounded-md border border-emerald-200 bg-white/80 px-2.5 py-1.5">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Correct answer</p>
                            <p className="text-xs text-emerald-900">{correctText}</p>
                          <AltLine text={correctOpt?.altText} className="text-xs text-emerald-800" />
                          </div>
                        </>
                      )}
                    </div>
                    {!isRight && q.explanation && (
                      <p className="mt-1.5 text-xs text-gray-500">{q.explanation}</p>
                    )}
                    <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800">
                      <input
                        type="checkbox"
                        checked={acked}
                        onChange={(e) => toggleQuestionAck(q._id, e.target.checked)}
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                      />
                      <span>
                        {isRight
                          ? 'I have reviewed this correct answer.'
                          : `I acknowledge this mistake and have reviewed the correct answer${q.sopReference ? ' and its SOP reference' : ''}.`}
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>
          )}

          <button
            onClick={() => void fetchQuestions('exam')}
            className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-purple-700"
          >
            <ClipboardList className="h-3.5 w-3.5" /> Continue to Formal Exam
          </button>
        </div>
      );
    }

    return (
      <div className="flex flex-1 flex-col items-center gap-5 py-6">
        {/* Prominent score hero */}
        <div className={`flex w-full max-w-md flex-col items-center gap-4 rounded-3xl border px-8 py-10 text-center shadow-sm ${
          passed
            ? 'border-green-200 bg-linear-to-b from-green-50 to-white'
            : 'border-red-200 bg-linear-to-b from-red-50 to-white'
        }`}>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            {sopCode} · Attempt {localAttempts || examAttempts || 1}
          </p>
          <div className={`flex h-16 w-16 items-center justify-center rounded-full ${passed ? 'bg-green-100' : 'bg-red-100'}`}>
            {passed
              ? <Trophy className="h-8 w-8 text-green-600" />
              : <X className="h-8 w-8 text-red-500" />}
          </div>
          <p className={`flex items-start justify-center font-black leading-none tracking-tight tabular-nums ${passed ? 'text-green-600' : 'text-red-600'}`}>
            <span className="text-7xl sm:text-8xl">{score}</span>
            <span className="mt-1 text-3xl font-extrabold sm:text-4xl">%</span>
          </p>
          <p className={`text-base font-bold ${passed ? 'text-green-700' : 'text-red-700'}`}>
            {passed
              ? 'Congratulations — you passed!'
              : isRetest
              ? 'Retest not complete — every question must be correct'
              : `Did not pass — minimum is ${passingScore}%`}
          </p>
          <p className="text-sm font-medium text-gray-600">{sopTitle}</p>
          <span className="inline-flex items-center rounded-full bg-white px-3.5 py-1 text-xs font-semibold text-gray-600 shadow-sm ring-1 ring-inset ring-gray-200">
            {questions.filter((q) => answers[q._id] === q.correctAnswer).length} of {questions.length} correct
          </span>
        </div>

        {attemptHistoryBlock}

        {/* Wrong answers + correct answers — shown after every failed attempt before retest */}
        {!passed && missedCount > 0 && !revealAnswers && (
          <div className="w-full max-w-2xl space-y-3">
            <p className="text-sm font-semibold text-gray-800">
              Review incorrect answers ({missedCount})
            </p>
            <p className="text-xs text-gray-500">
              Acknowledge each mistake below before you can start the retest.
              {ackedWrongCount < missedCount && (
                <span className="ml-1 font-medium text-amber-700">
                  ({ackedWrongCount}/{missedCount} acknowledged)
                </span>
              )}
            </p>
            {retestQueue.map((q, i) => {
              const given = answers[q._id];
              const correctOpt = q.displayOptions.find((o) => o.label === q.correctAnswer);
              const givenOpt = q.displayOptions.find((o) => o.label === given);
              const correctText = correctOpt?.text ?? q.correctAnswer;
              const givenText = givenOpt?.text;
              const acked = ackedQuestionIds.has(q._id);
              return (
                <div
                  key={q._id}
                  className={`rounded-xl border p-3 text-sm ${acked ? 'border-amber-300 bg-amber-50/60' : 'border-red-200 bg-red-50'}`}
                >
                  <p className="font-medium text-gray-800">{i + 1}. {q.question}</p>
                  <AltLine text={q.alt?.question} className="text-sm font-medium" />
                  {q.sopReference && (
                    <p className="mt-1.5 rounded-md bg-white/70 px-2 py-1 text-[11px] leading-snug text-slate-600 ring-1 ring-inset ring-slate-200">
                      <span className="font-semibold text-slate-700">SOP reference: </span>
                      {q.sopReference}
                    </p>
                  )}
                  <div className="mt-2 space-y-1.5">
                    <div className="rounded-md border border-red-200 bg-white/80 px-2.5 py-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-red-600">Your answer (wrong)</p>
                      <p className="text-xs text-red-800">{givenText || '—'}</p>
                      <AltLine text={givenOpt?.altText} className="text-xs text-red-700" />
                    </div>
                    <div className="rounded-md border border-emerald-200 bg-white/80 px-2.5 py-1.5">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Correct answer</p>
                      <p className="text-xs text-emerald-900">{correctText}</p>
                      <AltLine text={correctOpt?.altText} className="text-xs text-emerald-800" />
                    </div>
                  </div>
                  {q.explanation && (
                    <p className="mt-1.5 text-xs text-gray-500">{q.explanation}</p>
                  )}
                  <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800">
                    <input
                      type="checkbox"
                      checked={acked}
                      onChange={(e) => toggleQuestionAck(q._id, e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                    />
                    <span>
                      I acknowledge this mistake and have reviewed the correct answer
                      {q.sopReference ? ' and its SOP reference' : ''}.
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        )}

        {/* Full answer review once passed or attempts exhausted */}
        {revealAnswers && (
          <div className="w-full max-w-2xl space-y-3">
            <p className="text-sm font-semibold text-gray-800">Full answer review</p>
            <p className="text-xs text-gray-500">
              Acknowledge each question below after you have reviewed the answer
              {wrongInFullReview > 0 ? ' and any SOP references for mistakes' : ''}.
            </p>
            {questions.map((q, i) => {
              const given = answers[q._id];
              const isRight = given === q.correctAnswer;
              const correctOpt = q.displayOptions.find((o) => o.label === q.correctAnswer);
              const givenOpt = q.displayOptions.find((o) => o.label === given);
              const correctText = correctOpt?.text ?? q.correctAnswer;
              const givenText = givenOpt?.text;
              const acked = ackedQuestionIds.has(q._id);
              return (
                <div
                  key={q._id}
                  className={`rounded-xl border p-3 text-sm ${
                    isRight
                      ? acked ? 'border-emerald-300 bg-emerald-50' : 'border-green-200 bg-green-50'
                      : acked ? 'border-amber-300 bg-amber-50/60' : 'border-red-200 bg-red-50'
                  }`}
                >
                  <p className="font-medium text-gray-800">{i + 1}. {q.question}</p>
                  <AltLine text={q.alt?.question} className="text-sm font-medium" />
                  {q.sopReference && (
                    <p className="mt-1.5 rounded-md bg-white/70 px-2 py-1 text-[11px] leading-snug text-slate-600 ring-1 ring-inset ring-slate-200">
                      <span className="font-semibold text-slate-700">SOP reference: </span>
                      {q.sopReference}
                    </p>
                  )}
                  <div className="mt-2 space-y-1.5">
                    {isRight ? (
                      <div className="rounded-md border border-emerald-200 bg-white/80 px-2.5 py-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Correct answer</p>
                        <p className="text-xs text-emerald-900">{correctText}</p>
                        <AltLine text={correctOpt?.altText} className="text-xs text-emerald-800" />
                      </div>
                    ) : (
                      <>
                        <div className="rounded-md border border-red-200 bg-white/80 px-2.5 py-1.5">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-red-600">Your answer (wrong)</p>
                          <p className="text-xs text-red-800">{givenText || '—'}</p>
                          <AltLine text={givenOpt?.altText} className="text-xs text-red-700" />
                        </div>
                        <div className="rounded-md border border-emerald-200 bg-white/80 px-2.5 py-1.5">
                          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700">Correct answer</p>
                          <p className="text-xs text-emerald-900">{correctText}</p>
                          <AltLine text={correctOpt?.altText} className="text-xs text-emerald-800" />
                        </div>
                      </>
                    )}
                  </div>
                  {!isRight && q.explanation && (
                    <p className="mt-1.5 text-xs text-gray-500">{q.explanation}</p>
                  )}
                  <label className="mt-2.5 flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs text-slate-800">
                    <input
                      type="checkbox"
                      checked={acked}
                      onChange={(e) => toggleQuestionAck(q._id, e.target.checked)}
                      className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-purple-600 focus:ring-purple-500"
                    />
                    <span>
                      {isRight
                        ? 'I have reviewed this correct answer.'
                        : `I acknowledge this mistake and have reviewed the correct answer${q.sopReference ? ' and its SOP reference' : ''}.`}
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        )}

        {canRetest && (
          <div className="flex w-full max-w-2xl flex-col items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-center">
            <p className="text-sm font-semibold text-amber-800">
              {isRetest
                ? `Almost there — ${missedCount} question${missedCount !== 1 ? 's' : ''} still need a correct answer.`
                : `No need to redo the whole exam — just the ${missedCount} question${missedCount !== 1 ? 's' : ''} you missed.`}
            </p>
            <p className="text-xs text-amber-700">
              Tick the acknowledgement checkbox on <strong>every</strong> incorrect answer above before continuing.
              The retest requires <strong>100%</strong> on the remaining questions.
            </p>
            {!allWrongAcked && (
              <p className="text-[11px] font-medium text-amber-800">
                {ackedWrongCount}/{missedCount} mistakes acknowledged
              </p>
            )}
            <button
              onClick={startRetest}
              disabled={!allWrongAcked}
              className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Start Retest · Attempt {localAttempts + 1} · {missedCount} question{missedCount !== 1 ? 's' : ''}
            </button>
            {attemptsLeft !== null && (
              <p className="text-[11px] font-medium text-amber-600">
                {attemptsLeft} attempt{attemptsLeft !== 1 ? 's' : ''} remaining
              </p>
            )}
          </div>
        )}

        {attemptsExhausted && !passed && (
          <div className="flex w-full max-w-2xl flex-col items-center gap-2 rounded-xl border border-red-200 bg-red-50 p-4 text-center">
            <p className="text-sm font-semibold text-red-800">
              You&apos;ve used all {maxAttempts} attempt{maxAttempts !== 1 ? 's' : ''}.
            </p>
            <p className="text-xs text-red-700">
              The correct answers and explanations for the questions you missed are shown above.
              Please review them and contact your trainer to be re-assigned this assessment.
            </p>
          </div>
        )}
      </div>
    );
  }

  // ── Answering phase (paginated, one question at a time — full-screen) ────────
  const passingScore = isRetest ? 100 : (settings?.passingScore ?? 80);
  const q = questions[currentIdx];
  const answeredCount = Object.keys(answers).length;
  const isLast = currentIdx === questions.length - 1;
  const submitLabel = isRetest ? 'Submit Retest' : quizMode === 'trial' ? 'Finish Demo' : 'Submit Exam';

  const goToQuestion = (idx: number) => {
    if (idx < 0 || idx >= questions.length) return;
    setCurrentIdx(idx);
    setVisited((prev) => new Set(prev).add(idx));
  };
  const clearResponse = () =>
    setAnswers((prev) => {
      const next = { ...prev };
      if (q) delete next[q._id];
      return next;
    });
  const toggleMark = () =>
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(currentIdx)) next.delete(currentIdx);
      else next.add(currentIdx);
      return next;
    });

  const navState = (i: number): 'current' | 'answered' | 'marked' | 'visited' | 'pending' => {
    if (i === currentIdx) return 'current';
    if (marked.has(i)) return 'marked';
    if (answers[questions[i]._id] !== undefined) return 'answered';
    if (visited.has(i)) return 'visited';
    return 'pending';
  };
  const navColor = (s: string) =>
    s === 'current'  ? 'bg-purple-600 border-purple-600 text-white shadow-md scale-105'
    : s === 'answered' ? 'bg-emerald-500 border-emerald-500 text-white'
    : s === 'marked'   ? 'bg-amber-400 border-amber-400 text-white'
    : s === 'visited'  ? 'bg-gray-100 border-gray-300 text-gray-600'
    : 'bg-white border-gray-200 text-gray-400';

  if (!q) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-gray-50">
        <Loader2 className="h-6 w-6 animate-spin text-purple-400" />
      </div>
    );
  }

  // One answer per question, shared by both language panels: picking an option in
  // either panel selects the same letter in the other. Nothing is answered twice.
  const selectedLabel = answers[q._id];
  const selectOption = (label: 'A' | 'B' | 'C' | 'D') =>
    setAnswers((prev) => ({ ...prev, [q._id]: label }));
  const showAlt = bilingual && !!q.alt;

  const renderOptions = (variant: 'primary' | 'alt') => (
    <div className="space-y-2.5">
      {q.displayOptions.map((opt) => {
        const selected = selectedLabel === opt.label;
        const text = variant === 'alt' ? (opt.altText ?? '') : opt.text;
        return (
          <button
            key={opt.label}
            onClick={() => selectOption(opt.label)}
            lang={variant === 'alt' ? 'gu' : 'en'}
            aria-pressed={selected}
            className={`flex w-full items-start gap-3 rounded-2xl border px-4 py-3.5 text-left transition ${
              selected
                ? 'border-purple-400 bg-purple-50 shadow-sm ring-1 ring-purple-200'
                : 'border-gray-200 bg-white hover:border-purple-200 hover:bg-purple-50/40'
            }`}
          >
            <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
              selected ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-500'
            }`}>
              {opt.label}
            </span>
            <span className={`flex-1 text-sm font-medium leading-relaxed ${
              selected ? 'text-purple-900' : 'text-gray-700'
            }`}>
              {text}
            </span>
            {selected && <Check className="mt-1 h-4 w-4 shrink-0 text-purple-600" />}
          </button>
        );
      })}
    </div>
  );

  const renderQuestionPanel = (variant: 'primary' | 'alt') => (
    <div className="flex flex-col rounded-3xl border border-gray-200 bg-white p-5 shadow-sm md:p-6">
      <div className="mb-3 flex items-center gap-2">
        <span className="rounded-md bg-purple-600 px-2 py-0.5 text-[11px] font-bold tabular-nums text-white">
          Q{currentIdx + 1}
        </span>
        {showAlt && (
          <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-[11px] font-semibold text-gray-600">
            {variant === 'alt' ? 'ગુજરાતી' : 'English'}
          </span>
        )}
      </div>
      <p
        lang={variant === 'alt' ? 'gu' : 'en'}
        className="text-base font-semibold leading-relaxed text-gray-800 md:text-lg"
      >
        {variant === 'alt' ? q.alt?.question : q.question}
      </p>
      <div className="mt-4 border-t border-dashed border-gray-100 pt-4">
        {renderOptions(variant)}
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-gray-50">
      {/* Violation warning overlay */}
      {showViolationWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-2xl border border-red-200 bg-white p-6 shadow-2xl">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <AlertCircle className="h-6 w-6 text-red-600" />
            </div>
            <h3 className="text-base font-bold text-gray-800">Tab Switch Detected</h3>
            <p className="mt-1 text-sm text-gray-600">You left the exam window. This has been recorded.</p>
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
              Warning {violations} of {MAX_TAB_VIOLATIONS} — {MAX_TAB_VIOLATIONS - violations} remaining before auto-submit
            </div>
            <button
              onClick={() => setShowViolationWarning(false)}
              className="mt-4 w-full rounded-lg bg-purple-600 py-2.5 text-sm font-semibold text-white hover:bg-purple-700"
            >
              Return to Exam
            </button>
          </div>
        </div>
      )}

      {/* Top bar */}
      <div className="sticky top-0 z-10 flex items-center gap-4 border-b border-gray-200 bg-white px-4 py-3 shadow-sm">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-sm font-bold text-gray-800 md:text-base">
              {quizMode === 'trial' ? 'Demo' : isRetest ? 'Retest' : 'Assessment'}
            </h1>
            {quizMode !== 'trial' && (
              <span className="rounded-full bg-purple-100 px-2.5 py-0.5 text-[11px] font-bold text-purple-700">
                Attempt {localAttempts + 1}
                {settings?.maxAttempts ? ` / ${settings.maxAttempts}` : ''}
              </span>
            )}
          </div>
          <p className="truncate text-xs font-medium text-gray-700">
            {sopCode} — {sopTitle}
          </p>
          <p className="text-xs text-gray-400">
            {quizMode === 'trial'
              ? `${questions.length} practice questions · no pass/fail`
              : isRetest
              ? `${questions.length} missed · Answer all correctly (100%)`
              : `${questions.length} questions · Pass: ${passingScore}%`}
          </p>
        </div>
        {violations > 0 && (
          <span className="flex items-center gap-1 rounded-full bg-red-100 px-2 py-1 text-[10px] font-bold text-red-700">
            ⚠ {violations}/{MAX_TAB_VIOLATIONS}
          </span>
        )}
        {timeLeft !== null && (
          <div className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 font-mono text-sm font-bold tabular-nums ${
            timeLeft <= 30 ? 'animate-pulse border-red-200 bg-red-50 text-red-600' : 'border-gray-200 bg-gray-50 text-gray-700'
          }`}>
            <Clock className="h-4 w-4" /> {formatTime(timeLeft)}
          </div>
        )}
        <button
          onClick={handleSubmit}
          className="rounded-xl bg-purple-600 px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-purple-700"
        >
          {submitLabel}
        </button>
      </div>

      <div className="flex flex-1 gap-0 overflow-hidden">
        {/* Main question area */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6">
          <div className={`mx-auto w-full ${showAlt ? 'max-w-6xl' : 'max-w-3xl'}`}>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-500">
              Question {currentIdx + 1} / {questions.length}
            </span>
            {bilingual && (
              <span className="rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-xs font-semibold text-purple-700">
                English + ગુજરાતી
              </span>
            )}
            {marked.has(currentIdx) && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                Marked for review
              </span>
            )}
          </div>

          {/* Question + options. Trainers see the same MCQ in both languages side
              by side; both panels drive the one shared answer. */}
          {showAlt ? (
            <>
              <div className="mb-3 flex items-start gap-2 rounded-xl border border-purple-200 bg-purple-50 px-3.5 py-2.5 text-xs text-purple-800">
                <ClipboardList className="mt-0.5 h-4 w-4 shrink-0 text-purple-600" />
                <span>
                  <strong className="font-semibold">Same question in both languages.</strong>{' '}
                  Answer it once in either panel — the other selects the matching option
                  automatically. / એક જ પ્રશ્ન, બંને ભાષામાં — એક વાર જ જવાબ આપો.
                </span>
              </div>
              <div className="mb-6 grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
                {renderQuestionPanel('primary')}
                {renderQuestionPanel('alt')}
              </div>
            </>
          ) : (
            <div className="mb-6">
              {renderQuestionPanel('primary')}
              {bilingual && (
                <p className="mt-2 text-xs text-amber-700">
                  Gujarati version not available for this question — it is asked in English only.
                </p>
              )}
            </div>
          )}

          {/* Action bar */}
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={clearResponse}
              disabled={answers[q._id] === undefined}
              className="flex items-center gap-1.5 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <XCircle className="h-4 w-4" /> Clear Response
            </button>
            <button
              onClick={toggleMark}
              className={`flex items-center gap-1.5 rounded-xl border px-4 py-2 text-sm transition ${
                marked.has(currentIdx) ? 'border-amber-300 bg-amber-50 text-amber-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Flag className="h-4 w-4" /> {marked.has(currentIdx) ? 'Marked for Review' : 'Mark for Review'}
            </button>
            <div className="ml-auto flex gap-2">
              <button
                onClick={() => goToQuestion(currentIdx - 1)}
                disabled={currentIdx === 0}
                className="flex items-center gap-1 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" /> Previous
              </button>
              <button
                onClick={() => (isLast ? handleSubmit() : goToQuestion(currentIdx + 1))}
                className="flex items-center gap-1 rounded-xl bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-purple-700"
              >
                {isLast ? 'Finish' : 'Save & Next'} <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
          </div>
        </div>

        {/* Right panel — Question Navigator */}
        <div className="hidden w-64 shrink-0 flex-col overflow-y-auto border-l border-gray-200 bg-white p-4 lg:flex">
          <h3 className="text-sm font-semibold text-gray-800">Question Navigator</h3>
          <p className="mb-3 text-xs text-gray-400">{answeredCount} answered · {marked.size} marked</p>

          {/* Legend */}
          <div className="mb-4 grid grid-cols-2 gap-1 text-xs">
            {[
              { color: 'bg-purple-600', label: 'Current' },
              { color: 'bg-emerald-500', label: 'Answered' },
              { color: 'bg-amber-400', label: 'Marked' },
              { color: 'bg-gray-200', label: 'Visited' },
            ].map(({ color, label }) => (
              <div key={label} className="flex items-center gap-1 text-gray-500">
                <span className={`h-2.5 w-2.5 rounded-sm ${color}`} /> {label}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-5 gap-1.5">
            {questions.map((_, i) => (
              <button
                key={i}
                onClick={() => goToQuestion(i)}
                title={`Question ${i + 1}`}
                className={`h-10 w-10 rounded-xl border text-xs font-semibold transition ${navColor(navState(i))}`}
              >
                {i + 1}
              </button>
            ))}
          </div>

          <div className="mt-6 space-y-2">
            <div className="flex justify-between text-xs text-gray-400">
              <span>Progress</span>
              <span>{Math.round((answeredCount / questions.length) * 100)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-purple-500 transition-all"
                style={{ width: `${(answeredCount / questions.length) * 100}%` }}
              />
            </div>
          </div>

          <button
            onClick={handleSubmit}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-purple-600 py-2.5 text-sm font-semibold text-white transition hover:bg-purple-700"
          >
            <Award className="h-4 w-4" /> {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main journey page ────────────────────────────────────────────────────────

export default function JourneyPage() {
  const params = useParams<{ sopCode: string }>();
  const router = useRouter();
  const sopCode = params.sopCode;

  const [data, setData] = useState<JourneyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [currentStep, setCurrentStep] = useState(0);
  const [localSteps, setLocalSteps] = useState<JourneyStep[]>([]);
  const [overallPct, setOverallPct] = useState(0);
  const [showCelebration, setShowCelebration] = useState(false);
  const [hasCert, setHasCert] = useState(false);

  const applyJourneyData = useCallback((json: JourneyData) => {
    setData(json);
    setLocalSteps(json.steps);
    const pct = json.progress?.overallPercentage ?? 0;
    setOverallPct(pct);
    // Deep link: `?step=<id>` opens that resource directly (used by the dashboard
    // "Show Video / PPT / SOP / Start Test" buttons). Falls back to first incomplete.
    const desired = typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).get('step')
      : null;
    const desiredIdx = desired ? json.steps.findIndex((s) => s.id === desired) : -1;
    if (desiredIdx >= 0) {
      setCurrentStep(desiredIdx);
      return;
    }
    const firstIncomplete = json.steps.findIndex((s) => !s.completed);
    setCurrentStep(firstIncomplete >= 0 ? firstIncomplete : 0);
  }, []);

  const load = useCallback(async (force = false) => {
    const employeeId = getCachedLmsEmployeeId();
    const field = employeeId
      ? lmsClientFields.journey(employeeId, sopCode)
      : `journey::${String(sopCode || '').toUpperCase()}`;
    const cached = !force ? readLmsClientCache<JourneyData>(field) : null;
    if (cached?.value) {
      applyJourneyData(cached.value);
      setLoading(false);
      if (Date.now() - cached.cachedAt <= LMS_CLIENT_FRESH_MS) {
        const pct = cached.value.progress?.overallPercentage ?? 0;
        if (pct >= 100 && employeeId) {
          const certCached = readLmsClientCache<{ certificate: unknown }>(
            lmsClientFields.certificate(employeeId, sopCode),
          );
          if (certCached?.value?.certificate) setHasCert(true);
        }
        return;
      }
    } else {
      setLoading(true);
    }
    try {
      const res = await fetch(`/api/lms/journey/${sopCode}`);
      if (res.status === 401) { router.push('/lms'); return; }
      const json = await res.json() as JourneyData;
      applyJourneyData(json);
      if (employeeId) writeLmsClientCache(field, json);
      const pct = json.progress?.overallPercentage ?? 0;
      if (pct >= 100) {
        const certRes = await fetch(`/api/lms/certificate/${sopCode}`);
        const certData = await certRes.json();
        if (certData.certificate) {
          setHasCert(true);
          if (employeeId) {
            writeLmsClientCache(lmsClientFields.certificate(employeeId, sopCode), certData);
          }
        }
      }
    } catch {
      setError('Failed to load training.');
    } finally {
      setLoading(false);
    }
  }, [sopCode, router, applyJourneyData]);

  useEffect(() => { load(); }, [load]);

  const updateProgress = useCallback(async (stepId: string, payload: Record<string, unknown>): Promise<number | null> => {
    try {
      const res = await fetch(`/api/lms/progress/${sopCode}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: stepId, availableSteps: data?.availableSteps, ...payload }),
      });
      const json = await res.json();
      if (json.progress) {
        const newPct = json.progress.overallPercentage ?? 0;
        setOverallPct(newPct);
        const employeeId = getCachedLmsEmployeeId();
        if (employeeId) {
          invalidateLmsClientFields(
            lmsClientFields.journey(employeeId, sopCode),
            lmsClientFields.dashboard(employeeId),
            lmsClientFields.certificate(employeeId, sopCode),
          );
        }
        if (newPct >= 100 && !hasCert) {
          try {
            const certRes = await fetch(`/api/lms/certificate/${sopCode}`, { method: 'POST' });
            const certData = await certRes.json().catch(() => ({}));
            if (certData.certificate) setHasCert(true);
          } catch { /* non-critical */ }
        }
        return newPct;
      }
    } catch { /* non-critical */ }
    return null;
  }, [sopCode, data?.availableSteps, hasCert]);

  const markStepComplete = useCallback((stepId: string) => {
    setLocalSteps((prev) =>
      prev.map((s) => (s.id === stepId ? { ...s, completed: true } : s)),
    );
    void updateProgress(stepId, { completed: true });
  }, [updateProgress]);

  const handleVideoProgress = useCallback((stepId: string, pct: number, ts: number) => {
    void updateProgress(stepId, { percentage: pct, lastTimestamp: ts });
  }, [updateProgress]);

  const handleQuizComplete = useCallback(async (
    stepId: string,
    score: number,
    passed: boolean,
    newAttempts: number,
  ) => {
    // Never un-complete: if they already passed and a retake fails, keep completed=true
    setLocalSteps((prev) =>
      prev.map((s) => {
        if (s.id !== stepId) return s;
        const history = [...(s.attemptHistory || [])].filter((h) => h.attempt !== newAttempts);
        history.push({ attempt: newAttempts, score });
        history.sort((a, b) => a.attempt - b.attempt);
        return {
          ...s,
          completed: passed || s.completed,
          attempts: newAttempts,
          percentage: score,
          attemptHistory: history,
        };
      }),
    );

    const newPct = await updateProgress(stepId, { completed: passed, passed, score, attempts: newAttempts });

    // Certificate + celebration after a passing attempt (server verifies / completes progress).
    if (passed) {
      try {
        const r = await fetch(`/api/lms/certificate/${sopCode}`, { method: 'POST' });
        const d = await r.json().catch(() => ({}));
        if (d.certificate) {
          setHasCert(true);
          setShowCelebration(true);
          if (typeof newPct !== 'number' || newPct < 100) setOverallPct(100);
        } else if (newPct !== null && newPct >= 100) {
          // Progress complete but cert create failed — still celebrate; user can retry from footer.
          setShowCelebration(true);
        }
      } catch {
        if (newPct !== null && newPct >= 100) setShowCelebration(true);
      }
    }
  }, [updateProgress, sopCode]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50">
        <AlertCircle className="h-10 w-10 text-red-400" />
        <p className="text-gray-600">{error}</p>
        <button onClick={() => router.push('/lms')} className="text-sm text-purple-600 hover:underline">
          Back to My Training
        </button>
      </div>
    );
  }

  const sopName = data?.sop?.name || sopCode;
  const activeStep = localSteps[currentStep];

  return (
    <div className="flex min-h-screen flex-col bg-gray-50">

      {/* ── Training complete / certificate celebration ─────────── */}
      {showCelebration && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-green-200 bg-white p-8 shadow-2xl text-center">
            <div className="mb-4 flex justify-center">
              <div className="flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
                <Trophy className="h-10 w-10 text-green-600" />
              </div>
            </div>
            <h3 className="text-2xl font-bold text-gray-800">Training Complete!</h3>
            <p className="mt-2 text-sm text-gray-500">{sopName}</p>
            <p className="mt-3 text-sm text-gray-600">
              You have successfully passed the assessment and are now
              <strong className="text-green-700"> certified as trained</strong> for this SOP.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              {hasCert && (
                <button
                  onClick={() => { setShowCelebration(false); router.push(`/lms/certificate/${sopCode}`); }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 py-3 text-sm font-semibold text-white shadow hover:bg-green-700"
                >
                  <Award className="h-4 w-4" /> View Your Certificate
                </button>
              )}
              <button
                onClick={() => setShowCelebration(false)}
                className="w-full rounded-xl border border-gray-200 py-2.5 text-sm font-medium text-gray-500 hover:bg-gray-50"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-screen-2xl items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <button
            onClick={() => router.push('/lms')}
            className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> My Training
          </button>
          <div className="h-4 w-px bg-gray-200" />
          <h1 className="flex-1 truncate text-sm font-bold text-gray-800" title={sopName}>
            {sopCode} — {sopName}
          </h1>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <div className="h-2 w-32 overflow-hidden rounded-full bg-gray-100">
              <div
                className="h-full rounded-full bg-purple-500 transition-all duration-500"
                style={{ width: `${overallPct}%` }}
              />
            </div>
            <span className="w-10 text-right font-semibold text-purple-700">{overallPct}%</span>
          </div>
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-screen-2xl flex-1 gap-0 px-4 py-6 sm:px-6 lg:px-8">
        {/* Main content */}
        <main className="flex flex-1 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {/* Step header */}
          {activeStep && (
            <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-3.5">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                activeStep.completed ? 'bg-green-50 text-green-600' : 'bg-purple-50 text-purple-600'
              }`}>
                <StepIcon type={activeStep.type} size={4} />
              </div>
              <div>
                <h2 className="text-sm font-bold text-gray-800">{activeStep.label}</h2>
                <p className="text-[11px] text-gray-400">
                  Step {currentStep + 1} of {localSteps.length}
                  {activeStep.completed && ' · Completed'}
                </p>
                {activeStep.type === 'quiz' && (activeStep.attemptHistory?.length || activeStep.attempts) ? (
                  <p className="mt-0.5 text-[11px] font-medium text-gray-600">
                    {(activeStep.attemptHistory && activeStep.attemptHistory.length > 0
                      ? activeStep.attemptHistory
                      : activeStep.percentage != null
                        ? [{ attempt: activeStep.attempts || 1, score: activeStep.percentage }]
                        : []
                    )
                      .map((h) => `Attempt ${h.attempt} – ${h.score}%`)
                      .join(' · ')}
                  </p>
                ) : null}
              </div>
              {activeStep.completed && (
                <span className="ml-auto flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-1 text-[11px] font-semibold text-green-700">
                  <Check className="h-3 w-3" /> Done
                </span>
              )}
            </div>
          )}

          {/* Step content */}
          <div className="flex flex-1 flex-col overflow-y-auto p-5">
            {!activeStep && (
              <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-full bg-purple-50">
                  <Trophy className="h-7 w-7 text-purple-500" />
                </div>
                <p className="font-semibold text-gray-700">No learning steps available</p>
                <p className="text-sm text-gray-400">Content for this SOP has not been uploaded yet.</p>
              </div>
            )}
            {activeStep?.type === 'video' && (
              <VideoStep
                key={activeStep.id}
                step={activeStep}
                onProgress={(pct, ts) => handleVideoProgress(activeStep.id, pct, ts)}
                onComplete={() => markStepComplete(activeStep.id)}
              />
            )}
            {activeStep?.type === 'slides' && (
              <SlidesStep
                key={activeStep.id}
                step={activeStep}
                onComplete={() => markStepComplete(activeStep.id)}
              />
            )}
            {activeStep?.type === 'pdf' && (
              <PdfStep
                key={activeStep.id}
                step={activeStep}
                sopIdentifier={data?.sop?.identifier || sopCode}
                onComplete={() => markStepComplete(activeStep.id)}
              />
            )}
            {activeStep?.type === 'quiz' && (
              <QuizStep
                key={activeStep.id}
                sopCode={sopCode}
                sopName={data?.sop?.name || ''}
                step={activeStep}
                onComplete={(score, passed, newAttempts) =>
                  handleQuizComplete(activeStep.id, score, passed, newAttempts)
                }
                onExit={() => router.push('/lms')}
              />
            )}
          </div>

          {/* Navigation footer */}
          {localSteps.length > 0 && (
            <div className="flex items-center justify-between border-t border-gray-100 px-5 py-3">
              <button
                onClick={() => setCurrentStep((i) => Math.max(0, i - 1))}
                disabled={currentStep === 0}
                className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </button>

              <span className="text-[11px] text-gray-400">
                {localSteps.filter((s) => s.completed).length} of {localSteps.length} completed
              </span>

              {currentStep < localSteps.length - 1 ? (
                <button
                  onClick={() => setCurrentStep((i) => Math.min(localSteps.length - 1, i + 1))}
                  className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-xs font-medium text-white hover:bg-purple-700 disabled:opacity-40"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  onClick={() => router.push('/lms')}
                  disabled={overallPct < 100}
                  className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-40"
                >
                  <Trophy className="h-3.5 w-3.5" /> Finish Training
                </button>
              )}
            </div>
          )}

          {/* ── Post-completion panel ─────────────────────────── */}
          {overallPct >= 100 && (
            <div className="border-t border-dashed border-green-200 bg-green-50/60 px-5 py-5">
              <div className="mb-3 flex items-center gap-2">
                <Trophy className="h-4 w-4 text-green-600" />
                <p className="text-sm font-bold text-green-800">Training Complete!</p>
              </div>

              <div className="flex flex-wrap gap-3">
                {/* Certificate */}
                <button
                  onClick={() => router.push(`/lms/certificate/${sopCode}`)}
                  className="flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2.5 text-sm font-medium text-white shadow hover:bg-purple-700"
                >
                  <Award className="h-4 w-4" />
                  {hasCert ? 'View Certificate' : 'Get Certificate'}
                </button>

              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
