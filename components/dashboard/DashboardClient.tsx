"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import type { DashboardStats, RegistrySOP } from "@/lib/types";
import {
  DASHBOARD_CACHE_KEY,
  DASHBOARD_STATS_CACHE_KEY,
  bustDashboardCache,
  readClientCache,
  writeClientCache,
} from "@/lib/cache";
import { useDashboardStore } from "@/lib/store/dashboard-store";
import {
  applyFilters,
  baseIdentifierFromIdentifier,
  buildDashboardStats,
  normalizeRegistrySop,
  paginate,
} from "@/lib/sop-utils";
import { exportSopsToExcel } from "@/lib/export-missing";
import { displaySopCode } from "@/lib/sop-display";
import { canMutate, hasFullDashboardAccess, isAdmin } from "@/lib/roles";
import type { AppRole } from "@/lib/auth";
import { DashboardHeader } from "./DashboardHeader";
import { DashboardToolbar } from "./DashboardToolbar";
import { DepartmentCapsules } from "./DepartmentCapsules";
import { SOPRegistryTable } from "./SOPRegistryTable";
import { FilterSidebar } from "./FilterSidebar";
import { UploadSOPModal } from "./UploadModals";
import {
  BulkLocationUploadModal,
  BulkPdfUploadModal,
  BulkVideosSlidesModal,
  GujaratiFolderUploadModal,
  MigrateBunnyModal,
  SopFolderUploadModal,
} from "./BulkUploadModals";
import { BulkUploadAllModal } from "./BulkUploadAllModal";
import { PipelineDock, ToastNotification } from "./PipelineDock";
import { AdminToolsModal, ComplianceModal, GuidelinesPanel } from "./ExtraModals";
import { AuditLogsModal } from "./AuditLogsModal";
import GuidelinesComplianceWizard from "./GuidelinesComplianceWizard";
import GuidelinesResultPanel, { type ComplianceResult } from "./GuidelinesResultPanel";
import ComplianceFullViewer from "./ComplianceFullViewer";

export function DashboardClient() {
  const { data: session, status: sessionStatus } = useSession();
  const role = (session?.user?.role ?? "viewer") as AppRole;
  const userCanMutate = canMutate(role);
  const userIsAdmin = isAdmin(role);
  const fullDashboard = hasFullDashboardAccess(role);
  const cacheScope = `${role}:${session?.user?.department ?? ""}`;
  const scopedSopCacheKey = `${DASHBOARD_CACHE_KEY}:${cacheScope}`;
  const scopedStatsCacheKey = `${DASHBOARD_STATS_CACHE_KEY}:${cacheScope}`;
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [departmentList, setDepartmentList] = useState<string[]>([]);

  const handleDepartmentAdded = useCallback((name: string) => {
    setDepartmentList((prev) => (prev.includes(name) ? prev : [...prev, name]));
    // Immediately show an empty capsule so new depts appear in "By Department"
    // before the next full stats refetch (SOPs will fill counts on upload/refresh).
    setStats((prev) => {
      if (!prev) return prev;
      if (prev.departments.some((d) => d.department === name)) return prev;
      const empty = buildDashboardStats([], [name]).departments.find((d) => d.department === name);
      if (!empty) return prev;
      return { ...prev, departments: [...prev.departments, empty] };
    });
  }, []);

  const handleDepartmentDeleted = useCallback((name: string) => {
    setDepartmentList((prev) => prev.filter((d) => d !== name));
    // Also drop the capsule, which is sourced from stats.departments — otherwise
    // a deleted department keeps showing until the next full stats refetch.
    setStats((prev) =>
      prev
        ? { ...prev, departments: prev.departments.filter((d) => d.department !== name) }
        : prev,
    );
  }, []);

  // The full grouped registry (active + obsolete). Fetched once and filtered
  // entirely on the client, so capsule/pill clicks update the table instantly
  // without a network round-trip per filter change.
  const [allItems, setAllItems] = useState<RegistrySOP[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [guidelinesWizardOpen, setGuidelinesWizardOpen] = useState(false);
  const [wizardMinimized, setWizardMinimized] = useState(false);
  const [guidelinesWizardPreset, setGuidelinesWizardPreset] = useState<{
    _id: string;
    sopNo: string;
  } | null>(null);
  const [prefetchedGuidelines, setPrefetchedGuidelines] = useState<unknown[] | null>(null);
  const [complianceCache, setComplianceCache] = useState<Record<string, ComplianceResult>>({});
  const [viewingComplianceSopNo, setViewingComplianceSopNo] = useState<string | null>(null);
  const [viewingComplianceFullSopNo, setViewingComplianceFullSopNo] = useState<string | null>(null);
  const [auditLogsOpen, setAuditLogsOpen] = useState(false);

  const registryRowsForWizard = useMemo(
    () =>
      allItems.map((s) => ({
        _id: s.id,
        id: s.id,
        sopNo: s.identifier,
        identifier: s.identifier,
        englishName: s.name,
        sopName: s.name,
        name: s.name,
        department: s.department,
      })),
    [allItems],
  );

  const handleComplianceResult = useCallback(
    (sopNo: string, sopName: string, result: Omit<ComplianceResult, "sopNo" | "sopName" | "runAt">) => {
      const entry: ComplianceResult = {
        sopNo,
        sopName,
        findings: result.findings ?? [],
        overallScore: result.overallScore ?? 0,
        clausesAnalyzed: result.clausesAnalyzed ?? 0,
        guidelineDocumentsUsed: result.guidelineDocumentsUsed ?? 0,
        runAt: new Date().toISOString(),
        source: "dashboard-wizard",
      };
      setComplianceCache((prev) => ({ ...prev, [sopNo]: entry }));
      setViewingComplianceSopNo(sopNo);
    },
    [],
  );

  useEffect(() => {
    if (!fullDashboard) return;
    if (!guidelinesWizardOpen && !prefetchedGuidelines) {
      fetch("/api/guidelines/upload?summary=true")
        .then((r) => r.json())
        .then((j) => {
          if (j.success && Array.isArray(j.guidelines)) setPrefetchedGuidelines(j.guidelines);
        })
        .catch(() => {});
    }
  }, [guidelinesWizardOpen, prefetchedGuidelines, fullDashboard]);

  useEffect(() => {
    if (!fullDashboard) return;
    fetch("/api/dashboard/sop-guideline-review?listAll=true", { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => {
        if (!json.success || !Array.isArray(json.results)) return;
        const cache: Record<string, ComplianceResult> = {};
        for (const r of json.results) {
          cache[r.sopNo] = {
            sopNo: r.sopNo,
            sopName: r.sopName || "",
            findings: Array.isArray(r.findings) ? r.findings : [],
            overallScore: r.overallScore ?? 0,
            clausesAnalyzed: r.clausesAnalyzed ?? 0,
            guidelineDocumentsUsed: r.guidelineDocumentsUsed ?? 0,
            runAt: r.runAt ? new Date(r.runAt).toISOString() : new Date().toISOString(),
            source: r.source,
          };
        }
        setComplianceCache((prev) => ({ ...cache, ...prev }));
      })
      .catch(() => {});
  }, [fullDashboard]);

  const {
    filters,
    setFilter,
    uploadModalOpen,
    setUploadModalOpen,
    pdfUploadOpen,
    setPdfUploadOpen,
    folderUploadOpen,
    setFolderUploadOpen,
    gujaratiUploadOpen,
    setGujaratiUploadOpen,
    locationUploadOpen,
    setLocationUploadOpen,
    bunnyMigrateOpen,
    setBunnyMigrateOpen,
    videoUploadOpen,
    setVideoUploadOpen,
    bulkAllUploadOpen,
    setBulkAllUploadOpen,
    complianceOpen,
    setComplianceOpen,
    adminOpen,
    setAdminOpen,
  } = useDashboardStore();

  // Derived view: filter + sort + paginate the cached registry locally. This runs
  // in a few ms even for the whole collection, so every capsule/pill/department
  // click is instant.
  const { filtered, items, total } = useMemo(() => {
    const filtered = applyFilters(allItems, filters);
    const { items, total } = paginate(filtered, filters.page, filters.limit);
    return { filtered, items, total };
  }, [allItems, filters]);

  const fetchStats = useCallback(async () => {
    const cached = readClientCache<DashboardStats & { departmentList?: string[] }>(
      scopedStatsCacheKey,
      "stats",
    );
    try {
      const res = await fetch(`/api/sops/stats?_t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = body.error ?? `Could not refresh dashboard stats (${res.status})`;
        if (cached) {
          setStats(cached);
          setDepartmentList(cached.departmentList ?? []);
          setError(`Showing cached stats — ${msg}`);
        } else {
          setError(msg);
        }
        return;
      }
      const data = await res.json();
      setStats(data);
      setDepartmentList(data.departmentList ?? []);
      writeClientCache(scopedStatsCacheKey, "stats", data);
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load stats";
      if (cached) {
        setStats(cached);
        setDepartmentList(cached.departmentList ?? []);
        setError(`Showing cached stats — ${msg}`);
      } else {
        setError(msg);
      }
    }
  }, [scopedStatsCacheKey]);

  const fetchSops = useCallback(async () => {
    setError(null);
    // Stale-while-revalidate: paint the cached registry instantly, then refetch
    // the full set once in the background. All filtering happens client-side.
    const cached = readClientCache<RegistrySOP[]>(scopedSopCacheKey, "all");
    if (cached) {
      setAllItems(cached.map(normalizeRegistrySop));
      setLoading(false);
    } else {
      setLoading(true);
    }
    try {
      const res = await fetch(`/api/sops?all=1`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? "Failed to load SOPs");
      }
      const data = await res.json();
      const items = (data.items as RegistrySOP[]).map(normalizeRegistrySop);
      setAllItems(items);
      writeClientCache(scopedSopCacheKey, "all", items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      if (!cached) {
        setAllItems([]);
      }
    } finally {
      setLoading(false);
    }
  }, [scopedSopCacheKey]);

  const refresh = useCallback(async () => {
    bustDashboardCache();
    await Promise.allSettled([fetchStats(), fetchSops()]);
  }, [fetchStats, fetchSops]);

  // Hard refresh: wipes every cache layer, forces a cold sequential fetch, and
  // reports per-API timing to the console so you can see what's slow.
  const hardRefresh = useCallback(async () => {
    bustDashboardCache();
    setAllItems([]);
    setStats(null);
    setLoading(true);
    setError(null);

    console.group(
      `%c[Hard Refresh] Cold reload — ${new Date().toLocaleTimeString()}`,
      "color:#6366f1;font-weight:bold",
    );

    type Timing = { api: string; fetchMs: number; parseMs: number; totalMs: number; status: string };
    const timings: Timing[] = [];

    // Stats — sequential so timings are independent
    {
      const t0 = performance.now();
      try {
        const res = await fetch(`/api/sops/stats?_t=${Date.now()}`, { cache: "no-store" });
        const t1 = performance.now();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const t2 = performance.now();
        setStats(data);
        setDepartmentList(data.departmentList ?? []);
        writeClientCache(scopedStatsCacheKey, "stats", data);
        timings.push({ api: "/api/sops/stats", fetchMs: Math.round(t1 - t0), parseMs: Math.round(t2 - t1), totalMs: Math.round(t2 - t0), status: "ok" });
        console.log(`[Hard Refresh] /api/sops/stats  →  ${Math.round(t2 - t0)}ms  (fetch ${Math.round(t1 - t0)}ms + parse ${Math.round(t2 - t1)}ms)`);
      } catch (e) {
        const dur = Math.round(performance.now() - t0);
        timings.push({ api: "/api/sops/stats", fetchMs: dur, parseMs: 0, totalMs: dur, status: "ERROR" });
        console.error(`[Hard Refresh] /api/sops/stats  →  FAILED after ${dur}ms`, e);
      }
    }

    // SOPs — wait for stats to finish first (maximum cold-load path)
    {
      const t0 = performance.now();
      try {
        const res = await fetch(`/api/sops?all=1&_t=${Date.now()}`, { cache: "no-store" });
        const t1 = performance.now();
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error ?? "Failed to load SOPs");
        }
        const data = await res.json();
        const t2 = performance.now();
        setAllItems(data.items);
        writeClientCache(scopedSopCacheKey, "all", data.items);
        timings.push({ api: "/api/sops?all=1", fetchMs: Math.round(t1 - t0), parseMs: Math.round(t2 - t1), totalMs: Math.round(t2 - t0), status: "ok" });
        console.log(`[Hard Refresh] /api/sops?all=1   →  ${Math.round(t2 - t0)}ms  (fetch ${Math.round(t1 - t0)}ms + parse ${Math.round(t2 - t1)}ms)`);
      } catch (e) {
        const dur = Math.round(performance.now() - t0);
        timings.push({ api: "/api/sops?all=1", fetchMs: dur, parseMs: 0, totalMs: dur, status: "ERROR" });
        setError(e instanceof Error ? e.message : "Failed to load");
        setAllItems([]);
        console.error(`[Hard Refresh] /api/sops?all=1  →  FAILED after ${dur}ms`, e);
      }
    }

    setLoading(false);

    const slowest = [...timings].sort((a, b) => b.totalMs - a.totalMs)[0];
    console.log(
      `%c[Hard Refresh] Slowest: ${slowest.api}  (${slowest.totalMs}ms)`,
      "color:#f59e0b;font-weight:bold",
    );
    console.table(
      timings.map(({ api, fetchMs, parseMs, totalMs, status }) => ({
        "API": api,
        "Fetch (ms)": fetchMs,
        "Parse (ms)": parseMs,
        "Total (ms)": totalMs,
        "Status": status,
      })),
    );
    console.groupEnd();
  }, [scopedSopCacheKey, scopedStatsCacheKey]);

  // Mark an SOP family obsolete with an instant, optimistic update: flip the
  // family's `isObsolete` flag locally so it leaves the active list and joins the
  // Obsolete view immediately, then recompute the dashboard stats from the same
  // registry array — no full re-scan / re-group round-trip. The DELETE call only
  // persists the change; on failure we roll the local state back so an SOP is
  // never shown in both places.
  const handleObsolete = useCallback(
    async (sop: RegistrySOP) => {
      const base = baseIdentifierFromIdentifier(sop.identifier);
      const prevItems = allItems;
      const prevStats = stats;

      const nextItems = allItems.map((item) =>
        baseIdentifierFromIdentifier(item.identifier) === base
          ? { ...item, isObsolete: true }
          : item,
      );
      const nextStats = buildDashboardStats(nextItems, departmentList);

      setAllItems(nextItems);
      setStats(nextStats);
      writeClientCache(scopedSopCacheKey, "all", nextItems);
      writeClientCache(scopedStatsCacheKey, "stats", { ...nextStats, departmentList });

      try {
        const res = await fetch(
          `/api/sops/registry/${encodeURIComponent(sop.identifier)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error ?? "Failed to mark SOP obsolete");
        }
      } catch (e) {
        setAllItems(prevItems);
        setStats(prevStats);
        writeClientCache(scopedSopCacheKey, "all", prevItems);
        writeClientCache(scopedStatsCacheKey, "stats", prevStats);
        throw e;
      }
    },
    [allItems, stats, departmentList, scopedSopCacheKey, scopedStatsCacheKey],
  );

  // Revive an obsolete SOP family: optimistically flip `isObsolete` back to false
  // so it leaves the Obsolete view and rejoins the active registry immediately,
  // then recompute stats. The POST call persists the change; on failure we roll
  // the local state back so the SOP is never shown in both places.
  const handleRevive = useCallback(
    async (sop: RegistrySOP) => {
      const base = baseIdentifierFromIdentifier(sop.identifier);
      const prevItems = allItems;
      const prevStats = stats;

      const nextItems = allItems.map((item) =>
        baseIdentifierFromIdentifier(item.identifier) === base
          ? { ...item, isObsolete: false }
          : item,
      );
      const nextStats = buildDashboardStats(nextItems, departmentList);

      setAllItems(nextItems);
      setStats(nextStats);
      writeClientCache(scopedSopCacheKey, "all", nextItems);
      writeClientCache(scopedStatsCacheKey, "stats", { ...nextStats, departmentList });

      try {
        const res = await fetch(
          `/api/sops/registry/${encodeURIComponent(sop.identifier)}`,
          { method: "POST" },
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error ?? "Failed to revive SOP");
        }
      } catch (e) {
        setAllItems(prevItems);
        setStats(prevStats);
        writeClientCache(scopedSopCacheKey, "all", prevItems);
        writeClientCache(scopedStatsCacheKey, "stats", prevStats);
        throw e;
      }
    },
    [allItems, stats, departmentList, scopedSopCacheKey, scopedStatsCacheKey],
  );

  // Permanently delete an SOP family. Unlike obsolete, this is irreversible, so
  // we call the API first (password-gated) and only drop the family from the
  // local registry once the server confirms — no optimistic flicker, and a wrong
  // password leaves the table untouched.
  const handlePermanentDelete = useCallback(
    async (sop: RegistrySOP, password: string) => {
      const res = await fetch(
        `/api/sops/registry/${encodeURIComponent(sop.identifier)}?permanent=1`,
        { method: "DELETE", headers: { "x-confirm-password": password } },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Failed to delete SOP");
      }

      const base = baseIdentifierFromIdentifier(sop.identifier);
      const nextItems = allItems.filter(
        (item) => baseIdentifierFromIdentifier(item.identifier) !== base,
      );
      const nextStats = buildDashboardStats(nextItems, departmentList);

      setAllItems(nextItems);
      setStats(nextStats);
      writeClientCache(scopedSopCacheKey, "all", nextItems);
      writeClientCache(scopedStatsCacheKey, "stats", { ...nextStats, departmentList });
    },
    [allItems, departmentList, scopedSopCacheKey, scopedStatsCacheKey],
  );

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    const cachedStats = readClientCache<DashboardStats & { departmentList?: string[] }>(
      scopedStatsCacheKey,
      "stats",
    );
    if (cachedStats) {
      setStats(cachedStats);
      setDepartmentList(cachedStats.departmentList ?? []);
    }
    fetchStats();
  }, [fetchStats, scopedStatsCacheKey, sessionStatus]);

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    fetchSops();
  }, [fetchSops, sessionStatus]);

  const handleSort = (field: string) => {
    setFilter({
      sortBy: field,
      sortDir:
        filters.sortBy === field && filters.sortDir === "asc" ? "desc" : "asc",
    });
  };

  const handleExport = () => {
    const headers = [
      "SOP No",
      "Version",
      "Name",
      "Department",
      "Location",
      "Language",
      "Expiry",
      "Uploaded",
      "Compliance Done",
      "Score",
      "Bypassed",
    ];
    const rows = items.map((s) =>
      [
        displaySopCode(s.identifier),
        s.version,
        `"${s.name.replace(/"/g, '""')}"`,
        s.department,
        s.location ?? "",
        s.language,
        s.expiryDate ?? "",
        s.uploadedAt,
        s.complianceDone ? "Yes" : "No",
        s.complianceDone ? `${Math.round(s.complianceScore * 10)}%` : "",
        s.complianceBypassed ? "Yes" : "No",
      ].join(","),
    );
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sop-registry.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Excel export of the full filtered/searched set (every matching record, not
  // just the current page). Respects the active missing-data category so users
  // can export exactly what the registry is showing.
  const handleExportExcel = useCallback(() => {
    exportSopsToExcel(filtered, filters);
  }, [filtered, filters]);

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-[#f8f9fa] text-gray-800">
      <DashboardHeader
        stats={stats}
        onExpiryFilter={(tier) => setFilter({ expiry: tier })}
      />
      <DashboardToolbar
        stats={stats}
        onRefresh={refresh}
        onHardRefresh={hardRefresh}
        onExport={handleExport}
        canMutate={userCanMutate}
        isAdmin={userIsAdmin}
        onFilesImportComplete={refresh}
        onOpenGuidelinesWizard={
          fullDashboard
            ? () => {
                setGuidelinesWizardPreset(null);
                setGuidelinesWizardOpen(true);
                setWizardMinimized(false);
              }
            : undefined
        }
        onOpenAuditLogs={() => setAuditLogsOpen(true)}
      />

      {error && (
        <div className="mx-4 mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
          {error.includes("MONGODB_URI") && (
            <span>
              {" "}
              — Create a <code className="rounded bg-red-100 px-1">.env.local</code> file with
              your MongoDB connection string.
            </span>
          )}
          {(error.includes("unreachable") || error.includes("ETIMEDOUT")) && (
            <span>
              {" "}
              — Verify MongoDB Atlas is running and your current IP is on the network access allowlist.
            </span>
          )}
        </div>
      )}

      {fullDashboard && stats && (
        <DepartmentCapsules
          capsules={stats.departments}
          onDepartmentAdded={handleDepartmentAdded}
          onDepartmentDeleted={handleDepartmentDeleted}
        />
      )}

      <div id="sop-registry">
        <SOPRegistryTable
          items={items}
          total={total}
          loading={loading}
          departments={departmentList}
          onSort={handleSort}
          onRefresh={refresh}
          onObsolete={handleObsolete}
          onRevive={handleRevive}
          onPermanentDelete={handlePermanentDelete}
          onExportExcel={handleExportExcel}
          canMutate={userCanMutate}
        />
      </div>

      {fullDashboard && (
        <>
          <FilterSidebar sops={items} />
          <GuidelinesPanel />

          <UploadSOPModal
            open={uploadModalOpen}
            onClose={() => setUploadModalOpen(false)}
            onSuccess={refresh}
            departmentList={departmentList}
          />
          <SopFolderUploadModal
            open={folderUploadOpen}
            onClose={() => setFolderUploadOpen(false)}
            onSuccess={refresh}
            departmentList={departmentList}
          />
          <GujaratiFolderUploadModal
            open={gujaratiUploadOpen}
            onClose={() => setGujaratiUploadOpen(false)}
            onSuccess={refresh}
          />
          <BulkPdfUploadModal
            open={pdfUploadOpen}
            onClose={() => setPdfUploadOpen(false)}
            onSuccess={refresh}
          />
          <BulkLocationUploadModal
            open={locationUploadOpen}
            onClose={() => setLocationUploadOpen(false)}
            onSuccess={refresh}
          />
          <BulkVideosSlidesModal
            open={videoUploadOpen}
            onClose={() => setVideoUploadOpen(false)}
            onSuccess={refresh}
          />
          <BulkUploadAllModal
            open={bulkAllUploadOpen}
            onClose={() => setBulkAllUploadOpen(false)}
            onSuccess={refresh}
            departmentList={departmentList}
          />
          <MigrateBunnyModal
            open={bunnyMigrateOpen}
            onClose={() => setBunnyMigrateOpen(false)}
            onSuccess={refresh}
            isAdmin={userIsAdmin}
          />

          <ComplianceModal
            open={complianceOpen}
            onClose={() => setComplianceOpen(false)}
            sops={items}
            onComplete={refresh}
          />
          <AdminToolsModal
            open={adminOpen}
            onClose={() => setAdminOpen(false)}
            onSuccess={refresh}
            isAdmin={userIsAdmin}
          />
          <PipelineDock onComplete={refresh} />

          <GuidelinesComplianceWizard
            open={guidelinesWizardOpen}
            minimized={wizardMinimized}
            onClose={() => {
              setGuidelinesWizardOpen(false);
              setWizardMinimized(false);
            }}
            onMinimize={() => setWizardMinimized(true)}
            registryRows={registryRowsForWizard}
            prefetchedGuidelines={prefetchedGuidelines}
            presetSop={guidelinesWizardPreset}
            onResult={handleComplianceResult}
          />

          {viewingComplianceSopNo && complianceCache[viewingComplianceSopNo] && (
            <GuidelinesResultPanel
              result={complianceCache[viewingComplianceSopNo]}
              onClose={() => setViewingComplianceSopNo(null)}
              onRerun={() => {
                const result = complianceCache[viewingComplianceSopNo];
                const row = registryRowsForWizard.find((r) => String(r.sopNo) === viewingComplianceSopNo);
                setViewingComplianceSopNo(null);
                setGuidelinesWizardPreset({
                  _id: row ? String(row._id) : "",
                  sopNo: result.sopNo,
                });
                setGuidelinesWizardOpen(true);
              }}
            />
          )}

          {viewingComplianceFullSopNo && complianceCache[viewingComplianceFullSopNo] && (
            <ComplianceFullViewer
              result={complianceCache[viewingComplianceFullSopNo]}
              onClose={() => setViewingComplianceFullSopNo(null)}
              onRerun={() => {
                const result = complianceCache[viewingComplianceFullSopNo];
                const row = registryRowsForWizard.find((r) => String(r.sopNo) === viewingComplianceFullSopNo);
                setViewingComplianceFullSopNo(null);
                setGuidelinesWizardPreset({
                  _id: row ? String(row._id) : "",
                  sopNo: result.sopNo,
                });
                setGuidelinesWizardOpen(true);
              }}
            />
          )}
        </>
      )}
      <ToastNotification />
      <AuditLogsModal open={auditLogsOpen} onClose={() => setAuditLogsOpen(false)} />
    </div>
  );
}
