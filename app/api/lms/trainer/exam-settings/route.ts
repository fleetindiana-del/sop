import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import {
  buildSopList,
  type SopExamSettingsPayload,
} from '@/app/api/lms/admin/sop-exam-settings/route';
import {
  invalidateLmsServerKeys,
  lmsServerKeys,
} from '@/lib/lmsCache';
import SopExamSettings, {
  SHUFFLE_MODES,
  type ISopEmployeeExamRule,
  type ShuffleMode,
} from '@/models/lms/SopExamSettings';
import { baseIdentifierFromIdentifier } from '@/lib/sop-utils';
import { isSopMcqApprovedForLms } from '@/lib/lmsMcqApproval';

export const dynamic = 'force-dynamic';

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseShuffleMode(v: unknown, fallback: ShuffleMode): ShuffleMode {
  if (typeof v === 'string' && (SHUFFLE_MODES as string[]).includes(v)) {
    return v as ShuffleMode;
  }
  return fallback;
}

function parseBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  return fallback;
}

function parseEmployeeRules(
  raw: unknown,
  fallbackBase: Omit<SopExamSettingsPayload, 'employeeRules'>,
): ISopEmployeeExamRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ISopEmployeeExamRule[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const employeeId = String(r.employeeId || '').trim();
    if (!employeeId || seen.has(employeeId)) continue;
    seen.add(employeeId);
    out.push({
      employeeId,
      employeeName: String(r.employeeName || '').trim() || employeeId,
      department: String(r.department || '').trim(),
      designation: String(r.designation || '').trim(),
      isTrainer: r.isTrainer === true,
      trialQuestionCount: clampInt(r.trialQuestionCount, 0, 50, fallbackBase.trialQuestionCount),
      examQuestionCount: clampInt(r.examQuestionCount, 1, 200, fallbackBase.examQuestionCount),
      passingScore: r.isTrainer === true
        ? 100
        : clampInt(r.passingScore, 1, 100, fallbackBase.passingScore),
      maxAttempts: r.isTrainer === true
        ? 0
        : clampInt(r.maxAttempts, 0, 999, fallbackBase.maxAttempts),
      timeLimitMinutes: clampInt(r.timeLimitMinutes, 0, 600, fallbackBase.timeLimitMinutes),
      shuffleMode: parseShuffleMode(r.shuffleMode, fallbackBase.shuffleMode),
      showAnswersAfterTrial: parseBool(r.showAnswersAfterTrial, fallbackBase.showAnswersAfterTrial),
      allowRetakeAfterPass: parseBool(r.allowRetakeAfterPass, fallbackBase.allowRetakeAfterPass),
    });
  }
  return out;
}

// GET /api/lms/trainer/exam-settings — SOP exam settings for trainer departments only
export async function GET() {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  try {
    const list = await buildSopList();
    const depts = auth.trainer.trainerDepartments;
    const sops = list.sops.filter((s) =>
      deptMatchesTrainerScope(s.department, depts),
    );
    return NextResponse.json(
      {
        ...list,
        sops,
        departments: depts,
        trainerScoped: true,
      },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    );
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

// PATCH /api/lms/trainer/exam-settings — update SOP exam settings in trainer scope
export async function PATCH(req: NextRequest) {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  try {
    await connectDB();
    const body = (await req.json()) as Record<string, unknown>;
    const rawCode = String(body.sopCode || '').trim();
    if (!rawCode) {
      return NextResponse.json({ error: 'sopCode is required' }, { status: 400 });
    }
    const sopCode = (baseIdentifierFromIdentifier(rawCode) || rawCode).toUpperCase();

    const list = await buildSopList();
    const target = list.sops.find((s) => s.sopCode.toUpperCase() === sopCode);
    if (!target || !deptMatchesTrainerScope(target.department, auth.trainer.trainerDepartments)) {
      return NextResponse.json(
        { error: 'SOP is outside your trainer departments' },
        { status: 403 },
      );
    }

    if (body.reset === true) {
      await SopExamSettings.deleteOne({ sopCode });
      invalidateLmsServerKeys(lmsServerKeys.adminSopExamSettings());
      const refreshed = await buildSopList();
      return NextResponse.json({
        ok: true,
        reset: true,
        sopCode,
        globalDefaults: refreshed.globalDefaults,
        sops: refreshed.sops.filter((s) =>
          deptMatchesTrainerScope(s.department, auth.trainer.trainerDepartments),
        ),
        departments: auth.trainer.trainerDepartments,
      });
    }

    const baseUpdate = {
      trialQuestionCount: clampInt(body.trialQuestionCount, 0, 50, 5),
      examQuestionCount: clampInt(body.examQuestionCount, 1, 200, 20),
      passingScore: clampInt(body.passingScore, 1, 100, 80),
      maxAttempts: clampInt(body.maxAttempts, 0, 999, 0),
      timeLimitMinutes: clampInt(body.timeLimitMinutes, 0, 600, 0),
      shuffleMode: parseShuffleMode(body.shuffleMode, 'questions'),
      showAnswersAfterTrial: parseBool(body.showAnswersAfterTrial, true),
      allowRetakeAfterPass: parseBool(body.allowRetakeAfterPass, true),
    };

    const $set: Record<string, unknown> = { sopCode, ...baseUpdate };
    if ('employeeRules' in body) {
      $set.employeeRules = parseEmployeeRules(body.employeeRules, {
        ...baseUpdate,
        lmsApproved: false,
      });
    }

    const saved = await SopExamSettings.findOneAndUpdate(
      { sopCode },
      { $set },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();

    invalidateLmsServerKeys(lmsServerKeys.adminSopExamSettings());
    const mcqApproved = await isSopMcqApprovedForLms(sopCode);

    return NextResponse.json({
      ok: true,
      sopCode,
      settings: {
        trialQuestionCount: saved?.trialQuestionCount ?? baseUpdate.trialQuestionCount,
        examQuestionCount: saved?.examQuestionCount ?? baseUpdate.examQuestionCount,
        passingScore: saved?.passingScore ?? baseUpdate.passingScore,
        maxAttempts: saved?.maxAttempts ?? baseUpdate.maxAttempts,
        timeLimitMinutes: saved?.timeLimitMinutes ?? baseUpdate.timeLimitMinutes,
        shuffleMode: saved?.shuffleMode ?? baseUpdate.shuffleMode,
        showAnswersAfterTrial: saved?.showAnswersAfterTrial ?? baseUpdate.showAnswersAfterTrial,
        allowRetakeAfterPass: saved?.allowRetakeAfterPass ?? baseUpdate.allowRetakeAfterPass,
        lmsApproved: mcqApproved,
        employeeRules: Array.isArray(saved?.employeeRules) ? saved!.employeeRules : [],
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
