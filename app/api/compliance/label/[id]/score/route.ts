import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import LabelComplianceReport from "@/models/LabelComplianceReport";
import { scoreLabelDraft } from "@/lib/label-compliance/analyze";
import { rateLimitLabelApi, requireGeminiConfigured } from "@/lib/label-compliance/http";
import { PRODUCT_CLASSIFICATIONS, type ProductClassification } from "@/lib/label-compliance/types";

export const maxDuration = 120;

function isClassification(value: unknown): value is ProductClassification {
  return typeof value === "string" && (PRODUCT_CLASSIFICATIONS as readonly string[]).includes(value);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const gemini = requireGeminiConfigured();
  if (gemini) return gemini;
  const limited = rateLimitLabelApi(request, "score", 12);
  if (limited) return limited;

  const { id } = await context.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid report id" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    productClassification?: string;
    extractedLabel?: Record<string, unknown>;
  } | null;

  await connectDB();
  const existing = await LabelComplianceReport.findById(id);
  if (!existing) return NextResponse.json({ error: "Report not found" }, { status: 404 });

  const classification = isClassification(body?.productClassification)
    ? body.productClassification
    : existing.productClassification;

  if (body?.extractedLabel && typeof body.extractedLabel === "object") {
    existing.extractedLabel = {
      ...existing.extractedLabel,
      ...body.extractedLabel,
      declarations: {
        ...existing.extractedLabel?.declarations,
        ...(body.extractedLabel.declarations as object | undefined),
      },
    };
  }

  try {
    const scored = await scoreLabelDraft({
      classification,
      extracted: existing.extractedLabel,
      unreadableRegions: existing.unreadableRegions ?? [],
    });

    existing.productClassification = classification;
    existing.classificationConfirmed = true;
    existing.findings = scored.findings;
    existing.score = scored.score;
    existing.complianceStatus = scored.complianceStatus;
    existing.analysisStatus = "completed";
    existing.analyzedAt = new Date();
    if (!existing.versionNumber) existing.versionNumber = 1;
    await existing.save();

    return NextResponse.json({ success: true, report: existing.toObject() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Scoring failed";
    console.error("[label-compliance:score]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
