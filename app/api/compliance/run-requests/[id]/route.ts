import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import { isComplianceOperator } from "@/lib/page-access";
import ComplianceRunRequest from "@/models/ComplianceRunRequest";
import ComplianceReport from "@/models/ComplianceReport";
import { toRequestDto, type CompactFinding } from "@/lib/complianceRunRequests";

export const dynamic = "force-dynamic";

type FindingRow = {
  clauseNumber?: string;
  clauseTitle?: string;
  complianceLevel?: string;
  issueSeverity?: string;
  mismatchExplanation?: string;
  suggestedAction?: string;
};

function canAccessRequest(
  userId: string,
  requesterId: string,
  role: string,
  pageAccess: string[] | undefined,
) {
  if (userId === requesterId) return true;
  return isComplianceOperator(role, pageAccess);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid request id" }, { status: 400 });
    }

    const doc = await ComplianceRunRequest.findById(id).lean();
    if (!doc) {
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }

    const requesterId = String(doc.requesterId);
    if (
      !canAccessRequest(
        auth.session.user.id,
        requesterId,
        auth.session.user.role,
        auth.session.user.pageAccess,
      )
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const dto = toRequestDto(doc);
    const canOpenEngine = isComplianceOperator(
      auth.session.user.role,
      auth.session.user.pageAccess,
    );

    let findings: CompactFinding[] = [];
    if (doc.reportId) {
      const report = await ComplianceReport.findById(doc.reportId)
        .select(
          "overallScore complianceStatus analyzedAt compliantCount partialCount nonCompliantCount findings",
        )
        .lean();
      if (report?.findings?.length) {
        findings = (report.findings as FindingRow[])
          .filter(
            (f) =>
              f.complianceLevel === "partial" || f.complianceLevel === "non-compliant",
          )
          .slice(0, 20)
          .map((f) => ({
            clauseNumber: f.clauseNumber ?? "",
            clauseTitle: f.clauseTitle ?? "",
            complianceLevel: f.complianceLevel ?? "",
            issueSeverity: f.issueSeverity,
            mismatchExplanation: f.mismatchExplanation,
            suggestedAction: f.suggestedAction,
          }));
      }
    }

    return NextResponse.json({
      success: true,
      request: dto,
      findings,
      canOpenEngine,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load request" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid request id" }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body.action || "").trim();
    const doc = await ComplianceRunRequest.findById(id);
    if (!doc) {
      return NextResponse.json({ error: "Request not found" }, { status: 404 });
    }

    const operator = isComplianceOperator(
      auth.session.user.role,
      auth.session.user.pageAccess,
    );
    const isRequester = String(doc.requesterId) === auth.session.user.id;

    if (action === "cancel") {
      if (!isRequester && !operator) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (doc.status === "completed") {
        return NextResponse.json({ error: "Completed requests cannot be cancelled" }, { status: 400 });
      }
      if (doc.status === "cancelled") {
        return NextResponse.json({ success: true, request: toRequestDto(doc) });
      }
      doc.status = "cancelled";
      doc.cancelledAt = new Date();
      await doc.save();
      return NextResponse.json({ success: true, request: toRequestDto(doc) });
    }

    if (action === "acknowledge") {
      if (!operator) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      if (doc.status === "pending") {
        doc.status = "in_progress";
        await doc.save();
      }
      return NextResponse.json({ success: true, request: toRequestDto(doc) });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update request" },
      { status: 500 },
    );
  }
}
