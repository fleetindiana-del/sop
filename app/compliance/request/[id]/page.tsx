"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useAuthGuard } from "@/hooks/useAuthGuard";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Shield,
  XCircle,
} from "lucide-react";
import { formatSopCodeDisplay } from "@/lib/sopIdentifierNormalize";

type RequestDetail = {
  id: string;
  sopId: string;
  sopIdentifier: string;
  sopName: string;
  department: string;
  requesterName: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  note: string;
  reportId: string | null;
  resultSummary: {
    overallScore: number;
    complianceStatus: string;
    analyzedAt?: string;
    compliantCount: number;
    partialCount: number;
    nonCompliantCount: number;
  } | null;
  notifiedCount: number;
  completedAt: string | null;
  createdAt: string;
};

type CompactFinding = {
  clauseNumber: string;
  clauseTitle: string;
  complianceLevel: string;
  issueSeverity?: string;
  mismatchExplanation?: string;
  suggestedAction?: string;
};

const STATUS_STYLE: Record<RequestDetail["status"], string> = {
  pending: "bg-amber-50 text-amber-800 border-amber-200",
  in_progress: "bg-sky-50 text-sky-800 border-sky-200",
  completed: "bg-emerald-50 text-emerald-800 border-emerald-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
};

const LEVEL_STYLE: Record<string, string> = {
  "non-compliant": "bg-rose-50 text-rose-800 border-rose-200",
  partial: "bg-amber-50 text-amber-800 border-amber-200",
};

export default function ComplianceRequestDetailPage() {
  useAuthGuard();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const [request, setRequest] = useState<RequestDetail | null>(null);
  const [findings, setFindings] = useState<CompactFinding[]>([]);
  const [canOpenEngine, setCanOpenEngine] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/compliance/run-requests/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load request");
      setRequest(data.request);
      setFindings(data.findings ?? []);
      setCanOpenEngine(Boolean(data.canOpenEngine));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load request");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const cancel = async () => {
    if (!id || !request) return;
    setCancelling(true);
    try {
      const res = await fetch(`/api/compliance/run-requests/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to cancel");
      setRequest(data.request);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel");
    } finally {
      setCancelling(false);
    }
  };

  if (loading) {
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
              href="/compliance/request"
              className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Requests
            </Link>
            <div className="h-4 w-px bg-gray-200" />
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-purple-600" />
              <h1 className="text-sm font-bold tracking-tight">Compliance run request</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl px-4 py-6">
        {error && (
          <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
        {!request ? (
          <p className="text-sm text-gray-500">Request not found.</p>
        ) : (
          <>
            <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-lg font-bold text-purple-800">
                    {formatSopCodeDisplay(request.sopIdentifier)}
                  </p>
                  <p className="text-sm text-gray-700">{request.sopName}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {request.department} · requested by {request.requesterName} on{" "}
                    {new Date(request.createdAt).toLocaleString()}
                  </p>
                </div>
                <span
                  className={`inline-flex rounded border px-2.5 py-1 text-[11px] font-bold uppercase ${STATUS_STYLE[request.status]}`}
                >
                  {request.status.replace("_", " ")}
                </span>
              </div>

              {request.note && (
                <p className="mb-4 rounded-lg bg-gray-50 px-3 py-2 text-sm text-gray-700">
                  {request.note}
                </p>
              )}

              {request.status === "pending" && (
                <p className="text-sm text-amber-800">
                  The compliance operator has been notified ({request.notifiedCount} recipient
                  {request.notifiedCount === 1 ? "" : "s"}). Status updates when the run is
                  executed locally.
                </p>
              )}
              {request.status === "in_progress" && (
                <p className="text-sm text-sky-800">
                  A compliance run for this SOP is in progress. This page will refresh when results
                  are saved.
                </p>
              )}

              <div className="mt-5 flex flex-wrap gap-2">
                {(request.status === "pending" || request.status === "in_progress") && (
                  <button
                    type="button"
                    onClick={() => void cancel()}
                    disabled={cancelling}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                  >
                    {cancelling ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5" />
                    )}
                    Cancel request
                  </button>
                )}
                {canOpenEngine && request.status !== "cancelled" && (
                  <button
                    type="button"
                    onClick={() =>
                      router.push(
                        `/compliance?requestId=${request.id}&sopId=${request.sopId}`,
                      )
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100"
                  >
                    <ClipboardCheck className="h-3.5 w-3.5" />
                    Open in Compliance Engine
                  </button>
                )}
                {request.status === "completed" && canOpenEngine && request.reportId && (
                  <Link
                    href={`/compliance/report/${request.reportId}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Full report
                  </Link>
                )}
              </div>
            </div>

            {request.status === "completed" && request.resultSummary && (
              <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
                <h2 className="mb-4 text-sm font-bold text-gray-800">Results</h2>
                <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border border-purple-200 bg-purple-50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-purple-700">
                      Score
                    </p>
                    <p className="text-2xl font-bold text-gray-800">
                      {request.resultSummary.overallScore.toFixed(1)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                      Status
                    </p>
                    <p className="text-sm font-semibold text-gray-800">
                      {request.resultSummary.complianceStatus || "—"}
                    </p>
                  </div>
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                      Compliant
                    </p>
                    <p className="text-2xl font-bold text-gray-800">
                      {request.resultSummary.compliantCount}
                    </p>
                  </div>
                  <div className="rounded-xl border border-rose-200 bg-rose-50 p-3">
                    <p className="text-[10px] font-bold uppercase tracking-wide text-rose-700">
                      Gaps
                    </p>
                    <p className="text-2xl font-bold text-gray-800">
                      {request.resultSummary.partialCount +
                        request.resultSummary.nonCompliantCount}
                    </p>
                  </div>
                </div>
                {request.completedAt && (
                  <p className="mb-4 text-xs text-gray-500">
                    Completed {new Date(request.completedAt).toLocaleString()}
                  </p>
                )}

                {findings.length > 0 ? (
                  <div className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Open findings ({findings.length}
                      {findings.length === 20 ? "+" : ""})
                    </p>
                    {findings.map((f, i) => (
                      <div
                        key={`${f.clauseNumber}-${i}`}
                        className="rounded-xl border border-gray-200 px-4 py-3"
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-purple-700">
                            {f.clauseNumber}
                          </span>
                          <span className="text-sm font-medium text-gray-800">{f.clauseTitle}</span>
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                              LEVEL_STYLE[f.complianceLevel] ??
                              "bg-slate-50 text-slate-700 border-slate-200"
                            }`}
                          >
                            {f.complianceLevel}
                          </span>
                        </div>
                        {f.mismatchExplanation && (
                          <p className="text-xs leading-relaxed text-gray-600">
                            {f.mismatchExplanation}
                          </p>
                        )}
                        {f.suggestedAction && (
                          <p className="mt-1 text-xs text-gray-500">
                            Suggested: {f.suggestedAction}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">No open gap findings in this report.</p>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
