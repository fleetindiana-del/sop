/**
 * Remove PDF image streams and "scanned image" boilerplate from compliance findings.
 *   npx tsx scripts/repair-finding-text.ts
 */
import fs from "fs";
import { connectDB } from "@/lib/mongodb";
import ComplianceReport from "@/models/ComplianceReport";
import { isBadFindingNarrative, isUnreadableDocumentText } from "@/lib/ComplianceFindingValidator";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const env = fs.readFileSync(file, "utf8");
      for (const line of env.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (!m || process.env[m[1]]) continue;
        let value = m[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[m[1]] = value;
      }
      return;
    } catch {
      /* try next */
    }
  }
}

function requirementOf(finding: {
  guidelineRequirement?: string;
  clauseText?: string;
  clauseTitle?: string;
}): string {
  const raw = (finding.guidelineRequirement || finding.clauseText || finding.clauseTitle || "this requirement")
    .replace(/\s+/g, " ")
    .trim();
  const text = isUnreadableDocumentText(raw) ? finding.clauseTitle || "this requirement" : raw;
  return text.length > 320 ? `${text.slice(0, 317)}...` : text;
}

function repairFinding(
  finding: Record<string, unknown>,
  sopName: string,
): { finding: Record<string, unknown>; changed: boolean } {
  const next = { ...finding };
  let changed = false;
  const requirement = requirementOf(finding as { guidelineRequirement?: string; clauseText?: string; clauseTitle?: string });
  const level = String(finding.complianceLevel ?? "");

  const set = (key: string, value: string) => {
    if (next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  };

  const clearIfBad = (key: string) => {
    const value = typeof next[key] === "string" ? (next[key] as string) : "";
    if (value && isBadFindingNarrative(value)) set(key, "");
  };

  if (isBadFindingNarrative(String(next.sopTextSnippet ?? ""))) set("sopTextSnippet", "");
  if (isBadFindingNarrative(String(next.suggestedAction ?? ""))) {
    set("suggestedAction", "State this requirement in the procedure and train the users who perform the activity.");
  }
  if (isBadFindingNarrative(String(next.suggestedText ?? "")) && level !== "compliant" && level !== "not-applicable") {
    set(
      "suggestedText",
      `${sopName} shall state that ${requirement} Name the responsible person, the record to be completed, and the action if the requirement is not met.`,
    );
  } else {
    clearIfBad("suggestedText");
  }
  if (isBadFindingNarrative(String(next.mismatchExplanation ?? "")) && level !== "compliant" && level !== "not-applicable") {
    set(
      "mismatchExplanation",
      `The procedure for ${sopName} does not explicitly state this requirement: ${requirement}`,
    );
  } else {
    clearIfBad("mismatchExplanation");
  }
  if (isBadFindingNarrative(String(next.evidenceMissing ?? ""))) set("evidenceMissing", requirement);
  for (const key of [
    "evidenceFound",
    "impactAnalysis",
    "highlightedIssue",
    "whyEvidenceInsufficient",
    "whyApplies",
    "whyScoreReduced",
  ]) {
    clearIfBad(key);
  }

  return { finding: next, changed };
}

async function main() {
  loadEnv();
  await connectDB();
  const reports = await ComplianceReport.find({
    $or: [
      { "findings.sopTextSnippet": { $regex: "%PDF-|/Subtype|/DCTDecode|scanned image", $options: "i" } },
      { "findings.suggestedText": { $regex: "%PDF-|/Subtype|/DCTDecode", $options: "i" } },
      { "findings.mismatchExplanation": { $regex: "scanned image|readable procedure", $options: "i" } },
      { "findings.impactAnalysis": { $regex: "scanned image|%PDF-|/DCTDecode", $options: "i" } },
      { "findings.evidenceFound": { $regex: "%PDF-|/Subtype|/DCTDecode", $options: "i" } },
      { "findings.evidenceMissing": { $regex: "scanned image|%PDF-", $options: "i" } },
    ],
  });

  console.log(`Reports to repair: ${reports.length}`);
  let findingsChanged = 0;
  for (const report of reports) {
    let reportChanged = false;
    const findings = (report.findings ?? []).map((finding) => {
      const plain = typeof (finding as { toObject?: () => Record<string, unknown> }).toObject === "function"
        ? (finding as { toObject: () => Record<string, unknown> }).toObject()
        : { ...(finding as unknown as Record<string, unknown>) };
      const repaired = repairFinding(plain, report.sopName || report.sopIdentifier);
      if (repaired.changed) {
        reportChanged = true;
        findingsChanged += 1;
      }
      return repaired.finding;
    });
    if (!reportChanged) continue;
    report.findings = findings as never;
    report.markModified("findings");
    await report.save();
    console.log(`Repaired ${report.sopIdentifier}`);
  }
  console.log(`Updated findings: ${findingsChanged}`);

  const thin = await ComplianceReport.find({
    sopIdentifier: {
      $in: [
        "BSGE01-05",
        "PRAA17-05",
        "PRAA10-04",
        "PRAA06-05",
        "PRAA03-05",
        "PRAA02-05",
        "STGE03-06",
        "STCL05-02",
      ],
    },
  });
  let filled = 0;
  for (const report of thin) {
    let reportChanged = false;
    const findings = (report.findings ?? []).map((finding) => {
      const plain = typeof (finding as { toObject?: () => Record<string, unknown> }).toObject === "function"
        ? (finding as { toObject: () => Record<string, unknown> }).toObject()
        : { ...(finding as unknown as Record<string, unknown>) };
      const level = String(plain.complianceLevel ?? "");
      const suggested = String(plain.suggestedText ?? "").trim();
      if ((level === "partial" || level === "non-compliant") && !suggested) {
        const requirement = requirementOf(plain as { guidelineRequirement?: string; clauseText?: string; clauseTitle?: string });
        plain.suggestedText = `${report.sopName} shall state that ${requirement} Name the responsible person, the record to be completed, and the action if the requirement is not met.`;
        reportChanged = true;
        filled += 1;
      }
      return plain;
    });
    if (!reportChanged) continue;
    report.findings = findings as never;
    report.markModified("findings");
    await report.save();
  }
  console.log(`Filled proposed text on ${filled} findings.`);

  const sample = await ComplianceReport.findOne({ sopIdentifier: "STGE03-06" })
    .select("findings.sopTextSnippet findings.suggestedText findings.suggestedAction findings.mismatchExplanation findings.clauseNumber findings.complianceLevel")
    .lean();
  const picked =
    sample?.findings?.find((f) => /shall state that/.test(f.suggestedText ?? "")) ??
    sample?.findings?.find((f) => f.complianceLevel === "partial" || f.complianceLevel === "non-compliant");
  console.log(
    JSON.stringify(
      {
        clause: picked?.clauseNumber,
        level: picked?.complianceLevel,
        sop: (picked?.sopTextSnippet ?? "").slice(0, 120),
        gap: (picked?.mismatchExplanation ?? "").slice(0, 180),
        action: (picked?.suggestedAction ?? "").slice(0, 160),
        proposed: (picked?.suggestedText ?? "").slice(0, 180),
      },
      null,
      2,
    ),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.stack || err.message : err);
    process.exit(1);
  });
