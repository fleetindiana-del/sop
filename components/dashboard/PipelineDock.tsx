"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, Minus, X, XCircle } from "lucide-react";
import { bustDashboardCache } from "@/lib/cache";
import { useDashboardStore } from "@/lib/store/dashboard-store";
import { displaySopCode } from "@/lib/sop-display";

type McqLive = {
  status?: string;
  phase?: string;
  percent?: number;
  error?: string | null;
};

type SopLive = {
  mcq: McqLive | null;
  complianceActive: boolean;
  complianceName?: string;
};

export function PipelineDock({ onComplete }: { onComplete?: () => void }) {
  const { pipelineJobs, removePipelineJob, clearPipeline } = useDashboardStore();
  const [expanded, setExpanded] = useState(false);
  /**
   * Out of the way, but still running. Minimising leaves only a small badge in
   * the corner — unlike Dismiss, which stops tracking the run altogether. The
   * polling effect above is unaffected either way, so generation and compliance
   * carry on in the background and the dock comes back with live progress.
   */
  const [minimized, setMinimized] = useState(false);
  const [live, setLive] = useState<Record<string, SopLive>>({});
  const completedRef = useRef(new Set<string>());
  const refreshedRef = useRef(false);

  useEffect(() => {
    const identifiers = [...new Set(pipelineJobs.map((j) => j.identifier))];
    if (!identifiers.length) {
      setLive({});
      return;
    }

    let active = true;

    const poll = async () => {
      let complianceById = new Map<string, string>();
      try {
        const cRes = await fetch("/api/compliance/active");
        if (cRes.ok) {
          const cData = await cRes.json();
          for (const run of cData.runs ?? []) {
            if (run.identifier) {
              complianceById.set(String(run.identifier).toUpperCase(), run.name ?? "");
            }
          }
        }
      } catch {
        /* ignore */
      }

      const next: Record<string, SopLive> = {};

      for (const identifier of identifiers) {
        let mcq: McqLive | null = null;
        try {
          const res = await fetch(
            `/api/sop/generate-mcqs/status?identifier=${encodeURIComponent(identifier)}`,
          );
          if (res.ok) {
            const data = await res.json();
            mcq = {
              status: data.status,
              phase: data.phase,
              percent: data.percent,
              error: data.error,
            };
          }
        } catch {
          /* ignore */
        }

        const complianceActive = complianceById.has(identifier.toUpperCase());
        next[identifier] = {
          mcq,
          complianceActive,
          complianceName: complianceById.get(identifier.toUpperCase()),
        };

        const mcqStatus = mcq?.status;
        const mcqTerminal =
          mcqStatus === "completed" ||
          mcqStatus === "failed" ||
          mcqStatus === "cancelled";
        const allDone = mcqTerminal && !complianceActive;

        if (allDone && !completedRef.current.has(identifier)) {
          completedRef.current.add(identifier);
          const delay = mcqStatus === "completed" ? 12_000 : 4_000;
          setTimeout(() => removePipelineJob(identifier), delay);
        }
      }

      if (!active) return;
      setLive(next);
    };

    void poll();
    const interval = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [pipelineJobs, removePipelineJob]);

  useEffect(() => {
    if (pipelineJobs.length === 0 && completedRef.current.size > 0 && !refreshedRef.current) {
      refreshedRef.current = true;
      bustDashboardCache();
      onComplete?.();
      const timer = setTimeout(() => {
        clearPipeline();
        completedRef.current.clear();
        refreshedRef.current = false;
        setExpanded(false);
        setMinimized(false);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [pipelineJobs.length, onComplete, clearPipeline]);

  if (pipelineJobs.length === 0) return null;

  const runningCount = pipelineJobs.filter((j) => {
    const s = live[j.identifier];
    if (!s) return true;
    const mcqRunning =
      s.mcq &&
      (s.mcq.status === "queued" || s.mcq.status === "running" || !s.mcq.status);
    return Boolean(mcqRunning || s.complianceActive || !s.mcq);
  }).length;

  const titleCount = runningCount || pipelineJobs.length;

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        title={`Work in progress · ${titleCount} — click to reopen`}
        aria-label="Reopen work in progress"
        className="fixed bottom-4 right-4 z-50 flex h-9 w-9 items-center justify-center rounded-full border border-sky-200 bg-white text-sky-600 shadow-lg shadow-sky-100/80 transition hover:border-sky-300 hover:bg-sky-50"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        {titleCount > 1 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-sky-600 px-1 text-[9px] font-bold text-white">
            {titleCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {expanded && (
        <div className="w-80 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-2">
            <div>
              <h4 className="text-xs font-bold text-slate-800">Codex work in progress</h4>
              <p className="text-[10px] text-slate-500">
                MCQ generation + compliance for {pipelineJobs.length} SOP
                {pipelineJobs.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setMinimized(true)}
                className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                title="Minimize — keeps running in the background"
                aria-label="Minimize"
              >
                <Minus className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                title="Collapse"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="max-h-72 space-y-2 overflow-y-auto p-3">
            {pipelineJobs.map((job) => {
              const s = live[job.identifier];
              const mcqStatus = s?.mcq?.status;
              const mcqRunning =
                !mcqStatus || mcqStatus === "queued" || mcqStatus === "running";
              const mcqDone = mcqStatus === "completed";
              const mcqFailed = mcqStatus === "failed" || mcqStatus === "cancelled";
              const complianceActive = Boolean(s?.complianceActive);
              const percent = s?.mcq?.percent ?? job.progress;

              return (
                <div key={job.id} className="rounded-lg border border-slate-100 bg-slate-50/80 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[11px] font-semibold text-slate-800">
                      {displaySopCode(job.identifier)}
                    </span>
                    {(mcqRunning || complianceActive) && (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sky-500" />
                    )}
                    {mcqDone && !complianceActive && (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    )}
                    {mcqFailed && !complianceActive && (
                      <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                    )}
                  </div>

                  <div className="mt-1.5 space-y-1 text-[10px] text-slate-600">
                    <div className="flex items-center justify-between gap-2">
                      <span>
                        MCQ:{" "}
                        <span className="font-medium text-slate-800">
                          {mcqFailed
                            ? s?.mcq?.error || mcqStatus
                            : s?.mcq?.phase ||
                              (mcqDone ? "Complete" : mcqRunning ? "Running…" : "Starting…")}
                        </span>
                      </span>
                      {mcqRunning && (
                        <span className="tabular-nums text-slate-400">{Math.round(percent)}%</span>
                      )}
                    </div>
                    {mcqRunning && (
                      <div className="h-1 overflow-hidden rounded-full bg-slate-200">
                        <div
                          className="h-full bg-sky-500 transition-all"
                          style={{ width: `${Math.min(100, Math.max(4, percent))}%` }}
                        />
                      </div>
                    )}
                    <div>
                      Compliance:{" "}
                      <span className="font-medium text-slate-800">
                        {complianceActive
                          ? "Running (all guidelines)…"
                          : mcqDone
                            ? "Idle / finished"
                            : "Queued after MCQ start"}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2">
            <button
              type="button"
              onClick={() => {
                clearPipeline();
                setExpanded(false);
              }}
              className="text-[10px] font-medium text-slate-400 hover:text-slate-600"
            >
              Dismiss
            </button>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setExpanded(false)}
                className="text-[10px] font-medium text-sky-600 hover:text-sky-800"
              >
                Hide details
              </button>
              <button
                type="button"
                onClick={() => setMinimized(true)}
                className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500 hover:text-slate-800"
                title="Minimize — keeps running in the background"
              >
                <Minus className="h-3 w-3" />
                Minimize
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 rounded-full border border-sky-200 bg-white px-3.5 py-2 text-xs font-semibold text-sky-800 shadow-lg shadow-sky-100/80 transition hover:border-sky-300 hover:bg-sky-50"
        title={expanded ? "Hide details" : "Show details"}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600" />
        <span>
          Work in progress
          {titleCount > 0 ? ` · ${titleCount}` : ""}
        </span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-sky-500" />
        ) : (
          <ChevronUp className="h-3.5 w-3.5 text-sky-500" />
        )}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setMinimized(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              setMinimized(true);
            }
          }}
          className="ml-0.5 rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          title="Minimize — keeps running in the background"
          aria-label="Minimize"
        >
          <Minus className="h-3 w-3" />
        </span>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            clearPipeline();
            setExpanded(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              clearPipeline();
              setExpanded(false);
            }
          }}
          className="rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          title="Dismiss — stops tracking this run"
        >
          <X className="h-3 w-3" />
        </span>
      </button>
    </div>
  );
}

export function ToastNotification() {
  const { toast, dismissToast } = useDashboardStore();

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismissToast, 8000);
    return () => clearTimeout(timer);
  }, [toast, dismissToast]);

  if (!toast) return null;

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-800 px-4 py-2 text-sm text-white shadow-lg">
      {toast.message}
    </div>
  );
}
