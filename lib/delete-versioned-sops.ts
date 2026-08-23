import fs from "fs";
import path from "path";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { groupRecordsByBase } from "@/lib/reconcile-sop-versions";
import { recordsForVersion, maxVersionInGroup, versionFromIdentifier } from "@/lib/sop-utils";
import { logSopAudit, snapshotSop } from "@/lib/audit-log";

function resolveUploadPath(fileUrl: string): string | null {
  try {
    const raw = fileUrl.trim();
    const urlPath = raw.startsWith("http://") || raw.startsWith("https://")
      ? new URL(raw).pathname
      : raw;
    // Only handle local /uploads/... paths — skip CDN URLs
    if (!urlPath.startsWith("/uploads/") && !urlPath.startsWith("uploads/")) return null;
    const relative = urlPath.replace(/^\//, "");
    return path.join(process.cwd(), "public", relative);
  } catch {
    return null;
  }
}

function deleteFileIfExists(filePath: string) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      // Remove parent directory if now empty
      const dir = path.dirname(filePath);
      const remaining = fs.readdirSync(dir).filter((f) => f !== ".gitkeep");
      if (remaining.length === 0) fs.rmdirSync(dir);
    }
  } catch {
    // Non-fatal: file may be on CDN or already gone
  }
}

/**
 * Hard-delete every SOP family that has more than one distinct version number
 * in the database (i.e. has prior-version records). Deletes all DB records for
 * the family — both current and prior — plus their local upload files.
 */
export async function deleteVersionedSopFamilies() {
  await connectDB();
  const records = await SOP.find({});
  const grouped = groupRecordsByBase(records);

  const deletedRecords: string[] = [];
  const deletedFiles: string[] = [];
  const families: string[] = [];

  for (const [baseId, family] of grouped) {
    // A family is "versioned" when it contains records with more than one
    // distinct numeric version (i.e. real prior-version uploads exist).
    const versionNums = new Set(
      family.map((r) => {
        const fromId = versionFromIdentifier(r.identifier);
        const num = fromId != null ? parseInt(fromId, 10) : parseFloat(r.version ?? "0");
        return isNaN(num) ? 0 : num;
      }),
    );

    if (versionNums.size <= 1) continue;

    families.push(baseId);

    for (const record of family) {
      // Collect all file URLs from this record
      const fileUrls = new Set<string>();
      if (record.fileUrl) fileUrls.add(record.fileUrl);
      for (const doc of record.sopDocuments ?? []) {
        if (doc.filePath) fileUrls.add(doc.filePath);
      }

      for (const url of fileUrls) {
        const fsPath = resolveUploadPath(url);
        if (fsPath) {
          deleteFileIfExists(fsPath);
          deletedFiles.push(fsPath);
        }
      }

      const previous = snapshotSop(record);
      await SOP.deleteOne({ _id: record._id });
      await logSopAudit({
        action: "deleted",
        sop: record,
        previous,
        summary: `Deleted version ${record.version ?? ""} record of ${record.identifier}`.replace(/\s+/g, " "),
        comments: "Versioned SOP family cleanup",
      });
      deletedRecords.push(record._id.toString());
    }
  }

  invalidateDashboardSopsCache();

  return {
    familiesDeleted: families.length,
    families,
    recordsDeleted: deletedRecords.length,
    filesDeleted: deletedFiles.length,
  };
}
