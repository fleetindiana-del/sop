import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import LabelComplianceReport from "@/models/LabelComplianceReport";
import { isGapLifecycle } from "@/lib/label-compliance/analyze";
import { rateLimitLabelApi } from "@/lib/label-compliance/http";
import {
  PRODUCT_CLASSIFICATIONS,
  type ExtractedLabel,
  type GapLifecycleStatus,
  type ProductClassification,
} from "@/lib/label-compliance/types";

export const maxDuration = 60;

function isClassification(value: unknown): value is ProductClassification {
  return typeof value === "string" && (PRODUCT_CLASSIFICATIONS as readonly string[]).includes(value);
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid report id" }, { status: 400 });
  }

  await connectDB();
  const report = await LabelComplianceReport.findById(id).lean();
  if (!report) return NextResponse.json({ error: "Report not found" }, { status: 404 });
  return NextResponse.json({ success: true, report });
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const limited = rateLimitLabelApi(request, "patch", 40);
  if (limited) return limited;

  const { id } = await context.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid report id" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as {
    findingId?: string;
    lifecycle?: string;
    productClassification?: string;
    classificationConfirmed?: boolean;
    extractedLabel?: ExtractedLabel;
    productName?: string;
    brandName?: string;
  } | null;

  if (!body) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  await connectDB();

  if (body.findingId && isGapLifecycle(body.lifecycle)) {
    const lifecycle: GapLifecycleStatus = body.lifecycle;
    const updated = await LabelComplianceReport.findOneAndUpdate(
      { _id: id, "findings.findingId": body.findingId },
      { $set: { "findings.$.lifecycle": lifecycle } },
      { new: true },
    ).lean();
    if (!updated) return NextResponse.json({ error: "Finding not found" }, { status: 404 });
    return NextResponse.json({ success: true, report: updated });
  }

  const $set: Record<string, unknown> = {};
  if (isClassification(body.productClassification)) {
    $set.productClassification = body.productClassification;
    $set.classificationOverride = body.productClassification;
  }
  if (typeof body.classificationConfirmed === "boolean") {
    $set.classificationConfirmed = body.classificationConfirmed;
  }
  if (body.extractedLabel && typeof body.extractedLabel === "object") {
    $set.extractedLabel = body.extractedLabel;
    if (body.extractedLabel.productName) $set.productName = body.extractedLabel.productName;
    if (body.extractedLabel.brandName) $set.brandName = body.extractedLabel.brandName;
  }
  if (typeof body.productName === "string" && body.productName.trim()) {
    $set.productName = body.productName.trim();
  }
  if (typeof body.brandName === "string") {
    $set.brandName = body.brandName.trim();
  }

  if (!Object.keys($set).length) {
    return NextResponse.json({ error: "No updates provided" }, { status: 400 });
  }

  const updated = await LabelComplianceReport.findByIdAndUpdate(id, { $set }, { new: true }).lean();
  if (!updated) return NextResponse.json({ error: "Report not found" }, { status: 404 });
  return NextResponse.json({ success: true, report: updated });
}
