'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { Loader2 } from 'lucide-react';
import { loadPdfJs } from '@/lib/guidelinePdfLoader';

/* ─── Branding-free slides viewer ─────────────────────────────────────────
   NotebookLM PPT/PDF decks put a logo on EVERY page (bottom-right), same as
   Video Overview MP4s. Native Chrome PDF / Office iframes only let us mask
   the viewport corner — scrolled pages keep the watermark.

   For PDFs we render each page with pdf.js and paint the same LOGO_PATCH used
   by BrandlessVideoPlayer onto every page canvas. Source files are unchanged. */

/** Match BrandlessVideoPlayer LOGO_PATCH — fraction of page box. */
const LOGO_PATCH = { width: 0.26, height: 0.2 };

type PdfDoc = import('pdfjs-dist').PDFDocumentProxy;

export type BrandlessSlidesViewerProps = {
  src: string;
  title?: string;
  /** pdf = pdf.js page render + per-page mask; office/iframe = embed + viewport mask. */
  mode?: 'pdf' | 'office' | 'iframe';
  className?: string;
  style?: CSSProperties;
};

function sampleCornerFill(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): string {
  try {
    const sx = Math.max(0, Math.round(width * (1 - LOGO_PATCH.width - 0.03)));
    const sy = Math.max(0, Math.round(height * (1 - LOGO_PATCH.height)));
    const sw = Math.max(2, Math.round(width * 0.03));
    const sh = Math.max(2, Math.round(height * LOGO_PATCH.height * 0.75));
    const { data } = ctx.getImageData(sx, sy, sw, sh);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n += 1;
    }
    if (!n) return '#ffffff';
    return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`;
  } catch {
    return '#ffffff';
  }
}

/** Paint NotebookLM corner logo out — same coverage as video previews. */
function maskNotebookLmCorner(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const fill = sampleCornerFill(ctx, width, height);
  const pw = Math.max(1, Math.round(width * LOGO_PATCH.width));
  const ph = Math.max(1, Math.round(height * LOGO_PATCH.height));
  ctx.fillStyle = fill;
  ctx.fillRect(width - pw, height - ph, pw, ph);
}

function BrandlessPdfPage({
  pdf,
  pageNum,
  width,
}: {
  pdf: PdfDoc;
  pageNum: number;
  width: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<import('pdfjs-dist').RenderTask | null>(null);

  useEffect(() => {
    if (!width) return;
    let cancelled = false;

    (async () => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      if (!wrap || !canvas) return;

      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;

      const pdfjs = await loadPdfJs();
      const page = await pdf.getPage(pageNum);
      if (cancelled) return;

      const baseVp = page.getViewport({ scale: 1 });
      const scale = width / baseVp.width;
      const viewport = page.getViewport({ scale });

      wrap.style.width = `${viewport.width}px`;
      wrap.style.height = `${viewport.height}px`;

      const outputScale = new pdfjs.OutputScale();
      canvas.width = Math.floor(viewport.width * outputScale.sx);
      canvas.height = Math.floor(viewport.height * outputScale.sy);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;

      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const transform =
        outputScale.sx !== 1 || outputScale.sy !== 1
          ? [outputScale.sx, 0, 0, outputScale.sy, 0, 0]
          : undefined;

      const task = page.render({ canvasContext: ctx, viewport, transform, canvas });
      renderTaskRef.current = task;

      try {
        await task.promise;
        if (cancelled) return;
        // Mask after paint so every scrolled page is clean (not just viewport).
        maskNotebookLmCorner(ctx, canvas.width, canvas.height);
      } catch {
        /* cancelled or render error */
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [pdf, pageNum, width]);

  return (
    <div
      ref={wrapRef}
      className="relative mx-auto overflow-hidden bg-white shadow-sm"
      style={{ maxWidth: '100%' }}
    >
      <canvas ref={canvasRef} className="block max-w-full" />
    </div>
  );
}

function BrandlessPdfDocument({ src, title }: { src: string; title: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PdfDoc | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth - 16);
      if (w > 0) setWidth(w);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let doc: PdfDoc | null = null;
    setLoading(true);
    setError('');
    setPdf(null);
    setPageCount(0);

    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        const res = await fetch(src, { credentials: 'same-origin', cache: 'no-store' });
        if (!res.ok) throw new Error('Could not load slides PDF');
        const data = await res.arrayBuffer();
        if (cancelled) return;
        doc = await pdfjs.getDocument({ data: data.slice(0) }).promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPdf(doc);
        setPageCount(doc.numPages);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to open slides');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (doc) void doc.destroy();
    };
  }, [src]);

  return (
    <div
      ref={scrollRef}
      className="h-full w-full overflow-auto bg-stone-200/80"
      title={title}
      onContextMenu={(e) => e.preventDefault()}
    >
      {loading && (
        <div className="flex min-h-[55vh] items-center justify-center">
          <Loader2 className="h-7 w-7 animate-spin text-purple-500" />
        </div>
      )}
      {error && (
        <div className="flex min-h-[55vh] items-center justify-center px-4">
          <p className="text-center text-sm text-red-600">{error}</p>
        </div>
      )}
      {pdf && width > 0 && !loading && !error && (
        <div className="flex flex-col items-center gap-3 p-2 sm:p-3">
          {Array.from({ length: pageCount }, (_, i) => (
            <BrandlessPdfPage key={`${src}-${i + 1}`} pdf={pdf} pageNum={i + 1} width={width} />
          ))}
        </div>
      )}
    </div>
  );
}

export function BrandlessSlidesViewer({
  src,
  title = 'Slides',
  mode = 'iframe',
  className = '',
  style,
}: BrandlessSlidesViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [geom, setGeom] = useState<{
    right: number;
    bottom: number;
    cw: number;
    ch: number;
  } | null>(null);

  const measure = useCallback(() => {
    const c = containerRef.current;
    if (!c) return;
    const cr = c.getBoundingClientRect();
    setGeom({ right: 0, bottom: 0, cw: cr.width, ch: cr.height });
  }, []);

  useEffect(() => {
    if (mode === 'pdf') return;
    measure();
    const c = containerRef.current;
    if (!c) return;
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, src, mode]);

  // PDF path: per-page canvas mask (works for every page while scrolling).
  if (mode === 'pdf') {
    return (
      <div
        className={`relative h-full w-full overflow-hidden bg-stone-200 ${className}`}
        style={style}
      >
        <BrandlessPdfDocument src={src} title={title} />
      </div>
    );
  }

  // Office / generic iframe — viewport mask only (embed is cross-origin).
  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden bg-white ${className}`}
      style={style}
    >
      <iframe src={src} className="h-full w-full border-0" title={title} allowFullScreen />
      {mode === 'office' && (
        <div className="pointer-events-auto absolute inset-x-0 top-0 z-20 h-12 bg-white" aria-hidden />
      )}
      {geom && geom.cw > 0 && geom.ch > 0 && (
        <div
          className="pointer-events-none absolute z-20 rounded-tl-md bg-white"
          style={{
            right: geom.right,
            bottom: geom.bottom,
            width: Math.max(96, geom.cw * LOGO_PATCH.width),
            height: Math.max(40, geom.ch * LOGO_PATCH.height),
          }}
          aria-hidden
        />
      )}
    </div>
  );
}
