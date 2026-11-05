import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/withAuth";
import { exportAllSopsToFilesFolder } from "@/lib/export-sops-to-files";
import { withActivityLog } from "@/lib/activity-log";

export const maxDuration = 300;

async function handlePOST() {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const result = await exportAllSopsToFilesFolder({
      resume: true,
      onProgress: (msg) => console.log(`[export] ${msg}`),
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("export-sops-to-files error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export failed" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
