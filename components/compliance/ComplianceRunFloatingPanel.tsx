"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, Square, ChevronUp, ChevronDown, ExternalLink } from "lucide-react";
import {
  complianceRunProgressPct,
  useComplianceRunStore,
} from "@/lib/store/compliance-run-store";
import { displaySopCode } from "@/lib/sop-display";

export function ComplianceRunFloatingPanel() {
  const pathname = usePathname();
  const isAnalyzing = useComplianceRunStore((s) => s.isAnalyzing);
  const isPaused = useComplianceRunStore((s) => s.isPaused);
  const isStopping = useComplianceRunStore((s) => s.isStopping);
  const panelExpanded = useComplianceRunStore((s) => s.panelExpanded);
  const analysisComplete = useComplianceRunStore((s) => s.analysisComplete);
  const guidelineName = useComplianceRunStore((s) => s.guidelineName);
  const analysisStats = useComplianceRunStore((s) => s.analysisStats);
  const sopLists = useComplianceRunStore((s) => s.sopLists);
  const serverOnlyActive = useComplianceRunStore((s) => s.serverOnlyActive);
  const stoppedMidRun = useComplianceRunStore((s) => s.stoppedMidRun);
  const serverActiveSops = useComplianceRunStore((s) => s.serverActiveSops);
  const togglePanelExpanded = useComplianceRunStore((s) => s.togglePanelExpanded);
  const togglePause = useComplianceRunStore((s) => s.togglePause);
  const stopRun = useComplianceRunStore((s) => s.stopRun);
  const dismissComplete = useComplianceRunStore((s) => s.dismissComplete);

  const progressPct = complianceRunProgressPct(analysisStats);
  const doneCount = analysisStats.completed + analysisStats.cached + analysisStats.failed;
  const remaining = Math.max(0, analysisStats.total - doneCount);
  const onCompliancePage = pathname?.startsWith("/compliance");

  const showPanel =    isAnalyzing ||
    serverOnlyActive ||
    stoppedMidRun ||
    (analysisComplete && doneCount > 0);

  if (!showPanel) return null;

  const title = isAnalyzing
    ? "Compliance check running"
    : serverOnlyActive
      ? "Compliance check active on server"
      : stoppedMidRun
        ? "Compliance check stopped"
        : "Compliance check complete";

  const subtitle = isAnalyzing
    ? `${doneCount}/${analysisStats.total} SOPs · ${progressPct}%`
    : serverOnlyActive
      ? `${serverActiveSops.length} SOP(s) processing`
      : stoppedMidRun
        ? `Stopped · ${doneCount}/${analysisStats.total} done`
        : `${doneCount} SOP(s) finished`;

  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col items-end gap-2 max-w-[min(100vw-2rem,24rem)]">
      {panelExpanded && (
        <div className="w-full rounded-2xl border border-purple-200 bg-white shadow-2xl shadow-purple-200/40 overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div className="bg-gradient-to-r from-purple-600 to-violet-600 px-4 py-3 text-white">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-bold leading-tight">{title}</p>
                {guidelineName && (
                  <p className="text-[11px] text-purple-100 mt-0.5 truncate" title={guidelineName}>
                    Guideline: {guidelineName}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={togglePanelExpanded}
                className="p-1 rounded-lg hover:bg-white/15 transition-colors flex-shrink-0"
                aria-label="Collapse panel"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="p-4 space-y-3">
            {isAnalyzing && (
              <>
                <div>
                  <div className="flex justify-between text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                    <span>Progress</span>
                    <span>{progressPct}%</span>
                  </div>
                  <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-purple-600 rounded-full transition-all duration-500"
                      style={{ width: `${progressPct}%` }}
                    />
                  </div>
                </div>

                {analysisStats.currentSopName && (
                  <div className="rounded-xl bg-purple-50 border border-purple-100 px-3 py-2.5">
                    <p className="text-[10px] font-bold text-purple-600 uppercase tracking-wider">
                      Current SOP
                    </p>
                    <p className="text-sm font-semibold text-gray-800 truncate">
                      {analysisStats.currentSopName}
                    </p>
                    <p className="text-xs font-mono text-purple-600">
                      {analysisStats.currentSopIdentifier}
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    { label: "Done", value: analysisStats.completed + analysisStats.cached, tone: "text-emerald-600" },
                    { label: "Left", value: remaining, tone: "text-purple-600" },
                    { label: "Failed", value: analysisStats.failed, tone: "text-rose-600" },
                  ].map((c) => (
                    <div key={c.label} className="rounded-lg bg-gray-50 border border-gray-100 py-2">
                      <p className={`text-lg font-bold ${c.tone}`}>{c.value}</p>
                      <p className="text-[9px] font-bold text-gray-400 uppercase">{c.label}</p>
                    </div>
                  ))}
                </div>
              </>
            )}

            {serverOnlyActive && !isAnalyzing && (
              <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-900">
                <p className="font-medium">A compliance run is still active on the server.</p>
                <ul className="mt-2 space-y-1 text-xs">
                  {serverActiveSops.map((s) => (
                    <li key={s.sopId} className="font-mono">
                      {displaySopCode(s.identifier)} — {s.name}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {stoppedMidRun && !isAnalyzing && (
              <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2.5 text-sm text-rose-800">
                <p className="font-semibold">Analysis stopped</p>
                <p className="text-xs mt-1 text-rose-700">
                  {doneCount} of {analysisStats.total} SOP(s) processed before stop.
                </p>
              </div>
            )}

            {analysisComplete && !isAnalyzing && !stoppedMidRun && (
              <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-sm text-emerald-800">
                <p className="font-semibold">Analysis finished</p>
                <p className="text-xs mt-1 text-emerald-700">
                  {analysisStats.completed} analyzed · {analysisStats.cached} cached ·{" "}
                  {analysisStats.failed} failed
                </p>
                {(sopLists.failed.length > 0) && (
                  <ul className="mt-2 max-h-24 overflow-y-auto text-[10px] text-rose-600 space-y-0.5">
                    {sopLists.failed.map((f, i) => (
                      <li key={i}>
                        {displaySopCode(f.identifier)}: {f.error}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {(isAnalyzing || serverOnlyActive) && (
                <>
                  {isAnalyzing && (
                    <button
                      type="button"
                      onClick={togglePause}
                      disabled={isStopping}
                      className="flex-1 min-w-[5rem] px-3 py-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-xs font-bold hover:bg-amber-100 disabled:opacity-50"
                    >
                      {isPaused ? "▶ Resume" : "⏸ Pause"}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void stopRun()}
                    disabled={isStopping}
                    className="flex-1 min-w-[5rem] px-3 py-2 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 text-xs font-bold hover:bg-rose-100 disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    {isStopping ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Square className="h-3.5 w-3.5 fill-current" />
                    )}
                    Stop
                  </button>
                </>
              )}
              {!onCompliancePage && (
                <Link
                  href="/compliance"
                  className="flex-1 min-w-[5rem] px-3 py-2 rounded-xl border border-purple-200 bg-purple-50 text-purple-700 text-xs font-bold hover:bg-purple-100 text-center inline-flex items-center justify-center gap-1"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Open
                </Link>
              )}
              {(analysisComplete || stoppedMidRun) && !isAnalyzing && (
                <button
                  type="button"
                  onClick={dismissComplete}
                  className="flex-1 min-w-[5rem] px-3 py-2 rounded-xl border border-gray-200 bg-gray-50 text-gray-600 text-xs font-bold hover:bg-gray-100"
                >
                  Dismiss
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={togglePanelExpanded}
        className={`flex items-center gap-2.5 pl-3 pr-4 py-2.5 rounded-full border shadow-lg transition-all hover:scale-[1.02] ${
          isAnalyzing || serverOnlyActive
            ? "bg-purple-600 border-purple-500 text-white shadow-purple-300/50"
            : stoppedMidRun
              ? "bg-rose-600 border-rose-500 text-white shadow-rose-300/50"
              : "bg-emerald-600 border-emerald-500 text-white shadow-emerald-300/50"
        }`}
      >
        {(isAnalyzing || serverOnlyActive) && (
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-60" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-white" />
          </span>
        )}
        {isAnalyzing && <Loader2 className="h-4 w-4 animate-spin flex-shrink-0" />}
        <span className="text-xs font-bold whitespace-nowrap">{subtitle}</span>
        {panelExpanded ? (
          <ChevronDown className="h-4 w-4 opacity-80" />
        ) : (
          <ChevronUp className="h-4 w-4 opacity-80" />
        )}
      </button>
    </div>
  );
}
