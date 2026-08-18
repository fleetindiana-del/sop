import { randomUUID } from "crypto";
import { getRuleById, rulesForClassification } from "./fssai-rules";
import type { VisionFinding } from "./extract-label";
import type {
  ExtractedLabel,
  GapLifecycleStatus,
  LabelDeclarations,
  LabelFinding,
  LabelFindingSeverity,
  LabelFindingStatus,
  LabelScoreBreakdown,
  LabelVersionComparison,
  ProductClassification,
  UnreadableRegion,
} from "./types";

const REVIEW_IF_ABSENT = new Set([
  "allergenDeclaration",
  "additiveDeclaration",
  "customerCare",
  "targetGroup",
]);

const SEVERITY_WEIGHT: Record<LabelFindingSeverity, number> = {
  critical: 0,
  high: 0.25,
  medium: 0.55,
  low: 0.75,
};

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length >= 2;
}

function declarationValue(
  extracted: ExtractedLabel,
  key: keyof LabelDeclarations,
): boolean | null | undefined {
  return extracted.declarations[key];
}

function fieldPresent(extracted: ExtractedLabel, field: string): boolean | null {
  if (field === "expiryDate") {
    return hasText(extracted.expiryDate) || hasText(extracted.bestBefore) ? true : false;
  }
  if (field === "manufacturer") {
    return hasText(extracted.manufacturer) || hasText(extracted.packer) || hasText(extracted.importer)
      ? true
      : false;
  }
  if (field === "countryOfOrigin") {
    if (hasText(extracted.countryOfOrigin)) return true;
    // Required only when an importer is identified; otherwise not applicable.
    if (hasText(extracted.importer)) return false;
    return null;
  }
  if (field === "rdaPresent") {
    if (extracted.rdaPresent === true) return true;
    if (extracted.rdaPresent === false) return false;
    return null;
  }
  if (field === "vegetarianLogo") {
    if (extracted.vegetarianLogo === true || extracted.vegetarianLogo === false) return true;
    return extracted.vegetarianLogo === null ? false : null;
  }
  if (field.startsWith("declarations.")) {
    const key = field.slice("declarations.".length) as keyof LabelDeclarations;
    const v = declarationValue(extracted, key);
    if (v === true) return true;
    if (v === false) return false;
    return null;
  }
  const value = extracted[field as keyof ExtractedLabel];
  if (typeof value === "boolean") return value;
  if (value === null) return null;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return hasText(value);
  return null;
}

function asSeverity(raw: unknown, fallback: LabelFindingSeverity): LabelFindingSeverity {
  const v = String(raw ?? "").toLowerCase();
  if (v === "critical" || v === "high" || v === "medium" || v === "low") return v;
  if (v === "major") return "high";
  if (v === "minor") return "medium";
  if (v === "informational") return "low";
  return fallback;
}

function asStatus(raw: unknown): LabelFindingStatus | null {
  const v = String(raw ?? "").toLowerCase();
  if (v === "pass" || v === "fail" || v === "review") return v;
  return null;
}

function evidenceFace(raw: unknown): LabelFinding["evidenceFace"] {
  const v = String(raw ?? "").toLowerCase();
  if (v === "front" || v === "back" || v === "side" || v === "pdf" || v === "unknown") return v;
  return "unknown";
}

function newFinding(partial: Omit<LabelFinding, "findingId" | "lifecycle"> & { lifecycle?: GapLifecycleStatus }): LabelFinding {
  return {
    findingId: randomUUID(),
    lifecycle: partial.lifecycle ?? "detected",
    ...partial,
  };
}

function regionBlocksRule(regions: UnreadableRegion[], ruleTitle: string, field?: string): UnreadableRegion | undefined {
  const hay = `${ruleTitle} ${field ?? ""}`.toLowerCase();
  return regions.find((r) => {
    const section = r.section.toLowerCase();
    if (!section) return false;
    if (hay.includes(section)) return true;
    if (section.includes("ingredient") && hay.includes("ingredient")) return true;
    if (section.includes("warning") && (hay.includes("warning") || hay.includes("medicinal") || hay.includes("children"))) return true;
    if (section.includes("nutrition") && (hay.includes("nutrition") || hay.includes("rda") || hay.includes("serving"))) return true;
    if ((section.includes("license") || section.includes("licence")) && hay.includes("license")) return true;
    if (section.includes("date") && (hay.includes("date") || hay.includes("expiry") || hay.includes("best before") || hay.includes("manufacture"))) return true;
    if (section.includes("claim") && hay.includes("claim")) return true;
    return false;
  });
}

/**
 * Merge vision findings with deterministic presence checks. Structural
 * missing-field failures always win over a vision "pass". Unreadable
 * sections stay as review — never a guessed pass/fail.
 */
export function evaluateLabelCompliance(opts: {
  classification: ProductClassification;
  extracted: ExtractedLabel;
  visionFindings: VisionFinding[];
  previousFindings?: LabelFinding[];
  unreadableRegions?: UnreadableRegion[];
}): { findings: LabelFinding[]; score: LabelScoreBreakdown } {
  const applicable = rulesForClassification(opts.classification);
  const visionByRule = new Map<string, VisionFinding[]>();
  for (const vf of opts.visionFindings) {
    const id = String(vf.ruleId ?? "").trim();
    if (!id) continue;
    const list = visionByRule.get(id) ?? [];
    list.push(vf);
    visionByRule.set(id, list);
  }

  const previousByRule = new Map<string, LabelFinding>();
  for (const prev of opts.previousFindings ?? []) {
    previousByRule.set(prev.ruleId, prev);
  }

  const findings: LabelFinding[] = [];

  for (const rule of applicable) {
    const visionHits = visionByRule.get(rule.id) ?? [];
    const claimHits = visionHits.filter((v) => hasText(v.claim));

    if (rule.category === "claim" && claimHits.length) {
      for (const hit of claimHits) {
        const status = asStatus(hit.status) ?? "review";
        findings.push(
          newFinding({
            ruleId: rule.id,
            title: rule.title,
            regulation: rule.regulation,
            severity: asSeverity(hit.severity, rule.severity),
            status,
            evidenceFace: evidenceFace(hit.evidenceFace),
            evidence: String(hit.evidence ?? "").trim() || `Claim: ${hit.claim}`,
            claim: String(hit.claim).trim(),
            recommendation: String(hit.recommendation ?? "").trim() || rule.recommendation,
            source: "vision",
            lifecycle: status === "pass" ? "closed" : "detected",
          }),
        );
      }
      continue;
    }

    const presence = rule.field ? fieldPresent(opts.extracted, rule.field) : null;
    const vision = visionHits[0];
    const blocked = regionBlocksRule(opts.unreadableRegions ?? [], rule.title, rule.field);
    let status: LabelFindingStatus = "review";
    let source: LabelFinding["source"] = "merged";
    let evidence = vision?.evidence?.trim() || "";
    let recommendation = vision?.recommendation?.trim() || rule.recommendation;
    let evidenceFaceVal = evidenceFace(vision?.evidenceFace);

    if (blocked) {
      status = "review";
      source = "vision";
      evidenceFaceVal = blocked.face;
      evidence = `Unable to confidently read this section (${blocked.section}): ${blocked.reason}`;
      recommendation = blocked.suggestedAction || "Upload a clearer photo of this panel, then re-run extraction.";
    } else if (presence === true) {
      status = asStatus(vision?.status) === "fail" ? "review" : "pass";
      source = vision ? "merged" : "rule-engine";
      if (!evidence) evidence = `Found on label: ${summarizeField(opts.extracted, rule.field)}`;
    } else if (presence === false) {
      const softMiss = rule.field ? REVIEW_IF_ABSENT.has(rule.field) : false;
      status = softMiss ? "review" : "fail";
      source = "rule-engine";
      if (!evidence) {
        evidence = softMiss
          ? `Not visible — confirm whether “${rule.title}” applies to this product.`
          : `Not found on uploaded panels for “${rule.title}”.`;
      }
    } else if (vision) {
      status = asStatus(vision.status) ?? "review";
      source = "vision";
      if (!evidence) evidence = "Vision model could not confirm this requirement from the artwork.";
    } else {
      status = "review";
      source = "rule-engine";
      evidence = "Insufficient evidence on the uploaded panels — needs manual review.";
    }

    const prev = previousByRule.get(rule.id);
    let lifecycle: GapLifecycleStatus = status === "pass" ? "closed" : "detected";
    if (prev && status === "pass" && prev.status !== "pass") {
      lifecycle = "revalidated";
    } else if (prev && status !== "pass" && prev.lifecycle === "corrected") {
      lifecycle = "re-uploaded";
    } else if (prev && status !== "pass") {
      lifecycle = prev.lifecycle === "closed" ? "detected" : prev.lifecycle;
    }

    findings.push(
      newFinding({
        ruleId: rule.id,
        title: rule.title,
        regulation: rule.regulation,
        severity: rule.severity,
        status,
        evidenceFace: evidenceFaceVal,
        evidence,
        recommendation,
        source,
        lifecycle,
      }),
    );
  }

  // Orphan vision findings (unknown rule ids / extra claims)
  for (const [ruleId, hits] of visionByRule) {
    if (getRuleById(ruleId) && applicable.some((r) => r.id === ruleId)) continue;
    for (const hit of hits) {
      const status = asStatus(hit.status) ?? "review";
      findings.push(
        newFinding({
          ruleId: ruleId || "FSSAI-CLAIM-002",
          title: hit.claim ? `Claim requires review` : "Additional label observation",
          regulation: getRuleById(ruleId)?.regulation ?? "FSS (Advertising and Claims) Regulations, 2018",
          severity: asSeverity(hit.severity, "high"),
          status,
          evidenceFace: evidenceFace(hit.evidenceFace),
          evidence: String(hit.evidence ?? "").trim() || "Vision observation",
          claim: hasText(hit.claim) ? String(hit.claim).trim() : undefined,
          recommendation: String(hit.recommendation ?? "").trim() || "Review this claim against FSSAI permitted claims.",
          source: "vision",
          lifecycle: status === "pass" ? "closed" : "detected",
        }),
      );
    }
  }

  return { findings, score: scoreFindings(findings, applicable.length) };
}

function summarizeField(extracted: ExtractedLabel, field?: string): string {
  if (!field) return "";
  if (field.startsWith("declarations.")) {
    const key = field.slice("declarations.".length) as keyof LabelDeclarations;
    return `${key}=${String(extracted.declarations[key])}`;
  }
  if (field === "expiryDate") {
    return extracted.expiryDate || extracted.bestBefore || "";
  }
  const value = extracted[field as keyof ExtractedLabel];
  if (typeof value === "string") return value.slice(0, 180);
  return String(value ?? "");
}

export function scoreFindings(findings: LabelFinding[], applicableRuleCount: number): LabelScoreBreakdown {
  const scored = findings.filter((f) => f.status !== "review" || f.severity === "critical");
  const uniqueRules = new Set(findings.map((f) => f.ruleId));
  let weighted = 0;
  let weightTotal = 0;

  for (const f of findings) {
    if (f.status === "review" && f.severity !== "critical") continue;
    const w = 1;
    weightTotal += w;
    if (f.status === "pass") weighted += w;
    else weighted += SEVERITY_WEIGHT[f.severity] * w;
  }

  const passed = findings.filter((f) => f.status === "pass").length;
  const critical = findings.filter((f) => f.status === "fail" && f.severity === "critical").length;
  const high = findings.filter((f) => f.status === "fail" && f.severity === "high").length;
  const medium = findings.filter((f) => f.status === "fail" && f.severity === "medium").length;
  const low = findings.filter((f) => f.status === "fail" && f.severity === "low").length;
  const review = findings.filter((f) => f.status === "review").length;
  const score = weightTotal > 0 ? Math.round((weighted / weightTotal) * 100) : 0;

  return {
    totalRules: applicableRuleCount || uniqueRules.size,
    applicableRules: uniqueRules.size,
    passed,
    critical,
    high,
    medium,
    low,
    review,
    score,
    formula: scored.length
      ? "Weighted: pass=1, fail critical=0 / high=0.25 / medium=0.55 / low=0.75; review (non-critical) excluded"
      : "No scored findings",
  };
}

export function overallStatus(score: LabelScoreBreakdown): "Fully Compliant" | "Partially Compliant" | "Non-Compliant" {
  if (score.critical > 0 || score.score < 55) return "Non-Compliant";
  if (score.high > 0 || score.medium > 0 || score.score < 90) return "Partially Compliant";
  return "Fully Compliant";
}

function gapKey(f: LabelFinding): string {
  return `${f.ruleId}::${(f.claim || "").trim().toLowerCase()}`;
}

export function compareLabelRuns(
  previous: LabelFinding[],
  next: LabelFinding[],
  fromVersion: number,
  toVersion: number,
  fromScore: number,
  toScore: number,
): LabelVersionComparison {
  const prevGaps = new Map(
    previous.filter((f) => f.status !== "pass").map((f) => [gapKey(f), f]),
  );
  const nextGaps = new Map(
    next.filter((f) => f.status !== "pass").map((f) => [gapKey(f), f]),
  );

  const resolvedTitles: string[] = [];
  for (const [key, finding] of prevGaps) {
    if (!nextGaps.has(key)) resolvedTitles.push(finding.claim || finding.title);
  }
  const remainingTitles: string[] = [];
  const newTitles: string[] = [];
  for (const [key, finding] of nextGaps) {
    const title = finding.claim || finding.title;
    if (prevGaps.has(key)) remainingTitles.push(title);
    else newTitles.push(title);
  }

  return {
    fromVersion,
    toVersion,
    fromScore,
    toScore,
    resolved: resolvedTitles.length,
    remaining: remainingTitles.length,
    newFindings: newTitles.length,
    resolvedTitles: resolvedTitles.slice(0, 12),
    remainingTitles: remainingTitles.slice(0, 12),
    newTitles: newTitles.slice(0, 12),
  };
}
