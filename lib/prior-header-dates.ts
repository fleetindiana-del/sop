import SOP, { type ISOP } from "@/models/SOP";
import { sopHeaderDatesValid } from "@/lib/sop-dates";
import { extractTextFromBuffer } from "@/lib/extractContent";
import {
  groupSOPRecords,
  maxVersionInGroup,
  sopFamilyGroupKey,
} from "@/lib/sop-utils";

export const LINKED_CONTENT_PLACEHOLDER = "[Linked from Bunny storage]";

/** The two prior revisions shown in the registry Prior Versions column. */
export function isInRegistryPriorWindow(
  versionNum: number,
  currentVersionNum: number,
): boolean {
  return versionNum < currentVersionNum && versionNum >= currentVersionNum - 2;
}

function versionNumOf(record: Pick<ISOP, "versionNum" | "version">): number {
  return record.versionNum ?? (parseFloat(record.version ?? "0") || 0);
}

function langLabel(record: Pick<ISOP, "language">): "English" | "Gujarati" {
  return record.language === "Gujarati" ? "Gujarati" : "English";
}

export function isUnextractedDocxContent(content?: string | null): boolean {
  if (!content) return true;
  return content.startsWith("[");
}

export function validatePriorDocxHeaderDates(
  record: Pick<ISOP, "content" | "language">,
): boolean {
  if (isUnextractedDocxContent(record.content)) return false;
  return sopHeaderDatesValid(record.content!, langLabel(record));
}

/** Download a DOCX from CDN and extract its text (header table included). */
export async function reextractDocxContentFromUrl(fileUrl: string): Promise<string | null> {
  try {
    const res = await fetch(fileUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const content = await extractTextFromBuffer(buf, "docx");
    if (isUnextractedDocxContent(content)) return null;
    return content;
  } catch {
    return null;
  }
}

async function ensureDocxContent(record: ISOP): Promise<ISOP> {
  if (!isUnextractedDocxContent(record.content)) return record;
  const content = await reextractDocxContentFromUrl(record.fileUrl);
  if (!content) return record;
  await SOP.updateOne(
    { _id: record._id },
    { $set: { content, linkedFromBunny: false, updatedAt: new Date() } },
  );
  return { ...record, content, linkedFromBunny: false } as ISOP;
}

/**
 * Re-download and extract text for prior-window DOCX that still carry the Bunny
 * link placeholder instead of real content.
 */
export async function reextractRegistryPriorLinkedDocx() {
  const records = (await SOP.find({
    isObsolete: { $ne: true },
    fileType: "docx",
    fileUrl: { $exists: true, $ne: "" },
  }).lean()) as ISOP[];

  const families = new Map<string, ISOP[]>();
  for (const record of records) {
    const key = sopFamilyGroupKey(record);
    const list = families.get(key) ?? [];
    list.push(record);
    families.set(key, list);
  }

  let attempted = 0;
  let extracted = 0;
  for (const [, family] of families) {
    const currentNum = parseFloat(maxVersionInGroup(family)) || 0;
    for (const record of family) {
      if (!isUnextractedDocxContent(record.content)) continue;
      if (!isInRegistryPriorWindow(versionNumOf(record), currentNum)) continue;
      attempted++;
      const updated = await ensureDocxContent(record);
      if (!isUnextractedDocxContent(updated.content)) extracted++;
    }
  }

  return { attempted, extracted };
}

/**
 * Re-validate header dates on every DOCX in the registry prior-version window
 * (and the current version, for the Files column) for one SOP family.
 */
export async function refreshFamilyPriorHeaderDateFlags(family: ISOP[]) {
  const currentVersion = maxVersionInGroup(family);
  const currentNum = parseFloat(currentVersion) || 0;
  const ops: Parameters<typeof SOP.bulkWrite>[0] = [];
  const now = new Date();

  for (const record of family) {
    if (record.fileType !== "docx") continue;
    const num = versionNumOf(record);
    const inPriorWindow = isInRegistryPriorWindow(num, currentNum);
    const isCurrent = num === currentNum;
    if (!inPriorWindow && !isCurrent) {
      if (record.headerDatesValid != null) {
        ops.push({
          updateOne: {
            filter: { _id: record._id },
            update: { $unset: { headerDatesValid: "" }, $set: { updatedAt: now } },
          },
        });
      }
      continue;
    }

    let full: ISOP | null = record.content
      ? record
      : ((await SOP.findById(record._id).select("content language fileUrl fileType").lean()) as ISOP | null);
    if (!full) continue;

    if (isUnextractedDocxContent(full.content)) {
      full = await ensureDocxContent(full);
    }

    const valid = validatePriorDocxHeaderDates(full);
    if (record.headerDatesValid === valid) continue;
    ops.push({
      updateOne: {
        filter: { _id: record._id },
        update: { $set: { headerDatesValid: valid, updatedAt: now } },
      },
    });
  }

  if (ops.length) await SOP.bulkWrite(ops, { ordered: false });
  return ops.length;
}

/**
 * Backfill `headerDatesValid` for every prior-version DOCX slot across active
 * registry SOP families (~416). Current-version and archived DOCX are skipped.
 */
export async function backfillPriorHeaderDateFlags() {
  const reextract = await reextractRegistryPriorLinkedDocx();

  const records = (await SOP.find({ isObsolete: { $ne: true } }).lean()) as ISOP[];
  const families = new Map<string, ISOP[]>();
  for (const record of records) {
    const key = sopFamilyGroupKey(record);
    const list = families.get(key) ?? [];
    list.push(record);
    families.set(key, list);
  }

  let familiesTouched = 0;
  let flagsWritten = 0;
  for (const [, family] of families) {
    const n = await refreshFamilyPriorHeaderDateFlags(family);
    if (n > 0) {
      familiesTouched++;
      flagsWritten += n;
    }
  }

  return { families: families.size, familiesTouched, flagsWritten, reextract };
}
/** Registry prior-version DOCX slots that still lack a valid header date pair. */
export function countPriorHeaderDateErrors(registry: ReturnType<typeof groupSOPRecords>) {
  const slots = registry.flatMap((s) =>
    s.priorVersions.filter((pv) => pv.docx && !pv.missing),
  );
  return {
    sopCount: registry.length,
    priorDocxSlots: slots.length,
    invalid: slots.filter((pv) => pv.docxDateError).length,
  };
}
