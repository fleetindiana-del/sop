import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import LabelComplianceReport from "@/models/LabelComplianceReport";
import { extractLabelDraft, parseLabelUploads } from "@/lib/label-compliance/analyze";
import {
  parseRequestedIds,
  rateLimitLabelApi,
  requireGeminiConfigured,
} from "@/lib/label-compliance/http";

export const maxDuration = 120;

export async function GET(request: NextRequest) {
  const ids = parseRequestedIds(request.nextUrl.searchParams.get("ids"));
  if (!ids.length) {
    return NextResponse.json({ success: true, reports: [] });
  }

  const objectIds = ids
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!objectIds.length) {
    return NextResponse.json({ success: true, reports: [] });
  }

  await connectDB();
  const reports = await LabelComplianceReport.find({ _id: { $in: objectIds } })
    .select(
      "productName brandName productClassification classificationConfidence classificationConfirmed score complianceStatus analysisStatus assets versionNumber latestComparison analyzedAt lastRecheckAt",
    )
    .sort({ analyzedAt: -1 })
    .lean();

  return NextResponse.json({ success: true, reports });
}

export async function POST(request: NextRequest) {
  const gemini = requireGeminiConfigured();
  if (gemini) return gemini;
  const limited = rateLimitLabelApi(request, "extract", 8);
  if (limited) return limited;

  try {
    const form = await request.formData();
    const images = await parseLabelUploads(form);
    if (!images.length) {
      return NextResponse.json(
        { error: "Upload at least one label panel (front, back, side) or a complete PDF." },
        { status: 400 },
      );
    }

    const productNameHint = String(form.get("productName") ?? "").trim();
    const brandHint = String(form.get("brandName") ?? "").trim();
    const notes = String(form.get("notes") ?? "").trim();

    const draft = await extractLabelDraft({
      images,
      productNameHint: productNameHint || undefined,
      brandHint: brandHint || undefined,
    });

    await connectDB();
    const created = await LabelComplianceReport.create({
      ...draft,
      notes: notes || undefined,
      createdBy: "public",
    });

    return NextResponse.json({ success: true, report: created.toObject() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Label extraction failed";
    console.error("[label-compliance:extract]", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
