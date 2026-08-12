import { connectDB } from '@/lib/mongodb';
import {
  getOrBuildLmsCache,
  lmsServerKeys,
  lmsServerTtl,
  peekLmsServerCache,
  primeLmsServerCache,
} from '@/lib/lmsCache';
import SOP from '@/models/SOP';
import MCQBank from '@/models/MCQBank';
import { sopFamilyIdentifierRegex } from '@/lib/sop-utils';

function toArray(val: string | string[] | undefined | null): string[] {
  if (!val) return [];
  return Array.isArray(val) ? val.filter(Boolean) : [val];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

type SopLean = {
  name: string;
  identifier: string;
  sopBaseId?: string;
  department: string;
  fileUrl?: string;
  fileType?: string;
  language?: string;
  mediaLinks?: {
    videos?: { en?: string | string[]; gu?: string | string[] };
    slides?: { en?: string | string[]; gu?: string | string[] };
  };
  versionNum?: number;
  uploadedAt?: Date;
};

export interface JourneyContent {
  sop: {
    name: string;
    identifier: string;
    sopBaseId?: string;
    department: string;
    fileUrl?: string;
    fileType?: string;
    mcqCount: number;
  } | null;
  availableStepIds: string[];
  videosEn: string[];
  videosGu: string[];
  slidesEn: string[];
  slidesGu: string[];
  sopPdfUrl: string | null;
  sopFileType: 'pdf' | 'docx';
  /** Gujarati SOP document, when a distinct Gujarati-language record exists. */
  sopPdfUrlGu: string | null;
  sopFileTypeGu: 'pdf' | 'docx';
  mcqCount: number;
  /** Question count of the Gujarati MCQ bank, if one exists. */
  mcqCountGu: number;
}

function buildJourneyContent(
  sop: SopLean | null,
  gujSop: SopLean | null,
  mcqCount: number,
  mcqCountGu: number,
): JourneyContent {
  const videosEn = sop ? toArray(sop.mediaLinks?.videos?.en) : [];
  const videosGu = sop ? toArray(sop.mediaLinks?.videos?.gu) : [];
  const slidesEn = sop ? toArray(sop.mediaLinks?.slides?.en) : [];
  const slidesGu = sop ? toArray(sop.mediaLinks?.slides?.gu) : [];
  const sopPdfUrl = sop?.fileUrl || null;
  // Only surface a Gujarati doc when it is a separate file from the primary one.
  const sopPdfUrlGu =
    gujSop?.fileUrl && gujSop.fileUrl !== sopPdfUrl ? gujSop.fileUrl : null;

  const availableStepIds: string[] = [];
  if (videosEn.length > 0) availableStepIds.push('videoEn');
  if (videosGu.length > 0) availableStepIds.push('videoGu');
  if (sopPdfUrl) availableStepIds.push('sopPdf');
  if (sopPdfUrlGu) availableStepIds.push('sopPdfGu');
  if (slidesEn.length > 0) availableStepIds.push('slidesEn');
  if (slidesGu.length > 0) availableStepIds.push('slidesGu');
  if (mcqCount > 0) availableStepIds.push('quiz');
  if (mcqCountGu > 0) availableStepIds.push('quizGu');

  return {
    sop: sop
      ? {
          name: sop.name,
          identifier: sop.identifier,
          sopBaseId: sop.sopBaseId,
          department: sop.department,
          fileUrl: sop.fileUrl,
          fileType: sop.fileType,
          mcqCount,
        }
      : null,
    availableStepIds,
    videosEn,
    videosGu,
    slidesEn,
    slidesGu,
    sopPdfUrl,
    sopFileType:
      sop?.fileType === 'docx' || /\.docx($|\?)/i.test(sop?.fileUrl || '')
        ? 'docx'
        : 'pdf',
    sopPdfUrlGu,
    sopFileTypeGu:
      gujSop?.fileType === 'docx' || /\.docx($|\?)/i.test(gujSop?.fileUrl || '')
        ? 'docx'
        : 'pdf',
    mcqCount,
    mcqCountGu,
  };
}

function sopRank(sop: SopLean): number {
  const version = sop.versionNum ?? 0;
  const uploaded = sop.uploadedAt ? new Date(sop.uploadedAt).getTime() : 0;
  return version * 1e15 + uploaded;
}

function sopMatchesCode(sop: SopLean, code: string): boolean {
  const codeUpper = code.toUpperCase();
  const id = String(sop.identifier || '').toUpperCase();
  const baseId = String(sop.sopBaseId || stripVersion(sop.identifier || '')).toUpperCase();
  return id === codeUpper || baseId === codeUpper || id.startsWith(codeUpper);
}

/**
 * Usable question count per language — must mirror `fetchQuestions` in
 * /api/lms/quiz exactly (same family regex, same isSimilar exclusion), or the
 * Start Test button appears for a bank the exam then serves 0 questions from.
 */
function mcqCountForCode(
  code: string,
  bankDocs: Array<{ sopIdentifier?: string; usableQuestions?: number; language?: string }>,
  language: 'English' | 'Gujarati',
): number {
  const re = sopFamilyIdentifierRegex(code);
  let total = 0;
  for (const bank of bankDocs) {
    if ((bank.language || 'English') !== language) continue;
    if (re.test(String(bank.sopIdentifier || ''))) total += bank.usableQuestions || 0;
  }
  return total;
}

/** Resolve journey content for many SOP codes in two bulk DB queries. */
export async function getJourneyContentBatch(
  sopCodes: Iterable<string>,
): Promise<Map<string, JourneyContent>> {
  const unique = [...new Set([...sopCodes].filter(Boolean))];
  const result = new Map<string, JourneyContent>();
  const missing: string[] = [];

  for (const code of unique) {
    const cached = peekLmsServerCache<JourneyContent>(lmsServerKeys.journeyContent(code));
    if (cached) result.set(code, cached);
    else missing.push(code);
  }

  if (missing.length === 0) return result;

  await connectDB();

  const sopOr = missing.flatMap((code) => [
    { identifier: code },
    { sopBaseId: code },
    { identifier: { $regex: new RegExp(`^${escapeRegex(code)}`, 'i') } },
  ]);

  const [sopRows, bankDocs] = await Promise.all([
    SOP.find({ isObsolete: { $ne: true }, $or: sopOr })
      .select('name identifier sopBaseId department fileUrl fileType language mediaLinks versionNum uploadedAt')
      .lean<SopLean[]>(),
    // Count non-similar questions server-side so the (large) mcqs arrays never
    // cross the wire — one aggregate for every requested code.
    MCQBank.aggregate<{ sopIdentifier?: string; usableQuestions?: number; language?: string }>([
      {
        $match: {
          isObsolete: { $ne: true },
          language: { $in: ['English', 'Gujarati'] },
          $or: missing.map((code) => ({
            sopIdentifier: { $regex: sopFamilyIdentifierRegex(code) },
          })),
        },
      },
      {
        $project: {
          _id: 0,
          sopIdentifier: 1,
          language: 1,
          usableQuestions: {
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
    ]),
  ]);

  for (const code of missing) {
    let best: SopLean | null = null;
    let bestRank = -1;
    let bestGu: SopLean | null = null;
    let bestGuRank = -1;
    for (const sop of sopRows) {
      if (!sopMatchesCode(sop, code)) continue;
      const rank = sopRank(sop);
      if (rank > bestRank) {
        best = sop;
        bestRank = rank;
      }
      if (sop.language === 'Gujarati' && rank > bestGuRank) {
        bestGu = sop;
        bestGuRank = rank;
      }
    }

    const content = buildJourneyContent(
      best,
      bestGu,
      mcqCountForCode(code, bankDocs, 'English'),
      mcqCountForCode(code, bankDocs, 'Gujarati'),
    );
    result.set(code, content);
    primeLmsServerCache(
      lmsServerKeys.journeyContent(code),
      content,
      lmsServerTtl.journeyContent,
    );
  }

  return result;
}

/** Shared SOP content for a journey — identical for every learner. */
export async function getJourneyContent(sopCode: string): Promise<JourneyContent> {
  return getOrBuildLmsCache(
    lmsServerKeys.journeyContent(sopCode),
    lmsServerTtl.journeyContent,
    async () => {
      const batch = await getJourneyContentBatch([sopCode]);
      return batch.get(sopCode) ?? buildJourneyContent(null, null, 0, 0);
    },
  );
}
