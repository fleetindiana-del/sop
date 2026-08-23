import type { RegistrySOP } from "@/lib/types";

/** 80% on the 0–10 compliance scale. */
export const COMPLIANCE_PASS_SCORE = 8;

export function hasUploadedPriorVersion(sop: Pick<RegistrySOP, "priorVersions" | "archivedVersions">): boolean {
  return (
    sop.priorVersions.some((pv) => !pv.missing) ||
    sop.archivedVersions.some((pv) => !pv.missing)
  );
}

/**
 * Bypass means a new revision was issued (expiry refreshed into the future)
 * without running compliance, after the prior version had failed.
 * Expired / undated SOPs still have prior files on record but did not bypass —
 * the expiry was never updated, so they stay "not done", not "bypassed".
 */
export function isComplianceBypassed(
  sop: Pick<RegistrySOP, "priorVersions" | "archivedVersions" | "expiryTier">,
  analyzed: boolean,
  priorFailed: boolean,
): boolean {
  if (analyzed || !priorFailed || !hasUploadedPriorVersion(sop)) return false;
  return sop.expiryTier !== "expired" && sop.expiryTier !== "none";
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
