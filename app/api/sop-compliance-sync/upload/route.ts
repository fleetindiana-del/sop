import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import SOP from "@/models/SOP";
import { extractTablesFromDOCX } from "@/lib/docxTableParser";

/** Upload department DOCX files with SOP compliance dates (Effective / Review). */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();

    const formData = await request.formData();
    const files: File[] = [];

    for (const [, value] of formData.entries()) {
      if (value instanceof File && value.name.toLowerCase().endsWith(".docx")) {
        if (!value.name.startsWith("~$")) files.push(value);
      }
    }

    if (files.length === 0) {
      return NextResponse.json({ error: "No DOCX files found" }, { status: 400 });
    }

    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const file of files) {
      try {
        const department = extractDepartmentFromFilename(file.name);
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const tables = await extractTablesFromDOCX(buffer);

        if (tables.length === 0) {
          totalSkipped++;
          continue;
        }

        for (const table of tables) {
          if (table.rows.length < 2) continue;

          for (const row of table.rows) {
            if (row.cells.length < 6) continue;

            const sopNo = row.cells[2]?.trim();
            const version = row.cells[3]?.trim();
            const effectiveDateStr = row.cells[4]?.trim();
            const reviewDateStr = row.cells[5]?.trim();

            if (!sopNo || !/^[A-Z]{2,6}\d{2,3}$/i.test(sopNo)) continue;

            const effectiveDate = parseDate(effectiveDateStr);
            const reviewDate = parseDate(reviewDateStr);
            if (!effectiveDate && !reviewDate) continue;

            let sop = await SOP.findOne({ identifier: `${sopNo}-${version}` });
            if (!sop) {
              sop = await SOP.findOne({
                identifier: new RegExp(`^${sopNo}(-\\d+)?$`, "i"),
              });
            }
            if (!sop) {
              totalSkipped++;
              continue;
            }

            const updates: Record<string, unknown> = {};
            if (effectiveDate) updates.effectiveDate = effectiveDate;
            if (reviewDate) {
              updates.reviewDate = reviewDate;
              updates.expiryDate = reviewDate;
            }
            if (version) updates.version = version;
            if (department) updates.department = department;

            await SOP.findByIdAndUpdate(sop._id, { $set: updates }, { returnDocument: 'after' });
            totalUpdated++;
          }
        }
      } catch (fileError) {
        console.error(`Error processing ${file.name}:`, fileError);
        totalErrors++;
      }
    }

    return NextResponse.json({
      success: true,
      updated: totalUpdated,
      skipped: totalSkipped,
      errors: totalErrors,
      message: `Successfully updated ${totalUpdated} SOPs`,
    });
  } catch (error) {
    console.error("sop-compliance-sync upload:", error);
    return NextResponse.json(
      {
        error: "Failed to process files",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

function extractDepartmentFromFilename(filename: string): string {
  const nameWithoutExt = filename.replace(/\.docx$/i, "");
  return nameWithoutExt.replace(/^\d+\.\s*/, "").toUpperCase();
}

function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  try {
    const parts = dateStr.split("/");
    if (parts.length !== 3) return null;
    const day = parseInt(parts[0], 10);
    const month = parseInt(parts[1], 10) - 1;
    const year = parseInt(parts[2], 10);
    const date = new Date(year, month, day);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}
