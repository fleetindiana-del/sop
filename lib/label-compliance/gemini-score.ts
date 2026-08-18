import { generateGeminiComplianceJson } from "@/lib/gemini-client";
import { rulesForClassification } from "./fssai-rules";
import type { VisionFinding } from "./extract-label";
import type { ExtractedLabel, ProductClassification, UnreadableRegion } from "./types";

/**
 * Text-only Gemini agent: apply FSSAI rules to already-extracted label data.
 * Images are not re-sent; this keeps the free-tier quota on the vision pass.
 */
export async function geminiApplyFssaiRules(opts: {
  classification: ProductClassification;
  extracted: ExtractedLabel;
  unreadableRegions: UnreadableRegion[];
}): Promise<VisionFinding[]> {
  const rules = rulesForClassification(opts.classification);
  const ruleLines = rules.map((r) => `- ${r.id} [${r.severity}] ${r.title}: ${r.check}`).join("\n");

  const system = `You are Gemini acting as an FSSAI label-compliance agent for India.
Score only from the extracted text. If a section was unreadable, status must be "review" — never fail or pass by guessing.
JSON only.`;

  const user = `Product classification (human-confirmed): ${opts.classification}

Extracted label JSON:
${JSON.stringify(opts.extracted, null, 2)}

Unreadable regions (do not invent these fields):
${JSON.stringify(opts.unreadableRegions, null, 2)}

Evaluate these rules:
${ruleLines}

Return:
{
  "findings": [
    {
      "ruleId": "FSSAI-…",
      "status": "pass" | "fail" | "review",
      "severity": "critical" | "high" | "medium" | "low",
      "evidenceFace": "front" | "back" | "side" | "pdf" | "unknown",
      "evidence": "quote or why it is missing/unreadable",
      "claim": "only for claim rules",
      "recommendation": "concrete label wording to add or change"
    }
  ]
}

For FSSAI-CLAIM-001/002/003 emit one finding per distinct claim in extracted.claims.
If extracted.claims is empty, still check OCR text for implied disease claims.`;

  const payload = await generateGeminiComplianceJson<{ findings?: VisionFinding[] }>(system, user);
  return Array.isArray(payload.findings) ? payload.findings : [];
}
