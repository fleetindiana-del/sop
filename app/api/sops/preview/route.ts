import { NextRequest, NextResponse } from "next/server";
import path from "path";
import {
  loadStoredFileBuffer,
  resolveAlternateStoredLocation,
} from "@/lib/loadStoredFileBuffer";
import { getContentType } from "@/lib/extractContent";
import { inlineBinaryResponse } from "@/lib/inline-file-response";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get("path");
  const type = searchParams.get("type") ?? "pdf";

  if (!filePath) {
    return NextResponse.json({ error: "Missing path parameter" }, { status: 400 });
  }

  try {
    // An empty Buffer is truthy — treat zero bytes as missing so the alternate
    // location is still tried and we never serve 0 bytes as a "valid" PDF.
    let buffer = await loadStoredFileBuffer(filePath, { trustedRemote: true });
    if (!buffer?.length) {
      const alt = await resolveAlternateStoredLocation(filePath, null, undefined);
      if (alt) buffer = await loadStoredFileBuffer(alt, { trustedRemote: true });
    }
    if (!buffer?.length) {
      return NextResponse.json(
        { error: "Stored file is empty or missing — re-upload the document" },
        { status: 404 },
      );
    }

    const filename = path.basename(filePath.split("?")[0] ?? filePath);
    const contentType =
      type === "pdf" || /\.pdf($|\?)/i.test(filePath)
        ? "application/pdf"
        : getContentType(filename);

    return inlineBinaryResponse(buffer, contentType, filename);
  } catch (err) {
    console.error("Preview error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Preview failed" },
      { status: 500 },
    );
  }
}
