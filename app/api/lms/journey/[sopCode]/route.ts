import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { connectDB } from '@/lib/mongodb';
import { verifyLmsToken, LMS_COOKIE } from '@/lib/lms-session';
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
  if (content.mcqCount > 0) {
    const s = (stepData.quiz || {}) as {
      completed?: boolean;
      passed?: boolean;
      score?: number;
      attempts?: number;
      attemptHistory?: Array<{ attempt: number; score: number; at?: string | Date }>;
    };
    journeySteps.push({
      id: 'quiz', type: 'quiz', label: 'Assessment', questionCount: content.mcqCount,
      completed: s.completed ?? false,
      percentage: s.score,
      attempts: s.attempts ?? 0,
      attemptHistory: Array.isArray(s.attemptHistory) ? s.attemptHistory : [],
    });
  }
  if (content.mcqCountGu > 0) {
    const s = (stepData.quizGu || {}) as {
      completed?: boolean;
      passed?: boolean;
      score?: number;
      attempts?: number;
      attemptHistory?: Array<{ attempt: number; score: number; at?: string | Date }>;
    };
    journeySteps.push({
      id: 'quizGu', type: 'quiz', label: 'Assessment (Gujarati)', questionCount: content.mcqCountGu,
      completed: s.completed ?? false,
      percentage: s.score,
      attempts: s.attempts ?? 0,
      attemptHistory: Array.isArray(s.attemptHistory) ? s.attemptHistory : [],
    });
  }

  return journeySteps;
}

// GET /api/lms/journey/[sopCode]
export async function GET(_req: NextRequest, { params }: Params) {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
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
