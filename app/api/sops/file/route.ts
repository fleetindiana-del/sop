import { NextRequest, NextResponse } from "next/server";
import path from "path";
import {
  loadStoredFileBuffer,
  resolveAlternateStoredLocation,
} from "@/lib/loadStoredFileBuffer";
import { getContentType } from "@/lib/extractContent";

/** Serves raw files for Office Online viewer (must be publicly reachable). */
export async function GET(request: NextRequest) {
  const filePath = request.nextUrl.searchParams.get("path");

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

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": getContentType(filename),
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    console.error("File serve error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "File not found" },
      { status: 404 },
    );
  }
}
