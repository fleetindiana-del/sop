import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/withAuth";
import { checkCodexCliHealth, getComplianceCodexModel, getMcqCodexModel } from "@/lib/codex-cli";
import { enqueueMcqGeneration } from "@/lib/mcq-generation";
import {
  resolveSopIdsForIdentifiers,
  triggerComplianceV3Async,
} from "@/lib/start-compliance-v3-async";
import { getExistingComplianceScore } from "@/lib/compliance-score-lookup";

const CODEX_UNAVAILABLE_MESSAGE =
  "No Codex available. Please use your local computer where Codex is available and run MCQ generation and compliance manually.";

/**
 * After SOP upload/import: if Codex is logged in, enqueue Codex MCQ generation
 * and start full (all-guidelines) V3 compliance in the background.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  let body: { identifiers?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const identifiers = Array.isArray(body.identifiers)
    ? [...new Set(body.identifiers.map((v) => String(v).trim()).filter(Boolean))]
    : [];

  if (!identifiers.length) {
    return NextResponse.json({ error: "identifiers required" }, { status: 400 });
  }

  const health = await checkCodexCliHealth();
  if (!health.ok || !health.loggedIn) {
    return NextResponse.json(
      {
        success: false,
        codexAvailable: false,
        error: CODEX_UNAVAILABLE_MESSAGE,
        codex: health,
      },
      { status: 503 },
    );
  }

  const resolved = await resolveSopIdsForIdentifiers(identifiers);
  if (!resolved.length) {
    return NextResponse.json({ error: "No matching SOP records found" }, { status: 404 });
  }

  const mcq: Array<{ identifier: string; status: string; alreadyRunning?: boolean }> = [];
  for (const { identifier } of resolved) {
    try {
      const job = await enqueueMcqGeneration(identifier, "codex");
      mcq.push({
        identifier: job.identifier,
        status: job.status,
        alreadyRunning: job.alreadyRunning,
      });
    } catch (err) {
      mcq.push({
        identifier,
        status: "failed",
      });
      console.error(`[post-upload-pipeline] MCQ enqueue failed for ${identifier}:`, err);
    }
  }

  const complianceSkipped: string[] = [];
  for (const { sopId, identifier } of resolved) {
    const existing = await getExistingComplianceScore(sopId, identifier);
    if (existing && existing.score >= 8 && !existing.bypassed) {
      console.log(
        `[post-upload-pipeline] compliance skipped for ${identifier} — existing score ${existing.score}/10`,
      );
      complianceSkipped.push(identifier);
      continue;
    }
    triggerComplianceV3Async({
      sopId,
      provider: "codex",
      model: getComplianceCodexModel(),
      includeAnnexures: true,
      maxClauses: 200,
    });
    console.log(`[post-upload-pipeline] compliance V3 queued for ${identifier}`);
  }

  return NextResponse.json(
    {
      success: true,
      codexAvailable: true,
      mcqModel: getMcqCodexModel(),
      complianceModel: getComplianceCodexModel(),
      complianceEngine: "v3",
      started: resolved.map((r) => r.identifier),
      mcq,
      compliance: "started",
      complianceSkipped,
    },
    { status: 202 },
  );
}
