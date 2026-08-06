'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';

const FETCH_MS = 45_000;
const RENDER_MS = 60_000;
/** Hold black after PrintScreen — OS often grabs the frame a beat later. */
const PRINTSCREEN_HOLD_MS = 4_000;

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * LMS Word preview with secure-view: the SOP paints only while this window is
 * focused. On blur / tab hide / capture shortcuts the surface goes solid black
 * so Snipping Tool and many PrintScreen grabs capture black instead of content.
 * Phone cameras and some OS paths still cannot be blocked in a browser.
 */
export function RestrictedLmsDocxPreview({
  pathParam,
  identifierParam,
  languageParam,
}: {
  pathParam: string | null;
  identifierParam: string | null;
  languageParam: string | null;
  /** Kept for callers; secure-view uses blackout instead of a watermark. */
  watermarkText?: string | null;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  /** True when focus lost / tab hidden — stays until the window is focused again. */
  const [unfocused, setUnfocused] = useState(false);
  /** Timed blackout from capture key chords (PrintScreen, Win+Shift+S). */
  const [captureHold, setCaptureHold] = useState(false);
  const isGujarati = (languageParam || '').toLowerCase() === 'gujarati';

  const blackedOut = unfocused || captureHold;

  useEffect(() => {
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    const syncFocus = () => {
      setUnfocused(document.hidden || !document.hasFocus());
    };

    const holdCapture = (ms = PRINTSCREEN_HOLD_MS) => {
      setCaptureHold(true);
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => setCaptureHold(false), ms);
      // Best-effort: wipe clipboard so a PrintScreen paste is empty.
      try {
        void navigator.clipboard?.writeText?.('');
      } catch {
        /* ignore */
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'PrintScreen') {
        e.preventDefault();
        e.stopPropagation();
        holdCapture();
      }
      if ((e.ctrlKey || e.metaKey) && ['c', 'C', 'x', 'X', 's', 'S', 'p', 'P', 'a', 'A'].includes(e.key)) {
        e.preventDefault();
      }
      // Win+Shift+S / Ctrl+Shift+S — blank before the snip UI opens.
      if (e.shiftKey && (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
        holdCapture(8_000);
      }
    };

    // Capture-phase keyup too — some OS paths fire after keydown.
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'PrintScreen') holdCapture();
    };

    syncFocus();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', syncFocus);
    window.addEventListener('focus', syncFocus);
    document.addEventListener('visibilitychange', syncFocus);

    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', syncFocus);
      window.removeEventListener('focus', syncFocus);
      document.removeEventListener('visibilitychange', syncFocus);
      if (holdTimer) clearTimeout(holdTimer);
    };
  }, []);

  useEffect(() => {
    if (!pathParam && !identifierParam) {
      setError('No document path or identifier provided.');
      setPhase('error');
      return;
    }

    let cancelled = false;

    (async () => {
      setPhase('loading');
      setError(null);
      try {
        let blob: Blob | null = null;

        if (pathParam && /^https?:\/\//i.test(pathParam) && /\.docx($|\?)/i.test(pathParam)) {
          try {
            const direct = await fetchWithTimeout(pathParam);
            if (direct.ok) {
              const b = await direct.blob();
              if (b.size > 0) blob = b;
            }
          } catch {
            /* fall through */
          }
        }

        if (!blob) {
          const tokenParams = new URLSearchParams();
          if (identifierParam) tokenParams.set('identifier', identifierParam);
          if (languageParam) tokenParams.set('language', languageParam || 'English');
          if (pathParam && /\.docx?($|\?)/i.test(pathParam)) {
            tokenParams.set('path', pathParam);
          }

          const tokenRes = await fetchWithTimeout(`/api/files/docx-view-token?${tokenParams.toString()}`);
          const tokenData = await tokenRes.json().catch(() => ({}));
          if (cancelled) return;
          if (!tokenData?.success || !tokenData.token) {
            throw new Error(tokenData?.error || 'Word document not available for this SOP.');
          }

          const blobRes = await fetchWithTimeout(
            `/api/files/serve-docx?t=${encodeURIComponent(tokenData.token)}`,
          );
          if (cancelled) return;
          if (!blobRes.ok) {
            throw new Error('The document file could not be loaded.');
          }
          const ct = (blobRes.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('application/pdf')) {
            throw new Error('A Word (.docx) file is required for view-only LMS preview.');
          }
          blob = await blobRes.blob();
        }

        if (cancelled || !blob) return;

        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (cancelled || !bodyRef.current) {
          throw new Error('Preview surface not ready.');
        }

        const { renderAsync } = await import('docx-preview');
        bodyRef.current.innerHTML = '';
        if (styleRef.current) styleRef.current.innerHTML = '';

        await Promise.race([
          renderAsync(blob, bodyRef.current, styleRef.current || undefined, {
            className: 'docx-preview-wrapper',
            breakPages: true,
            inWrapper: true,
            renderHeaders: true,
            renderFooters: true,
            renderFootnotes: true,
            renderEndnotes: true,
            renderAltChunks: true,
            ignoreWidth: false,
            ignoreHeight: false,
            ignoreFonts: false,
            experimental: true,
            useBase64URL: true,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Document render timed out')), RENDER_MS),
          ),
        ]);

        if (!cancelled) setPhase('ready');
      } catch (e: unknown) {
        if (cancelled) return;
        const aborted =
          e instanceof Error && (e.name === 'AbortError' || /aborted|timed out/i.test(e.message));
        setError(
          aborted
            ? 'Loading timed out. Please try again.'
            : e instanceof Error
              ? e.message
              : 'Failed to load the document preview.',
        );
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pathParam, identifierParam, languageParam]);

  return (
    <div
      className="relative flex h-full min-h-[240px] flex-col select-none bg-stone-300"
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      onPaste={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {phase === 'loading' && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-stone-300">
          <Loader2 className="h-9 w-9 animate-spin text-purple-600" />
          <p className="text-sm font-medium text-gray-600">Loading document...</p>
        </div>
      )}

      {phase === 'error' && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-white p-6">
          <div className="max-w-md text-center">
            <AlertCircle className="mx-auto mb-2 h-8 w-8 text-red-500" />
            <p className="text-sm font-semibold text-gray-800">Cannot open document</p>
            <p className="mt-1 text-xs text-gray-500">{error}</p>
          </div>
        </div>
      )}

      <div
        className={`relative docx-scroll-area min-h-0 flex-1 overflow-auto ${phase === 'ready' ? '' : 'invisible'}`}
        // Hide painted pixels from the compositor while blacked out (extra belt for captures).
        style={blackedOut && phase === 'ready' ? { visibility: 'hidden' } : undefined}
      >
        <div ref={styleRef} className="docx-preview-styles" aria-hidden />
        <div
          ref={bodyRef}
          className={`docx-preview-surface select-none${isGujarati ? ' docx-gujarati-text' : ''}`}
        />

        {phase === 'ready' && (
          <p className="mx-auto w-[794px] max-w-full px-2 pb-6 pt-2 text-center text-[11px] text-amber-700">
            View only — the document blacks out if you switch away or use a screenshot shortcut.
          </p>
        )}
      </div>

      {/* Solid black cover: shown on blur / hide / capture keys so grabs see black. */}
      {phase === 'ready' && blackedOut && (
        <div
          className="absolute inset-0 z-30 flex items-center justify-center bg-black px-6 text-center"
          aria-live="polite"
        >
          <div>
            <p className="text-sm font-semibold text-white">Document hidden</p>
            <p className="mt-1 text-xs text-white/60">
              Click back into this window to continue reading.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
