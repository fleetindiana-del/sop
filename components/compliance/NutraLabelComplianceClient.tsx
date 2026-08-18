"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  ImagePlus,
  Loader2,
  Plus,
  RefreshCw,
  ScanLine,
  Sparkles,
} from "lucide-react";
import {
  CLASSIFICATION_LABELS,
  GAP_LIFECYCLE,
  LABEL_FACES,
  PRODUCT_CLASSIFICATIONS,
  type ExtractedLabel,
  type FaceReadability,
  type GapLifecycleStatus,
  type LabelAssetMeta,
  type LabelFace,
  type LabelFinding,
  type LabelFindingSeverity,
  type LabelPreview,
  type LabelScoreBreakdown,
  type LabelVersionComparison,
  type ProductClassification,
  type UnreadableRegion,
} from "@/lib/label-compliance/types";

type ReportListItem = {
  _id: string;
  productName: string;
  brandName?: string;
  productClassification: ProductClassification;
  classificationConfidence: number;
  classificationConfirmed?: boolean;
  score: LabelScoreBreakdown;
  complianceStatus: string;
  analysisStatus: "extracted" | "completed" | "failed";
  assets: LabelAssetMeta[];
  versionNumber?: number;
  latestComparison?: LabelVersionComparison;
  analyzedAt: string;
  lastRecheckAt?: string;
};

type FullReport = ReportListItem & {
  extractedLabel: ExtractedLabel;
  findings: LabelFinding[];
  unreadableRegions?: UnreadableRegion[];
  readability?: FaceReadability[];
  classificationReason?: string;
  previews?: LabelPreview[];
  modelNotes?: string;
  notes?: string;
};

const FACE_LABELS: Record<LabelFace, string> = {
  front: "Front Label",
  back: "Back Label",
  side: "Side Label",
  pdf: "Complete PDF",
};

const LIFECYCLE_LABELS: Record<GapLifecycleStatus, string> = {
  detected: "Detected",
  reviewed: "Reviewed",
  "correction-suggested": "Correction Suggested",
  corrected: "Corrected",
  "re-uploaded": "Re-uploaded",
  revalidated: "Revalidated",
  closed: "Closed",
};

const NEXT_LIFECYCLE: Partial<Record<GapLifecycleStatus, GapLifecycleStatus>> = {
  detected: "reviewed",
  reviewed: "correction-suggested",
  "correction-suggested": "corrected",
  "re-uploaded": "revalidated",
  revalidated: "closed",
};

const SEVERITY_STYLE: Record<LabelFindingSeverity, string> = {
  critical: "bg-rose-50 text-rose-800 border-rose-200",
  high: "bg-orange-50 text-orange-800 border-orange-200",
  medium: "bg-amber-50 text-amber-800 border-amber-200",
  low: "bg-slate-50 text-slate-700 border-slate-200",
};

type SlotFiles = Partial<Record<LabelFace, File>>;
type Phase = "home" | "create" | "confirm" | "review" | "report";

const REVIEW_IDS_KEY = "nutra-label-review-ids";

function readStoredIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(REVIEW_IDS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean).slice(0, 30) : [];
  } catch {
    return [];
  }
}

function rememberReportId(id: string) {
  if (typeof window === "undefined" || !id) return;
  const next = [id, ...readStoredIds().filter((x) => x !== id)].slice(0, 30);
  window.localStorage.setItem(REVIEW_IDS_KEY, JSON.stringify(next));
}

export function NutraLabelComplianceClient() {

  const [phase, setPhase] = useState<Phase>("home");
  const [slots, setSlots] = useState<SlotFiles>({});
  const [blobUrls, setBlobUrls] = useState<Partial<Record<LabelFace, string>>>({});
  const [productName, setProductName] = useState("");
  const [brandName, setBrandName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<"extract" | "score" | "recheck" | null>(null);
  const [error, setError] = useState("");
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [report, setReport] = useState<FullReport | null>(null);
  const [draftClass, setDraftClass] = useState<ProductClassification>("unknown");
  const [showClassPicker, setShowClassPicker] = useState(false);
  const [activeFace, setActiveFace] = useState<LabelFace>("front");
  const [updatingFindingId, setUpdatingFindingId] = useState<string | null>(null);
  const [showV2Upload, setShowV2Upload] = useState(false);
  const [geminiReady, setGeminiReady] = useState<{ ok: boolean; model?: string | null } | null>(null);
  const listLoaded = useRef(false);

  useEffect(() => {
    const urls: Partial<Record<LabelFace, string>> = {};
    for (const face of LABEL_FACES) {
      const file = slots[face];
      if (file?.type.startsWith("image/")) urls[face] = URL.createObjectURL(file);
    }
    setBlobUrls(urls);
    return () => {
      for (const url of Object.values(urls)) {
        if (url) URL.revokeObjectURL(url);
      }
    };
  }, [slots]);

  const loadReports = useCallback(async () => {
    setLoadingList(true);
    try {
      const ids = readStoredIds();
      if (!ids.length) {
        setReports([]);
        return;
      }
      const res = await fetch(`/api/compliance/label?ids=${encodeURIComponent(ids.join(","))}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load reports");
      setReports(data.reports ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reports");
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (listLoaded.current) return;
    listLoaded.current = true;
    void loadReports();
    void fetch("/api/compliance/label/health")
      .then((res) => res.json())
      .then((data) => setGeminiReady({ ok: Boolean(data.ok), model: data.model }))
      .catch(() => setGeminiReady({ ok: false }));
  }, [loadReports]);

  const applyReport = (next: FullReport) => {
    setReport(next);
    if (next._id) rememberReportId(next._id);
    setDraftClass(next.productClassification);
    const firstFace = next.previews?.[0]?.face || next.assets?.[0]?.face || "front";
    setActiveFace(firstFace);
    if (next.analysisStatus === "completed") setPhase("report");
    else setPhase(next.classificationConfirmed ? "review" : "confirm");
  };

  const openReport = async (id: string) => {
    setError("");
    const res = await fetch(`/api/compliance/label/${id}`);
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Failed to load report");
      return;
    }
    applyReport(data.report);
  };

  const buildForm = (files: SlotFiles) => {
    const form = new FormData();
    if (productName.trim()) form.set("productName", productName.trim());
    if (brandName.trim()) form.set("brandName", brandName.trim());
    if (notes.trim()) form.set("notes", notes.trim());
    for (const face of LABEL_FACES) {
      const file = files[face];
      if (file) form.set(face, file);
    }
    return form;
  };

  const startNew = () => {
    setReport(null);
    setSlots({});
    setProductName("");
    setBrandName("");
    setNotes("");
    setShowClassPicker(false);
    setShowV2Upload(false);
    setError("");
    setPhase("create");
  };

  const runExtract = async () => {
    if (!LABEL_FACES.some((f) => slots[f])) {
      setError("Upload front, back, and/or side photos — or one complete PDF.");
      return;
    }
    setBusy("extract");
    setError("");
    try {
      const res = await fetch("/api/compliance/label", { method: "POST", body: buildForm(slots) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Gemini could not read the label");
      applyReport(data.report);
      setPhase("confirm");
      await loadReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setBusy(null);
    }
  };

  const confirmClassification = async (nextClass: ProductClassification) => {
    if (!report?._id) return;
    setDraftClass(nextClass);
    const res = await fetch(`/api/compliance/label/${report._id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ productClassification: nextClass, classificationConfirmed: true }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "Could not save classification");
      return;
    }
    setReport(data.report);
    setShowClassPicker(false);
    setPhase("review");
  };

  const runScore = async () => {
    if (!report?._id) return;
    setBusy("score");
    setError("");
    try {
      const res = await fetch(`/api/compliance/label/${report._id}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productClassification: draftClass,
          extractedLabel: report.extractedLabel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "FSSAI scoring failed");
      applyReport(data.report);
      setPhase("report");
      await loadReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scoring failed");
    } finally {
      setBusy(null);
    }
  };

  const runRecheck = async () => {
    if (!report?._id) return;
    if (!LABEL_FACES.some((f) => slots[f])) {
      setError("Upload the revised label (V2) photos or PDF, then compare.");
      return;
    }
    setBusy("recheck");
    setError("");
    try {
      const res = await fetch(`/api/compliance/label/${report._id}/recheck`, {
        method: "POST",
        body: buildForm(slots),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-check failed");
      applyReport(data.report);
      setSlots({});
      setShowV2Upload(false);
      setPhase("report");
      await loadReports();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-check failed");
    } finally {
      setBusy(null);
    }
  };

  const advanceLifecycle = async (finding: LabelFinding, lifecycle: GapLifecycleStatus) => {
    if (!report?._id) return;
    setUpdatingFindingId(finding.findingId);
    try {
      const res = await fetch(`/api/compliance/label/${report._id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ findingId: finding.findingId, lifecycle }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");
      setReport(data.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setUpdatingFindingId(null);
    }
  };

  const imageSrc = (face: LabelFace) => {
    if (blobUrls[face]) return blobUrls[face];
    const preview = report?.previews?.find((p) => p.face === face);
    if (preview?.dataBase64) return `data:${preview.mimeType};base64,${preview.dataBase64}`;
    return null;
  };

  const availableFaces = useMemo(() => {
    const fromSlots = LABEL_FACES.filter((f) => slots[f] || blobUrls[f]);
    const fromReport = (report?.previews ?? []).map((p) => p.face);
    const fromAssets = (report?.assets ?? []).map((a) => a.face);
    return [...new Set([...fromSlots, ...fromReport, ...fromAssets])];
  }, [slots, blobUrls, report]);

  const busyLabel =
    busy === "extract"
      ? "Gemini is reading the label…"
      : busy === "score"
        ? "Gemini is applying FSSAI rules…"
        : busy === "recheck"
          ? "Gemini is comparing the revised label…"
          : null;

  return (
    <div className="min-h-screen bg-[#f8f9fa] font-sans">
      <header className="sticky top-0 z-50 border-b border-gray-200 bg-white/95 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-2 px-3 py-2 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate bg-gradient-to-r from-purple-700 to-teal-600 bg-clip-text text-[13px] font-bold text-transparent sm:text-sm">
              Nutra Label Compliance
            </h1>
            <span className="hidden items-center gap-1 rounded-full border border-teal-200 bg-teal-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-800 sm:inline-flex">
              <Sparkles className="h-3 w-3" /> Gemini · FSSAI
            </span>
          </div>
          {phase !== "home" && (
            <button
              type="button"
              onClick={() => {
                setPhase("home");
                setShowV2Upload(false);
              }}
              className="shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
            >
              My reviews
            </button>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-7xl space-y-4 px-3 pb-[max(4rem,env(safe-area-inset-bottom))] pt-3 sm:space-y-5 sm:px-6 sm:pt-4">
        {phase !== "home" && <WorkflowStepper phase={phase} version={report?.versionNumber} />}

        {geminiReady && !geminiReady.ok && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            Gemini is not configured on this host. Set <code className="rounded bg-amber-100 px-1">GEMINI_API_KEY</code> before running a label check.
          </div>
        )}
        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</div>
        )}
        {busyLabel && (
          <div className="flex items-center gap-2 rounded-lg border border-purple-200 bg-purple-50 px-4 py-3 text-sm font-medium text-purple-900">
            <Loader2 className="h-4 w-4 animate-spin" />
            {busyLabel}
          </div>
        )}

        {phase === "home" && (
          <HomeList
            reports={reports}
            loading={loadingList}
            onRefresh={() => void loadReports()}
            onOpen={(id) => void openReport(id)}
            onCreate={startNew}
          />
        )}

        {phase === "create" && (
          <CreateReview
            productName={productName}
            brandName={brandName}
            notes={notes}
            slots={slots}
            onProductName={setProductName}
            onBrandName={setBrandName}
            onNotes={setNotes}
            onFile={(face, file) => setSlots((prev) => ({ ...prev, [face]: file }))}
            onClear={(face) =>
              setSlots((prev) => {
                const next = { ...prev };
                delete next[face];
                return next;
              })
            }
            onSubmit={() => void runExtract()}
            disabled={busy !== null}
          />
        )}

        {phase === "confirm" && report && (
          <ClassificationConfirm
            report={report}
            draftClass={draftClass}
            showPicker={showClassPicker}
            onDraftClass={setDraftClass}
            onShowPicker={setShowClassPicker}
            onYes={() => void confirmClassification(draftClass)}
            disabled={busy !== null}
          />
        )}

        {(phase === "review" || phase === "report") && report && (
          <SplitWorkspace
            report={report}
            phase={phase}
            activeFace={activeFace}
            availableFaces={availableFaces}
            imageSrc={imageSrc}
            onFace={setActiveFace}
            onExtracted={(extracted) => setReport((prev) => (prev ? { ...prev, extractedLabel: extracted } : prev))}
            onScore={() => void runScore()}
            onLifecycle={advanceLifecycle}
            updatingFindingId={updatingFindingId}
            showV2Upload={showV2Upload}
            onToggleV2={() => setShowV2Upload((v) => !v)}
            slots={slots}
            onFile={(face, file) => setSlots((prev) => ({ ...prev, [face]: file }))}
            onClear={(face) =>
              setSlots((prev) => {
                const next = { ...prev };
                delete next[face];
                return next;
              })
            }
            onRecheck={() => void runRecheck()}
            disabled={busy !== null}
          />
        )}
      </div>
    </div>
  );
}

function WorkflowStepper({ phase, version }: { phase: Phase; version?: number }) {
  const steps = [
    { id: "create", label: "Upload" },
    { id: "confirm", label: "Category" },
    { id: "review", label: "Review data" },
    { id: "report", label: version && version > 1 ? `Label V${version}` : "Compliance" },
  ];
  const idx = Math.max(0, steps.findIndex((s) => s.id === phase));
  return (
    <ol className="flex flex-wrap gap-2">
      {steps.map((step, i) => (
        <li
          key={step.id}
          className={`rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wide ${
            i === idx
              ? "bg-purple-600 text-white"
              : i < idx
                ? "bg-teal-50 text-teal-800 border border-teal-200"
                : "bg-white text-gray-400 border border-gray-200"
          }`}
        >
          {i + 1}. {step.label}
        </li>
      ))}
    </ol>
  );
}

function HomeList({
  reports,
  loading,
  onRefresh,
  onOpen,
  onCreate,
}: {
  reports: ReportListItem[];
  loading: boolean;
  onRefresh: () => void;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-gray-100 px-4 py-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-5">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Your label reviews</h2>
          <p className="text-xs text-gray-500">Photograph the pack. Gemini reads it, then FSSAI rules are applied. No login required.</p>
        </div>
        <div className="flex w-full gap-2 sm:w-auto">
          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-gray-200 px-3 py-2.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50 sm:flex-none sm:py-1.5"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
          <button
            type="button"
            onClick={onCreate}
            className="inline-flex flex-[2] items-center justify-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2.5 text-[11px] font-bold text-white hover:bg-purple-700 sm:flex-none sm:py-1.5"
          >
            <Plus className="h-3.5 w-3.5" /> New review
          </button>
        </div>
      </div>
      {loading ? (
        <p className="px-5 py-8 text-center text-sm text-gray-500">Loading…</p>
      ) : reports.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-gray-500">No reviews on this phone yet. Create one and photograph the pack.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-5 py-2 font-bold">Product</th>
                <th className="px-3 py-2 font-bold">Version</th>
                <th className="px-3 py-2 font-bold">Class</th>
                <th className="px-3 py-2 font-bold">Score</th>
                <th className="px-3 py-2 font-bold">Status</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((row) => (
                <tr
                  key={row._id}
                  onClick={() => onOpen(row._id)}
                  className="cursor-pointer border-t border-gray-50 hover:bg-purple-50/50"
                >
                  <td className="px-5 py-2.5">
                    <p className="font-semibold text-gray-800">{row.productName}</p>
                    <p className="text-[10px] text-gray-400">{row.brandName || "—"}</p>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-gray-600">V{row.versionNumber ?? 1}</td>
                  <td className="px-3 py-2.5 text-gray-600">{CLASSIFICATION_LABELS[row.productClassification]}</td>
                  <td className="px-3 py-2.5 font-black text-purple-700">
                    {row.analysisStatus === "completed" ? `${row.score?.score ?? 0}%` : "—"}
                  </td>
                  <td className="px-3 py-2.5 text-gray-500">
                    {row.analysisStatus === "extracted" ? "Draft · confirm category" : row.complianceStatus}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CreateReview({
  productName,
  brandName,
  notes,
  slots,
  onProductName,
  onBrandName,
  onNotes,
  onFile,
  onClear,
  onSubmit,
  disabled,
}: {
  productName: string;
  brandName: string;
  notes: string;
  slots: SlotFiles;
  onProductName: (v: string) => void;
  onBrandName: (v: string) => void;
  onNotes: (v: string) => void;
  onFile: (face: LabelFace, file: File) => void;
  onClear: (face: LabelFace) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <section className="space-y-4">
      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold text-gray-900">1. Basic product information</h2>
        <p className="mt-0.5 text-xs text-gray-500">Optional. Gemini will read the rest from the pack.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Product name
            <input
              value={productName}
              onChange={(e) => onProductName(e.target.value)}
              placeholder="Leave blank to detect"
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-800"
            />
          </label>
          <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Brand
            <input
              value={brandName}
              onChange={(e) => onBrandName(e.target.value)}
              placeholder="Optional"
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-800"
            />
          </label>
          <label className="sm:col-span-2 text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Notes
            <input
              value={notes}
              onChange={(e) => onNotes(e.target.value)}
              placeholder="Lot, market, or anything the photos won’t show"
              className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-800"
            />
          </label>
        </div>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold text-gray-900">2. Upload label</h2>
        <p className="mt-0.5 text-xs text-gray-500">
          Photograph each panel. Tilt, glare, and curved bottles are OK — if Gemini cannot read a section, it will ask for a clearer shot instead of guessing.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {(["front", "back", "side"] as const).map((face) => (
            <FaceSlot key={face} face={face} file={slots[face]} onFile={(file) => onFile(face, file)} onClear={() => onClear(face)} />
          ))}
        </div>
        <div className="my-4 flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.2em] text-gray-400">
          <span className="h-px flex-1 bg-gray-200" />
          or
          <span className="h-px flex-1 bg-gray-200" />
        </div>
        <FaceSlot face="pdf" file={slots.pdf} onFile={(file) => onFile("pdf", file)} onClear={() => onClear("pdf")} />
        <button
          type="button"
          onClick={onSubmit}
          disabled={disabled}
          className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-purple-600 px-4 py-3 text-sm font-bold text-white hover:bg-purple-700 disabled:opacity-60 sm:w-auto sm:py-2 sm:text-xs"
        >
          <ScanLine className="h-3.5 w-3.5" />
          Let Gemini read the label
        </button>
      </div>
    </section>
  );
}

function ClassificationConfirm({
  report,
  draftClass,
  showPicker,
  onDraftClass,
  onShowPicker,
  onYes,
  disabled,
}: {
  report: FullReport;
  draftClass: ProductClassification;
  showPicker: boolean;
  onDraftClass: (v: ProductClassification) => void;
  onShowPicker: (v: boolean) => void;
  onYes: () => void;
  disabled: boolean;
}) {
  return (
    <section className="mx-auto max-w-xl rounded-2xl border border-purple-200 bg-white p-6 shadow-sm">
      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-purple-500">Gemini classification</p>
      <h2 className="mt-2 text-lg font-bold text-gray-900">
        This appears to be a {CLASSIFICATION_LABELS[draftClass]}.
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-gray-600">{report.classificationReason}</p>
      <p className="mt-1 text-xs text-gray-400">Confidence {report.classificationConfidence}%</p>
      <p className="mt-4 text-sm font-semibold text-gray-800">Is this classification correct?</p>
      <div className="mt-3 flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap">
        <button
          type="button"
          disabled={disabled}
          onClick={onYes}
          className="w-full rounded-lg bg-purple-600 px-4 py-3 text-sm font-bold text-white hover:bg-purple-700 disabled:opacity-60 sm:w-auto sm:py-2 sm:text-xs"
        >
          Yes, continue
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onShowPicker(true)}
          className="w-full rounded-lg border border-gray-200 bg-white px-4 py-3 text-sm font-bold text-gray-700 hover:bg-gray-50 sm:w-auto sm:py-2 sm:text-xs"
        >
          Change category
        </button>
      </div>
      {showPicker && (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="text-[10px] font-bold uppercase tracking-wider text-gray-500">
            Category
            <select
              value={draftClass}
              onChange={(e) => onDraftClass(e.target.value as ProductClassification)}
              className="mt-1 block w-full rounded-lg border border-gray-200 px-2.5 py-2.5 text-sm font-semibold sm:min-w-[240px]"
            >
              {PRODUCT_CLASSIFICATIONS.filter((c) => c !== "unknown").map((c) => (
                <option key={c} value={c}>
                  {CLASSIFICATION_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={disabled}
            onClick={onYes}
            className="rounded-lg bg-teal-600 px-4 py-2 text-xs font-bold text-white hover:bg-teal-700"
          >
            Use this category
          </button>
        </div>
      )}
    </section>
  );
}

function SplitWorkspace({
  report,
  phase,
  activeFace,
  availableFaces,
  imageSrc,
  onFace,
  onExtracted,
  onScore,
  onLifecycle,
  updatingFindingId,
  showV2Upload,
  onToggleV2,
  slots,
  onFile,
  onClear,
  onRecheck,
  disabled,
}: {
  report: FullReport;
  phase: Phase;
  activeFace: LabelFace;
  availableFaces: LabelFace[];
  imageSrc: (face: LabelFace) => string | null | undefined;
  onFace: (face: LabelFace) => void;
  onExtracted: (extracted: ExtractedLabel) => void;
  onScore: () => void;
  onLifecycle: (finding: LabelFinding, next: GapLifecycleStatus) => void;
  updatingFindingId: string | null;
  showV2Upload: boolean;
  onToggleV2: () => void;
  slots: SlotFiles;
  onFile: (face: LabelFace, file: File) => void;
  onClear: (face: LabelFace) => void;
  onRecheck: () => void;
  disabled: boolean;
}) {
  const src = imageSrc(activeFace) || (availableFaces[0] ? imageSrc(availableFaces[0]) : null);
  const extracted = report.extractedLabel;
  const unread = report.unreadableRegions ?? [];
  const score = report.score;
  const comparison = report.latestComparison;

  return (
    <div className="space-y-4">
      {unread.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="flex items-center gap-1.5 text-xs font-bold text-amber-900">
            <AlertTriangle className="h-3.5 w-3.5" /> Unable to confidently read {unread.length} section
            {unread.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-2 space-y-1.5 text-xs text-amber-900">
            {unread.map((row, i) => (
              <li key={`${row.section}-${i}`}>
                <span className="font-semibold capitalize">{row.section}</span>
                {row.face !== "unknown" ? ` (${FACE_LABELS[row.face]})` : ""} — {row.reason}. {row.suggestedAction}
              </li>
            ))}
          </ul>
        </div>
      )}

      {phase === "report" && comparison && (
        <div className="rounded-xl border border-teal-200 bg-teal-50 px-5 py-4">
          <p className="text-sm font-bold text-teal-900">
            Label V{comparison.fromVersion} → V{comparison.toVersion}
          </p>
          <p className="mt-1 text-2xl font-black text-teal-800">
            Compliance: {comparison.fromScore}% → {comparison.toScore}%
          </p>
          <p className="mt-2 text-xs font-semibold text-teal-900">
            Resolved: {comparison.resolved} findings · Remaining: {comparison.remaining} findings · New findings:{" "}
            {comparison.newFindings}
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <aside className="rounded-2xl border border-gray-200 bg-white p-3 shadow-sm sm:p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400">Product image</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(availableFaces.length ? availableFaces : LABEL_FACES).map((face) => (
              <button
                key={face}
                type="button"
                onClick={() => onFace(face)}
                className={`rounded-md px-2 py-1 text-[10px] font-bold uppercase ${
                  activeFace === face ? "bg-purple-600 text-white" : "border border-gray-200 text-gray-600"
                }`}
              >
                {FACE_LABELS[face]}
              </button>
            ))}
          </div>
          <div className="mt-3 flex min-h-[200px] items-center justify-center overflow-hidden rounded-xl bg-slate-100 sm:min-h-[320px]">
            {src ? (
              // Uploaded label preview; next/image is not used because src is a blob/data URL.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt={`${FACE_LABELS[activeFace]} artwork`} className="max-h-[280px] w-full object-contain sm:max-h-[520px]" />
            ) : (
              <p className="px-4 text-center text-xs text-gray-400">No preview stored for this panel.</p>
            )}
          </div>
        </aside>

        <div className="space-y-4">
          {phase === "review" && (
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <h2 className="text-sm font-bold uppercase tracking-wider text-gray-800">Label information</h2>
              <p className="mt-1 text-xs text-gray-500">Check Gemini’s extraction before FSSAI rules run.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {(
                  [
                    ["productName", "Product"],
                    ["categoryStatement", "Category on pack"],
                    ["servingSize", "Serving"],
                    ["recommendedUsage", "Usage"],
                    ["netQuantity", "Net quantity"],
                    ["fssaiLicenseNumber", "FSSAI licence"],
                  ] as const
                ).map(([key, label]) => (
                  <label key={key} className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
                    {label}
                    <input
                      value={String(extracted[key] ?? "")}
                      onChange={(e) => onExtracted({ ...extracted, [key]: e.target.value })}
                      className="mt-1 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm font-medium text-gray-800"
                    />
                  </label>
                ))}
              </div>
              <button
                type="button"
                onClick={onScore}
                disabled={disabled}
                className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-purple-600 px-4 py-3 text-sm font-bold text-white hover:bg-purple-700 disabled:opacity-60 sm:w-auto sm:py-2 sm:text-xs"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Run FSSAI compliance
              </button>
            </section>
          )}

          {phase === "report" && score && (
            <section className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-400">Label information</p>
                  <p className="mt-1 text-base font-bold text-gray-900">Product: {report.productName}</p>
                  <p className="text-sm text-gray-600">Category: {CLASSIFICATION_LABELS[report.productClassification]}</p>
                  {extracted.servingSize && (
                    <p className="text-sm text-gray-600">Serving: {extracted.servingSize}</p>
                  )}
                </div>
                <div className="text-right">
                  <p className={`text-4xl font-black ${score.score >= 85 ? "text-emerald-600" : score.score >= 60 ? "text-amber-600" : "text-rose-600"}`}>
                    {score.score}%
                  </p>
                  <p className="text-xs font-semibold text-gray-500">{report.complianceStatus}</p>
                  <p className="text-[10px] text-gray-400">Label V{report.versionNumber ?? 1}</p>
                </div>
              </div>

              <h3 className="mt-5 text-[10px] font-black uppercase tracking-[0.2em] text-gray-400">FSSAI checks</h3>
              <ul className="mt-2 divide-y divide-gray-100">
                {report.findings.map((finding) => (
                  <FindingRow
                    key={finding.findingId}
                    finding={finding}
                    busy={updatingFindingId === finding.findingId}
                    onLifecycle={(next) => onLifecycle(finding, next)}
                  />
                ))}
              </ul>

              <button
                type="button"
                onClick={onToggleV2}
                className="mt-4 rounded-lg border border-teal-300 bg-teal-50 px-3 py-1.5 text-[11px] font-bold text-teal-800 hover:bg-teal-100"
              >
                {showV2Upload ? "Hide V2 upload" : `Upload Label V${(report.versionNumber ?? 1) + 1}`}
              </button>
              {showV2Upload && (
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-gray-500">After artwork is fixed, upload the revised panels. Gemini re-reads and compares to V{report.versionNumber ?? 1}.</p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(["front", "back", "side"] as const).map((face) => (
                      <FaceSlot key={face} face={face} file={slots[face]} onFile={(file) => onFile(face, file)} onClear={() => onClear(face)} />
                    ))}
                  </div>
                  <FaceSlot face="pdf" file={slots.pdf} onFile={(file) => onFile("pdf", file)} onClear={() => onClear("pdf")} />
                  <button
                    type="button"
                    onClick={onRecheck}
                    disabled={disabled}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-bold text-white hover:bg-teal-700 disabled:opacity-60"
                  >
                    <RefreshCw className="h-3.5 w-3.5" /> Compare and re-check
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function FaceSlot({
  face,
  file,
  onFile,
  onClear,
}: {
  face: LabelFace;
  file?: File;
  onFile: (file: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const accept = face === "pdf" ? "application/pdf" : "image/*";
  return (
    <div
      className={`relative flex min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-3 py-5 text-center sm:min-h-[110px] sm:py-4 ${
        file ? "border-teal-300 bg-teal-50/60" : "border-gray-200 bg-gray-50 hover:border-purple-300"
      }`}
    >
      <button type="button" onClick={() => inputRef.current?.click()} className="flex min-h-[44px] w-full flex-col items-center gap-1.5">
        {file ? <FileText className="h-5 w-5 text-teal-700" /> : <ImagePlus className="h-5 w-5 text-gray-400" />}
        <span className="text-[11px] font-black uppercase tracking-wider text-gray-700">{FACE_LABELS[face]}</span>
        <span className="max-w-full truncate text-[10px] text-gray-500">
          {file ? file.name : face === "pdf" ? "Upload complete PDF" : "Upload Photo"}
        </span>
      </button>
      {file && (
        <button
          type="button"
          onClick={onClear}
          className="absolute right-2 top-2 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-bold text-gray-500 hover:text-rose-600"
        >
          Clear
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        capture={face === "pdf" ? undefined : "environment"}
        className="hidden"
        onChange={(e) => {
          const next = e.target.files?.[0];
          if (next) onFile(next);
        }}
      />
    </div>
  );
}

function FindingRow({
  finding,
  busy,
  onLifecycle,
}: {
  finding: LabelFinding;
  busy: boolean;
  onLifecycle: (next: GapLifecycleStatus) => void;
}) {
  const next = NEXT_LIFECYCLE[finding.lifecycle];
  const mark =
    finding.status === "pass" ? "✅" : finding.status === "review" || finding.evidence.startsWith("Unable to confidently") ? "⚠️" : "❌";
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900">
            {mark} {finding.claim ? "Claim requires review" : finding.title}
          </p>
          {finding.claim && <p className="mt-0.5 text-xs italic text-gray-700">Claim: “{finding.claim}”</p>}
          <p className="mt-1 text-[11px] text-gray-500">
            <span className="font-mono font-bold text-purple-700">{finding.ruleId}</span> · {finding.regulation}
          </p>
          <p className="mt-1 text-xs text-gray-600">{finding.evidence}</p>
          {finding.status !== "pass" && finding.recommendation && (
            <p className="mt-2 rounded-lg border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-900">
              <span className="font-bold">Recommendation: </span>
              {finding.recommendation}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {finding.status === "pass" ? (
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-black uppercase text-emerald-800">
              <CheckCircle2 className="h-3 w-3" /> Passed
            </span>
          ) : (
            <span className={`rounded-md border px-2 py-0.5 text-[10px] font-black uppercase ${SEVERITY_STYLE[finding.severity]}`}>
              {finding.severity}
            </span>
          )}
          {finding.status !== "pass" && (
            <>
              <select
                value={finding.lifecycle}
                disabled={busy}
                onChange={(e) => onLifecycle(e.target.value as GapLifecycleStatus)}
                className="rounded-md border border-gray-200 bg-white px-1.5 py-1 text-[10px] font-semibold text-gray-700"
              >
                {GAP_LIFECYCLE.map((step) => (
                  <option key={step} value={step}>
                    {LIFECYCLE_LABELS[step]}
                  </option>
                ))}
              </select>
              {next && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onLifecycle(next)}
                  className="text-[10px] font-bold text-purple-700 hover:underline disabled:opacity-50"
                >
                  {busy ? "Saving…" : `Mark ${LIFECYCLE_LABELS[next]}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </li>
  );
}
