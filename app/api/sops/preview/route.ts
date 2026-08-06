import { NextRequest, NextResponse } from "next/server";
import path from "path";
import {
  loadStoredFileBuffer,
  resolveAlternateStoredLocation,
} from "@/lib/loadStoredFileBuffer";
import { getContentType } from "@/lib/extractContent";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const filePath = searchParams.get("path");
  const type = searchParams.get("type") ?? "pdf";

  if (!filePath) {
    return NextResponse.json({ error: "Missing path parameter" }, { status: 400 });
  }

  try {
    let buffer = await loadStoredFileBuffer(filePath, { trustedRemote: true });
    if (!buffer) {
      const alt = await resolveAlternateStoredLocation(filePath, null, undefined);
      if (alt) buffer = await loadStoredFileBuffer(alt, { trustedRemote: true });
    }
    if (!buffer) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const filename = path.basename(filePath.split("?")[0] ?? filePath);
    const contentType =
      type === "pdf" || /\.pdf($|\?)/i.test(filePath)
        ? "application/pdf"
        : getContentType(filename);

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("Preview error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Preview failed" },
      { status: 500 },
    );
  }
}
