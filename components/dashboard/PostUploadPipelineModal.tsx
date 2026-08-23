"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useDashboardStore } from "@/lib/store/dashboard-store";
import { Btn, Modal } from "./ui";

type Phase = "checking" | "queued" | "starting" | "started" | "error";

export function PostUploadPipelineModal({
  open,
  identifiers,
  onClose,
  onStarted,
}: {
  open: boolean;
  identifiers: string[];
  onClose: () => void;
  onStarted?: () => void;
}) {
  const { addPipelineJob, showToast } = useDashboardStore();
  const [phase, setPhase] = useState<Phase>("checking");
  const [message, setMessage] = useState("");
  const [awaitingWorker, setAwaitingWorker] = useState(true);

  const uniqueIds = [...new Set(identifiers.filter(Boolean))];
  const idsKey = uniqueIds.slice().sort().join("|");
  const label =
    uniqueIds.length === 1
      ? uniqueIds[0]
      : `${uniqueIds.length} SOP${uniqueIds.length === 1 ? "" : "s"}`;

  useEffect(() => {
    if (!open) {
      setPhase("checking");
      setMessage("");
      setAwaitingWorker(true);
      return;
    }
    if (!uniqueIds.length) {
      setPhase("error");
      setMessage("No uploaded SOPs to process");
      return;
    }

    let cancelled = false;
    setPhase("checking");

    void (async () => {
      try {
        const res = await fetch("/api/llm/codex-status");
        const data = await res.json();
        if (cancelled) return;
        const localCodex = Boolean(data.success && data.codex?.loggedIn);
        setAwaitingWorker(!localCodex);
        for (const identifier of uniqueIds) {
          addPipelineJob({
            identifier,
            language: "ENG",
            stage: "mcq_generating",
            status: "running",
            progress: 8,
          });
        }
        setPhase("queued");
        onStarted?.();
      } catch {
        if (cancelled) return;
        setAwaitingWorker(true);
        setPhase("queued");
        onStarted?.();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, idsKey]);

  const resetAndClose = () => {
    setPhase("checking");
    setMessage("");
    onClose();
  };

  const startCompliance = async () => {
    if (!uniqueIds.length) return;
    setPhase("starting");
    try {
      const res = await fetch("/api/sop/post-upload-pipeline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifiers: uniqueIds, compliance: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setPhase("error");
        setMessage(data.error || "Could not start compliance");
        return;
      }
      showToast("Compliance started — see Work in progress");
      setPhase("started");
      setTimeout(() => resetAndClose(), 900);
    } catch {
      setPhase("error");
      setMessage("Could not start compliance");
    }
  };

  return (
    <Modal
      open={open}
      onClose={phase === "checking" || phase === "starting" ? () => undefined : resetAndClose}
      title="MCQ generation"
    >
      <div className="space-y-3 text-xs text-slate-700">
        {phase === "checking" && (
          <div className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-3">
            <Loader2 className="h-4 w-4 animate-spin text-sky-600" />
            <span>MCQs are queued for {label}…</span>
          </div>
        )}

        {phase === "queued" && (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-950">
            <p className="font-semibold">MCQs queued for {label}</p>
            {awaitingWorker ? (
              <p className="mt-1 text-[11px] leading-snug">
                The website cannot run Codex. Keep{" "}
                <code className="rounded bg-white px-1">npm run dev</code> or{" "}
                <code className="rounded bg-white px-1">npm run mcq:worker</code> running on your
                computer with the <strong>same MongoDB</strong> as production. The local worker
                starts Codex automatically when it sees this job.
              </p>
            ) : (
              <p className="mt-1 text-[11px] leading-snug">
                Codex is available on this machine and will generate the questions. Watch Work in
                progress for live status.
              </p>
            )}
          </div>
        )}

        {phase === "starting" && (
          <div className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-3">
            <Loader2 className="h-4 w-4 animate-spin text-emerald-600" />
            <span>Starting compliance…</span>
          </div>
        )}

        {phase === "started" && (
          <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-3 text-emerald-900">
            <p className="font-semibold">Started in the background</p>
          </div>
        )}

        {phase === "error" && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-3 text-red-800">
            <p className="font-semibold">Could not continue</p>
            <p className="mt-1 text-[11px]">{message}</p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          {phase === "queued" && !awaitingWorker && (
            <Btn variant="primary" onClick={() => void startCompliance()}>
              Also start compliance
            </Btn>
          )}
          {(phase === "queued" || phase === "started" || phase === "error") && (
            <Btn onClick={resetAndClose}>Close</Btn>
          )}
        </div>
      </div>
    </Modal>
  );
}
