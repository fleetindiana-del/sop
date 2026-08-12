import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/withAuth";
import { parseImportScopes, previewFilesImport } from "@/lib/sop-files-import";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  const scopes = parseImportScopes(request.nextUrl.searchParams.get("scopes"));
  if (!scopes) {
    return NextResponse.json(
      { error: "Invalid scopes — use main, annexure, and/or prior" },
      { status: 400 },
    );
  }

  const parentIdentifier = request.nextUrl.searchParams.get("parent")?.trim() || undefined;

  try {
    const preview = await previewFilesImport(undefined, scopes, parentIdentifier);
    return NextResponse.json(preview);
  } catch (error) {
    console.error("files-import preview error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Preview failed" },
      { status: 500 },
    );
  }
}
