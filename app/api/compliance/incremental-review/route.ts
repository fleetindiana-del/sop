import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import ComplianceGapFinding from "@/models/ComplianceGapFinding";
import { runIncrementalComplianceReview } from "@/lib/compliance-incremental";
import { requireAuth } from "@/lib/withAuth";
import { getComplianceProvider, type LlmProvider } from "@/lib/llm";
import { withActivityLog } from "@/lib/activity-log";

export const maxDuration = 300;

/** Stage 3 — incremental revalidation of unresolved findings only. */
async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const { sopId } = body;
    const p = body.provider as string | undefined;
    const providerOverride: LlmProvider | undefined =
      p === "claude" ? "claude" : p === "codex" ? "codex" : p === "ollama" ? "ollama" : p === "gemini" ? "gemini" : undefined;

    if (!sopId) {
      return NextResponse.json({ success: false, error: "sopId is required" }, { status: 400 });
    }

    const sop = await SOP.findById(sopId).lean();
    if (!sop) {
      return NextResponse.json({ success: false, error: "SOP not found" }, { status: 404 });
    }

    const unresolved = await ComplianceGapFinding.countDocuments({ sopId, resolved: false });
    if (unresolved === 0) {
      return NextResponse.json({
        success: true,
        message: "No unresolved findings to review",
        reviewed: 0,
        skipped: 0,
      });
    }

    const result = await runIncrementalComplianceReview(sop, {
      provider: providerOverride ?? getComplianceProvider(),
      previousStructure: sop.complianceStructureCache?.sectionHashes,
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Incremental review failed" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
