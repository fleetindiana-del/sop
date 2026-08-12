import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOPGuideline from "@/models/SOPGuideline";
import { requireAuth } from "@/lib/withAuth";

const DEFAULT_FOLDERS = ["ICH Guidelines", "WHO GMP", "FDA CFR", "Schedule M"];

export async function GET() {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();

    const agg = await SOPGuideline.aggregate([
      {
        $group: {
          _id: "$folderName",
          guidelineCount: { $sum: 1 },
          totalClauses: { $sum: { $size: "$clauses" } },
          lastUpdated: { $max: "$updatedAt" },
        },
      },
      {
        $project: {
          _id: 0,
          folderName: "$_id",
          guidelineCount: 1,
          totalClauses: 1,
          lastUpdated: 1,
        },
      },
      { $sort: { folderName: 1 } },
    ]);

    // Merge in default empty folders that haven't been populated yet
    const existingNames = new Set(agg.map((f) => f.folderName));
    for (const name of DEFAULT_FOLDERS) {
      if (!existingNames.has(name)) {
        agg.push({ folderName: name, guidelineCount: 0, totalClauses: 0, lastUpdated: null });
      }
    }
    agg.sort((a, b) => a.folderName.localeCompare(b.folderName));

    const totalGuidelines = agg.reduce((s, f) => s + f.guidelineCount, 0);
    const totalClauses = agg.reduce((s, f) => s + f.totalClauses, 0);

    return NextResponse.json({ success: true, folders: agg, totalGuidelines, totalClauses });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  const folderName = request.nextUrl.searchParams.get("folderName");
  if (!folderName) return NextResponse.json({ error: "folderName is required" }, { status: 400 });

  try {
    await connectDB();
    const result = await SOPGuideline.deleteMany({ folderName });
    return NextResponse.json({
      success: true,
      message: `Deleted ${result.deletedCount} guideline(s) from "${folderName}"`,
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
