'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, AlertCircle, FileText, Download, RefreshCw, ExternalLink } from 'lucide-react';
import { buildDocxDownloadHref } from '@/lib/viewDocLinks';

export { buildDocxDownloadHref } from '@/lib/viewDocLinks';

type PreviewMode =
  | 'loading'
  | 'google-viewer'   // Primary: Google Docs Viewer iframe — faithful rendering, ~10-30s
  | 'office-viewer'   // Alternative: Office Online iframe — pixel-perfect, ~2-3min
  | 'docx-preview'    // Fallback: in-browser docx-preview library
  | 'view-docx-html'  // Gujarati HTML conversion
  | 'pdf-inline'
  | 'error';

export type DocxViewerPreference = 'office' | 'google';

const GOOGLE_VIEWER = 'https://docs.google.com/gview';
const PREVIEW_API_TIMEOUT_MS = 60_000;
const DOCX_RENDER_TIMEOUT_MS = 180_000;

async function fetchWithTimeout(input: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PREVIEW_API_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseFilenameFromContentDisposition(cd: string | null): string | null {
  if (!cd) return null;
  const star = cd.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (star) {
    try { return decodeURIComponent(star[1]); } catch { return star[1]; }
  }
  const quoted = cd.match(/filename="([^"]+)"/i);
  if (quoted) return quoted[1];
  const plain = cd.match(/filename=([^;\s]+)/i);
  return plain ? plain[1].replace(/^["']|["']$/g, '') : null;
}

export async function downloadWordFileFromApi(
  url: string,
  fallbackFileName: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await fetch(url, { credentials: 'same-origin' });
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok || ct.includes('application/json')) {
    let message = `Could not download the file (${res.status}).`;
    try {
      const j = (await res.json()) as { error?: string; hint?: string };
      if (j.error) message = j.error;
      else if (j.hint) message = j.hint;
    } catch { /* body not JSON */ }
    return { ok: false, message };
  }
  const blob = await res.blob();
  const fromHeader =
    parseFilenameFromContentDisposition(res.headers.get('content-disposition')) || fallbackFileName;
  const safeName = /\.(docx|doc)$/i.test(fromHeader)
    ? fromHeader
    : `${fallbackFileName.replace(/\.[^.]+$/, '')}.docx`;
  const obj = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = obj;
  a.download = safeName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(obj);
  return { ok: true };
}

type Props = {
  pathParam: string | null;
  identifierParam: string | null;
  languageParam: string | null;
  backHref?: string;
  backLabel?: string;
  layout?: 'full' | 'embedded';
  viewerPreference?: DocxViewerPreference;
  /**
   * LMS / view-only: skip Google/Office iframes (download chrome), hide Download,
   * and render with the same in-browser docx-preview engine as the dashboard.
   */
  restricted?: boolean;
};

export default function DocxPreviewClient({
  pathParam,
  identifierParam,
  languageParam,
  backHref = '/dashboard',
  backLabel = 'Back to Dashboard',
  layout = 'full',
  restricted = false,
}: Props) {
  const [mode, setMode] = useState<PreviewMode>('loading');
  const [error, setError] = useState<string | null>(null);
  const [pdfInlineSrc, setPdfInlineSrc] = useState<string | null>(null);
  const [viewDocxHtml, setViewDocxHtml] = useState<string | null>(null);

  // Viewer URLs
  const [googleViewerSrc, setGoogleViewerSrc] = useState<string | null>(null);
  const [officeViewerUrl, setOfficeViewerUrl] = useState<string | null>(null);
  const [cdnDocUrl, setCdnDocUrl] = useState<string | null>(null);
  const [iframeLoading, setIframeLoading] = useState(true);
  // Track if Google viewer failed to load (show retry/fallback hint)
  const [googleFailed, setGoogleFailed] = useState(false);

  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const isGujarati = (languageParam || '').toLowerCase() === 'gujarati';
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [downloadHint, setDownloadHint] = useState<string | null>(null);

  useEffect(() => {
    const id = 'noto-sans-gujarati-docx-preview';
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+Gujarati:wght@400;500;600;700&display=swap';
      document.head.appendChild(link);
    }
  }, []);

  useEffect(() => {
    if (!pathParam && !identifierParam) {
      setError('No document path or identifier provided.');
      setMode('error');
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // Restricted LMS mode: never open Google/Office (Download / Add to Drive).
        // Use the same in-browser docx-preview path the dashboard uses as Quick Preview.
        if (restricted) {
          await renderViaServerPath(cancelled);
          return;
        }

        // ── Resolve viewer URLs (server-side cached after first call) ────────────────
        const viewerParams = new URLSearchParams();
        if (identifierParam) viewerParams.set('identifier', identifierParam);
        if (languageParam) viewerParams.set('language', languageParam || 'English');
        if (pathParam) viewerParams.set('path', pathParam);
        const viewerRes = await fetchWithTimeout(`/api/files/viewer-url?${viewerParams.toString()}`);
        const viewerJson = await viewerRes.json();
        if (cancelled) return;

        const cdnUrl: string | null =
          viewerJson.success && viewerJson.canUseOfficeViewer && viewerJson.publicDocumentUrl
            ? (viewerJson.publicDocumentUrl as string)
            : null;

        if (viewerJson.success && viewerJson.officeViewerUrl) {
          setOfficeViewerUrl(viewerJson.officeViewerUrl as string);
        }

        // ── Primary path: Google Docs Viewer (CDN files) ─────────────────────────────
        // Google Docs Viewer renders faithfully — logos, WMF/EMF images, tables, fonts.
        // Typically 10-30 seconds vs 2-3 minutes for Office Online.
        // No file download needed — just pass the CDN URL to Google.
        if (cdnUrl) {
          const isPdf = /\.pdf($|\?)/i.test(cdnUrl) ||
            (!!(pathParam) && /\.pdf($|\?)/i.test(pathParam));

          if (isPdf) {
            setPdfInlineSrc(cdnUrl);
            setMode('pdf-inline');
            return;
          }

          setCdnDocUrl(cdnUrl);
          setGoogleViewerSrc(`${GOOGLE_VIEWER}?url=${encodeURIComponent(cdnUrl)}&embedded=true`);
          setIframeLoading(true);
          setGoogleFailed(false);
          setMode('google-viewer');
          return;
        }

        // ── Server-side fallback: non-CDN / local files ───────────────────────────────
        await renderViaServerPath(cancelled);
      } catch (e: unknown) {
        if (cancelled) return;
        const aborted = e instanceof Error && (e.name === 'AbortError' || e.message.includes('aborted'));
        setError(
          aborted
            ? 'Loading timed out. Try downloading the file instead.'
            : 'Failed to load the document preview.',
        );
        setMode('error');
      }
    })();

    async function renderViaServerPath(isCancelled: boolean) {
      const tokenParams = new URLSearchParams();
      if (identifierParam) tokenParams.set('identifier', identifierParam);
      if (languageParam) tokenParams.set('language', languageParam || 'English');
      if (pathParam) tokenParams.set('path', pathParam);

      const tokenRes = await fetchWithTimeout(`/api/files/docx-view-token?${tokenParams.toString()}`);
      const tokenData = await tokenRes.json();
      if (isCancelled) return;

      if (!tokenData.success || !tokenData.token) {
        if (!restricted && await tryPdfFallback()) return;
        if (isCancelled) return;
        setError('Could not open the document. The file may not be available on this server.');
        setMode('error');
        return;
      }

      const blobRes = await fetchWithTimeout(`/api/files/serve-docx?t=${encodeURIComponent(tokenData.token)}`);
      if (isCancelled) return;
      if (!blobRes.ok) {
        if (!restricted && await tryPdfFallback()) return;
        if (isCancelled) return;
        setError('The document file could not be loaded.');
        setMode('error');
        return;
      }

      const ct2 = (blobRes.headers.get('content-type') || '').toLowerCase();
      if (ct2.includes('application/pdf')) {
        if (restricted) {
          setError('A Word (.docx) file is required for view-only LMS preview.');
          setMode('error');
          return;
        }
        const dlParams = new URLSearchParams();
        if (identifierParam) dlParams.set('identifier', identifierParam);
        if (languageParam) dlParams.set('language', languageParam || 'English');
        if (pathParam) dlParams.set('path', pathParam);
        dlParams.set('open', '1');
        setPdfInlineSrc(`/api/files/download?${dlParams.toString()}`);
        setMode('pdf-inline');
        return;
      }

      if (isGujarati && pathParam) {
        try {
          const cdnFallbackRes = await fetchWithTimeout(pathParam);
          if (!isCancelled && cdnFallbackRes.ok) {
            const docxBytes = await cdnFallbackRes.arrayBuffer();
            if (!isCancelled && docxBytes.byteLength > 0) {
              const postParams = new URLSearchParams();
              if (identifierParam) postParams.set('identifier', identifierParam);
              if (languageParam) postParams.set('language', languageParam);
              const htmlRes = await fetchWithTimeout(
                `/api/files/docx-to-html?${postParams.toString()}`,
                { method: 'POST', body: docxBytes, headers: { 'Content-Type': 'application/octet-stream' } },
              );
              if (!isCancelled && htmlRes.ok) {
                const htmlData = await htmlRes.json();
                if (!isCancelled && htmlData.success && htmlData.html) {
                  setViewDocxHtml(htmlData.html as string);
                  setMode('view-docx-html');
                  return;
                }
              }
            }
          }
        } catch { /* fall through */ }
      }

      const blob = await blobRes.blob();
      try {
        const { renderAsync } = await import('docx-preview');
        // Ensure the loading UI (with hidden bodyRef) has committed before render.
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        if (isCancelled || !bodyRef.current) {
          setError('Preview surface not ready. Please try again.');
          setMode('error');
          return;
        }
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
            setTimeout(() => reject(new Error('Document render timed out')), DOCX_RENDER_TIMEOUT_MS),
          ),
        ]);
        if (isCancelled) return;
        setMode('docx-preview');
      } catch {
        if (!isCancelled && !restricted && await tryPdfFallback()) return;
        if (isCancelled) return;
        setError('Failed to render the document. The file may be corrupted or in an unsupported format.');
        setMode('error');
      }
    }

    async function tryPdfFallback(): Promise<boolean> {
      try {
        const dlParams = new URLSearchParams();
        if (identifierParam) dlParams.set('identifier', identifierParam);
        if (languageParam) dlParams.set('language', languageParam || 'English');
        if (pathParam) dlParams.set('path', pathParam);
        dlParams.set('open', '1');
        const dlRes = await fetchWithTimeout(`/api/files/download?${dlParams.toString()}`, { credentials: 'same-origin' });
        if (!dlRes.ok) return false;
        const ct = (dlRes.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('application/pdf')) {
          setPdfInlineSrc(`/api/files/download?${dlParams.toString()}`);
          setMode('pdf-inline');
          return true;
        }
        return false;
      } catch { return false; }
    }

    return () => { cancelled = true; };
  }, [pathParam, identifierParam, languageParam, isGujarati, restricted]);

  const docxDownloadHref = restricted
    ? null
    : buildDocxDownloadHref(pathParam, identifierParam, languageParam);

  const handleDownloadDocx = useCallback(async () => {
    if (!docxDownloadHref) return;
    setDownloadBusy(true);
    setDownloadHint(null);
    const stem =
      identifierParam?.trim() ||
      (pathParam ? decodeURIComponent(pathParam.split(/[/\\]/).pop() || '').replace(/\.(pdf|docx|doc)$/i, '') : '') ||
      'document';
    const safeStem = stem.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 180);
    const fallback = /\.(docx|doc)$/i.test(safeStem) ? safeStem : `${safeStem}.docx`;
    const result = await downloadWordFileFromApi(docxDownloadHref, fallback);
    setDownloadBusy(false);
    if (!result.ok) setDownloadHint(result.message);
  }, [docxDownloadHref, identifierParam, pathParam]);

  // Switch from Google Viewer to Office Online
  const switchToOfficeOnline = useCallback(() => {
    if (!officeViewerUrl) return;
    setIframeLoading(true);
    setGoogleFailed(false);
    setMode('office-viewer');
  }, [officeViewerUrl]);

  // Switch from Google Viewer to in-app docx-preview
  const switchToDocxPreview = useCallback(async () => {
    if (!cdnDocUrl) return;
    setMode('loading');
    try {
      const docxRes = await fetchWithTimeout(cdnDocUrl);
      if (!docxRes.ok) throw new Error('fetch failed');
      const blob = await docxRes.blob();
      const { renderAsync } = await import('docx-preview');
      if (!bodyRef.current) return;
      bodyRef.current.innerHTML = '';
      if (styleRef.current) styleRef.current.innerHTML = '';
      await renderAsync(blob, bodyRef.current, styleRef.current || undefined, {
        className: 'docx-preview-wrapper',
        breakPages: true, inWrapper: true,
        renderHeaders: true, renderFooters: true,
        renderFootnotes: true, renderEndnotes: true,
        renderAltChunks: true, ignoreWidth: false, ignoreHeight: false,
        ignoreFonts: false, experimental: true, useBase64URL: true,
      });
      setMode('docx-preview');
    } catch {
      setError('Could not load in-browser preview. Try downloading the file.');
      setMode('error');
    }
  }, [cdnDocUrl]);

  // ── Loading spinner ────────────────────────────────────────────────────────
  if (mode === 'loading') {
    return (
      <div className={`relative flex items-center justify-center ${layout === 'embedded' ? 'min-h-[320px] h-full' : 'min-h-screen bg-gray-100'}`}>
        <div className="flex flex-col items-center gap-3">
          <div className={`h-10 w-10 animate-spin rounded-full border-4 border-t-transparent ${layout === 'embedded' ? 'border-green-500' : 'border-purple-600'}`} />
          <p className="text-sm font-medium text-gray-600">Preparing document…</p>
        </div>
        {/* Keep render targets mounted so renderAsync never races an empty ref. */}
        <div className="pointer-events-none absolute h-0 w-0 overflow-hidden opacity-0" aria-hidden>
          <div ref={styleRef} />
          <div ref={bodyRef} />
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────
  if (mode === 'error') {
    return (
      <div className={layout === 'embedded'
        ? 'rounded-xl border border-red-500/30 bg-red-950/20 p-6'
        : 'flex min-h-screen items-center justify-center bg-gray-100 p-4'}>
        <div className="max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3 text-red-600">
            <AlertCircle className="h-8 w-8 shrink-0" />
            <p className="font-semibold">Cannot open document</p>
          </div>
          <p className="mt-2 text-sm text-gray-600">{error}</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Link href={backHref} className="inline-flex items-center gap-2 text-sm font-semibold text-purple-600 hover:underline">
              <ArrowLeft className="h-4 w-4" /> {backLabel}
            </Link>
            {docxDownloadHref && (
              <div className="flex flex-col gap-2">
                <button type="button" disabled={downloadBusy} onClick={() => void handleDownloadDocx()}
                  className="inline-flex w-fit items-center gap-2 text-sm font-semibold text-blue-600 underline decoration-blue-400/60 hover:text-blue-800 disabled:opacity-50"
                >
                  <Download className="h-4 w-4 shrink-0" aria-hidden />
                  {downloadBusy ? 'Preparing download…' : 'Download original file'}
                </button>
                {downloadHint && <p className="text-xs text-red-600">{downloadHint}</p>}
              </div>
            )}
            {officeViewerUrl && (
              <a href={officeViewerUrl} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-semibold text-gray-600 underline hover:text-gray-800"
              >
                <ExternalLink className="h-4 w-4" /> Open in Office Online
              </a>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── PDF inline ─────────────────────────────────────────────────────────────
  if (mode === 'pdf-inline' && pdfInlineSrc) {
    return (
      <div className={`relative flex flex-col bg-[#e5e7eb] ${layout === 'embedded' ? 'min-h-[600px]' : 'h-screen'}`}>
        <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 py-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <BackButton backHref={backHref} backLabel={backLabel} />
            {docxDownloadHref && (
              <button type="button" disabled={downloadBusy} onClick={() => void handleDownloadDocx()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                <Download className="h-4 w-4" aria-hidden />
                {downloadBusy ? 'Preparing…' : 'Download original'}
              </button>
            )}
          </div>
          <span className="flex items-center gap-2 text-xs text-gray-500">
            <FileText className="h-4 w-4" /> PDF preview
            {isGujarati && <span className="font-semibold text-indigo-600">Gujarati</span>}
          </span>
        </div>
        <div className="min-h-0 flex-1 p-2 sm:p-3">
          <iframe src={pdfInlineSrc} title="SOP document — PDF preview"
            className={`w-full max-w-[1200px] mx-auto rounded-lg border border-gray-200 bg-white shadow-md ${layout === 'embedded' ? 'min-h-[560px]' : 'h-[calc(100vh-3.25rem)]'}`}
          />
        </div>
        {downloadHint && <p className="px-4 pb-2 text-xs text-red-600">{downloadHint}</p>}
      </div>
    );
  }

  // ── Gujarati HTML preview ──────────────────────────────────────────────────
  if (mode === 'view-docx-html' && viewDocxHtml) {
    return (
      <div className={`relative flex flex-col bg-[#d1d5db] ${layout === 'embedded' ? 'min-h-[600px]' : 'min-h-screen'}`}>
        <div className="sticky top-0 z-10 flex shrink-0 items-center justify-between border-b border-gray-200 bg-white px-4 py-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            {layout === 'full' && <BackButton backHref={backHref} backLabel={backLabel} />}
            {docxDownloadHref && (
              <button type="button" disabled={downloadBusy} onClick={() => void handleDownloadDocx()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                <Download className="h-4 w-4" aria-hidden />
                {downloadBusy ? 'Preparing…' : 'Download original'}
              </button>
            )}
          </div>
          <span className="flex items-center gap-2 text-xs text-gray-500">
            <FileText className="h-4 w-4" /> In-browser preview
            <span className="font-semibold text-indigo-600">Gujarati</span>
          </span>
        </div>
        {downloadHint && <p className="px-4 pt-1 text-xs text-red-600">{downloadHint}</p>}
        <div className="docx-scroll-area flex-1">
          <div
            className={`docx-page-shell view-docx-surface${isGujarati ? ' view-docx-gujarati' : ''}`}
            dangerouslySetInnerHTML={{ __html: viewDocxHtml }}
          />
          <p className="mx-auto w-[794px] max-w-full px-2 pb-8 pt-3 text-center text-[11px] leading-snug text-gray-500">
            In-browser preview — <strong>Download original</strong> opens the exact file in Microsoft Word.
          </p>
        </div>
      </div>
    );
  }

  // ── Google Docs Viewer (primary) / Office Online (alternative) ────────────
  if ((mode === 'google-viewer' && googleViewerSrc) || (mode === 'office-viewer' && officeViewerUrl)) {
    const iframeSrc = mode === 'office-viewer' ? officeViewerUrl! : googleViewerSrc!;
    const isOfficeMode = mode === 'office-viewer';

    return (
      <div className={`flex flex-col bg-gray-100 ${layout === 'embedded' ? 'min-h-[600px]' : 'h-screen'}`}>
        {/* ── Toolbar ── */}
        <div className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 bg-white px-4 py-2 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            {layout === 'full' && <BackButton backHref={backHref} backLabel={backLabel} />}

            {docxDownloadHref && (
              <button type="button" disabled={downloadBusy} onClick={() => void handleDownloadDocx()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                <Download className="h-4 w-4" aria-hidden />
                {downloadBusy ? 'Preparing…' : 'Download'}
              </button>
            )}

            {/* Switch viewer buttons */}
            {!isOfficeMode && officeViewerUrl && (
              <button type="button" onClick={switchToOfficeOnline}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
                title="Office Online renders pixel-perfect but takes 2-3 minutes to load"
              >
                <ExternalLink className="h-4 w-4" />
                Office Online <span className="text-[10px] text-gray-400">(slower)</span>
              </button>
            )}
            {isOfficeMode && googleViewerSrc && (
              <button type="button" onClick={() => { setIframeLoading(true); setMode('google-viewer'); }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-sm font-medium text-purple-700 hover:bg-purple-100"
              >
                <RefreshCw className="h-4 w-4" />
                Google Viewer <span className="text-[10px] text-purple-400">(faster)</span>
              </button>
            )}
            {!isOfficeMode && cdnDocUrl && (
              <button type="button" onClick={() => void switchToDocxPreview()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-50"
                title="In-browser render (instant but logos may differ)"
              >
                <FileText className="h-4 w-4" />
                Quick preview
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-gray-400">
            <FileText className="h-3.5 w-3.5" />
            {isOfficeMode ? 'Office Online' : 'Google Docs Viewer'}
            {isGujarati && <span className="font-semibold text-indigo-500">· Gujarati</span>}
          </div>
        </div>

        {/* ── Viewer iframe ── */}
        <div className="relative min-h-0 flex-1">
          {iframeLoading && (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-gray-50">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-purple-600 border-t-transparent" />
              <p className="mt-3 text-sm font-medium text-gray-600">
                {isOfficeMode ? 'Opening in Office Online…' : 'Loading document…'}
              </p>
              <p className="mt-1 text-xs text-gray-400">
                {isOfficeMode
                  ? 'Office Online may take 2-3 minutes to fetch and render the file.'
                  : 'Usually ready in 10-30 seconds.'}
              </p>
            </div>
          )}

          {/* Google failed hint */}
          {googleFailed && !iframeLoading && !isOfficeMode && (
            <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-xl border border-amber-200 bg-white px-4 py-3 shadow-lg text-sm text-center">
              <p className="font-medium text-amber-700">Google Viewer could not load this document.</p>
              <div className="mt-2 flex flex-wrap justify-center gap-2">
                {officeViewerUrl && (
                  <button type="button" onClick={switchToOfficeOnline}
                    className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700"
                  >Try Office Online</button>
                )}
                {cdnDocUrl && (
                  <button type="button" onClick={() => void switchToDocxPreview()}
                    className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >Quick Preview</button>
                )}
              </div>
            </div>
          )}

          <iframe
            key={iframeSrc}
            title="Document viewer"
            src={iframeSrc}
            className="h-full w-full border-0 bg-white"
            allow="fullscreen"
            sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
            onLoad={() => setIframeLoading(false)}
            onError={() => { setIframeLoading(false); setGoogleFailed(true); }}
          />
        </div>
      </div>
    );
  }

  // ── In-browser docx-preview (fallback / "Quick Preview") ──────────────────
  // `mode === 'loading'` is always handled by the early return above (incl. when switchToDocxPreview starts).
  return (
    <div
      className={`relative flex flex-col bg-[#d1d5db] ${layout === 'embedded' ? 'min-h-[320px] h-full' : 'min-h-screen'} ${restricted ? 'select-none' : ''}`}
      onCopy={restricted ? (e) => e.preventDefault() : undefined}
      onCut={restricted ? (e) => e.preventDefault() : undefined}
      onPaste={restricted ? (e) => e.preventDefault() : undefined}
      onContextMenu={restricted ? (e) => e.preventDefault() : undefined}
    >
      {layout === 'full' && !restricted && (
        <div className="sticky top-0 z-10 flex shrink-0 flex-col gap-1 border-b border-gray-200 bg-white px-4 py-2 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <BackButton backHref={backHref} backLabel={backLabel} />
              {docxDownloadHref && (
                <button type="button" disabled={downloadBusy} onClick={() => void handleDownloadDocx()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                >
                  <Download className="h-4 w-4" aria-hidden />
                  {downloadBusy ? 'Preparing…' : 'Download original'}
                </button>
              )}
              {officeViewerUrl && (
                <a href={officeViewerUrl} target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
                  title="Open in Microsoft Office Online for exact rendering"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  Office Online
                </a>
              )}
            </div>
            <span className="flex items-center gap-2 text-xs text-gray-500">
              <FileText className="h-4 w-4" /> Quick preview
              {isGujarati && <span className="font-semibold text-indigo-600">Gujarati</span>}
            </span>
          </div>
          {downloadHint && <p className="text-xs text-red-600" role="alert">{downloadHint}</p>}
        </div>
      )}

      {layout === 'embedded' && !restricted && (
        <div className="flex shrink-0 flex-col items-end gap-1 px-1 pt-1">
          <div className="flex items-center gap-2">
            {docxDownloadHref && (
              <button type="button" disabled={downloadBusy} onClick={() => void handleDownloadDocx()}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                {downloadBusy ? 'Preparing…' : 'Download original'}
              </button>
            )}
          </div>
          {downloadHint && <p className="max-w-xs text-right text-[10px] text-red-600">{downloadHint}</p>}
        </div>
      )}

      <div className="docx-scroll-area flex-1 min-h-0 overflow-auto">
        <div ref={styleRef} className="docx-preview-styles" aria-hidden="true" />
        <div
          ref={bodyRef}
          className={
            mode === 'docx-preview'
              ? `docx-preview-surface${isGujarati ? ' docx-gujarati-text' : ''}${restricted ? ' select-none' : ''}`
              : 'hidden'
          }
        />
        {mode === 'docx-preview' && !restricted && (
          <p className="mx-auto w-[794px] max-w-full px-2 pb-8 pt-3 text-center text-[11px] leading-snug text-gray-500">
            Quick preview — some images (logos, WMF graphics) may differ from the original.{' '}
            <strong>Download original</strong> opens the exact file in Microsoft Word.
            {officeViewerUrl && (
              <> Or use <a href={officeViewerUrl} target="_blank" rel="noopener noreferrer" className="underline">Office Online</a> for pixel-perfect rendering.</>
            )}
          </p>
        )}
        {mode === 'docx-preview' && restricted && (
          <p className="mx-auto w-[794px] max-w-full px-2 pb-8 pt-3 text-center text-[11px] leading-snug text-amber-700">
            View only — download, copy, and print are disabled for this SOP.
          </p>
        )}
      </div>
    </div>
  );
}

function BackButton({ backHref, backLabel }: { backHref: string; backLabel: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        window.close();
        setTimeout(() => {
          if (!window.closed) {
            if (window.history.length > 1) window.history.back();
            else window.location.href = backHref;
          }
        }, 150);
      }}
      className="inline-flex items-center gap-2 text-sm font-semibold text-purple-600 hover:underline cursor-pointer bg-transparent border-0 p-0"
    >
      <ArrowLeft className="h-4 w-4" /> {backLabel}
    </button>
  );
}
