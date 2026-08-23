"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Download,
  History,
  Loader2,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { displaySopCode } from "@/lib/sop-display";
import { Badge, Btn } from "./ui";

export type AuditLogRow = {
  id: string;
  timestamp: string;
  entityType: "sop" | "department";
  entityId: string;
  entityLabel: string;
  sopName: string;
  department: string;
  userId: string;
  userName: string;
  userRole: string;
  userDepartment: string;
  action: string;
  fieldsChanged: string[];
  previousValues: Record<string, unknown>;
  updatedValues: Record<string, unknown>;
  summary: string;
  comments: string;
  ipAddress: string;
  userAgent: string;
  systemGenerated: boolean;
};

type Facets = {
  actions: string[];
  entityTypes: string[];
  departments: string[];
  users: string[];
};

type SortField =
  | "timestamp"
  | "userName"
  | "userRole"
  | "action"
  | "entityType"
  | "entityLabel"
  | "sopName"
  | "department";

const ACTION_BADGE: Record<string, "green" | "amber" | "red" | "blue" | "purple" | "gray" | "default"> = {
  created: "green",
  uploaded: "blue",
  updated: "purple",
  restored: "green",
  renamed: "amber",
  obsoleted: "amber",
  deleted: "red",
};

const FIELD_LABELS: Record<string, string> = {
  name: "SOP Name",
  identifier: "SOP No.",
  department: "Department",
  owner: "Owner",
  version: "Version",
  language: "Language",
  location: "Location",
  processArea: "Process Area",
  guidelineReference: "Guideline Ref.",
  remarks: "Remarks",
  status: "Status",
  isObsolete: "Obsolete",
  obsoleteReason: "Obsolete Reason",
  effectiveDate: "Effective Date",
  reviewDate: "Review Date",
  expiryDate: "Expiry Date",
  file: "File",
  videosEn: "Videos (EN)",
  videosGu: "Videos (GUJ)",
  slidesEn: "Slides (EN)",
  slidesGu: "Slides (GUJ)",
  thumbnail: "Thumbnail",
};

function fieldLabel(key: string) {
  return FIELD_LABELS[key] ?? key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function formatTimestamp(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
      }
    }
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function AuditLogsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facets, setFacets] = useState<Facets>({
    actions: [],
    entityTypes: [],
    departments: [],
    users: [],
  });
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [department, setDepartment] = useState("");
  const [userName, setUserName] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sortBy, setSortBy] = useState<SortField>("timestamp");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, action, entityType, department, userName, from, to]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedQ) params.set("q", debouncedQ);
    if (action) params.set("action", action);
    if (entityType) params.set("entityType", entityType);
    if (department) params.set("department", department);
    if (userName) params.set("userName", userName);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("sortBy", sortBy);
    params.set("sortDir", sortDir);
    params.set("page", String(page));
    params.set("limit", String(limit));
    return params.toString();
  }, [debouncedQ, action, entityType, department, userName, from, to, sortBy, sortDir, page, limit]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/audit-logs?${queryString}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load audit logs");
      setItems(data.items ?? []);
      setTotal(Number(data.total ?? 0));
      if (data.facets) setFacets(data.facets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load audit logs");
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleSort = (field: SortField) => {
    if (sortBy === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDir(field === "timestamp" ? "desc" : "asc");
    }
    setPage(1);
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const params = new URLSearchParams(queryString);
      params.set("format", "csv");
      params.delete("page");
      params.delete("limit");
      const res = await fetch(`/api/audit-logs?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  const resetFilters = () => {
    setQ("");
    setDebouncedQ("");
    setAction("");
    setEntityType("");
    setDepartment("");
    setUserName("");
    setFrom("");
    setTo("");
    setSortBy("timestamp");
    setSortDir("desc");
    setPage(1);
  };

  const pageCount = Math.max(1, Math.ceil(total / limit));
  const fromRow = total === 0 ? 0 : (page - 1) * limit + 1;
  const toRow = Math.min(total, page * limit);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortBy !== field) {
      return <ArrowUpDown className="ml-0.5 inline h-3 w-3 text-gray-400 opacity-60" />;
    }
    return sortDir === "asc" ? (
      <ArrowUp className="ml-0.5 inline h-3 w-3 text-violet-600" />
    ) : (
      <ArrowDown className="ml-0.5 inline h-3 w-3 text-violet-600" />
    );
  };

  const thBtn =
    "flex w-full items-center gap-0.5 rounded px-0.5 py-1 text-left text-[10px] font-bold uppercase tracking-wide text-gray-600 hover:bg-violet-50 hover:text-violet-700 focus:outline-none focus:ring-2 focus:ring-violet-400";

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-logs-title"
        className="flex h-[92vh] w-full max-w-[1600px] flex-col overflow-hidden rounded-lg bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 bg-gray-50 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600">
              <History className="h-4 w-4 text-white" />
            </div>
            <div>
              <h2 id="audit-logs-title" className="text-sm font-semibold text-slate-800">
                Dashboard Audit Logs
              </h2>
              <p className="text-[10px] text-slate-500">
                Who changed what, when, and the previous vs new values. Includes prior SOP
                uploadedAt / createdAt / obsoleteAt. Times shown in IST. Records are append-only.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Btn size="sm" onClick={() => void load()} disabled={loading} title="Refresh">
              <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Btn>
            <Btn size="sm" onClick={() => void exportCsv()} disabled={exporting || total === 0}>
              <Download className="h-3 w-3" />
              {exporting ? "Exporting…" : "Export CSV"}
            </Btn>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1.5 text-slate-500 hover:bg-slate-200"
              aria-label="Close audit logs"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-2 border-b border-slate-200 px-4 py-2.5">
          <label className="min-w-[180px] flex-1">
            <span className="mb-0.5 block text-[9px] font-bold uppercase tracking-wide text-slate-500">Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-slate-400" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="SOP no., name, user, summary…"
                className="w-full rounded border border-slate-300 py-1 pl-7 pr-2 text-xs focus:border-violet-500 focus:outline-none"
              />
            </div>
          </label>
          <FilterSelect label="Action" value={action} onChange={setAction} options={facets.actions} />
          <FilterSelect
            label="Entity"
            value={entityType}
            onChange={setEntityType}
            options={facets.entityTypes}
          />
          <FilterSelect
            label="Department"
            value={department}
            onChange={setDepartment}
            options={facets.departments}
          />
          <FilterSelect label="User" value={userName} onChange={setUserName} options={facets.users} />
          <label>
            <span className="mb-0.5 block text-[9px] font-bold uppercase tracking-wide text-slate-500">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-xs focus:border-violet-500 focus:outline-none"
            />
          </label>
          <label>
            <span className="mb-0.5 block text-[9px] font-bold uppercase tracking-wide text-slate-500">To</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1 text-xs focus:border-violet-500 focus:outline-none"
            />
          </label>
          <Btn size="sm" onClick={resetFilters}>
            Clear filters
          </Btn>
        </div>

        <div className="flex items-center justify-between px-4 py-1.5 text-[11px] text-slate-600">
          <span>
            {loading ? "Loading…" : `${fromRow}–${toRow} of ${total} event${total === 1 ? "" : "s"}`}
          </span>
          <span className="text-slate-400">Click a column header to sort. Expand a row to see field-level changes.</span>
        </div>

        {error && (
          <div className="mx-4 mb-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
          <table className="w-full min-w-[1100px] border-collapse text-left">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="w-7 bg-gray-100 px-1 py-1" aria-label="Expand" />
                <th className="bg-gray-100 px-1 py-1">
                  <button type="button" className={thBtn} onClick={() => handleSort("timestamp")}>
                    Timestamp (IST) <SortIcon field="timestamp" />
                  </button>
                </th>
                <th className="bg-gray-100 px-1 py-1">
                  <button type="button" className={thBtn} onClick={() => handleSort("userName")}>
                    User <SortIcon field="userName" />
                  </button>
                </th>
                <th className="bg-gray-100 px-1 py-1">
                  <button type="button" className={thBtn} onClick={() => handleSort("userRole")}>
                    Role <SortIcon field="userRole" />
                  </button>
                </th>
                <th className="bg-gray-100 px-1 py-1">
                  <button type="button" className={thBtn} onClick={() => handleSort("action")}>
                    Action <SortIcon field="action" />
                  </button>
                </th>
                <th className="bg-gray-100 px-1 py-1">
                  <button type="button" className={thBtn} onClick={() => handleSort("entityLabel")}>
                    SOP / Dept <SortIcon field="entityLabel" />
                  </button>
                </th>
                <th className="bg-gray-100 px-1 py-1">
                  <button type="button" className={thBtn} onClick={() => handleSort("sopName")}>
                    SOP Name <SortIcon field="sopName" />
                  </button>
                </th>
                <th className="bg-gray-100 px-1 py-1">
                  <button type="button" className={thBtn} onClick={() => handleSort("department")}>
                    Department <SortIcon field="department" />
                  </button>
                </th>
                <th className="bg-gray-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-600">
                  Fields changed
                </th>
                <th className="bg-gray-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-gray-600">
                  Summary
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-16 text-center text-sm text-slate-500">
                    <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin text-violet-600" />
                    Loading audit logs… first open reconstructs prior SOP events from uploadedAt / createdAt.
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={10} className="py-16 text-center text-sm text-slate-500">
                    No matching audit events for the current filters.
                  </td>
                </tr>
              ) : (
                items.map((row) => {
                  const isOpen = expanded.has(row.id);
                  const changeKeys = row.fieldsChanged.length
                    ? row.fieldsChanged
                    : [...new Set([...Object.keys(row.previousValues), ...Object.keys(row.updatedValues)])];
                  return (
                    <AuditRow
                      key={row.id}
                      row={row}
                      open={isOpen}
                      changeKeys={changeKeys}
                      onToggle={() => toggleExpanded(row.id)}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-2">
          <span className="text-[11px] text-slate-500">
            Page {page} of {pageCount}
          </span>
          <div className="flex items-center gap-1.5">
            <Btn size="sm" disabled={page <= 1 || loading} onClick={() => setPage(1)}>
              First
            </Btn>
            <Btn size="sm" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </Btn>
            <Btn
              size="sm"
              disabled={page >= pageCount || loading}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              Next
            </Btn>
            <Btn
              size="sm"
              disabled={page >= pageCount || loading}
              onClick={() => setPage(pageCount)}
            >
              Last
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
}) {
  return (
    <label>
      <span className="mb-0.5 block text-[9px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs capitalize focus:border-violet-500 focus:outline-none"
      >
        <option value="">All</option>
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

function AuditRow({
  row,
  open,
  changeKeys,
  onToggle,
}: {
  row: AuditLogRow;
  open: boolean;
  changeKeys: string[];
  onToggle: () => void;
}) {
  const label =
    row.entityType === "sop" ? displaySopCode(row.entityLabel) || row.entityLabel : row.entityLabel;

  return (
    <>
      <tr className="border-b border-slate-100 hover:bg-violet-50/40">
        <td className="px-1 py-1.5 align-middle">
          <button
            type="button"
            onClick={onToggle}
            className="rounded p-0.5 text-slate-500 hover:bg-slate-200"
            aria-expanded={open}
            aria-label={open ? "Hide change details" : "Show change details"}
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 align-middle text-[11px] text-slate-700">
          {formatTimestamp(row.timestamp)}
        </td>
        <td className="px-2 py-1.5 align-middle text-[11px] font-medium text-slate-800">
          {row.userName}
          {row.systemGenerated && (
            <span className="ml-1 rounded border border-slate-200 bg-slate-50 px-1 py-px text-[8px] font-semibold uppercase tracking-wide text-slate-500">
              record
            </span>
          )}
        </td>
        <td className="px-2 py-1.5 align-middle">
          <span className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{row.userRole}</span>
        </td>
        <td className="px-2 py-1.5 align-middle">
          <Badge variant={ACTION_BADGE[row.action] ?? "default"} className="capitalize">
            {row.action}
          </Badge>
        </td>
        <td className="px-2 py-1.5 align-middle text-[11px] font-semibold text-slate-800">{label}</td>
        <td className="max-w-[220px] truncate px-2 py-1.5 align-middle text-[11px] text-slate-700" title={row.sopName}>
          {row.sopName || "—"}
        </td>
        <td className="px-2 py-1.5 align-middle text-[11px] text-slate-700">{row.department || "—"}</td>
        <td className="px-2 py-1.5 align-middle">
          <div className="flex flex-wrap gap-0.5">
            {row.fieldsChanged.length ? (
              row.fieldsChanged.slice(0, 4).map((field) => (
                <span
                  key={field}
                  className="rounded border border-slate-200 bg-slate-50 px-1 py-px text-[9px] font-medium text-slate-600"
                >
                  {fieldLabel(field)}
                </span>
              ))
            ) : (
              <span className="text-[10px] text-slate-400">—</span>
            )}
            {row.fieldsChanged.length > 4 && (
              <span className="text-[9px] text-slate-500">+{row.fieldsChanged.length - 4}</span>
            )}
          </div>
        </td>
        <td className="max-w-[280px] truncate px-2 py-1.5 align-middle text-[11px] text-slate-600" title={row.summary}>
          {row.summary}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-slate-200 bg-slate-50">
          <td colSpan={10} className="px-6 py-3">
            <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
              {row.comments && <span>Note: {row.comments}</span>}
              {row.ipAddress && <span>IP: {row.ipAddress}</span>}
              {row.systemGenerated && <span>System generated</span>}
            </div>
            {changeKeys.length === 0 ? (
              <p className="text-xs text-slate-500">No field-level differences recorded for this event.</p>
            ) : (
              <table className="w-full max-w-4xl border-collapse overflow-hidden rounded border border-slate-200 bg-white text-left">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-600">Field</th>
                    <th className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-600">Previous</th>
                    <th className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-600">New</th>
                  </tr>
                </thead>
                <tbody>
                  {changeKeys.map((field) => (
                    <tr key={field} className="border-t border-slate-100">
                      <td className="px-2 py-1 text-[11px] font-medium text-slate-700">{fieldLabel(field)}</td>
                      <td className="px-2 py-1 text-[11px] text-rose-700">
                        {formatValue(row.previousValues[field])}
                      </td>
                      <td className="px-2 py-1 text-[11px] text-emerald-700">
                        {formatValue(row.updatedValues[field])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
