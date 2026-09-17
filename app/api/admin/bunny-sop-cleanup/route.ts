import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import {
  isCdnUrl,
  readFileBuffer,
  uploadFileToBunny,
} from "@/lib/bunny";
import { getContentType } from "@/lib/extractContent";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { SOP_LIST_EXCLUDE } from "@/lib/sop-list-projection";
import { requireAuth } from "@/lib/withAuth";
import { isBunnyConfigured } from "@/lib/validateEnv";

export async function POST() {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  if (!isBunnyConfigured()) {
    return NextResponse.json({ error: "Bunny CDN is not configured" }, { status: 500 });
  }

  try {
    await connectDB();
    const sops = await SOP.find({}).select(SOP_LIST_EXCLUDE);
    let migrated = 0;
    let failed = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const sop of sops) {
      const paths = [
        sop.fileUrl,
        ...(sop.sopDocuments ?? []).map((d) => d.filePath).filter(Boolean),
      ] as string[];

      for (const filePath of paths) {
        if (!filePath || isCdnUrl(filePath)) {
          skipped++;
          continue;
        }

        try {
          const buffer = await readFileBuffer(filePath);
          const filename =
            sop.originalFileName ??
            filePath.split("/").pop() ??
            `${sop.identifier}.${sop.fileType}`;
          const cdnUrl = await uploadFileToBunny({
            buffer,
            department: sop.department,
            identifier: sop.identifier,
            language: sop.language ?? "English",
            fileType: sop.fileType,
            filename,
            contentType: getContentType(filename),
          });

          if (sop.fileUrl === filePath) sop.fileUrl = cdnUrl;
          for (const doc of sop.sopDocuments ?? []) {
            if (doc.filePath === filePath) doc.filePath = cdnUrl;
          }
          migrated++;
        } catch (err) {
          failed++;
          errors.push(`${sop.identifier}: ${err instanceof Error ? err.message : "failed"}`);
        }
      }

      await sop.save();
    }

    invalidateDashboardSopsCache();
    return NextResponse.json({ migrated, failed, skipped, errors: errors.slice(0, 20) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Migration failed" },
      { status: 500 },
    );
  }
}
