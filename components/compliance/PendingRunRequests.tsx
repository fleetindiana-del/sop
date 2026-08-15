"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, ClipboardCheck, Loader2 } from "lucide-react";

type RunRequest = {
  id: string;
  sopId: string;
  sopIdentifier: string;
  sopName: string;
  department: string;
  requesterName: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  createdAt: string;
};

export function PendingRunRequests({
  onSelectSop,
}: {
  onSelectSop: (sopId: string, department: string) => void;
}) {
  const router = useRouter();
  const [requests, setRequests] = useState<RunRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/compliance/run-requests?inbox=1");
      const data = await res.json();
      if (res.ok) setRequests(data.requests ?? []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openInEngine = async (req: RunRequest) => {
    try {
      await fetch(`/api/compliance/run-requests/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "acknowledge" }),
      });
    } catch {
      /* still select the SOP */
    }
    onSelectSop(req.sopId, req.department);
    router.replace(`/compliance?requestId=${req.id}&sopId=${req.sopId}`, { scroll: false });
  };

  if (loading && requests.length === 0) return null;
  if (requests.length === 0) return null;

  return (
    <div className="mb-6 rounded-2xl border border-amber-200 bg-amber-50/80 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Bell className="h-4 w-4 text-amber-700" />
        <h3 className="text-sm font-bold text-amber-900">
          Pending compliance run requests ({requests.length})
        </h3>
      </div>
      <p className="mb-3 text-xs text-amber-800">
        These were requested from the dashboard. Select the SOP here, then run the check locally
        as usual. The requester is notified when the report is saved.
      </p>
      <div className="space-y-2">
        {requests.map((req) => (
          <div
            key={req.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-white px-4 py-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-800">
                <span className="font-mono text-purple-700">{req.sopIdentifier}</span>
                {" — "}
                {req.sopName}
              </p>
              <p className="mt-0.5 text-xs text-gray-500">
                {req.department} · requested by {req.requesterName}
                {req.status === "in_progress" ? " · in progress" : ""}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void openInEngine(req)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 hover:bg-purple-100"
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              Select SOP
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
