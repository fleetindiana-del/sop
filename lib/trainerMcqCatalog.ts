import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import { getGroupedRegistryRows } from '@/lib/dashboardRegistrySource';
import {
  buildActiveSopFamilyMap,
  mcqBankLangCode,
  mcqResolveDept,
  selectCanonicalBanksByLang,
} from '@/lib/mcq-bank-utils';
import { isMcqFamilyFullyApproved } from '@/lib/lmsMcqApproval';
import { getJourneyContentBatch } from '@/lib/lmsJourneyContent';
import {
  baseIdentifierFromIdentifier,
  sopFamilyGroupKey,
} from '@/lib/sop-utils';
import { isDashboardDepartmentName } from '@/lib/dashboardDepartments';

export type McqLangSlot = {
  questionCount: number;
  lmsApproved: boolean;
};

export type AssetLangSlot = {
  available: boolean;
};

export type TrainerMcqCatalogEntry = {
  sopCode: string;
  /** Full registry identifier (includes current revision), dashboard SOP No. format. */
  sopIdentifier: string;
  /** Current SOP version from the registry (e.g. "10" or "1.0"). */
  sopVersion?: string;
  sopName: string;
  sopNameGujarati?: string;
  department: string;
  language: string;
  isDualLanguage: boolean;
  needsEn: boolean;
  needsGu: boolean;
  eng: McqLangSlot;
  guj: McqLangSlot;
  pdfEng: AssetLangSlot;
  pdfGuj: AssetLangSlot;
  videoEng: AssetLangSlot;
  videoGuj: AssetLangSlot;
  /** Combined non-similar question count — legacy aggregate. */
  questionCount: number;
  /** True when every question in every bank is checked. */
  lmsApproved: boolean;
  examQuestionCount?: number;
  passingScore?: number;
};

type FamilyLangStats = {
  enQ: number;
  enChecked: number;
  guQ: number;
  guChecked: number;
  questionCount: number;
  totalQ: number;
  checkedQ: number;
};

function slotFromStats(totalQ: number, checkedQ: number): McqLangSlot {
  return {
    questionCount: totalQ,
    lmsApproved: isMcqFamilyFullyApproved(totalQ, checkedQ),
  };
}

function resolveLanguageFlags(languages: Set<string>): {
  language: string;
  isDualLanguage: boolean;
  needsEn: boolean;
  needsGu: boolean;
} {
  const hasEn = languages.has('English');
  const hasGu = languages.has('Gujarati');
  if (hasEn && hasGu) {
    return { language: 'ENG-GUJ', isDualLanguage: true, needsEn: true, needsGu: true };
  }
  if (hasGu) {
    return { language: 'GUJ', isDualLanguage: false, needsEn: false, needsGu: true };
  }
  return { language: 'ENG', isDualLanguage: false, needsEn: true, needsGu: false };
}

/** Per-family MCQ stats keyed by uppercased SOP base code. */
export async function buildTrainerMcqCatalogMap(): Promise<Map<string, TrainerMcqCatalogEntry>> {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database not connected');

  const grouped = await getGroupedRegistryRows();
  const activeFamilyMap = buildActiveSopFamilyMap(grouped);
  const gujaratiByFam = new Map<string, string>();
  const versionByFam = new Map<string, string>();
  const preferredIdentifierByFam = new Map<string, string>();
  for (const row of grouped) {
    if (row.isObsolete) continue;
    const famKey = sopFamilyGroupKey(row);
    const guj = String(row.nameGujarati ?? '').trim();
    if (guj && !gujaratiByFam.has(famKey)) gujaratiByFam.set(famKey, guj);
    const version = String(row.version ?? '').trim();
    if (version && !versionByFam.has(famKey)) versionByFam.set(famKey, version);
    if (!preferredIdentifierByFam.has(famKey)) preferredIdentifierByFam.set(famKey, row.identifier);
  }

  const bankRows = await db.collection('mcqbanks').aggregate([
    { $match: { isObsolete: { $ne: true } } },
    {
      $project: {
        sopIdentifier: 1,
        language: 1,
        totalQuestions: { $size: { $ifNull: ['$mcqs', []] } },
        checkedCount: {
          $size: {
            $filter: {
              input: { $ifNull: ['$mcqs', []] },
              as: 'q',
              cond: { $eq: ['$$q.isChecked', true] },
            },
          },
        },
        updatedAt: 1,
        qCount: {
          $size: {
            $filter: {
              input: { $ifNull: ['$mcqs', []] },
              as: 'q',
              cond: { $ne: ['$$q.isSimilar', true] },
            },
          },
        },
      },
    },
  ]).toArray();

  const banksByFam = new Map<string, typeof bankRows>();
  for (const b of bankRows) {
    const famKey = sopFamilyGroupKey({ identifier: String(b.sopIdentifier || '').trim() });
    if (!activeFamilyMap.has(famKey)) continue;
    const list = banksByFam.get(famKey);
    if (list) list.push(b);
    else banksByFam.set(famKey, [b]);
  }

  const statsByFam = new Map<string, FamilyLangStats>();
  for (const [famKey, banks] of banksByFam) {
    const canonical = selectCanonicalBanksByLang(
      banks.map((b) => ({
        ...b,
        sopIdentifier: String(b.sopIdentifier || ''),
        language: String(b.language || ''),
        totalQuestions: Number(b.totalQuestions) || 0,
        updatedAt: b.updatedAt as Date | undefined,
      })),
      preferredIdentifierByFam.get(famKey),
    );
    const cur: FamilyLangStats = {
      enQ: 0,
      enChecked: 0,
      guQ: 0,
      guChecked: 0,
      questionCount: 0,
      totalQ: 0,
      checkedQ: 0,
    };
    for (const b of canonical) {
      const totalQ = Number(b.totalQuestions) || 0;
      const checkedQ = Number(b.checkedCount) || 0;
      const qCount = Number(b.qCount) || 0;
      cur.totalQ += totalQ;
      cur.checkedQ += checkedQ;
      cur.questionCount += qCount;
      if (mcqBankLangCode(String(b.language || '')) === 'GUJ') {
        cur.guQ += totalQ;
        cur.guChecked += checkedQ;
      } else {
        cur.enQ += totalQ;
        cur.enChecked += checkedQ;
      }
    }
    statsByFam.set(famKey, cur);
  }

  const out = new Map<string, TrainerMcqCatalogEntry>();
  for (const [famKey, active] of activeFamilyMap) {
    const dept = mcqResolveDept(active.identifier, active.dept);
    if (!isDashboardDepartmentName(dept)) continue;
    const sopCode = (
      baseIdentifierFromIdentifier(active.identifier).toUpperCase()
      || famKey.toUpperCase()
    );
    const langFlags = resolveLanguageFlags(active.languages);
    const stats = statsByFam.get(famKey);
    const gujarati = gujaratiByFam.get(famKey);
    const eng = slotFromStats(stats?.enQ ?? 0, stats?.enChecked ?? 0);
    const guj = slotFromStats(stats?.guQ ?? 0, stats?.guChecked ?? 0);
    out.set(sopCode, {
      sopCode,
      sopIdentifier: active.identifier || sopCode,
      sopVersion: versionByFam.get(famKey),
      sopName: active.name || sopCode,
      sopNameGujarati: gujarati && gujarati !== active.name ? gujarati : undefined,
      department: dept,
      language: langFlags.language,
      isDualLanguage: langFlags.isDualLanguage,
      needsEn: langFlags.needsEn,
      needsGu: langFlags.needsGu,
      eng,
      guj,
      pdfEng: { available: false },
      pdfGuj: { available: false },
      videoEng: { available: false },
      videoGuj: { available: false },
      questionCount: stats?.questionCount ?? 0,
      lmsApproved: stats
        ? isMcqFamilyFullyApproved(stats.totalQ, stats.checkedQ)
        : false,
    });
  }

  const contentMap = await getJourneyContentBatch([...out.keys()]);
  for (const [sopCode, entry] of out) {
    const content = contentMap.get(sopCode);
    entry.pdfEng = { available: Boolean(content?.sopPdfUrl) };
    entry.pdfGuj = { available: Boolean(content?.sopPdfUrlGu) };
    entry.videoEng = { available: (content?.videosEn.length ?? 0) > 0 };
    entry.videoGuj = { available: (content?.videosGu.length ?? 0) > 0 };
  }

  return out;
}
