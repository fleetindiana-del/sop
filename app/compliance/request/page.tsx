"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useAuthGuard } from "@/hooks/useAuthGuard";
import {
  ArrowLeft,
  ClipboardCheck,
  Loader2,
  Search,
  Shield,
} from "lucide-react";
import { formatSopCodeDisplay } from "@/lib/sopIdentifierNormalize";
import { isDeptScopedRole, parseAssignedDepartments } from "@/lib/roles";
import type { AppRole } from "@/lib/auth";

type CatalogSop = {
  _id: string;
  identifier: string;
  name: string;
  department: string;
  version?: string;
};

type RunRequest = {
  id: string;
  sopIdentifier: string;
  sopName: string;
  department: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  createdAt: string;
  resultSummary: { overallScore: number; complianceStatus: string } | null;
};

const STATUS_STYLE: Record<RunRequest["status"], string> = {
  pending: "bg-amber-50 text-amber-800 border-amber-200",
  in_progress: "bg-sky-50 text-sky-800 border-sky-200",
  completed: "bg-emerald-50 text-emerald-800 border-emerald-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
};

export default function RequestComplianceRunPage() {
  useAuthGuard();
  const router = useRouter();
  const { data: session, status } = useSession();
  const role = (session?.user?.role ?? "viewer") as AppRole;
  const assignedDepts = parseAssignedDepartments(session?.user?.department);
  const assignedKey = assignedDepts.join("|");

  const [departments, setDepartments] = useState<string[]>([]);
  const [sops, setSops] = useState<CatalogSop[]>([]);
  const [requests, setRequests] = useState<RunRequest[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [department, setDepartment] = useState("");
  const [sopId, setSopId] = useState("");
  const [sopQuery, setSopQuery] = useState("");
  const [note, setNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const [deptRes, sopRes] = await Promise.all([
        fetch("/api/departments"),
        fetch("/api/compliance/sops"),
      ]);
      const deptData = await deptRes.json();
      const sopData = await sopRes.json();
      let depts: string[] = deptData.departments ?? [];
      let list: CatalogSop[] = sopData.sops ?? [];
      if (isDeptScopedRole(role) && assignedDepts.length) {
        const allowed = new Set(assignedDepts.map((d) => d.toLowerCase()));
        depts = depts.filter((d) => allowed.has(d.toLowerCase()));
        list = list.filter((s) => allowed.has(s.department.toLowerCase()));
      }
      setDepartments(depts);
      setSops(list);
      if (depts.length === 1) setDepartment(depts[0]);
    } catch {
      setError("Failed to load SOPs and departments.");
    } finally {
      setLoadingCatalog(false);
    }
  }, [role, assignedKey]);

  const loadRequests = useCallback(async () => {
    setLoadingRequests(true);
    try {
      const res = await fetch("/api/compliance/run-requests");
      const data = await res.json();
      if (res.ok) setRequests(data.requests ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoadingRequests(false);
    }
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    void loadCatalog();
    void loadRequests();
  }, [status, loadCatalog, loadRequests]);

  const filteredSops = useMemo(() => {
    const q = sopQuery.trim().toLowerCase();
    return sops.filter((s) => {
      if (department && s.department !== department) return false;
      if (!q) return true;
      return (
        s.identifier.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        formatSopCodeDisplay(s.identifier).toLowerCase().includes(q)
      );
    });
  }, [sops, department, sopQuery]);

  const selectedSop = sops.find((s) => s._id === sopId) ?? null;

  useEffect(() => {
    if (selectedSop && department && selectedSop.department !== department) {
      setSopId("");
    }
  }, [department, selectedSop]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError("");
    if (!department || !sopId || !confirmed) {
      setError("Select an SOP, department, and confirm the request.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/compliance/run-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sopId, department, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to submit request");
      const id = data.request?.id;
      if (id) router.push(`/compliance/request/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit request");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
            </Link>
            <div className="h-4 w-px bg-gray-200" />
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-purple-600" />
              <h1 className="text-sm font-bold tracking-tight">Request Compliance Run</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 py-6">
        <p className="mb-6 text-sm text-gray-600">
          This sends a notification to the person who runs compliance locally. It does not start
          the analysis from the dashboard.
        </p>

        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm"
        >
          {error && (
            <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
          )}

          <label className="mb-4 block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
              1. Department
            </span>
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              disabled={loadingCatalog}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            >
              <option value="">Select department…</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          <div className="mb-4">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
              2. SOP
            </span>
            <div className="relative mb-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                value={sopQuery}
                onChange={(e) => setSopQuery(e.target.value)}
                disabled={!department || loadingCatalog}
                placeholder={department ? "Search SOP code or name…" : "Select a department first"}
                className="w-full rounded-lg border border-gray-200 py-2.5 pl-9 pr-3 text-sm text-gray-800 placeholder:text-gray-400 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 disabled:bg-gray-50"
              />
            </div>
            <select
              value={sopId}
              onChange={(e) => setSopId(e.target.value)}
              disabled={!department || loadingCatalog}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-800 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20 disabled:bg-gray-50"
            >
              <option value="">
                {loadingCatalog
                  ? "Loading SOPs…"
                  : department
                    ? `Select SOP (${filteredSops.length})…`
                    : "Select a department first"}
              </option>
              {filteredSops.map((s) => (
                <option key={s._id} value={s._id}>
                  {formatSopCodeDisplay(s.identifier)} — {s.name}
                </option>
              ))}
            </select>
          </div>

          <label className="mb-4 block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-gray-500">
              Note (optional)
            </span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Anything the operator should know…"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder:text-gray-400 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-500/20"
            />
          </label>

          {selectedSop && department && (
            <div className="mb-4 rounded-xl border border-purple-200 bg-purple-50/70 p-4">
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-purple-700">
                3. Confirm request
              </p>
              <p className="text-sm text-gray-800">
                <span className="font-mono font-semibold text-purple-800">
                  {formatSopCodeDisplay(selectedSop.identifier)}
                </span>
                {" — "}
                {selectedSop.name}
              </p>
              <p className="mt-1 text-xs text-gray-600">Department: {department}</p>
              <label className="mt-3 flex items-start gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                />
                Notify the compliance operator to run this SOP locally. I understand this does not
                start the analysis from here.
              </label>
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !department || !sopId || !confirmed}
            className="inline-flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ClipboardCheck className="h-4 w-4" />
            )}
            {submitting ? "Submitting…" : "Submit request"}
          </button>
        </form>

        <section className="mt-8">
          <h2 className="mb-3 text-sm font-bold text-gray-800">Your requests</h2>
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
            {loadingRequests ? (
              <div className="flex justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
              </div>
            ) : requests.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-gray-500">
                You have not requested any compliance runs yet.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-[11px] uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-4 py-2.5">SOP</th>
                    <th className="px-4 py-2.5">Department</th>
                    <th className="px-4 py-2.5">Status</th>
                    <th className="px-4 py-2.5">Requested</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} className="border-t border-gray-100">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/compliance/request/${r.id}`}
                          className="font-medium text-purple-700 hover:underline"
                        >
                          {r.sopIdentifier}
                        </Link>
                        <p className="text-xs text-gray-500">{r.sopName}</p>
                      </td>
                      <td className="px-4 py-2.5 text-gray-600">{r.department}</td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-flex rounded border px-2 py-0.5 text-[10px] font-bold uppercase ${STATUS_STYLE[r.status]}`}
                        >
                          {r.status.replace("_", " ")}
                        </span>
                        {r.status === "completed" && r.resultSummary && (
                          <span className="ml-2 text-[11px] text-gray-500">
                            {r.resultSummary.complianceStatus}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">
                        {new Date(r.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
