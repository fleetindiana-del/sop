import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import ComplianceGapFinding from "@/models/ComplianceGapFinding";
import ComplianceReport from "@/models/ComplianceReport";
import {
  applyDocxTextFix,
  applyTextContentFix,
} from "@/lib/compliance-docx-patch";
import { runIncrementalComplianceReview } from "@/lib/compliance-incremental";
import { buildAndSaveComplianceStructureCache } from "@/lib/compliance-sop-cache";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { loadWordDocumentBuffer } from "@/lib/loadStoredFileBuffer";
import { requireAuth } from "@/lib/withAuth";
import { uploadToBunny } from "@/lib/bunnyStorage";
import { extractTextFromBuffer } from "@/lib/extractContent";
import { withActivityLog } from "@/lib/activity-log";

export const maxDuration = 120;

/** One-click fix — patch only the relevant SOP text/DOCX section. */
async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const { gapId, sopId, originalText, replacementText } = body as {
      gapId?: string;
      sopId?: string;
      originalText?: string;
      replacementText?: string;
    };

    if (!gapId || !sopId) {
      return NextResponse.json(
        { success: false, error: "gapId and sopId are required" },
        { status: 400 },
      );
    }

    const gap = await ComplianceGapFinding.findOne({ gapId, sopId }).lean();
    if (!gap) {
      return NextResponse.json({ success: false, error: "Finding not found" }, { status: 404 });
    }

    const sop = await SOP.findById(sopId);
    if (!sop) {
      return NextResponse.json({ success: false, error: "SOP not found" }, { status: 404 });
    }

    const orig = (originalText || gap.sopSectionText || gap.evidenceSopQuote || "").trim();
    const repl = (replacementText || gap.proposedVerbiage || "").trim();

    if (!orig || !repl) {
      return NextResponse.json(
        { success: false, error: "originalText and replacementText are required" },
        { status: 400 },
      );
    }

    let docxBuffer: Buffer | null = null;
    let docxPatchResult = null;

    if (sop.fileType === "docx") {
      docxBuffer = await loadWordDocumentBuffer(sop.fileUrl, sop.identifier, sop.language);
      if (docxBuffer) {
        docxPatchResult = await applyDocxTextFix(docxBuffer, orig, repl);
      }
    }

    const textFix = applyTextContentFix(sop.content, orig, repl);
    if (!textFix.replaced && !(docxPatchResult?.success)) {
      return NextResponse.json(
        {
          success: false,
          error: "Could not locate original text in SOP content or DOCX",
          originalText: orig,
          modifiedText: repl,
        },
        { status: 422 },
      );
    }

    sop.content = textFix.replaced ? textFix.content : sop.content;
    sop.processedAt = new Date();

    if (docxPatchResult?.success && docxPatchResult.buffer && sop.fileUrl) {
      const destPath = sop.fileUrl
        .replace(/^https?:\/\/[^/]+\//, "")
        .replace(/^bunny:\/\//, "")
        .replace(/^\//, "");
      const uploaded = await uploadToBunny(docxPatchResult.buffer, destPath);
      if (uploaded && docxPatchResult.buffer) {
        const extracted = await extractTextFromBuffer(docxPatchResult.buffer, "docx");
        if (extracted && extracted.length > 50) sop.content = extracted;
      }
    }

    await sop.save();
    await buildAndSaveComplianceStructureCache(sop._id, sop.content);
    invalidateDashboardSopsCache();

    await ComplianceGapFinding.updateOne(
      { gapId },
      {
        $set: {
          lastAppliedAt: new Date(),
          sopSectionText: repl,
          lastReviewedAt: new Date(),
        },
      },
    );

    const inc = await runIncrementalComplianceReview(sop.toObject(), {
      previousStructure: sop.complianceStructureCache?.sectionHashes,
    });

    await ComplianceReport.updateOne(
      { sopId: sop._id },
      {
        $set: {
          overallScore: inc.overallScore,
          criticalCount: inc.criticalCount,
          majorCount: inc.majorCount,
          minorCount: inc.minorCount,
          improvementCount: inc.improvementCount,
          analyzedAt: new Date(),
        },
      },
    );

    return NextResponse.json({
      success: true,
      gapId,
      originalText: orig,
      modifiedText: repl,
      changeSummary: docxPatchResult?.changeSummary ?? `Updated SOP text in section ${gap.sopSection}`,
      docxUpdated: Boolean(docxPatchResult?.success),
      revalidation: inc,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Apply fix failed" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
