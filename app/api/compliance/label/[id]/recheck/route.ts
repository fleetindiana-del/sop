import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import LabelComplianceReport from "@/models/LabelComplianceReport";
import {
  extractLabelDraft,
  parseLabelUploads,
  scoreLabelDraft,
  snapshotFromReport,
  buildVersionComparison,
} from "@/lib/label-compliance/analyze";
import { rateLimitLabelApi, requireGeminiConfigured } from "@/lib/label-compliance/http";

export const maxDuration = 180;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const gemini = requireGeminiConfigured();
  if (gemini) return gemini;
  const limited = rateLimitLabelApi(request, "recheck", 8);
  if (limited) return limited;

  const { id } = await context.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid report id" }, { status: 400 });
  }

  await connectDB();
  const existing = await LabelComplianceReport.findById(id);
  if (!existing) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  try {
    const form = await request.formData();
    const images = await parseLabelUploads(form);
    if (!images.length) {
      return NextResponse.json(
        { error: "Re-upload at least one revised label panel (or PDF) to compare versions." },
        { status: 400 },
      );
    }

    const previousSnapshot = snapshotFromReport({
      versionNumber: existing.versionNumber,
      score: existing.score,
      complianceStatus: existing.complianceStatus,
      findings: existing.findings,
      analyzedAt: existing.analyzedAt,
    });

    const draft = await extractLabelDraft({
      images,
      productNameHint: existing.productName,
      brandHint: existing.brandName,
    });

    const scored = await scoreLabelDraft({
      classification: existing.productClassification,
      extracted: draft.extractedLabel,
      unreadableRegions: draft.unreadableRegions,
      previousFindings: existing.findings,
    });

    const nextVersion = (existing.versionNumber || 1) + 1;
    const comparison = buildVersionComparison(
      { versionNumber: existing.versionNumber, score: existing.score, findings: existing.findings },
      { versionNumber: nextVersion, score: scored.score, findings: scored.findings },
    );

    existing.versions = [...(existing.versions ?? []), previousSnapshot];
    existing.versionNumber = nextVersion;
    existing.latestComparison = comparison;
    existing.productName = draft.productName || existing.productName;
    existing.brandName = draft.brandName || existing.brandName;
    existing.assets = draft.assets;
    existing.previews = draft.previews;
    existing.extractedLabel = draft.extractedLabel;
    existing.unreadableRegions = draft.unreadableRegions;
    existing.readability = draft.readability;
    existing.findings = scored.findings;
    existing.score = scored.score;
    existing.complianceStatus = scored.complianceStatus;
    existing.analysisStatus = "completed";
    existing.modelNotes = draft.modelNotes;
    existing.analyzedAt = new Date();
    existing.lastRecheckAt = new Date();
    await existing.save();

    return NextResponse.json({ success: true, report: existing.toObject() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Recheck failed";
    console.error("[label-compliance:recheck]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
