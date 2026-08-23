import { createHash } from "crypto";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { sopIdentifierMatchFilter, normalizeSopIdentifierKey } from "@/lib/sopIdentifierNormalize";
import { baseIdentifierFromIdentifier, sopFamilyIdentifierRegex } from "@/lib/sop-utils";
import { saveUploadedBuffer, detectFileType } from "@/lib/upload";
import { resolveUploadLanguage } from "@/lib/sop-filename";
import { languageFromContentScript } from "@/lib/sop-name-resolution";
import { extractTextFromBuffer } from "@/lib/extractContent";
import { logSopAudit, snapshotSop } from "@/lib/audit-log";

export type AnnexureLinkResult = {
  success: boolean;
  skipped?: boolean;
  skipReason?: "duplicate";
  error?: string;
  parentIdentifier?: string;
  annexureLabel?: string;
  filePath?: string;
  checksum?: string;
};

function escapeMongoRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

async function findParentSopRecord(parentIdentifier: string, versionNum?: number) {
  const normalized = normalizeSopIdentifierKey(parentIdentifier);

  const exactFilter: Record<string, unknown> = {
    ...sopIdentifierMatchFilter(normalized),
    isObsolete: { $ne: true },
  };

  if (versionNum != null) {
    const withVersion = await SOP.findOne({ ...exactFilter, versionNum })
      .sort({ versionNum: -1 })
      .lean();
    if (withVersion) return withVersion;
  }

  let parent = await SOP.findOne(exactFilter).sort({ versionNum: -1 }).lean();
  if (parent) return parent;

  const familyFilter: Record<string, unknown> = {
    identifier: sopFamilyIdentifierRegex(normalized),
    isObsolete: { $ne: true },
  };
  if (versionNum != null) {
    familyFilter.versionNum = versionNum;
  }

  parent = await SOP.findOne(familyFilter).sort({ versionNum: -1 }).lean();
  if (parent) return parent;

  const base = baseIdentifierFromIdentifier(normalized);
  const docMatch = base.match(/^([A-Z]{2,6})(\d+)$/i);
  const baseCandidates = new Set<string>([base]);
  if (docMatch) {
    const letters = docMatch[1].toUpperCase();
    const doc = parseInt(docMatch[2], 10);
    baseCandidates.add(`${letters}${doc}`);
    baseCandidates.add(`${letters}${String(doc).padStart(2, "0")}`);
  }

  for (const candidate of baseCandidates) {
    parent = await SOP.findOne({
      sopBaseId: new RegExp(`^${escapeMongoRegex(candidate)}$`, "i"),
      isObsolete: { $ne: true },
    })
      .sort({ versionNum: -1 })
      .lean();
    if (parent) return parent;
  }

  return null;
}

export async function findAnnexureParentSop(parentIdentifier: string, versionNum?: number) {
  return findParentSopRecord(parentIdentifier, versionNum);
}

export async function linkAnnexureToParent(opts: {
  buffer: Buffer;
  fileName: string;
  relativePath: string;
  parentIdentifier: string;
  annexureLabel?: string;
  versionNum?: number;
  checksum?: string;
  skipIfChecksumMatches?: boolean;
}): Promise<AnnexureLinkResult> {
  await connectDB();

  const fileType = detectFileType(opts.fileName);
  if (!fileType) {
    return { success: false, error: "Unsupported file type" };
  }

  const checksum =
    opts.checksum ?? createHash("sha256").update(opts.buffer).digest("hex");

  if (opts.skipIfChecksumMatches) {
    const existingChecksum = await SOP.findOne({ checksum }).lean();
    if (existingChecksum) {
      return {
        success: true,
        skipped: true,
        skipReason: "duplicate",
        parentIdentifier: opts.parentIdentifier,
        checksum,
      };
    }
  }

  let parent = await findParentSopRecord(opts.parentIdentifier, opts.versionNum);

  if (!parent) {
    return {
      success: false,
      error: `Parent SOP ${opts.parentIdentifier} not found — import main SOP first`,
      parentIdentifier: opts.parentIdentifier,
    };
  }

  const existingAnnexure = (parent.sopDocuments ?? []).find(
    (d) => d.checksum === checksum,
  );
  if (existingAnnexure) {
    return {
      success: true,
      skipped: true,
      skipReason: "duplicate",
      parentIdentifier: parent.identifier,
      annexureLabel: opts.annexureLabel,
      checksum,
    };
  }

  const content = await extractTextFromBuffer(opts.buffer, fileType);
  const lang = languageFromContentScript(
    content,
    resolveUploadLanguage(opts.relativePath, parent.language ?? "English"),
  );

  const { fileUrl } = await saveUploadedBuffer(
    opts.buffer,
    opts.fileName,
    parent.department,
    parent.identifier,
    lang,
  );

  const docEntry = {
    fileName: opts.fileName,
    filePath: fileUrl,
    fileType,
    language: lang,
    documentKind: "annexure" as const,
    annexureLabel: opts.annexureLabel,
    checksum,
    parentIdentifier: parent.identifier,
  };

  const auditPrevious = snapshotSop(parent);
  const updatedParent = await SOP.findByIdAndUpdate(
    parent._id,
    { $push: { sopDocuments: docEntry } },
    { returnDocument: "after" },
  ).lean();

  if (updatedParent) {
    await logSopAudit({
      action: "updated",
      sop: updatedParent,
      previous: auditPrevious,
      comments: `Linked annexure ${opts.annexureLabel ?? ""}: ${opts.fileName}`.trim(),
    });
  }

  return {
    success: true,
    parentIdentifier: parent.identifier,
    annexureLabel: opts.annexureLabel,
    filePath: fileUrl,
    checksum,
  };
}
