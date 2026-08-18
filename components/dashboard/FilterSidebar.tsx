"use client";

import { X } from "lucide-react";
import type { RegistrySOP } from "@/lib/types";
import { useDashboardStore } from "@/lib/store/dashboard-store";
import { Btn } from "./ui";

interface FilterSidebarProps {
  sops: RegistrySOP[];
}

export function FilterSidebar({ sops }: FilterSidebarProps) {
  const { showFilterSidebar, toggleFilterSidebar, filters, setFilter, resetFilters } =
    useDashboardStore();

  if (!showFilterSidebar) return null;

  const locations = [...new Set(sops.map((s) => s.location).filter(Boolean))] as string[];

  return (
    <aside className="fixed right-0 top-0 z-40 flex h-full w-72 flex-col border-l border-slate-200 bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
        <h3 className="text-xs font-bold uppercase text-slate-700">Filters</h3>
        <button type="button" onClick={toggleFilterSidebar} className="rounded p-1 hover:bg-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-[10px]">
        <FilterGroup label="File Type">
          {["DOCX", "No DOCX", "PDF", "No PDF"].map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input
                type="radio"
                name="fileType"
                checked={filters.fileType === v}
                onChange={() => setFilter({ fileType: v })}
              />
              {v}
            </label>
          ))}
        </FilterGroup>

        <FilterGroup label="Media">
          {["Video", "No Video", "Slides", "No Slides", "No Media"].map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input
                type="radio"
                name="media"
                checked={filters.media === v}
                onChange={() => setFilter({ media: v })}
              />
              {v}
            </label>
          ))}
        </FilterGroup>

        <FilterGroup label="Expiry Status">
          {["Expired", "Near", "Medium", "Low", "No Date"].map((v) => (
            <label key={v} className="flex items-center gap-2">
              <input
                type="radio"
                name="expiry"
                checked={filters.expiry === v}
                onChange={() => setFilter({ expiry: v })}
              />
              {v}
            </label>
          ))}
        </FilterGroup>

        <FilterGroup label="Version Status">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="versionStatus"
              checked={filters.versionStatus === "found"}
              onChange={() => setFilter({ versionStatus: "found" })}
            />
            All found
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="versionStatus"
              checked={filters.versionStatus === "missing"}
              onChange={() => setFilter({ versionStatus: "missing" })}
            />
            Not found
          </label>
        </FilterGroup>

        <FilterGroup label="Toggles">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filters.dualLanguage ?? false}
              onChange={(e) => setFilter({ dualLanguage: e.target.checked })}
            />
            Dual Language only
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={filters.absoluteSop ?? false}
              onChange={(e) => setFilter({ absoluteSop: e.target.checked })}
            />
            Absolute SOP
          </label>
        </FilterGroup>

        <FilterGroup label="Date Range">
          <input
            type="date"
            className="mb-1 w-full rounded border border-slate-300 px-1 py-0.5"
            value={filters.dateFrom ?? ""}
            onChange={(e) => setFilter({ dateFrom: e.target.value || undefined })}
          />
          <input
            type="date"
            className="w-full rounded border border-slate-300 px-1 py-0.5"
            value={filters.dateTo ?? ""}
            onChange={(e) => setFilter({ dateTo: e.target.value || undefined })}
          />
        </FilterGroup>

        {locations.length > 0 && (
          <FilterGroup label="Location">
            {locations.slice(0, 20).map((loc) => (
              <label key={loc} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={filters.locations?.includes(loc) ?? false}
                  onChange={(e) => {
                    const current = filters.locations ?? [];
                    setFilter({
                      locations: e.target.checked
                        ? [...current, loc]
                        : current.filter((l) => l !== loc),
                    });
                  }}
                />
                {loc}
              </label>
            ))}
          </FilterGroup>
        )}

        <FilterGroup label="Sort">
          <select
            className="mb-1 w-full rounded border border-slate-300 px-1 py-0.5"
            value={filters.sortBy ?? "identifier"}
            onChange={(e) => setFilter({ sortBy: e.target.value })}
          >
            {[
              "identifier",
              "name",
              "department",
              "location",
              "version",
              "expiryDate",
              "language",
              "complianceScore",
              "complianceDone",
              "complianceBypassed",
              "uploadedAt",
            ].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            className="w-full rounded border border-slate-300 px-1 py-0.5"
            value={filters.sortDir ?? "asc"}
            onChange={(e) => setFilter({ sortDir: e.target.value as "asc" | "desc" })}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </FilterGroup>
      </div>

      <div className="border-t border-slate-200 p-3">
        <Btn size="sm" className="w-full" onClick={resetFilters}>
          Reset All Filters
        </Btn>
      </div>
    </aside>
  );
}

function FilterGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 font-semibold uppercase text-slate-500">{label}</p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
