import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import {
  isPlaceholderSopName,
  nameMatchesLanguage,
  sopRecordNameNeedsFix,
} from "@/lib/sop-name-resolution";
import { deriveSopRecordName } from "@/lib/sop-utils";

/**
 * For every SOP record with a missing, placeholder, or wrong-language name,
 * derive the real title from the stored document content and filename.
 */
export async function backfillSopNames() {
  await connectDB();

  // Needs `content` to derive names (see deriveSopRecordName below) — only the
  // other two heavy caches are safe to exclude here.
  const records = await SOP.find({}).select("-mcqClauseCache -complianceStructureCache");
  let updated = 0;
  let skipped = 0;
  const changes: Array<{
    identifier: string;
    language: string;
    old: string;
    new: string;
  }> = [];

  for (const record of records) {
    const language = record.language === "Gujarati" ? "Gujarati" : "English";
    const currentName = record.name?.trim() ?? "";

    if (!sopRecordNameNeedsFix(currentName, record.identifier, language)) {
      skipped++;
      continue;
    }

    const newName = deriveSopRecordName({
      identifier: record.identifier,
      language,
      fileType: record.fileType,
      content: record.content,
      originalFileName: record.originalFileName,
    });

    if (
      !newName ||
      newName === currentName ||
      isPlaceholderSopName(newName, record.identifier) ||
      !nameMatchesLanguage(newName, language)
    ) {
      skipped++;
      continue;
    }

    changes.push({
      identifier: record.identifier,
      language,
      old: currentName,
      new: newName,
    });
    await record.updateOne({ name: newName });
    updated++;
  }

  invalidateDashboardSopsCache();

  return { updated, skipped, total: records.length, changes };
}
