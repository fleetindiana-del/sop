import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { resolveLmsIdentity } from '@/lib/lmsIdentity';
import {
  getOrBuildLmsCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import { getJourneyContent } from '@/lib/lmsJourneyContent';
import LearningProgress from '@/models/lms/LearningProgress';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ sopCode: string }> };

export interface JourneyStep {
  id: string;
  type: 'video' | 'slides' | 'pdf' | 'quiz';
  label: string;
  urls?: string[];
  url?: string;
  fileType?: 'pdf' | 'docx';
  questionCount?: number;
  attempts?: number;
  completed: boolean;
  percentage?: number;
  lastTimestamp?: number;
  /** Formal exam attempt scores, e.g. [{ attempt: 1, score: 75 }, ...]. */
  attemptHistory?: Array<{ attempt: number; score: number; at?: string | Date }>;
  /** Quiz steps only: languages this assessment can be taken in. */
  languages?: Array<'en' | 'gu'>;
}

type QuizStepData = {
  completed?: boolean;
  passed?: boolean;
  score?: number;
  attempts?: number;
  attemptHistory?: Array<{ attempt: number; score: number; at?: string | Date }>;
};

/**
 * Fold legacy `quizGu` progress into the single `quiz` step.
 *
 * Before translations, English and Gujarati were separate exams with separate
 * records and passing either one counted. Now there is one exam in two languages,
 * so a learner who passed the old Gujarati assessment must stay passed. Attempts
 * take the max rather than the sum — a migration should never push someone over
 * an attempt limit for work they already did.
 */
function mergeQuizProgress(en: QuizStepData, gu: QuizStepData): QuizStepData {
  const enRank = (en.passed ? 2 : 0) + (en.completed ? 1 : 0);
  const guRank = (gu.passed ? 2 : 0) + (gu.completed ? 1 : 0);
  const best = guRank > enRank || (guRank === enRank && (gu.score ?? 0) > (en.score ?? 0)) ? gu : en;
  const history = [
    ...(Array.isArray(en.attemptHistory) ? en.attemptHistory : []),
    ...(Array.isArray(gu.attemptHistory) ? gu.attemptHistory : []),
  ].sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());

  return {
    completed: en.completed || gu.completed,
    passed: en.passed || gu.passed,
    score: Math.max(en.score ?? 0, gu.score ?? 0),
    attempts: Math.max(en.attempts ?? 0, gu.attempts ?? 0),
    attemptHistory: history.length ? history : best.attemptHistory,
  };
}

function buildJourneySteps(
  content: Awaited<ReturnType<typeof getJourneyContent>>,
  stepData: Record<string, unknown>,
): JourneyStep[] {
  const journeySteps: JourneyStep[] = [];

  if (content.videosEn.length > 0) {
    const s = (stepData.videoEn || {}) as { completed?: boolean; percentage?: number; lastTimestamp?: number };
    journeySteps.push({
      id: 'videoEn', type: 'video', label: 'English Video', urls: content.videosEn,
      completed: s.completed ?? false,
      percentage: s.percentage ?? 0,
      lastTimestamp: s.lastTimestamp ?? 0,
    });
  }
  if (content.videosGu.length > 0) {
    const s = (stepData.videoGu || {}) as { completed?: boolean; percentage?: number; lastTimestamp?: number };
    journeySteps.push({
      id: 'videoGu', type: 'video', label: 'Gujarati Video', urls: content.videosGu,
      completed: s.completed ?? false,
      percentage: s.percentage ?? 0,
      lastTimestamp: s.lastTimestamp ?? 0,
    });
  }
  if (content.sopPdfUrl) {
    const s = (stepData.sopPdf || {}) as { completed?: boolean };
    journeySteps.push({
      id: 'sopPdf', type: 'pdf', label: 'SOP Document', url: content.sopPdfUrl,
      fileType: content.sopFileType,
      completed: s.completed ?? false,
    });
  }
  if (content.sopPdfUrlGu) {
    const s = (stepData.sopPdfGu || {}) as { completed?: boolean };
    journeySteps.push({
      id: 'sopPdfGu', type: 'pdf', label: 'SOP Document (Gujarati)', url: content.sopPdfUrlGu,
      fileType: content.sopFileTypeGu,
      completed: s.completed ?? false,
    });
  }
  if (content.slidesEn.length > 0) {
    const s = (stepData.slidesEn || {}) as { completed?: boolean };
    journeySteps.push({
      id: 'slidesEn', type: 'slides', label: 'English Slides (PPT)', urls: content.slidesEn,
      completed: s.completed ?? false,
    });
  }
  if (content.slidesGu.length > 0) {
    const s = (stepData.slidesGu || {}) as { completed?: boolean };
    journeySteps.push({
      id: 'slidesGu', type: 'slides', label: 'Gujarati Slides (PPT)', urls: content.slidesGu,
      completed: s.completed ?? false,
    });
  }
  // One assessment for the SOP; `languages` tells the learner UI which language
  // versions of those same MCQs it may offer.
  if (content.quizLanguages.length > 0) {
    const s = mergeQuizProgress(
      (stepData.quiz || {}) as QuizStepData,
      (stepData.quizGu || {}) as QuizStepData,
    );
    journeySteps.push({
      id: 'quiz',
      type: 'quiz',
      label: 'Assessment',
      questionCount: content.mcqCount || content.mcqCountGu,
      completed: s.completed ?? false,
      percentage: s.score,
      attempts: s.attempts ?? 0,
      attemptHistory: Array.isArray(s.attemptHistory) ? s.attemptHistory : [],
      languages: content.quizLanguages,
    });
  }

  return journeySteps;
}

// GET /api/lms/journey/[sopCode]
export async function GET(_req: NextRequest, { params }: Params) {
  const payload = await resolveLmsIdentity();
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { sopCode } = await params;

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.journey(payload.sub, sopCode),
      lmsServerTtl.userProgress,
      async () => {
        const content = await getJourneyContent(sopCode);
        const { availableStepIds } = content;

        await connectDB();

        let progress = await LearningProgress.findOne({ employeeId: payload.sub, sopCode }).lean();
        if (!progress) {
          const created = await LearningProgress.create({
            employeeId: payload.sub,
            sopCode,
            availableSteps: availableStepIds,
            status: 'not_started',
            overallPercentage: 0,
            lastAccessedAt: new Date(),
          });
          progress = created.toObject();
        } else if (
          Array.isArray(progress.availableSteps) &&
          availableStepIds.some((id) => !progress.availableSteps.includes(id))
        ) {
          const merged = Array.from(new Set([...progress.availableSteps, ...availableStepIds]));
          await LearningProgress.updateOne(
            { _id: progress._id },
            { $set: { availableSteps: merged } },
          );
          progress = { ...progress, availableSteps: merged };
        }

        const steps = progress as typeof progress & { steps?: Record<string, unknown> };
        const stepData = steps.steps || {};
        const journeySteps = buildJourneySteps(content, stepData);

        return {
          sop: content.sop
            ? {
                name: content.sop.name,
                identifier: content.sop.identifier,
                department: content.sop.department,
                fileUrl: content.sop.fileUrl,
                fileType: content.sop.fileType,
                mcqCount: content.mcqCount,
              }
            : null,
          progress,
          steps: journeySteps,
          availableSteps: availableStepIds,
        };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(30) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
