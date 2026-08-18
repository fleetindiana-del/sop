import type { RegistrySOP } from "@/lib/types";

/** 80% on the 0–10 compliance scale. */
export const COMPLIANCE_PASS_SCORE = 8;

export function hasUploadedPriorVersion(sop: Pick<RegistrySOP, "priorVersions" | "archivedVersions">): boolean {
  return (
    sop.priorVersions.some((pv) => !pv.missing) ||
    sop.archivedVersions.some((pv) => !pv.missing)
  );
}

export function compliancePercent(score: number): number {
  return Math.round(score * 10);
}
