import type { Types } from "mongoose";
import SOP, { type ISOP } from "@/models/SOP";
import { hashSopContent } from "@/lib/compliance-hashes";
import {
  parseSopStructure,
  buildSectionSummary,
  type ParsedSop,
  type SopSection,
} from "@/lib/sopStructureParser";

export interface SectionHashEntry {
  sectionId: string;
  title: string;
  hash: string;
  lineStart: number;
  lineEnd: number;
}

export interface ComplianceStructureCache {
  contentHash: string;
  sectionHashes: SectionHashEntry[];
  sectionSummary: string;
  parsedAt: Date;
}

export type CachedParsedSop = {
  parsed: ParsedSop;
  sectionHashes: SectionHashEntry[];
  sectionSummary: string;
  contentHash: string;
  fromCache: boolean;
};

function sectionText(parsed: ParsedSop, section: SopSection): string {
  return parsed.lines
    .filter((l) => l.lineNumber >= section.lineStart && l.lineNumber <= section.lineEnd)
    .map((l) => l.text)
    .join("\n");
}

function buildSectionHashes(parsed: ParsedSop): SectionHashEntry[] {
  return parsed.sections.map((s) => ({
    sectionId: s.id || s.title,
    title: s.title,
    hash: hashSopContent(sectionText(parsed, s)),
    lineStart: s.lineStart,
    lineEnd: s.lineEnd,
  }));
}

export async function buildAndSaveComplianceStructureCache(
  sopId: Types.ObjectId | string,
  content: string,
): Promise<CachedParsedSop> {
  const parsed = parseSopStructure(content);
  const contentHash = hashSopContent(content);
  const sectionHashes = buildSectionHashes(parsed);
  const sectionSummary = buildSectionSummary(parsed);

  const complianceStructureCache: ComplianceStructureCache = {
    contentHash,
    sectionHashes,
    sectionSummary,
    parsedAt: new Date(),
  };

  // timestamps: false — internal parse cache; must not bust the registry
  // signature (count + newest updatedAt) used by the persistent grouped cache.
  await SOP.updateOne(
    { _id: sopId },
    { $set: { complianceStructureCache } },
    { timestamps: false },
  );

  return { parsed, sectionHashes, sectionSummary, contentHash, fromCache: false };
}

export async function getOrBuildComplianceStructure(
  sop: Pick<ISOP, "_id" | "content"> & {
    complianceStructureCache?: ComplianceStructureCache | null;
  },
): Promise<CachedParsedSop> {
  const content = sop.content ?? "";
  const contentHash = hashSopContent(content);
  const cached = sop.complianceStructureCache;

  if (
    cached?.contentHash === contentHash &&
    Array.isArray(cached.sectionHashes) &&
    cached.sectionHashes.length > 0
  ) {
    return {
      parsed: parseSopStructure(content),
      sectionHashes: cached.sectionHashes,
      sectionSummary: cached.sectionSummary ?? buildSectionSummary(parseSopStructure(content)),
      contentHash,
      fromCache: true,
    };
  }

  return buildAndSaveComplianceStructureCache(sop._id, content);
}

export function getSectionHash(
  sectionHashes: SectionHashEntry[],
  sopSection: string,
): string | null {
  const trimmed = (sopSection || "").trim();
  if (!trimmed) return null;

  const numMatch = trimmed.match(/(\d+(?:\.\d+)*)/);
  const sectionNum = numMatch?.[1];

  const byId = sectionHashes.find(
    (s) =>
      s.sectionId === sectionNum ||
      s.sectionId === trimmed ||
      trimmed.includes(s.sectionId) ||
      s.title.toLowerCase() === trimmed.toLowerCase(),
  );
  return byId?.hash ?? null;
}

export function getChangedSectionIds(
  previous: SectionHashEntry[],
  current: SectionHashEntry[],
): Set<string> {
  const prevMap = new Map(previous.map((s) => [s.sectionId, s.hash]));
  const changed = new Set<string>();

  for (const cur of current) {
    const prevHash = prevMap.get(cur.sectionId);
    if (!prevHash || prevHash !== cur.hash) changed.add(cur.sectionId);
  }

  for (const prev of previous) {
    if (!current.some((c) => c.sectionId === prev.sectionId)) changed.add(prev.sectionId);
  }

  return changed;
}

export function extractSectionText(parsed: ParsedSop, sopSection: string): string {
  const numMatch = (sopSection || "").match(/(\d+(?:\.\d+)*)/);
  const sectionNum = numMatch?.[1];

  const section = parsed.sections.find(
    (s) => s.id === sectionNum || sopSection.includes(s.title),
  );
  if (section) return sectionText(parsed, section);

  const snippet = (sopSection || "").slice(0, 80);
  const line = parsed.lines.find((l) => l.text.includes(snippet));
  if (line?.sectionId) {
    const sec = parsed.sections.find((s) => s.id === line.sectionId);
    if (sec) return sectionText(parsed, sec);
  }

  return "";
}
