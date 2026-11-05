/**
 * Replace one-line boilerplate on gap findings with clause-specific procedure text.
 *   npx tsx scripts/write-finding-detail.ts
 */
import fs from "fs";
import { connectDB } from "@/lib/mongodb";
import ComplianceReport from "@/models/ComplianceReport";

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

const THIN_RE =
  /shall state that|text-controlled procedure that states the missing control|no readable procedure|does not explicitly state this requirement|scanned image|name the responsible person, the record to be completed|the procedure shall require that/i;

function isThin(text?: string): boolean {
  if (!text?.trim()) return true;
  return THIN_RE.test(text);
}

function requirementText(finding: {
  guidelineRequirement?: string;
  clauseText?: string;
  clauseTitle?: string;
  clauseNumber?: string;
}): string {
  const candidates = [finding.clauseText, finding.guidelineRequirement, finding.clauseTitle]
    .map((value) => (value ?? "").replace(/\s+/g, " ").trim())
    .filter((value) => value.length > 20 && !THIN_RE.test(value));
  candidates.sort((a, b) => b.length - a.length);
  const text = candidates[0] || finding.clauseTitle || "this requirement";
  return text.length > 900 ? `${text.slice(0, 897)}...` : text;
}

function obligations(requirement: string, clauseNumber: string): string[] {
  const body = requirement
    .replace(new RegExp(`^${clauseNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`), "")
    .replace(/\be\.\s*g\./gi, "for example")
    .replace(/\bi\.\s*e\./gi, "that is")
    .replace(/\bshould\b/gi, "shall")
    .replace(/\bmust\b/gi, "shall");
  const parts = body
    .split(/(?<=\.)\s+|(?:\s(?=\([a-z]\)\s))|(?:\s(?=\(\d+\)\s))/)
    .map((part) => part.replace(/\s+/g, " ").replace(/^[a-z]\)\s*/i, "").replace(/^\(\d+\)\s*/, "").trim())
    .filter((part) => part.length > 20);
  return (parts.length ? parts : [body]).slice(0, 8);
}

function writeDetail(
  finding: {
    clauseNumber?: string;
    clauseTitle?: string;
    guidelineName?: string;
    sopSectionAffected?: string;
    whyApplies?: string;
    complianceLevel?: string;
    guidelineRequirement?: string;
    clauseText?: string;
  },
  sopName: string,
) {
  const clause = finding.clauseNumber || "";
  const title = (finding.clauseTitle || "this control").replace(/\s+/g, " ").trim();
  const guide = finding.guidelineName || "the guideline";
  const section = (finding.sopSectionAffected || "Procedure").replace(/\s+/g, " ").trim();
  const points = obligations(requirementText(finding), clause);
  const heading = (points[0] || title).replace(/\.$/, "");
  const level = finding.complianceLevel;

  const steps = points
    .map((point) => point.replace(/[.;]+$/, ""))
    .map((point) => (/[:;]$/.test(point) || point.endsWith(".") ? point : `${point}.`))
    .join(" ");

  const suggestedText = [
    `${section} — ${heading}.`,
    `Staff who carry out ${sopName} shall follow these steps.`,
    steps,
    `Record the date, the material or batch identity, the result, and the name of the person who did the work in the log for this activity.`,
    `If a step cannot be completed, stop the work, tell the department head, and write down what failed before the activity starts again.`,
    `Do not give this step to a person who has not been trained on it.`,
  ].join(" ");

  const missing = points.join(" ");
  const keepWhy = finding.whyApplies && !isThin(finding.whyApplies) ? finding.whyApplies : "";

  return {
    evidenceFound:
      level === "partial"
        ? `${sopName} addresses part of this activity. It does not yet include every obligation in ${guide} clause ${clause}.`
        : `${sopName} is the procedure for this activity. It does not include the obligations in ${guide} clause ${clause}.`,
    evidenceMissing: missing,
    mismatchExplanation: `${guide} clause ${clause} is not written into the procedure. The missing controls are: ${missing}`,
    whyApplies:
      keepWhy ||
      `${sopName} is the procedure that performs this work, so ${guide} clause ${clause} applies. The clause requires that ${title.replace(/\.$/, "").charAt(0).toLowerCase()}${title.replace(/\.$/, "").slice(1)}.`,
    whyEvidenceInsufficient: `The procedure does not state these controls from clause ${clause}: ${points[0]?.replace(/\.$/, "")}.`,
    whyScoreReduced:
      level === "partial"
        ? `Partial credit for clause ${clause}. The activity sits in this SOP, but the clause is only partly written into the procedure.`
        : `No credit for clause ${clause}. The procedure does not contain the controls the clause requires.`,
    suggestedAction: `In the ${section} section, write that ${heading.charAt(0).toLowerCase()}${heading.slice(1)}, and record who checked it.`,
    suggestedText,
  };
}

async function main() {
  loadEnv();
  await connectDB();
  const reports = await ComplianceReport.find({
    sopIdentifier: {
      $in: ["PRAA17-05", "PRAA10-04", "PRAA06-05", "PRAA03-05", "PRAA02-05", "STGE03-06", "STCL05-02"],
    },
  });

  console.log(`Reports with thin findings: ${reports.length}`);
  let updated = 0;
  for (const report of reports) {
    let changed = false;
    const findings = (report.findings ?? []).map((finding) => {
      const plain = typeof (finding as { toObject?: () => Record<string, unknown> }).toObject === "function"
        ? (finding as { toObject: () => Record<string, unknown> }).toObject()
        : { ...(finding as unknown as Record<string, unknown>) };
      const level = String(plain.complianceLevel ?? "");
      if (level !== "partial" && level !== "non-compliant") return plain;
      const detail = writeDetail(plain as never, report.sopName || report.sopIdentifier);
      Object.assign(plain, detail);
      changed = true;
      updated += 1;
      return plain;
    });
    if (!changed) continue;
    report.findings = findings as never;
    report.markModified("findings");
    await report.save();
    console.log(`Wrote ${report.sopIdentifier}`);
  }
  console.log(`Findings rewritten: ${updated}`);

  const sample = await ComplianceReport.findOne({ sopIdentifier: "STGE03-06" })
    .select("findings")
    .lean();
  const picked = sample?.findings?.find((f) => f.clauseNumber === "14.13") ?? sample?.findings?.find((f) => f.complianceLevel === "partial");
  console.log(
    JSON.stringify(
      {
        clause: picked?.clauseNumber,
        gap: picked?.mismatchExplanation,
        action: picked?.suggestedAction,
        proposed: picked?.suggestedText,
        found: picked?.evidenceFound,
        missing: (picked?.evidenceMissing ?? "").slice(0, 400),
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
