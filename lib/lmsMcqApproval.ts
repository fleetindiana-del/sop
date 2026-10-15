import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import { sopFamilyGroupKey, sopFamilyIdentifierRegex } from '@/lib/sop-utils';
import { selectCanonicalBanksByLang } from '@/lib/mcq-bank-utils';
import { sopFamilyKeyFromIdentifier } from '@/lib/sopIdentifierNormalize';

/**
 * MCQ Bank "Approved" for a SOP family = every question is checked (ticked).
 * Matches the MCQ Bank stats rule: totalQ > 0 && checkedQ >= totalQ.
 */
export function isMcqFamilyFullyApproved(totalQ: number, checkedQ: number): boolean {
  return totalQ > 0 && checkedQ >= totalQ;
}

/**
 * LMS codes are usually base codes without a revision (STGE05), while banks carry one
 * (STGE05-04). Treat a bare code as revision 0 so both resolve to the same family key (STGE:5).
 */
export function familyKeyForLmsCode(sopCode: string): string {
  const code = String(sopCode || '').trim();
  if (code && !/-\d+$/.test(code)) {
    const fam = sopFamilyKeyFromIdentifier(`${code}-0`);
    if (fam) return fam;
  }
  return sopFamilyGroupKey({ identifier: code });
}

export type McqApprovalStats = {
  totalQ: number;
  approvedQ: number;
  pendingQ: number;
  approved: boolean;
};

/**
 * Batch-resolve MCQ-bank approval counts for SOP codes / family keys.
 * Map keys include both the family key and each requested code (uppercased).
 */
export async function getMcqApprovalStatsForCodes(
  codes: string[],
): Promise<Map<string, McqApprovalStats>> {
  const result = new Map<string, McqApprovalStats>();
  const unique = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
  if (unique.length === 0) return result;

  const famKeys = [...new Set(unique.map(familyKeyForLmsCode))];
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) return result;

  // Query by the requested codes — family keys (STGE:5) are not identifier strings.
  const bankOr = unique.map((code) => ({
    sopIdentifier: { $regex: sopFamilyIdentifierRegex(code) },
  }));

  const banks = bankOr.length
    ? await db.collection('mcqbanks').find(
        { isObsolete: { $ne: true }, $or: bankOr },
        { projection: { sopIdentifier: 1, language: 1, 'mcqs.isChecked': 1, totalQuestions: 1 } },
      ).maxTimeMS(15_000).toArray()
    : [];

  const grouped = new Map<string, Array<{
    sopIdentifier: string;
    language: string;
    totalQuestions: number;
    checkedQ: number;
  }>>();
  for (const b of banks) {
    const fam = sopFamilyGroupKey({ identifier: String(b.sopIdentifier || '').trim() });
    if (!famKeys.includes(fam)) continue;
    const mcqs = Array.isArray(b.mcqs) ? b.mcqs as Array<{ isChecked?: boolean }> : [];
    const totalQ = Number(b.totalQuestions) || mcqs.length;
    const checkedQ = mcqs.filter((q) => q.isChecked === true).length;
    const row = {
      sopIdentifier: String(b.sopIdentifier || ''),
      language: String(b.language || ''),
      totalQuestions: totalQ,
      checkedQ,
    };
    const list = grouped.get(fam);
    if (list) list.push(row);
    else grouped.set(fam, [row]);
  }

  const byFam = new Map<string, { totalQ: number; checkedQ: number }>();
  for (const [fam, famBanks] of grouped) {
    const canonical = selectCanonicalBanksByLang(famBanks);
    const agg = { totalQ: 0, checkedQ: 0 };
    for (const b of canonical) {
      agg.totalQ += b.totalQuestions;
      agg.checkedQ += b.checkedQ;
    }
    byFam.set(fam, agg);
  }

  for (const fam of famKeys) {
    const agg = byFam.get(fam) ?? { totalQ: 0, checkedQ: 0 };
    const approvedQ = Math.min(agg.checkedQ, agg.totalQ);
    const stats: McqApprovalStats = {
      totalQ: agg.totalQ,
      approvedQ,
      pendingQ: Math.max(0, agg.totalQ - approvedQ),
      approved: isMcqFamilyFullyApproved(agg.totalQ, agg.checkedQ),
    };
    result.set(fam, stats);
    result.set(fam.toUpperCase(), stats);
  }

  for (const code of unique) {
    const stats = result.get(familyKeyForLmsCode(code));
    if (!stats) continue;
    result.set(code, stats);
    result.set(code.toUpperCase(), stats);
  }

  return result;
}

/**
 * Batch-resolve MCQ-bank approval for SOP codes / family keys.
 * Map keys include both the family key and each requested code (uppercased).
 */
export async function getMcqApprovedMapForCodes(
  codes: string[],
): Promise<Map<string, boolean>> {
  const stats = await getMcqApprovalStatsForCodes(codes);
  const result = new Map<string, boolean>();
  for (const [key, s] of stats) result.set(key, s.approved);
  return result;
}

const NO_MCQ_STATS: McqApprovalStats = { totalQ: 0, approvedQ: 0, pendingQ: 0, approved: false };

export async function getSopMcqApprovalStats(sopCode: string): Promise<McqApprovalStats> {
  const map = await getMcqApprovalStatsForCodes([sopCode]);
  return map.get(sopCode) ?? map.get(familyKeyForLmsCode(sopCode)) ?? NO_MCQ_STATS;
}

/** Learner-facing reason an exam is locked on MCQ Bank approval. */
export function mcqNotApprovedMessage(stats: McqApprovalStats): string {
  if (stats.totalQ === 0) {
    return 'This exam cannot be started — no MCQs have been created for this SOP in the MCQ Bank.';
  }
  return `This exam cannot be started — ${stats.pendingQ} of ${stats.totalQ} questions are not yet approved in the MCQ Bank `
    + `(${stats.approvedQ} approved, ${stats.pendingQ} pending). It unlocks automatically once every question is approved.`;
}

export async function isSopMcqApprovedForLms(sopCode: string): Promise<boolean> {
  return (await getSopMcqApprovalStats(sopCode)).approved;
}
