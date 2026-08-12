import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SopFilesImportJob from "@/models/SopFilesImportJob";
import { getFilesImportDir, parseImportScopes, startFilesImportJob } from "@/lib/sop-files-import";
import { findAnnexureParentSop } from "@/lib/sop-annexure";
import { requireAuth } from "@/lib/withAuth";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  let body: { scopes?: unknown; parentIdentifier?: string } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body → all scopes */
  }

  const scopes = parseImportScopes(body.scopes);
  if (!scopes) {
    return NextResponse.json(
      { error: "Invalid scopes — use main, annexure, and/or prior" },
      { status: 400 },
    );
  }

  const parentIdentifier = body.parentIdentifier?.trim() || undefined;

  try {
    await connectDB();

    if (scopes.includes("annexure") && parentIdentifier) {
      const parent = await findAnnexureParentSop(parentIdentifier);
      if (!parent) {
        return NextResponse.json(
          {
            error: `Parent SOP ${parentIdentifier} not found in database — import the main SOP first`,
          },
          { status: 400 },
        );
      }
    }

    const running = await SopFilesImportJob.findOne({ status: { $in: ["queued", "running"] } });
    if (running) {
      return NextResponse.json(
        { error: "An import is already in progress", jobId: running._id.toString() },
        { status: 409 },
      );
    }

    const job = await SopFilesImportJob.create({
      status: "queued",
      phase: "Queued",
      percent: 0,
      scopes,
      parentIdentifier,
      totals: {
        scanned: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        annexures: 0,
        obsoleteRouted: 0,
        priorRelocated: 0,
      },
      files: [],
      startedAt: new Date(),
    });

    startFilesImportJob(job._id.toString());

    return NextResponse.json({
      jobId: job._id.toString(),
      importDir: getFilesImportDir(),
      scopes,
    });
  } catch (error) {
    console.error("files-import run error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to start import" },
      { status: 500 },
    );
  }
}
