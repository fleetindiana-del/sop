import { NextRequest, NextResponse } from "next/server";
import { processSopUpload } from "@/lib/sop-upload";
import { requireAuth } from "@/lib/withAuth";

export const maxDuration = 300;

// Generic Word placeholder pages to skip — must be the WHOLE filename (ignoring
// extension), not merely contain these words, or a real annexure whose title
// happens to include "cover page" (e.g. "Annexure-II Particle Counter Cover
// Page.docx") gets silently dropped. Keep in sync with SKIP_NAME in
// lib/sop-content-metadata.ts.
const SKIP_PATTERN = /^(cover\s*page|index)(\.[a-z0-9]+)?$/i;

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    const paths = formData.getAll("paths").map(String);

    // Build aligned (file, path) pairs so filtering never shifts indices.
    const pairs: Array<{ file: File; path: string }> = files.map((f, i) => ({
      file: f,
      path: paths[i] ?? f.name,
    }));
    const filtered = pairs.filter((p) => !SKIP_PATTERN.test(p.file.name));

    const nextForm = new FormData();
    // Copy non-file/non-path scalar fields (language, department, generateMcq, …)
    for (const [key, value] of formData.entries()) {
      if (key !== "files" && key !== "paths") nextForm.append(key, value);
    }
    // Re-append files and their matching paths together to keep indices aligned.
    for (const { file, path } of filtered) {
      nextForm.append("files", file);
      nextForm.append("paths", path);
    }
    console.log(
      `[bulk-folder-upload] batch received: ${files.length} file(s), ${filtered.length} after skip-filter`,
    );

    return processSopUpload(nextForm, request);
  } catch (error) {
    console.error("bulk-folder-upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 },
    );
  }
}
