import { create } from "zustand";
import type { PipelineJob, SOPFilters } from "@/lib/types";

interface DashboardState {
  filters: SOPFilters;
  showCapsules: boolean;
  showGuidelines: boolean;
  showFilterSidebar: boolean;
  showObsolete: boolean;
  expandedRows: Set<string>;
  uploadModalOpen: boolean;
  pdfUploadOpen: boolean;
  folderUploadOpen: boolean;
  gujaratiUploadOpen: boolean;
  locationUploadOpen: boolean;
  bunnyMigrateOpen: boolean;
  videoUploadOpen: boolean;
  bulkAllUploadOpen: boolean;
  complianceOpen: boolean;
  adminOpen: boolean;
  pipelineJobs: PipelineJob[];
  toast: { message: string; id: number } | null;
  setFilter: (patch: Partial<SOPFilters>) => void;
  resetFilters: () => void;
  toggleCapsules: () => void;
  toggleGuidelines: () => void;
  toggleFilterSidebar: () => void;
  toggleRow: (id: string) => void;
  setUploadModalOpen: (open: boolean) => void;
  setPdfUploadOpen: (open: boolean) => void;
  setFolderUploadOpen: (open: boolean) => void;
  setGujaratiUploadOpen: (open: boolean) => void;
  setLocationUploadOpen: (open: boolean) => void;
  setBunnyMigrateOpen: (open: boolean) => void;
  setVideoUploadOpen: (open: boolean) => void;
  setBulkAllUploadOpen: (open: boolean) => void;
  setComplianceOpen: (open: boolean) => void;
  setAdminOpen: (open: boolean) => void;
  addPipelineJob: (job: Omit<PipelineJob, "id" | "startedAt">) => void;
  updatePipelineJob: (id: string, patch: Partial<PipelineJob>) => void;
  removePipelineJob: (identifier: string) => void;
  clearPipeline: () => void;
  showToast: (message: string) => void;
  dismissToast: () => void;
}

const defaultFilters: SOPFilters = {
  searchField: "All",
  sortBy: "department",
  sortDir: "asc",
  page: 1,
  // No pagination — the table scrolls internally, so load every match.
  limit: 100000,
};

export const useDashboardStore = create<DashboardState>((set) => ({
  filters: defaultFilters,
  showCapsules: true,
  showGuidelines: false,
  showFilterSidebar: false,
  showObsolete: false,
  expandedRows: new Set(),
  uploadModalOpen: false,
  pdfUploadOpen: false,
  folderUploadOpen: false,
  gujaratiUploadOpen: false,
  locationUploadOpen: false,
  bunnyMigrateOpen: false,
  videoUploadOpen: false,
  bulkAllUploadOpen: false,
  complianceOpen: false,
  adminOpen: false,
  pipelineJobs: [],
  toast: null,

  setFilter: (patch) =>
    set((s) => ({
      filters: { ...s.filters, ...patch, page: patch.page ?? 1 },
    })),

  resetFilters: () => set({ filters: defaultFilters, showObsolete: false }),

  toggleCapsules: () => set((s) => ({ showCapsules: !s.showCapsules })),

  toggleGuidelines: () => set((s) => ({ showGuidelines: !s.showGuidelines })),

  toggleFilterSidebar: () => set((s) => ({ showFilterSidebar: !s.showFilterSidebar })),

  toggleRow: (id) =>
    set((s) => {
      const next = new Set(s.expandedRows);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedRows: next };
    }),

  setUploadModalOpen: (open) => set({ uploadModalOpen: open }),
  setPdfUploadOpen: (open) => set({ pdfUploadOpen: open }),
  setFolderUploadOpen: (open) => set({ folderUploadOpen: open }),
  setGujaratiUploadOpen: (open) => set({ gujaratiUploadOpen: open }),
  setLocationUploadOpen: (open) => set({ locationUploadOpen: open }),
  setBunnyMigrateOpen: (open) => set({ bunnyMigrateOpen: open }),
  setVideoUploadOpen: (open) => set({ videoUploadOpen: open }),
  setBulkAllUploadOpen: (open) => set({ bulkAllUploadOpen: open }),
  setComplianceOpen: (open) => set({ complianceOpen: open }),
  setAdminOpen: (open) => set({ adminOpen: open }),

  addPipelineJob: (job) =>
    set((s) => {
      if (s.pipelineJobs.some((j) => j.identifier === job.identifier && j.status === "running")) {
        return s;
      }
      return {
        pipelineJobs: [
          ...s.pipelineJobs,
          { ...job, id: crypto.randomUUID(), startedAt: Date.now() },
        ],
      };
    }),

  updatePipelineJob: (id, patch) =>
    set((s) => ({
      pipelineJobs: s.pipelineJobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
    })),

  removePipelineJob: (identifier) =>
    set((s) => ({
      pipelineJobs: s.pipelineJobs.filter((j) => j.identifier !== identifier),
    })),

  clearPipeline: () => set({ pipelineJobs: [] }),

  showToast: (message) => set({ toast: { message, id: Date.now() } }),

  dismissToast: () => set({ toast: null }),
}));

export function filtersToQuery(filters: SOPFilters): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value === undefined || value === "" || value === false) return;
    if (Array.isArray(value)) {
      value.forEach((v) => params.append(key === "locations" ? "location" : key, v));
    } else {
      params.set(key, String(value));
    }
  });
  return params.toString();
}
