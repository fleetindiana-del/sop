import {
  differenceInDays,
  format,
  isAfter,
  isBefore,
  parseISO,
} from "date-fns";
import type { ISOP } from "@/models/SOP";
import type {
  DashboardStats,
  DepartmentCapsule,
  EditSOPFormData,
  EditSOPPayload,
  ExpiryTier,
  LanguageCode,
  RegistrySOP,
  SOPFilters,
} from "@/lib/types";
import { collectPresentAnnexureRomans, sortAnnexureRomans } from "@/lib/sop-annexure-requirements";
import {
  cleanSopDisplayName,
  hasGujaratiScript,
  isPlaceholderSopName,
  nameMatchesLanguage,
  resolveSopFamilyNames,
} from "@/lib/sop-name-resolution";
import { nameFromFilename } from "@/lib/sop-filename";
import {
  normalizeSopIdentifierKey,
  sopFamilyKeyFromIdentifier,
  sopIdentifierMatchFilter,
} from "@/lib/sopIdentifierNormalize";

export const DEPARTMENT_ORDER = [
  "QA",
  "QC",
  "Microbiology",
  "Production",
  "Store",
  "Engineering and Maintenance",
  "Warehouse/Store",
  "Personnel",
];

export function sortByDeptOrder(departments: string[]): string[] {
  return [...departments].sort((a, b) => {
    const ai = DEPARTMENT_ORDER.indexOf(a);
    const bi = DEPARTMENT_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

const NEAR_EXPIRY_DAYS = 30;
const MEDIUM_EXPIRY_DAYS = 180;

export function getExpiryTier(expiryDate?: Date | string | null): ExpiryTier {
  if (!expiryDate) return "none";
  const date = typeof expiryDate === "string" ? parseISO(expiryDate) : expiryDate;
  const days = differenceInDays(date, new Date());
  if (days < 0) return "expired";
  if (days <= NEAR_EXPIRY_DAYS) return "high";
  if (days <= MEDIUM_EXPIRY_DAYS) return "medium";
  // Any valid future date counts as "low" urgency — including far-future dates
  // beyond LOW_EXPIRY_DAYS. "none" is reserved for SOPs with no expiry date at all
  // (guarded above), so they aren't miscounted as "No Date".
  return "low";
}

export function formatExpiryLabel(expiryDate?: Date | string | null): string {
  if (!expiryDate) return "No Date";
  const date = typeof expiryDate === "string" ? parseISO(expiryDate) : expiryDate;
  const days = differenceInDays(date, new Date());
  if (days < 0) return `Expired - ${Math.abs(days)} days ago`;
  const months = Math.floor(days / 30);
  const remDays = days % 30;
  return `${days} days (${months} months ${remDays} days)`;
}

export function complianceScoreFromStatus(status?: string): number {
  switch (status) {
    case "compliant":
      return 9;
    case "partial":
      return 6;
    case "non-compliant":
      return 3;
    default:
      return 0;
  }
}

function langKey(language?: string): "en" | "gu" {
  return language === "Gujarati" ? "gu" : "en";
}

function resolveLanguage(records: ISOP[]): LanguageCode {
  const langs = new Set(records.map((r) => r.language ?? "English"));
  const hasGujText = records.some(
    (r) => r.name && hasGujaratiScript(r.name) && !isPlaceholderSopName(r.name, r.identifier),
  );
  const hasEngText = records.some(
    (r) =>
      r.name &&
      !hasGujaratiScript(r.name) &&
      !isPlaceholderSopName(r.name, r.identifier),
  );
  if ((langs.has("English") || hasEngText) && (langs.has("Gujarati") || hasGujText)) {
    return "ENG-GUJ";
  }
  if (langs.has("Gujarati") || (hasGujText && !hasEngText)) return "GUJ";
  return "ENG";
}

export function versionNumber(version: string): number {
  return parseFloat(version) || 0;
}

/** Stable family key for grouping all revisions of one SOP (QAGE01-11 ≡ QAGE1-11). */
export function sopFamilyGroupKey(record: Pick<ISOP, "identifier" | "sopBaseId">): string {
  const normalized = normalizeSopIdentifierKey(record.identifier);
  const fam = sopFamilyKeyFromIdentifier(normalized);
  if (fam) return fam;
  const base = record.sopBaseId ?? record.identifier;
  return baseIdentifierFromIdentifier(base).toUpperCase();
}

function sopGroupKey(record: ISOP): string {
  return sopFamilyGroupKey(record);
}

function recordVersionNum(record: ISOP): number {
  // Always derive from recordVersion so the identifier-suffix override in recordVersion
  // takes effect. The stored versionNum DB field may have been saved with an old default
  // (e.g. 1 for records that had version="1.0") and would yield a wrong comparison.
  return versionNumber(recordVersion(record));
}

/** A stored version date must be present, calendar-valid, and not an upload-time placeholder. */
function isValidVersionDateValue(date: Date | undefined, uploadedAt?: Date): boolean {
  if (!date) return false;
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return false;
  const year = new Date(date).getFullYear();
  if (year < 1990 || year > 2100) return false;
  if (uploadedAt && Math.abs(t - new Date(uploadedAt).getTime()) <= 10_000) return false;
  return true;
}

/** Version date = the document's effective / revision date only — not review or expiry. */
function resolveVersionDateForValidation(
  record: ISOP,
  inheritFrom?: Date,
): Date | undefined {
  if (
    record.effectiveDate &&
    isValidVersionDateValue(record.effectiveDate, record.uploadedAt)
  ) {
    return record.effectiveDate;
  }
  if (inheritFrom && isValidVersionDateValue(inheritFrom, record.uploadedAt)) {
    return inheritFrom;
  }
  return undefined;
}

/**
 * Current-version date completeness for one language: the required docx + pdf pair
 * must both be on file with a valid effective (version) date from the docx. The pdf
 * may inherit the docx date when its own effectiveDate is missing or invalid.
 * Review / expiry dates are never used for this check.
 */
function currentVersionLangDateComplete(
  group: ISOP[],
  currentVersionNum: number,
  guj: boolean,
): boolean {
  const langRecords = group.filter(
    (r) =>
      recordVersionNum(r) === currentVersionNum &&
      (guj ? r.language === "Gujarati" : r.language !== "Gujarati") &&
      (r.fileType === "docx" || r.fileType === "pdf"),
  );
  const docx = langRecords.find((r) => r.fileType === "docx" && r.fileUrl);
  const pdf = langRecords.find((r) => r.fileType === "pdf" && r.fileUrl);
  if (!docx || !pdf) return false;

  const docxDate = resolveVersionDateForValidation(docx);
  if (!docxDate) return false;

  return Boolean(resolveVersionDateForValidation(pdf, docxDate));
}

function pickFamilyDate(
  records: ISOP[],
  field: "expiryDate" | "effectiveDate" | "reviewDate",
): Date | undefined {
  const ranked = [...records].sort((a, b) => {
    const score = (r: ISOP) => {
      let s = 0;
      if (r.language !== "Gujarati") s += 10;
      if (r.fileType === "docx") s += 5;
      if (r[field]) s += 1;
      return s;
    };
    return score(b) - score(a);
  });
  return ranked.find((r) => r[field])?.[field];
}

function recordVersion(record: ISOP): string {
  // When version is the schema default "1.0" (meaning it was never explicitly set), prefer the
  // version encoded in the identifier suffix (e.g. PEGE01-05 → "5") via resolveVersionForRecord.
  // For any other explicitly stored version, resolveVersionForRecord also handles tie-breaking.
  return resolveVersionForRecord(record.identifier, record.version);
}

export function maxVersionInGroup(group: ISOP[]): string {
  let bestNum = recordVersionNum(group[0]);
  let bestLabel = recordVersion(group[0]);
  for (const record of group) {
    const num = recordVersionNum(record);
    if (num > bestNum) {
      bestNum = num;
      bestLabel = recordVersion(record);
    }
  }
  return bestLabel;
}

export function recordsForVersion(group: ISOP[], version: string): ISOP[] {
  const target = versionNumber(version);
  return group.filter((record) => recordVersionNum(record) === target);
}

/** Each DB record represents one file — use fileUrl only to avoid cross-version pollution. */
function applyRecordFileLinks(
  record: ISOP,
  entry: { docx?: string; pdf?: string },
) {
  if (!record.fileUrl) return;
  if (record.fileType === "docx") entry.docx = record.fileUrl;
  if (record.fileType === "pdf") entry.pdf = record.fileUrl;
}

function collectAnnexures(records: ISOP[]) {
  const annexures: { label: string; filePath: string; fileName?: string }[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    for (const doc of record.sopDocuments ?? []) {
      if (doc.documentKind !== "annexure" || !doc.filePath) continue;
      const key = doc.checksum || doc.filePath;
      if (seen.has(key)) continue;
      seen.add(key);
      annexures.push({
        label: doc.annexureLabel || doc.fileName || "Annexure",
        filePath: doc.filePath,
        fileName: doc.fileName,
      });
    }
  }

  return annexures;
}

function collectRequiredAnnexures(records: ISOP[]): string[] {
  const englishDocx = records.find(
    (r) => r.fileType === "docx" && r.language === "English" && r.requiredAnnexures?.length,
  );
  if (englishDocx?.requiredAnnexures?.length) {
    return sortAnnexureRomans(englishDocx.requiredAnnexures);
  }
  const anyDocx = records.find(
    (r) => r.fileType === "docx" && r.requiredAnnexures?.length,
  );
  return anyDocx?.requiredAnnexures?.length
    ? sortAnnexureRomans(anyDocx.requiredAnnexures)
    : [];
}

function collectVersionFiles(records: ISOP[]) {
  const docx: { en?: string; gu?: string } = {};
  const pdf: { en?: string; gu?: string } = {};
  const docxDateError: { en?: boolean; gu?: boolean } = {};

  for (const record of records) {
    const key = langKey(record.language);
    if (record.fileUrl) {
      if (record.fileType === "docx") {
        docx[key] = record.fileUrl;
        if (record.headerDatesValid === false) docxDateError[key] = true;
      }
      if (record.fileType === "pdf") pdf[key] = record.fileUrl;
    }
    for (const doc of record.sopDocuments ?? []) {
      const type = doc.fileType?.toLowerCase();
      const docKey = langKey(doc.language);
      const path = doc.filePath?.trim();
      if (!path) continue;
      if (type === "docx" && !docx[docKey]) docx[docKey] = path;
      if (type === "pdf" && !pdf[docKey]) pdf[docKey] = path;
    }
  }

  return {
    docx,
    pdf,
    ...(docxDateError.en || docxDateError.gu ? { docxDateError } : {}),
  };
}

/** Record slots on the current version — used to decide whether a missing file counts as red. */
function currentVersionFileSlots(records: ISOP[]): RegistrySOP["fileSlots"] {
  const docx = { en: false, gu: false };
  const pdf = { en: false, gu: false };
  for (const record of records) {
    const key = langKey(record.language);
    if (record.fileType === "docx") docx[key] = true;
    if (record.fileType === "pdf") pdf[key] = true;
  }
  return { docx, pdf };
}

/** Safe accessor — cached registry rows may predate `fileSlots`. */
export function getFileSlots(
  sop: Pick<RegistrySOP, "fileSlots" | "files" | "language">,
): RegistrySOP["fileSlots"] {
  if (sop.fileSlots?.docx && sop.fileSlots?.pdf) return sop.fileSlots;
  return {
    docx: {
      en: Boolean(sop.files?.docx?.en),
      gu: Boolean(sop.files?.docx?.gu),
    },
    pdf: {
      en: Boolean(sop.files?.pdf?.en),
      gu: Boolean(sop.files?.pdf?.gu),
    },
  };
}

/** Whether a DOCX is required for capsule missing counts (red) for this language. */
export function docxRequiredForLang(sop: RegistrySOP, lang: "en" | "gu"): boolean {
  const needsEn = sop.language === "ENG" || sop.language === "ENG-GUJ";
  const needsGu = sop.language === "GUJ" || sop.language === "ENG-GUJ";
  if (lang === "en") {
    if (!needsEn) return false;
    return sop.language === "ENG" || sop.language === "ENG-GUJ";
  }
  if (!needsGu) return false;
  if (sop.language === "GUJ") return true;
  return getFileSlots(sop).docx.gu;
}

/** Whether a PDF is required for capsule missing counts for this language. */
export function pdfRequiredForLang(sop: RegistrySOP, lang: "en" | "gu"): boolean {
  const needsEn = sop.language === "ENG" || sop.language === "ENG-GUJ";
  const needsGu = sop.language === "GUJ" || sop.language === "ENG-GUJ";
  if (lang === "en") {
    if (!needsEn) return false;
    return sop.language === "ENG" || sop.language === "ENG-GUJ";
  }
  if (!needsGu) return false;
  if (sop.language === "GUJ") return true;
  return getFileSlots(sop).pdf.gu;
}

/** Ensure legacy/cached registry rows have `fileSlots` and `annexures` before UI use. */
export function normalizeRegistrySop(sop: RegistrySOP): RegistrySOP {
  const withSlots = sop.fileSlots?.docx && sop.fileSlots?.pdf ? sop : { ...sop, fileSlots: getFileSlots(sop) };
  const withCompliance = {
    ...withSlots,
    complianceAnalyzed: withSlots.complianceAnalyzed ?? false,
    complianceDone: withSlots.complianceDone ?? false,
    complianceBypassed: withSlots.complianceBypassed ?? false,
  };
  if (withCompliance.annexures && withCompliance.requiredAnnexures !== undefined) return withCompliance;
  return {
    ...withCompliance,
    annexures: withCompliance.annexures ?? [],
    requiredAnnexures: withCompliance.requiredAnnexures ?? [],
  };
}

function hasFile(links: { en?: string; gu?: string }, lang: "en" | "gu") {
  return Boolean(links[lang]);
}

export function asMediaArray(value?: string | string[]): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value.filter(Boolean) : value ? [value] : [];
}

function pushMediaUrl(bucket: { en: string[]; gu: string[] }, key: "en" | "gu", ...urls: string[]) {
  for (const url of urls) {
    if (!url || bucket[key].includes(url)) continue;
    bucket[key].push(url);
  }
}

function collectMediaUrls(records: ISOP[]) {
  const videos = { en: [] as string[], gu: [] as string[] };
  const slides = { en: [] as string[], gu: [] as string[] };
  let thumbnail: string | undefined;

  for (const record of records) {
    if (record.mediaLinks?.thumbnail) thumbnail = record.mediaLinks.thumbnail;
    pushMediaUrl(videos, "en", ...asMediaArray(record.mediaLinks?.videos?.en));
    pushMediaUrl(videos, "gu", ...asMediaArray(record.mediaLinks?.videos?.gu));
    pushMediaUrl(slides, "en", ...asMediaArray(record.mediaLinks?.slides?.en));
    pushMediaUrl(slides, "gu", ...asMediaArray(record.mediaLinks?.slides?.gu));

    for (const doc of record.sopDocuments ?? []) {
      const key = doc.language?.toLowerCase().startsWith("gu") ? "gu" : "en";
      const type = doc.fileType?.toLowerCase();
      if (type === "video" && doc.filePath) pushMediaUrl(videos, key, doc.filePath);
      if (type === "slide" && doc.filePath) pushMediaUrl(slides, key, doc.filePath);
    }
  }

  return {
    videos: {
      en: videos.en.length ? videos.en : undefined,
      gu: videos.gu.length ? videos.gu : undefined,
    },
    slides: {
      en: slides.en.length ? slides.en : undefined,
      gu: slides.gu.length ? slides.gu : undefined,
    },
    thumbnail,
  };
}

function collectMedia(records: ISOP[]) {
  const { videos, slides } = collectMediaUrls(records);
  return {
    videos: { en: videos.en?.length ?? 0, gu: videos.gu?.length ?? 0 },
    slides: { en: slides.en?.length ?? 0, gu: slides.gu?.length ?? 0 },
  };
}

export function buildEditFormData(group: ISOP[]): EditSOPFormData {
  const currentVersion = maxVersionInGroup(group);
  const currentRecords = recordsForVersion(group, currentVersion);
  const sorted = [...currentRecords].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const primary = sorted[0] ?? group[0];
  const english =
    currentRecords.find((r) => r.language !== "Gujarati") ??
    group.find((r) => r.language !== "Gujarati") ??
    primary;
  const gujarati =
    currentRecords.find((r) => r.language === "Gujarati") ??
    group.find((r) => r.language === "Gujarati");
  const files = collectVersionFiles(currentRecords);
  const media = collectMediaUrls(currentRecords);
  const language = resolveLanguage(currentRecords.length ? currentRecords : group);
  const expiryDate = primary.expiryDate ?? english.expiryDate ?? gujarati?.expiryDate;

  return {
    identifier: primary.identifier,
    recordIds: group.map((r) => r._id.toString()),
    name: english.name,
    nameGujarati: gujarati?.name !== english.name ? gujarati?.name : undefined,
    department: primary.department,
    location: primary.location,
    version: currentVersion,
    language,
    owner: primary.owner,
    effectiveDate: primary.effectiveDate?.toISOString(),
    expiryDate: expiryDate?.toISOString(),
    reviewDate: primary.reviewDate?.toISOString(),
    processArea: primary.processArea,
    guidelineReference: primary.guidelineReference,
    remarks: primary.remarks,
    files,
    videos: media.videos,
    slides: media.slides,
    thumbnail: media.thumbnail,
  };
}

function parseOptionalDate(value?: string | null): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function langLabel(key: "en" | "gu"): "English" | "Gujarati" {
  return key === "gu" ? "Gujarati" : "English";
}

export async function applyRegistryUpdate(group: ISOP[], payload: EditSOPPayload) {
  const currentVersion = maxVersionInGroup(group);
  const currentRecords = recordsForVersion(group, currentVersion);
  const currentIds = new Set(currentRecords.map((r) => r._id.toString()));
  const sopBaseId = baseIdentifierFromIdentifier(payload.identifier);
  const resolvedVersion = resolveVersionForRecord(payload.identifier, payload.version);
  const versionNum = versionNumber(resolvedVersion);

  const mediaLinks = {
    videos: {
      en: payload.videos.en?.length ? payload.videos.en : undefined,
      gu: payload.videos.gu?.length ? payload.videos.gu : undefined,
    },
    slides: {
      en: payload.slides.en?.length ? payload.slides.en : undefined,
      gu: payload.slides.gu?.length ? payload.slides.gu : undefined,
    },
    thumbnail: payload.thumbnail?.trim() || undefined,
  };

  for (const record of group) {
    const isGujarati = record.language === "Gujarati";
    const recordName =
      isGujarati && payload.nameGujarati?.trim()
        ? payload.nameGujarati.trim()
        : payload.name;
    const isCurrent = currentIds.has(record._id.toString());

    if (isCurrent) {
      const fileKey = langKey(record.language);
      const fileUrl =
        record.fileType === "docx"
          ? payload.files.docx[fileKey]?.trim()
          : record.fileType === "pdf"
            ? payload.files.pdf[fileKey]?.trim()
            : undefined;

      const lang = langLabel(fileKey);
      const fileDocs = buildFileDocuments(payload).filter(
        (doc) => doc.language === lang && doc.fileType === record.fileType,
      );
      const mediaDocs = buildMediaDocuments(payload);
      const preservedDocs = (record.sopDocuments ?? []).filter((doc) => {
        const type = doc.fileType?.toLowerCase();
        return type !== "docx" && type !== "pdf";
      });
      const sopDocuments = [...preservedDocs, ...fileDocs, ...mediaDocs];

      await record.updateOne({
        name: recordName,
        identifier: payload.identifier.trim(),
        department: payload.department,
        location: payload.location?.trim() || undefined,
        version: resolvedVersion,
        sopBaseId,
        versionNum,
        owner: payload.owner?.trim() || undefined,
        effectiveDate: parseOptionalDate(payload.effectiveDate),
        expiryDate: parseOptionalDate(payload.expiryDate),
        reviewDate: parseOptionalDate(payload.reviewDate),
        processArea: payload.processArea?.trim() || undefined,
        guidelineReference: payload.guidelineReference?.trim() || undefined,
        remarks: payload.remarks?.trim() || undefined,
        mediaLinks,
        ...(fileUrl ? { fileUrl } : {}),
        sopDocuments,
      });
    } else {
      await record.updateOne({
        name: recordName,
        department: payload.department,
        location: payload.location?.trim() || undefined,
        guidelineReference: payload.guidelineReference?.trim() || undefined,
      });
    }
  }
}

function buildFileDocuments(payload: EditSOPPayload) {
  const docs: NonNullable<ISOP["sopDocuments"]> = [];
  (["en", "gu"] as const).forEach((key) => {
    const lang = langLabel(key);
    const docx = payload.files.docx[key]?.trim();
    const pdf = payload.files.pdf[key]?.trim();
    if (docx) {
      docs.push({ filePath: docx, fileType: "docx", language: lang, fileName: `${payload.identifier}.docx` });
    }
    if (pdf) {
      docs.push({ filePath: pdf, fileType: "pdf", language: lang, fileName: `${payload.identifier}.pdf` });
    }
  });
  return docs;
}

function buildMediaDocuments(payload: EditSOPPayload) {
  const docs: NonNullable<ISOP["sopDocuments"]> = [];
  (["en", "gu"] as const).forEach((key) => {
    const lang = langLabel(key);
    for (const [index, video] of (payload.videos[key] ?? []).entries()) {
      const url = video.trim();
      if (!url) continue;
      docs.push({
        filePath: url,
        fileType: "video",
        language: lang,
        fileName: `${payload.identifier}-video-${index + 1}`,
      });
    }
    for (const [index, slide] of (payload.slides[key] ?? []).entries()) {
      const url = slide.trim();
      if (!url) continue;
      docs.push({
        filePath: url,
        fileType: "slide",
        language: lang,
        fileName: `${payload.identifier}-slide-${index + 1}`,
      });
    }
  });
  return docs;
}

function mergeSopDocuments(
  existing: NonNullable<ISOP["sopDocuments"]>,
  updated: NonNullable<ISOP["sopDocuments"]>,
) {
  const preserved = existing.filter((doc) => {
    const type = doc.fileType?.toLowerCase();
    return type !== "docx" && type !== "pdf" && type !== "video" && type !== "slide";
  });
  return [...preserved, ...updated];
}

export async function markRegistryObsolete(group: ISOP[], reason = "Moved to Obsolete SOPs") {
  const now = new Date();
  await Promise.all(
    group.map((record) =>
      record.updateOne({
        isObsolete: true,
        obsoleteAt: now,
        obsoleteReason: reason,
      }),
    ),
  );
}

/**
 * Reverse {@link markRegistryObsolete}: return an SOP family to active status so
 * it reappears in the main registry. Clears the obsolete bookkeeping fields.
 */
export async function reviveRegistryGroup(group: ISOP[]) {
  await Promise.all(
    group.map((record) =>
      record.updateOne({
        isObsolete: false,
        $unset: { obsoleteAt: "", obsoleteReason: "" },
      }),
    ),
  );
}

/**
 * Permanently remove every record in an SOP family from the database. Unlike
 * {@link markRegistryObsolete}, this is irreversible — the records (all versions
 * and languages) are deleted outright. Stored files on the CDN are left intact;
 * this only purges the registry rows.
 *
 * Callers that also need files-import manifest / archive cleanup should invoke
 * `clearImportStateAfterPermanentDelete` from a server-only route (do not import
 * sop-files-import here — this module is used by client components).
 */
export async function deleteRegistryGroup(group: ISOP[]) {
  await Promise.all(group.map((record) => record.deleteOne()));
}

export function groupSOPRecords(records: ISOP[]): RegistrySOP[] {
  const grouped = new Map<string, ISOP[]>();

  for (const record of records) {
    const key = sopGroupKey(record);
    const existing = grouped.get(key) ?? [];
    existing.push(record);
    grouped.set(key, existing);
  }

  const result: RegistrySOP[] = [];

  for (const [, group] of grouped) {
    const currentVersion = maxVersionInGroup(group);
    const currentRecords = recordsForVersion(group, currentVersion);
    const sorted = [...currentRecords].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const primary = sorted[0] ?? group[0];
    const versionRecords = currentRecords.length ? currentRecords : group;
    const files = collectVersionFiles(versionRecords);
    const annexures = collectAnnexures(versionRecords);
    const requiredAnnexures = collectRequiredAnnexures(versionRecords);
    const fileSlots = currentVersionFileSlots(versionRecords);
    const language = resolveLanguage(versionRecords);
    const expiryDate = pickFamilyDate(currentRecords.length ? currentRecords : group, "expiryDate");
    const effectiveDate = pickFamilyDate(currentRecords.length ? currentRecords : group, "effectiveDate");
    const uploadedAt = currentRecords.reduce(
      (latest, r) =>
        new Date(r.uploadedAt) > new Date(latest) ? r.uploadedAt.toISOString() : latest,
      primary.uploadedAt.toISOString(),
    );

    const hasVersion = group.some((r) => r.version || versionFromIdentifier(r.identifier));

    const { prior: priorVersions, archived: archivedVersions } = buildPriorVersions(
      group,
      currentVersion,
      language,
    );
    // Version date = prior-version DOCX header dates in the registry window (Prior Versions column).
    const priorDates = priorDocxHeaderDatesOk(priorVersions, language);
    const hasVersionDateEn = priorDates.en;
    const hasVersionDateGu = priorDates.gu;
    const hasVersionDate = priorDates.all;

    const displayIdentifier =
      currentRecords.find((r) => {
        const fromId = versionFromIdentifier(r.identifier);
        return fromId && versionNumber(fromId) === versionNumber(currentVersion);
      })?.identifier ?? primary.identifier;

    const resolved = resolveSopFamilyNames(versionRecords, displayIdentifier);

    result.push({
      id: primary._id.toString(),
      recordIds: group.map((r) => r._id.toString()),
      identifier: displayIdentifier,
      name: resolved.englishName,
      nameGujarati: resolved.gujaratiName,
      version: currentVersion,
      department: primary.department,
      location: primary.location,
      language,
      guidelineReference: primary.guidelineReference,
      expiryDate: expiryDate?.toISOString(),
      effectiveDate: effectiveDate?.toISOString(),
      uploadedAt,
      complianceStatus: primary.complianceStatus ?? "pending",
      complianceScore: complianceScoreFromStatus(primary.complianceStatus),
      complianceAnalyzed: false,
      complianceDone: false,
      complianceBypassed: false,
      pipelineStatus: primary.pipelineStatus ?? "idle",
      isObsolete: group.every((r) => r.isObsolete),
      isNew: differenceInDays(new Date(), new Date(primary.createdAt)) <= 14,
      files,
      annexures,
      requiredAnnexures,
      fileSlots,
      media: collectMedia(currentRecords),
      mediaUrls: (() => {
        const { videos, slides } = collectMediaUrls(currentRecords);
        return { videos, slides };
      })(),
      videoFileNames: currentRecords.flatMap(
        (r) => (r.sopDocuments ?? [])
          .filter((d) => d.fileType?.toLowerCase() === "video" && d.fileName)
          .map((d) => d.fileName!.toLowerCase()),
      ),
      priorVersions,
      archivedVersions,
      hasVersion,
      hasVersionDate,
      hasVersionDateEn,
      hasVersionDateGu,
      expiryTier: getExpiryTier(expiryDate),
      mcqCount: currentRecords.reduce((sum, r) => sum + (r.mcqCount ?? 0), 0),
    });
  }

  return result;
}

/**
 * The prior-revision numbers an SOP at `currentNum` is REQUIRED to keep on file:
 * the two revisions immediately preceding the current one, down to the original v0.
 *   • a v5 SOP must hold V4 and V3
 *   • a v2 SOP must hold V1 and V0
 *   • a v1 SOP must hold V0
 *   • a v0 SOP has no required prior
 *
 * This is the SINGLE source of truth used by both the Found/Not-Found status
 * (priorVersionsComplete) and the per-version "missing" markers (buildPriorVersions),
 * so the two can never disagree as SOPs are added, edited, or deleted.
 */
function requiredPriorVersionNumbers(currentNum: number): number[] {
  return [currentNum - 1, currentNum - 2].filter((n) => n >= 0);
}

type PriorVersionEntry = {
  version: string;
  language: string;
  docx?: string;
  pdf?: string;
  missing?: boolean;
  /** DOCX header EFF. DATE / REVIEW DT. pair is missing, empty, invalid, or illogical. */
  docxDateError?: boolean;
};

/**
 * Split an SOP family's superseded revisions into two buckets:
 *   • `prior`    — the two revisions immediately preceding the current one. These stay in
 *                  the active SOP Registry's "Prior Versions" column (e.g. V12 keeps V11, V10).
 *   • `archived` — every revision older than that window (e.g. V9 and below). These are NOT
 *                  deleted; they are surfaced in the Prior Version Archive as historical
 *                  records, with all their files and metadata intact.
 *
 * A revision automatically moves from `prior` to `archived` the moment a newer version is
 * uploaded and pushes it outside the two-revision window — no deletion, no migration.
 */
function buildPriorVersions(group: ISOP[], currentVersion: string, language = "ENG") {
  const isDual = language === "ENG-GUJ";
  const currentNum = versionNumber(currentVersion);
  // Revisions with versionNum >= keptThreshold (and below current) stay in the registry;
  // anything older is archived. keptThreshold = currentNum - 2 keeps exactly V-1 and V-2.
  const keptThreshold = currentNum - 2;

  // Collect every uploaded prior-version file, keyed by "<versionNum>-<lang>".
  const uploaded = new Map<
    string,
    {
      versionNum: number;
      version: string;
      lang: string;
      docx?: string;
      pdf?: string;
      headerDatesValid?: boolean;
    }
  >();
  // An active family may carry obsolete leftovers that share a (versionNum, language)
  // with a live record — e.g. a stale zero-padded duplicate (PREG21-00 vs PREG21-0) from
  // before a department/version reconcile. These collide on the `${num}-${lang}` key below
  // and, because the merge is last-write-wins, an obsolete record iterated later overwrites
  // the live file link AND its header-date flag — surfacing as a stale preview and a false
  // "Version Date Missing". Skip obsolete records here so only live files supply prior slots.
  // (Fully-obsolete families keep their records so the Obsolete view still shows prior files.)
  const familyHasActive = group.some((r) => !r.isObsolete);
  for (const record of group) {
    if (familyHasActive && record.isObsolete) continue;
    const num = recordVersionNum(record);
    if (num >= currentNum) continue;
    const lang = record.language === "Gujarati" ? "GUJ" : "ENG";
    const key = `${num}-${lang}`;
    const entry = uploaded.get(key) ?? { versionNum: num, version: recordVersion(record), lang };
    applyRecordFileLinks(record, entry);
    if (record.fileType === "docx") {
      entry.headerDatesValid = record.headerDatesValid;
    }
    uploaded.set(key, entry);
  }

  const prior: PriorVersionEntry[] = [];
  const archived: PriorVersionEntry[] = [];

  for (const { versionNum, version, lang, docx, pdf, headerDatesValid } of uploaded.values()) {
    if (!docx && !pdf) continue;
    const inPriorWindow = versionNum >= keptThreshold;
    const docxDateError = inPriorWindow && Boolean(docx && headerDatesValid !== true);
    const entry: PriorVersionEntry = { version, language: lang, docx, pdf, docxDateError };
    if (inPriorWindow) prior.push(entry);
    else archived.push(entry);
  }

  // The registry must hold the two revisions immediately preceding the current one, and
  // EACH required language must hold them independently. For a dual-language SOP both the
  // English and Gujarati copies of each required revision must exist (complete docx + pdf);
  // a missing Gujarati translation is flagged on its own row, not masked by the English
  // copy. Any required (language, revision) that has no complete file on file is marked
  // "missing" so the SOP is Not Found and the specific version number is shown as missing.
  // Required revisions are always inside the kept window, so missing markers live in `prior`.
  const requiredLangs = isDual ? ["ENG", "GUJ"] : [language === "GUJ" ? "GUJ" : "ENG"];
  const requiredVersions = requiredPriorVersionNumbers(currentNum);
  for (const lang of requiredLangs) {
    const completeForLang = new Set(
      prior
        .filter((pv) => pv.language === lang && pv.docx && pv.pdf)
        .map((pv) => versionNumber(pv.version)),
    );
    for (const n of requiredVersions) {
      if (completeForLang.has(n)) continue;
      const existsForLang = prior.some(
        (pv) => pv.language === lang && versionNumber(pv.version) === n,
      );
      if (!existsForLang) prior.push({ version: String(n), language: lang, missing: true });
    }
  }

  // Newest first — guarantees correct descending order for every language independently.
  const byVersionDesc = (a: PriorVersionEntry, b: PriorVersionEntry) =>
    versionNumber(b.version) - versionNumber(a.version);
  return { prior: prior.sort(byVersionDesc), archived: archived.sort(byVersionDesc) };
}

/**
 * Whether every prior-version DOCX in the registry window for one language has valid
 * header dates (EFF. DATE / REVIEW DT.). Mirrors the green/red DOCX links in Prior Versions.
 * SOPs with no prior DOCX slots for that language are treated as valid (nothing to flag).
 */
function priorDocxHeaderDatesOkForLang(
  priorVersions: PriorVersionEntry[],
  lang: "ENG" | "GUJ",
): boolean {
  const docxSlots = priorVersions.filter(
    (pv) => pv.language === lang && pv.docx && !pv.missing,
  );
  return docxSlots.every((pv) => !pv.docxDateError);
}

function priorDocxHeaderDatesOk(
  priorVersions: PriorVersionEntry[],
  language: LanguageCode,
): { en: boolean; gu: boolean; all: boolean } {
  const needsEn = language === "ENG" || language === "ENG-GUJ";
  const needsGu = language === "GUJ" || language === "ENG-GUJ";
  const en = !needsEn || priorDocxHeaderDatesOkForLang(priorVersions, "ENG");
  const gu = !needsGu || priorDocxHeaderDatesOkForLang(priorVersions, "GUJ");
  return { en, gu, all: en && gu };
}

/**
 * Whether an SOP's prior-version history is complete for the Found / Not Found status.
 *
 * Only the TWO revisions immediately preceding the current one are required — older
 * revisions (3rd-newest and beyond) never affect the status, even if they are incomplete.
 * EACH required language must independently hold every required revision as a complete
 * docx + pdf: for a dual-language (ENG-GUJ) SOP, both the English AND Gujarati copies of
 * each required revision must exist, so a missing translation makes the SOP Not Found.
 */
function priorVersionsCompleteForLang(sop: RegistrySOP, lang: "ENG" | "GUJ"): boolean {
  const requiredVersions = requiredPriorVersionNumbers(versionNumber(sop.version));
  if (requiredVersions.length === 0) return true;
  const completeNums = new Set(
    sop.priorVersions
      .filter((pv) => pv.language === lang && Boolean(pv.docx) && Boolean(pv.pdf))
      .map((pv) => versionNumber(pv.version)),
  );
  return requiredVersions.every((n) => completeNums.has(n));
}

function priorVersionsComplete(sop: RegistrySOP): boolean {
  const requiredLangs =
    sop.language === "ENG-GUJ" ? ["ENG", "GUJ"] : [sop.language === "GUJ" ? "GUJ" : "ENG"];
  return requiredLangs.every((lang) => priorVersionsCompleteForLang(sop, lang as "ENG" | "GUJ"));
}

function sopRequiresAnnexures(s: RegistrySOP): boolean {
  return (s.requiredAnnexures?.length ?? 0) > 0;
}

function annexuresComplete(s: RegistrySOP): boolean {
  const required = s.requiredAnnexures ?? [];
  if (!required.length) return true;
  const present = collectPresentAnnexureRomans(
    (s.annexures ?? []).map((a) => ({ label: a.label, fileName: a.fileName })),
  );
  return required.every((r) => present.has(r));
}

export function applyFilters(items: RegistrySOP[], filters: SOPFilters): RegistrySOP[] {
  let result = [...items];

  if (filters.archiveView) {
    // Prior Version Archive: active families that have superseded revisions on file.
    result = result.filter((s) => !s.isObsolete && s.archivedVersions.length > 0);
  } else if (filters.obsoleteOnly) {
    result = result.filter((s) => s.isObsolete);
  } else {
    result = result.filter((s) => !s.isObsolete);
  }

  if (filters.department && filters.department !== "All" && filters.department !== "Total") {
    result = result.filter((s) => s.department === filters.department);
  }

  if (filters.language && filters.language !== "All") {
    result = result.filter((s) => {
      if (filters.language === "ENG-GUJ") return s.language === "ENG-GUJ";
      if (filters.language === "ENG")
        return s.language === "ENG" || s.language === "ENG-GUJ";
      if (filters.language === "GUJ")
        return s.language === "GUJ" || s.language === "ENG-GUJ";
      return true;
    });
  }

  if (filters.dualLanguage) {
    result = result.filter((s) => s.language === "ENG-GUJ");
  }

  if (filters.expiry && filters.expiry !== "All") {
    result = result.filter((s) => {
      if (filters.expiry === "Expired") return s.expiryTier === "expired";
      if (filters.expiry === "Near") return s.expiryTier === "high";
      if (filters.expiry === "Medium") return s.expiryTier === "medium";
      if (filters.expiry === "Low") return s.expiryTier === "low";
      if (filters.expiry === "No Date") return s.expiryTier === "none";
      return true;
    });
  }

  if (filters.complianceDone === "Yes") {
    result = result.filter((s) => s.complianceDone);
  } else if (filters.complianceDone === "No") {
    result = result.filter((s) => !s.complianceDone);
  }

  if (filters.complianceBypassed === "Yes") {
    result = result.filter((s) => s.complianceBypassed);
  } else if (filters.complianceBypassed === "No") {
    result = result.filter((s) => !s.complianceBypassed);
  }

  if (filters.fileType) {
    // Version-section lang pills reuse fileType labels; versionStatus handles those.
    const versionLangFileType =
      filters.versionStatus &&
      ["Needs EN", "Needs GJ", "EN DOCX", "GJ DOCX", "EN PDF", "GJ PDF"].includes(filters.fileType);
    if (!versionLangFileType) {
      result = result.filter((s) => matchFileType(s, filters.fileType!));
    }
  }

  if (filters.media) {
    result = result.filter((s) => matchMedia(s, filters.media!, filters.language));
  }

  if (filters.videoType) {
    result = result.filter((s) => matchVideoType(s, filters.videoType!));
  }

  if (filters.versionStatus === "found" || filters.versionStatus === "missing") {
    const isVersionComplete = (s: RegistrySOP): boolean => {
      if (filters.language === "ENG") return priorVersionsCompleteForLang(s, "ENG");
      if (filters.language === "GUJ") return priorVersionsCompleteForLang(s, "GUJ");
      if (filters.fileType === "Needs EN" || filters.fileType === "EN DOCX" || filters.fileType === "EN PDF") {
        return priorVersionsCompleteForLang(s, "ENG");
      }
      if (filters.fileType === "Needs GJ" || filters.fileType === "GJ DOCX" || filters.fileType === "GJ PDF") {
        return priorVersionsCompleteForLang(s, "GUJ");
      }
      return priorVersionsComplete(s);
    };
    if (filters.versionStatus === "found") {
      result = result.filter(isVersionComplete);
    } else {
      result = result.filter((s) => !isVersionComplete(s));
    }
  }

  if (filters.annexureStatus === "found" || filters.annexureStatus === "missing") {
    if (filters.annexureStatus === "found") {
      result = result.filter((s) => sopRequiresAnnexures(s) && annexuresComplete(s));
    } else {
      result = result.filter((s) => sopRequiresAnnexures(s) && !annexuresComplete(s));
    }
  }

  if (filters.versionDate === "found" || filters.versionDate === "missing") {
    // Mirror the capsule's per-language counts: when a single language is selected, judge that
    // language's dates; otherwise require every language the SOP needs (combined flag).
    const dateOk = (s: RegistrySOP): boolean =>
      filters.language === "ENG"
        ? s.hasVersionDateEn
        : filters.language === "GUJ"
          ? s.hasVersionDateGu
          : s.hasVersionDate;
    result = result.filter((s) => (filters.versionDate === "found" ? dateOk(s) : !dateOk(s)));
  }

  if (filters.absoluteSop) {
    result = result.filter(
      (s) =>
        hasFile(s.files.docx, "en") &&
        hasFile(s.files.pdf, "en") &&
        s.hasVersion &&
        s.hasVersionDate &&
        s.expiryTier !== "none",
    );
  }

  if (filters.dateFrom) {
    const from = parseISO(filters.dateFrom);
    result = result.filter((s) => !isBefore(parseISO(s.uploadedAt), from));
  }

  if (filters.dateTo) {
    const to = parseISO(filters.dateTo);
    result = result.filter((s) => !isAfter(parseISO(s.uploadedAt), to));
  }

  if (filters.locations?.length) {
    result = result.filter((s) => s.location && filters.locations!.includes(s.location));
  }

  if (filters.search) {
    const q = filters.search.toLowerCase();
    const field = filters.searchField ?? "All";
    result = result.filter((s) => {
      const targets: Record<string, string> = {
        All: `${s.identifier} ${s.name} ${s.nameGujarati ?? ""} ${s.department} ${s.location ?? ""}`,
        "SOP No": s.identifier,
        Name: `${s.name} ${s.nameGujarati ?? ""}`,
        Department: s.department,
        Location: s.location ?? "",
      };
      return (targets[field] ?? targets.All).toLowerCase().includes(q);
    });
  }

  return sortRegistry(result, filters.sortBy, filters.sortDir);
}

function matchFileType(s: RegistrySOP, fileType: string): boolean {
  switch (fileType) {
    case "DOCX":
      return (!docxRequiredForLang(s, "en") || Boolean(s.files.docx.en))
        && (!docxRequiredForLang(s, "gu") || Boolean(s.files.docx.gu));
    case "No DOCX":
      return (docxRequiredForLang(s, "en") && !s.files.docx.en)
        || (docxRequiredForLang(s, "gu") && !s.files.docx.gu);
    case "EN DOCX":    return docxRequiredForLang(s, "en") && Boolean(s.files.docx.en);
    case "No EN DOCX": return docxRequiredForLang(s, "en") && !s.files.docx.en;
    case "GJ DOCX":    return docxRequiredForLang(s, "gu") && Boolean(s.files.docx.gu);
    case "No GJ DOCX": return docxRequiredForLang(s, "gu") && !s.files.docx.gu;
    case "PDF":
      return (!pdfRequiredForLang(s, "en") || Boolean(s.files.pdf.en))
        && (!pdfRequiredForLang(s, "gu") || Boolean(s.files.pdf.gu));
    case "No PDF":
      return (pdfRequiredForLang(s, "en") && !s.files.pdf.en)
        || (pdfRequiredForLang(s, "gu") && !s.files.pdf.gu);
    case "EN PDF":     return pdfRequiredForLang(s, "en") && Boolean(s.files.pdf.en);
    case "No EN PDF":  return pdfRequiredForLang(s, "en") && !s.files.pdf.en;
    case "GJ PDF":     return pdfRequiredForLang(s, "gu") && Boolean(s.files.pdf.gu);
    case "No GJ PDF":  return pdfRequiredForLang(s, "gu") && !s.files.pdf.gu;
    case "Needs EN":   return s.language === "ENG" || s.language === "ENG-GUJ";
    case "Needs GJ":   return s.language === "GUJ" || s.language === "ENG-GUJ";
    default:           return true;
  }
}

function matchMedia(s: RegistrySOP, media: string, language?: string): boolean {
  const needsEn = s.language === "ENG" || s.language === "ENG-GUJ";
  const needsGu = s.language === "GUJ" || s.language === "ENG-GUJ";

  // Per-language pills (ENG / GUJ rows) — mirror buildCapsule video/slide counts.
  if (language === "ENG") {
    switch (media) {
      case "Video":
        return needsEn && s.media.videos.en > 0;
      case "No Video":
        return needsEn && s.media.videos.en === 0;
      case "Slides":
        return needsEn && s.media.slides.en > 0;
      case "No Slides":
        return needsEn && s.media.slides.en === 0;
      case "No Media":
        return needsEn && s.media.videos.en === 0 && s.media.slides.en === 0;
      default:
        return true;
    }
  }
  if (language === "GUJ") {
    switch (media) {
      case "Video":
        return needsGu && s.media.videos.gu > 0;
      case "No Video":
        return needsGu && s.media.videos.gu === 0;
      case "Slides":
        return needsGu && s.media.slides.gu > 0;
      case "No Slides":
        return needsGu && s.media.slides.gu === 0;
      case "No Media":
        return needsGu && s.media.videos.gu === 0 && s.media.slides.gu === 0;
      default:
        return true;
    }
  }

  const videoCount = s.media.videos.en + s.media.videos.gu;
  const slideCount = s.media.slides.en + s.media.slides.gu;
  switch (media) {
    case "Video":
      return videoCount > 0;
    case "No Video":
      return videoCount === 0;
    case "Slides":
      return slideCount > 0;
    case "No Slides":
      return slideCount === 0;
    case "No Media":
      return videoCount === 0 && slideCount === 0;
    default:
      return true;
  }
}

function hasVideoKeyword(sop: RegistrySOP, keyword: string): boolean {
  const strs = [
    ...(sop.mediaUrls?.videos?.en ?? []).map((u) => u.toLowerCase()),
    ...(sop.mediaUrls?.videos?.gu ?? []).map((u) => u.toLowerCase()),
    ...(sop.videoFileNames ?? []),
  ];
  return strs.some((s) => s.includes(keyword));
}

function matchVideoType(s: RegistrySOP, videoType: string): boolean {
  switch (videoType) {
    case "Explainer": return hasVideoKeyword(s, "explainer");
    case "No Explainer": return !hasVideoKeyword(s, "explainer");
    case "Brief": return hasVideoKeyword(s, "brief");
    case "No Brief": return !hasVideoKeyword(s, "brief");
    default: return true;
  }
}

function deptOrderCompare(a: string, b: string): number {
  const ai = DEPARTMENT_ORDER.indexOf(a);
  const bi = DEPARTMENT_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
}

function sortRegistry(
  items: RegistrySOP[],
  sortBy = "department",
  sortDir: "asc" | "desc" = "asc",
): RegistrySOP[] {
  const dir = sortDir === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    const compare = (x: string | number, y: string | number) =>
      x < y ? -1 * dir : x > y ? 1 * dir : 0;

    switch (sortBy) {
      case "name":
        return compare(a.name.toLowerCase(), b.name.toLowerCase());
      case "department": {
        const deptCmp = deptOrderCompare(a.department, b.department) * dir;
        return deptCmp !== 0 ? deptCmp : a.identifier.localeCompare(b.identifier);
      }
      case "location":
        return compare(a.location ?? "", b.location ?? "");
      case "version":
        return compare(parseFloat(a.version) || 0, parseFloat(b.version) || 0);
      case "expiryDate":
        return compare(a.expiryDate ?? "", b.expiryDate ?? "");
      case "language":
        return compare(a.language, b.language);
      case "complianceScore":
        return compare(
          a.complianceAnalyzed ? a.complianceScore : -1,
          b.complianceAnalyzed ? b.complianceScore : -1,
        );
      case "complianceDone":
        return compare(Number(Boolean(a.complianceDone)), Number(Boolean(b.complianceDone)));
      case "complianceBypassed":
        return compare(Number(Boolean(a.complianceBypassed)), Number(Boolean(b.complianceBypassed)));
      case "uploadedAt":
        return compare(a.uploadedAt, b.uploadedAt);
      default:
        return compare(a.identifier, b.identifier);
    }
  });
}

export function paginate<T>(items: T[], page = 1, limit = 50): { items: T[]; total: number } {
  const start = (page - 1) * limit;
  return { items: items.slice(start, start + limit), total: items.length };
}

function emptyLangPair() {
  return { found: 0, missing: 0, en: { found: 0, missing: 0 }, gu: { found: 0, missing: 0 } };
}

function buildCapsule(department: string, sops: RegistrySOP[]): DepartmentCapsule {
  const needsEn = (s: RegistrySOP) => s.language === "ENG" || s.language === "ENG-GUJ";
  const needsGu = (s: RegistrySOP) => s.language === "GUJ" || s.language === "ENG-GUJ";

  const capsule: DepartmentCapsule = {
    department,
    total: sops.length,
    dualLanguage: sops.filter((s) => s.language === "ENG-GUJ").length,
    withEn: sops.filter(needsEn).length,
    withGu: sops.filter(needsGu).length,
    expired: sops.filter((s) => s.expiryTier === "expired").length,
    nearExpiry: sops.filter((s) => s.expiryTier === "high").length,
    active: sops.filter((s) => s.expiryTier !== "expired" && s.expiryTier !== "none").length,
    noDate: sops.filter((s) => s.expiryTier === "none").length,
    docx: emptyLangPair(),
    pdf: emptyLangPair(),
    version: {
      found: 0,
      missing: 0,
      docx: { en: { found: 0, missing: 0 }, gu: { found: 0, missing: 0 } },
      pdf: { en: { found: 0, missing: 0 }, gu: { found: 0, missing: 0 } },
    },
    versionDate: {
      found: 0,
      missing: 0,
      en: { found: 0, missing: 0 },
      gu: { found: 0, missing: 0 },
    },
    annexures: { found: 0, missing: 0 },
    videos: {
      available: 0,
      required: sops.length,
      missing: 0,
      en: { available: 0, missing: 0 },
      gu: { available: 0, missing: 0 },
    },
    explainerVideos: { found: 0, missing: 0 },
    briefVideos: { found: 0, missing: 0 },
    slides: {
      available: 0,
      required: sops.length,
      missing: 0,
      en: { available: 0, missing: 0 },
      gu: { available: 0, missing: 0 },
    },
  };

  for (const sop of sops) {
    // Language-specific DOCX/PDF — red (missing) only when a slot is required and empty.
    for (const [type, files] of [
      ["docx", sop.files.docx],
      ["pdf", sop.files.pdf],
    ] as const) {
      const bucket = type === "docx" ? capsule.docx : capsule.pdf;
      const requiredFor = type === "docx" ? docxRequiredForLang : pdfRequiredForLang;
      for (const lang of ["en", "gu"] as const) {
        if (!requiredFor(sop, lang)) continue;
        if (hasFile(files, lang)) bucket[lang].found++;
        else bucket[lang].missing++;
      }
      const allRequiredPresent =
        (!requiredFor(sop, "en") || hasFile(files, "en"))
        && (!requiredFor(sop, "gu") || hasFile(files, "gu"));
      if (allRequiredPresent) bucket.found++;
      else bucket.missing++;
    }

    // Prior-version history only — current DOCX/PDF slots are tracked in the DOCX/PDF rows above.
    if (priorVersionsComplete(sop)) {
      capsule.version.found++;
    } else {
      capsule.version.missing++;
    }
    if (needsEn(sop)) {
      if (priorVersionsCompleteForLang(sop, "ENG")) {
        capsule.version.docx.en.found++;
        capsule.version.pdf.en.found++;
      } else {
        capsule.version.docx.en.missing++;
        capsule.version.pdf.en.missing++;
      }
    }
    if (needsGu(sop)) {
      if (priorVersionsCompleteForLang(sop, "GUJ")) {
        capsule.version.docx.gu.found++;
        capsule.version.pdf.gu.found++;
      } else {
        capsule.version.docx.gu.missing++;
        capsule.version.pdf.gu.missing++;
      }
    }

    // SOP-level: prior DOCX header dates valid for every required language (Prior Versions column).
    if (sop.hasVersionDate) capsule.versionDate.found++;
    else capsule.versionDate.missing++;
    // Per-language: each language is judged on its own prior DOCX header dates.
    if (needsEn(sop)) {
      if (sop.hasVersionDateEn) capsule.versionDate.en.found++;
      else capsule.versionDate.en.missing++;
    }
    if (needsGu(sop)) {
      if (sop.hasVersionDateGu) capsule.versionDate.gu.found++;
      else capsule.versionDate.gu.missing++;
    }

    if (sopRequiresAnnexures(sop)) {
      if (annexuresComplete(sop)) capsule.annexures.found++;
      else capsule.annexures.missing++;
    }

    // Found / Not Found are SOP counts (not raw file counts) so each pair sums to
    // the dataset size — the master count for the overall row, and the number of
    // SOPs that require a language for the ENG/GUJ rows. This keeps the panel
    // aligned with the dashboard's active SOP total instead of mixing units.
    const hasEnVideo = sop.media.videos.en > 0;
    const hasGuVideo = sop.media.videos.gu > 0;
    const hasAnyVideo = hasEnVideo || hasGuVideo;
    const hasEnSlide = sop.media.slides.en > 0;
    const hasGuSlide = sop.media.slides.gu > 0;
    const hasAnySlide = hasEnSlide || hasGuSlide;

    capsule.videos.available += hasAnyVideo ? 1 : 0;
    capsule.videos.missing += hasAnyVideo ? 0 : 1;
    capsule.videos.en.available += needsEn(sop) && hasEnVideo ? 1 : 0;
    capsule.videos.en.missing += needsEn(sop) && !hasEnVideo ? 1 : 0;
    capsule.videos.gu.available += needsGu(sop) && hasGuVideo ? 1 : 0;
    capsule.videos.gu.missing += needsGu(sop) && !hasGuVideo ? 1 : 0;

    capsule.slides.available += hasAnySlide ? 1 : 0;
    capsule.slides.missing += hasAnySlide ? 0 : 1;
    capsule.slides.en.available += needsEn(sop) && hasEnSlide ? 1 : 0;
    capsule.slides.en.missing += needsEn(sop) && !hasEnSlide ? 1 : 0;
    capsule.slides.gu.available += needsGu(sop) && hasGuSlide ? 1 : 0;
    capsule.slides.gu.missing += needsGu(sop) && !hasGuSlide ? 1 : 0;

    const allVideoStrings = [
      ...(sop.mediaUrls?.videos?.en ?? []).map((u) => u.toLowerCase()),
      ...(sop.mediaUrls?.videos?.gu ?? []).map((u) => u.toLowerCase()),
      ...(sop.videoFileNames ?? []),
    ];
    const hasExplainer = allVideoStrings.some((s) => s.includes("explainer"));
    const hasBrief = allVideoStrings.some((s) => s.includes("brief"));
    if (hasExplainer) capsule.explainerVideos.found++;
    else capsule.explainerVideos.missing++;
    if (hasBrief) capsule.briefVideos.found++;
    else capsule.briefVideos.missing++;
  }

  return capsule;
}

export function buildDashboardStats(registry: RegistrySOP[], extraDepartments: string[] = []): DashboardStats {
  const active = registry.filter((s) => !s.isObsolete);
  const sopDepts = [...new Set(active.map((s) => s.department))].filter(
    (d) => d && !EXCLUDED_DASHBOARD_DEPT.has(d.toLowerCase()),
  );
  const extras = extraDepartments.filter(
    (d) => d && !EXCLUDED_DASHBOARD_DEPT.has(d.toLowerCase()),
  );
  const departments = sortByDeptOrder([...new Set([...sopDepts, ...extras])]);
  const deptCapsules = departments.map((d) =>
    buildCapsule(d, active.filter((s) => s.department === d)),
  );

  return {
    totalSops: active.length,
    expired: active.filter((s) => s.expiryTier === "expired").length,
    nearExpiry: active.filter((s) => s.expiryTier === "high").length,
    mediumExpiry: active.filter((s) => s.expiryTier === "medium").length,
    lowExpiry: active.filter((s) => s.expiryTier === "low").length,
    noDate: active.filter((s) => s.expiryTier === "none").length,
    videosUploaded: active.reduce((s, r) => s + r.media.videos.en + r.media.videos.gu, 0),
    slidesUploaded: active.reduce((s, r) => s + r.media.slides.en + r.media.slides.gu, 0),
    guidelinesTotal: active.filter((s) => s.guidelineReference).length,
    guidelinesAnalyzed: active.filter((s) => s.complianceStatus !== "pending").length,
    departments: [buildCapsule("Total", active), ...deptCapsules],
    priorVersionCount: active.reduce(
      (s, r) => s + r.priorVersions.filter((pv) => !pv.missing).length,
      0,
    ),
    archivedVersionCount: active.filter((r) => r.archivedVersions.length > 0).length,
  };
}

export function formatUploaded(dateStr: string) {
  return format(parseISO(dateStr), "dd MMM yyyy HH:mm");
}

export function parseFiltersFromSearchParams(params: URLSearchParams): SOPFilters {
  return {
    search: params.get("search") ?? undefined,
    searchField: params.get("searchField") ?? "All",
    department: params.get("department") ?? undefined,
    language: params.get("language") ?? undefined,
    fileType: params.get("fileType") ?? undefined,
    media: params.get("media") ?? undefined,
    videoType: params.get("videoType") ?? undefined,
    expiry: params.get("expiry") ?? undefined,
    complianceDone: params.get("complianceDone") ?? undefined,
    complianceBypassed: params.get("complianceBypassed") ?? undefined,
    versionStatus: params.get("versionStatus") ?? undefined,
    versionDate: params.get("versionDate") ?? undefined,
    annexureStatus: params.get("annexureStatus") ?? undefined,
    dualLanguage: params.get("dualLanguage") === "true",
    absoluteSop: params.get("absoluteSop") === "true",
    obsoleteOnly: params.get("obsoleteOnly") === "true",
    archiveView: params.get("archiveView") === "true",
    dateFrom: params.get("dateFrom") ?? undefined,
    dateTo: params.get("dateTo") ?? undefined,
    locations: params.getAll("location"),
    sortBy: params.get("sortBy") ?? "department",
    sortDir: (params.get("sortDir") as "asc" | "desc") ?? "asc",
    page: parseInt(params.get("page") ?? "1", 10),
    limit: parseInt(params.get("limit") ?? "50", 10),
  };
}

export function defaultExpiryDate(months = 24): Date {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return date;
}

/** Base SOP code without the version suffix (e.g. PEGE11-11 → PEGE11, QA-DP-01 → QA-DP). */
export function baseIdentifierFromIdentifier(identifier: string): string {
  const code = identifier.trim().toUpperCase().replace(/_/g, "-");
  if (!code) return code;

  const hyphenated = code.match(/^([A-Z]{2,}[A-Z0-9]*)-\d+$/);
  if (hyphenated) return hyphenated[1];

  const segmented = code.match(/^([A-Z]{2,}-[A-Z]{2,})-\d+$/);
  if (segmented) return segmented[1];

  return code;
}

/**
 * Match all identifier variants for the same SOP family (e.g. PEGE11, PEGE11-09,
 * PEGE11-11). The document number is matched leading-zero-insensitively so the
 * family resolves to the SAME record set the registry groups for display
 * ({@link sopFamilyGroupKey} treats QAGE01-11 ≡ QAGE1-11). If this regex were
 * stricter than the grouping, an obsolete/revive/edit action would touch only
 * some of a family's rows and the registry — which marks a family obsolete only
 * when `group.every(r => r.isObsolete)` — would snap it back to active on reload.
 */
export function sopFamilyIdentifierRegex(identifier: string): RegExp {
  const base = baseIdentifierFromIdentifier(identifier);
  // Split a trailing document number off the base so QAGE01 and QAGE1 collapse:
  // emit `LETTERS0*N` so any zero-padding of the doc number matches.
  const docMatch = base.match(/^(.*?)(\d+)$/);
  if (docMatch) {
    const prefix = docMatch[1].replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const docNum = String(parseInt(docMatch[2], 10));
    return new RegExp(`^${prefix}0*${docNum}(-\\d+)?$`, "i");
  }
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`^${escaped}(-\\d+)?$`, "i");
}

/** SOP codes like QAGE01-11 encode the version in the suffix after the final hyphen segment. */
export function versionFromIdentifier(identifier: string): string | null {
  const code = identifier.trim().toUpperCase().replace(/_/g, "-");
  if (!code) return null;

  const hyphenated = code.match(/^[A-Z]{2,}[A-Z0-9]*-(\d+)$/);
  if (hyphenated) return hyphenated[1];

  const segmented = code.match(/^[A-Z]{2,}-[A-Z]{2,}-(\d+)$/);
  if (segmented) return segmented[1];

  return null;
}

export function resolveSopVersion(identifier: string, storedVersion?: string | null): string {
  return resolveVersionForRecord(identifier, storedVersion);
}

/** Extract SOP code from a folder/filename segment (e.g. "PEGE01-10 - Title" → PEGE01-10). */
export function extractSopCodeFromSegment(segment: string): string | null {
  const trimmed = segment.trim();
  const hyphenated = trimmed.match(/^([A-Z]{2,}[A-Z0-9]*-\d+)/i);
  if (hyphenated && isPlausibleSopDocumentCode(hyphenated[1])) {
    return hyphenated[1].toUpperCase().replace(/_/g, "-");
  }
  const segmented = trimmed.match(/^([A-Z]{2,}-[A-Z]{2,}-\d+)/i);
  if (segmented && isPlausibleSopDocumentCode(segmented[1])) {
    return segmented[1].toUpperCase().replace(/_/g, "-");
  }
  return null;
}

export function titleFromFolderSegment(segment: string, sopCode: string): string | null {
  const codePattern = sopCode.replace(/[-]/g, String.raw`[\s_-]`);
  const stripped = segment
    .trim()
    .replace(new RegExp(`^${codePattern}[\\s_\\-–]+`, "i"), "")
    .trim();
  return stripped || null;
}

/**
 * True for real plant SOP codes (PEGE22-03, QAGE01-09).
 * False for facility/site labels that only look similar (WADHWAN-2, SITE-1).
 */
export function isPlausibleSopDocumentCode(raw: string): boolean {
  const u = String(raw || "")
    .toUpperCase()
    .replace(/_/g, "-")
    .trim();
  if (!u) return false;
  // All-letter base + hyphen + number → site/facility name, not an SOP no.
  if (/^[A-Z]{2,}-\d+$/.test(u)) return false;
  // Standard: letters + document index digits + revision (PEGE22-03, PRCL24-0)
  if (/^[A-Z]{2,6}\d+-\d+$/.test(u)) return true;
  // Segmented: XX-YY-N
  if (/^[A-Z]{2,}-[A-Z]{2,}-\d+$/.test(u)) return true;
  const last = u.lastIndexOf("-");
  if (last <= 0) return false;
  const base = u.slice(0, last);
  const rev = u.slice(last + 1);
  return /^\d+$/.test(rev) && /[0-9]/.test(base) && /^[A-Z][A-Z0-9]*$/i.test(base);
}

/** Collect plausible SOP codes embedded in a filename/path/title string. */
export function extractSopIdentifierCandidates(text: string): string[] {
  const matches = [
    ...String(text || "").matchAll(/([A-Z]{2,}[A-Z0-9]*-\d+|[A-Z]{2,}-[A-Z]{2,}-\d+)/gi),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of matches) {
    const raw = m[1].toUpperCase().replace(/_/g, "-");
    if (!isPlausibleSopDocumentCode(raw)) continue;
    const key = normalizeSopIdentifierKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/** Prefer the real SOP code in long names (never facility labels like WADHWAN-2). */
export function pickBestSopIdentifierFromText(text: string): string | undefined {
  const candidates = extractSopIdentifierCandidates(text);
  return candidates[0];
}

export function extractIdentifierFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  const fromSegment = extractSopCodeFromSegment(base);
  if (fromSegment) return fromSegment;
  const best = pickBestSopIdentifierFromText(base);
  if (best) return best;
  return "";
}

const FOLDER_DEPARTMENT_ALIASES: Record<string, string> = {
  qa: "QA",
  "quality assurance": "QA",
  qc: "QC",
  "quality control": "QC",
  microbiology: "Microbiology",
  micro: "Microbiology",
  production: "Production",
  prod: "Production",
  store: "Store",
  stores: "Store",
  engineering: "Engineering and Maintenance",
  maintenance: "Engineering and Maintenance",
  "engineering and maintenance": "Engineering and Maintenance",
  "e&m": "Engineering and Maintenance",
  personnel: "Personnel",
  hr: "Personnel",
};

/** SOP subcategory prefix → department (e.g. MAGE01-05, MAGE - General). */
const SUBCAT_TO_DEPT: Record<string, string> = {
  QAGE: "QA",
  ANNE: "QA",
  QCGE: "QC",
  QAIC: "QC",
  QAIO: "QC",
  QAMI: "Microbiology",
  QCMI: "Microbiology",
  PRAA: "Production",
  PRCL: "Production",
  PRED: "Production",
  PREO: "Production",
  PREP: "Production",
  PRGE: "Production",
  PRMA: "Production",
  PRPA: "Production",
  BSGE: "Store",
  STCL: "Store",
  STGE: "Store",
  STOP: "Store",
  STPA: "Store",
  STRM: "Store",
  MAGE: "Engineering and Maintenance",
  PREG: "Engineering and Maintenance",
  PEGE: "Personnel",
};

const IDENTIFIER_DEPARTMENT_RULES: { pattern: RegExp; department: string }[] = [
  { pattern: /^QA[A-Z0-9]/i, department: "QA" },
  { pattern: /^QC[A-Z0-9]/i, department: "QC" },
  { pattern: /^MIC[A-Z0-9]/i, department: "Microbiology" },
  { pattern: /^MI[A-Z0-9]/i, department: "Microbiology" },
  { pattern: /^(PROD|PRD|PD)[A-Z0-9]/i, department: "Production" },
  { pattern: /^(STR|STOR|BS)[A-Z0-9]/i, department: "Store" },
  { pattern: /^(ENG|EM|MAGE|PREG)[A-Z0-9]/i, department: "Engineering and Maintenance" },
  { pattern: /^(PER|PE)[A-Z0-9]/i, department: "Personnel" },
];

function normalizeFolderDepartment(segment: string): string | null {
  const cleaned = segment.trim().replace(/[_]+/g, " ");
  const key = cleaned.toLowerCase();
  if (FOLDER_DEPARTMENT_ALIASES[key]) return FOLDER_DEPARTMENT_ALIASES[key];

  for (const [alias, department] of Object.entries(FOLDER_DEPARTMENT_ALIASES)) {
    if (key === alias || key.startsWith(`${alias} `) || key.endsWith(` ${alias}`)) {
      return department;
    }
  }

  return null;
}

/** Strip leading "7. " numbering and take the label before " - Title". */
function cleanDeptFolderLabel(segment: string): string {
  const stripped = segment
    .trim()
    .replace(/[_]+/g, " ")
    .replace(/^\d+[.)]\s*/, "")
    .trim();
  // Prefer split on spaced dash (SOP folder titles); keep hyphenated codes intact.
  const spaced = stripped.split(/\s+[-–]\s+/)[0]?.trim();
  return spaced || stripped;
}

const JUNK_DEPT_FOLDER_NAMES = new Set([
  "versions",
  "version",
  "english",
  "gujarati",
  "eng",
  "guj",
  "annexure",
  "annexures",
  "uploads",
  "files",
  "docx",
  "pdf",
  "prior",
  "obsolete",
  "archive",
  "media",
  "videos",
  "slides",
]);

// Local mirror of dashboard junk buckets (avoid circular import).
const EXCLUDED_DASHBOARD_DEPT = new Set(["other", "unknown", "general", "total", ""]);

function isJunkDeptFolderLabel(label: string): boolean {
  const key = label.trim().toLowerCase();
  if (!key || JUNK_DEPT_FOLDER_NAMES.has(key)) return true;
  if (/^v\d+(\.\d+)?$/i.test(key)) return true;
  if (EXCLUDED_DASHBOARD_DEPT.has(key)) return true;
  // File names are not department folders.
  if (/\.(docx?|pdf|xlsx?|pptx?|zip|mp4|webm)$/i.test(key)) return true;
  return false;
}

function isLikelySopDocumentFolder(segment: string): boolean {
  return Boolean(
    extractSopCodeFromSegment(segment) || pickBestSopIdentifierFromText(segment),
  );
}

function matchKnownDepartment(label: string, knownDepartments?: string[]): string | null {
  if (!knownDepartments?.length || !label.trim()) return null;
  const key = label.trim().toLowerCase();
  return knownDepartments.find((d) => d.trim().toLowerCase() === key) ?? null;
}

export function departmentFromIdentifier(identifier: string): string | null {
  const code = identifier.trim().toUpperCase().replace(/_/g, "-");
  if (!code) return null;

  const subcatMatch = code.match(/^([A-Z]{2,6})\d/);
  if (subcatMatch && SUBCAT_TO_DEPT[subcatMatch[1]]) {
    return SUBCAT_TO_DEPT[subcatMatch[1]];
  }
  for (let len = 6; len >= 2; len--) {
    const prefix = code.slice(0, len);
    if (SUBCAT_TO_DEPT[prefix]) return SUBCAT_TO_DEPT[prefix];
  }

  for (const rule of IDENTIFIER_DEPARTMENT_RULES) {
    if (rule.pattern.test(code)) return rule.department;
  }

  return null;
}

export function departmentFromRelativePath(
  relativePath: string,
  knownDepartments?: string[],
): string | null {
  const segments = relativePath.split(/[/\\]/).filter(Boolean);
  for (const segment of segments) {
    const label = cleanDeptFolderLabel(segment);

    const direct = normalizeFolderDepartment(segment) ?? normalizeFolderDepartment(label);
    if (direct && direct !== "General") return direct;

    const known = matchKnownDepartment(label, knownDepartments);
    if (known) return known;

    const folderLabel = segment.split(/\s*[-–]\s*/)[0]?.trim() ?? segment;
    const fromCode = departmentFromIdentifier(folderLabel);
    if (fromCode) return fromCode;

    if (/^qa\b/i.test(segment)) return "QA";
    if (/^qc\b/i.test(segment)) return "QC";
    if (/microbiology/i.test(segment)) return "Microbiology";
    if (/production/i.test(segment)) return "Production";
    if (/\bstore\b/i.test(segment)) return "Store";
    if (/engineering|maintenance/i.test(segment)) return "Engineering and Maintenance";
    if (/personnel/i.test(segment)) return "Personnel";

    // Custom department folders (e.g. abcd/SOP-file.docx) — use the exact folder name.
    if (!isLikelySopDocumentFolder(segment) && !isJunkDeptFolderLabel(label) && label.length >= 2) {
      return label;
    }
  }

  return null;
}

export function resolveDepartmentFromUpload(opts: {
  relativePath?: string;
  identifier?: string;
  batchOverride?: string;
  /** DEPARTMENT value extracted from the SOP document header. */
  contentDepartment?: string;
  /** Persisted / dashboard department names — preserves exact casing for custom depts. */
  knownDepartments?: string[];
}): string {
  if (opts.batchOverride?.trim()) {
    const override = opts.batchOverride.trim();
    const aliased = FOLDER_DEPARTMENT_ALIASES[override.toLowerCase()];
    if (aliased) return aliased;
    const known = matchKnownDepartment(override, opts.knownDepartments);
    if (known) return known;
    return override;
  }

  // Prefer the department written inside the document over path/code heuristics.
  if (opts.contentDepartment?.trim()) {
    const fromDoc = opts.contentDepartment.trim();
    const aliased = FOLDER_DEPARTMENT_ALIASES[fromDoc.toLowerCase()];
    if (aliased) return aliased;
    const known = matchKnownDepartment(fromDoc, opts.knownDepartments);
    if (known) return known;
    return fromDoc;
  }

  if (opts.relativePath) {
    const fromPath = departmentFromRelativePath(opts.relativePath, opts.knownDepartments);
    if (fromPath) return fromPath;
  }

  if (opts.identifier) {
    const fromId = departmentFromIdentifier(opts.identifier);
    if (fromId) return fromId;
  }

  return "General";
}

export function fileUrlToRelativePath(fileUrl?: string): string | undefined {
  if (!fileUrl?.trim()) return undefined;
  try {
    const raw = fileUrl.trim();
    const path = raw.startsWith("http://") || raw.startsWith("https://")
      ? new URL(raw).pathname
      : raw;
    return path.replace(/^\/?uploads\/?/i, "").replace(/^\//, "");
  } catch {
    return fileUrl;
  }
}

/** Re-resolve department for records already in the database. */
export function resolveDepartmentForExistingSop(
  sop: {
    identifier: string;
    folderPath?: string;
    fileUrl?: string;
    originalFileName?: string;
    deptManualOverride?: boolean;
    /** Pre-extracted DEPARTMENT header value (from document content). */
    contentDepartment?: string;
  },
  knownDepartments?: string[],
): string | null {
  if (sop.deptManualOverride) return null;

  if (sop.contentDepartment?.trim()) {
    const raw = sop.contentDepartment.trim();
    const aliased = FOLDER_DEPARTMENT_ALIASES[raw.toLowerCase()];
    if (aliased) return aliased;
    const known = matchKnownDepartment(raw, knownDepartments);
    if (known) return known;
    return raw;
  }

  const fromId = departmentFromIdentifier(sop.identifier);
  if (fromId) return fromId;

  const pathCandidates = [
    sop.folderPath,
    fileUrlToRelativePath(sop.fileUrl),
    sop.originalFileName,
  ].filter(Boolean) as string[];

  for (const candidate of pathCandidates) {
    const fromPath = departmentFromRelativePath(candidate, knownDepartments);
    if (fromPath && fromPath !== "General") return fromPath;
  }

  return null;
}

export function parseUploadPathMetadata(relativePath: string) {
  const segments = relativePath.split(/[/\\]/).filter(Boolean);
  const fileName = segments.at(-1) ?? relativePath;
  const folderPath = segments.length > 1 ? segments.slice(0, -1).join("/") : undefined;
  const parentFolder = segments.length > 2 ? segments.at(-2) : undefined;
  const folderSegments = segments.slice(0, -1);

  const vFolderIndex = folderSegments.findIndex((s) => /^v\d+(\.\d+)?$/i.test(s.trim()));
  const versionFromVFolder =
    vFolderIndex >= 0 ? folderSegments[vFolderIndex].trim().replace(/^v/i, "") : undefined;

  let identifierFromPath: string | undefined;
  let titleFromPath: string | undefined;

  if (versionFromVFolder && vFolderIndex > 0) {
    for (let i = vFolderIndex - 1; i >= 0; i--) {
      const code = extractSopCodeFromSegment(folderSegments[i]);
      if (code) {
        identifierFromPath = code;
        titleFromPath = titleFromFolderSegment(folderSegments[i], code) ?? undefined;
        break;
      }
    }
  }

  if (!identifierFromPath) {
    for (let i = folderSegments.length - 1; i >= 0; i--) {
      const code = extractSopCodeFromSegment(folderSegments[i]);
      if (code) {
        identifierFromPath = code;
        titleFromPath = titleFromFolderSegment(folderSegments[i], code) ?? undefined;
        break;
      }
    }
  }

  const versionFromFolder = identifierFromPath
    ? versionFromIdentifier(identifierFromPath) ?? undefined
    : undefined;

  return {
    fileName,
    folderPath,
    parentFolder,
    identifierFromPath,
    titleFromPath,
    versionFromPath: versionFromVFolder ?? versionFromFolder,
  };
}

/** Resolve the canonical version label for a record. */
export function resolveVersionForRecord(
  identifier: string,
  storedVersion?: string | null,
  pathVersion?: string | null,
): string {
  const fromPath = pathVersion?.trim();
  if (fromPath) return fromPath;

  const rawFromId = versionFromIdentifier(identifier);
  // Normalise to remove leading zeros (e.g. "05" → "5") so display matches expectations.
  const fromId = rawFromId != null ? String(parseInt(rawFromId, 10)) : null;
  const stored = storedVersion?.trim();
  if (fromId) {
    if (!stored || stored === "1.0" || versionNumber(stored) === versionNumber(fromId)) {
      return fromId;
    }
    return stored;
  }

  return stored ?? "1.0";
}

export function sopVersionFields(identifier: string, storedVersion?: string | null, pathVersion?: string | null) {
  const normalized = normalizeSopIdentifierKey(identifier);
  const version = resolveVersionForRecord(normalized, storedVersion, pathVersion);
  return {
    version,
    sopBaseId: baseIdentifierFromIdentifier(normalized),
    versionNum: versionNumber(version),
  };
}

// Lines that are never the SOP title — skip them when scanning document text.
const TITLE_SKIP = /^(standard\s+operating\s+procedure|document\s+(no|number|title)|sop\s+(no|number|title)|revision|version\s+no|date\s+of|effective\s+date|approved\s+by|prepared\s+by|reviewed\s+by|page\s+\d|confidential|internal\s+use|copy\s+no|objective\s*:?\s*)$/i;

function stripLeadingSopCodeFromLine(line: string, identifier: string): string {
  let s = line.trim();
  const sopBase = baseIdentifierFromIdentifier(identifier);
  const escapedBase = sopBase.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  s = s.replace(new RegExp(`^[A-Z]{2,}[A-Z0-9]*-\\d+[\\s_:\\-–]*`, "i"), "").trim();
  s = s.replace(new RegExp(`^${escapedBase}[\\s_:\\-–]*`, "i"), "").trim();
  return s;
}

function normalizeTitleLine(line: string): string {
  if (line === line.toUpperCase() && /[A-Z]{2}/.test(line)) {
    return line
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return line;
}

function lineLooksLikeTitle(
  line: string,
  language: "English" | "Gujarati",
): boolean {
  if (line.length < 4 || line.length > 160) return false;
  if (TITLE_SKIP.test(line)) return false;
  if (/^\d+[\s.]/.test(line)) return false;
  if (language === "Gujarati") return hasGujaratiScript(line);
  return !hasGujaratiScript(line) && /[a-zA-Z]{3}/.test(line);
}

/**
 * Pull the title from the header "SUBJECT :" field — the document's own,
 * authoritative title. Stops at the next header cell label so trailing
 * EFF. DATE / SUPERSEDES / page-number text isn't captured.
 */
function extractSubjectTitle(content: string): string | null {
  // English "SUBJECT" and Gujarati "વિષય"; stop at the next header cell label
  // (English EFF. DATE / SUPERSEDES … or Gujarati લાગુ પડેલ / ફેર ચકાસણી / રદ કરેલ).
  const match = content.match(
    /(?:SUBJECT|વિષય)\s*:?\s*(.+?)\s*(?:EFF\.?\s*DATE|REVIEW\s*DT\.?|SUPERSEDES|PAGE\s*NO\.?|PREPARED\s*BY|SOP\s*NO\.?|લાગુ?\s*પડેલ?|ફેર\s*ચકાસણી|રદ\s*કરેલ|બનાવનાર|$)/i,
  );
  const title = match?.[1]?.replace(/\s+/g, " ").trim();
  return title && title.length >= 3 ? title : null;
}

/**
 * Extract the SOP title from the first meaningful lines of extracted document text.
 * Returns null when no reliable title is found.
 */
export function extractTitleFromContent(
  content: string,
  identifier: string,
  language: "English" | "Gujarati" = "English",
): string | null {
  if (!content || content.startsWith("[")) return null;

  // The header SUBJECT field is the authoritative title; prefer it over the
  // body heuristic (which otherwise grabs the OBJECTIVE sentence).
  const subject = extractSubjectTitle(content);
  if (subject && lineLooksLikeTitle(subject, language)) {
    return normalizeTitleLine(subject);
  }

  const sopBase = baseIdentifierFromIdentifier(identifier).toUpperCase();

  const lines = content
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  for (const rawLine of lines.slice(0, 30)) {
    let line = stripLeadingSopCodeFromLine(rawLine, identifier);
    if (!line) continue;
    if (line.toUpperCase() === sopBase) continue;
    if (!lineLooksLikeTitle(line, language)) continue;
    return normalizeTitleLine(line);
  }

  return null;
}

/** Derive the display name for a single language-specific SOP record. */
export function deriveSopRecordName(opts: {
  identifier: string;
  language: "English" | "Gujarati";
  fileType: "pdf" | "docx";
  content?: string;
  originalFileName?: string;
  titleFromPath?: string | null;
  explicitName?: string | null;
}): string {
  const { identifier, language, fileType } = opts;
  const candidates: Array<string | null | undefined> = [
    opts.explicitName?.trim(),
    opts.titleFromPath?.trim(),
    fileType === "docx" && opts.content
      ? extractTitleFromContent(opts.content, identifier, language)
      : null,
    opts.originalFileName ? nameFromFilename(opts.originalFileName) : "",
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    const cleaned = cleanSopDisplayName(raw);
    if (
      !cleaned ||
      isPlaceholderSopName(cleaned, identifier) ||
      !nameMatchesLanguage(cleaned, language)
    ) {
      continue;
    }
    return cleaned;
  }

  return identifier;
}

