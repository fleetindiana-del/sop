'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, FileText, Loader2 } from 'lucide-react';

const FETCH_MS = 45_000;
const RENDER_MS = 60_000;

interface AnnexureMeta {
  label: string;
  fileName: string;
  fileType: 'pdf' | 'docx';
  token: string;
}

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_MS);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** One annexure rendered below the main SOP — same view-only docx-preview/PDF handling. */
function AnnexureBlock({ annexure }: { annexure: AnnexureMeta }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const fileUrl = `/api/lms/annexure-file?t=${encodeURIComponent(annexure.token)}`;

  useEffect(() => {
    if (annexure.fileType === 'pdf') {
      setPhase('ready');
      return;
    }
    let cancelled = false;
    (async () => {
      setPhase('loading');
      setError(null);
      try {
        const res = await fetchWithTimeout(fileUrl);
        if (!res.ok) throw new Error('Annexure file could not be loaded.');
        const blob = await res.blob();
        if (cancelled) return;
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        if (cancelled || !bodyRef.current) throw new Error('Preview surface not ready.');
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
            setTimeout(() => reject(new Error('Annexure render timed out')), RENDER_MS),
          ),
        ]);
        if (!cancelled) setPhase('ready');
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to load the annexure preview.');
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUrl, annexure.fileType]);

  return (
    <div className="mt-4 border-t border-stone-400/40 pt-4">
      <div className="mx-auto flex w-[794px] max-w-full items-center gap-2 px-2 pb-2 text-sm font-semibold text-gray-700">
        <FileText className="h-4 w-4 text-purple-600" />
        Annexure{annexure.label ? ` ${annexure.label}` : ''} — {annexure.fileName}
      </div>
      {annexure.fileType === 'pdf' ? (
        <div className="mx-auto w-[794px] max-w-full px-2">
          <iframe
            src={`${fileUrl}#toolbar=0&navpanes=0`}
            title={`Annexure ${annexure.label || ''}`}
            className="h-[600px] w-full rounded border border-gray-300 bg-white"
          />
        </div>
      ) : (
        <div className="relative min-h-[160px]">
          {phase === 'loading' && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-gray-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading annexure...
            </div>
          )}
          {phase === 'error' && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-red-600">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}
          <div ref={styleRef} className="docx-preview-styles" aria-hidden />
          <div
            ref={bodyRef}
            className={`docx-preview-surface select-none ${phase === 'ready' ? '' : 'invisible h-0 overflow-hidden'}`}
          />
        </div>
      )}
    </div>
  );
}

/**
 * LMS Word preview — clean view (no watermark), download/copy disabled.
 * Same docx-preview engine as the dashboard Quick Preview.
 */
export function RestrictedLmsDocxPreview({
  pathParam,
  identifierParam,
  languageParam,
}: {
  pathParam: string | null;
  identifierParam: string | null;
  languageParam: string | null;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [annexures, setAnnexures] = useState<AnnexureMeta[]>([]);
  const isGujarati = (languageParam || '').toLowerCase() === 'gujarati';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ['c', 'C', 'x', 'X', 's', 'S', 'p', 'P', 'a', 'A'].includes(e.key)) {
        e.preventDefault();
      }
      // Best-effort deterrent — DevTools access cannot be blocked outright.
      if (
        e.key === 'F12' ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i', 'I', 'j', 'J', 'c', 'C'].includes(e.key)) ||
        ((e.ctrlKey || e.metaKey) && ['u', 'U'].includes(e.key))
      ) {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Connected annexures render below the main SOP so both are visible together.
  useEffect(() => {
    if (!identifierParam) {
      setAnnexures([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ identifier: identifierParam });
        if (languageParam) params.set('language', languageParam);
        const res = await fetchWithTimeout(`/api/lms/sop-annexures?${params.toString()}`);
        if (cancelled || !res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (!cancelled && Array.isArray(data?.annexures)) setAnnexures(data.annexures);
      } catch {
        /* annexures are supplementary — a fetch failure should not block the main SOP */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identifierParam, languageParam]);

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
      onDragStart={(e) => e.preventDefault()}
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

      <div className={`relative docx-scroll-area min-h-0 flex-1 overflow-auto print:hidden ${phase === 'ready' ? '' : 'invisible'}`}>
        <div ref={styleRef} className="docx-preview-styles" aria-hidden />
        <div
          ref={bodyRef}
          className={`docx-preview-surface select-none${isGujarati ? ' docx-gujarati-text' : ''}`}
        />
        {phase === 'ready' && (
          <>
            {annexures.map((a) => (
              <AnnexureBlock key={a.token} annexure={a} />
            ))}
            <p className="mx-auto w-[794px] max-w-full px-2 pb-6 pt-2 text-center text-[11px] text-amber-700">
              View only — download, copy, and print are disabled for this SOP and its annexures.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
