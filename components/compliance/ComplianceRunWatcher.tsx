"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useComplianceRunStore } from "@/lib/store/compliance-run-store";

type ActiveRun = { sopId: string; identifier: string; name: string };

let serverPollTimer: ReturnType<typeof setInterval> | null = null;

function stopServerPoll() {
  if (serverPollTimer) {
    clearInterval(serverPollTimer);
    serverPollTimer = null;
  }
}

async function fetchActiveRuns(): Promise<ActiveRun[] | null> {
  try {
    const res = await fetch("/api/compliance/active");
    if (res.status === 401) return null;
    const data = await res.json();
    if (!data.success || !data.active || !Array.isArray(data.runs) || !data.runs.length) {
      return null;
    }
    return data.runs.map((r: ActiveRun) => ({
      sopId: r.sopId,
      identifier: r.identifier,
      name: r.name,
    }));
  } catch {
    return null;
  }
}

/**
 * Lightweight watcher: one check on load, then polls only while the server
 * reports an in-process run. Avoids hammering /api/compliance/active while idle.
 */
export function ComplianceRunWatcher() {
  const pathname = usePathname();
  const isAnalyzing = useComplianceRunStore((s) => s.isAnalyzing);
  const initialCheckDone = useRef(false);
  const isLoginPage = pathname === "/login";
  const isPublicLabel = Boolean(pathname?.startsWith("/compliance/label"));

  useEffect(() => {
    if (isAnalyzing || isLoginPage || isPublicLabel) {
      stopServerPoll();
      if (isAnalyzing) {
        useComplianceRunStore.getState().setServerActive(false, []);
      }
      return;
    }

    const { setServerActive } = useComplianceRunStore.getState();

    const applyResult = (runs: ActiveRun[] | null) => {
      if (runs?.length) {
        setServerActive(true, runs);
        if (!serverPollTimer) {
          serverPollTimer = setInterval(async () => {
            if (useComplianceRunStore.getState().isAnalyzing) {
              stopServerPoll();
              return;
            }
            const next = await fetchActiveRuns();
            if (!next?.length) {
              setServerActive(false, []);
              stopServerPoll();
            } else {
              setServerActive(true, next);
            }
          }, 15000);
        }
      } else {
        setServerActive(false, []);
        stopServerPoll();
      }
    };

    if (!initialCheckDone.current) {
      initialCheckDone.current = true;
      void fetchActiveRuns().then(applyResult);
    }

    return () => {
      stopServerPoll();
    };
  }, [isAnalyzing, isLoginPage, isPublicLabel]);

  return null;
}
