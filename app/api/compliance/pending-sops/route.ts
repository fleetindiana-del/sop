import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import ComplianceReport from "@/models/ComplianceReport";
import { getGroupedRegistryRows } from "@/lib/dashboardRegistrySource";
import { normalizeSopIdentifierKey } from "@/lib/sopIdentifierNormalize";
import { sortByDeptOrder } from "@/lib/sop-utils";
import { requireAuth } from "@/lib/withAuth";

/**
 * Active SOPs that have never completed a compliance run — the backlog for a
 * "run everything still pending" sweep. A report is matched to a registry row by
 * Mongo id OR by normalized identifier (so a revised SOP whose revision moved on
 * counts as pending again).
 *
 * `?department=` scopes the backlog to one department; `?countOnly=1` skips the
 * row payload for the badge on the SOP step.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();

    const department = request.nextUrl.searchParams.get("department");
    const countOnly = request.nextUrl.searchParams.get("countOnly") === "1";

    const grouped = await getGroupedRegistryRows();
    const active = grouped.filter((s) => !s.isObsolete);
    const scoped =
      department && department !== "all"
        ? active.filter((s) => s.department === department)
        : active;

    const analyzed = await ComplianceReport.find({ analysisStatus: "completed" })
      .select("sopId sopIdentifier")
      .lean();

    const analyzedKeys = new Set<string>();
    for (const r of analyzed) {
      if (r.sopId) analyzedKeys.add(`id:${String(r.sopId)}`);
      const key = normalizeSopIdentifierKey(r.sopIdentifier ?? "");
      if (key) analyzedKeys.add(`code:${key}`);
    }

    const pending = scoped.filter(
      (s) =>
        !analyzedKeys.has(`id:${String(s.id)}`) &&
        !analyzedKeys.has(`code:${normalizeSopIdentifierKey(s.identifier ?? "")}`),
    );

    return NextResponse.json({
      success: true,
      total: pending.length,
      scanned: scoped.length,
      analyzed: scoped.length - pending.length,
      departments: sortByDeptOrder([
        ...new Set(pending.map((s) => s.department).filter(Boolean)),
      ]),
      sops: countOnly
        ? []
        : pending.map((s) => ({
            _id: s.id,
            identifier: s.identifier,
            name: s.name,
            department: s.department,
            version: s.version ?? "1.0",
            language: s.language ?? "English",
            location: s.location ?? "",
          })),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to resolve pending SOPs",
      },
      { status: 500 },
    );
  }
}
