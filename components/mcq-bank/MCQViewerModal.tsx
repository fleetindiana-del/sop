"use client";

import { useEffect, useRef, useState } from "react";
import { QuestionAnalyticsModal } from "./QuestionAnalyticsModal";
import {
  ArrowLeft,
  CheckCircle2,
  Copy,
  Grid,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Sparkles,
  Trash2,
  Wand2,
  X,
  Paperclip,
  Languages,
} from "lucide-react";

/** One language version of a master MCQ — same question, same correct option. */
interface McqTranslation {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
  isStale?: boolean;
  isVerified?: boolean;
}

interface MCQ {
  mcqId?: string;
  translations?: Record<string, McqTranslation | undefined>;
  question: string;
  difficulty?: "Easy" | "Medium" | "Hard" | string;
  difficultyStars?: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
  sopReference?: string;
  isChecked?: boolean;
  isReviewed?: boolean;
  isSimilar?: boolean;
  fromAnnexure?: boolean;
  isCreative?: boolean;
}

/** Explicit flag, or legacy annexure-swap questions that cite Annexure-I/II/… */
function isAnnexureMcq(mcq: Pick<MCQ, "fromAnnexure" | "question">): boolean {
  if (mcq.fromAnnexure) return true;
  return /\bAnnexure[-–—\s]*([IVXLC]+|\d+)\b/i.test(mcq.question ?? "");
}

function isCreativeMcq(mcq: Pick<MCQ, "isCreative">): boolean {
  return Boolean(mcq.isCreative);
}

function displayDifficulty(raw: unknown): "Easy" | "Medium" | "Hard" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "easy") return "Easy";
  if (s === "hard") return "Hard";
  if (raw === "Easy" || raw === "Medium" || raw === "Hard") return raw;
  return "Medium";
}

interface MCQBank {
  _id: string;
  sopIdentifier: string;
  sopName: string;
  department: string;
  language?: string;
  totalQuestions: number;
  mcqs: MCQ[];
}

type StatusFilter = "all" | "checked" | "pending" | "similar" | "reviewed" | "annexure" | "creative";
type TabType = "active" | "recycled";

const BATCH = 30;

function highlight(text: string, term: string) {
  if (!term || !text) return <span>{text}</span>;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return <span>{text}</span>;
  return (
    <span>
      {text.slice(0, idx)}
      <mark className="bg-indigo-500/40 text-indigo-100 rounded px-0.5">
        {text.slice(idx, idx + term.length)}
      </mark>
      {text.slice(idx + term.length)}
    </span>
  );
}

interface QuestionCardProps {
  mcq: MCQ;
  originalIndex: number;
  bankId: string;
  searchTerm: string;
  onUpdated: (idx: number, patch: Partial<MCQ>) => void;
  onOpen: () => void;
}

function QuestionCard({ mcq, originalIndex, bankId, searchTerm, onUpdated, onOpen }: QuestionCardProps) {
  const [updating, setUpdating] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);
  const difficulty = displayDifficulty(mcq.difficulty);

  // One question, viewed in either language. The Gujarati version is a translation
  // of THIS question — same options in the same order, same correct answer.
  const gu = mcq.translations?.gu;
  const [showGu, setShowGu] = useState(false);
  const view = showGu && gu ? gu : mcq;

  async function toggle(field: "isChecked" | "isReviewed" | "isSimilar") {
    setUpdating(field);
    try {
      const res = await fetch("/api/mcq-bank/update-status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankId, index: originalIndex, field, value: !mcq[field] }),
      });
      if (res.ok) onUpdated(originalIndex, { [field]: !mcq[field] });
    } finally {
      setUpdating(null);
    }
  }

  async function regenerate() {
    setRegenerating(true);
    setRegenError(null);
    try {
      const res = await fetch("/api/mcq-bank/regenerate-question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankId, questionIndex: originalIndex }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error ?? "Regeneration failed");
      onUpdated(originalIndex, data.mcq as Partial<MCQ>);
    } catch (e) {
      setRegenError(e instanceof Error ? e.message : "Regeneration failed");
    } finally {
      setRegenerating(false);
    }
  }

  const diffBadge =
    difficulty === "Easy"
      ? "bg-blue-50 text-blue-600 border-blue-200"
      : difficulty === "Medium"
      ? "bg-amber-50 text-amber-600 border-amber-200"
      : "bg-rose-50 text-rose-600 border-rose-200";

  const sl = searchTerm.toLowerCase().trim();

  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm hover:border-purple-300 hover:shadow-md transition-all duration-300 min-w-0">
      {/* Hover glow */}
      <div className="absolute inset-0 bg-gradient-to-br from-purple-50 to-indigo-50 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />

      <div className="relative flex flex-row items-stretch flex-1">
        {/* Left sidebar: index */}
        <div
          className="flex w-14 shrink-0 flex-col items-center justify-start gap-2 border-r border-gray-100 bg-gray-50 p-3 cursor-pointer"
          onClick={onOpen}
        >
          <span className="text-[9px] font-bold uppercase tracking-widest text-gray-400 font-mono">#</span>
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-gray-200 bg-white text-sm font-mono font-bold text-purple-700 shadow-sm group-hover:border-purple-300">
            {originalIndex + 1}
          </div>
        </div>

        {/* Main content — click opens analytics modal */}
        <div className="flex flex-1 flex-col px-4 pb-4 pt-3 min-w-0 cursor-pointer" onClick={onOpen}>
          {/* Top row: difficulty + status icons */}
          <div className="mb-1.5 flex items-center justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`flex h-6 w-6 items-center justify-center rounded border text-[11px] font-black ${diffBadge}`}
                title={difficulty}>
                {difficulty[0]}
              </span>
              {isAnnexureMcq(mcq) && (
                <span
                  className="inline-flex items-center gap-1 rounded border border-teal-200 bg-teal-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-teal-700"
                  title="Generated from linked annexure content"
                >
                  <Paperclip className="h-3 w-3" />
                  Annex
                </span>
              )}
              {isCreativeMcq(mcq) && (
                <span
                  className="inline-flex items-center gap-1 rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700"
                  title="Creative scenario fill near bank cap"
                >
                  <Sparkles className="h-3 w-3" />
                  Creative
                </span>
              )}
              {gu && (
                <button
                  onClick={(e) => { e.stopPropagation(); setShowGu((v) => !v); }}
                  title={
                    gu.isStale
                      ? "Gujarati translation is out of date — the English question changed since it was made"
                      : "Show this question in Gujarati"
                  }
                  className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide transition ${
                    gu.isStale
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : showGu
                      ? "border-indigo-300 bg-indigo-600 text-white"
                      : "border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                  }`}
                >
                  <Languages className="h-3 w-3" />
                  {showGu ? "EN" : "ગુજ"}
                  {gu.isStale ? " • stale" : ""}
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {mcq.isSimilar && (
                <div className="rounded border border-amber-200 bg-amber-50 p-1 text-amber-600" title="Flagged as Similar">
                  <Copy className="h-3.5 w-3.5" />
                </div>
              )}
              {mcq.isChecked && (
                <div className="rounded border border-purple-200 bg-purple-50 p-1 text-purple-600" title="Approved">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </div>
              )}
              {mcq.isReviewed && (
                <div className="rounded border border-blue-200 bg-blue-50 p-1 text-blue-600" title="Reviewed">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </div>
              )}
            </div>
          </div>

          {/* Question text */}
          <div className="mb-2.5 min-w-0">
            <div className="flex min-w-0 items-start gap-1.5">
              <span className="mt-px shrink-0 select-none text-[15px] font-black text-purple-600">Q.</span>
              <p className={`flex-1 min-w-0 break-words text-[15px] font-bold leading-snug text-gray-800 line-clamp-3 ${regenerating ? "opacity-40" : ""}`}>
                {sl ? highlight(view.question, sl) : view.question}
              </p>
            </div>
            {regenerating && (
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-violet-600">
                <Loader2 className="h-3 w-3 animate-spin" />
                Regenerating with Claude…
              </div>
            )}
            {regenError && !regenerating && (
              <div className="mt-1.5 text-[11px] font-semibold text-rose-600">{regenError}</div>
            )}
          </div>

          {/* Options 2×2 */}
          <div className="grid flex-1 grid-cols-2 gap-2">
            {(view.options || []).slice(0, 4).map((opt, oi) => {
              const isCorrect = opt === view.correctAnswer;
              return (
                <div key={oi}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-3 text-[13px] font-medium ${
                    isCorrect
                      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                      : "border-gray-100 bg-gray-50 text-gray-600"
                  }`}>
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold ${
                    isCorrect ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-500"
                  }`}>
                    {String.fromCharCode(65 + oi)}
                  </span>
                  <span className="min-w-0 flex-1 break-words leading-snug">
                    {sl ? highlight(opt, sl) : opt}
                  </span>
                  {isCorrect && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right action toolbar */}
        <div
          className="flex w-11 shrink-0 flex-col items-center justify-center gap-1.5 border-l border-gray-100 bg-gray-50 p-2"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Similar */}
          <button disabled={!!updating || regenerating}
            onClick={() => toggle("isSimilar")}
            title="Toggle Similar"
            className={`rounded-lg p-2 transition-all disabled:opacity-40 ${
              mcq.isSimilar
                ? "bg-amber-500 text-white shadow-sm"
                : "border border-gray-200 bg-white text-gray-400 hover:border-amber-200 hover:bg-amber-50 hover:text-amber-600"
            }`}>
            {updating === "isSimilar" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          {/* Approve */}
          <button disabled={!!updating || regenerating}
            onClick={() => toggle("isChecked")}
            title="Approve"
            className={`rounded-lg p-2 transition-all disabled:opacity-40 ${
              mcq.isChecked
                ? "bg-emerald-500 text-white shadow-sm"
                : "border border-gray-200 bg-white text-gray-400 hover:border-emerald-200 hover:bg-emerald-50 hover:text-emerald-600"
            }`}>
            {updating === "isChecked" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          </button>
          {/* Review */}
          <button disabled={!!updating || regenerating}
            onClick={() => toggle("isReviewed")}
            title="Mark Reviewed"
            className={`rounded-lg p-2 transition-all disabled:opacity-40 ${
              mcq.isReviewed
                ? "bg-blue-500 text-white shadow-sm"
                : "border border-gray-200 bg-white text-gray-400 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
            }`}>
            {updating === "isReviewed" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          </button>
          {/* Regenerate (Claude) */}
          <button disabled={!!updating || regenerating}
            onClick={regenerate}
            title="Regenerate this question with Claude"
            className="rounded-lg border border-gray-200 bg-white p-2 text-gray-400 transition-all hover:border-violet-200 hover:bg-violet-50 hover:text-violet-600 disabled:opacity-40">
            {regenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}

interface MCQViewerModalProps {
  bankId: string;
  onClose: () => void;
  onBack?: () => void;
}

interface SiblingBank {
  langCode: "EN" | "GU";
  bankId: string;
}

// Current active version of this SOP family, resolved from the Dashboard registry.
// The bank doc may store an older version's identifier/name; this is the truth.
interface CurrentVersion {
  identifier: string;
  version: string;
  name: string;
  nameGujarati: string | null;
}

// Per-language version status: is a newer version of THIS bank's language live
// without regenerated MCQs? (English & Gujarati are compared independently.)
interface VersionStatus {
  language: "EN" | "GU";
  bankVersion: number;
  currentVersion: number;
  isOutdated: boolean;
}

export function MCQViewerModal({ bankId, onClose, onBack }: MCQViewerModalProps) {
  // The bank currently being viewed. Starts at the opened bank, but the EN/GU
  // toggle swaps it to the sibling-language bank of the same SOP family.
  const [activeBankId, setActiveBankId] = useState(bankId);
  const [siblings, setSiblings] = useState<SiblingBank[]>([]);
  const [current, setCurrent] = useState<CurrentVersion | null>(null);
  const [versionStatus, setVersionStatus] = useState<VersionStatus | null>(null);
  const [bank, setBank] = useState<MCQBank | null>(null);
  const [mcqs, setMcqs] = useState<MCQ[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Re-sync when a different SOP/bank is opened from outside.
  useEffect(() => { setActiveBankId(bankId); }, [bankId]);

  const [activeTab, setActiveTab] = useState<TabType>("active");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [visibleCount, setVisibleCount] = useState(BATCH);
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);
  const [isMaximized, setIsMaximized] = useState(true);
  const [selectedQuestion, setSelectedQuestion] = useState<{ mcq: MCQ; index: number } | null>(null);
  // Individual regeneration always uses Claude — this just reflects whether the
  // local Claude CLI/subscription is currently connected.
  const [claudeStatus, setClaudeStatus] = useState<{ ok: boolean; loading: boolean; mcqModel?: string; error?: string }>({
    ok: false,
    loading: true,
  });

  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/llm/claude-status")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const c = data.claude ?? {};
        setClaudeStatus({ ok: Boolean(data.success && c.loggedIn), mcqModel: c.mcqModel, error: c.error, loading: false });
      })
      .catch((e) => {
        if (cancelled) return;
        setClaudeStatus({ ok: false, loading: false, error: e instanceof Error ? e.message : "Could not check Claude status" });
      });
    return () => { cancelled = true; };
  }, []);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/mcq-bank/bank?id=${activeBankId}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed");
        if (!cancelled) {
          setBank(data.bank);
          setMcqs(data.bank?.mcqs ?? []);
          setSiblings(data.siblings ?? []);
          setCurrent(data.current ?? null);
          setVersionStatus(data.versionStatus ?? null);
          // Reset the scrolled-through window when the viewed bank changes.
          setVisibleCount(BATCH);
          setSelectedQuestion(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [activeBankId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") (onBack ?? onClose)(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack, onClose]);

  // Infinite scroll
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) {
        setVisibleCount((v) => v + 20);
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const sl = searchTerm.toLowerCase().trim();

  const filtered = mcqs.filter((q) => {
    if (statusFilter === "checked" && !q.isChecked) return false;
    if (statusFilter === "pending" && (q.isChecked || q.isReviewed)) return false;
    if (statusFilter === "similar" && !q.isSimilar) return false;
    if (statusFilter === "reviewed" && !q.isReviewed) return false;
    if (statusFilter === "annexure" && !isAnnexureMcq(q)) return false;
    if (statusFilter === "creative" && !isCreativeMcq(q)) return false;
    if (sl) {
      const qText = (q.question || "").toLowerCase();
      const opts = (q.options || []).join(" ").toLowerCase();
      if (!qText.includes(sl) && !opts.includes(sl)) return false;
    }
    return true;
  });

  const visible = filtered.slice(0, visibleCount);

  function handleUpdated(idx: number, patch: Partial<MCQ>) {
    setMcqs((prev) => prev.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  }

  const statusCounts = {
    all:      mcqs.length,
    checked:  mcqs.filter((q) => q.isChecked).length,
    pending:  mcqs.filter((q) => !q.isChecked && !q.isReviewed).length,
    similar:  mcqs.filter((q) => q.isSimilar).length,
    reviewed: mcqs.filter((q) => q.isReviewed).length,
    annexure: mcqs.filter((q) => isAnnexureMcq(q)).length,
    creative: mcqs.filter((q) => isCreativeMcq(q)).length,
  };

  // Gujarati coverage of THIS bank's master questions. Stale ones are counted
  // separately — the LMS will not serve them until they are re-translated.
  const guTranslated = mcqs.filter((q) => q.translations?.gu).length;
  const guStale = mcqs.filter((q) => q.translations?.gu?.isStale).length;

  const isGuj = (bank?.language ?? "").toLowerCase() === "gujarati";
  const langCode = isGuj ? "GU" : "EN";

  // Prefer the SOP family's CURRENT version (from the Dashboard) over whatever
  // version the bank was generated from, so the header stays in sync with the
  // Dashboard's current SOP No. / version.
  const displayIdentifier = current?.identifier ?? bank?.sopIdentifier ?? "";
  const displayName = current
    ? (isGuj ? (current.nameGujarati ?? current.name) : current.name)
    : (bank?.sopName ?? "");
  // A newer version of this language is live but its MCQs were never generated.
  const isOutdated = Boolean(versionStatus?.isOutdated);

  // Sibling-language banks for the EN/GU flip. A language is only switchable when
  // this SOP family actually has a bank in that language.
  const enSibling = siblings.find((s) => s.langCode === "EN");
  const guSibling = siblings.find((s) => s.langCode === "GU");
  const switchLang = (target: SiblingBank | undefined) => {
    if (target && target.bankId !== activeBankId) setActiveBankId(target.bankId);
  };

  const filterPills = [
    { id: "all" as const,      label: "All",      icon: <Grid className="h-3.5 w-3.5" />,        activeClass: "text-indigo-400" },
    { id: "checked" as const,  label: "Approved",  icon: <CheckCircle2 className="h-3.5 w-3.5" />, activeClass: "text-emerald-400" },
    { id: "pending" as const,  label: "Pending",   icon: <Loader2 className="h-3.5 w-3.5" />,      activeClass: "text-orange-400" },
    { id: "similar" as const,  label: "Similar",   icon: <Copy className="h-3.5 w-3.5" />,          activeClass: "text-amber-400" },
    { id: "reviewed" as const, label: "Reviewed",  icon: <CheckCircle2 className="h-3.5 w-3.5" />,  activeClass: "text-blue-400" },
    { id: "annexure" as const, label: "Annexure",  icon: <Paperclip className="h-3.5 w-3.5" />,     activeClass: "text-teal-400" },
    { id: "creative" as const, label: "Creative",  icon: <Sparkles className="h-3.5 w-3.5" />,      activeClass: "text-violet-400" },
  ] as const;

  return (
    <div className="fixed inset-0 z-[60] flex animate-in fade-in duration-300">
      <div className="flex h-full w-full flex-col bg-[#f8f9fa]">

        {/* ── Sticky header ── */}
        <div className="sticky top-0 z-20 shrink-0 border-b border-gray-200 bg-white">
          {/* Brand / nav row */}
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex min-w-0 items-center gap-4">
              <button
                type="button"
                onClick={onBack ?? onClose}
                title={onBack ? "Back to previous screen" : "Close"}
                className="rounded-xl border border-gray-200 bg-gray-100 p-2 text-gray-500 hover:bg-gray-200 hover:text-gray-800 transition-all"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>

              {bank && (
                <div className="flex min-w-0 flex-col">
                  <div className="mb-0.5 flex items-center gap-2">
                    <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-purple-600">
                      SOP Identifier
                    </span>
                    <span className="h-1 w-1 rounded-full bg-gray-300" />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                      {bank.language ?? "English"} Version{current ? ` · v${current.version}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <h2 className="shrink-0 text-xl font-bold text-gray-800">
                      {displayName}
                    </h2>
                    <span className="rounded-lg border border-purple-200 bg-purple-50 px-2 py-0.5 font-mono text-xs font-bold text-purple-700">
                      {displayIdentifier}
                    </span>
                    {isOutdated && (
                      <span
                        className="flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider text-rose-600"
                        title={`A newer version (v${versionStatus?.currentVersion}) of this SOP is live — its MCQs have not been generated yet. These questions are from v${versionStatus?.bankVersion}.`}
                      >
                        <RefreshCw className="h-3 w-3" />
                        v{versionStatus?.currentVersion} not generated
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              {/* Selected-AI indicator for individual question regeneration — always Claude */}
              <div
                title={
                  claudeStatus.loading
                    ? "Checking Claude connection…"
                    : claudeStatus.ok
                    ? `Individual regeneration uses Claude (${claudeStatus.mcqModel ?? "claude-haiku"})`
                    : `Claude not connected: ${claudeStatus.error ?? "unknown error"}`
                }
                className={`hidden items-center gap-1.5 rounded-xl border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider sm:flex ${
                  claudeStatus.loading
                    ? "border-gray-200 bg-gray-50 text-gray-400"
                    : claudeStatus.ok
                    ? "border-violet-200 bg-violet-50 text-violet-700"
                    : "border-rose-200 bg-rose-50 text-rose-600"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {claudeStatus.loading ? "Claude…" : claudeStatus.ok ? "Claude ✓" : "Claude !"}
              </div>

              {bank && (
                <div className="hidden items-center justify-center rounded-lg border border-purple-200 bg-purple-50 px-2 py-1 md:flex min-w-[2.5rem]">
                  <span className="text-[11px] font-bold text-purple-700">{filtered.length}</span>
                </div>
              )}

              <div className="mx-2 h-8 w-px bg-gray-200" />

              <div className="flex items-center gap-1">
                {/* Search toggle */}
                <button type="button"
                  onClick={() => { setSearchVisible((v) => !v); if (searchVisible) { setSearchInput(""); setSearchTerm(""); } }}
                  className={`rounded-xl border p-2 transition-all ${
                    searchVisible || searchTerm
                      ? "border-purple-200 bg-purple-100 text-purple-700"
                      : "border-transparent text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                  }`}>
                  <Search className="h-5 w-5" />
                </button>

                {/* Check Similar */}
                <button type="button"
                  className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs font-bold uppercase tracking-wider text-amber-700 hover:bg-amber-100 transition-all">
                  <ScanSearch className="h-4 w-4" />
                  <span className="hidden sm:inline">Check Similar</span>
                </button>

                {/* Smart Regenerate */}
                <button type="button"
                  className="flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2 text-xs font-bold uppercase tracking-wider text-violet-700 hover:bg-violet-100 transition-all">
                  <Sparkles className="h-4 w-4" />
                  <span className="hidden sm:inline">Smart Regenerate</span>
                </button>

                {/* Gujarati translation coverage of this bank's master questions */}
                {langCode === "EN" && mcqs.length > 0 && (
                  <div
                    title={
                      guStale > 0
                        ? `${guStale} translation(s) out of date — re-run scripts/translate-mcqs.ts`
                        : "Master questions available in Gujarati"
                    }
                    className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[10px] font-bold uppercase tracking-wider ${
                      guStale > 0
                        ? "border-amber-200 bg-amber-50 text-amber-700"
                        : guTranslated === mcqs.length
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-gray-200 bg-gray-50 text-gray-500"
                    }`}
                  >
                    <Languages className="h-4 w-4" />
                    ગુજ {guTranslated}/{mcqs.length}
                    {guStale > 0 ? ` • ${guStale} stale` : ""}
                  </div>
                )}

                {/* EN/GU toggle — flips between the English & Gujarati banks of this SOP */}
                <div className="flex overflow-hidden rounded-xl border border-gray-200">
                  <button type="button"
                    onClick={() => switchLang(enSibling)}
                    disabled={!enSibling || langCode === "EN"}
                    title={enSibling ? "View English version" : "No English version for this SOP"}
                    className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition-all ${
                      langCode === "EN"
                        ? "bg-purple-100 text-purple-700"
                        : enSibling
                        ? "bg-white text-gray-500 hover:bg-gray-100 cursor-pointer"
                        : "bg-white text-gray-300 cursor-not-allowed"
                    }`}>EN</button>
                  <button type="button"
                    onClick={() => switchLang(guSibling)}
                    disabled={!guSibling || langCode === "GU"}
                    title={guSibling ? "View Gujarati version" : "No Gujarati version for this SOP"}
                    className={`px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition-all ${
                      langCode === "GU"
                        ? "bg-purple-100 text-purple-700"
                        : guSibling
                        ? "bg-white text-gray-500 hover:bg-gray-100 cursor-pointer"
                        : "bg-white text-gray-300 cursor-not-allowed"
                    }`}>GU</button>
                </div>

                {/* Reset & Regen */}
                <button type="button"
                  className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-bold uppercase tracking-wider text-rose-700 hover:bg-rose-100 transition-all">
                  <RotateCcw className="h-4 w-4" />
                  <span className="hidden sm:inline">Reset &amp; Regen</span>
                </button>

                {/* Maximize/Minimize */}
                <button type="button" onClick={() => setIsMaximized((v) => !v)}
                  className="rounded-xl border border-transparent p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-all">
                  {isMaximized ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />}
                </button>

                {/* Close */}
                <button type="button" onClick={onClose}
                  className="rounded-xl border border-transparent p-2 text-gray-400 hover:border-red-200 hover:bg-red-50 hover:text-red-600 transition-all">
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
          </div>

          {/* Sub-header: search + filter */}
          <div className="space-y-4 px-6 pb-4">
            {searchVisible && (
              <div className="relative animate-in slide-in-from-top-2 duration-300">
                <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-indigo-400/60" />
                <input autoFocus type="text" value={searchInput}
                  onChange={(e) => { setSearchInput(e.target.value); setVisibleCount(BATCH); }}
                  placeholder="Search questions, references, or codes..."
                  className="w-full rounded-2xl border border-gray-300 py-3 pl-11 pr-12 text-sm text-gray-800 placeholder-gray-400 shadow-sm focus:border-purple-300 focus:outline-none focus:ring-2 focus:ring-purple-200 hover:border-purple-300 transition-all" />
                {searchTerm && (
                  <button type="button" onClick={() => { setSearchInput(""); setSearchTerm(""); }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-gray-100 p-1 text-gray-400 hover:text-gray-700">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            )}

            {/* Tabs + status filters */}
            <div className="flex items-center justify-between gap-4">
              {/* Tabs */}
              <nav className="flex items-center gap-1.5 rounded-2xl border border-gray-200 bg-gray-100 p-1.5 shadow-inner">
                <button type="button"
                  onClick={() => { setActiveTab("active"); setVisibleCount(BATCH); }}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                    activeTab === "active"
                      ? "bg-purple-600 text-white shadow-sm"
                      : "text-gray-500 hover:bg-white hover:text-gray-700"
                  }`}>
                  <Grid className="h-3 w-3" />
                  Active ({mcqs.length})
                </button>
                <button type="button"
                  onClick={() => setActiveTab("recycled")}
                  className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition-all ${
                    activeTab === "recycled"
                      ? "bg-rose-600 text-white shadow-sm"
                      : "text-gray-500 hover:bg-white hover:text-gray-700"
                  }`}>
                  <Trash2 className="h-3 w-3" />
                  Recycled
                </button>
              </nav>

              {/* Status filter pills */}
              {activeTab === "active" && (
                <div className="flex items-center gap-2">
                  <span className="mr-1 hidden text-[10px] font-bold uppercase tracking-widest text-gray-400 sm:inline">
                    Status Filter
                  </span>
                  <div className="flex gap-1 rounded-xl border border-gray-200 bg-gray-100 p-1 shadow-inner">
                    {filterPills.map((pill) => (
                      <button key={pill.id} type="button"
                        onClick={() => { setStatusFilter(pill.id); setVisibleCount(BATCH); }}
                        className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px] font-bold transition-all ${
                          statusFilter === pill.id
                            ? `border-gray-200 bg-white shadow-sm ${pill.activeClass}`
                            : "border-transparent text-gray-400 hover:bg-white hover:text-gray-700"
                        }`}>
                        {pill.icon}
                        {pill.label} ({statusCounts[pill.id]})
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Body ── */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto border-x border-gray-200 bg-[#f8f9fa] px-0">
          {loading ? (
            <div className="flex h-64 items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
            </div>
          ) : error ? (
            <div className="m-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          ) : activeTab === "recycled" ? (
            <div className="flex h-64 items-center justify-center text-sm text-gray-400">
              No recycled questions
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-3xl border border-gray-200 bg-gray-100 shadow-sm">
                <Search className="h-8 w-8 text-gray-400" />
              </div>
              <h3 className="mb-2 text-xl font-bold text-gray-700">No results found</h3>
              <p className="max-w-xs text-gray-500">Adjust your filters to see more questions.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-2">
              {visible.map((mcq, i) => {
                const originalIndex = mcqs.indexOf(mcq);
                return (
                  <QuestionCard
                    key={originalIndex}
                    mcq={mcq}
                    originalIndex={originalIndex}
                    bankId={activeBankId}
                    searchTerm={searchTerm}
                    onUpdated={handleUpdated}
                    onOpen={() => setSelectedQuestion({ mcq, index: originalIndex })}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Question Analytics Modal */}
      {selectedQuestion && (
        <QuestionAnalyticsModal
          mcq={selectedQuestion.mcq}
          index={selectedQuestion.index}
          bankId={activeBankId}
          sopIdentifier={displayIdentifier}
          onClose={() => setSelectedQuestion(null)}
          onUpdated={(idx, patch) => {
            handleUpdated(idx, patch);
            setSelectedQuestion((prev) =>
              prev ? { ...prev, mcq: { ...prev.mcq, ...patch } } : null
            );
          }}
        />
      )}
    </div>
  );
}
