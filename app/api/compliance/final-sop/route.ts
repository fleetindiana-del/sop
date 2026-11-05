import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { applyDocxTextFix } from "@/lib/compliance-docx-patch";
import { loadWordDocumentBuffer } from "@/lib/loadStoredFileBuffer";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

export const maxDuration = 120;

export interface FinalSopFix {
  originalText: string;
  replacementText: string;
  clauseTitle?: string;
  section?: string;
}

/**
 * POST /api/compliance/final-sop
 * Applies ALL provided fixes to the SOP DOCX in memory (sequentially) and
 * returns the fully-patched document as a download. Nothing is saved.
 */
async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  await connectDB();

  const body = await request.json() as {
    sopId?: string;
    fixes?: FinalSopFix[];
  };

  const { sopId, fixes = [] } = body;

  if (!sopId) {
    return NextResponse.json({ error: "sopId is required" }, { status: 400 });
  }
  if (!fixes.length) {
    return NextResponse.json({ error: "No fixes provided" }, { status: 400 });
  }

  const sop = await SOP.findById(sopId)
    .select("name identifier fileUrl fileType language")
    .lean();

  if (!sop) {
    return NextResponse.json({ error: "SOP not found" }, { status: 404 });
  }
  if (sop.fileType !== "docx") {
    return NextResponse.json(
      { error: "Final SOP export is only supported for DOCX files." },
      { status: 422 },
    );
  }

  const docxBuffer = await loadWordDocumentBuffer(
    sop.fileUrl,
    sop.identifier,
    sop.language,
  );

  if (!docxBuffer) {
    return NextResponse.json(
      { error: "Could not load source DOCX. Please ensure the file is accessible." },
      { status: 422 },
    );
  }

  // Apply fixes sequentially — each pass uses the output of the previous
  let current = docxBuffer;
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const fix of fixes) {
    if (!fix.originalText?.trim() || !fix.replacementText?.trim()) continue;

    const result = await applyDocxTextFix(current, fix.originalText, fix.replacementText);
    if (result.success && result.buffer) {
      current = result.buffer;
      applied.push(fix.clauseTitle ?? fix.originalText.slice(0, 60));
    } else {
      skipped.push(fix.clauseTitle ?? fix.originalText.slice(0, 60));
    }
  }

  if (!applied.length) {
    return NextResponse.json(
      { error: "None of the suggested fixes could be applied — original text may not match the document exactly.", skipped },
      { status: 422 },
    );
  }

  const safeName = `${sop.identifier}_${sop.name}`
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
  const filename = `FINAL_SOP_${safeName}.docx`;

  return new NextResponse(current as unknown as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Applied-Count": String(applied.length),
      "X-Skipped-Count": String(skipped.length),
    },
  });
}

export const POST = withActivityLog(handlePOST);
