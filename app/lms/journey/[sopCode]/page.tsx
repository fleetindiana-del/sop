'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ArrowLeft, Check, ChevronLeft, ChevronRight, PlayCircle,
  FileText, BookOpen, ClipboardList, Lock, Loader2, AlertCircle,
  Volume2, Trophy, X, Award, RefreshCw, Clock,
  Maximize2, Flag, XCircle,
} from 'lucide-react';
import type { JourneyStep } from '@/app/api/lms/journey/[sopCode]/route';
import { buildOfficeOnlineEmbedUrl } from '@/lib/file-urls';
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
}

interface DisplayOption { label: 'A' | 'B' | 'C' | 'D'; text: string; }
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const lastReported = useRef(step.percentage ?? 0);
  const nearEndFired = useRef(false);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [speed, setSpeed] = useState(1);
  const urls = step.urls || [];

  // Reset near-end guard when video src changes
  useEffect(() => { nearEndFired.current = false; }, [currentIdx]);

  const handleSpeedChange = (s: number) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
  };

  // Restore position on first load
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !step.lastTimestamp) return;
    v.currentTime = step.lastTimestamp;
  }, [currentIdx, step.lastTimestamp]);

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || isNaN(v.duration) || v.duration === 0) return;

    // Stop playback 2 s before end and treat as finished (hides watermark outro)
    if (!nearEndFired.current && v.duration > 4 && v.currentTime >= v.duration - 2) {
      nearEndFired.current = true;
      v.pause();
      if (currentIdx < urls.length - 1) {
        nearEndFired.current = false;
        setCurrentIdx((i) => i + 1);
      } else {
        onProgress(100, 0);
        onComplete();
      }
      return;
    }

    const pct = Math.round((v.currentTime / v.duration) * 100);
    if (pct >= lastReported.current + 5) {
      lastReported.current = pct;
      onProgress(pct, Math.round(v.currentTime));
    }
  };

  // Prevent seeking into the last 2 seconds
  const handleSeeked = () => {
    const v = videoRef.current;
    if (!v || isNaN(v.duration) || v.duration === 0) return;
    if (v.currentTime > v.duration - 2) {
      v.currentTime = Math.max(0, v.duration - 2);
    }
  };

  if (urls.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-400">
        <p className="text-sm">No video available for this step.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3">
      {urls.length > 1 && (
        <div className="flex items-center gap-2">
          {urls.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentIdx(i)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                i === currentIdx ? 'bg-purple-600 text-white' : 'border border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}
            >
              Part {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Video container — overflow:hidden clips any branding that extends outside */}
      <div className="relative overflow-hidden rounded-xl bg-black shadow-lg select-none">
        <video
          ref={videoRef}
          key={urls[currentIdx]}
          src={urls[currentIdx]}
          controls
          controlsList="nodownload nofullscreen"
          disablePictureInPicture
          className="w-full"
          style={{ maxHeight: '60vh' }}
          onTimeUpdate={handleTimeUpdate}
          onSeeked={handleSeeked}
          onContextMenu={(e) => e.preventDefault()}
        >
          Your browser does not support HTML5 video.
        </video>
        {/* Overlay that covers the third-party watermark in the bottom-right corner */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-10 right-0 h-7 w-36 bg-black"
        />
      </div>

      {/* Speed controls */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-gray-400 shrink-0">Speed:</span>
        <div className="flex gap-1">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => handleSpeedChange(s)}
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
        <span className="ml-auto flex items-center gap-2 text-xs text-gray-400">
          <span className="flex items-center gap-1"><Volume2 className="h-3.5 w-3.5" /> Audio controls in player</span>
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
    </div>
  );
}

// ─── Slides step ──────────────────────────────────────────────────────────────

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

  if (urls.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-400">
        <p className="text-sm">No slides available for this step.</p>
      </div>
    );
  }

  const isLast = currentIdx === urls.length - 1;

  return (
    <div className="flex flex-1 flex-col gap-3">
      {urls.length > 1 && (
        <div className="flex items-center gap-2">
          {urls.map((_, i) => (
            <button
              key={i}
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
      <div className="flex-1 overflow-hidden rounded-xl border border-gray-200 shadow-sm" style={{ minHeight: '55vh' }}>
        <iframe
          src={urls[currentIdx]}
          className="h-full w-full"
          style={{ minHeight: '55vh' }}
          title={`${step.label} - Deck ${currentIdx + 1}`}
        />
      </div>
      {!acknowledged && isLast && (
        <button
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
    </div>
  );
}

// ─── PDF step ─────────────────────────────────────────────────────────────────

function PdfStep({
  step,
  onComplete,
}: {
  step: JourneyStep;
  onComplete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(step.completed);

  // While the immersive reader is open, lock background scroll and allow ESC to exit.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
      // Soft block common screenshot / save shortcuts (cannot stop OS PrintScreen).
      if ((e.ctrlKey || e.metaKey) && ['c', 'C', 's', 'S', 'p', 'P'].includes(e.key)) {
        e.preventDefault();
      }
    };
    const block = (e: Event) => e.preventDefault();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    document.addEventListener('copy', block);
    document.addEventListener('cut', block);
    document.addEventListener('contextmenu', block);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('copy', block);
      document.removeEventListener('cut', block);
      document.removeEventListener('contextmenu', block);
    };
  }, [fullscreen]);

  useEffect(() => {
    if (!open || fullscreen) return;
    const block = (e: Event) => e.preventDefault();
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ['c', 'C', 's', 'S', 'p', 'P'].includes(e.key)) {
        e.preventDefault();
      }
    };
    document.addEventListener('copy', block);
    document.addEventListener('cut', block);
    document.addEventListener('contextmenu', block);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('copy', block);
      document.removeEventListener('cut', block);
      document.removeEventListener('contextmenu', block);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, fullscreen]);

  if (!step.url) {
    return (
      <div className="flex flex-1 items-center justify-center text-gray-400">
        <p className="text-sm">SOP document not available.</p>
      </div>
    );
  }

  const isDocx = step.fileType === 'docx' || step.url.toLowerCase().endsWith('.docx');
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  // PDFs render through the same preview route the dashboard uses, so the inline
  // and full-screen previews look identical to the dashboard. DOCX uses Office Online.
  const viewerSrc = isDocx
    ? buildOfficeOnlineEmbedUrl(step.url, origin)
    : `/api/sops/preview?path=${encodeURIComponent(step.url)}&type=pdf`;

  const reviewed = acknowledged || step.completed;
  const markReviewed = () => { setAcknowledged(true); onComplete(); };

  return (
    <div
      className="flex flex-1 flex-col gap-3 select-none"
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Landing card — prevents auto-download on page load */}
      {!open && (
        <div className="flex flex-1 flex-col items-center justify-center gap-5 rounded-2xl border border-gray-200 bg-linear-to-b from-gray-50 to-white py-16">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white shadow-md ring-1 ring-gray-100">
            <BookOpen className="h-8 w-8 text-purple-500" />
          </div>
          <div className="text-center">
            <p className="text-base font-semibold text-gray-700">SOP Document</p>
            <p className="mt-0.5 text-xs text-gray-400">
              {isDocx ? 'Word document' : 'PDF'} · View-only — download, copy, and screenshots are restricted
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

      {open && (
        <>
          {/* Inline viewer toolbar — no download / open-in-new-tab */}
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

          <div className="relative flex-1 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm h-[70vh] sm:h-[76vh] lg:h-[80vh]">
            <iframe
              src={viewerSrc}
              className="h-full w-full border-0"
              title="SOP Document"
              sandbox="allow-scripts allow-same-origin allow-popups"
              referrerPolicy="no-referrer"
            />
          </div>

          {!reviewed ? (
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
          )}
        </>
      )}

      {/* Immersive full-screen reader */}
      {fullscreen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-[#e5e7eb] select-none">
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
          <div className="min-h-0 flex-1 p-2 sm:p-3">
            <iframe
              src={viewerSrc}
              className="h-full w-full rounded-lg border-0 bg-white shadow"
              title="SOP Document fullscreen"
              sandbox="allow-scripts allow-same-origin allow-popups"
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
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
    let opts: DisplayOption[] = [
      { label: 'A', text: q.optionA },
      { label: 'B', text: q.optionB },
      { label: 'C', text: q.optionC },
      { label: 'D', text: q.optionD },
    ];
    if (shuffleOpts) opts = shuffleArray(opts);
    return { ...q, displayOptions: opts };
  });
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
  step,
  onComplete,
  onExit,
}: {
  sopCode: string;
  step: JourneyStep;
  onComplete: (score: number, passed: boolean, newAttempts: number) => void;
  onExit: () => void;
}) {
  const [localAttempts, setLocalAttempts] = useState(step.attempts ?? 0);
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
  // Exam/retest attempts used this session — drives the attempt allocation and
  // gates when correct answers are finally revealed. (Demo attempts don't count.)
  const [examAttempts, setExamAttempts] = useState(0);
  /** 'trial' = demo assessment; 'exam' = formal scored attempt. */
  const [quizMode, setQuizMode] = useState<'trial' | 'exam'>('exam');

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

  // Gujarati assessment pulls from the Gujarati MCQ bank via the lang param.
  const lang = step.id === 'quizGu' ? 'gu' : 'en';

  const fetchQuestions = useCallback(async (mode: 'trial' | 'exam' = 'exam') => {
    setPhase('loading');
    setAnswers({});
    setScore(0);
    setError('');
    setIsRetest(false);
    setRetestQueue([]);
    if (mode === 'exam') setExamAttempts(0);
    try {
      const res = await fetch(`/api/lms/quiz/${sopCode}?mode=${mode}&lang=${lang}`);
      const data = await res.json() as {
        questions?: MCQQuestion[];
        settings?: QuizSettings;
        error?: string;
      };

      // Demo disabled or empty → fall through to formal exam.
      if (mode === 'trial') {
        const trialCount = data.settings?.trialQuestionCount ?? 0;
        if (trialCount <= 0 || !data.questions?.length) {
          setSettings(data.settings ?? null);
          const examRes = await fetch(`/api/lms/quiz/${sopCode}?mode=exam&lang=${lang}`);
          const examData = await examRes.json() as {
            questions?: MCQQuestion[];
            settings?: QuizSettings;
            error?: string;
          };
          if (!examData.questions?.length) {
            setError(examData.error || 'No questions available.');
            setPhase('review');
            return;
          }
          setSettings(examData.settings ?? data.settings ?? null);
          setQuizMode('exam');
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
      setQuestions(prepareQuestions(data.questions, data.settings?.shuffleOptions ?? false));
      setPhase('intro');
    } catch {
      setError('Failed to load quiz. Please try again.');
      setPhase('review');
    }
  }, [sopCode, lang]);

  // Prefer demo first when configured; otherwise start on the formal exam.
  useEffect(() => { if (!step.completed) void fetchQuestions('trial'); }, [fetchQuestions, step.completed]);

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
    setPhase('review');

    // Demo does not count toward attempts / progress.
    if (quizMode === 'trial') return;

    const newAttempts = localAttempts + 1;
    setLocalAttempts(newAttempts);
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
    setQuestions(retestQueue);
    setAnswers({});
    setScore(0);
    setError('');
    setIsRetest(true);
    setQuizMode('exam');
    setPhase('answering');
  };

  const allowRetake = settings?.allowRetakeAfterPass !== false;

  // ── Already passed (step.completed) — show summary ──────────────────────────
  if (step.completed && phase === 'loading' && localAttempts === (step.attempts ?? 0)) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 py-12">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <Trophy className="h-8 w-8 text-green-600" />
        </div>
        <div className="text-center">
          <p className="font-semibold text-gray-800">Assessment completed</p>
          <p className="mt-1 text-sm text-gray-500">
            You passed with {step.percentage ?? '—'}%.
            {allowRetake ? ' Retake anytime below.' : ''}
          </p>
        </div>
        {allowRetake && (
          <button
            onClick={() => void fetchQuestions('exam')}
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
          <h2 className="text-xl font-bold text-gray-800">
            {isRetest ? 'Start Retest' : isDemo ? 'Demo Assessment' : 'Start Assessment'}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {isDemo
              ? 'Practice first — this demo does not count toward your score.'
              : 'Review the details below, then begin when you\'re ready.'}
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
              {isRetest ? 'Start Retest' : isDemo ? 'Start Demo' : 'Start Exam'}
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
              {questions.map((q, i) => {
                const given = answers[q._id];
                const isRight = given === q.correctAnswer;
                const correctText = q.displayOptions.find((o) => o.label === q.correctAnswer)?.text ?? q.correctAnswer;
                const givenText = q.displayOptions.find((o) => o.label === given)?.text;
                return (
                  <div
                    key={q._id}
                    className={`rounded-xl border p-3 text-sm ${isRight ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}
                  >
                    <p className="font-medium text-gray-800">{i + 1}. {q.question}</p>
                    <p className={`mt-1 text-xs ${isRight ? 'text-green-700' : 'text-red-700'}`}>
                      {isRight
                        ? `Correct: ${correctText}`
                        : <>Your answer: {givenText || '—'} · Correct: {correctText}</>}
                    </p>
                    {!isRight && q.explanation && (
                      <p className="mt-1 text-xs text-gray-500">{q.explanation}</p>
                    )}
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
          <span className="inline-flex items-center rounded-full bg-white px-3.5 py-1 text-xs font-semibold text-gray-600 shadow-sm ring-1 ring-inset ring-gray-200">
            {questions.filter((q) => answers[q._id] === q.correctAnswer).length} of {questions.length} correct
          </span>
        </div>

        {/* Answers stay hidden while retries remain */}
        {!revealAnswers && (
          <div className="flex w-full max-w-md items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
            <p className="text-xs text-gray-500">
              The correct answers stay hidden while you still have attempts left, so your retest
              is a fair test of what you&apos;ve learned. They&apos;ll be shown only if you use all
              attempts without passing.
            </p>
          </div>
        )}

        {/* Answer review — only once revealed */}
        {revealAnswers && (
          <div className="w-full max-w-2xl space-y-3">
            {questions.map((q, i) => {
              const given = answers[q._id];
              const isRight = given === q.correctAnswer;
              const correctText = q.displayOptions.find((o) => o.label === q.correctAnswer)?.text ?? q.correctAnswer;
              const givenText = q.displayOptions.find((o) => o.label === given)?.text;
              return (
                <div
                  key={q._id}
                  className={`rounded-xl border p-3 text-sm ${isRight ? 'border-green-200 bg-green-50' : 'border-red-200 bg-red-50'}`}
                >
                  <p className="font-medium text-gray-800">{i + 1}. {q.question}</p>
                  <p className={`mt-1 text-xs ${isRight ? 'text-green-700' : 'text-red-700'}`}>
                    {isRight
                      ? `Correct: ${correctText}`
                      : <>Your answer: {givenText || '—'} · Correct: {correctText}</>
                    }
                  </p>
                  {!isRight && q.explanation && (
                    <p className="mt-1 text-xs text-gray-500">{q.explanation}</p>
                  )}
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
              This retest includes <strong>only your incorrect questions</strong> and requires
              <strong> 100%</strong> — answer them all correctly to complete the assessment.
            </p>
            <button
              onClick={startRetest}
              className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white shadow hover:bg-purple-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Start Retest · {missedCount} question{missedCount !== 1 ? 's' : ''}
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
          <h1 className="truncate text-sm font-bold text-gray-800 md:text-base">
            {quizMode === 'trial' ? 'Demo' : isRetest ? 'Retest' : 'Assessment'}
          </h1>
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
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-gray-500">
              Question {currentIdx + 1} / {questions.length}
            </span>
            {marked.has(currentIdx) && (
              <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                Marked for review
              </span>
            )}
          </div>

          {/* Question card */}
          <div className="mb-5 rounded-3xl border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-lg font-medium leading-relaxed text-gray-800">{q.question}</p>
          </div>

          {/* Options */}
          <div className="mb-6 space-y-3">
            {q.displayOptions.map((opt) => {
              const selected = answers[q._id] === opt.label;
              return (
                <button
                  key={opt.label}
                  onClick={() => setAnswers((prev) => ({ ...prev, [q._id]: opt.label }))}
                  className={`flex w-full items-center gap-3 rounded-2xl border px-5 py-4 text-left text-sm font-medium transition ${
                    selected
                      ? 'border-purple-400 bg-purple-50 text-purple-800 shadow-sm'
                      : 'border-gray-200 bg-white text-gray-700 hover:border-purple-200 hover:bg-purple-50/40'
                  }`}
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    selected ? 'bg-purple-600 text-white' : 'bg-gray-100 text-gray-500'
                  }`}>
                    {opt.label}
                  </span>
                  {opt.text}
                </button>
              );
            })}
          </div>

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
          const certRes = await fetch(`/api/lms/certificate/${sopCode}`);
          const certData = await certRes.json();
          if (certData.certificate) setHasCert(true);
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
        return { ...s, completed: passed || s.completed, attempts: newAttempts };
      }),
    );

    const newPct = await updateProgress(stepId, { completed: passed, passed, score, attempts: newAttempts });

    // Certificate + celebration only after progress is confirmed at 100%
    if (passed && newPct !== null && newPct >= 100) {
      try {
        const r = await fetch(`/api/lms/certificate/${sopCode}`, { method: 'POST' });
        const d = await r.json();
        if (d.certificate) setHasCert(true);
        if (r.ok) setShowCelebration(true);
      } catch { /* non-critical */ }
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
                onComplete={() => markStepComplete(activeStep.id)}
              />
            )}
            {activeStep?.type === 'quiz' && (
              <QuizStep
                key={activeStep.id}
                sopCode={sopCode}
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
