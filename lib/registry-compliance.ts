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

/** Score is shown only when the current version passed compliance (≥ 80%). */
export function shouldShowComplianceScore(
  sop: Pick<RegistrySOP, "complianceDone">,
): boolean {
  return Boolean(sop.complianceDone);
}
