import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import { sopFamilyGroupKey, sopFamilyIdentifierRegex } from '@/lib/sop-utils';
import { selectCanonicalBanksByLang } from '@/lib/mcq-bank-utils';

/**
 * MCQ Bank "Approved" for a SOP family = every question is checked (ticked).
 * Matches the MCQ Bank stats rule: totalQ > 0 && checkedQ >= totalQ.
 */
export function isMcqFamilyFullyApproved(totalQ: number, checkedQ: number): boolean {
  return totalQ > 0 && checkedQ >= totalQ;
}

export function familyKeyForLmsCode(sopCode: string): string {
  return sopFamilyGroupKey({ identifier: String(sopCode || '').trim() });
}

/**
 * Batch-resolve MCQ-bank approval for SOP codes / family keys.
 * Map keys include both the family key and each requested code (uppercased).
 */
export async function getMcqApprovedMapForCodes(
  codes: string[],
): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const unique = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))];
  if (unique.length === 0) return result;

  const famKeys = [...new Set(unique.map(familyKeyForLmsCode))];
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) return result;

  const bankFamilies = [...new Set(unique.map(familyKeyForLmsCode))];
  const bankOr = bankFamilies.flatMap((base) => [
    { sopIdentifier: base },
    { sopIdentifier: { $regex: sopFamilyIdentifierRegex(base) } },
  ]);

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
    const agg = byFam.get(fam);
    const approved = agg
      ? isMcqFamilyFullyApproved(agg.totalQ, agg.checkedQ)
      : false;
    result.set(fam, approved);
    result.set(fam.toUpperCase(), approved);
  }

  for (const code of unique) {
    const fam = familyKeyForLmsCode(code);
    const approved = result.get(fam) === true;
    result.set(code, approved);
    result.set(code.toUpperCase(), approved);
  }

  return result;
}

export async function isSopMcqApprovedForLms(sopCode: string): Promise<boolean> {
  const map = await getMcqApprovedMapForCodes([sopCode]);
  return map.get(sopCode) === true || map.get(familyKeyForLmsCode(sopCode)) === true;
}
