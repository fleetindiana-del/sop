"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  Search,
  Star,
  Users,
  X,
  Zap,
} from "lucide-react";
import { displaySopCode, displaySopTitle } from "@/lib/sop-display";

interface DeptSopEntry {
  sopId: string;
  sopCode: string;
  sopName: string;
  sopNameGujarati: string | null;
  language: string;
  department: string;
  trainerName: string;
  totalQuestions: number;
  checkedCount: number;
  reviewedCount: number;
  similarCount: number;
  hasMcq: boolean;
  /** One entry per language bank, each with its own counts. */
  mcqBanks: {
    id: string;
    language: string;
    totalQuestions: number;
    checkedCount: number;
    reviewedCount: number;
    similarCount: number;
  }[];
  lastUpdated: string | null;
}

type DeptSopBank = DeptSopEntry["mcqBanks"][number];

interface DeptStats {
  totalQuestions: number;
  checkedCount: number;
  reviewedCount: number;
  similarCount: number;
  notChecked: number;
}

interface DeptDetailModalProps {
  dept: string;
  deptColor: { bg: string; badge: string };
  onClose: () => void;
  onViewMcqs?: (bankId: string) => void;
}

type SortKey = "sopCode" | "totalQuestions" | "checkedCount" | "reviewedCount" | "similarCount";

// Map dept bg class → gradient (dark version for reference-style header)
const DEPT_GRADIENT: Record<string, string> = {
  "bg-violet-600":  "from-violet-600 via-violet-700 to-violet-800",
  "bg-blue-600":    "from-blue-500 via-blue-600 to-blue-700",
  "bg-orange-600":  "from-orange-500 via-orange-600 to-orange-700",
  "bg-emerald-600": "from-emerald-500 via-emerald-600 to-emerald-700",
  "bg-amber-600":   "from-amber-500 via-amber-600 to-amber-700",
  "bg-cyan-600":    "from-cyan-500 via-cyan-600 to-cyan-700",
  "bg-rose-600":    "from-rose-500 via-rose-600 to-rose-600",
  "bg-slate-600":   "from-slate-500 via-slate-600 to-slate-700",
};

function fmt(n: number) { return n.toLocaleString(); }

function langTag(language: string) {
  return language.toLowerCase() === "gujarati" ? "GU" : "EN";
}

/**
 * One figure per language bank.
 *
 * A dual-language SOP holds a separate bank per language, and the row opens one
 * of them at a time — so a single summed number (100 English + 100 Gujarati =
 * 200) never matched the 100 questions the reader landed on. Split the figure
 * whenever the family has more than one bank; a single-language SOP keeps the
 * plain number it always showed.
 */
function CountCell({
  banks,
  total,
  pick,
  tone,
  weight = "font-semibold",
  dash = false,
}: {
  banks: DeptSopBank[];
  total: number;
  pick: (bank: DeptSopBank) => number;
  tone: string;
  weight?: string;
  /** Units shows an em dash for a family with no questions; counts show 0. */
  dash?: boolean;
}) {
  const cls = (n: number) => `text-xs ${weight} ${n > 0 ? tone : "text-gray-300"}`;

  if (banks.length < 2) {
    return <span className={cls(total)}>{dash && total === 0 ? "—" : fmt(total)}</span>;
  }

  return (
    <div className="flex flex-col items-center gap-0.5 leading-tight">
      {banks.map((bank) => {
        const count = pick(bank);
        return (
          <span key={bank.id} className="flex items-baseline gap-1 whitespace-nowrap">
            <span className={cls(count)}>{fmt(count)}</span>
            <span className="text-[8px] font-black uppercase tracking-widest text-gray-400">
              {langTag(bank.language)}
            </span>
          </span>
        );
      })}
    </div>
  );
}

function StatusDot({ total, checked }: { total: number; checked: number }) {
  if (total === 0) return <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-200" />;
  if (checked >= total) return <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500 shadow-[0_0_6px_#10b981]" />;
  if (checked > 0) return <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />;
  return <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-300" />;
}

export function DeptDetailModal({ dept, deptColor, onClose, onViewMcqs }: DeptDetailModalProps) {
  const [sops, setSops] = useState<DeptSopEntry[]>([]);
  const [stats, setStats] = useState<DeptStats | null>(null);
  const [counts, setCounts] = useState<{ withMcqs: number; withoutMcqs: number }>({ withMcqs: 0, withoutMcqs: 0 });
  const [trainer, setTrainer] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("sopCode");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [isCinema, setIsCinema] = useState(false);

  // Draggable modal
  const [dragging, setDragging] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button") || (e.target as HTMLElement).closest("input")) return;
    setDragging(true);
    setDragStart({ x: e.clientX - pos.x, y: e.clientY - pos.y });
  };
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => setPos({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging, dragStart]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/mcq-bank/dept-sops?dept=${encodeURIComponent(dept)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed");
        if (!cancelled) {
          setSops(data.sops ?? []);
          setStats(data.stats ?? null);
          setCounts({ withMcqs: data.withMcqs ?? 0, withoutMcqs: data.withoutMcqs ?? 0 });
          setTrainer(data.trainer ?? null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [dept]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sorted = useMemo(() => {
    const filtered = sops.filter((s) => {
      if (!search) return true;
      const lc = search.toLowerCase();
      return s.sopCode.toLowerCase().includes(lc) || s.sopName.toLowerCase().includes(lc);
    });
    return [...filtered].sort((a, b) => {
      const cmp = sortKey === "sopCode" ? a.sopCode.localeCompare(b.sopCode) : b[sortKey] - a[sortKey];
      return sortDir === "desc" ? -cmp : cmp;
    });
  }, [sops, search, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("asc"); }
  }

  const gradient = DEPT_GRADIENT[deptColor.bg] ?? "from-slate-500 via-slate-600 to-slate-700";

  function SortTh({ label, field }: { label: string; field: SortKey }) {
    const active = sortKey === field;
    return (
      <button type="button" onClick={() => toggleSort(field)}
        className="flex items-center gap-1 text-left text-[9px] font-black uppercase tracking-widest text-gray-500 hover:text-gray-800 transition-colors">
        {label}
        {active
          ? (sortDir === "asc" ? <ChevronUp className="h-3 w-3 text-gray-700" /> : <ChevronDown className="h-3 w-3 text-gray-700" />)
          : null}
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-in fade-in duration-300 sm:p-6 lg:p-8">
      {/* Backdrop */}
      <div className="absolute inset-0 cursor-pointer bg-black/60 backdrop-blur-sm" onClick={onClose} />

      <div
        className={`relative flex flex-col overflow-hidden border border-gray-200 bg-white shadow-2xl transition-all duration-500 ${
          isCinema ? "h-full w-full rounded-none" : "h-[92vh] w-full max-w-[90rem] rounded-[32px]"
        }`}
        style={!isCinema ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : undefined}
      >
        {/* ── Gradient header ── */}
        {!isCinema && (
          <div
            onMouseDown={handleMouseDown}
            className={`relative shrink-0 cursor-grab overflow-hidden border-b border-white/5 bg-gradient-to-br px-8 py-6 shadow-lg active:cursor-grabbing animate-in slide-in-from-top duration-500 ${gradient}`}
          >
            <div className="relative flex items-start justify-between">
              {/* Left: dept info */}
              <div className="flex items-center gap-6">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/20 shadow-[0_10px_30px_rgba(0,0,0,0.3)] text-3xl">
                  📁
                </div>

                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-4">
                    <h2 className="text-3xl font-black tracking-tight text-white leading-none">{dept}</h2>
                    <div className="flex items-center gap-2">
                      <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-white/50">
                        Digital Repository
                      </span>
                      {trainer && (
                        <div className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-3 py-1">
                          <Users className="h-3 w-3 opacity-70 text-white" />
                          <span className="text-[10px] font-bold uppercase tracking-widest text-white">{trainer}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-5">
                    {stats && (
                      <>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-1.5 rounded-full bg-indigo-400 shadow-[0_0_10px_#6366f1]" />
                          <span className="text-[11px] font-bold uppercase tracking-widest text-white/60">
                            <strong className="mr-1.5 text-white">{fmt(stats.totalQuestions)}</strong>Question Units
                          </span>
                        </div>
                        <div className="h-1.5 w-1.5 rounded-full bg-white/10" />
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_#10b981]" />
                          <span className="text-[11px] font-bold uppercase tracking-widest text-white/60">
                            <strong className="mr-1.5 text-white">{sops.length}</strong>Active SOPs
                          </span>
                        </div>
                        <div className="h-1.5 w-1.5 rounded-full bg-white/10" />
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_#10b981]" />
                          <span className="text-[11px] font-bold uppercase tracking-widest text-white/60">
                            <strong className="mr-1.5 text-white">{counts.withMcqs}</strong>With MCQs
                          </span>
                        </div>
                        <div className="h-1.5 w-1.5 rounded-full bg-white/10" />
                        <div className="flex items-center gap-2">
                          <div className={`h-1.5 w-1.5 rounded-full ${counts.withoutMcqs > 0 ? "bg-rose-400 shadow-[0_0_10px_#f43f5e]" : "bg-white/30"}`} />
                          <span className="text-[11px] font-bold uppercase tracking-widest text-white/60">
                            <strong className="mr-1.5 text-white">{counts.withoutMcqs}</strong>Without MCQs
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Filter pill stats */}
                  {stats && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {[
                        { id: "approved", label: "Approved", count: stats.checkedCount,
                          cls: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20",
                          icon: <CheckCircle2 className="h-3 w-3" /> },
                        { id: "notChecked", label: "Not Checked", count: stats.notChecked,
                          cls: "border-rose-500/20 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
                          icon: <AlertCircle className="h-3 w-3" /> },
                        { id: "similar", label: "Similar", count: stats.similarCount,
                          cls: "border-orange-500/20 bg-orange-500/10 text-orange-300 hover:bg-orange-500/20",
                          icon: <AlertCircle className="h-3 w-3" /> },
                        { id: "reviewed", label: "Reviewed", count: stats.reviewedCount,
                          cls: "border-indigo-500/20 bg-indigo-500/10 text-indigo-300 hover:bg-indigo-500/20",
                          icon: <Star className="h-3 w-3" /> },
                      ].map((p) => (
                        <span key={p.id}
                          className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[8px] font-black uppercase tracking-[0.2em] transition-all ${p.cls}`}>
                          {p.icon}
                          {p.label}: {fmt(p.count)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Right: actions */}
              <div className="flex items-center gap-2">
                <button type="button"
                  className="flex items-center gap-2 rounded-lg border border-white/30 bg-white/20 px-4 py-2 text-[9px] font-bold uppercase tracking-widest text-white backdrop-blur-xl shadow-lg transition-all hover:bg-white/30">
                  <Zap className="h-3 w-3" />
                  Bulk Smart Regen
                </button>
                <button type="button"
                  className="flex items-center gap-2 rounded-lg border border-white/30 bg-white/20 px-4 py-2 text-[9px] font-bold uppercase tracking-widest text-white backdrop-blur-xl shadow-lg transition-all hover:bg-white/30">
                  <Star className="h-3 w-3 fill-amber-300 text-amber-300" />
                  Review
                </button>
                <button type="button" onClick={() => setIsCinema(true)}
                  className="rounded-lg border border-white/30 bg-white/20 p-2.5 shadow-md transition-all hover:bg-white/30 group">
                  <Maximize2 className="h-4 w-4 text-white transition-all duration-300" />
                </button>
                <button type="button" onClick={onClose}
                  className="rounded-lg border border-white/30 bg-white/20 p-2.5 shadow-md transition-all hover:bg-white/30 group">
                  <X className="h-4 w-4 text-white transition-all duration-300 group-hover:rotate-90" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Search / toolbar ── */}
        <div className="shrink-0 flex items-center justify-between border-b border-gray-200 bg-gray-50 px-6 py-3 shadow-sm">
          {isCinema && (
            <div className="mr-4 flex items-center gap-3">
              <button type="button" onClick={() => setIsCinema(false)}
                className="rounded-lg border border-indigo-200 bg-indigo-50 p-2 text-indigo-600 transition-all hover:bg-indigo-100">
                <Minimize2 className="h-4 w-4" />
              </button>
              <div>
                <p className="text-[9px] font-black uppercase tracking-widest text-indigo-600 leading-none mb-0.5">{dept}</p>
                <p className="text-[7px] font-bold uppercase tracking-tighter text-gray-400">Expand View Active</p>
              </div>
            </div>
          )}

          <div className="relative max-w-md flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Query SOPs, codes..."
              className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-8 text-xs text-gray-700 placeholder-gray-400 transition-all focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-200 shadow-sm" />
            {search && (
              <button type="button" onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700 transition-colors">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <div className="ml-4 flex items-center gap-2">
            {isCinema && (
              <button type="button" onClick={onClose}
                className="rounded-lg border border-gray-200 bg-white p-2 transition-all hover:border-rose-300 hover:bg-rose-50 group">
                <X className="h-4 w-4 text-gray-500 group-hover:text-rose-600" />
              </button>
            )}
          </div>
        </div>

        {/* ── Table ── */}
        <div className="flex-1 overflow-auto bg-gray-50 p-6">
          {loading ? (
            <div className="flex h-64 items-center justify-center">
              <div className="relative">
                <div className="h-16 w-16 animate-spin rounded-full border-4 border-indigo-100 border-t-indigo-500" />
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="h-6 w-6 animate-pulse text-indigo-500" />
                </div>
              </div>
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">{error}</div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-100/70">
                    <th className="w-6 px-4 py-3" />
                    <th className="px-4 py-3"><SortTh label="Protocol ID" field="sopCode" /></th>
                    <th className="px-4 py-3 text-[9px] font-black uppercase tracking-widest text-gray-500">SOP Name</th>
                    <th className="px-4 py-3 text-center"><SortTh label="Units" field="totalQuestions" /></th>
                    <th className="px-4 py-3 text-center"><SortTh label="Approved" field="checkedCount" /></th>
                    <th className="px-4 py-3 text-center"><SortTh label="Reviewed" field="reviewedCount" /></th>
                    <th className="px-4 py-3 text-center"><SortTh label="Similar" field="similarCount" /></th>
                    <th className="px-4 py-3 text-[9px] font-black uppercase tracking-widest text-gray-500">Lang</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {sorted.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-16 text-center text-sm text-gray-400">
                        {search ? `No SOPs match "${search}"` : `No SOPs found for ${dept}`}
                      </td>
                    </tr>
                  ) : (
                    sorted.map((entry, idx) => {
                      const hasBanks = entry.hasMcq && entry.mcqBanks.length > 0;
                      const defaultBank = entry.mcqBanks.find(
                        (b) => b.language.toLowerCase() !== "gujarati"
                      ) ?? entry.mcqBanks[0];

                      return (
                        <tr
                          key={`${entry.sopCode}-${idx}`}
                          onClick={() => hasBanks && defaultBank && onViewMcqs?.(defaultBank.id)}
                          className={`transition-colors hover:bg-indigo-50/50 ${hasBanks ? "cursor-pointer group/row" : ""}`}
                        >
                          <td className="px-4 py-3">
                            <StatusDot total={entry.totalQuestions} checked={entry.checkedCount} />
                          </td>
                          {/* SOP No. — matches the Dashboard SOP Registry (font-mono, 13px, purple-700) */}
                          <td className="whitespace-nowrap px-4 py-3 font-mono text-[13px] font-bold tracking-wider text-purple-700">
                            <span className={`block truncate transition-colors ${hasBanks ? "group-hover/row:underline underline-offset-2" : ""}`} title={displaySopCode(entry.sopCode)}>
                              {displaySopCode(entry.sopCode)}
                            </span>
                          </td>
                          {/* SOP Name — matches the Dashboard SOP Registry (12px bold, Gujarati subline) */}
                          <td className="max-w-[260px] px-4 py-3">
                            <div className="flex min-w-0 flex-col gap-0 leading-tight">
                              <span
                                className="line-clamp-2 text-[12px] font-bold leading-tight text-gray-900 wrap-break-word"
                                title={displaySopTitle(entry.sopName, entry.sopCode)}
                              >
                                {displaySopTitle(entry.sopName, entry.sopCode)}
                              </span>
                              {entry.sopNameGujarati && (
                                <span
                                  className="line-clamp-2 text-[10px] font-bold leading-tight text-indigo-700 wrap-break-word"
                                  title={displaySopTitle(entry.sopNameGujarati, entry.sopCode)}
                                >
                                  {displaySopTitle(entry.sopNameGujarati, entry.sopCode)}
                                </span>
                              )}
                              {entry.trainerName && (
                                <span className="truncate text-[10px] text-gray-400">{entry.trainerName}</span>
                              )}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-center">
                            <CountCell
                              banks={entry.mcqBanks}
                              total={entry.totalQuestions}
                              pick={(b) => b.totalQuestions}
                              tone="text-gray-800"
                              weight="font-bold"
                              dash
                            />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-center">
                            <CountCell
                              banks={entry.mcqBanks}
                              total={entry.checkedCount}
                              pick={(b) => b.checkedCount}
                              tone="text-emerald-600"
                            />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-center">
                            <CountCell
                              banks={entry.mcqBanks}
                              total={entry.reviewedCount}
                              pick={(b) => b.reviewedCount}
                              tone="text-indigo-600"
                            />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-center">
                            <CountCell
                              banks={entry.mcqBanks}
                              total={entry.similarCount}
                              pick={(b) => b.similarCount}
                              tone="text-orange-500"
                            />
                          </td>
                          <td className="whitespace-nowrap px-4 py-3" onClick={(e) => e.stopPropagation()}>
                            {hasBanks ? (
                              <div className="flex items-center gap-1">
                                {entry.mcqBanks.map((b) => (
                                  <button key={b.id} type="button"
                                    onClick={() => onViewMcqs?.(b.id)}
                                    className={`rounded-lg px-2.5 py-1 text-[9px] font-black uppercase tracking-widest transition-all border ${
                                      b.language.toLowerCase() === "gujarati"
                                        ? "border-orange-300 bg-orange-50 text-orange-600 hover:bg-orange-100"
                                        : "border-indigo-300 bg-indigo-50 text-indigo-600 hover:bg-indigo-100"
                                    }`}>
                                    {b.language.toLowerCase() === "gujarati" ? "GU" : "EN"}
                                  </button>
                                ))}
                              </div>
                            ) : (
                              <span
                                className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-rose-50 px-2 py-1 text-[8px] font-black uppercase tracking-widest text-rose-600"
                                title="No MCQs generated for the current active version"
                              >
                                <AlertCircle className="h-3 w-3" />
                                MCQ Not Found
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-gray-200 bg-gray-50 px-6 py-2 text-center text-[9px] font-bold uppercase tracking-widest text-gray-400">
          {sorted.length} SOP{sorted.length !== 1 ? "s" : ""} · {dept} Department
        </div>
      </div>
    </div>
  );
}
