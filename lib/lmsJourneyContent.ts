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
  /**
   * Questions available in Gujarati — translations of the English masters, or a
   * legacy standalone Gujarati bank for SOPs not translated yet.
   */
  mcqCountGu: number;
  /** Languages the single assessment can be taken in. */
  quizLanguages: Array<'en' | 'gu'>;
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
  // One assessment, taken in whichever language the learner picks — English and
  // Gujarati are two renderings of the same MCQs, not two separate exams. Legacy
  // `quizGu` progress is still honoured on read, but no new quizGu step is offered.
  const quizLanguages: Array<'en' | 'gu'> = [];
  if (mcqCount > 0) quizLanguages.push('en');
  if (mcqCountGu > 0) quizLanguages.push('gu');
  if (quizLanguages.length > 0) availableStepIds.push('quiz');

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
    quizLanguages,
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

type BankCountRow = {
  sopIdentifier?: string;
  usableQuestions?: number;
  translatedGu?: number;
  language?: string;
};

/**
 * Usable question count per language — must mirror `fetchQuestions` in
 * /api/lms/quiz exactly (same family regex, same isSimilar exclusion), or the
 * Start Test button appears for a bank the exam then serves 0 questions from.
 */
function mcqCountForCode(
  code: string,
  bankDocs: BankCountRow[],
  language: 'English' | 'Gujarati',
): number {
  const re = sopFamilyIdentifierRegex(code);
  let total = 0;
  for (const bank of bankDocs) {
    const bankLang = bank.language || 'English';
    if (bankLang !== language) continue;
    if (re.test(String(bank.sopIdentifier || ''))) total += bank.usableQuestions || 0;
  }
  return total;
}

/**
 * Questions the Gujarati exam can actually serve, mirroring the quiz route's
 * preference order: translations of the English masters first, and only when a
 * family has none, its legacy standalone Gujarati bank.
 */
function gujaratiCountForCode(code: string, bankDocs: BankCountRow[]): number {
  const re = sopFamilyIdentifierRegex(code);
  let translated = 0;
  for (const bank of bankDocs) {
    if ((bank.language || 'English') !== 'English') continue;
    if (re.test(String(bank.sopIdentifier || ''))) translated += bank.translatedGu || 0;
  }
  if (translated > 0) return translated;
  return mcqCountForCode(code, bankDocs, 'Gujarati');
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

  const bases = [...new Set(missing.map(stripVersion).filter(Boolean))];
  const identSet = [...new Set([...missing, ...bases])];

  // Indexed equality ($in on identifier / sopBaseId) instead of one prefix
  // regex per assigned SOP — that $or list forced a collection scan on every
  // LMS dashboard / trainer-monthly load.
  const sopRows = await SOP.find({
    isObsolete: { $ne: true },
    $or: [
      { identifier: { $in: identSet } },
      { sopBaseId: { $in: bases } },
    ],
  })
    .select('name identifier sopBaseId department fileUrl fileType language mediaLinks versionNum uploadedAt')
    .lean<SopLean[]>();

  const bankFamilies = [...new Set(missing.map((c) => stripVersion(c)).filter(Boolean))];
  // Family regex — banks are stored under versioned ids (PRPA01-03) while
  // assignments use the base code (PRPA01). Exact $in missed them, so monthly
  // rows were dropped and trainer employee counts stayed at 0.
  const bankOr = bankFamilies.flatMap((base) => [
    { sopIdentifier: base },
    { sopIdentifier: { $regex: sopFamilyIdentifierRegex(base) } },
  ]);

  const banks = bankOr.length
    ? await MCQBank.find({
        isObsolete: { $ne: true },
        $or: bankOr,
        $and: [{
          $or: [
            { language: { $in: ['English', 'Gujarati'] } },
            { language: { $exists: false } },
            { language: null },
            { language: '' },
          ],
        }],
      })
        .select('sopIdentifier language totalQuestions')
        .maxTimeMS(15_000)
        .lean<Array<{ sopIdentifier?: string; language?: string; totalQuestions?: number }>>()
    : [];

  // Stored totalQuestions only — do not walk `$mcqs` on Atlas (45s timeout).
  const bankDocs: BankCountRow[] = banks.map((b) => ({
    sopIdentifier: b.sopIdentifier,
    language: b.language || 'English',
    usableQuestions: b.totalQuestions || 0,
    translatedGu: 0,
  }));

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
      gujaratiCountForCode(code, bankDocs),
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
