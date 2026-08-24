import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { connectDB } from '@/lib/mongodb';
import { verifyLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import {
  getOrBuildLmsCache,
  invalidateLmsLearnerCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import Certificate from '@/models/lms/Certificate';
import LearningProgress from '@/models/lms/LearningProgress';
import Employee from '@/models/Employee';
import SOP from '@/models/SOP';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ sopCode: string }> };

function generateCertNumber(): string {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `CERT-${ymd}-${rand}`;
}

// GET /api/lms/certificate/[sopCode] — get existing certificate or null
export async function GET(_req: NextRequest, { params }: Params) {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { sopCode } = await params;

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.certificate(payload.sub, sopCode),
      lmsServerTtl.certificate,
      async () => {
        await connectDB();
        const cert = await Certificate.findOne({ employeeId: payload.sub, sopCode }).lean();
        return { certificate: cert || null };
      },
    );

    if (!body.certificate) {
      // Do not reveal whether this SOP has a certificate owned by another employee.
      return NextResponse.json({ error: 'Certificate not found' }, { status: 404 });
    }

    return NextResponse.json(body, { headers: lmsCacheControl(120) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// POST /api/lms/certificate/[sopCode] — generate certificate if all steps complete
export async function POST(_req: NextRequest, { params }: Params) {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { sopCode } = await params;

  try {
    await connectDB();

    // Already issued?
    const existing = await Certificate.findOne({ employeeId: payload.sub, sopCode }).lean();
    if (existing) return NextResponse.json({ certificate: existing });

    // Verify progress is complete AND the quiz was actually passed
    const progress = await LearningProgress.findOne({ employeeId: payload.sub, sopCode });
    if (!progress) {
      return NextResponse.json({ error: 'Training not yet completed' }, { status: 400 });
    }

    const stepsRecord = progress.steps as Record<string, { passed?: boolean; completed?: boolean; score?: number }> | undefined;
    const availableSteps = (progress.availableSteps ?? []) as string[];
    const quizKeys = availableSteps.filter((k) => k === 'quiz' || k === 'quizGu');
    // Also accept quiz completion even if availableSteps was stale / missing quiz keys.
    const allQuizKeys = ['quiz', 'quizGu'] as const;
    const quizPassed = (quizKeys.length > 0 ? quizKeys : [...allQuizKeys]).some(
      (k) => stepsRecord?.[k]?.passed === true || stepsRecord?.[k]?.completed === true,
    );

    if (!quizPassed && quizKeys.length > 0) {
      return NextResponse.json({ error: 'Assessment not passed' }, { status: 400 });
    }

    // If quiz passed but overall % was stuck (stale availableSteps), complete training now.
    if (quizPassed && (progress.overallPercentage < 100 || progress.status !== 'completed')) {
      progress.overallPercentage = 100;
      progress.status = 'completed';
      if (!progress.completedAt) progress.completedAt = new Date();
      // Ensure quiz keys exist in availableSteps for future recalcs.
      for (const k of allQuizKeys) {
        if (stepsRecord?.[k]?.passed || stepsRecord?.[k]?.completed) {
          if (!progress.availableSteps.includes(k)) {
            progress.availableSteps = [...progress.availableSteps, k];
          }
        }
      }
      await progress.save();
      invalidateLmsLearnerCache(payload.sub, sopCode);
    }

    if (progress.overallPercentage < 100 || progress.status !== 'completed') {
      return NextResponse.json({ error: 'Training not yet completed' }, { status: 400 });
    }

    // Get employee details
    const employee = await Employee.findById(payload.sub)
      .select('name designation department')
      .lean<{ name: string; designation: string; department: string }>();
    if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

    // Get SOP name
    const sop = await SOP.findOne({
      $or: [
        { identifier: sopCode },
        { sopBaseId: sopCode },
        { identifier: new RegExp(`^${sopCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') },
      ],
    }).select('name version').sort({ versionNum: -1 }).lean<{ name: string; version?: string }>();

    const stepsData = progress.steps as Record<string, { score?: number; passed?: boolean }> | undefined;
    const quizScore = stepsData?.quiz?.score ?? stepsData?.quizGu?.score ?? 0;

    const cert = await Certificate.create({
      certificateNumber: generateCertNumber(),
      employeeId: payload.sub,
      employeeName: employee.name,
      designation: employee.designation,
      department: employee.department,
      sopCode,
      sopName: sop?.name || sopCode,
      sopVersion: sop?.version,
      completedAt: progress.completedAt || new Date(),
      quizScore,
      issuedAt: new Date(),
    });

    invalidateLmsLearnerCache(payload.sub, sopCode);
    return NextResponse.json({ certificate: cert.toObject() }, { status: 201 });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
