import { create } from "zustand";

export type ComplianceSopRunEntry = {
  identifier: string;
  name: string;
  score?: number | null;
  status?: string;
  error?: string;
};

export type ComplianceAnalysisStats = {
  total: number;
  completed: number;
  cached: number;
  failed: number;
  currentSopName: string;
  currentSopIdentifier: string;
};

export type ComplianceRunStartParams = {
  candidates: { _id: string; identifier: string; name: string }[];
  guidelineIds: string[];
  guidelineLabel: string;
  forceRefresh: boolean;
  provider?: "claude" | "codex" | "gemini" | "ollama" | null;
  model?: string;
};

type ComplianceRunState = {
  isAnalyzing: boolean;
  isPaused: boolean;
  isStopping: boolean;
  panelExpanded: boolean;
  analysisComplete: boolean;
  guidelineName: string;
  analysisStats: ComplianceAnalysisStats;
  sopLists: {
    completed: ComplianceSopRunEntry[];
    cached: ComplianceSopRunEntry[];
    failed: ComplianceSopRunEntry[];
  };
  /** Set when a run finishes — pages can react to refresh reports. */
  runGeneration: number;
  lastAnalyzedSopId: string | null;
  wasStopped: boolean;
  stoppedMidRun: boolean;
  serverOnlyActive: boolean;
  serverActiveSops: { sopId: string; identifier: string; name: string }[];

  setPanelExpanded: (expanded: boolean) => void;
  togglePanelExpanded: () => void;
  togglePause: () => void;
  setServerActive: (
    active: boolean,
    sops?: { sopId: string; identifier: string; name: string }[],
  ) => void;
  startRun: (params: ComplianceRunStartParams) => Promise<void>;
  stopRun: () => Promise<void>;
  dismissComplete: () => void;
};

const pauseRef = { current: false };
const stopRequestedRef = { current: false };
const analyzeAbortRef = { current: null as AbortController | null };

function waitIfPaused(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (pauseRef.current) setTimeout(check, 500);
      else resolve();
    };
    check();
  });
}

export const useComplianceRunStore = create<ComplianceRunState>((set, get) => ({
  isAnalyzing: false,
  isPaused: false,
  isStopping: false,
  panelExpanded: false,
  analysisComplete: false,
  guidelineName: "",
  analysisStats: {
    total: 0,
    completed: 0,
    cached: 0,
    failed: 0,
    currentSopName: "",
    currentSopIdentifier: "",
  },
  sopLists: { completed: [], cached: [], failed: [] },
  runGeneration: 0,
  lastAnalyzedSopId: null,
  wasStopped: false,
  stoppedMidRun: false,
  serverOnlyActive: false,
  serverActiveSops: [],

  setPanelExpanded: (expanded) => set({ panelExpanded: expanded }),
  togglePanelExpanded: () => set((s) => ({ panelExpanded: !s.panelExpanded })),

  togglePause: () => {
    pauseRef.current = !pauseRef.current;
    set((s) => ({ isPaused: !s.isPaused }));
  },

  setServerActive: (active, sops = []) =>
    set((s) => {
      const serverOnlyActive = active && !s.isAnalyzing;
      const unchanged =
        s.serverOnlyActive === serverOnlyActive &&
        s.serverActiveSops.length === sops.length &&
        sops.every(
          (r, i) =>
            s.serverActiveSops[i]?.sopId === r.sopId &&
            s.serverActiveSops[i]?.identifier === r.identifier,
        );
      if (unchanged) return s;
      return { serverOnlyActive, serverActiveSops: sops };
    }),

  dismissComplete: () =>
    set({
      analysisComplete: false,
      stoppedMidRun: false,
      panelExpanded: false,
      serverOnlyActive: false,
      serverActiveSops: [],
    }),

  stopRun: async () => {
    if (get().isStopping) return;
    set({ isStopping: true });
    stopRequestedRef.current = true;
    pauseRef.current = false;
    set({ isPaused: false });
    try {
      await fetch("/api/compliance/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stopAll: true }),
      });
    } catch {
      /* ignore */
    }
    analyzeAbortRef.current?.abort();
    set({ isStopping: false });
  },

  startRun: async (params) => {
    const { candidates, guidelineIds, guidelineLabel, forceRefresh, provider, model } = params;
    if (!candidates.length || !guidelineIds.length || get().isAnalyzing) return;

    pauseRef.current = false;
    stopRequestedRef.current = false;
    analyzeAbortRef.current = null;

    set({
      isAnalyzing: true,
      isPaused: false,
      isStopping: false,
      analysisComplete: false,
      wasStopped: false,
      stoppedMidRun: false,
      lastAnalyzedSopId: null,
      guidelineName: guidelineLabel,
      panelExpanded: false,
      serverOnlyActive: false,
      serverActiveSops: [],
      analysisStats: {
        total: candidates.length,
        completed: 0,
        cached: 0,
        failed: 0,
        currentSopName: candidates[0]?.name ?? "",
        currentSopIdentifier: candidates[0]?.identifier ?? "",
      },
      sopLists: { completed: [], cached: [], failed: [] },
    });

    void fetch("/api/compliance/run-requests/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sopIds: candidates.map((c) => c._id),
        identifiers: candidates.map((c) => c.identifier),
      }),
    }).catch(() => {});

    let lastAnalyzedSopId: string | null = null;

    for (const sop of candidates) {
      if (stopRequestedRef.current) break;
      await waitIfPaused();
      if (stopRequestedRef.current) break;

      set((s) => ({
        analysisStats: {
          ...s.analysisStats,
          currentSopName: sop.name,
          currentSopIdentifier: sop.identifier,
        },
      }));

      const abortController = new AbortController();
      analyzeAbortRef.current = abortController;

      try {
        const res = await fetch("/api/compliance/analyze-v3", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sopId: sop._id,
            guidelineIds,
            includeAnnexures: true,
            provider: provider ?? undefined,
            model: model ?? undefined,
            config: {
              aiModel: provider === "gemini" || !provider ? "gemini-2.0-flash" : undefined,
              maxClausesToAnalyze: 200,
            },
          }),
          signal: abortController.signal,
        });
        const data = await res.json().catch(() => ({ success: false, error: "Parse error" }));
        if (data.cancelled || stopRequestedRef.current) break;

        if (data.success) {
          const entry: ComplianceSopRunEntry = {
            identifier: sop.identifier,
            name: sop.name,
            score: data.overallScore ?? null,
            status: data.complianceStatus ?? "",
          };
          if (data.cached) {
            set((s) => ({
              analysisStats: { ...s.analysisStats, cached: s.analysisStats.cached + 1 },
              sopLists: { ...s.sopLists, cached: [...s.sopLists.cached, entry] },
            }));
          } else {
            set((s) => ({
              analysisStats: { ...s.analysisStats, completed: s.analysisStats.completed + 1 },
              sopLists: { ...s.sopLists, completed: [...s.sopLists.completed, entry] },
            }));
          }
          lastAnalyzedSopId = sop._id;
        } else {
          set((s) => ({
            analysisStats: { ...s.analysisStats, failed: s.analysisStats.failed + 1 },
            sopLists: {
              ...s.sopLists,
              failed: [
                ...s.sopLists.failed,
                { identifier: sop.identifier, name: sop.name, error: data.error },
              ],
            },
          }));
        }
      } catch (err) {
        if (
          stopRequestedRef.current ||
          (err instanceof DOMException && err.name === "AbortError")
        ) {
          break;
        }
        if (err instanceof Error && /cancel/i.test(err.message)) break;
        set((s) => ({
          analysisStats: { ...s.analysisStats, failed: s.analysisStats.failed + 1 },
          sopLists: {
            ...s.sopLists,
            failed: [
              ...s.sopLists.failed,
              {
                identifier: sop.identifier,
                name: sop.name,
                error: err instanceof Error ? err.message : "Network error",
              },
            ],
          },
        }));
      } finally {
        analyzeAbortRef.current = null;
      }

      if (stopRequestedRef.current) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    const wasStopped = stopRequestedRef.current;
    const done =
      get().analysisStats.completed +
      get().analysisStats.cached +
      get().analysisStats.failed;
    pauseRef.current = false;
    stopRequestedRef.current = false;

    set((s) => ({
      isAnalyzing: false,
      isPaused: false,
      isStopping: false,
      analysisComplete: !wasStopped,
      wasStopped,
      stoppedMidRun: wasStopped && done > 0,
      lastAnalyzedSopId,
      runGeneration: s.runGeneration + 1,
      panelExpanded: !wasStopped && candidates.length === 1 ? true : s.panelExpanded,
    }));
  },
}));

export function complianceRunProgressPct(stats: ComplianceAnalysisStats): number {
  if (stats.total <= 0) return 0;
  return Math.round(((stats.completed + stats.cached + stats.failed) / stats.total) * 100);
}
