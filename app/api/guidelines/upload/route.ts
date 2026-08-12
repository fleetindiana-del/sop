import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { connectDB } from "@/lib/mongodb";
import SOPGuideline from "@/models/SOPGuideline";
import { requireAuth } from "@/lib/withAuth";
import {
  processGuidelinePDF,
  extractClauses,
  identifyGuidelineType,
  categorizeGuideline,
} from "@/lib/ocrProcessor";

export const maxDuration = 120;

/** Runtime-only path under temp/guidelines — keep out of Turbopack NFT traces. */
function guidelineFilePath(folderName: string, fileName: string): string {
  return path.join(process.cwd(), "temp", "guidelines", folderName, fileName);
}

function guidelineFolderPath(folderName: string): string {
  return path.join(process.cwd(), "temp", "guidelines", folderName);
}

// ── In-memory summary cache (5-minute TTL) ─────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000;
let summaryCache: { data: unknown; timestamp: number } | null = null;
function getCachedSummary() {
  if (!summaryCache) return null;
  if (Date.now() - summaryCache.timestamp > CACHE_TTL_MS) { summaryCache = null; return null; }
  return summaryCache.data;
}
function setCachedSummary(data: unknown) { summaryCache = { data, timestamp: Date.now() }; }
function clearCache() { summaryCache = null; }

// ── POST — Upload PDFs ─────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;
  const userId = (auth.session?.user as { id?: string })?.id ?? "system";

  try {
    await connectDB();
    const formData = await request.formData();
    const folderName = (formData.get("folder") as string | null)?.trim() ||
                       (formData.get("folderName") as string | null)?.trim();
    const files = formData.getAll("files") as File[];

    if (!folderName) {
      return NextResponse.json({ success: false, error: "Folder / Category name is required" }, { status: 400 });
    }
    if (!files.length) {
      return NextResponse.json({ success: false, error: "At least one PDF is required" }, { status: 400 });
    }

    const results: {
      name: string; clauses: number; status: "created" | "updated" | "failed";
      folder?: string; error?: string;
    }[] = [];

    for (const file of files) {
      if (!path.basename(file.name).toLowerCase().endsWith(".pdf")) {
        results.push({ name: path.basename(file.name), clauses: 0, status: "failed", error: "Only PDF files are supported" });
        continue;
      }

      try {
        const buffer = Buffer.from(await file.arrayBuffer());

        // file.name may include a relative path from webkitdirectory (e.g. "FolderName/actual.pdf")
        const safeFileName = path.basename(file.name);

        const tempDir = guidelineFolderPath(folderName);
        fs.mkdirSync(/* turbopackIgnore: true */ tempDir, { recursive: true });
        const filePath = guidelineFilePath(folderName, safeFileName);
        fs.writeFileSync(/* turbopackIgnore: true */ filePath, buffer);

        let ocr;
        try {
          // OCR / text extraction
          ocr = await processGuidelinePDF(buffer);
        } catch (ocrErr) {
          // Clean up orphaned temp file
          try { fs.unlinkSync(/* turbopackIgnore: true */ filePath); } catch { /* ignore */ }
          results.push({
            name: safeFileName, clauses: 0, status: "failed", folder: folderName,
            error: `PDF parsing failed: ${ocrErr instanceof Error ? ocrErr.message.slice(0, 120) : "unknown error"}`,
          });
          continue;
        }

        if (!ocr.text.trim()) {
          try { fs.unlinkSync(/* turbopackIgnore: true */ filePath); } catch { /* ignore */ }
          results.push({ name: safeFileName, clauses: 0, status: "failed", folder: folderName, error: "No text extracted (may be image-only scan — try a digital PDF)" });
          continue;
        }

        // Parse clauses and detect metadata
        const baseName = safeFileName.replace(/\.pdf$/i, "").replace(/[-_]/g, " ");
        const clauses = extractClauses(ocr.text, baseName);
        const guidelineType = identifyGuidelineType(ocr.text, file.name);
        const category = categorizeGuideline(ocr.text);

        const docFields = {
          folderName,
          filePath,
          pdfName: safeFileName,
          isScanned: ocr.isScanned,
          ocrStatus: "completed" as const,
          rawText: ocr.text.slice(0, 200_000),
          pageCount: ocr.pageCount || 1,
          clauses,
          guidelineType,
          category,
          uploadedBy: userId,
        };

        // Upsert by name + folderName
        const existing = await SOPGuideline.findOne({ name: baseName, folderName });
        if (existing) {
          Object.assign(existing, docFields);
          await existing.save();
          results.push({ name: baseName, clauses: clauses.length, status: "updated", folder: folderName });
        } else {
          await SOPGuideline.create({ name: baseName, ...docFields });
          results.push({ name: baseName, clauses: clauses.length, status: "created", folder: folderName });
        }
      } catch (err) {
        results.push({
          name: path.basename(file.name), clauses: 0, status: "failed", folder: folderName,
          error: err instanceof Error ? err.message.slice(0, 150) : "Processing failed",
        });
      }
    }

    clearCache();
    const succeeded = results.filter((r) => r.status !== "failed").length;
    return NextResponse.json({
      success: succeeded > 0,
      results,
      message: `${succeeded}/${files.length} file(s) processed successfully`,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 },
    );
  }
}

// ── GET — List / Fetch single / Serve PDF ─────────────────────────────────

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  await connectDB();
  const { searchParams } = request.nextUrl;
  const id = searchParams.get("id");
  const serve = searchParams.get("serve");
  const summary = searchParams.get("summary");
  const folderName = searchParams.get("folderName");
  const category = searchParams.get("category");

  // Serve PDF file from disk
  if (serve) {
    try {
      const doc = await SOPGuideline.findById(serve).select("filePath pdfName folderName").lean();
      if (!doc) return NextResponse.json({ error: "Guideline not found" }, { status: 404 });

      // Resolve file path: use stored path if it exists, otherwise reconstruct from folderName + pdfName
      let resolvedPath = doc.filePath;
      if (!fs.existsSync(/* turbopackIgnore: true */ resolvedPath)) {
        const reconstructed = guidelineFilePath(doc.folderName, doc.pdfName);
        if (fs.existsSync(/* turbopackIgnore: true */ reconstructed)) {
          resolvedPath = reconstructed;
        } else {
          return NextResponse.json(
            { error: "Guideline file not found. Please re-upload the PDF." },
            { status: 404 },
          );
        }
      }

      const fileBuffer = fs.readFileSync(/* turbopackIgnore: true */ resolvedPath);
      return new NextResponse(fileBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${doc.pdfName}"`,
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
    }
  }

  // Fetch single guideline with full clauses
  if (id) {
    try {
      const doc = await SOPGuideline.findById(id)
        .select("name folderName pdfName guidelineType category createdAt clauses.clauseNumber clauses.clauseTitle clauses.clauseText")
        .maxTimeMS(25000)
        .lean();
      if (!doc) return NextResponse.json({ error: "Guideline not found" }, { status: 404 });
      return NextResponse.json({ success: true, guideline: doc });
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
    }
  }

  // Summary list (lightweight — no clause text)
  if (summary) {
    const cached = getCachedSummary();
    if (cached && !folderName && !category) {
      return NextResponse.json(cached, {
        headers: { "Cache-Control": "public, max-age=300" },
      });
    }
    try {
      const filter: Record<string, string> = {};
      if (folderName) filter.folderName = folderName;
      if (category) filter.category = category;
      const guidelines = await SOPGuideline.find(filter)
        .select("name folderName pdfName guidelineType category createdAt")
        .limit(2000)
        .sort({ folderName: 1, name: 1 })
        .lean();
      const resp = { success: true, guidelines, totalClauses: 0, summary: true };
      if (!folderName && !category) setCachedSummary(resp);
      return NextResponse.json(resp);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
    }
  }

  // Default detailed list
  try {
    const filter: Record<string, string> = {};
    if (folderName) filter.folderName = folderName;
    if (category) filter.category = category;
    const guidelines = await SOPGuideline.find(filter)
      .select("name folderName pdfName guidelineType category createdAt clauses.clauseNumber clauses.clauseTitle")
      .limit(50)
      .sort({ folderName: 1, name: 1 })
      .lean();

    const totalClauses = guidelines.reduce((s, g) => s + (g.clauses?.length ?? 0), 0);
    return NextResponse.json({ success: true, guidelines, totalClauses });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

// ── DELETE — Remove single guideline ──────────────────────────────────────

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  await connectDB();
  const { searchParams } = request.nextUrl;
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const doc = await SOPGuideline.findById(id).lean();
    if (!doc) return NextResponse.json({ error: "Guideline not found" }, { status: 404 });
    if (doc.filePath) {
      const toDelete = doc.filePath;
      if (fs.existsSync(/* turbopackIgnore: true */ toDelete)) {
        try { fs.unlinkSync(/* turbopackIgnore: true */ toDelete); } catch { /* ignore unlink failure */ }
      }
    }
    await SOPGuideline.findByIdAndDelete(id);
    clearCache();
    return NextResponse.json({ success: true, message: "Guideline deleted", id });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
