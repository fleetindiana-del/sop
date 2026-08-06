"use client";

import {
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Calendar,
  ChevronDown,
  ChevronRight,
  Download,
  Edit2,
  FileText,
  Loader2,
  Presentation,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Users,
  Video,
  X,
} from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import { PasswordConfirmDialog } from "./PasswordConfirmDialog";
import { EditSOPModal } from "./EditSOPModal";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { RegistrySOP } from "@/lib/types";
import {
  buildOfficeOnlineEmbedUrl,
  buildPreviewHref,
  isOfficePreviewAvailable,
} from "@/lib/file-urls";
import { docxRequiredForLang, formatUploaded, pdfRequiredForLang } from "@/lib/sop-utils";
import { annexureRomanFromLabel } from "@/lib/sop-annexure-requirements";
import { displaySopCode, displaySopTitle } from "@/lib/sop-display";
import { describeFilters } from "@/lib/filter-breadcrumb";
import { useDashboardStore } from "@/lib/store/dashboard-store";
import { Btn } from "./ui";
import { DocPreviewModal } from "@/components/shared/DocPreviewModal";
import { BrandlessVideoPlayer } from "@/components/shared/BrandlessVideoPlayer";

/* ─── SOP display helpers (shared with the MCQ Bank Registry) ─────────── */
/* displaySopCode / displaySopTitle live in @/lib/sop-display so both the SOP
   Registry and the MCQ Bank Registry render SOP No. / SOP Name identically. */

const registryTdBase = "px-1 py-1 align-middle overflow-hidden max-w-0";
const registrySopNoTd = "px-1 py-1 align-middle whitespace-nowrap";

/* ─── Media (video / slide) preview modal ────────────────────────────── */
function isVideoUrl(url: string): boolean {
  const lower = url.toLowerCase().split("?")[0];
  return /\.(mp4|webm|mov|ogg|ogv|avi|mkv)$/.test(lower);
}

function isSlideUrl(url: string): boolean {
  const lower = url.toLowerCase().split("?")[0];
  return /\.(pptx?|key)$/.test(lower);
}

function mediaSummary(url: string, index: number): string {
  try {
    const decoded = decodeURIComponent(url.split("?")[0]);
    const seg = decoded.split("/").filter(Boolean).pop() ?? "";
    const name = seg.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
    if (name.length > 30) return name.slice(0, 30) + "…";
    return name || `Item ${index + 1}`;
  } catch {
    return `Item ${index + 1}`;
  }
}

// Infer display language from URL path/filename when the URL itself carries an
// explicit language marker. This corrects labels for videos that were stored
// under the wrong language key before the upload regex was fixed (e.g. a
// _GUJ-Brief.mp4 that landed in videos.en shows "GUJ" not "ENG").
function langLabelFromUrl(url: string, fallback: string): string {
  try {
    const path = decodeURIComponent(url.split("?")[0]).toLowerCase();
    if (/(^|[-_/])(?:guj|gujarati)(?:[-_./]|$)/.test(path)) return "GUJ";
    if (/(^|[-_/])(?:eng|english)(?:[-_./]|$)/.test(path)) return "ENG";
  } catch { /* ignore */ }
  return fallback;
}

function MediaPreviewModal({
  url,
  label,
  onClose,
}: {
  url: string;
  label: string;
  onClose: () => void;
}) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const officeEmbedSrc = isSlideUrl(url) ? buildOfficeOnlineEmbedUrl(url, origin) : null;
  const officeAvailable = isSlideUrl(url) && isOfficePreviewAvailable(url, origin);
  const [iframeLoading, setIframeLoading] = useState(true);

  // Drag-to-move the modal: grab the header and the panel follows the pointer
  // (free reposition, no placeholder, no blur). Pointer events + pointer capture
  // give one code path for mouse/touch/pen across browsers and keep the drag
  // smooth even when the pointer passes over the preview iframe or the page
  // behind (the iframe would otherwise swallow window-level move events).
  const modalRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{
    startX: number; startY: number; baseX: number; baseY: number;
    naturalLeft: number; naturalTop: number; width: number; height: number;
  } | null>(null);

  // Clamp a translate offset so the panel stays fully inside the viewport.
  // `natural*` is the panel's position when offset is 0 (it's centred via flex).
  const clampAxis = (value: number, natural: number, size: number, viewport: number) => {
    const min = -natural;
    const max = viewport - natural - size;
    if (max < min) return min; // panel larger than viewport: pin to top/left edge
    return Math.min(Math.max(value, min), max);
  };

  const handleHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Let the download link / close button work normally.
    if ((e.target as HTMLElement).closest("button, a, input")) return;
    const el = modalRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: pos.x, baseY: pos.y,
      naturalLeft: rect.left - pos.x,
      naturalTop: rect.top - pos.y,
      width: rect.width, height: rect.height,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const handleHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const nextX = clampAxis(d.baseX + (e.clientX - d.startX), d.naturalLeft, d.width, window.innerWidth);
    const nextY = clampAxis(d.baseY + (e.clientY - d.startY), d.naturalTop, d.height, window.innerHeight);
    setPos({ x: nextX, y: nextY });
  };
  const handleHeaderPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  // Keep the panel on-screen if the window is resized after it was moved.
  useEffect(() => {
    const onResize = () =>
      setPos((p) => {
        const el = modalRef.current;
        if (!el) return p;
        const rect = el.getBoundingClientRect();
        const naturalLeft = rect.left - p.x;
        const naturalTop = rect.top - p.y;
        return {
          x: clampAxis(p.x, naturalLeft, rect.width, window.innerWidth),
          y: clampAxis(p.y, naturalTop, rect.height, window.innerHeight),
        };
      });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const modal = (
    // No dimming/click-catching backdrop: the layer ignores pointer events
    // (pointer-events-none) so the page behind stays visible and interactive
    // while the preview is open. Close via the X button or Escape.
    <div className="pointer-events-none fixed inset-0 z-200 flex items-center justify-center p-4">
      <div
        ref={modalRef}
        className="pointer-events-auto flex w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
        style={{
          height: isVideoUrl(url) ? "auto" : "min(90vh, 900px)",
          transform: `translate(${pos.x}px, ${pos.y}px)`,
        }}
      >
        {/* Header (drag handle) */}
        <div
          className="flex shrink-0 cursor-grab touch-none select-none items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-2.5 active:cursor-grabbing"
          onPointerDown={handleHeaderPointerDown}
          onPointerMove={handleHeaderPointerMove}
          onPointerUp={handleHeaderPointerUp}
          onPointerCancel={handleHeaderPointerUp}
        >
          <div className="flex items-center gap-2 min-w-0">
            {isVideoUrl(url)
              ? <Video className="h-4 w-4 shrink-0 text-emerald-600" />
              : <Presentation className="h-4 w-4 shrink-0 text-indigo-600" />}
            <span className="truncate text-sm font-semibold text-gray-800">{label}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={url}
              download
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-50"
              onClick={(e) => e.stopPropagation()}
            >
              <Download className="h-3 w-3" />
              Download
            </a>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-gray-500 hover:bg-gray-100"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="relative min-h-0 flex-1 bg-black/5">
          {isVideoUrl(url) ? (
            <BrandlessVideoPlayer url={url} />
          ) : isSlideUrl(url) && !officeAvailable ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center text-sm text-gray-600">
              <Presentation className="h-10 w-10 text-gray-300" />
              <p>Office Online preview requires a public URL.</p>
              <p className="text-xs text-gray-500">On localhost, download the file to view it.</p>
              <a
                href={url}
                download
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                <Download className="h-3.5 w-3.5" />
                Download file
              </a>
            </div>
          ) : isSlideUrl(url) ? (
            <div className="relative h-full">
              {iframeLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-white text-sm text-gray-500">
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Loading preview…
                </div>
              )}
              <iframe
                src={officeEmbedSrc!}
                className="absolute inset-0 h-full w-full border-0"
                title={`Slide preview: ${label}`}
                allowFullScreen
                onLoad={() => setIframeLoading(false)}
              />
            </div>
          ) : (
            /* Generic: open in new iframe (PDF-like CDN file) */
            <div className="relative h-full">
              {iframeLoading && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-white text-sm text-gray-500">
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  Loading…
                </div>
              )}
              <iframe
                src={url}
                className="absolute inset-0 h-full w-full border-0"
                title={label}
                allowFullScreen
                onLoad={() => setIframeLoading(false)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

/* ─── Clickable pill for one media item ─────────────────────────────── */
function MediaPill({
  url,
  langLabel,
  index,
  kind,
}: {
  url: string;
  langLabel: string;
  index: number;
  kind: "video" | "slide";
}) {
  const [open, setOpen] = useState(false);
  const summary = mediaSummary(url, index);
  const isVideo = kind === "video";
  const urlLower = url.toLowerCase();
  const videoTypeLabel = urlLower.includes("explainer") ? "EX" : urlLower.includes("brief") ? "BR" : null;
  const effectiveLangLabel = langLabelFromUrl(url, langLabel);
  const displayLabel = isVideo ? (videoTypeLabel ?? `${effectiveLangLabel}·${index + 1}`) : effectiveLangLabel;

  const pillCls = isVideo
    ? "inline-flex items-center gap-0.5 rounded border border-emerald-200 bg-emerald-50 px-1 py-px text-[8px] font-semibold text-emerald-700 hover:bg-emerald-100 cursor-pointer transition-colors max-w-full"
    : "inline-flex items-center gap-0.5 rounded border border-indigo-200 bg-indigo-50 px-1 py-px text-[8px] font-semibold text-indigo-700 hover:bg-indigo-100 cursor-pointer transition-colors max-w-full";

  const label = `${effectiveLangLabel} — ${summary}`;

  return (
    <>
      <button
        type="button"
        className={pillCls}
        title={`Preview: ${label}`}
        onClick={(e) => { e.stopPropagation(); setOpen(true); }}
      >
        {isVideo
          ? <Video className="h-2 w-2 shrink-0" aria-hidden />
          : <Presentation className="h-2 w-2 shrink-0" aria-hidden />}
        <span className="truncate max-w-15">{displayLabel}</span>
      </button>
      {open && (
        <MediaPreviewModal
          url={url}
          label={label}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/* ─── Document preview modal ─────────────────────────────────────────── */

interface SOPRegistryTableProps {
  items: RegistrySOP[];
  total: number;
  loading: boolean;
  departments: string[];
  onSort: (field: string) => void;
  onRefresh: () => void;
  onObsolete: (sop: RegistrySOP) => Promise<void>;
  onRevive: (sop: RegistrySOP) => Promise<void>;
  onPermanentDelete: (sop: RegistrySOP, password: string) => Promise<void>;
  onExportExcel: () => void;
  canMutate: boolean;
}

export function SOPRegistryTable({
  items,
  total,
  loading,
  departments,
  onSort,
  onRefresh,
  onObsolete,
  onRevive,
  onPermanentDelete,
  onExportExcel,
  canMutate,
}: SOPRegistryTableProps) {
  const { filters, setFilter, resetFilters, expandedRows, toggleRow, toggleFilterSidebar, showToast } =
    useDashboardStore();
  const [editIdentifier, setEditIdentifier] = useState<string | null>(null);
  const [obsoleteTarget, setObsoleteTarget] = useState<RegistrySOP | null>(null);
  const [obsoleting, setObsoleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RegistrySOP | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const breadcrumb = useMemo(() => describeFilters(filters), [filters]);

  const handleEditClose = useCallback(() => setEditIdentifier(null), []);

  const SortIcon = ({ field }: { field: string }) => {
    if (filters.sortBy !== field)
      return <ArrowUpDown className="h-3 w-3 text-gray-400 ml-0.5 inline opacity-60" />;
    return filters.sortDir === "asc"
      ? <ArrowUp className="h-3 w-3 text-purple-600 ml-0.5 inline" />
      : <ArrowDown className="h-3 w-3 text-purple-600 ml-0.5 inline" />;
  };

  const thBase = "bg-gray-100 px-1 py-0.5 align-top text-[9px] font-bold text-gray-600 uppercase tracking-wide whitespace-normal wrap-break-word overflow-hidden";
  const selBase = "w-full min-w-0 text-[8px] p-px border border-gray-300 rounded bg-white focus:outline-none focus:border-purple-500 cursor-pointer leading-tight";
  const sortBtn = "flex w-full min-w-0 items-center gap-0.5 rounded px-0.5 py-1 text-left font-bold uppercase tracking-wide text-gray-600 hover:bg-purple-50/80 hover:text-purple-700 focus:outline-none focus:ring-2 focus:ring-purple-400";

  /* Unique language options for filter dropdown */
  const uniqueLanguages = useMemo(() => {
    const langs = new Set(items.map((s) => s.language));
    return Array.from(langs).sort();
  }, [items]);

  // True when the table is showing the Obsolete SOPs view; there we offer Revive
  // (move back to active) instead of the Obsolete action.
  const isObsoleteView = Boolean(filters.obsoleteOnly);
  // True when showing the Prior Version Archive: a read-only historical listing of
  // superseded revisions. Rows show their archived versions and hide mutate actions.
  const isArchiveView = Boolean(filters.archiveView);

  const handleRevive = useCallback(
    async (sop: RegistrySOP) => {
      try {
        await onRevive(sop);
        showToast(`${displaySopCode(sop.identifier)} restored to the SOP Registry`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Failed to revive SOP");
      }
    },
    [onRevive, showToast],
  );

  const handleObsoleteConfirm = async () => {
    if (!obsoleteTarget) return;
    const target = obsoleteTarget;
    // The move is applied optimistically by the parent, so close the dialog at
    // once — the SOP leaves the active list and the counts update on this click.
    setObsoleteTarget(null);
    setObsoleting(true);
    try {
      await onObsolete(target);
      showToast(`${displaySopCode(target.identifier)} moved to Obsolete SOPs`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to move SOP to Obsolete");
    } finally {
      setObsoleting(false);
    }
  };

  const handleDeleteConfirm = async (password: string) => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onPermanentDelete(target, password);
      // Only close on success; a wrong password keeps the dialog open so the
      // user can retry without losing their place.
      setDeleteTarget(null);
      showToast(`${displaySopCode(target.identifier)} permanently deleted`);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Failed to delete SOP");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="mx-auto w-full max-w-full overflow-hidden px-1 pb-2 sm:px-2">
      <EditSOPModal
        open={editIdentifier !== null}
        identifier={editIdentifier}
        departmentList={departments}
        onClose={handleEditClose}
        onSuccess={onRefresh}
      />
      <ConfirmDialog
        open={obsoleteTarget !== null}
        title="Move SOP to Obsolete"
        message={
          obsoleteTarget
            ? `Move SOP ${displaySopCode(obsoleteTarget.identifier)} to Obsolete SOPs? All files, versions, history, and metadata will be preserved. The SOP will be removed from active listings.`
            : ""
        }
        confirmLabel="Move to Obsolete"
        loading={obsoleting}
        onConfirm={handleObsoleteConfirm}
        onCancel={() => setObsoleteTarget(null)}
      />
      <PasswordConfirmDialog
        open={deleteTarget !== null}
        title="Permanently delete SOP"
        message={
          deleteTarget
            ? `Permanently delete SOP ${displaySopCode(deleteTarget.identifier)}? This removes all versions, languages, history, and metadata from the registry and cannot be undone.`
            : ""
        }
        confirmLabel="Delete permanently"
        loading={deleting}
        error={deleteError}
        onConfirm={handleDeleteConfirm}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
      />
      <div className="flex flex-col w-full bg-gray-50">

        {/* Toolbar row */}
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-300 bg-gray-100 px-3 py-2">
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-700">
            {isArchiveView ? "Prior Version Archive" : isObsoleteView ? "Obsolete SOPs" : "SOP Registry"}
          </h2>
          <div className="flex flex-wrap items-center gap-1.5">
            <Btn size="xs" onClick={resetFilters}>Reset</Btn>
            <Btn
              size="xs"
              onClick={onExportExcel}
              disabled={total === 0}
              title={`Export the ${total} displayed record${total === 1 ? "" : "s"} (${breadcrumb.label}) to Excel`}
            >
              <Download className="h-3 w-3" />
              Export to Excel{total > 0 ? ` (${total})` : ""}
            </Btn>
            <select
              className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[10px] focus:outline-none focus:border-purple-500"
              value={filters.searchField ?? "All"}
              onChange={(e) => setFilter({ searchField: e.target.value })}
            >
              {["All fields", "SOP No", "Name", "Department", "Location"].map((f) => (
                <option key={f} value={f === "All fields" ? "All" : f}>{f}</option>
              ))}
            </select>
            <div className="relative">
              <input
                type="search"
                placeholder="Search SOPs..."
                className="w-44 rounded border border-gray-300 py-0.5 pl-2 pr-6 text-[10px] focus:border-purple-500 focus:outline-none"
                value={filters.search ?? ""}
                onChange={(e) => setFilter({ search: e.target.value })}
              />
            </div>
            <Btn size="xs" onClick={toggleFilterSidebar}>
              <SlidersHorizontal className="h-3 w-3" />
            </Btn>
          </div>
          <span className="ml-auto rounded bg-purple-50 px-2 py-0.5 text-[10px] font-semibold text-purple-800">
            {total} results
          </span>
        </div>

        {/* Breadcrumb — shows which capsule/card was clicked and the dataset on view */}
        <div
          className="flex flex-wrap items-center gap-1.5 border-b border-gray-200 bg-white px-3 py-1.5 text-[11px]"
          aria-label="Current results context"
        >
          <span className="font-semibold text-purple-700">{breadcrumb.department}</span>
          <ChevronRight className="h-3 w-3 shrink-0 text-gray-400" aria-hidden />
          {breadcrumb.segments.length > 0 ? (
            breadcrumb.segments.map((seg, i) => (
              <Fragment key={seg}>
                {i > 0 && <span className="text-gray-300" aria-hidden>·</span>}
                <span className="rounded bg-gray-100 px-1.5 py-0.5 font-medium text-gray-700">{seg}</span>
              </Fragment>
            ))
          ) : (
            <span className="font-medium text-gray-600">All SOPs</span>
          )}
          <span className="text-gray-500">Results</span>
        </div>

        {/* Table — vertical scroll only; columns share viewport width */}
        <div
          className="w-full max-w-full overflow-x-hidden overflow-y-auto overscroll-y-contain max-h-[calc(100vh-180px)]"
        >
          <table className="w-full table-fixed border-collapse text-left">
            <colgroup>
              <col style={{ width: "1.5%" }} />
              <col style={{ width: "2%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "2.5%" }} />
              <col style={{ width: canMutate ? "12%" : "14%" }} />
              <col style={{ width: "3.5%" }} />
              <col style={{ width: "4.5%" }} />
              <col style={{ width: canMutate ? "19%" : "20%" }} />
              <col style={{ width: "3.5%" }} />
              <col style={{ width: "3.5%" }} />
              <col style={{ width: "7.5%" }} />
              <col style={{ width: "5%" }} />
              <col style={{ width: "6.5%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "6.5%" }} />
              {canMutate && <col style={{ width: "3.5%" }} />}
            </colgroup>
            <thead className="bg-gray-100 border-b border-gray-300">
              <tr className="sticky top-0 z-20 bg-gray-100">
                <th className={`${thBase} text-center`} />
                <th className={`${thBase} text-center`} title="Serial number">SR</th>
                <th className={thBase}>
                  <button type="button" className={sortBtn} onClick={() => onSort("identifier")}>
                    SOP No <SortIcon field="identifier" />
                  </button>
                </th>
                <th className={`${thBase} text-center`}>
                  <button type="button" className={sortBtn} onClick={() => onSort("version")}>
                    Ver <SortIcon field="version" />
                  </button>
                </th>
                <th className={thBase}>
                  <button type="button" className={sortBtn} onClick={() => onSort("name")}>
                    SOP Name <SortIcon field="name" />
                  </button>
                </th>
                <th className={thBase}>
                  <div className="flex flex-col items-center gap-0.5">
                    <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest leading-none">Guideline</span>
                    <button type="button" className={`${sortBtn} justify-center py-0.5`} onClick={() => onSort("guidelineReference")} title="Guideline reference">
                      <Sparkles className="h-3 w-3 text-orange-500 shrink-0" />
                      <SortIcon field="guidelineReference" />
                    </button>
                  </div>
                </th>
                <th className={thBase}>
                  <button type="button" className={sortBtn} onClick={() => onSort("location")}>
                    Location <SortIcon field="location" />
                  </button>
                </th>
                <th className={`${thBase} text-center`} title={isArchiveView ? "Archived (superseded) revisions per language" : "Prior revisions (DOCX/PDF) per language"}>
                  <button type="button" className={sortBtn} onClick={() => onSort("priorVersions")}>
                    {isArchiveView ? "Archived Versions" : "Prior Versions"} <SortIcon field="priorVersions" />
                  </button>
                </th>
                <th className={`${thBase} text-center`}>
                  <div className="flex flex-col items-center gap-px min-w-0">
                    <button type="button" className={`${sortBtn} justify-center`} onClick={() => onSort("department")}>
                      Dept <SortIcon field="department" />
                    </button>
                    <select
                      className={selBase}
                      value={filters.department ?? ""}
                      onChange={(e) => setFilter({ department: e.target.value || undefined })}
                    >
                      <option value="">All</option>
                      {departments.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                </th>
                <th className={thBase}>
                  <div className="flex flex-col gap-px">
                    <button type="button" className={sortBtn} onClick={() => onSort("language")}>
                      Lang <SortIcon field="language" />
                    </button>
                    <select
                      className={selBase}
                      value={filters.language ?? ""}
                      onChange={(e) => setFilter({ language: e.target.value || undefined })}
                    >
                      <option value="">All</option>
                      {uniqueLanguages.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                </th>
                <th className={thBase} title="Current approved files: English first, then Gujarati when dual">
                  <div className="flex flex-col gap-px">
                    <button type="button" className={sortBtn} onClick={() => onSort("fileType")}>
                      Files <SortIcon field="fileType" />
                    </button>
                    <select
                      className={selBase}
                      value={filters.fileType ?? ""}
                      onChange={(e) => setFilter({ fileType: e.target.value || undefined })}
                    >
                      <option value="">All</option>
                      <option value="DOCX">DOCX</option>
                      <option value="No DOCX">No DOCX</option>
                      <option value="PDF">PDF</option>
                      <option value="No PDF">No PDF</option>
                    </select>
                  </div>
                </th>
                <th className={thBase} title="Required annexures from SOP (green = present, red = missing)">
                  Annexure
                </th>
                <th className={thBase}>
                  <div className="flex flex-col gap-px">
                    <button type="button" className={sortBtn} onClick={() => onSort("videos")} title="Training videos">
                      Video <SortIcon field="videos" />
                    </button>
                    <select
                      className={selBase}
                      value={filters.media?.startsWith("Video") || filters.media?.startsWith("No Video") ? (filters.media ?? "") : ""}
                      onChange={(e) => setFilter({ media: e.target.value || undefined })}
                    >
                      <option value="">All</option>
                      <option value="Video">Has Video</option>
                      <option value="No Video">No Video</option>
                    </select>
                  </div>
                </th>
                <th className={thBase}>
                  <div className="flex flex-col gap-px">
                    <button type="button" className={sortBtn} onClick={() => onSort("slides")} title="Slide decks">
                      Slides <SortIcon field="slides" />
                    </button>
                    <select
                      className={selBase}
                      value={filters.media?.startsWith("Slides") || filters.media?.startsWith("No Slides") ? (filters.media ?? "") : ""}
                      onChange={(e) => setFilter({ media: e.target.value || undefined })}
                    >
                      <option value="">All</option>
                      <option value="Slides">Has Slides</option>
                      <option value="No Slides">No Slides</option>
                    </select>
                  </div>
                </th>
                <th className={thBase}>
                  <button type="button" className={sortBtn} onClick={() => onSort("uploadedAt")} title="Upload date">
                    Uploaded <SortIcon field="uploadedAt" />
                  </button>
                </th>
                <th className={thBase}>
                  <div className="flex flex-col gap-px">
                    <button type="button" className={sortBtn} onClick={() => onSort("expiryDate")}>
                      Expiry <SortIcon field="expiryDate" />
                    </button>
                    <select
                      className={selBase}
                      value={filters.expiry ?? ""}
                      onChange={(e) => setFilter({ expiry: e.target.value || undefined })}
                    >
                      <option value="">All</option>
                      <option value="Expired">Expired</option>
                      <option value="Near">Near (&lt;90d)</option>
                      <option value="Medium">Medium</option>
                      <option value="Low">Low</option>
                      <option value="No Date">No Date</option>
                    </select>
                  </div>
                </th>
                {canMutate && <th className={thBase}>Actions</th>}
              </tr>
            </thead>
            <tbody className="text-[10px] text-gray-700">
              {loading ? (
                <tr>
                  <td colSpan={canMutate ? 17 : 16} className="py-12 text-center text-slate-400">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={canMutate ? 17 : 16} className="py-12 text-center text-gray-500">
                    <div className="flex flex-col items-center gap-1">
                      <FileText className="h-5 w-5 text-gray-300" />
                      <p className="text-xs">
                        {isArchiveView
                          ? "No archived versions — SOPs need more than two prior revisions before older ones are archived."
                          : "No SOPs found"}
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                items.map((sop, idx) => (
                  <SOPRow
                    key={sop.id}
                    sop={sop}
                    index={(filters.page! - 1) * (filters.limit ?? 50) + idx + 1}
                    isEven={idx % 2 === 0}
                    expanded={expandedRows.has(sop.id)}
                    onToggle={() => toggleRow(sop.id)}
                    canMutate={canMutate}
                    isObsoleteView={isObsoleteView}
                    isArchiveView={isArchiveView}
                    onEdit={() => setEditIdentifier(sop.identifier)}
                    onObsolete={() => setObsoleteTarget(sop)}
                    onRevive={() => handleRevive(sop)}
                    onDelete={() => {
                      setDeleteError(null);
                      setDeleteTarget(sop);
                    }}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ─── Individual row ─────────────────────────────────────────────────── */
const SOPRow = memo(function SOPRow({
  sop,
  index,
  isEven,
  expanded,
  onToggle,
  canMutate,
  isObsoleteView,
  isArchiveView,
  onEdit,
  onObsolete,
  onRevive,
  onDelete,
}: {
  sop: RegistrySOP;
  index: number;
  isEven: boolean;
  expanded: boolean;
  onToggle: () => void;
  canMutate: boolean;
  isObsoleteView: boolean;
  isArchiveView: boolean;
  onEdit: () => void;
  onObsolete: () => void;
  onRevive: () => void;
  onDelete: () => void;
}) {
  const isDual = sop.language === "ENG-GUJ";

  /* Expiry badge */
  const expiryNode = (() => {
    if (!sop.expiryDate) {
      return <span className="inline-block rounded border border-gray-200 bg-gray-50 px-1 py-0.5 text-[8px] font-semibold text-gray-400">No Date</span>;
    }
    const diffDays = Math.floor((new Date(sop.expiryDate).getTime() - Date.now()) / 86400000);
    const absDays = Math.abs(diffDays);
    const months = Math.floor(absDays / 30);
    const remDays = absDays - months * 30;
    const monthWord = months === 1 ? "month" : "months";
    const breakdown = months > 0 && remDays > 0
      ? ` (${months} ${monthWord} ${remDays} days)`
      : months > 0 ? ` (${months} ${monthWord})` : "";

    let label: string;
    let colorClass: string;
    if (diffDays < 0) {
      label = `Expired · ${absDays} days ago${breakdown}`;
      colorClass = "text-red-700 bg-red-50 border-red-200";
    } else if (diffDays <= 30) {
      label = `${diffDays} days${breakdown}`;
      colorClass = "text-orange-700 bg-orange-50 border-orange-200";
    } else if (diffDays <= 90) {
      label = `${diffDays} days${breakdown}`;
      colorClass = "text-yellow-800 bg-yellow-50 border-yellow-200";
    } else {
      label = `${diffDays} days${breakdown}`;
      colorClass = "text-emerald-800 bg-emerald-50 border-emerald-200";
    }
    return (
      <span
        className={`inline-block w-full max-w-full rounded border px-1 py-0.5 text-[8px] font-semibold leading-snug line-clamp-2 ${colorClass}`}
        title={`Expiry: ${new Date(sop.expiryDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} — ${label}`}
      >
        {label}
      </span>
    );
  })();

  return (
    <Fragment>
      <tr
        onClick={onToggle}
        className={`hover:bg-purple-50/80 cursor-pointer transition-colors group border-b border-gray-100/80 ${
          expanded ? "bg-purple-50" : isEven ? "bg-white" : "bg-gray-50/60"
        }`}
      >
        {/* Expand toggle */}
        <td className={`${registryTdBase} text-center`}>
          {expanded
            ? <ChevronDown className="h-4 w-4 text-purple-600 mx-auto" />
            : <ChevronRight className="h-4 w-4 text-gray-400 mx-auto" />}
        </td>

        {/* SR */}
        <td className={`${registryTdBase} text-center text-[10px] font-bold text-gray-600 tabular-nums`}>
          {index}
          {sop.isNew && (
            <span className="ml-0.5 rounded bg-blue-100 px-0.5 py-px text-[8px] font-bold text-blue-700">N</span>
          )}
        </td>

        {/* SOP No */}
        <td className={`${registrySopNoTd} font-mono text-[13px] font-bold tracking-wider text-purple-700 group-hover:underline`}>
          {displaySopCode(sop.identifier)}
        </td>

        {/* Ver */}
        <td className={`${registryTdBase} text-center`}>
          <span className="text-[11px] font-bold text-gray-800 tabular-nums">{sop.version}</span>
        </td>

        {/* SOP Name */}
        <td className={`${registryTdBase} font-medium text-gray-800`}>
          <div className="flex min-w-0 flex-col gap-0 leading-tight">
            <span
              className="line-clamp-2 text-[12px] font-bold leading-tight text-gray-900 wrap-break-word"
              title={displaySopTitle(sop.name, sop.identifier)}
            >
              {displaySopTitle(sop.name, sop.identifier)}
            </span>
            {sop.nameGujarati && (
              <span
                className="line-clamp-2 text-[10px] font-bold leading-tight text-indigo-700 wrap-break-word"
                title={displaySopTitle(sop.nameGujarati, sop.identifier)}
              >
                {displaySopTitle(sop.nameGujarati, sop.identifier)}
              </span>
            )}
          </div>
        </td>

        {/* Guideline */}
        <td className={`${registryTdBase} text-center`}>
          <span className="inline-block max-w-full truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 tabular-nums">
            {sop.guidelineReference ?? <span className="text-gray-300">—</span>}
          </span>
        </td>

        {/* Location */}
        <td className={registryTdBase}>
          <span className="line-clamp-2 text-[10px] font-medium leading-snug text-gray-700 cursor-help" title={sop.location ?? undefined}>
            {sop.location ?? <span className="text-gray-400">—</span>}
          </span>
        </td>

        {/* Prior Versions (or archived revisions in the archive view) */}
        <td className={`${registryTdBase} overflow-hidden px-0.5`}>
          <div className="min-w-0 max-w-full overflow-hidden">
            <PriorVersionsCell sop={sop} archiveView={isArchiveView} />
          </div>
        </td>

        {/* Department */}
        <td className={`${registryTdBase} text-center text-gray-700`}>
          <span
            className="mx-auto block max-w-full truncate text-[9px] font-semibold leading-tight"
            title={sop.department}
          >
            {sop.department}
          </span>
        </td>

        {/* Lang */}
        <td className={`${registryTdBase} text-center`}>
          {isDual ? (
            <div className="inline-flex flex-col items-center gap-0 leading-none">
              <span className="text-[9px] font-bold text-gray-800">ENG</span>
              <span className="text-[9px] font-bold text-indigo-800">GUJ</span>
            </div>
          ) : (
            <span className="text-[9px] font-semibold text-gray-700">
              {sop.language === "GUJ" ? "GUJ" : "ENG"}
            </span>
          )}
        </td>

        {/* Files */}
        <td className={`${registryTdBase} text-center`}>
          <FilesCell sop={sop} />
        </td>

        {/* Annexure */}
        <td className={`${registryTdBase} text-center`}>
          <AnnexureCell sop={sop} />
        </td>

        {/* Video */}
        <td className={`${registryTdBase} text-left`}>
          <VideoCell sop={sop} isDual={isDual} />
        </td>

        {/* Slides */}
        <td className={`${registryTdBase} text-left`}>
          <SlidesCell sop={sop} isDual={isDual} />
        </td>

        {/* Uploaded */}
        <td className={`${registryTdBase} text-[9px] leading-tight text-gray-600`}>
          {(() => {
            const full = formatUploaded(sop.uploadedAt);
            const spaceIdx = full.lastIndexOf(" ");
            const datePart = spaceIdx > 0 ? full.slice(0, spaceIdx) : full;
            const timePart = spaceIdx > 0 ? full.slice(spaceIdx + 1) : null;
            return (
              <div className="flex flex-col leading-snug" title={full}>
                <span>{datePart}</span>
                {timePart && <span className="text-gray-400">{timePart}</span>}
              </div>
            );
          })()}
        </td>

        {/* Expiry */}
        <td className={registryTdBase}>{expiryNode}</td>

        {/* Actions */}
        {canMutate && (
          <td className={registryTdBase}>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className="rounded p-0.5 hover:bg-slate-100"
                title="Edit SOP"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
              >
                <Edit2 className="h-3 w-3 text-slate-500" />
              </button>
              {/* Archive view is read-only history — only Edit is offered there. */}
              {!isArchiveView && (
                <>
                  {isObsoleteView ? (
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-emerald-50"
                      title="Revive — move back to SOP Registry"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRevive();
                      }}
                    >
                      <RotateCcw className="h-3 w-3 text-emerald-600" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="rounded p-0.5 hover:bg-amber-50"
                      title="Move to Obsolete"
                      onClick={(e) => {
                        e.stopPropagation();
                        onObsolete();
                      }}
                    >
                      <Archive className="h-3 w-3 text-amber-600" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded p-0.5 hover:bg-red-50"
                    title="Delete permanently"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                    }}
                  >
                    <Trash2 className="h-3 w-3 text-red-500" />
                  </button>
                </>
              )}
            </div>
          </td>
        )}
      </tr>

      {/* Expanded detail row */}
      {expanded && (
        <tr className="bg-gray-50 border-b border-gray-200">
          <td colSpan={canMutate ? 17 : 16} className="px-4 py-3">
            <SOPDetailPanel
              sop={sop}
              expiryNode={expiryNode}
              canMutate={canMutate}
              isObsoleteView={isObsoleteView}
              isArchiveView={isArchiveView}
              onEdit={onEdit}
              onObsolete={onObsolete}
              onRevive={onRevive}
              onDelete={onDelete}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
});

/* ─── Expanded row detail panel ──────────────────────────────────────── */
function DetailRow({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="shrink-0 font-semibold text-gray-600">{label}</span>
      <span className="truncate text-right font-bold text-gray-800" title={title}>{value}</span>
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="border-b border-gray-300 pb-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-700">
      {children}
    </h4>
  );
}

function SOPDetailPanel({
  sop,
  expiryNode,
  canMutate,
  isObsoleteView,
  isArchiveView,
  onEdit,
  onObsolete,
  onRevive,
  onDelete,
}: {
  sop: RegistrySOP;
  expiryNode: React.ReactNode;
  canMutate: boolean;
  isObsoleteView: boolean;
  isArchiveView: boolean;
  onEdit: () => void;
  onObsolete: () => void;
  onRevive: () => void;
  onDelete: () => void;
}) {
  const languageLabel =
    sop.language === "ENG-GUJ" ? "English & Gujarati" : sop.language === "GUJ" ? "Gujarati" : "English";
  const videoCount = sop.media.videos.en + sop.media.videos.gu;
  const slideCount = sop.media.slides.en + sop.media.slides.gu;
  const effective = sop.effectiveDate
    ? new Date(sop.effectiveDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    : null;

  const fileGroups = [
    {
      lang: "ENG",
      docx: sop.files.docx.en,
      pdf: sop.files.pdf.en,
      docxDateError: sop.files.docxDateError?.en,
    },
    {
      lang: "GUJ",
      docx: sop.files.docx.gu,
      pdf: sop.files.pdf.gu,
      docxDateError: sop.files.docxDateError?.gu,
    },
  ].filter((g) => g.docx || g.pdf);

  // In the archive view the panel shows the superseded (archived) revisions instead of
  // the two kept prior versions.
  const revisionList = isArchiveView ? sop.archivedVersions : sop.priorVersions;
  const engPrior = revisionList.filter((pv) => pv.language === "ENG");
  const gujPrior = revisionList.filter((pv) => pv.language === "GUJ");

  const renderPriorGroup = (label: string, pvs: typeof sop.priorVersions) =>
    pvs.length === 0 ? null : (
      <div className="flex items-start gap-1.5">
        <span className="w-12 shrink-0 text-[8px] font-bold uppercase text-gray-400">{label}</span>
        <div className="flex flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          {pvs.map((pv) =>
            pv.missing ? (
              <span key={`${pv.version}-${pv.language}`} className="text-[8px] font-semibold italic text-amber-600" title={`Version ${pv.version} was never uploaded`}>
                <span className="font-bold not-italic text-gray-400 line-through">V{pv.version}</span> not found
              </span>
            ) : (
              <span key={`${pv.version}-${pv.language}`} className="flex items-center gap-0.5 text-[8px] font-bold">
                <span className={pv.docxDateError ? "text-red-700" : "text-green-700"}>V{pv.version}</span>
                {pv.docx ? (
                  <FileLink filePath={pv.docx} label="DOCX" hasError={pv.docxDateError} />
                ) : (
                  <span className="text-orange-600">DOCX</span>
                )}
                <span className="select-none text-gray-300">/</span>
                {pv.pdf ? <FileLink filePath={pv.pdf} label="PDF" isPdf /> : <span className="text-red-500">PDF</span>}
              </span>
            ),
          )}
        </div>
      </div>
    );

  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-3">
      {/* Basic Information */}
      <div className="space-y-2">
        <SectionHeading>Basic Information</SectionHeading>
        <div className="space-y-1 text-[10px]">
          <DetailRow label="SOP Number:" value={displaySopCode(sop.identifier)} />
          <DetailRow label="Version:" value={sop.version || "—"} />
          <DetailRow label="Department:" value={sop.department || "Other"} />
          {sop.location && <DetailRow label="Location:" value={sop.location} title={sop.location} />}
          <DetailRow label="Language:" value={languageLabel} />
          {sop.name && <DetailRow label="English Name:" value={sop.name} title={sop.name} />}
          {sop.nameGujarati && <DetailRow label="Gujarati Name:" value={sop.nameGujarati} title={sop.nameGujarati} />}
          {sop.guidelineReference && <DetailRow label="Guideline:" value={sop.guidelineReference} title={sop.guidelineReference} />}
        </div>
      </div>

      {/* Documents & Revisions */}
      <div className="space-y-2">
        <SectionHeading>Documents &amp; Revisions</SectionHeading>
        <div className="space-y-2 text-[10px]">
          <div className="flex items-start gap-1.5">
            <FileText className="mt-0.5 h-3 w-3 shrink-0 text-gray-500" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="font-semibold text-gray-600">Active Files:</span>
              {fileGroups.length === 0 ? (
                <span className="text-gray-500">No documents</span>
              ) : (
                fileGroups.map((g) => (
                  <div key={g.lang} className="flex items-center gap-1.5">
                    <span className="w-7 shrink-0 text-[8px] font-bold text-gray-400">{g.lang}</span>
                    <div className="flex items-center gap-2 text-[8px] font-bold">
                      {g.docx ? (
                        <FileLink filePath={g.docx} label="DOCX" hasError={g.docxDateError} />
                      ) : (
                        <span className="text-orange-600">DOCX&nbsp;✗</span>
                      )}
                      {g.pdf ? <FileLink filePath={g.pdf} label="PDF" isPdf /> : <span className="text-red-500">PDF&nbsp;✗</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
          {revisionList.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-gray-200 pt-1.5">
              <span className="font-semibold text-gray-600">
                {isArchiveView ? "Archived Revisions:" : "Prior Revisions:"}
              </span>
              {renderPriorGroup("English", engPrior)}
              {renderPriorGroup("Gujarati", gujPrior)}
            </div>
          )}
        </div>
      </div>

      {/* Training & Status */}
      <div className="space-y-2">
        <SectionHeading>Training &amp; Status</SectionHeading>
        <div className="space-y-1.5 text-[10px]">
          <div className="flex items-start gap-1.5">
            <Video className="h-3 w-3 shrink-0 text-gray-500 mt-0.5" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-semibold text-gray-600">Training Video</span>
              {videoCount === 0 ? (
                <span className="text-[10px] font-semibold italic text-amber-600">Not Available</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {(sop.mediaUrls?.videos?.en ?? []).map((url, i) => (
                    <MediaPill key={url} url={url} langLabel="ENG" index={i} kind="video" />
                  ))}
                  {(sop.mediaUrls?.videos?.gu ?? []).map((url, i) => (
                    <MediaPill key={url} url={url} langLabel="GUJ" index={i} kind="video" />
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-start gap-1.5">
            <Presentation className="h-3 w-3 shrink-0 text-gray-500 mt-0.5" />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-semibold text-gray-600">Slides &amp; Materials</span>
              {slideCount === 0 ? (
                <span className="text-[10px] font-semibold italic text-amber-600">Not Available</span>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {(sop.mediaUrls?.slides?.en ?? []).map((url, i) => (
                    <MediaPill key={url} url={url} langLabel="ENG" index={i} kind="slide" />
                  ))}
                  {(sop.mediaUrls?.slides?.gu ?? []).map((url, i) => (
                    <MediaPill key={url} url={url} langLabel="GUJ" index={i} kind="slide" />
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 shrink-0 text-gray-500" />
            <span className="font-semibold text-gray-600">MCQ Bank:</span>
            <span className="font-bold text-gray-800">{sop.mcqCount > 0 ? `${sop.mcqCount} questions` : "Pending"}</span>
          </div>
          <div className="flex items-center gap-1.5 border-t border-gray-200 pt-1.5">
            <Calendar className="h-3 w-3 shrink-0 text-gray-500" />
            <span className="font-semibold text-gray-600">Expiry:</span>
            <span className="min-w-0 flex-1">{expiryNode}</span>
          </div>
          {effective && (
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3 w-3 shrink-0 text-gray-500" />
              <span className="font-semibold text-gray-600">Effective:</span>
              <span className="font-bold text-gray-800">{effective}</span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <Users className="h-3 w-3 shrink-0 text-gray-500" />
            <span className="font-semibold text-gray-600">Compliance:</span>
            <span className="font-bold text-gray-800">{sop.complianceScore}/10 ({sop.complianceStatus})</span>
          </div>

          {canMutate && (
            <div className="flex flex-col gap-1 pt-2">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onEdit(); }}
                className="flex items-center justify-center gap-1 rounded border border-gray-300 bg-white px-2 py-1 text-[10px] font-semibold text-gray-700 hover:bg-gray-50"
              >
                <Edit2 className="h-3 w-3" /> Edit SOP
              </button>
              {/* Archive view is read-only history — only Edit is offered there. */}
              {!isArchiveView && (
                <>
                  {isObsoleteView ? (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onRevive(); }}
                      className="flex items-center justify-center gap-1 rounded border border-emerald-200 bg-white px-2 py-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50"
                    >
                      <RotateCcw className="h-3 w-3" /> Revive SOP
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onObsolete(); }}
                      className="flex items-center justify-center gap-1 rounded border border-amber-200 bg-white px-2 py-1 text-[10px] font-semibold text-amber-700 hover:bg-amber-50"
                    >
                      <Archive className="h-3 w-3" /> Mark Obsolete
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onDelete(); }}
                    className="flex items-center justify-center gap-1 rounded border border-red-200 bg-white px-2 py-1 text-[10px] font-semibold text-red-600 hover:bg-red-50"
                  >
                    <Trash2 className="h-3 w-3" /> Delete Permanently
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Annexure cell ─────────────────────────────────────────────────── */
function AnnexureCell({ sop }: { sop: RegistrySOP }) {
  const annexures = sop.annexures ?? [];
  const required = sop.requiredAnnexures ?? [];

  const byRoman = new Map<string, RegistrySOP["annexures"][number]>();
  for (const a of annexures) {
    const roman = annexureRomanFromLabel(a.label) ?? (a.fileName ? annexureRomanFromLabel(a.fileName) : undefined);
    if (roman && !byRoman.has(roman)) byRoman.set(roman, a);
  }

  if (!required.length) {
    if (!annexures.length) {
      return <span className="text-[8px] text-gray-300">—</span>;
    }
    return (
      <div className="mx-auto flex w-full min-w-0 flex-col gap-0.5 text-left">
        {annexures.map((a) => (
          <FileLink key={a.filePath} filePath={a.filePath} label={a.label} />
        ))}
      </div>
    );
  }

  const allPresent = required.every((r) => byRoman.has(r));

  return (
    <div
      className="mx-auto flex w-full min-w-0 flex-wrap gap-0.5"
      title={
        allPresent
          ? `All ${required.length} annexure(s) present`
          : `Missing: ${required.filter((r) => !byRoman.has(r)).map((r) => `Annexure-${r}`).join(", ")}`
      }
    >
      {required.map((roman) => (
        <AnnexureBadge key={roman} roman={roman} annexure={byRoman.get(roman)} />
      ))}
    </div>
  );
}

function AnnexureBadge({
  roman,
  annexure,
}: {
  roman: string;
  annexure?: { label: string; filePath: string; fileName?: string };
}) {
  const [previewOpen, setPreviewOpen] = useState(false);

  if (!annexure) {
    return (
      <span
        className="inline-flex min-w-[14px] items-center justify-center rounded px-0.5 text-[8px] font-bold leading-tight bg-red-100 text-red-700"
        title={`Annexure-${roman} missing`}
      >
        {roman}
      </span>
    );
  }

  const isPdf = /\.pdf$/i.test(annexure.filePath);

  return (
    <>
      <button
        type="button"
        className="inline-flex min-w-[14px] items-center justify-center rounded px-0.5 text-[8px] font-bold leading-tight bg-green-100 text-green-700 hover:bg-green-200 cursor-pointer"
        onClick={(e) => {
          e.stopPropagation();
          setPreviewOpen(true);
        }}
        title={`Preview ${annexure.label}`}
      >
        {roman}
      </button>
      {previewOpen && (
        <DocPreviewModal
          filePath={annexure.filePath}
          label={annexure.label}
          isPdf={isPdf}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  );
}

/* ─── Files cell: ENG row + GUJ row ──────────────────────────────────── */
function FilesCell({ sop }: { sop: RegistrySOP }) {
  const isDual = sop.language === "ENG-GUJ";
  const hasGu = Boolean(sop.files.docx.gu || sop.files.pdf.gu) || isDual;

  const renderLangRow = (
    langLabel: string,
    langKey: "en" | "gu",
    docxPath: string | undefined,
    pdfPath: string | undefined,
    docxHasError?: boolean,
  ) => (
    <div className="flex min-w-0 items-center gap-1.5 text-left leading-none">
      <span className="w-4.5 shrink-0 text-[8px] font-bold text-gray-500">{langLabel}</span>
      {docxPath ? (
        <FileLink filePath={docxPath} label="DOCX" hasError={docxHasError} />
      ) : docxRequiredForLang(sop, langKey) ? (
        <span className="truncate text-[8px] font-bold leading-none text-orange-600" title="DOCX missing">DOCX&nbsp;✗</span>
      ) : (
        <span className="truncate text-[8px] font-medium leading-none text-gray-300" title="DOCX not required for this version">DOCX&nbsp;—</span>
      )}
      {pdfPath ? (
        <FileLink filePath={pdfPath} label="PDF" isPdf />
      ) : pdfRequiredForLang(sop, langKey) ? (
        <span className="truncate text-[8px] font-bold leading-none text-red-600" title="PDF missing">PDF&nbsp;✗</span>
      ) : (
        <span className="truncate text-[8px] font-medium leading-none text-gray-300" title="PDF not required for this version">PDF&nbsp;—</span>
      )}
    </div>
  );

  if (!hasGu) {
    return (
      <div className="mx-auto flex w-full min-w-0 flex-col gap-1 text-left leading-none">
        {renderLangRow("ENG", "en", sop.files.docx.en, sop.files.pdf.en, sop.files.docxDateError?.en)}
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full min-w-0 flex-col gap-1 text-left leading-none">
      {renderLangRow("ENG", "en", sop.files.docx.en, sop.files.pdf.en, sop.files.docxDateError?.en)}
      {renderLangRow("GUJ", "gu", sop.files.docx.gu, sop.files.pdf.gu, sop.files.docxDateError?.gu)}
    </div>
  );
}

function FileLink({
  filePath,
  label,
  isPdf,
  hasError,
}: {
  filePath: string;
  label: string;
  isPdf?: boolean;
  hasError?: boolean;
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const openPreview = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setPreviewOpen(true);
  }, []);
  const closePreview = useCallback(() => setPreviewOpen(false), []);

  return (
    <>
      <div className="flex min-w-0 items-center gap-px overflow-hidden">
        <button
          type="button"
          className={`min-w-0 truncate font-bold text-[9px] hover:underline cursor-pointer ${
            hasError ? (isPdf ? "text-red-600" : "text-orange-600") : "text-green-600"
          }`}
          onClick={openPreview}
          title={hasError ? `${label} — header dates invalid or missing` : `Preview ${label}`}
        >
          {label}
        </button>
        <a
          href={buildPreviewHref(filePath)}
          download
          rel="noopener noreferrer"
          className="shrink-0 rounded p-px text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          title={`Download ${label}`}
          onClick={(e) => e.stopPropagation()}
        >
          <Download className="h-2 w-2" />
        </a>
      </div>
      {previewOpen && (
        <DocPreviewModal
          filePath={filePath}
          label={label}
          isPdf={!!isPdf}
          onClose={closePreview}
        />
      )}
    </>
  );
}

/* ─── Prior versions cell ─────────────────────────────────────────────── */
const MAX_PRIOR_VERSIONS = 2;

type PriorVersion = RegistrySOP["priorVersions"][0];

function PriorVersionEntry({ pv }: { pv: PriorVersion }) {
  if (pv.missing) {
    return (
      <span className="inline-flex items-center gap-px leading-none whitespace-nowrap">
        <span className="text-[9px] font-bold text-gray-400 line-through">V{pv.version}</span>
        <span className="ml-0.5 text-[8px] italic text-amber-600">miss</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-px leading-none whitespace-nowrap">
      <span className={`shrink-0 text-[9px] font-bold ${pv.docxDateError ? "text-red-700" : "text-green-700"}`}>
        V{pv.version}
      </span>
      <span className="mx-0.5 shrink-0 text-[8px] font-bold">
        {pv.docx ? (
          <FileLink filePath={pv.docx} label="DOCX" hasError={pv.docxDateError} />
        ) : (
          <span className="text-orange-600">DOCX</span>
        )}
      </span>
      <span className="select-none text-[8px] text-gray-400">/</span>
      <span className="mx-0.5 shrink-0 text-[8px] font-bold">
        {pv.pdf ? <FileLink filePath={pv.pdf} label="PDF" isPdf /> : <span className="text-red-500">PDF</span>}
      </span>
    </span>
  );
}

/* Version slot: flex-wrap within the cell so content never bleeds into Dept */
const PRIOR_LABEL_W = "1.5rem";

function PriorLangRow({ pvs, label }: { pvs: PriorVersion[]; label: string }) {
  if (pvs.length === 0) return null;
  const slots = Array.from({ length: MAX_PRIOR_VERSIONS }, (_, i) => pvs[i] ?? null).filter(Boolean) as PriorVersion[];
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-0.5 leading-none">
      <span
        className="shrink-0 text-[8px] font-bold uppercase text-gray-400 tabular-nums"
        style={{ width: PRIOR_LABEL_W }}
      >
        {label}
      </span>
      {slots.map((pv) => (
        <div key={`${pv.version}-${pv.language}`} className="min-w-0 max-w-full shrink overflow-hidden">
          <PriorVersionEntry pv={pv} />
        </div>
      ))}
    </div>
  );
}

function sortPriorDesc(pvs: PriorVersion[]): PriorVersion[] {
  return [...pvs].sort((a, b) => (parseFloat(b.version) || 0) - (parseFloat(a.version) || 0));
}

function ArchivedLangRow({ pvs, label }: { pvs: PriorVersion[]; label: string }) {
  if (pvs.length === 0) return null;
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-0.5 leading-none">
      <span
        className="shrink-0 text-[8px] font-bold uppercase text-gray-400 tabular-nums"
        style={{ width: PRIOR_LABEL_W }}
      >
        {label}
      </span>
      {pvs.map((pv) => (
        <div key={`${pv.version}-${pv.language}`} className="min-w-0 max-w-full shrink overflow-hidden">
          <PriorVersionEntry pv={pv} />
        </div>
      ))}
    </div>
  );
}

function PriorVersionsCell({ sop, archiveView }: { sop: RegistrySOP; archiveView?: boolean }) {
  // Archive view: show every superseded revision (no two-version cap), wrapped.
  if (archiveView) {
    const archived = sortPriorDesc(sop.archivedVersions);
    if (archived.length === 0) {
      return <span className="text-[8px] text-gray-400">—</span>;
    }
    if (sop.language === "ENG-GUJ") {
      return (
        <div className="flex min-w-0 max-w-full flex-col gap-0.5 overflow-hidden">
          <ArchivedLangRow pvs={archived.filter((pv) => pv.language === "ENG")} label="ENG" />
          <ArchivedLangRow pvs={archived.filter((pv) => pv.language === "GUJ")} label="GUJ" />
        </div>
      );
    }
    const langCode = sop.language === "GUJ" ? "GUJ" : "ENG";
    return (
      <ArchivedLangRow
        pvs={archived.filter((pv) => pv.language === langCode || !pv.language)}
        label={langCode}
      />
    );
  }

  if (sop.priorVersions.length === 0) {
    return <span className="text-[8px] text-gray-400">—</span>;
  }

  const isDual = sop.language === "ENG-GUJ";
  const all = sortPriorDesc(sop.priorVersions);

  if (isDual) {
    const eng = all.filter((pv) => pv.language === "ENG").slice(0, MAX_PRIOR_VERSIONS);
    const guj = all.filter((pv) => pv.language === "GUJ").slice(0, MAX_PRIOR_VERSIONS);
    return (
      <div className="flex min-w-0 max-w-full flex-col gap-0.5 overflow-hidden">
        <PriorLangRow pvs={eng} label="ENG" />
        <PriorLangRow pvs={guj} label="GUJ" />
      </div>
    );
  }

  const langCode = sop.language === "GUJ" ? "GUJ" : "ENG";
  const label = langCode;
  // Include entries matching the SOP language, plus any untagged legacy entries
  const pvs = all
    .filter((pv) => pv.language === langCode || !pv.language)
    .slice(0, MAX_PRIOR_VERSIONS);
  return <PriorLangRow pvs={pvs} label={label} />;
}

/* ─── Shared helper: render media pills for one language row ─────────── */
function MediaLangRow({
  langLabel,
  urls,
  kind,
  noneLabel,
}: {
  langLabel: string;
  urls: string[];
  kind: "video" | "slide";
  noneLabel: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-1 text-left leading-none min-h-2.5 py-px">
      <span className="w-5 shrink-0 text-[8px] font-bold text-gray-500 mt-px">{langLabel}</span>
      {urls.length > 0 ? (
        <div className="flex min-w-0 flex-wrap gap-0.5">
          {urls.map((url, i) => (
            <MediaPill key={url} url={url} langLabel={langLabel} index={i} kind={kind} />
          ))}
        </div>
      ) : (
        <span className="truncate text-[8px] font-semibold italic leading-none text-amber-600">{noneLabel}</span>
      )}
    </div>
  );
}

/* ─── Video cell ─────────────────────────────────────────────────────── */
function VideoCell({ sop, isDual }: { sop: RegistrySOP; isDual: boolean }) {
  const enUrls = sop.mediaUrls?.videos?.en ?? [];
  const guUrls = sop.mediaUrls?.videos?.gu ?? [];
  const allUrls = [...enUrls, ...guUrls];

  if (allUrls.length === 0 && !isDual) {
    return <span className="text-[10px] font-bold tabular-nums text-gray-400">0</span>;
  }

  if (!isDual) {
    return (
      <div className="flex min-w-0 flex-wrap gap-0.5">
        {allUrls.map((url, i) => (
          <MediaPill key={url} url={url} langLabel="ENG" index={i} kind="video" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5 text-left leading-none">
      <MediaLangRow langLabel="ENG" urls={enUrls} kind="video" noneLabel="no video" />
      <MediaLangRow langLabel="GUJ" urls={guUrls} kind="video" noneLabel="no video" />
    </div>
  );
}

/* ─── Slides cell ────────────────────────────────────────────────────── */
function SlidesCell({ sop, isDual }: { sop: RegistrySOP; isDual: boolean }) {
  const enUrls = sop.mediaUrls?.slides?.en ?? [];
  const guUrls = sop.mediaUrls?.slides?.gu ?? [];
  const allUrls = [...enUrls, ...guUrls];

  if (allUrls.length === 0 && !isDual) {
    return <span className="text-[10px] font-bold tabular-nums text-gray-400">0</span>;
  }

  if (!isDual) {
    return (
      <div className="flex min-w-0 flex-wrap gap-0.5">
        {allUrls.map((url, i) => (
          <MediaPill key={url} url={url} langLabel="ENG" index={i} kind="slide" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5 text-left leading-none">
      <MediaLangRow langLabel="ENG" urls={enUrls} kind="slide" noneLabel="no slides" />
      <MediaLangRow langLabel="GUJ" urls={guUrls} kind="slide" noneLabel="no slides" />
    </div>
  );
}
