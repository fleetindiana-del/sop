import type { RegistrySOP } from "@/lib/types";
import { normalizeSopIdentifierKey } from "@/lib/sopIdentifierNormalize";
import { sopFamilyGroupKey, versionFromIdentifier } from "@/lib/sop-utils";

// ── Subcategory prefix → canonical department (aligned with Dashboard / TM) ──
export const MCQ_SUBCAT_TO_DEPT: Record<string, string> = {
  QAGE: "QA", ANNE: "QA",
  QCGE: "QC", QAIC: "QC", QAIO: "QC",
  QAMI: "Microbiology", QCMI: "Microbiology",
  PRAA: "Production", PRCL: "Production", PRED: "Production",
  PREO: "Production", PREP: "Production", PRGE: "Production",
  PRMA: "Production", PRPA: "Production",
  BSGE: "Store", STCL: "Store", STGE: "Store",
  STOP: "Store", STPA: "Store", STRM: "Store",
  MAGE: "Engineering and Maintenance", PREG: "Engineering and Maintenance",
  PEGE: "Personnel",
};

export const MCQ_DEPARTMENT_ORDER = [
  "QA", "QC", "Microbiology", "Production",
  "Store", "Engineering and Maintenance", "Personnel",
];

export function mcqDeptFromIdentifier(id?: string | null): string {
  if (!id) return "Other";
  const up = id.toUpperCase().trim();
  const m = up.match(/^([A-Z]{2,6})\d/);
  if (m && MCQ_SUBCAT_TO_DEPT[m[1]]) return MCQ_SUBCAT_TO_DEPT[m[1]];
  for (let len = 6; len >= 2; len--) {
    const pfx = up.slice(0, len);
    if (MCQ_SUBCAT_TO_DEPT[pfx]) return MCQ_SUBCAT_TO_DEPT[pfx];
  }
  return "Other";
}

export function mcqNormalizeDeptName(raw?: string | null): string {
  if (!raw) return "Other";
  const lower = raw.toLowerCase().trim();
  if (/\bqa\b|quality.?assur/.test(lower)) return "QA";
  if (/\bqc\b|quality.?cont/.test(lower)) return "QC";
  if (/micro/.test(lower)) return "Microbiology";
  if (/engineer|maint/.test(lower)) return "Engineering and Maintenance";
  if (/person|\bhr\b/.test(lower)) return "Personnel";
  if (/store/.test(lower)) return "Store";
  if (/prod/.test(lower)) return "Production";
  return "Other";
}

export function mcqResolveDept(identifier: string, storedDept?: string | null): string {
  const fromId = mcqDeptFromIdentifier(identifier);
  if (fromId !== "Other") return fromId;
  return mcqNormalizeDeptName(storedDept);
}

export interface ActiveSopFamily {
  dept: string;
  languages: Set<string>;
  processAreas: Set<string>;
  name: string;
  identifier: string;
}

/** Active SOP families keyed by {@link sopFamilyGroupKey} — same universe as the Dashboard. */
export function buildActiveSopFamilyMap(rows: RegistrySOP[]): Map<string, ActiveSopFamily> {
  const map = new Map<string, ActiveSopFamily>();
  for (const row of rows) {
    if (row.isObsolete) continue;
    const famKey = sopFamilyGroupKey(row);
    const dept = mcqResolveDept(row.identifier, row.department);
    if (dept === "Other") continue;
    if (!map.has(famKey)) {
      map.set(famKey, {
        dept,
        languages: new Set<string>(),
        processAreas: new Set<string>(),
        name: row.name,
        identifier: row.identifier,
      });
    }
    const entry = map.get(famKey)!;
    if (row.language === "ENG" || row.language === "ENG-GUJ") entry.languages.add("English");
    if (row.language === "GUJ" || row.language === "ENG-GUJ") entry.languages.add("Gujarati");
  }
  return map;
}

export interface AggregatedMcqFamily {
  famKey: string;
  identifier: string;
  sopName: string;
  dept: string;
  totalQ: number;
  checkedQ: number;
  reviewedQ: number;
  similarQ: number;
  /** Questions present in the English bank (used for per-language completeness). */
  enQ: number;
  /** Questions present in the Gujarati bank (used for per-language completeness). */
  guQ: number;
  hasEn: boolean;
  hasGu: boolean;
  /** True when the Gujarati questions counted above are translations carried on the
   *  English masters rather than a standalone Gujarati bank. */
  guFromTranslations: boolean;
  lastUpdated: Date | null;
  banks: { id: string; langCode: "ENG" | "GUJ" }[];
}

export interface RawMcqBankAgg {
  _id: unknown;
  sopIdentifier: string;
  sopName?: string;
  department?: string;
  language: string;
  totalQuestions: number;
  checkedCount: number;
  reviewedCount: number;
  similarCount: number;
  updatedAt?: Date;
  /** Questions on this (English) bank that carry a Gujarati translation. */
  guTranslatedCount?: number;
  guTranslatedChecked?: number;
  guTranslatedReviewed?: number;
  guTranslatedSimilar?: number;
}

/**
 * A Gujarati translation stored on an English master is the same question rendered
 * in Gujarati. When a family has no separate Gujarati bank, those translations ARE
 * its Gujarati set, so every count that asks "how many Gujarati MCQs?" must see
 * them — otherwise the registry reads 0 while the viewer shows 100.
 *
 * Spread into a bank `$project` stage; the counts are 0 on banks with no
 * translations (Gujarati banks included), so folding is unconditional.
 */
function countTranslatedGu(extraCond?: Record<string, unknown>) {
  const isTranslated = { $ne: [{ $ifNull: ["$$q.translations.gu", null] }, null] };
  return {
    $size: {
      $filter: {
        input: { $ifNull: ["$mcqs", []] },
        as: "q",
        cond: extraCond ? { $and: [isTranslated, extraCond] } : isTranslated,
      },
    },
  };
}

export const guTranslatedProjection = {
  guTranslatedCount: countTranslatedGu(),
  guTranslatedChecked: countTranslatedGu({ $eq: ["$$q.isChecked", true] }),
  guTranslatedReviewed: countTranslatedGu({ $eq: ["$$q.isReviewed", true] }),
  guTranslatedSimilar: countTranslatedGu({ $eq: ["$$q.isSimilar", true] }),
  guTranslatedEasy: countTranslatedGu({ $eq: ["$$q.difficulty", "Easy"] }),
  guTranslatedMedium: countTranslatedGu({ $eq: ["$$q.difficulty", "Medium"] }),
  guTranslatedHard: countTranslatedGu({ $eq: ["$$q.difficulty", "Hard"] }),
};

export type McqBankLangCode = "ENG" | "GUJ";

export function mcqBankLangCode(language: string | undefined | null): McqBankLangCode {
  return String(language ?? "").toLowerCase() === "gujarati" ? "GUJ" : "ENG";
}

export interface CanonicalMcqBankPick {
  sopIdentifier: string;
  language?: string | null;
  totalQuestions?: number;
  updatedAt?: Date | string | null;
}

function bankRevisionNum(identifier: string): number {
  return parseInt(versionFromIdentifier(identifier) ?? "", 10) || 0;
}

function bankUpdatedMs(updatedAt?: Date | string | null): number {
  if (!updatedAt) return 0;
  const t = new Date(updatedAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

function identifiersMatch(a: string, b: string): boolean {
  const na = normalizeSopIdentifierKey(a);
  const nb = normalizeSopIdentifierKey(b);
  return Boolean(na) && na === nb;
}

/**
 * Choose one active bank per language for a SOP family.
 *
 * Prior versions (QAGE20-5 vs QAGE20-6) used to be summed, so the registry
 * showed 190 while opening the current bank showed 90. Prefer a bank that
 * matches `preferredIdentifier` (the Dashboard current revision); otherwise
 * take the newest revision.
 */
export function selectCanonicalBanksByLang<T extends CanonicalMcqBankPick>(
  banks: T[],
  preferredIdentifier?: string | null,
): T[] {
  const preferred = (preferredIdentifier ?? "").trim();
  const best = new Map<McqBankLangCode, T>();
  for (const b of banks) {
    const lang = mcqBankLangCode(b.language);
    const prev = best.get(lang);
    if (!prev || isBetterCanonicalMcqBank(b, prev, preferred)) best.set(lang, b);
  }
  return [...best.values()];
}

export function isBetterCanonicalMcqBank(
  candidate: CanonicalMcqBankPick,
  current: CanonicalMcqBankPick,
  preferredIdentifier?: string | null,
): boolean {
  const preferred = (preferredIdentifier ?? "").trim();
  if (preferred) {
    const candMatch = identifiersMatch(candidate.sopIdentifier, preferred);
    const curMatch = identifiersMatch(current.sopIdentifier, preferred);
    if (candMatch !== curMatch) return candMatch;
  }
  const candRev = bankRevisionNum(candidate.sopIdentifier);
  const curRev = bankRevisionNum(current.sopIdentifier);
  if (candRev !== curRev) return candRev > curRev;
  const candTs = bankUpdatedMs(candidate.updatedAt);
  const curTs = bankUpdatedMs(current.updatedAt);
  if (candTs !== curTs) return candTs > curTs;
  return (candidate.totalQuestions ?? 0) > (current.totalQuestions ?? 0);
}

/** Collapse raw MCQ bank rows into one entry per SOP family key. */
export function aggregateMcqBanksByFamily(
  rawBanks: RawMcqBankAgg[],
  preferredIdentifierByFam?: Map<string, string>,
): Map<string, AggregatedMcqFamily> {
  const grouped = new Map<string, RawMcqBankAgg[]>();
  for (const b of rawBanks) {
    const rawId = (b.sopIdentifier ?? "").trim();
    const famKey = sopFamilyGroupKey({ identifier: rawId });
    const dept = mcqResolveDept(rawId, b.department);
    if (dept === "Other") continue;
    const list = grouped.get(famKey);
    if (list) list.push(b);
    else grouped.set(famKey, [b]);
  }

  const map = new Map<string, AggregatedMcqFamily>();
  for (const [famKey, banks] of grouped) {
    const preferred = preferredIdentifierByFam?.get(famKey);
    const canonical = selectCanonicalBanksByLang(banks, preferred);
    const first = canonical[0] ?? banks[0];
    const rawId = (first.sopIdentifier ?? "").trim();
    const e: AggregatedMcqFamily = {
      famKey,
      identifier: preferred || rawId,
      sopName: first.sopName ?? rawId,
      dept: mcqResolveDept(rawId, first.department),
      totalQ: 0,
      checkedQ: 0,
      reviewedQ: 0,
      similarQ: 0,
      enQ: 0,
      guQ: 0,
      hasEn: false,
      hasGu: false,
      guFromTranslations: false,
      lastUpdated: null,
      banks: [],
    };
    let guTranslated = 0;
    let guTranslatedChecked = 0;
    let guTranslatedReviewed = 0;
    let guTranslatedSimilar = 0;
    for (const b of canonical) {
      e.totalQ += b.totalQuestions;
      e.checkedQ += b.checkedCount;
      e.reviewedQ += b.reviewedCount;
      e.similarQ += b.similarCount;
      if (mcqBankLangCode(b.language) === "GUJ") {
        e.hasGu = true;
        e.guQ += b.totalQuestions;
      } else {
        e.hasEn = true;
        e.enQ += b.totalQuestions;
        guTranslated += b.guTranslatedCount ?? 0;
        guTranslatedChecked += b.guTranslatedChecked ?? 0;
        guTranslatedReviewed += b.guTranslatedReviewed ?? 0;
        guTranslatedSimilar += b.guTranslatedSimilar ?? 0;
      }
      if (b._id) e.banks.push({ id: String(b._id), langCode: mcqBankLangCode(b.language) });
      const ts = b.updatedAt ? new Date(b.updatedAt) : null;
      if (ts && (!e.lastUpdated || ts > e.lastUpdated)) e.lastUpdated = ts;
      if (b.sopName) e.sopName = b.sopName;
    }
    // Translations only stand in for a Gujarati bank the family does not have —
    // a real Gujarati bank always wins, so the same questions are never counted twice.
    if (e.guQ === 0 && guTranslated > 0) {
      e.guQ = guTranslated;
      e.hasGu = true;
      e.guFromTranslations = true;
      e.totalQ += guTranslated;
      e.checkedQ += guTranslatedChecked;
      e.reviewedQ += guTranslatedReviewed;
      e.similarQ += guTranslatedSimilar;
    }
    map.set(famKey, e);
  }
  return map;
}

/**
 * Whether an MCQ family fully covers the language requirements of its SOP family.
 *
 * A dual-language SOP (ENG-GUJ) is only "with MCQ" when BOTH the English and the
 * Gujarati bank carry questions — if either language is missing its MCQs the SOP
 * counts as "without MCQ". A single-language SOP needs only its one language.
 * Families with no recognised language requirement fall back to "has any question".
 */
export function mcqFamilyComplete(
  required: { needsEn: boolean; needsGu: boolean },
  bank: { enQ: number; guQ: number } | undefined | null,
): boolean {
  if (!bank) return false;
  const { needsEn, needsGu } = required;
  if (!needsEn && !needsGu) return bank.enQ + bank.guQ > 0;
  if (needsEn && bank.enQ <= 0) return false;
  if (needsGu && bank.guQ <= 0) return false;
  return true;
}

/** MCQ families with no matching active SOP in the Dashboard registry. */
export function findObsoleteMcqFamilies(
  activeFamilies: Map<string, ActiveSopFamily>,
  mcqFamilies: Map<string, AggregatedMcqFamily>,
): AggregatedMcqFamily[] {
  const obsolete: AggregatedMcqFamily[] = [];
  for (const [famKey, bank] of mcqFamilies) {
    if (!activeFamilies.has(famKey)) obsolete.push(bank);
  }
  return obsolete.sort((a, b) => a.identifier.localeCompare(b.identifier));
}
