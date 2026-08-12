"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  Copy,
  Cpu,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  Home,
  LayoutList,
  Loader2,
  Lock,
  Minimize2,
  Monitor,
  Paperclip,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { MCQViewerModal } from "./MCQViewerModal";
import { DeptDetailModal } from "./DeptDetailModal";
import { DeptGridSkeleton } from "./MCQSkeleton";
import { displaySopCode, displaySopTitle } from "@/lib/sop-display";
import { normalizeSopIdentifierKey } from "@/lib/sopIdentifierNormalize";
import {
  mcqAnnexureStatusClass,
  mcqAnnexureStatusTitle,
  type McqAnnexureStatus,
} from "@/lib/mcqAnnexureStatus";
import { isAdmin } from "@/lib/roles";
import type { AppRole } from "@/lib/auth";

type McqGenProvider = "claude" | "codex" | "ollama";

interface DeptMCQStats {
  department: string;
  sopCount: number;
  subcategories: number;
  totalQuestions: number;
  checkedQuestions: number;
  reviewedQuestions: number;
  similarQuestions: number;
  remainingQuestions: number;
  mcqCoverage: number;
  withEnglish: number;
  withGujarati: number;
  totalSopEng: number;
  totalSopGuj: number;
  approvedSops: number;
  partialSops: number;
  pendingSops: number;
  similarSops: number;
  sopWithMcqs: number;
  sopWithoutMcqs: number;
  enRemaining: number;
  guRemaining: number;
  trainer: string | null;
}

interface MCQBankGlobalStats {
  totalUniqueSops: number;
  totalVersions: number;
  totalMcqBanks: number;
  mcqFound: number;
  notFound: number;
  withEnglish: number;
  withGujarati: number;
  approvedSops: number;
  partialSops: number;
  pendingSops: number;
  similarSops: number;
  totalQuestions: number;
  checkedQuestions: number;
  reviewedQuestions: number;
  similarQuestions: number;
  remainingQuestions: number;
  enRemaining: number;
  guRemaining: number;
  departments: DeptMCQStats[];
  obsoleteMcqs?: {
    count: number;
    identifiers: string[];
    totalQuestions: number;
  };
}

interface RegistryEntry {
  id: string;
  identifier: string;
  sopName: string;
  sopNameGujarati: string | null;
  department: string;
  language: string;
  langCode: string;
  totalMcqs: number;
  remaining: number;
  approved: number;
  partial: number;
  similar: number;
  easyCount: number;
  mediumCount: number;
  hardCount: number;
  lastUpdated: string | null;
  banks: { id: string; langCode: "ENG" | "GUJ" }[];
  /** True when the family has real questions in every required language — the
   *  same "MCQ Found" criterion as the dashboard capsule. */
  hasMcq: boolean;
  /** Per-language MCQ presence — backs the capsule "w/ EN" / "w/ GU" filters. */
  hasEnMcq: boolean;
  hasGuMcq: boolean;
  enMcqCount: number;
  guMcqCount: number;
  isObsoleteMcq?: boolean;
  /** Count of annexure files linked to this SOP family — included in MCQ
   *  generation prompts when > 0. */
  annexureCount: number;
  /** Whether the current MCQs were actually generated from those annexures. */
  annexureStatus: McqAnnexureStatus;
  annexureIncludedLabels: string[];
}

type McqLang = "English" | "Gujarati";
type McqDeleteScope = "eng" | "guj" | "both";
const MCQ_BANK_CAP = 100;

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────
// Password required to regenerate an SOP's MCQ bank (archives the current bank
// and generates a fresh set). Gate is client-side only — it guards against
// accidental clicks, not a determined user.
const REGEN_PASSWORD = "indiana132";

const fmt = (n: number | undefined | null) => (n == null ? "—" : n.toLocaleString());
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "—";

function deleteScopeLabel(scope: McqDeleteScope): string {
  if (scope === "eng") return "English MCQs";
  if (scope === "guj") return "Gujarati MCQs";
  return "both English and Gujarati MCQs";
}

// ─────────────────────────────────────────────────────────────
// Department theme (bordered white cards)
// ─────────────────────────────────────────────────────────────
function getDeptTheme(deptName: string) {
  const name = deptName.toLowerCase();
  if (name.includes("qa"))
    return { border: "border-purple-500", statBg: "bg-purple-50", iconBg: "bg-purple-100", iconText: "text-purple-600", accent: "text-purple-600", headerBorder: "border-b border-purple-100", capBg: "bg-purple-50 border-purple-200", pendingText: "text-purple-700", cardBg: "" };
  if (name.includes("qc"))
    return { border: "border-blue-500", statBg: "bg-blue-50", iconBg: "bg-blue-100", iconText: "text-blue-600", accent: "text-blue-600", headerBorder: "border-b border-blue-100", capBg: "bg-blue-50 border-blue-200", pendingText: "text-blue-700", cardBg: "" };
  if (name.includes("micro"))
    return { border: "border-orange-500", statBg: "bg-orange-50", iconBg: "bg-orange-100", iconText: "text-orange-600", accent: "text-orange-600", headerBorder: "border-b border-orange-100", capBg: "bg-orange-50 border-orange-200", pendingText: "text-orange-700", cardBg: "" };
  if (name.includes("prod"))
    return { border: "border-emerald-500", statBg: "bg-emerald-50", iconBg: "bg-emerald-100", iconText: "text-emerald-600", accent: "text-emerald-600", headerBorder: "border-b border-emerald-100", capBg: "bg-emerald-50 border-emerald-200", pendingText: "text-emerald-700", cardBg: "" };
  if (name.includes("store"))
    return { border: "border-amber-500", statBg: "bg-amber-50", iconBg: "bg-amber-100", iconText: "text-amber-600", accent: "text-amber-600", headerBorder: "border-b border-amber-100", capBg: "bg-amber-50 border-amber-200", pendingText: "text-amber-700", cardBg: "" };
  if (name.includes("engineer") || name.includes("maint"))
    return { border: "border-cyan-500", statBg: "bg-cyan-50", iconBg: "bg-cyan-100", iconText: "text-cyan-600", accent: "text-cyan-600", headerBorder: "border-b border-cyan-100", capBg: "bg-cyan-50 border-cyan-200", pendingText: "text-cyan-700", cardBg: "" };
  if (name.includes("person") || name.includes("hr"))
    return { border: "border-rose-500", statBg: "bg-rose-50", iconBg: "bg-rose-100", iconText: "text-rose-600", accent: "text-rose-600", headerBorder: "border-b border-rose-100", capBg: "bg-rose-50 border-rose-200", pendingText: "text-rose-700", cardBg: "" };
  return { border: "border-slate-400", statBg: "bg-slate-50", iconBg: "bg-slate-100", iconText: "text-slate-600", accent: "text-slate-600", headerBorder: "border-b border-slate-100", capBg: "bg-slate-50 border-slate-200", pendingText: "text-slate-700", cardBg: "" };
}

// Map a department name → the { bg } class DeptDetailModal uses to pick its
// header gradient. Keys must match DEPT_GRADIENT in DeptDetailModal.tsx.
function getDeptModalColor(deptName: string): { bg: string; badge: string } {
  const name = deptName.toLowerCase();
  if (name.includes("qa")) return { bg: "bg-violet-600", badge: "bg-violet-100 text-violet-700" };
  if (name.includes("qc")) return { bg: "bg-blue-600", badge: "bg-blue-100 text-blue-700" };
  if (name.includes("micro")) return { bg: "bg-orange-600", badge: "bg-orange-100 text-orange-700" };
  if (name.includes("prod")) return { bg: "bg-emerald-600", badge: "bg-emerald-100 text-emerald-700" };
  if (name.includes("store")) return { bg: "bg-amber-600", badge: "bg-amber-100 text-amber-700" };
  if (name.includes("engineer") || name.includes("maint")) return { bg: "bg-cyan-600", badge: "bg-cyan-100 text-cyan-700" };
  if (name.includes("person") || name.includes("hr")) return { bg: "bg-rose-600", badge: "bg-rose-100 text-rose-700" };
  return { bg: "bg-slate-600", badge: "bg-slate-100 text-slate-700" };
}

// ─────────────────────────────────────────────────────────────
// CapsuleMetric — compact label + value row
// ─────────────────────────────────────────────────────────────
function CM({
  label, value, vc, onClick, isActive = false,
}: {
  label: string; value: number; vc?: string;
  onClick?: () => void; isActive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick ? (e) => { e.preventDefault(); e.stopPropagation(); onClick(); } : undefined}
      aria-pressed={isActive || undefined}
      className={`flex w-full min-h-[24px] cursor-pointer items-center justify-between gap-1.5 rounded-[4px] px-1 py-0.5 text-left text-[10px] transition-colors hover:bg-purple-100/80 active:bg-purple-200/60 focus:outline-none focus:ring-1 focus:ring-purple-400 ${
        isActive ? "border border-purple-400 bg-purple-100/90" : "border border-transparent"
      }`}
    >
      <span className="min-w-0 shrink text-gray-700 font-semibold whitespace-nowrap overflow-hidden text-ellipsis">{label}</span>
      <span className={`font-bold tabular-nums shrink-0 leading-tight text-[11px] ${vc ?? "text-gray-900"}`}>{value}</span>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// TripleRow — 3 CMs side by side
// ─────────────────────────────────────────────────────────────
function TripleRow({ items }: {
  items: { label: string; value: number; vc?: string; onClick?: () => void; isActive?: boolean }[];
}) {
  return (
    <div className="flex w-full gap-0.5">
      {items.map((item) => (
        <div key={item.label} className="flex-1 min-w-0">
          <CM label={item.label} value={item.value} vc={item.vc} onClick={item.onClick} isActive={item.isActive} />
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CovBar — coverage progress bar
// ─────────────────────────────────────────────────────────────
function CovBar({ pct, label = "COVERAGE" }: { pct: number; label?: string }) {
  return (
    <div className="pt-1.5 mt-1.5 border-t border-gray-100">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[8px] font-bold text-gray-400 uppercase tracking-wider">{label}</span>
        <span className={`text-[9px] font-black ${pct >= 100 ? "text-emerald-600" : pct >= 60 ? "text-blue-600" : "text-amber-500"}`}>{pct}%</span>
      </div>
      <div className="w-full h-[3px] bg-gray-100 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${pct >= 100 ? "bg-emerald-500" : pct >= 60 ? "bg-blue-500" : "bg-amber-500"}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Compact whitebox Card (MCQ Status Cards section)
// ─────────────────────────────────────────────────────────────
function StatusCard({
  title, subtitle, isGrand = false,
  totalSOPs, sopWithMCQs, sopWithoutMCQs,
  approvedSOPs, partialSOPs, pendingSOPs, similarSOPs,
  totalSopEng, totalSopGuj, remainingEng, remainingGuj,
  mcqFound, mcqNotFound,
  genCompleted, genTarget, genRemaining,
  onOpen, onRowClick,
  onMcqWithClick, onMcqWithoutClick,
  onLangEnClick, onLangGuClick,
}: {
  title: string; subtitle: string; isGrand?: boolean;
  totalSOPs: number; sopWithMCQs: number; sopWithoutMCQs: number;
  approvedSOPs: number; partialSOPs: number; pendingSOPs: number; similarSOPs: number;
  totalSopEng: number; totalSopGuj: number; remainingEng: number; remainingGuj: number;
  mcqFound?: number; mcqNotFound?: number;
  genCompleted?: number; genTarget?: number; genRemaining?: number;
  onOpen?: () => void;
  onRowClick?: (f: "approved" | "partial" | "pending" | "similar") => void;
  onMcqWithClick?: () => void;
  onMcqWithoutClick?: () => void;
  onLangEnClick?: () => void;
  onLangGuClick?: () => void;
}) {
  return (
    <div className={`flex h-full w-full min-w-0 flex-col rounded-[10px] border px-2 py-1.5 text-left shadow-sm ${
      isGrand ? "border-purple-300 bg-purple-50" : "border-gray-200 bg-white"
    }`}>
      {/* Header */}
      <div
        role={isGrand || !onOpen ? undefined : "button"}
        tabIndex={isGrand || !onOpen ? -1 : 0}
        onClick={isGrand ? undefined : onOpen}
        onKeyDown={isGrand || !onOpen ? undefined : (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen?.(); }
        }}
        className={`mb-2 flex w-full min-h-[40px] items-start gap-1.5 rounded-md border-b pb-2 ${
          isGrand || !onOpen
            ? "cursor-default border-purple-200"
            : "cursor-pointer border-gray-100 hover:bg-purple-50/80 focus:outline-none focus:ring-2 focus:ring-purple-400"
        }`}
      >
        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-purple-600" />
        <div className="min-w-0 flex-1">
          <span className="block min-w-0 text-[11px] font-bold leading-tight text-gray-800 truncate" title={title}>{title}</span>
          <span className="block text-[9px] font-medium text-gray-500 leading-tight mt-0.5">{subtitle}</span>
        </div>
      </div>

      {/* Summary block — same on Total and every department capsule */}
      <div className={`flex flex-col gap-0 border-t border-transparent pt-0.5 mb-1 ${isGrand ? "" : "border-b border-gray-100 pb-1"}`}>
        <CM label="Unique SOPs" value={totalSOPs} onClick={onOpen} />
        <CM label="MCQ Found" value={mcqFound ?? sopWithMCQs} vc="text-emerald-600" onClick={onMcqWithClick ?? onOpen} />
        <CM
          label="Not Found"
          value={mcqNotFound ?? sopWithoutMCQs}
          vc={(mcqNotFound ?? sopWithoutMCQs) > 0 ? "text-red-600" : "text-gray-900"}
          onClick={onMcqWithoutClick ?? onOpen}
        />
      </div>

      {/* SOP counts */}
      <div className="flex flex-col gap-0 border-t border-transparent pt-0.5">
        <CM label="SOPs" value={totalSOPs} onClick={onOpen} />
        <CM label="w/ MCQs" value={sopWithMCQs} vc="text-emerald-600" onClick={onMcqWithClick ?? onOpen} />
        <CM label="w/o MCQs" value={sopWithoutMCQs} vc={sopWithoutMCQs > 0 ? "text-red-600" : "text-gray-900"} onClick={onMcqWithoutClick ?? onOpen} />
        <CM label="w/ EN" value={totalSopEng} onClick={onLangEnClick} />
        <CM label="w/ GU" value={totalSopGuj} vc="text-orange-500" onClick={onLangGuClick} />
        <TripleRow items={[
          { label: "Approved", value: approvedSOPs, vc: "text-emerald-600", onClick: onRowClick ? () => onRowClick("approved") : undefined },
          { label: "Partial",  value: partialSOPs,  vc: "text-amber-500",  onClick: onRowClick ? () => onRowClick("partial")  : undefined },
          { label: "Pending",  value: pendingSOPs,  vc: "text-red-600",    onClick: onRowClick ? () => onRowClick("pending")  : undefined },
        ]} />
        <CM label="Similar" value={similarSOPs} onClick={onRowClick ? () => onRowClick("similar") : undefined} />
      </div>

      {/* Remaining language slots */}
      <div className={`mt-1.5 pt-1.5 border-t ${isGrand ? "border-purple-200" : "border-gray-100"}`}>
        <div className="flex items-center gap-1.5 mb-1">
          <FileText className="h-3.5 w-3.5 shrink-0 text-amber-500" />
          <span className="min-w-0 flex-1 text-[11px] font-bold leading-tight text-gray-800">Lang Remaining</span>
        </div>
        <div className="flex flex-col gap-0">
          <TripleRow items={[
            { label: "EN rem.", value: remainingEng, vc: remainingEng > 0 ? "text-red-600" : "text-gray-900" },
            { label: "GU rem.", value: remainingGuj, vc: remainingGuj > 0 ? "text-red-600" : "text-gray-900" },
          ]} />
        </div>
      </div>

      {/* Generation section (Total only) */}
      {genCompleted !== undefined && (
        <div className={`mt-1.5 pt-1.5 border-t ${isGrand ? "border-purple-200" : "border-gray-100"}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <BookOpen className="h-3.5 w-3.5 shrink-0 text-blue-500" />
            <span className="min-w-0 flex-1 text-[11px] font-bold leading-tight text-gray-800">Generation</span>
          </div>
          <div className="flex flex-col gap-0">
            <CM label="Total SOPs" value={sopWithMCQs} vc="text-blue-600" />
            <TripleRow items={[
              { label: "Completed", value: genCompleted,     vc: "text-emerald-600" },
              { label: "Target",    value: genTarget ?? 0,   vc: "text-amber-500" },
              { label: "Remaining", value: genRemaining ?? 0, vc: "text-red-600" },
            ]} />
          </div>
        </div>
      )}

    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Colorful dept card (By Department section)
// ─────────────────────────────────────────────────────────────
function DeptColorCard({
  dept, onClick, onMcqWithClick, onMcqWithoutClick,
}: {
  dept: DeptMCQStats;
  onClick?: () => void;
  onMcqWithClick?: () => void;
  onMcqWithoutClick?: () => void;
}) {
  const theme = getDeptTheme(dept.department);
  const [expanded, setExpanded] = useState(false);
  const coveragePct = Math.min(dept.mcqCoverage, 100);

  // Coverage bar color matches accent
  const barColor = coveragePct >= 100 ? "bg-emerald-500" : coveragePct >= 60 ? "bg-blue-500" : "bg-amber-400";

  return (
    <div className={`rounded-xl border-2 ${theme.border} bg-white transition-all duration-300 shadow-sm hover:shadow-lg overflow-hidden group`}>
      {/* Clickable header area */}
      <div
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(); } }}
        className="w-full px-4 pt-4 pb-3 flex flex-col gap-0 bg-transparent transition-all text-left cursor-pointer"
      >
        {/* Header row */}
        <div className="flex items-center justify-between w-full mb-3">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${theme.iconBg} border border-current/10`}>
              <Folder className={`h-5 w-5 ${theme.iconText}`} />
            </div>
            <div>
              <h3 className={`text-base font-bold ${theme.accent}`}>{dept.department}</h3>
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                <p className="text-[10px] text-gray-400">
                  {dept.subcategories} Subcategor{dept.subcategories !== 1 ? "ies" : "y"}
                </p>
                {dept.trainer && (
                  <div className="flex items-center gap-1.5">
                    <span className="h-1 w-1 rounded-full bg-gray-300" />
                    <div className={`px-1.5 py-0.5 rounded border ${theme.capBg} text-[8px] font-black uppercase tracking-wider text-gray-700`}>
                      <span className="opacity-60 mr-1">Trainer:</span>{dept.trainer}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setExpanded((v) => !v); }}
            title={expanded ? "Collapse" : "Expand"}
            className={`h-6 w-6 rounded-full flex items-center justify-center border ${theme.border} ${theme.iconBg} ${theme.iconText} shrink-0 hover:opacity-80 transition-all duration-200`}
          >
            <ChevronDown className={`h-3 w-3 transition-transform duration-300 ${expanded ? "rotate-180" : ""}`} />
          </button>
        </div>

        {/* Top stats — SOP MCQ coverage */}
        <div className="grid grid-cols-3 gap-1.5 w-full mb-3">
          <div
            role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onClick?.(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick?.(); } }}
            className={`${theme.statBg} rounded-lg p-2 text-left border border-gray-100 cursor-pointer hover:opacity-90`}
          >
            <p className="text-gray-400 text-[8px] uppercase tracking-wider font-bold mb-0.5">SOPs</p>
            <span className={`text-base font-black leading-none ${theme.accent}`}>{dept.sopCount}</span>
          </div>
          <div
            role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onMcqWithClick?.(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onMcqWithClick?.(); } }}
            className="bg-emerald-50 rounded-lg p-2 text-left border border-emerald-100 cursor-pointer hover:opacity-90"
          >
            <p className="text-emerald-400 text-[8px] uppercase tracking-wider font-bold mb-0.5">w/ MCQs</p>
            <span className="text-base font-black leading-none text-emerald-600">{dept.sopWithMcqs}</span>
          </div>
          <div
            role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onMcqWithoutClick?.(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onMcqWithoutClick?.(); } }}
            className={`rounded-lg p-2 text-left border cursor-pointer hover:opacity-90 ${dept.sopWithoutMcqs > 0 ? "bg-red-50 border-red-100" : "bg-gray-50 border-gray-100"}`}
          >
            <p className="text-[8px] uppercase tracking-wider font-bold mb-0.5 text-gray-400">w/o MCQs</p>
            <span className={`text-base font-black leading-none ${dept.sopWithoutMcqs > 0 ? "text-red-600" : "text-gray-400"}`}>{dept.sopWithoutMcqs}</span>
          </div>
        </div>

        {/* Coverage bar */}
        <div className="w-full mb-3">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[8px] font-bold text-gray-400 uppercase tracking-wider">MCQ Coverage</span>
            <span className={`text-[9px] font-black ${theme.accent}`}>{coveragePct}%</span>
          </div>
          <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all duration-700 ${barColor}`} style={{ width: `${coveragePct}%` }} />
          </div>
        </div>

        {/* Status capsules */}
        <div className="grid grid-cols-2 gap-1.5 w-full mb-2">
          <div
            role="button" tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onClick?.(); }}
            className={`flex items-center gap-1.5 justify-between ${theme.capBg} border rounded-lg px-2.5 py-1.5 hover:opacity-80 transition-all cursor-pointer`}
          >
            <div className="flex items-center gap-1">
              <CheckCircle2 className="h-3 w-3 text-emerald-600 shrink-0" />
              <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wide">Approved</span>
            </div>
            <span className="text-sm font-black text-emerald-600 leading-none">{dept.approvedSops}</span>
          </div>
          <div className={`flex items-center gap-1.5 justify-between ${theme.capBg} border rounded-lg px-2.5 py-1.5`}>
            <div className="flex items-center gap-1">
              <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
              <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wide">Pending</span>
            </div>
            <span className="text-sm font-black text-amber-600 leading-none">{dept.pendingSops}</span>
          </div>
          <div className={`flex items-center gap-1.5 justify-between ${theme.capBg} border rounded-lg px-2.5 py-1.5`}>
            <div className="flex items-center gap-1">
              <Copy className="h-3 w-3 text-red-500 shrink-0" />
              <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wide">Similar</span>
            </div>
            <span className={`text-sm font-black leading-none ${dept.similarSops > 0 ? "text-red-500" : "text-gray-300"}`}>{dept.similarSops}</span>
          </div>
          <div className={`flex items-center gap-1.5 justify-between ${theme.capBg} border rounded-lg px-2.5 py-1.5`}>
            <div className="flex items-center gap-1">
              <FileText className="h-3 w-3 text-gray-400 shrink-0" />
              <span className="text-[9px] font-bold text-gray-500 uppercase tracking-wide">Remaining</span>
            </div>
            <span className={`text-sm font-black leading-none ${dept.sopWithoutMcqs > 0 ? "text-gray-700" : "text-gray-300"}`}>{dept.sopWithoutMcqs}</span>
          </div>
        </div>

        {/* Question breakdown badges */}
        {(dept.checkedQuestions > 0 || dept.similarQuestions > 0) && (
          <div className={`flex items-center gap-1.5 w-full ${theme.statBg} rounded-lg px-2 py-1.5 overflow-hidden flex-wrap border border-gray-100`}>
            <span className="text-[8px] font-bold text-gray-400 uppercase tracking-wider mr-0.5">Qs:</span>
            {dept.checkedQuestions > 0 && (
              <div className="flex items-center gap-1 bg-white px-1.5 py-0.5 rounded border border-gray-200">
                <CheckCircle2 className="h-2.5 w-2.5 text-emerald-500 shrink-0" />
                <span className="text-[9px] font-bold text-emerald-600 leading-none">{dept.checkedQuestions}</span>
                <span className="text-[8px] text-gray-400 leading-none">chkd</span>
              </div>
            )}
            {dept.reviewedQuestions > 0 && (
              <div className="flex items-center gap-1 bg-white px-1.5 py-0.5 rounded border border-gray-200">
                <Eye className="h-2.5 w-2.5 text-blue-500 shrink-0" />
                <span className="text-[9px] font-bold text-blue-600 leading-none">{dept.reviewedQuestions}</span>
                <span className="text-[8px] text-gray-400 leading-none">rvwd</span>
              </div>
            )}
            {dept.similarQuestions > 0 && (
              <div className="flex items-center gap-1 bg-white px-1.5 py-0.5 rounded border border-gray-200 animate-pulse">
                <AlertTriangle className="h-2.5 w-2.5 text-red-500 shrink-0" />
                <span className="text-[9px] font-bold text-red-500 leading-none">{dept.similarQuestions}</span>
                <span className="text-[8px] text-gray-400 leading-none">sim</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className={`border-t ${theme.border} ${theme.statBg} px-3 py-2 flex flex-col gap-1.5`}>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-gray-100">
            <FileText className={`h-3 w-3 ${theme.iconText} shrink-0`} />
            <span className="text-[9px] text-gray-500">
              <span className={`font-bold ${theme.accent}`}>{fmt(dept.totalQuestions)}</span> total questions ·
              <span className="font-bold text-emerald-600 ml-1">{dept.approvedSops}</span> approved SOPs
            </span>
          </div>
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-white border border-gray-200">
            <FolderOpen className={`h-3 w-3 ${theme.iconText} shrink-0`} />
            <span className="text-[9px] text-gray-500">{dept.subcategories} subcategor{dept.subcategories !== 1 ? "ies" : "y"} — click card to filter MCQ Registry</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Registry table row
// ─────────────────────────────────────────────────────────────
// Live per-row generation progress (mirrors the MCQGenJob status endpoint).
interface LangGenProgress {
  language: McqLang;
  status: string;
  inserted: number;
  target: number;
  collected: number;
  batchesDone: number;
  batchesTotal: number;
  skipped?: number;
}

interface GenProgress {
  status: "generating" | "completed" | "error" | "cancelled";
  mode?: "generate" | "regenerate" | "continue";
  languageScope?: McqLang;
  phase?: string;
  percent?: number;
  totalInserted?: number;
  totalSkipped?: number;
  totalFailedBatches?: number;
  languages?: LangGenProgress[];
  logs?: string[];
  error?: string;
  /** Epoch ms when this run was enqueued — ignores stale failed jobs from prior runs. */
  runStartedAt?: number;
}

function genModeLabel(mode?: GenProgress["mode"]): string {
  if (mode === "regenerate") return "Regenerating";
  if (mode === "continue") return "Continuing";
  return "Generating";
}

function McqGenProgressModal({
  entry,
  progress,
  onClose,
  onStop,
  stopping,
}: {
  entry: RegistryEntry;
  progress: GenProgress;
  onClose: () => void;
  onStop?: () => void;
  stopping?: boolean;
}) {
  const sopCode = displaySopCode(entry.identifier);
  const sopTitle = displaySopTitle(entry.sopName, entry.identifier);
  const isDone = progress.status === "completed";
  const isError = progress.status === "error";
  const isCancelled = progress.status === "cancelled";

  const langs = progress.languages?.length
    ? progress.languages
    : [{
        language: (progress.languageScope ?? "English") as McqLang,
        status: isDone ? "done" : "running",
        inserted: progress.totalInserted ?? 0,
        target: MCQ_BANK_CAP,
        collected: progress.languages?.[0]?.collected ?? progress.totalInserted ?? 0,
        batchesDone: 0,
        batchesTotal: 0,
        skipped: progress.totalSkipped,
      }];

  const totalInBank = langs.reduce((s, l) => s + Math.min(l.collected ?? 0, l.target || MCQ_BANK_CAP), 0);
  const totalInsertedRun = langs.reduce((s, l) => s + (l.inserted ?? 0), 0);
  const totalTarget = langs.reduce((s, l) => s + (l.target || MCQ_BANK_CAP), 0) || MCQ_BANK_CAP;
  const bankPercent = Math.min(100, Math.round((totalInBank / totalTarget) * 100));
  const barPercent = isDone ? bankPercent : Math.max(bankPercent, progress.percent ?? 0);

  const scopeLabel = progress.languageScope
    ? progress.languageScope === "Gujarati" ? "Gujarati" : "English"
    : langs.length > 1 ? "English & Gujarati" : langs[0]?.language ?? "MCQ";

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
        {/* Header */}
        <div className={`px-6 py-5 ${isError || isCancelled ? "bg-red-50" : isDone ? "bg-emerald-50" : "bg-gradient-to-br from-violet-600 to-indigo-700"}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {isDone ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
                ) : isError || isCancelled ? (
                  <AlertTriangle className="h-5 w-5 shrink-0 text-red-500" />
                ) : (
                  <Loader2 className="h-5 w-5 shrink-0 animate-spin text-white" />
                )}
                <h3 className={`text-sm font-bold ${isDone || isError || isCancelled ? "text-gray-800" : "text-white"}`}>
                  {isDone && totalInBank >= totalTarget
                    ? "MCQs Ready"
                    : isDone
                      ? totalInsertedRun > 0
                        ? "Partially Complete"
                        : "No MCQs Added"
                      : isCancelled
                        ? "Generation Stopped"
                        : isError
                          ? "Generation Failed"
                          : `${genModeLabel(progress.mode)} MCQs`}
                </h3>
              </div>
              <p className={`mt-1 font-mono text-[13px] font-bold tracking-wider ${isDone || isError || isCancelled ? "text-purple-700" : "text-white/90"}`}>
                {sopCode}
              </p>
              <p className={`mt-0.5 line-clamp-2 text-xs ${isDone || isError || isCancelled ? "text-gray-600" : "text-white/75"}`}>
                {sopTitle}
              </p>
              <p className={`mt-1 text-[11px] font-medium ${isDone || isError || isCancelled ? "text-gray-500" : "text-white/70"}`}>
                {entry.annexureCount > 0
                  ? `📎 Including ${entry.annexureCount} linked annexure${entry.annexureCount === 1 ? "" : "s"}`
                  : "No annexures linked — based on main SOP content only"}
              </p>
            </div>
            {(isDone || isError || isCancelled) && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-black/5 hover:text-gray-700"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        <div className="px-6 py-5 space-y-5">
          {!isError && !isCancelled && (
            <>
              {/* Main counter */}
              <div className="text-center">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">
                  {isDone ? "Created" : "Creating"} · {scopeLabel}
                </p>
                <p className="mt-1 tabular-nums">
                  <span className="text-4xl font-black text-gray-900">{fmt(totalInBank)}</span>
                  <span className="mx-1 text-2xl font-light text-gray-300">/</span>
                  <span className="text-2xl font-bold text-gray-400">{fmt(totalTarget)}</span>
                </p>
                {isDone && totalInsertedRun > 0 && (
                  <p className="mt-1 text-xs font-semibold text-emerald-600">+{fmt(totalInsertedRun)} new this run</p>
                )}
                <p className="mt-1 text-[11px] text-gray-500">
                  Target: {langs.length > 1 ? `${MCQ_BANK_CAP} MCQs per language` : `${MCQ_BANK_CAP} MCQs for this SOP`}
                </p>
              </div>

              {/* Progress bar */}
              <div>
                <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold text-gray-500">
                  <span>{progress.phase ?? (isDone ? "Complete" : "Working…")}</span>
                  <span className="tabular-nums text-gray-700">{barPercent}%</span>
                </div>
                <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100 shadow-inner">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ease-out ${
                      isDone ? "bg-emerald-500" : "bg-gradient-to-r from-violet-500 to-indigo-500"
                    }`}
                    style={{ width: `${barPercent}%` }}
                  />
                </div>
              </div>

              {/* Per-language breakdown */}
              {langs.length > 0 && (
                <div className="space-y-2">
                  {langs.map((lp) => {
                    const target = lp.target || MCQ_BANK_CAP;
                    const inBank = lp.collected ?? 0;
                    const pct = Math.min(100, Math.round((inBank / target) * 100));
                    const langShort = lp.language === "Gujarati" ? "GUJ" : "ENG";
                    return (
                      <div key={lp.language} className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2.5">
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <span className="text-[10px] font-bold uppercase tracking-wide text-gray-600">{langShort}</span>
                          <span className="text-[10px] font-bold tabular-nums text-gray-800">
                            {fmt(inBank)} / {fmt(target)}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
                          <div
                            className={`h-full rounded-full transition-all duration-500 ${
                              lp.language === "Gujarati" ? "bg-indigo-500" : "bg-blue-500"
                            }`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        {lp.batchesDone > 0 && (
                          <p className="mt-1 text-[9px] text-gray-400">
                            Batch {lp.batchesDone}{lp.batchesTotal ? ` / ${lp.batchesTotal}` : ""}
                            {(lp.skipped ?? 0) > 0 ? ` · ${lp.skipped} skipped` : ""}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Stats row */}
              {!isDone && (progress.totalSkipped != null || progress.totalFailedBatches) && (
                <div className="flex flex-wrap justify-center gap-3 text-[10px] text-gray-500">
                  <span><strong className="text-emerald-600">+{progress.totalInserted ?? 0}</strong> new</span>
                  <span><strong className="text-amber-600">{progress.totalSkipped ?? 0}</strong> skipped (duplicates)</span>
                  {(progress.totalFailedBatches ?? 0) > 0 && (
                    <span><strong className="text-red-500">{progress.totalFailedBatches}</strong> failed batches</span>
                  )}
                </div>
              )}

              {/* Live log */}
              {progress.logs && progress.logs.length > 0 && !isDone && (
                <div className="rounded-xl bg-gray-900 px-3 py-2.5 font-mono text-[10px] leading-relaxed text-green-400 max-h-28 overflow-y-auto space-y-0.5">
                  {progress.logs.slice(-8).map((line, i) => (
                    <div key={i} className="truncate" title={line}>{line}</div>
                  ))}
                </div>
              )}
            </>
          )}

          {(isError || isCancelled) && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {progress.error ?? (isCancelled ? "Generation was stopped. MCQs created so far are saved." : "Generation failed. Please try again.")}
            </div>
          )}

          {!isDone && !isError && !isCancelled && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[10px] leading-snug text-gray-400">
                You can close this window — generation keeps running on the server.
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-50"
                >
                  Run in background
                </button>
                {onStop && (
                  <button
                    type="button"
                    onClick={onStop}
                    disabled={stopping}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-rose-300 bg-rose-50 px-4 py-2 text-xs font-bold uppercase tracking-wide text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-60"
                  >
                    {stopping ? (
                      <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Stopping…</>
                    ) : (
                      <>Stop</>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}

          {(isDone || isError || isCancelled) && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className={`rounded-xl px-5 py-2 text-xs font-bold uppercase tracking-wide text-white transition-colors ${
                  isDone ? "bg-emerald-600 hover:bg-emerald-700" : "bg-gray-700 hover:bg-gray-800"
                }`}
              >
                {isDone ? "Done" : "Close"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function genBankProgress(progress: GenProgress) {
  const langs = progress.languages?.length
    ? progress.languages
    : [{
        collected: progress.totalInserted ?? 0,
        target: MCQ_BANK_CAP,
      }];
  const totalInBank = langs.reduce(
    (s, l) => s + Math.min(l.collected ?? 0, l.target || MCQ_BANK_CAP),
    0,
  );
  const totalTarget = langs.reduce((s, l) => s + (l.target || MCQ_BANK_CAP), 0) || MCQ_BANK_CAP;
  const bankPercent = Math.min(100, Math.round((totalInBank / totalTarget) * 100));
  const barPercent = Math.max(bankPercent, progress.percent ?? 0);
  return { totalInBank, totalTarget, bankPercent, barPercent };
}

/** In-flight generation toast card (parent supplies fixed bottom-right dock). */
function McqGenProgressToast({
  items,
  onOpen,
}: {
  items: { entry: RegistryEntry; progress: GenProgress }[];
  onOpen: (entry: RegistryEntry) => void;
}) {
  if (items.length === 0) return null;

  return (
    <>
      {items.map(({ entry, progress }) => {
        const { totalInBank, totalTarget, barPercent } = genBankProgress(progress);
        const sopCode = displaySopCode(entry.identifier);
        return (
          <div
            key={entry.id}
            className="pointer-events-auto overflow-hidden rounded-xl border border-violet-200 bg-white shadow-lg ring-1 ring-black/5 animate-in slide-in-from-bottom-2 fade-in duration-300"
          >
            <button
              type="button"
              onClick={() => onOpen(entry)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-violet-50/80"
            >
              <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-violet-600" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold uppercase tracking-wide text-violet-700">
                  Generation in progress
                </p>
                <p className="truncate text-xs font-semibold text-gray-800">{sopCode}</p>
                <p className="mt-0.5 truncate text-[10px] text-gray-500">
                  {progress.phase ?? "Running…"} · stops at {MCQ_BANK_CAP} MCQs
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-violet-100">
                    <div
                      className="h-full rounded-full bg-violet-600 transition-all duration-500"
                      style={{ width: `${Math.min(100, barPercent)}%` }}
                    />
                  </div>
                  <span className="shrink-0 text-[10px] font-bold tabular-nums text-violet-700">
                    {totalInBank}/{totalTarget}
                  </span>
                </div>
              </div>
            </button>
          </div>
        );
      })}
    </>
  );
}

interface AnnexSwapProgress {
  key: string;
  entryId: string;
  code: string;
  language: McqLang;
  provider: McqGenProvider;
  status: "running" | "completed" | "error";
  phase: string;
  percent: number;
  logs: string[];
  startedAt: number;
  error?: string;
  result?: { removed: number; inserted: number; annexuresUsed: number };
  /** User closed the toast; job may still be running (button spinner stays). */
  hidden?: boolean;
}

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

/** Soft progress while the long HTTP swap is in flight (API has no mid-request status).
 *  Never sits at a fixed % — creeps toward 97% until the server responds. */
function annexSwapSoftProgress(elapsedMs: number, provider: string): { percent: number; phase: string; log?: string } {
  const sec = elapsedMs / 1000;
  if (sec < 1.5) return { percent: 8, phase: "Loading SOP & linked annexures…", log: "Reading SOP family + annexure text" };
  if (sec < 4) return { percent: 18, phase: "Preparing annexure excerpt…", log: "Trimming annexure text for the model" };
  if (sec < 12) {
    return {
      percent: 35,
      phase: `Generating annexure MCQs via ${provider}…`,
      log: `LLM generating annexure questions (${provider})`,
    };
  }
  if (sec < 30) return { percent: 55, phase: "Model is writing questions…", log: "Waiting on model response" };
  if (sec < 60) return { percent: 70, phase: "Still generating — Codex/CLI can take a minute…", log: "Background process still running" };
  if (sec < 120) return { percent: 82, phase: "Long run — still waiting on the model…", log: "Still waiting on model (this is normal for Codex)" };
  // After 2 min: keep creeping 90→97% so the bar never looks frozen.
  const creep = 90 + 7 * (1 - Math.exp(-(sec - 120) / 180));
  const percent = Math.min(97, Math.round(creep));
  if (sec < 240) {
    return { percent, phase: "Still waiting on the model…", log: "Model still working — progress will complete when it returns" };
  }
  return {
    percent,
    phase: "Taking longer than usual — will time out if the model stays silent…",
    log: "Waiting past 4 minutes — client will abort soon if no response",
  };
}

/** Client-side deadline for annexure-swap fetch (ms). */
const ANNEX_SWAP_CLIENT_TIMEOUT_MS = 5 * 60 * 1000;

function AnnexSwapProgressCard({
  progress,
  compact = false,
  onDismiss,
  onHide,
}: {
  progress: AnnexSwapProgress;
  compact?: boolean;
  onDismiss?: () => void;
  /** Hide toast while a run continues in the background. */
  onHide?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [minimized, setMinimized] = useState(false);
  useEffect(() => {
    if (progress.status !== "running") return;
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [progress.status]);

  const elapsed =
    progress.status === "running"
      ? now - progress.startedAt
      : Math.max(0, now - progress.startedAt);
  const soft = annexSwapSoftProgress(elapsed, progress.provider);
  const langLabel = progress.language === "Gujarati" ? "GUJ" : "ENG";
  const isRunning = progress.status === "running";
  const isError = progress.status === "error";
  const displayPercent = isRunning ? soft.percent : progress.percent;
  const displayPhase = isRunning ? soft.phase : progress.phase;
  const logs = progress.logs.slice(-6);

  const handleClose = () => {
    if (isRunning) onHide?.();
    else onDismiss?.();
  };

  return (
    <div
      className={`overflow-hidden rounded-xl border shadow-lg ring-1 ring-black/5 ${
        isError
          ? "border-red-200 bg-red-50"
          : isRunning
            ? "border-teal-200 bg-teal-50/95"
            : "border-emerald-200 bg-emerald-50"
      } ${compact ? "min-w-[220px] max-w-[280px]" : "w-full max-w-xs"}`}
    >
      <div className="flex items-start gap-2 px-2.5 py-2">
        {isRunning ? (
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-teal-600" />
        ) : isError ? (
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
        ) : (
          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1.5">
            <p
              className={`min-w-0 truncate text-[9px] font-bold uppercase tracking-wide ${
                isError ? "text-red-700" : isRunning ? "text-teal-800" : "text-emerald-800"
              }`}
            >
              {isRunning ? "Annex swap · background" : isError ? "Annex swap failed" : "Annex swap done"}
            </p>
            <div className="flex shrink-0 items-center gap-0.5">
              <span className="mr-0.5 text-[9px] font-mono tabular-nums text-gray-500">
                {formatElapsed(elapsed)}
              </span>
              <button
                type="button"
                onClick={() => setMinimized((m) => !m)}
                className="rounded p-0.5 text-gray-400 hover:bg-white/80 hover:text-gray-700"
                title={minimized ? "Expand" : "Minimize"}
              >
                {minimized ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <Minimize2 className="h-3 w-3" />
                )}
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="rounded p-0.5 text-gray-400 hover:bg-white/80 hover:text-gray-700"
                title={isRunning ? "Hide (keeps running)" : "Close"}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          </div>
          <p className="truncate text-[10px] font-semibold text-gray-800">
            {progress.code} · {langLabel}
            <span className="ml-1 font-normal text-gray-500">via {progress.provider}</span>
          </p>
          {minimized ? (
            <div className="mt-1 flex items-center gap-2">
              <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/80 ring-1 ring-black/5">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${
                    isError ? "bg-red-500" : isRunning ? "bg-teal-500" : "bg-emerald-500"
                  }`}
                  style={{ width: `${Math.min(100, Math.max(4, displayPercent))}%` }}
                />
              </div>
              <span
                className={`shrink-0 text-[9px] font-bold tabular-nums ${
                  isError ? "text-red-700" : isRunning ? "text-teal-700" : "text-emerald-700"
                }`}
              >
                {Math.min(100, displayPercent)}%
              </span>
            </div>
          ) : (
            <>
              <p className="mt-0.5 truncate text-[10px] text-gray-600">{displayPhase}</p>
              <div className="mt-1.5 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/80 ring-1 ring-black/5">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isError ? "bg-red-500" : isRunning ? "bg-teal-500" : "bg-emerald-500"
                    }`}
                    style={{ width: `${Math.min(100, Math.max(4, displayPercent))}%` }}
                  />
                </div>
                <span
                  className={`shrink-0 text-[9px] font-bold tabular-nums ${
                    isError ? "text-red-700" : isRunning ? "text-teal-700" : "text-emerald-700"
                  }`}
                >
                  {Math.min(100, displayPercent)}%
                </span>
              </div>
              {logs.length > 0 && (
                <div className="mt-1.5 max-h-20 overflow-y-auto rounded-md bg-white/70 px-1.5 py-1 ring-1 ring-black/5">
                  {logs.map((line, i) => (
                    <p key={`${i}-${line.slice(0, 24)}`} className="truncate font-mono text-[8px] leading-relaxed text-gray-600">
                      {line}
                    </p>
                  ))}
                  {isRunning && soft.log && (
                    <p className="truncate font-mono text-[8px] leading-relaxed text-teal-700">
                      {new Date(now).toLocaleTimeString()}  {soft.log}
                    </p>
                  )}
                </div>
              )}
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                <div className="rounded-md bg-white/80 px-1.5 py-1 text-center ring-1 ring-black/5">
                  <p className={`text-sm font-bold tabular-nums leading-none ${isError ? "text-red-600" : "text-rose-600"}`}>
                    {progress.result ? `−${progress.result.removed}` : isRunning ? "…" : "−0"}
                  </p>
                  <p className="mt-0.5 text-[8px] font-bold uppercase tracking-wide text-gray-400">Removed</p>
                </div>
                <div className="rounded-md bg-white/80 px-1.5 py-1 text-center ring-1 ring-black/5">
                  <p className={`text-sm font-bold tabular-nums leading-none ${isError ? "text-red-600" : "text-emerald-600"}`}>
                    {progress.result ? `+${progress.result.inserted}` : isRunning ? "…" : "+0"}
                  </p>
                  <p className="mt-0.5 text-[8px] font-bold uppercase tracking-wide text-gray-400">Added</p>
                </div>
              </div>
              {progress.result && !isRunning && !isError && (
                <p className="mt-1 text-[9px] font-semibold text-emerald-800">
                  From {progress.result.annexuresUsed} annexure
                  {progress.result.annexuresUsed === 1 ? "" : "s"}
                </p>
              )}
              {isError && progress.error && (
                <p className="mt-1 text-[9px] font-semibold leading-snug text-red-700">{progress.error}</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionBtn({
  label, variant, disabled, loading, icon: Icon, onClick, title,
}: {
  label: string;
  variant: "generate" | "regenerate" | "continue" | "view" | "annexure";
  disabled?: boolean;
  loading?: boolean;
  icon: typeof Sparkles;
  onClick: () => void;
  title?: string;
}) {
  const styles = {
    generate: "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100",
    regenerate: "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100",
    continue: "border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100",
    view: "border-violet-300 bg-violet-50 text-violet-700 hover:bg-violet-100",
    annexure: "border-teal-300 bg-teal-50 text-teal-700 hover:bg-teal-100",
  }[variant];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[9px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${styles}`}
    >
      {loading ? (
        <><Loader2 className="h-2.5 w-2.5 animate-spin" /> {label}…</>
      ) : (
        <><Icon className="h-2.5 w-2.5" /> {label}</>
      )}
    </button>
  );
}

function McqCountLink({
  count,
  bankId,
  onView,
  colorClass,
  title,
}: {
  count: number;
  bankId?: string;
  onView?: (id: string) => void;
  colorClass: string;
  title?: string;
}) {
  const hasCount = count > 0;
  const display = hasCount ? fmt(count) : "—";
  const canOpen = hasCount && !!bankId && !!onView;

  if (!canOpen) {
    return (
      <span className={`text-[11px] font-bold ${hasCount ? colorClass : "text-gray-300"}`}>
        {display}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onView!(bankId!)}
      title={title ?? "View MCQs"}
      className={`text-[11px] font-bold ${colorClass} cursor-pointer underline-offset-2 hover:underline transition-colors`}
    >
      {display}
    </button>
  );
}

function DeleteMcqMenu({
  entry,
  needsEn,
  needsGu,
  onPick,
  disabled,
}: {
  entry: RegistryEntry;
  needsEn: boolean;
  needsGu: boolean;
  onPick: (scope: McqDeleteScope) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const hasAny = entry.hasEnMcq || entry.hasGuMcq;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  if (!hasAny) return null;

  const options: { scope: McqDeleteScope; label: string; count: number }[] = [];
  if (needsEn && entry.hasEnMcq) {
    options.push({ scope: "eng", label: "English MCQs", count: entry.enMcqCount });
  }
  if (needsGu && entry.hasGuMcq) {
    options.push({ scope: "guj", label: "Gujarati MCQs", count: entry.guMcqCount });
  }
  if (options.length >= 2) {
    options.push({ scope: "both", label: "Both languages", count: entry.totalMcqs });
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-full border border-rose-300 bg-rose-50 px-2.5 py-1 text-[9px] font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-70"
      >
        <Trash2 className="h-2.5 w-2.5" /> Delete
        <ChevronDown className={`h-2.5 w-2.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 min-w-[10.5rem] overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
          {options.map((opt) => (
            <button
              key={opt.scope}
              type="button"
              onClick={() => { setOpen(false); onPick(opt.scope); }}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[9px] font-semibold text-gray-700 hover:bg-rose-50 hover:text-rose-700"
            >
              <span>{opt.label}</span>
              <span className="tabular-nums text-gray-400">{fmt(opt.count)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RegistryRow({
  entry, isEven, onViewMcqs, onGenerate, onRegenerate, onContinue, onDeleteRequest, onOpenProgress, onStop, onAnnexureSwap, annexureSwapLang, genStatus,
}: {
  entry: RegistryEntry; isEven: boolean;
  onViewMcqs?: (id: string) => void;
  onGenerate?: (entry: RegistryEntry, language?: McqLang) => void;
  onRegenerate?: (entry: RegistryEntry, language?: McqLang) => void;
  onContinue?: (entry: RegistryEntry, language?: McqLang) => void;
  onDeleteRequest?: (entry: RegistryEntry, scope: McqDeleteScope) => void;
  onOpenProgress?: (entry: RegistryEntry) => void;
  onStop?: (entry: RegistryEntry) => void;
  onAnnexureSwap?: (entry: RegistryEntry, language: McqLang) => void;
  /** Language whose annexure swap is currently in flight, if any. */
  annexureSwapLang?: McqLang | null;
  genStatus?: GenProgress;
}) {
  const serverRunning = genStatus?.status === "generating";
  const remaining = Math.max(0, entry.totalMcqs - entry.approved);
  const isDual = entry.language === "ENG-GUJ";
  const needsEn = entry.language === "ENG" || isDual;
  const needsGu = entry.language === "GUJ" || isDual;
  // SOP No. / SOP Name rendered with displaySopCode / displaySopTitle and the exact
  // same Tailwind classes the SOP Registry uses, so both modules look identical.
  const sopCode = displaySopCode(entry.identifier);
  const sopTitle = displaySopTitle(entry.sopName, entry.identifier);
  const gujTitle = entry.sopNameGujarati
    ? displaySopTitle(entry.sopNameGujarati, entry.identifier)
    : null;
  const enBankId = entry.banks.find((b) => b.langCode === "ENG")?.id;
  const guBankId = entry.banks.find((b) => b.langCode === "GUJ")?.id;
  const defaultBankId = enBankId ?? guBankId ?? entry.banks[0]?.id;

  return (
    <tr className={`hover:bg-purple-50/80 transition-colors group/row border-b border-gray-100/80 ${
      isEven ? "bg-white" : "bg-gray-50/60"
    }`}>
      {/* SOP No. — matches SOP Registry (font-mono, 13px, purple-700) */}
      <td className="px-3 py-2.5 font-mono text-[13px] font-bold tracking-wider text-purple-700 group-hover/row:underline">
        <span className="block truncate" title={sopCode}>{sopCode}</span>
      </td>
      {/* SOP Name — matches SOP Registry (12px bold, Gujarati subline) */}
      <td className="px-3 py-2.5 max-w-[220px]">
        <div className="flex min-w-0 flex-col gap-0 leading-tight">
          <span className="line-clamp-2 text-[12px] font-bold leading-tight text-gray-900 wrap-break-word" title={sopTitle}>
            {sopTitle}
          </span>
          {gujTitle && (
            <span className="line-clamp-2 text-[10px] font-bold leading-tight text-indigo-700 wrap-break-word" title={gujTitle}>
              {gujTitle}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-[11px] text-gray-600">{entry.department}</td>
      {/* Annex — compact 3-state: were annexures used when these MCQs were made? */}
      <td className="px-2 py-2.5 text-center whitespace-nowrap">
        <span
          className={`inline-flex items-center gap-0.5 text-[10px] font-bold tabular-nums ${mcqAnnexureStatusClass(entry.annexureStatus)}`}
          title={mcqAnnexureStatusTitle({
            status: entry.annexureStatus,
            linkedCount: entry.annexureCount,
            includedLabels: entry.annexureIncludedLabels,
            hasMcqs: entry.totalMcqs > 0,
          })}
        >
          {entry.annexureStatus === "included"
            ? `📎 ${entry.annexureCount}`
            : entry.annexureStatus === "linked-not-used"
              ? `⚠ ${entry.annexureCount}`
              : "—"}
        </span>
      </td>
      {/* Lang — stacked ENG/GUJ for dual-language families, matching SOP Registry */}
      <td className="px-3 py-2.5 text-center whitespace-nowrap">
        {isDual ? (
          <div className="inline-flex flex-col items-center gap-0 leading-none">
            <span className="text-[9px] font-bold text-gray-800">ENG</span>
            <span className="text-[9px] font-bold text-indigo-800">GUJ</span>
          </div>
        ) : (
          <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-black uppercase ${
            entry.langCode === "ENG" ? "bg-blue-100 text-blue-800" : "bg-orange-100 text-orange-800"
          }`}>
            {entry.langCode}
          </span>
        )}
      </td>
      <td className="px-3 py-2.5 text-center whitespace-nowrap">
        <McqCountLink
          count={entry.totalMcqs}
          bankId={defaultBankId}
          onView={onViewMcqs}
          colorClass="text-emerald-600"
          title="View MCQs"
        />
      </td>
      <td className="px-3 py-2.5 text-center whitespace-nowrap">
        <McqCountLink
          count={needsEn ? entry.enMcqCount : 0}
          bankId={enBankId}
          onView={onViewMcqs}
          colorClass="text-blue-600"
          title="View English MCQs"
        />
      </td>
      <td className="px-3 py-2.5 text-center whitespace-nowrap">
        <McqCountLink
          count={needsGu ? entry.guMcqCount : 0}
          bankId={guBankId}
          onView={onViewMcqs}
          colorClass="text-indigo-700"
          title="View Gujarati MCQs"
        />
      </td>
      <td className="px-3 py-2.5 text-center whitespace-nowrap">
        <span className={`text-[11px] font-bold ${remaining > 0 ? "text-red-500" : "text-gray-300"}`}>
          {entry.totalMcqs > 0 ? fmt(remaining) : "—"}
        </span>
      </td>
      <td className="px-3 py-2.5 text-center whitespace-nowrap">
        <span className={`text-[11px] font-semibold ${entry.approved > 0 ? "text-emerald-600" : "text-gray-300"}`}>
          {fmt(entry.approved)}
        </span>
      </td>
      <td className="px-3 py-2.5 text-center whitespace-nowrap">
        <span className={`text-[11px] font-semibold ${entry.partial > 0 ? "text-amber-600" : "text-gray-300"}`}>
          {fmt(entry.partial)}
        </span>
      </td>
      <td className="px-3 py-2.5 text-center whitespace-nowrap">
        <span className={`text-[11px] font-semibold ${entry.similar > 0 ? "text-violet-600" : "text-gray-300"}`}>
          {fmt(entry.similar)}
        </span>
      </td>
      <td className="px-3 py-2.5 text-center whitespace-nowrap">
        <span className="text-[11px] text-gray-500">{fmtDate(entry.lastUpdated)}</span>
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        <div className="flex flex-col items-start gap-1">
          {serverRunning ? (
            <div className="flex flex-col gap-1 rounded-lg border border-purple-200 bg-purple-50 px-2 py-1.5">
              <span className="text-[9px] font-semibold text-purple-800">
                Generating… {genStatus?.percent ?? 0}%
                {genStatus?.phase ? ` · ${genStatus.phase}` : ""}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onOpenProgress?.(entry)}
                  className="text-[9px] font-semibold text-purple-600 hover:underline"
                >
                  View logs
                </button>
                <button
                  type="button"
                  onClick={() => onStop?.(entry)}
                  className="text-[9px] font-bold uppercase tracking-wide text-rose-600 hover:underline"
                >
                  Stop
                </button>
              </div>
            </div>
          ) : (
          <div className="flex flex-wrap items-center gap-1">
            {!entry.isObsoleteMcq && needsEn && !entry.hasEnMcq && (
              <ActionBtn
                variant="generate"
                icon={Sparkles}
                label={isDual ? "Generate ENG" : "Generate MCQ"}
                onClick={() => onGenerate?.(entry, isDual ? "English" : undefined)}
              />
            )}
            {!entry.isObsoleteMcq && needsGu && !entry.hasGuMcq && (
              <ActionBtn
                variant="generate"
                icon={Sparkles}
                label={isDual ? "Generate GUJ" : "Generate MCQ"}
                onClick={() => onGenerate?.(entry, isDual ? "Gujarati" : undefined)}
              />
            )}
            {!entry.isObsoleteMcq && needsEn && entry.hasEnMcq && (
              <ActionBtn
                variant="regenerate"
                icon={RefreshCw}
                label={isDual ? "Regenerate ENG" : "Regenerate"}
                onClick={() => onRegenerate?.(entry, isDual ? "English" : undefined)}
              />
            )}
            {!entry.isObsoleteMcq && needsGu && entry.hasGuMcq && (
              <ActionBtn
                variant="regenerate"
                icon={RefreshCw}
                label={isDual ? "Regenerate GUJ" : "Regenerate"}
                onClick={() => onRegenerate?.(entry, isDual ? "Gujarati" : undefined)}
              />
            )}
            {!entry.isObsoleteMcq && needsEn && entry.hasEnMcq && entry.enMcqCount < MCQ_BANK_CAP && (
              <ActionBtn
                variant="continue"
                icon={Sparkles}
                label={isDual ? "Continue ENG" : "Continue"}
                onClick={() => onContinue?.(entry, isDual ? "English" : undefined)}
              />
            )}
            {!entry.isObsoleteMcq && needsGu && entry.hasGuMcq && entry.guMcqCount < MCQ_BANK_CAP && (
              <ActionBtn
                variant="continue"
                icon={Sparkles}
                label={isDual ? "Continue GUJ" : "Continue"}
                onClick={() => onContinue?.(entry, isDual ? "Gujarati" : undefined)}
              />
            )}
            {!entry.isObsoleteMcq && entry.annexureCount > 0 && needsEn && entry.hasEnMcq && (
              <ActionBtn
                variant="annexure"
                icon={Paperclip}
                label={isDual ? "Annex ENG" : "Annex MCQ"}
                loading={annexureSwapLang === "English"}
                onClick={() => onAnnexureSwap?.(entry, "English")}
                title="Swap duplicate/similar MCQs for questions from linked annexures (creative-fill kept)"
              />
            )}
            {!entry.isObsoleteMcq && entry.annexureCount > 0 && needsGu && entry.hasGuMcq && (
              <ActionBtn
                variant="annexure"
                icon={Paperclip}
                label={isDual ? "Annex GUJ" : "Annex MCQ"}
                loading={annexureSwapLang === "Gujarati"}
                onClick={() => onAnnexureSwap?.(entry, "Gujarati")}
                title="Swap duplicate/similar MCQs for questions from linked annexures (creative-fill kept)"
              />
            )}
            {!entry.isObsoleteMcq && (entry.hasEnMcq || entry.hasGuMcq) && (
              <DeleteMcqMenu
                entry={entry}
                needsEn={needsEn}
                needsGu={needsGu}
                onPick={(scope) => onDeleteRequest?.(entry, scope)}
              />
            )}
            {entry.banks.length === 0 && entry.isObsoleteMcq && (
              <span className="text-[9px] text-gray-300">—</span>
            )}
          </div>
          )}
          {genStatus?.status === "error" && (
            <span className="text-[9px] font-semibold text-red-500">
              {genStatus.error ?? "Generation failed — retry"}
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────
// Sort icon
// ─────────────────────────────────────────────────────────────
function SortIcon({ col, current, dir }: { col: string; current: string; dir: string }) {
  if (current !== col) return <span className="text-gray-400 ml-0.5">↕</span>;
  return <span className="text-purple-300 ml-0.5">{dir === "asc" ? "↑" : "↓"}</span>;
}

// ─────────────────────────────────────────────────────────────
// Main client component
// ─────────────────────────────────────────────────────────────
export function MCQBankClient() {
  const router = useRouter();
  const { data: session } = useSession();
  const userIsAdmin = isAdmin((session?.user?.role ?? "viewer") as AppRole);

  // Modal state
  const [viewerBankId, setViewerBankId] = useState<string | null>(null);
  // Department folder modal (opened by clicking a department capsule/card)
  const [modalDept, setModalDept] = useState<string | null>(null);

  // Data state
  const [stats, setStats] = useState<MCQBankGlobalStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  const [allActiveEntries, setAllActiveEntries] = useState<RegistryEntry[]>([]);
  const [allObsoleteEntries, setAllObsoleteEntries] = useState<RegistryEntry[]>([]);
  const [regLoading, setRegLoading] = useState(true);
  const [regError, setRegError] = useState<string | null>(null);

  // Filters — applied client-side for instant capsule/card clicks (same pattern as Dashboard)
  const [search, setSearch] = useState("");
  const [difficulty, setDifficulty] = useState<"all" | "easy" | "medium" | "hard">("all");
  const [deptFilter, setDeptFilter] = useState("all");
  // MCQ presence filter: "all" | "found" (has MCQs) | "notFound" (no MCQs yet)
  const [mcqPresence, setMcqPresence] = useState<"all" | "found" | "notFound">("all");
  const [obsoleteOnly, setObsoleteOnly] = useState(false);
  const [sortCol, setSortCol] = useState("identifier");
  const [sortDir, setSortDir] = useState("asc");
  const [regLangFilter, setRegLangFilter] = useState("All");
  // Per-language MCQ-coverage filter, driven by the capsule "w/ EN" / "w/ GU"
  // clicks. Distinct from regLangFilter (SOP language): this matches the capsule
  // count of families that actually HAVE that language's MCQs.
  const [langMcqFilter, setLangMcqFilter] = useState<"all" | "en" | "gu">("all");

  // UI state
  const [showDeptCards, setShowDeptCards] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<McqGenProvider>("codex");
  const [claudeStatus, setClaudeStatus] = useState<{
    ok: boolean;
    model?: string;
    mcqModel?: string;
    mcqApiDirect?: boolean;
    email?: string;
    subscriptionType?: string;
    error?: string;
    loading?: boolean;
  } | null>(null);
  const [codexStatus, setCodexStatus] = useState<{
    ok: boolean;
    model?: string;
    mcqModel?: string;
    authMode?: string;
    codexVersion?: string;
    error?: string;
    loading?: boolean;
  } | null>(null);
  // Per-family MCQ generation state, keyed by registry entry id (family key).
  const [genStatus, setGenStatus] = useState<Record<string, GenProgress>>({});
  const [genModalEntry, setGenModalEntry] = useState<RegistryEntry | null>(null);
  // Identifiers currently being polled, so we never start two poll loops for one row.
  const pollingRef = useRef<Set<string>>(new Set());
  const pollAbortRef = useRef<Set<string>>(new Set());
  const resumedJobsRef = useRef<Set<string>>(new Set());
  const pendingActiveJobsRef = useRef<Array<{
    identifier: string;
    mode?: GenProgress["mode"];
    languageScope?: McqLang;
    phase?: string;
    percent?: number;
    totalInserted?: number;
    totalSkipped?: number;
    totalFailedBatches?: number;
    languages?: GenProgress["languages"];
    logs?: string[];
    startedAt?: string;
  }>>([]);
  const runStartedAtRef = useRef<Record<string, number>>({});
  const [genStopping, setGenStopping] = useState(false);
  const [stopAllLoading, setStopAllLoading] = useState(false);

  // Regenerate flow — the entry awaiting password confirmation, plus the typed
  // password and any validation error.
  const [regenTarget, setRegenTarget] = useState<{ entry: RegistryEntry; language?: McqLang } | null>(null);
  const [regenPassword, setRegenPassword] = useState("");
  const [regenError, setRegenError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<{ entry: RegistryEntry; scope: McqDeleteScope } | null>(null);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Annexure swap: confirm target + live bottom-right progress cards (phase/logs/
  // removed+added). Removes ~15 duplicate/similar MCQs and replaces them with
  // annexure-derived questions.
  const [annexSwapTarget, setAnnexSwapTarget] = useState<{ entry: RegistryEntry; language: McqLang } | null>(null);
  const [annexSwapProgress, setAnnexSwapProgress] = useState<AnnexSwapProgress[]>([]);
  const annexSwapTimersRef = useRef<Map<string, number>>(new Map());


  const mcqRegistryRef = useRef<HTMLDivElement>(null);

  const fetchStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      const statsRes = await fetch("/api/mcq-bank/stats");
      if (!statsRes.ok) throw new Error((await statsRes.json()).error ?? "Failed to load MCQ stats");
      setStats(await statsRes.json());
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : "Failed to load stats");
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const fetchRegistry = useCallback(async () => {
    setRegLoading(true);
    setRegError(null);
    try {
      const res = await fetch("/api/mcq-bank/registry?all=1");
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      const data = await res.json();
      setAllActiveEntries(data.active ?? []);
      setAllObsoleteEntries(data.obsolete ?? []);
    } catch (e) {
      setRegError(e instanceof Error ? e.message : "Failed to load registry");
    } finally {
      setRegLoading(false);
    }
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats, refreshKey]);
  useEffect(() => { fetchRegistry(); }, [fetchRegistry, refreshKey]);

  useEffect(() => {
    if (!userIsAdmin || selectedProvider !== "claude") {
      setClaudeStatus(null);
      return;
    }
    let cancelled = false;
    setClaudeStatus({ ok: false, loading: true });
    fetch("/api/llm/claude-status")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const c = data.claude ?? {};
        setClaudeStatus({
          ok: Boolean(data.success && c.loggedIn),
          model: c.model,
          mcqModel: c.mcqModel,
          mcqApiDirect: Boolean(c.mcqApiDirect),
          email: c.email,
          subscriptionType: c.subscriptionType,
          error: c.error,
          loading: false,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setClaudeStatus({
          ok: false,
          error: e instanceof Error ? e.message : "Could not check Claude status",
          loading: false,
        });
      });
    return () => { cancelled = true; };
  }, [selectedProvider, userIsAdmin]);

  useEffect(() => {
    if (!userIsAdmin || selectedProvider !== "codex") {
      setCodexStatus(null);
      return;
    }
    let cancelled = false;
    setCodexStatus({ ok: false, loading: true });
    fetch("/api/llm/codex-status")
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const c = data.codex ?? {};
        setCodexStatus({
          ok: Boolean(data.success && c.loggedIn),
          model: c.model,
          mcqModel: c.mcqModel,
          authMode: c.authMode,
          codexVersion: c.codexVersion,
          error: c.error,
          loading: false,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setCodexStatus({
          ok: false,
          error: e instanceof Error ? e.message : "Could not check Codex status",
          loading: false,
        });
      });
    return () => { cancelled = true; };
  }, [selectedProvider, userIsAdmin]);

  // Generate MCQs for a "Not Found" family on demand. The endpoint runs the full
  // generation pipeline into mcqbanks; once it succeeds we refresh stats + registry
  // so the row flips from "Not Found" to "MCQ Found".
  // Poll the generation job's status endpoint until it finishes, pushing live
  // progress into genStatus. Generation runs in the background server-side, so we
  // never hold an HTTP request open for the whole run.
  const pollJob = useCallback((entry: RegistryEntry) => {
    if (pollingRef.current.has(entry.id)) return;
    pollingRef.current.add(entry.id);
    pollAbortRef.current.delete(entry.id);
    const POLL_INTERVAL_MS = 3000;

    const finish = () => {
      pollingRef.current.delete(entry.id);
      pollAbortRef.current.delete(entry.id);
      resumedJobsRef.current.delete(entry.id);
    };

    const tick = async () => {
      if (pollAbortRef.current.has(entry.id)) {
        finish();
        return;
      }

      try {
        const res = await fetch(
          `/api/sop/generate-mcqs/status?identifier=${encodeURIComponent(entry.identifier)}`,
        );
        if (pollAbortRef.current.has(entry.id)) {
          finish();
          return;
        }
        if (res.ok) {
          const d = await res.json();
          const effectiveStatus =
            d.cancelRequested && (d.status === "running" || d.status === "queued")
              ? "cancelled"
              : d.status;

          const runStarted = runStartedAtRef.current[entry.id] ?? 0;
          const jobStarted = d.startedAt ? new Date(d.startedAt).getTime() : 0;
          const isStaleTerminal =
            (effectiveStatus === "failed" || effectiveStatus === "cancelled") &&
            Boolean(runStarted && jobStarted > 0 && jobStarted < runStarted - 1000);

          if (isStaleTerminal) {
            setTimeout(tick, POLL_INTERVAL_MS);
            return;
          }

          if (effectiveStatus === "completed") {
            finish();
            setGenStatus((s) => ({
              ...s,
              [entry.id]: {
                status: "completed",
                mode: d.mode,
                languageScope: d.languageScope,
                phase: d.phase,
                percent: d.percent ?? 0,
                totalInserted: d.totalInserted,
                totalSkipped: d.totalSkipped,
                totalFailedBatches: d.totalFailedBatches,
                languages: d.languages,
                logs: d.logs ?? [],
              },
            }));
            setRefreshKey((k) => k + 1);
            return;
          }
          if (effectiveStatus === "failed" || effectiveStatus === "cancelled") {
            finish();
            setGenStatus((s) => ({
              ...s,
              [entry.id]: {
                status: effectiveStatus === "cancelled" ? "cancelled" : "error",
                mode: d.mode,
                languageScope: d.languageScope,
                totalInserted: d.totalInserted,
                totalSkipped: d.totalSkipped,
                totalFailedBatches: d.totalFailedBatches,
                languages: d.languages,
                logs: d.logs ?? [],
                error: d.error ?? (effectiveStatus === "cancelled"
                  ? "Generation stopped. MCQs created so far are saved."
                  : "Generation failed"),
              },
            }));
            setRefreshKey((k) => k + 1);
            return;
          }
          setGenStatus((s) => ({
            ...s,
            [entry.id]: {
              status: "generating",
              mode: d.mode,
              languageScope: d.languageScope,
              phase: d.phase,
              percent: d.percent,
              totalInserted: d.totalInserted,
              totalSkipped: d.totalSkipped,
              totalFailedBatches: d.totalFailedBatches,
              languages: d.languages,
              logs: d.logs ?? [],
            },
          }));
        } else if (res.status === 404) {
          /* job not created yet — keep polling briefly */
        }
      } catch {
        /* transient network blip — keep polling */
      }

      if (pollAbortRef.current.has(entry.id)) {
        finish();
        return;
      }
      setTimeout(tick, POLL_INTERVAL_MS);
    };

    setTimeout(tick, 800);
  }, []);

  const attachGenerationJob = useCallback((
    entry: RegistryEntry,
    job: {
      mode?: GenProgress["mode"];
      languageScope?: McqLang;
      startedAt?: string;
      alreadyRunning?: boolean;
    },
    language?: McqLang,
    options?: { openModal?: boolean },
  ) => {
    const runStartedAt = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
    runStartedAtRef.current[entry.id] = runStartedAt;
    setGenStatus((s) => ({
      ...s,
      [entry.id]: {
        status: "generating",
        mode: job.mode,
        languageScope: job.languageScope ?? language,
        phase: job.alreadyRunning ? "Resuming…" : "Queued",
        percent: 0,
        logs: s[entry.id]?.logs ?? [],
        runStartedAt,
      },
    }));
    if (options?.openModal) setGenModalEntry(entry);
    pollJob(entry);
  }, [pollJob]);

  const tryResumeActiveJobs = useCallback((entries: RegistryEntry[]) => {
    if (pendingActiveJobsRef.current.length === 0) return;

    const remaining: typeof pendingActiveJobsRef.current = [];
    for (const job of pendingActiveJobsRef.current) {
      const jobKey = normalizeSopIdentifierKey(job.identifier);
      const entry = entries.find(
        (e) => normalizeSopIdentifierKey(e.identifier) === jobKey,
      );
      if (!entry) {
        remaining.push(job);
        continue;
      }
      if (resumedJobsRef.current.has(entry.id) || pollingRef.current.has(entry.id)) {
        continue;
      }
      resumedJobsRef.current.add(entry.id);
      const runStartedAt = job.startedAt ? new Date(job.startedAt).getTime() : Date.now();
      runStartedAtRef.current[entry.id] = runStartedAt;
      setGenStatus((s) => ({
        ...s,
        [entry.id]: {
          status: "generating",
          mode: job.mode,
          languageScope: job.languageScope,
          phase: job.phase ?? "Running…",
          percent: job.percent ?? 0,
          totalInserted: job.totalInserted,
          totalSkipped: job.totalSkipped,
          totalFailedBatches: job.totalFailedBatches,
          languages: job.languages,
          logs: job.logs ?? [],
          runStartedAt,
        },
      }));
      pollJob(entry);
    }
    pendingActiveJobsRef.current = remaining;
  }, [pollJob]);

  const stopGeneration = useCallback(async (entry: RegistryEntry) => {
    setGenStopping(true);
    try {
      const res = await fetch("/api/sop/generate-mcqs/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: entry.identifier }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setGenStatus((s) => ({
          ...s,
          [entry.id]: {
            ...(s[entry.id] ?? { status: "generating" as const }),
            status: "generating",
            error: data.error ?? "Stop failed — generation may still be running",
          },
        }));
        return;
      }
      setGenStatus((s) => ({
        ...s,
        [entry.id]: {
          ...(s[entry.id] ?? { status: "generating" as const }),
          status: "generating",
          phase: "Stopping…",
          error: undefined,
        },
      }));
      if (!pollingRef.current.has(entry.id)) {
        pollJob(entry);
      }
    } catch {
      setGenStatus((s) => ({
        ...s,
        [entry.id]: {
          ...(s[entry.id] ?? { status: "generating" as const }),
          status: "generating",
          error: "Stop request failed — try again",
        },
      }));
    } finally {
      setGenStopping(false);
    }
  }, [pollJob]);

  const stopAllGeneration = useCallback(async () => {
    if (!window.confirm("Stop ALL in-flight MCQ generation jobs and kill Claude calls?")) return;
    setStopAllLoading(true);
    try {
      const res = await fetch("/api/sop/generate-mcqs/cancel-all", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Failed to stop all jobs");
      setGenStatus({});
      setGenModalEntry(null);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "Failed to stop all jobs");
    } finally {
      setStopAllLoading(false);
    }
  }, []);

  const handleGenerate = useCallback(async (entry: RegistryEntry, language?: McqLang) => {
    setGenStatus((s) => ({
      ...s,
      [entry.id]: { status: "generating", languageScope: language, phase: "Starting…", percent: 0, logs: [] },
    }));
    try {
      const res = await fetch("/api/sop/generate-mcqs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: entry.identifier,
          ...(language ? { language } : {}),
          provider: selectedProvider,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Generation failed");
      attachGenerationJob(entry, data, language, { openModal: !data.alreadyRunning });
    } catch (e) {
      setGenStatus((s) => ({
        ...s,
        [entry.id]: { status: "error", error: e instanceof Error ? e.message : "Generation failed" },
      }));
      setGenModalEntry(entry);
    }
  }, [attachGenerationJob, selectedProvider]);

  const handleContinue = useCallback(async (entry: RegistryEntry, language?: McqLang) => {
    setGenStatus((s) => ({
      ...s,
      [entry.id]: { status: "generating", mode: "continue", languageScope: language, phase: "Starting…", percent: 0, logs: [] },
    }));
    try {
      const res = await fetch("/api/sop/generate-mcqs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: entry.identifier,
          mode: "continue",
          ...(language ? { language } : {}),
          provider: selectedProvider,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Continue generation failed");
      attachGenerationJob(entry, { ...data, mode: "continue" }, language, { openModal: !data.alreadyRunning });
    } catch (e) {
      setGenStatus((s) => ({
        ...s,
        [entry.id]: { status: "error", error: e instanceof Error ? e.message : "Continue generation failed" },
      }));
      setGenModalEntry(entry);
    }
  }, [attachGenerationJob, selectedProvider]);

  // Open the password prompt for an SOP the user wants to regenerate.
  const requestRegenerate = useCallback((entry: RegistryEntry, language?: McqLang) => {
    setRegenTarget({ entry, language });
    setRegenPassword("");
    setRegenError(null);
  }, []);

  const cancelRegenerate = useCallback(() => {
    setRegenTarget(null);
    setRegenPassword("");
    setRegenError(null);
  }, []);

  // Validate the password, then run the same generation pipeline as "Generate"
  // (the endpoint archives the active bank and installs a fresh one).
  const confirmRegenerate = useCallback(() => {
    if (regenPassword !== REGEN_PASSWORD) {
      setRegenError("Incorrect password. Please try again.");
      return;
    }
    if (!regenTarget) return;
    const { entry, language } = regenTarget;
    setRegenTarget(null);
    setRegenPassword("");
    setRegenError(null);
    if (entry) handleGenerate(entry, language);
  }, [regenPassword, regenTarget, handleGenerate]);

  const requestDelete = useCallback((entry: RegistryEntry, scope: McqDeleteScope) => {
    setDeleteTarget({ entry, scope });
    setDeletePassword("");
    setDeleteError(null);
  }, []);

  const cancelDelete = useCallback(() => {
    setDeleteTarget(null);
    setDeletePassword("");
    setDeleteError(null);
    setDeleteLoading(false);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (deletePassword !== REGEN_PASSWORD) {
      setDeleteError("Incorrect password. Please try again.");
      return;
    }
    if (!deleteTarget) return;
    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/mcq-bank/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: deleteTarget.entry.identifier,
          scope: deleteTarget.scope,
          password: deletePassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Delete failed");
      setViewerBankId(null);
      cancelDelete();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed");
      setDeleteLoading(false);
    }
  }, [deletePassword, deleteTarget, cancelDelete]);

  // Open the annexure-swap confirm dialog.
  const requestAnnexureSwap = useCallback((entry: RegistryEntry, language: McqLang) => {
    setAnnexSwapTarget({ entry, language });
  }, []);

  const patchAnnexSwap = useCallback((key: string, patch: Partial<AnnexSwapProgress> | ((prev: AnnexSwapProgress) => Partial<AnnexSwapProgress>)) => {
    setAnnexSwapProgress((list) =>
      list.map((item) => {
        if (item.key !== key) return item;
        const next = typeof patch === "function" ? patch(item) : patch;
        return {
          ...item,
          ...next,
          logs: next.logs ?? item.logs,
        };
      }),
    );
  }, []);

  const dismissAnnexSwap = useCallback((key: string) => {
    const timer = annexSwapTimersRef.current.get(key);
    if (timer) {
      window.clearTimeout(timer);
      annexSwapTimersRef.current.delete(key);
    }
    setAnnexSwapProgress((list) => list.filter((p) => p.key !== key));
  }, []);

  const hideAnnexSwap = useCallback((key: string) => {
    patchAnnexSwap(key, { hidden: true });
  }, [patchAnnexSwap]);

  const confirmAnnexureSwap = useCallback(async () => {
    if (!annexSwapTarget) return;
    const { entry, language } = annexSwapTarget;
    const key = `${entry.id}::${language}`;
    const code = displaySopCode(entry.identifier);
    const provider = selectedProvider;
    setAnnexSwapTarget(null);

    // Don't start a duplicate run for the same SOP+language.
    let started = false;
    const startedAt = Date.now();
    setAnnexSwapProgress((list) => {
      if (list.some((p) => p.key === key && p.status === "running")) return list;
      started = true;
      return [
        ...list.filter((p) => p.key !== key),
        {
          key,
          entryId: entry.id,
          code,
          language,
          provider,
          status: "running",
          phase: "Starting annexure swap…",
          percent: 5,
          logs: [
            `${new Date().toLocaleTimeString()}  Background annexure swap started`,
            `${new Date().toLocaleTimeString()}  Provider: ${provider} · ${language === "Gujarati" ? "GUJ" : "ENG"}`,
          ],
          startedAt,
        },
      ];
    });
    if (!started) return;

    // Push soft-phase milestones into the log pane while the HTTP request is open.
    const seenPhases = new Set<string>();
    const milestoneId = window.setInterval(() => {
      const soft = annexSwapSoftProgress(Date.now() - startedAt, provider);
      if (seenPhases.has(soft.phase)) return;
      seenPhases.add(soft.phase);
      patchAnnexSwap(key, (prev) => {
        if (prev.status !== "running") return {};
        return {
          phase: soft.phase,
          percent: soft.percent,
          logs: [
            ...prev.logs,
            `${new Date().toLocaleTimeString()}  ${soft.log ?? soft.phase}`,
          ].slice(-12),
        };
      });
    }, 800);

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), ANNEX_SWAP_CLIENT_TIMEOUT_MS);

    try {
      const res = await fetch("/api/mcq-bank/annexure-swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: entry.identifier,
          language,
          provider,
        }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Annexure swap failed");

      const removed = data.removed ?? 0;
      const inserted = data.inserted ?? 0;
      const annexuresUsed = data.annexuresUsed ?? 0;
      const breakdown = data.removedBreakdown as
        | { creative?: number; similar?: number; duplicate?: number; other?: number }
        | undefined;

      patchAnnexSwap(key, (prev) => ({
        status: "completed",
        phase: `Done — removed ${removed}, added ${inserted}`,
        percent: 100,
        hidden: false,
        result: { removed, inserted, annexuresUsed },
        logs: [
          ...prev.logs,
          `${new Date().toLocaleTimeString()}  Model returned — writing bank`,
          `${new Date().toLocaleTimeString()}  Removed ${removed} (creative ${breakdown?.creative ?? breakdown?.other ?? 0}, similar ${breakdown?.similar ?? 0}, duplicate ${breakdown?.duplicate ?? 0})`,
          `${new Date().toLocaleTimeString()}  Added ${inserted} from ${annexuresUsed} annexure${annexuresUsed === 1 ? "" : "s"}`,
        ].slice(-12),
      }));
      setRefreshKey((k) => k + 1);

      const dismissTimer = window.setTimeout(() => dismissAnnexSwap(key), 14_000);
      annexSwapTimersRef.current.set(key, dismissTimer);
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      const message = aborted
        ? `Timed out after ${Math.round(ANNEX_SWAP_CLIENT_TIMEOUT_MS / 60000)} minutes — Codex/CLI did not finish. Try Claude or Gemini, or retry.`
        : e instanceof Error
          ? e.message
          : "Annexure swap failed";
      patchAnnexSwap(key, (prev) => ({
        status: "error",
        phase: aborted ? "Timed out" : "Annexure swap failed",
        percent: prev.percent,
        hidden: false,
        error: message,
        logs: [...prev.logs, `${new Date().toLocaleTimeString()}  Error: ${message}`].slice(-12),
      }));
    } finally {
      window.clearInterval(milestoneId);
      window.clearTimeout(timeoutId);
    }
  }, [annexSwapTarget, selectedProvider, patchAnnexSwap, dismissAnnexSwap]);

  // Clear annex-swap dismiss timers on unmount.
  useEffect(() => {
    const timers = annexSwapTimersRef.current;
    return () => {
      timers.forEach((id) => window.clearTimeout(id));
      timers.clear();
    };
  }, []);


  const closeGenModal = useCallback(() => {
    setGenModalEntry(null);
  }, []);

  // Fetch in-flight jobs once on mount; attach when registry rows are available.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/sop/generate-mcqs/active");
        if (!res.ok || cancelled) return;
        const data = await res.json();
        pendingActiveJobsRef.current = data.jobs ?? [];
        tryResumeActiveJobs(allActiveEntries);
      } catch {
        /* registry effect retries when entries load */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount fetch only
  }, []);

  useEffect(() => {
    tryResumeActiveJobs(allActiveEntries);
  }, [allActiveEntries, tryResumeActiveJobs]);

  const activeGenToasts = useMemo(() => {
    const entries = [...allActiveEntries, ...allObsoleteEntries];
    return Object.entries(genStatus)
      .filter(([, p]) => p.status === "generating")
      .map(([id, progress]) => {
        const entry = entries.find((e) => e.id === id);
        return entry ? { entry, progress } : null;
      })
      .filter((x): x is { entry: RegistryEntry; progress: GenProgress } => x !== null)
      .filter(({ entry }) => genModalEntry?.id !== entry.id);
  }, [genStatus, allActiveEntries, allObsoleteEntries, genModalEntry]);

  const handleSort = (field: string) => {
    if (sortCol === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(field); setSortDir("asc"); }
  };

  const { filteredEntries, total } = useMemo(() => {
    let rows = obsoleteOnly ? allObsoleteEntries : allActiveEntries;

    if (deptFilter !== "all") {
      rows = rows.filter((e) => e.department === deptFilter);
    }
    // MCQ presence mirrors the dashboard capsule exactly: "found" = the family
    // has real questions in every language it requires (hasMcq); "notFound" =
    // everything else, including families whose bank exists but has no questions
    // (or a dual-language SOP missing one language). Filtering on hasMcq — not
    // banks.length — keeps the list count in sync with the capsule count.
    if (mcqPresence === "found") {
      rows = rows.filter((e) => e.hasMcq);
    } else if (mcqPresence === "notFound") {
      rows = rows.filter((e) => !e.hasMcq);
    }
    if (regLangFilter === "English") {
      rows = rows.filter((e) => e.language === "ENG" || e.language === "ENG-GUJ");
    } else if (regLangFilter === "Gujarati") {
      rows = rows.filter((e) => e.language === "GUJ" || e.language === "ENG-GUJ");
    }
    // Capsule "w/ EN" / "w/ GU": families that HAVE that language's MCQs. Matches
    // the capsule count exactly (a family authored in English but with no English
    // MCQs is excluded — it lives in "EN rem." instead).
    if (langMcqFilter === "en") {
      rows = rows.filter((e) => e.hasEnMcq);
    } else if (langMcqFilter === "gu") {
      rows = rows.filter((e) => e.hasGuMcq);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (e) =>
          e.identifier.toLowerCase().includes(q) ||
          e.sopName.toLowerCase().includes(q) ||
          (e.sopNameGujarati ?? "").toLowerCase().includes(q) ||
          e.department.toLowerCase().includes(q),
      );
    }
    if (difficulty === "easy") rows = rows.filter((e) => e.easyCount > 0);
    else if (difficulty === "medium") rows = rows.filter((e) => e.mediumCount > 0);
    else if (difficulty === "hard") rows = rows.filter((e) => e.hardCount > 0);

    const sorted = [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortCol === "identifier") cmp = a.identifier.localeCompare(b.identifier);
      else if (sortCol === "name") cmp = a.sopName.localeCompare(b.sopName);
      else if (sortCol === "dept") cmp = a.department.localeCompare(b.department);
      else if (sortCol === "annexure") {
        // "none" / missing count sorts as 0; ties break by status (used > linked-not-used).
        const rank = (s?: McqAnnexureStatus) => (s === "included" ? 2 : s === "linked-not-used" ? 1 : 0);
        cmp = (a.annexureCount ?? 0) - (b.annexureCount ?? 0);
        if (cmp === 0) cmp = rank(a.annexureStatus) - rank(b.annexureStatus);
      }
      else if (sortCol === "lang") cmp = a.langCode.localeCompare(b.langCode);
      else if (sortCol === "questions" || sortCol === "totalMcqs") cmp = a.totalMcqs - b.totalMcqs;
      else if (sortCol === "enMcqCount") cmp = a.enMcqCount - b.enMcqCount;
      else if (sortCol === "guMcqCount") cmp = a.guMcqCount - b.guMcqCount;
      else if (sortCol === "remaining") cmp = a.remaining - b.remaining;
      else if (sortCol === "approved") cmp = a.approved - b.approved;
      else if (sortCol === "partial") cmp = a.partial - b.partial;
      else if (sortCol === "similar") cmp = a.similar - b.similar;
      else if (sortCol === "lastUpdated" || sortCol === "date") {
        cmp = (Date.parse(a.lastUpdated ?? "") || 0) - (Date.parse(b.lastUpdated ?? "") || 0);
      } else cmp = a.identifier.localeCompare(b.identifier);
      return sortDir === "desc" ? -cmp : cmp;
    });

    return { filteredEntries: sorted, total: sorted.length };
  }, [
    allActiveEntries, allObsoleteEntries, obsoleteOnly, deptFilter, mcqPresence, regLangFilter,
    langMcqFilter, search, difficulty, sortCol, sortDir,
  ]);

  const totalBanks = stats?.totalMcqBanks ?? allActiveEntries.length;

  // Aggregate global totals for StatusCard
  const globalCard = stats ? {
    totalSOPs: stats.totalUniqueSops,
    sopWithMCQs: stats.mcqFound,
    sopWithoutMCQs: stats.notFound,
    approvedSOPs: stats.approvedSops,
    partialSOPs: stats.partialSops,
    pendingSOPs: stats.pendingSops,
    similarSOPs: stats.similarSops,
    totalSopEng: stats.withEnglish,
    totalSopGuj: stats.withGujarati,
    remainingEng: stats.enRemaining,
    remainingGuj: stats.guRemaining,
  } : null;

  const applyDeptFilter = useCallback((department: string) => {
    setObsoleteOnly(false);
    setDeptFilter(department === "Total" ? "all" : department);
    setMcqPresence("all");
    setLangMcqFilter("all");
    setSearch("");
    mcqRegistryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Filter the registry by MCQ presence (e.g. clicking "MCQ Found" / "Not Found").
  const applyPresenceFilter = useCallback((department: string, presence: "found" | "notFound") => {
    setObsoleteOnly(false);
    setDeptFilter(department === "Total" ? "all" : department);
    setMcqPresence(presence);
    setLangMcqFilter("all");
    setSearch("");
    mcqRegistryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Filter the registry by MCQ language coverage (clicking "w/ EN" / "w/ GU" on a
  // card) — i.e. families that HAVE that language's MCQs, matching the capsule.
  const applyLangFilter = useCallback((department: string, lang: "English" | "Gujarati") => {
    setObsoleteOnly(false);
    setDeptFilter(department === "Total" ? "all" : department);
    setMcqPresence("all");
    setRegLangFilter("All");
    setLangMcqFilter(lang === "English" ? "en" : "gu");
    setSearch("");
    mcqRegistryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Open the department folder modal (Digital Repository view) for a department.
  const openDeptModal = useCallback((department: string) => {
    if (department === "Total") return;
    setModalDept(department);
  }, []);

  const toggleObsoleteView = useCallback(() => {
    setObsoleteOnly((v) => !v);
    setDeptFilter("all");
    setMcqPresence("all");
    setLangMcqFilter("all");
    setSearch("");
    mcqRegistryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const DEPT_ORDER = ["QA", "QC", "Microbiology", "Production", "Store", "Engineering and Maintenance", "Personnel"];
  const orderedDepts = stats ? [
    ...DEPT_ORDER.map((n) => stats.departments.find((d) => d.department === n)).filter(Boolean) as DeptMCQStats[],
    ...stats.departments.filter((d) => !DEPT_ORDER.includes(d.department)),
  ] : [];

  const totalStatusCards = 1 + orderedDepts.length;

  return (
    <>
      {genModalEntry && genStatus[genModalEntry.id] && (
        <McqGenProgressModal
          entry={genModalEntry}
          progress={genStatus[genModalEntry.id]}
          onClose={closeGenModal}
          onStop={
            genStatus[genModalEntry.id].status === "generating"
              ? () => void stopGeneration(genModalEntry)
              : undefined
          }
          stopping={genStopping}
        />
      )}

      {(activeGenToasts.length > 0 || annexSwapProgress.some((p) => !p.hidden)) && (
        <div className="fixed bottom-4 right-4 z-[75] flex max-w-sm flex-col gap-2 pointer-events-none">
          {annexSwapProgress.filter((p) => !p.hidden).map((progress) => (
            <div key={progress.key} className="pointer-events-auto animate-in slide-in-from-bottom-2 fade-in duration-300">
              <AnnexSwapProgressCard
                progress={progress}
                compact
                onDismiss={() => dismissAnnexSwap(progress.key)}
                onHide={() => hideAnnexSwap(progress.key)}
              />
            </div>
          ))}
          <McqGenProgressToast items={activeGenToasts} onOpen={setGenModalEntry} />
        </div>
      )}

      {/* Regenerate password prompt — gates the destructive "archive + regenerate"
          action behind a password so it isn't triggered by an accidental click. */}
      {regenTarget && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          onClick={cancelRegenerate}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-2">
              <Lock className="h-4 w-4 text-purple-600" />
              <h3 className="text-sm font-bold text-gray-800">Regenerate MCQs</h3>
            </div>
            <p className="mb-4 text-xs leading-relaxed text-gray-500">
              Enter the password to regenerate{" "}
              {regenTarget.language ? `${regenTarget.language === "Gujarati" ? "Gujarati" : "English"} MCQs` : "MCQs"} for{" "}
              <span className="font-semibold text-gray-700">{displaySopCode(regenTarget.entry.identifier)}</span>.
              This archives the current bank to Obsolete MCQs and generates a fresh set.
            </p>
            <form onSubmit={(e) => { e.preventDefault(); confirmRegenerate(); }}>
              <input
                type="password"
                autoFocus
                value={regenPassword}
                onChange={(e) => { setRegenPassword(e.target.value); setRegenError(null); }}
                placeholder="Password"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-purple-400 focus:outline-none"
              />
              {regenError && (
                <p className="mt-2 text-xs font-semibold text-red-500">{regenError}</p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelRegenerate}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-700"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Regenerate
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          onClick={cancelDelete}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-2">
              <Trash2 className="h-4 w-4 text-rose-600" />
              <h3 className="text-sm font-bold text-gray-800">Delete MCQs</h3>
            </div>
            <p className="mb-4 text-xs leading-relaxed text-gray-500">
              Enter the password to permanently delete{" "}
              <span className="font-semibold text-gray-700">{deleteScopeLabel(deleteTarget.scope)}</span> for{" "}
              <span className="font-semibold text-gray-700">{displaySopCode(deleteTarget.entry.identifier)}</span>.
              This cannot be undone.
            </p>
            <form onSubmit={(e) => { e.preventDefault(); void confirmDelete(); }}>
              <input
                type="password"
                autoFocus
                value={deletePassword}
                onChange={(e) => { setDeletePassword(e.target.value); setDeleteError(null); }}
                placeholder="Password"
                disabled={deleteLoading}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:border-rose-400 focus:outline-none disabled:opacity-60"
              />
              {deleteError && (
                <p className="mt-2 text-xs font-semibold text-red-500">{deleteError}</p>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={cancelDelete}
                  disabled={deleteLoading}
                  className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50 disabled:opacity-60"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={deleteLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 disabled:opacity-60"
                >
                  {deleteLoading ? (
                    <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Deleting…</>
                  ) : (
                    <><Trash2 className="h-3.5 w-3.5" /> Delete</>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Annexure swap confirm — removes ~15 duplicate/similar MCQs and generates
          replacements from the linked annexures. */}
      {annexSwapTarget && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setAnnexSwapTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-1 flex items-center gap-2">
              <Paperclip className="h-4 w-4 text-teal-600" />
              <h3 className="text-sm font-bold text-gray-800">Swap in annexure MCQs</h3>
            </div>
            <p className="mb-4 text-xs leading-relaxed text-gray-500">
              This removes up to <span className="font-semibold text-gray-700">15</span>{" "}
              {annexSwapTarget.language === "Gujarati" ? "Gujarati" : "English"} MCQs for{" "}
              <span className="font-semibold text-gray-700">{displaySopCode(annexSwapTarget.entry.identifier)}</span>{" "}
              — duplicate and similar questions only. Creative-fill, unique SOP MCQs, approved, and
              existing annexure questions stay. Fresh questions are generated from linked annexures via{" "}
              <span className="font-semibold text-gray-700">{selectedProvider}</span>
              {selectedProvider === "codex" ? " (Codex swaps 8 at a time for speed)" : ""}. Progress
              and logs appear in the bottom-right panel while it runs.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setAnnexSwapTarget(null)}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-semibold text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmAnnexureSwap()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700"
              >
                <Paperclip className="h-3.5 w-3.5" /> Swap MCQs
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Department folder modal (Digital Repository) — opened from a dept capsule/card.
          Rendered before the viewer so the MCQ viewer stacks on top when both are open. */}
      {modalDept && (
        <DeptDetailModal
          dept={modalDept}
          deptColor={getDeptModalColor(modalDept)}
          onClose={() => setModalDept(null)}
          onViewMcqs={(bankId) => setViewerBankId(bankId)}
        />
      )}

      {/* MCQ Viewer Modal */}
      {viewerBankId && (
        <MCQViewerModal
          bankId={viewerBankId}
          onClose={() => setViewerBankId(null)}
          onBack={() => setViewerBankId(null)}
        />
      )}

      <div className="min-h-screen bg-gray-50">
        {/* ── Header ── */}
        <div className="border-b border-slate-200 bg-white px-6 py-4 shadow-sm">
          <div className="mx-auto max-w-[1920px]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-xl font-black text-slate-800">MCQ Question Bank</h1>
                <p className="text-xs text-slate-500">
                  Browse and manage your generated MCQ banks ({fmt(totalBanks)} total)
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => router.back()}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  ← Back
                </button>
                <button type="button" onClick={() => router.push("/dashboard")}
                  className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-700">
                  <Home className="h-3.5 w-3.5" /> Home
                </button>
                {userIsAdmin && (
                  <>
                    <button
                      type="button"
                      onClick={() => void stopAllGeneration()}
                      disabled={stopAllLoading}
                      className="flex items-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-60"
                      title="Emergency stop — kills all in-flight MCQ generation"
                    >
                      {stopAllLoading ? (
                        <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Stopping…</>
                      ) : (
                        <>Stop all generation</>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedProvider("claude")}
                      title={
                        selectedProvider === "claude" && claudeStatus?.ok
                          ? `Claude Haiku via your subscription (${claudeStatus.email ?? "logged in"} · ${claudeStatus.subscriptionType ?? "active"} · ${claudeStatus.mcqModel ?? "claude-haiku-4-5"}) — default MCQ generator`
                          : selectedProvider === "claude" && claudeStatus?.error
                            ? `Claude not connected: ${claudeStatus.error}`
                            : "Claude Haiku — default MCQ generator (100 unique questions per language)"
                      }
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                        selectedProvider === "claude"
                          ? claudeStatus?.ok === false && !claudeStatus?.loading
                            ? "border border-red-600 bg-red-600 text-white hover:bg-red-700 ring-2 ring-red-300"
                            : "border border-violet-600 bg-violet-600 text-white hover:bg-violet-700 ring-2 ring-violet-300"
                          : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      {selectedProvider === "claude"
                        ? claudeStatus?.loading
                          ? "Claude…"
                          : claudeStatus?.ok
                            ? "Claude ✓"
                            : "Claude !"
                        : "Claude"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedProvider("codex")}
                      title={
                        selectedProvider === "codex" && codexStatus?.ok
                          ? `Codex via your ChatGPT subscription (${codexStatus.mcqModel ?? "gpt-5.4-mini"}) — local CLI, no API key`
                          : selectedProvider === "codex" && codexStatus?.error
                            ? `Codex not connected: ${codexStatus.error}`
                            : "Codex gpt-5.4-mini — local CLI via ChatGPT subscription (no API key)"
                      }
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                        selectedProvider === "codex"
                          ? codexStatus?.ok === false && !codexStatus?.loading
                            ? "border border-red-600 bg-red-600 text-white hover:bg-red-700 ring-2 ring-red-300"
                            : "border border-sky-600 bg-sky-600 text-white hover:bg-sky-700 ring-2 ring-sky-300"
                          : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <Bot className="h-3.5 w-3.5" />
                      {selectedProvider === "codex"
                        ? codexStatus?.loading
                          ? "Codex…"
                          : codexStatus?.ok
                            ? "Codex ✓"
                            : "Codex !"
                        : "Codex"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedProvider("ollama")}
                      title={selectedProvider === "ollama" ? "Using local Ollama model (gemma3:12b)" : "Use local Ollama model (gemma3:12b) for MCQ generation"}
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                        selectedProvider === "ollama"
                          ? "border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 ring-2 ring-emerald-300"
                          : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <Cpu className="h-3.5 w-3.5" />
                      {selectedProvider === "ollama" ? "Local AI (Gemma3)" : "Local AI"}
                    </button>
                    <button type="button"
                      className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900">
                      <Monitor className="h-3.5 w-3.5" /> Dev Mode
                    </button>
                    <button type="button" onClick={() => setRefreshKey((k) => k + 1)}
                      className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700">
                      <RefreshCw className={`h-3.5 w-3.5 ${statsLoading ? "animate-spin" : ""}`} /> Refresh
                    </button>
                    <button type="button" onClick={toggleObsoleteView}
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors ${
                        obsoleteOnly ? "bg-red-700 hover:bg-red-800 ring-2 ring-red-300" : "bg-red-500 hover:bg-red-600"
                      }`}>
                      Obsolete MCQs{stats?.obsoleteMcqs?.count ? ` (${stats.obsoleteMcqs.count})` : ""}
                    </button>
                    <button type="button"
                      className="flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-600">
                      Similar Questions
                    </button>
                    <button type="button" onClick={() => router.push("/dashboard")}
                      className="flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-900">
                      <Upload className="h-3.5 w-3.5" /> Upload SOP
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mx-auto max-w-[1920px] space-y-6 px-6 py-4">

          {/* Error banner */}
          {statsError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {statsError}
            </div>
          )}
          {userIsAdmin && selectedProvider === "claude" && claudeStatus && !claudeStatus.loading && (
            <div
              className={`rounded-lg border px-4 py-3 text-sm ${
                claudeStatus.ok
                  ? "border-violet-200 bg-violet-50 text-violet-900"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {claudeStatus.ok ? (
                <>
                  Connected to your Claude subscription as <strong>{claudeStatus.email}</strong>
                  {claudeStatus.subscriptionType ? ` (${claudeStatus.subscriptionType})` : ""}
                  {" · "}MCQ model: <strong>{claudeStatus.mcqModel ?? "claude-haiku-4-5"}</strong>
                  {" · "}
                  {claudeStatus.mcqApiDirect ? (
                    <>Anthropic API (fast bulk batches)</>
                  ) : (
                    <>
                      Claude CLI (slow) — add <code className="rounded bg-violet-100 px-1">ANTHROPIC_API_KEY</code> to{" "}
                      <code className="rounded bg-violet-100 px-1">.env.local</code> for ~10× faster generation
                    </>
                  )}
                </>
              ) : (
                <>
                  Claude is not connected on this machine. Run <code className="rounded bg-red-100 px-1">claude auth login</code> in a terminal, then refresh.
                  {claudeStatus.error ? ` — ${claudeStatus.error}` : ""}
                </>
              )}
            </div>
          )}

          {userIsAdmin && selectedProvider === "codex" && codexStatus && !codexStatus.loading && (
            <div
              className={`rounded-lg border px-4 py-3 text-sm ${
                codexStatus.ok
                  ? "border-sky-200 bg-sky-50 text-sky-900"
                  : "border-red-200 bg-red-50 text-red-700"
              }`}
            >
              {codexStatus.ok ? (
                <>
                  Codex is connected via your ChatGPT subscription
                  {codexStatus.authMode ? ` (${codexStatus.authMode})` : ""}
                  {" · "}MCQ model: <strong>{codexStatus.mcqModel ?? "gpt-5.4-mini"}</strong>
                  {codexStatus.codexVersion ? ` · CLI v${codexStatus.codexVersion}` : ""}
                  {" · "}No OpenAI API key required — uses local <code className="rounded bg-sky-100 px-1">codex exec</code>
                </>
              ) : (
                <>
                  Codex is not connected on this machine. Run <code className="rounded bg-red-100 px-1">codex login</code> in a terminal, then refresh.
                  {codexStatus.error ? ` — ${codexStatus.error}` : ""}
                </>
              )}
            </div>
          )}

          {/* ── MCQ STATUS CARDS — horizontal scroll grid ── */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <BookOpen className="h-3.5 w-3.5 text-purple-400" />
              <span className="text-[10px] font-black text-gray-700 uppercase tracking-widest">MCQ Status</span>
              {statsLoading && <span className="text-[9px] text-gray-500 animate-pulse">Loading…</span>}
            </div>

            <div className="w-full px-1 py-2 sm:px-2 overflow-x-auto">
              {statsLoading ? (
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(8, minmax(150px, 1fr))` }}>
                  {[...Array(8)].map((_, i) => (
                    <div key={i} className="rounded-[10px] border border-gray-200 bg-white p-3 space-y-2 animate-pulse">
                      <div className="h-3 bg-gray-200 rounded w-3/4" />
                      <div className="h-2 bg-gray-100 rounded w-1/2" />
                      <div className="space-y-1 mt-2">
                        {[...Array(6)].map((_, j) => (
                          <div key={j} className="h-5 bg-gray-100 rounded" />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : stats && globalCard ? (
                <div className="grid items-stretch gap-3" style={{ gridTemplateColumns: `repeat(${totalStatusCards}, minmax(165px, 1fr))` }}>
                  {/* Total card */}
                  <StatusCard
                    title="Total"
                    subtitle={`${orderedDepts.length} departments`}
                    isGrand
                    totalSOPs={globalCard.totalSOPs}
                    sopWithMCQs={globalCard.sopWithMCQs}
                    sopWithoutMCQs={globalCard.sopWithoutMCQs}
                    approvedSOPs={globalCard.approvedSOPs}
                    partialSOPs={globalCard.partialSOPs}
                    pendingSOPs={globalCard.pendingSOPs}
                    similarSOPs={globalCard.similarSOPs}
                    totalSopEng={globalCard.totalSopEng}
                    totalSopGuj={globalCard.totalSopGuj}
                    remainingEng={globalCard.remainingEng}
                    remainingGuj={globalCard.remainingGuj}
                    mcqFound={stats.mcqFound}
                    mcqNotFound={stats.notFound}
                    onOpen={() => applyDeptFilter("Total")}
                    onMcqWithClick={() => applyPresenceFilter("Total", "found")}
                    onMcqWithoutClick={() => applyPresenceFilter("Total", "notFound")}
                    onLangEnClick={() => applyLangFilter("Total", "English")}
                    onLangGuClick={() => applyLangFilter("Total", "Gujarati")}
                  />
                  {orderedDepts.map((dept) => (
                    <StatusCard
                      key={dept.department}
                      title={dept.department}
                      subtitle={`${dept.subcategories} subcategories`}
                      totalSOPs={dept.sopCount}
                      sopWithMCQs={dept.sopWithMcqs}
                      sopWithoutMCQs={dept.sopWithoutMcqs}
                      approvedSOPs={dept.approvedSops}
                      partialSOPs={dept.partialSops}
                      pendingSOPs={dept.pendingSops}
                      similarSOPs={dept.similarSops}
                      totalSopEng={dept.withEnglish}
                      totalSopGuj={dept.withGujarati}
                      remainingEng={dept.enRemaining}
                      remainingGuj={dept.guRemaining}
                      mcqFound={dept.sopWithMcqs}
                      mcqNotFound={dept.sopWithoutMcqs}
                      onOpen={() => openDeptModal(dept.department)}
                      onMcqWithClick={() => applyPresenceFilter(dept.department, "found")}
                      onMcqWithoutClick={() => applyPresenceFilter(dept.department, "notFound")}
                      onLangEnClick={() => applyLangFilter(dept.department, "English")}
                      onLangGuClick={() => applyLangFilter(dept.department, "Gujarati")}
                      onRowClick={() => applyDeptFilter(dept.department)}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          {/* ── BY DEPARTMENT — Collapsible colorful grid ── */}
          <button
            type="button"
            onClick={() => setShowDeptCards((v) => !v)}
            className="w-full flex items-center gap-3 px-4 py-3 mb-2 rounded-xl bg-white border border-gray-200 shadow-sm hover:bg-gray-50 transition-colors text-left group"
          >
            <span className="flex items-center justify-center w-7 h-7 rounded-md bg-gradient-to-br from-violet-500 to-indigo-500 shadow-sm shrink-0">
              <svg className="h-4 w-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </span>
            <div className="flex-1 min-w-0">
              <span className="text-sm font-semibold text-gray-800">
                By Department <span className="text-gray-500 font-medium">({orderedDepts.length})</span>
              </span>
              <p className="text-xs text-gray-400 leading-none mt-0.5">Filter MCQs by department</p>
            </div>
            <span className="text-gray-400 group-hover:text-gray-600 transition-colors shrink-0">
              <ChevronDown className={`h-4 w-4 transition-transform duration-200 ${showDeptCards ? "" : "-rotate-90"}`} />
            </span>
          </button>

          {showDeptCards && (
            statsLoading ? (
              <DeptGridSkeleton count={8} />
            ) : stats ? (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {orderedDepts.map((dept) => (
                  <DeptColorCard
                    key={dept.department}
                    dept={dept}
                    onClick={() => openDeptModal(dept.department)}
                    onMcqWithClick={() => applyPresenceFilter(dept.department, "found")}
                    onMcqWithoutClick={() => applyPresenceFilter(dept.department, "notFound")}
                  />
                ))}
              </div>
            ) : null
          )}

          {/* ── MCQ REGISTRY TABLE ── */}
          <div className="mt-8" ref={mcqRegistryRef}>
            {/* Section header */}
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-purple-500/10 border border-purple-500/20">
                  <LayoutList className="h-5 w-5 text-purple-400" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-gray-800 uppercase tracking-widest">
                    {obsoleteOnly ? "Obsolete MCQs" : "MCQ Registry"}
                  </h3>
                  <p className="text-[10px] text-gray-500 mt-0.5">
                    {regLoading ? "Loading…" : obsoleteOnly
                      ? `${total} obsolete MCQ ${total === 1 ? "family" : "families"}`
                      : `${total} SOP${total === 1 ? "" : "s"}${deptFilter !== "all" ? ` · ${deptFilter}` : ""}${mcqPresence === "notFound" ? " · Not Found" : mcqPresence === "found" ? " · MCQ Found" : ""}${langMcqFilter === "en" ? " · w/ EN MCQs" : langMcqFilter === "gu" ? " · w/ GU MCQs" : ""}`}
                  </p>
                </div>
              </div>

              {/* Controls */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-500 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search SOPs..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-8 pr-3 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-800 text-[11px] placeholder-gray-400 focus:outline-none focus:border-purple-400 w-44 transition-colors"
                  />
                </div>
                {!obsoleteOnly && (
                  <select
                    value={deptFilter}
                    onChange={(e) => { setDeptFilter(e.target.value); setMcqPresence("all"); setLangMcqFilter("all"); }}
                    className="px-2.5 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-800 text-[11px] focus:outline-none focus:border-purple-400 cursor-pointer"
                  >
                    <option value="all">All Depts</option>
                    {stats?.departments.map((d) => (
                      <option key={d.department} value={d.department}>{d.department}</option>
                    ))}
                  </select>
                )}
                {deptFilter !== "all" && !obsoleteOnly && (
                  <button
                    type="button"
                    onClick={() => setDeptFilter("all")}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-purple-100 border border-purple-300 text-purple-700 text-[10px] font-bold hover:bg-purple-200 transition-colors"
                  >
                    {deptFilter} <X className="h-3 w-3 ml-0.5" />
                  </button>
                )}
                {mcqPresence !== "all" && !obsoleteOnly && (
                  <button
                    type="button"
                    onClick={() => setMcqPresence("all")}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[10px] font-bold transition-colors ${
                      mcqPresence === "notFound"
                        ? "bg-red-100 border-red-300 text-red-700 hover:bg-red-200"
                        : "bg-emerald-100 border-emerald-300 text-emerald-700 hover:bg-emerald-200"
                    }`}
                  >
                    {mcqPresence === "notFound" ? "Not Found" : "MCQ Found"} <X className="h-3 w-3 ml-0.5" />
                  </button>
                )}
                {langMcqFilter !== "all" && !obsoleteOnly && (
                  <button
                    type="button"
                    onClick={() => setLangMcqFilter("all")}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-blue-300 bg-blue-100 text-blue-700 text-[10px] font-bold hover:bg-blue-200 transition-colors"
                  >
                    {langMcqFilter === "en" ? "w/ EN MCQs" : "w/ GU MCQs"} <X className="h-3 w-3 ml-0.5" />
                  </button>
                )}
                <select
                  value={regLangFilter}
                  onChange={(e) => setRegLangFilter(e.target.value)}
                  className="px-2.5 py-1.5 rounded-lg bg-white border border-gray-300 text-gray-800 text-[11px] focus:outline-none focus:border-purple-400 cursor-pointer"
                >
                  <option value="All">All Languages</option>
                  <option value="English">English</option>
                  <option value="Gujarati">Gujarati</option>
                </select>
                {search && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-gray-100 border border-gray-300 text-gray-600 text-[10px] font-bold hover:bg-gray-200 transition-colors"
                  >
                    Clear <X className="h-3 w-3 ml-0.5" />
                  </button>
                )}
              </div>
            </div>

            {regError && (
              <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{regError}</div>
            )}

            {/* Table — chrome matches the SOP Registry (sticky gray-100 header) */}
            <div className="rounded-2xl border border-gray-200 overflow-hidden bg-gray-50">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-gray-100 border-b border-gray-300">
                      {([
                        ["identifier", "SOP No."],
                        ["name", "SOP Name"],
                        ["dept", "Dept"],
                        ["annexure", "Annex"],
                        ["lang", "Lang"],
                        ["totalMcqs", "Total MCQs"],
                        ["enMcqCount", "ENG MCQs"],
                        ["guMcqCount", "GUJ MCQs"],
                        ["remaining", "Remaining"],
                        ["approved", "Approved"],
                        ["partial", "Partial"],
                        ["similar", "Similar"],
                        ["lastUpdated", "Last Updated"],
                      ] as [string, string][]).map(([col, label]) => (
                        <th
                          key={col}
                          onClick={() => handleSort(col)}
                          className="px-3 py-3 text-[9px] font-bold uppercase tracking-wide text-gray-600 cursor-pointer hover:text-purple-700 whitespace-nowrap select-none transition-colors"
                        >
                          {label}<SortIcon col={col} current={sortCol} dir={sortDir} />
                        </th>
                      ))}
                      <th className="px-3 py-3 text-[9px] font-bold uppercase tracking-wide text-gray-600 whitespace-nowrap">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {regLoading ? (
                      [...Array(8)].map((_, i) => (
                        <tr key={i} className="border-b border-gray-200">
                          {[...Array(14)].map((_, j) => (
                            <td key={j} className="px-3 py-3">
                              <div className="h-3 animate-pulse rounded bg-gray-200" />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : filteredEntries.length === 0 ? (
                      <tr>
                        <td colSpan={14} className="text-center py-12 text-gray-500 text-sm">
                          No MCQ banks match the current filters.
                        </td>
                      </tr>
                    ) : filteredEntries.map((entry, idx) => (
                      <RegistryRow
                        key={entry.id || `${entry.identifier}||${entry.language}`}
                        entry={entry}
                        isEven={idx % 2 === 0}
                        onViewMcqs={(id) => setViewerBankId(id)}
                        onGenerate={handleGenerate}
                        onRegenerate={requestRegenerate}
                        onContinue={handleContinue}
                        onDeleteRequest={requestDelete}
                        onOpenProgress={setGenModalEntry}
                        onStop={(e) => void stopGeneration(e)}
                        onAnnexureSwap={requestAnnexureSwap}
                        annexureSwapLang={
                          annexSwapProgress.some(
                            (p) => p.key === `${entry.id}::English` && p.status === "running",
                          )
                            ? "English"
                            : annexSwapProgress.some(
                                  (p) => p.key === `${entry.id}::Gujarati` && p.status === "running",
                                )
                              ? "Gujarati"
                              : null
                        }
                        genStatus={genStatus[entry.id]}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

        </div>
      </div>
    </>
  );
}
