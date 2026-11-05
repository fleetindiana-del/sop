import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { applyDocxTextFix } from "@/lib/compliance-docx-patch";
import { loadWordDocumentBuffer } from "@/lib/loadStoredFileBuffer";
import { requireAuth } from "@/lib/withAuth";
import { withActivityLog } from "@/lib/activity-log";

export const maxDuration = 60;

/**
 * POST /api/compliance/draft-fix
 * Applies the proposed fix to the SOP DOCX in memory and returns the patched
 * file as a download — nothing is saved to the database or CDN.
 */
async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  await connectDB();

  const body = await request.json() as {
    sopId?: string;
    originalText?: string;
    replacementText?: string;
  };

  const { sopId, originalText = "", replacementText = "" } = body;

  if (!sopId) {
    return NextResponse.json({ error: "sopId is required" }, { status: 400 });
  }
  if (!originalText.trim() || !replacementText.trim()) {
    return NextResponse.json(
      { error: "originalText and replacementText are required" },
      { status: 400 },
    );
  }

  const sop = await SOP.findById(sopId)
    .select("name identifier fileUrl fileType language")
    .lean();
  if (!sop) {
    return NextResponse.json({ error: "SOP not found" }, { status: 404 });
  }

  if (sop.fileType !== "docx") {
    return NextResponse.json(
      { error: "Preview download is only supported for DOCX SOPs." },
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

  const patchResult = await applyDocxTextFix(docxBuffer, originalText, replacementText);

  const safeName = `${sop.identifier}_${sop.name}`
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);

  // Return the patched buffer if successful, otherwise the original so the
  // UI can still render a preview (with a warning banner).
  const outBuffer = patchResult.success && patchResult.buffer
    ? patchResult.buffer
    : docxBuffer;
  const filename = patchResult.success ? `DRAFT_${safeName}.docx` : `ORIGINAL_${safeName}.docx`;

  return new NextResponse(outBuffer as unknown as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Patch-Applied": patchResult.success ? "true" : "false",
    },
  });
}

export const POST = withActivityLog(handlePOST);
