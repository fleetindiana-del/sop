import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import ComplianceGapFinding from "@/models/ComplianceGapFinding";
import { requireAuth } from "@/lib/withAuth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const sopId = request.nextUrl.searchParams.get("sopId");
    const unresolvedOnly = request.nextUrl.searchParams.get("unresolved") === "true";

    if (!sopId) {
      return NextResponse.json({ success: false, error: "sopId is required" }, { status: 400 });
    }

    const query: Record<string, unknown> = { sopId };
    if (unresolvedOnly) query.resolved = false;

    const findings = await ComplianceGapFinding.find(query)
      .sort({ severity: 1, identifiedAt: -1 })
      .lean();

    const summary = {
      total: findings.length,
      unresolved: findings.filter((f) => !f.resolved).length,
      critical: findings.filter((f) => !f.resolved && f.severity === "critical").length,
      major: findings.filter((f) => !f.resolved && f.severity === "major").length,
      minor: findings.filter((f) => !f.resolved && f.severity === "minor").length,
      improvements: findings.filter(
        (f) => !f.resolved && f.complianceStatus === "improvement-opportunity",
      ).length,
    };

    return NextResponse.json({ success: true, findings, summary });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to fetch gaps" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const { gapId, resolved, resolutionStatus, reviewStatus } = body;

    if (!gapId) {
      return NextResponse.json({ success: false, error: "gapId is required" }, { status: 400 });
    }

    const $set: Record<string, unknown> = { lastReviewedAt: new Date() };

    if (resolved !== undefined) {
      $set.resolved = Boolean(resolved);
      if (resolved) {
        $set.resolvedAt = new Date();
        $set.resolutionStatus = "resolved";
      } else {
        $set.resolutionStatus = "open";
      }
    }

    if (resolutionStatus) $set.resolutionStatus = resolutionStatus;

    if (reviewStatus === "implemented") {
      $set.resolved = true;
      $set.resolvedAt = new Date();
      $set.resolutionStatus = "resolved";
    } else if (reviewStatus === "disputed") {
      $set.resolutionStatus = "needs-manual-review";
    }

    const updated = await ComplianceGapFinding.findOneAndUpdate({ gapId }, { $set }, { returnDocument: 'after' }).lean();

    if (!updated) {
      return NextResponse.json({ success: false, error: "Finding not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, finding: updated });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Update failed" },
      { status: 500 },
    );
  }
}
