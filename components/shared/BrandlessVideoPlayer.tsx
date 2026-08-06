'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Pause, Play, Volume2, VolumeX } from 'lucide-react';

/* ─── Branding-free video player ──────────────────────────────────────────
   NotebookLM "Video Overview" MP4s carry a visible NotebookLM logo in the
   bottom-right corner (persists the whole video) and a "Made with Google"
   branding clip at the very end. This player is DISPLAY-ONLY: it masks the
   corner logo and clamps the timeline so the trailing END_TRIM_SECONDS (the
   end clip) can never be reached or scrubbed into.

   We do not modify or redistribute the source: the file on the CDN is
   unchanged, and the inaudible SynthID provenance watermark is untouched. We
   only style our own viewer. */

const END_TRIM_SECONDS = 3;

const LOGO_PATCH = { width: 0.26, height: 0.2 };

const INTRO_SECONDS = 2.5;
const INTRO_PATCH = { height: 0.28 };

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export type BrandlessVideoPlayerProps = {
  url: string;
  /** Resume playback at this timestamp (seconds). */
  startAt?: number;
  playbackRate?: number;
  /** Cap height when not fullscreen / not expanded. */
  maxHeight?: string;
  /** Fill the parent (e.g. expand-view overlay). */
  fillParent?: boolean;
  /** Hide the built-in fullscreen control when the parent provides Expand View. */
  hideFullscreenButton?: boolean;
  onProgress?: (percentage: number, timestamp: number) => void;
  /** Fired once when playback reaches the trimmed end. */
  onNearEnd?: () => void;
};

export function BrandlessVideoPlayer({
  url,
  startAt = 0,
  playbackRate = 1,
  maxHeight = '60vh',
  fillParent = false,
  hideFullscreenButton = false,
  onProgress,
  onNearEnd,
}: BrandlessVideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const nearEndFired = useRef(false);
  const lastReported = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [isFs, setIsFs] = useState(false);
  const [geom, setGeom] = useState<{
    right: number;
    bottom: number;
    cw: number;
    ch: number;
  } | null>(null);
  const [bgColor, setBgColor] = useState<string | null>(null);
  const [sampleOk, setSampleOk] = useState(true);

  const limit =
    duration > END_TRIM_SECONDS ? duration - END_TRIM_SECONDS : duration;

  useEffect(() => {
    nearEndFired.current = false;
    lastReported.current = 0;
  }, [url]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = playbackRate;
  }, [playbackRate, url]);

  const measure = useCallback(() => {
    const c = containerRef.current;
    const v = videoRef.current;
    if (!c || !v || !v.videoWidth || !v.videoHeight) return;
    const cr = c.getBoundingClientRect();
    const vr = v.getBoundingClientRect();
    const scale = Math.min(vr.width / v.videoWidth, vr.height / v.videoHeight);
    const cw = v.videoWidth * scale;
    const ch = v.videoHeight * scale;
    const contentLeft = vr.left - cr.left + (vr.width - cw) / 2;
    const contentTop = vr.top - cr.top + (vr.height - ch) / 2;
    setGeom({
      right: cr.width - (contentLeft + cw),
      bottom: cr.height - (contentTop + ch),
      cw,
      ch,
    });
  }, []);

  useEffect(() => {
    measure();
    const c = containerRef.current;
    const ro = new ResizeObserver(measure);
    if (c) ro.observe(c);
    const onFsChange = () => {
      setIsFs(Boolean(document.fullscreenElement));
      measure();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      document.removeEventListener('fullscreenchange', onFsChange);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  useEffect(() => {
    if (!sampleOk) return;
    const v = videoRef.current;
    if (!v) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    let raf = 0;
    let stopped = false;
    let lastT = 0;
    let sampledOnce = false;
    const tick = (t: number) => {
      if (stopped) return;
      raf = requestAnimationFrame(tick);
      if (document.hidden) return;
      if (v.paused && sampledOnce) return;
      if (t - lastT < 250 || !v.videoWidth || v.readyState < 2) return;
      lastT = t;
      const sw = 160;
      const sh = Math.max(1, Math.round((sw * v.videoHeight) / v.videoWidth));
      canvas.width = sw;
      canvas.height = sh;
      try {
        ctx.drawImage(v, 0, 0, sw, sh);
        const sx = Math.round(sw * (1 - LOGO_PATCH.width - 0.03));
        const sy = Math.round(sh * (1 - LOGO_PATCH.height));
        const sWid = Math.max(2, Math.round(sw * 0.025));
        const sHei = Math.max(2, Math.round(sh * LOGO_PATCH.height * 0.8));
        const { data } = ctx.getImageData(sx, sy, sWid, sHei);
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
        if (n) {
          sampledOnce = true;
          setBgColor(
            `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`,
          );
        }
      } catch {
        stopped = true;
        cancelAnimationFrame(raf);
        setSampleOk(false);
        setBgColor(null);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [sampleOk, url]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play();
    else v.pause();
  }, []);

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (limit > 0 && v.currentTime >= limit) {
      v.pause();
      v.currentTime = limit;
      setCurrent(limit);
      if (!nearEndFired.current) {
        nearEndFired.current = true;
        onNearEnd?.();
        onProgress?.(100, 0);
      }
      return;
    }
    setCurrent(v.currentTime);
    if (limit > 0 && onProgress) {
      const pct = Math.round((v.currentTime / limit) * 100);
      if (pct >= lastReported.current + 5) {
        lastReported.current = pct;
        onProgress(pct, Math.round(v.currentTime));
      }
    }
  }, [limit, onNearEnd, onProgress]);

  const onSeek = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = videoRef.current;
      if (!v) return;
      const t = Math.min(Number(e.target.value), limit);
      v.currentTime = t;
      setCurrent(t);
    },
    [limit],
  );

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const goFullscreen = useCallback(() => {
    void containerRef.current?.requestFullscreen?.();
  }, []);

  const tall = fillParent || isFs;

  return (
    <div
      ref={containerRef}
      className={`relative mx-auto flex w-full items-center justify-center overflow-hidden bg-black ${
        tall ? 'h-full min-h-0' : ''
      }`}
      style={tall ? undefined : { maxHeight }}
    >
      <video
        ref={videoRef}
        key={url}
        src={url}
        crossOrigin={sampleOk ? 'anonymous' : undefined}
        className="block w-full object-contain"
        style={{ maxHeight: tall ? '100%' : maxHeight, height: tall ? '100%' : undefined }}
        onClick={togglePlay}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={(e) => {
          setDuration(e.currentTarget.duration || 0);
          if (startAt > 0) {
            e.currentTarget.currentTime = Math.min(startAt, Math.max(0, (e.currentTarget.duration || 0) - END_TRIM_SECONDS - 0.5));
          }
          e.currentTarget.playbackRate = playbackRate;
          measure();
        }}
        onTimeUpdate={onTimeUpdate}
        onError={() => {
          if (sampleOk) {
            setSampleOk(false);
            setBgColor(null);
            const v = videoRef.current;
            if (v) {
              v.removeAttribute('crossorigin');
              v.load();
            }
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
        playsInline
      >
        Your browser does not support the video tag.
      </video>

      {geom && (
        <div
          className={`pointer-events-none absolute z-10 rounded-tl-md ${
            bgColor ? '' : 'backdrop-blur-2xl'
          }`}
          style={{
            right: geom.right,
            bottom: geom.bottom,
            width: geom.cw * LOGO_PATCH.width,
            height: geom.ch * LOGO_PATCH.height,
            background: bgColor ?? 'rgba(255,255,255,0.04)',
            transition: 'background-color 250ms linear',
          }}
          aria-hidden
        />
      )}

      {geom && current < INTRO_SECONDS && (
        <div
          className={`pointer-events-none absolute z-10 rounded-t-md ${
            bgColor ? '' : 'backdrop-blur-2xl'
          }`}
          style={{
            left: geom.right,
            right: geom.right,
            bottom: geom.bottom,
            height: geom.ch * INTRO_PATCH.height,
            background: bgColor ?? 'rgba(255,255,255,0.04)',
            transition: 'background-color 250ms linear',
          }}
          aria-hidden
        />
      )}

      <div className="absolute inset-x-0 bottom-0 z-20 flex items-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-3 pb-2 pt-6 text-white">
        <button
          type="button"
          onClick={togglePlay}
          className="rounded p-1 hover:bg-white/20"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <span className="w-10 shrink-0 text-[11px] tabular-nums">
          {fmtTime(current)}
        </span>
        <input
          type="range"
          min={0}
          max={limit || 0}
          step="0.1"
          value={Math.min(current, limit || 0)}
          onChange={onSeek}
          className="h-1 flex-1 cursor-pointer accent-emerald-400"
          aria-label="Seek"
        />
        <span className="w-10 shrink-0 text-[11px] tabular-nums">
          {fmtTime(limit)}
        </span>
        <button
          type="button"
          onClick={toggleMute}
          className="rounded p-1 hover:bg-white/20"
          aria-label={muted ? 'Unmute' : 'Mute'}
        >
          {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
        </button>
        {!hideFullscreenButton && (
          <button
            type="button"
            onClick={goFullscreen}
            className="rounded p-1 hover:bg-white/20"
            aria-label="Fullscreen"
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

/** Brief / Short → Short; Explainer / Long → Long. */
export function classifyLmsVideoKind(url: string): 'Short' | 'Long' | null {
  try {
    const path = decodeURIComponent(url.split('?')[0] || '').toLowerCase();
    if (/(^|[-_/.\s])(brief|short)([-_/.]|$)/.test(path)) return 'Short';
    if (/(^|[-_/.\s])(explainer|long)([-_/.]|$)/.test(path)) return 'Long';
  } catch {
    /* ignore */
  }
  return null;
}

/** Order Short before Long and assign display labels. */
export function orderLmsVideos(urls: string[]): { url: string; label: string }[] {
  const items = urls.map((url, index) => ({
    url,
    index,
    kind: classifyLmsVideoKind(url),
  }));
  items.sort((a, b) => {
    const ra = a.kind === 'Short' ? 0 : a.kind === 'Long' ? 1 : 2;
    const rb = b.kind === 'Short' ? 0 : b.kind === 'Long' ? 1 : 2;
    if (ra !== rb) return ra - rb;
    return a.index - b.index;
  });

  const longIndexes: number[] = [];
  return items.map((item, i) => {
    let label: string;
    if (item.kind === 'Short') label = 'Short';
    else if (item.kind === 'Long') {
      longIndexes.push(i);
      label = 'Long';
    } else if (items.length === 1) {
      label = 'Short';
    } else if (i === 0) {
      label = 'Short';
    } else {
      label = 'Long';
    }
    return { url: item.url, label };
  });
}
