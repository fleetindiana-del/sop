import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import {
  getOrBuildLmsCache,
  invalidateLmsServerKeys,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import ExamSettings from '@/models/lms/ExamSettings';
import SopExamSettings, {
  SHUFFLE_MODES,
  shuffleModeFromFlags,
  type ISopEmployeeExamRule,
  type ShuffleMode,
} from '@/models/lms/SopExamSettings';
import MCQBank from '@/models/MCQBank';
import { getGroupedRegistryRows } from '@/lib/dashboardRegistrySource';
import { baseIdentifierFromIdentifier, sopFamilyGroupKey, sortByDeptOrder } from '@/lib/sop-utils';
import { buildActiveSopFamilyMap } from '@/lib/mcq-bank-utils';
import {
  getDashboardDepartments,
  isDashboardDepartmentName,
} from '@/lib/dashboardDepartments';

export const dynamic = 'force-dynamic';

export interface SopExamSettingsPayload {
  trialQuestionCount: number;
  examQuestionCount: number;
  passingScore: number;
  maxAttempts: number;
  timeLimitMinutes: number;
  shuffleMode: ShuffleMode;
  showAnswersAfterTrial: boolean;
  allowRetakeAfterPass: boolean;
  /** True when every MCQ for this SOP is checked in MCQ Bank. */
  lmsApproved: boolean;
  employeeRules: ISopEmployeeExamRule[];
}

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

function parseEmployeeRules(raw: unknown, fallbackBase: Omit<SopExamSettingsPayload, 'employeeRules'>): ISopEmployeeExamRule[] {
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
      // Trainers always require 100% to pass, unlimited attempts, and the full bank at runtime.
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

function payloadFromDoc(
  doc: Partial<SopExamSettingsPayload> & { employeeRules?: ISopEmployeeExamRule[] } | null | undefined,
  fallback: SopExamSettingsPayload,
): SopExamSettingsPayload {
  const base = {
    trialQuestionCount: doc?.trialQuestionCount ?? fallback.trialQuestionCount,
    examQuestionCount: doc?.examQuestionCount ?? fallback.examQuestionCount,
    passingScore: doc?.passingScore ?? fallback.passingScore,
    maxAttempts: doc?.maxAttempts ?? fallback.maxAttempts,
    timeLimitMinutes: doc?.timeLimitMinutes ?? fallback.timeLimitMinutes,
    shuffleMode: doc?.shuffleMode ?? fallback.shuffleMode,
    showAnswersAfterTrial: doc?.showAnswersAfterTrial ?? fallback.showAnswersAfterTrial,
    allowRetakeAfterPass: doc?.allowRetakeAfterPass ?? fallback.allowRetakeAfterPass,
    // Overwritten from MCQ Bank in buildSopList; keep fallback for structure only.
    lmsApproved: fallback.lmsApproved,
  };
  return {
    ...base,
    employeeRules: Array.isArray(doc?.employeeRules)
      ? parseEmployeeRules(doc.employeeRules, base)
      : (fallback.employeeRules ?? []),
  };
}

async function buildSopList() {
  await connectDB();

  const [globalDoc, sopSettings, banks, grouped, dashboardDepartments] = await Promise.all([
    ExamSettings.findOneAndUpdate(
      { settingsKey: 'global' },
      { $setOnInsert: { settingsKey: 'global' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean(),
    SopExamSettings.find({}).lean(),
    MCQBank.aggregate<{
      _id: string;
      sopName: string;
      department: string;
      bankQuestionCount: number;
      totalQuestions: number;
      checkedQuestions: number;
    }>([
      { $match: { isObsolete: { $ne: true } } },
      {
        $project: {
          sopIdentifier: 1,
          sopName: 1,
          department: 1,
          qCount: {
            $size: {
              $filter: {
                input: { $ifNull: ['$mcqs', []] },
                as: 'q',
                cond: { $ne: ['$$q.isSimilar', true] },
              },
            },
          },
          totalQuestions: { $size: { $ifNull: ['$mcqs', []] } },
          checkedQuestions: {
            $size: {
              $filter: {
                input: { $ifNull: ['$mcqs', []] },
                as: 'q',
                cond: { $eq: ['$$q.isChecked', true] },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: '$sopIdentifier',
          sopName: { $first: '$sopName' },
          department: { $first: '$department' },
          bankQuestionCount: { $sum: '$qCount' },
          totalQuestions: { $sum: '$totalQuestions' },
          checkedQuestions: { $sum: '$checkedQuestions' },
        },
      },
    ]),
    getGroupedRegistryRows(),
    getDashboardDepartments(),
  ]);

  // Same universe as Dashboard / MCQ Bank: active registry families only
  // (excludes obsolete SOPs and "Other" department codes).
  const activeFamilyMap = buildActiveSopFamilyMap(grouped);
  const dashboardDeptSet = new Set(dashboardDepartments.map((d) => d.toLowerCase()));

  // Prefer the Dashboard registry department name for each family.
  const registryDeptByFam = new Map<string, string>();
  const registryNameByFam = new Map<string, string>();
  for (const row of grouped) {
    if (row.isObsolete) continue;
    if (!isDashboardDepartmentName(row.department)) continue;
    if (!dashboardDeptSet.has(String(row.department).trim().toLowerCase())) continue;
    const famKey = sopFamilyGroupKey(row);
    if (!registryDeptByFam.has(famKey)) {
      registryDeptByFam.set(famKey, String(row.department).trim());
      registryNameByFam.set(famKey, row.name);
    }
  }

  const globalDefaults: SopExamSettingsPayload = {
    trialQuestionCount: globalDoc?.trialQuestionCount ?? 5,
    examQuestionCount: globalDoc?.examQuestionCount ?? 20,
    passingScore: globalDoc?.passingScore ?? 80,
    maxAttempts: globalDoc?.maxAttempts ?? 0,
    timeLimitMinutes: globalDoc?.timeLimitMinutes ?? 0,
    shuffleMode: shuffleModeFromFlags(
      globalDoc?.shuffleQuestions ?? true,
      globalDoc?.shuffleOptions ?? false,
    ),
    showAnswersAfterTrial: globalDoc?.showAnswersAfterTrial ?? true,
    allowRetakeAfterPass: globalDoc?.allowRetakeAfterPass ?? true,
    lmsApproved: true,
    employeeRules: [],
  };

  const settingsByCode = new Map(
    sopSettings.map((s) => [String(s.sopCode).toUpperCase(), s]),
  );

  type FamilyRow = {
    sopCode: string;
    sopName: string;
    department: string;
    bankQuestionCount: number;
    totalQuestions: number;
    checkedQuestions: number;
  };
  const families = new Map<string, FamilyRow>();
  for (const b of banks) {
    const raw = String(b._id || '').trim();
    if (!raw) continue;
    const famKey = sopFamilyGroupKey({ identifier: raw });
    const active = activeFamilyMap.get(famKey);
    // Drop banks for obsolete SOPs, deleted families, or Other-dept codes.
    if (!active) continue;

    const department = registryDeptByFam.get(famKey) || active.dept;
    if (!isDashboardDepartmentName(department)) continue;
    if (!dashboardDeptSet.has(department.toLowerCase())) continue;

    const sopCode =
      baseIdentifierFromIdentifier(active.identifier).toUpperCase() ||
      baseIdentifierFromIdentifier(raw).toUpperCase() ||
      raw.toUpperCase();
    const sopName = registryNameByFam.get(famKey) || active.name || b.sopName || sopCode;
    const prev = families.get(sopCode);
    if (!prev) {
      families.set(sopCode, {
        sopCode,
        sopName,
        department,
        bankQuestionCount: b.bankQuestionCount || 0,
        totalQuestions: b.totalQuestions || 0,
        checkedQuestions: b.checkedQuestions || 0,
      });
    } else {
      prev.bankQuestionCount += b.bankQuestionCount || 0;
      prev.totalQuestions += b.totalQuestions || 0;
      prev.checkedQuestions += b.checkedQuestions || 0;
      if (!prev.sopName && sopName) prev.sopName = sopName;
    }
  }

  const sops = [...families.values()]
    .filter((fam) => fam.bankQuestionCount > 0)
    .sort((a, b) => {
      const ordered = sortByDeptOrder([a.department, b.department]);
      if (ordered[0] === a.department && ordered[0] !== b.department) return -1;
      if (ordered[0] === b.department && ordered[0] !== a.department) return 1;
      return a.sopCode.localeCompare(b.sopCode);
    })
    .map((fam) => {
      const override = settingsByCode.get(fam.sopCode);
      const settings = override ? payloadFromDoc(override, globalDefaults) : null;
      const mcqApproved =
        fam.totalQuestions > 0 && fam.checkedQuestions >= fam.totalQuestions;
      const withApproval = (p: SopExamSettingsPayload): SopExamSettingsPayload => ({
        ...p,
        lmsApproved: mcqApproved,
      });
      const settingsOut = settings ? withApproval(settings) : null;
      const effective = withApproval(settingsOut ?? globalDefaults);
      return {
        sopCode: fam.sopCode,
        sopName: fam.sopName,
        department: fam.department,
        bankQuestionCount: fam.bankQuestionCount,
        hasOverride: !!settings,
        employeeRuleCount: settings?.employeeRules?.length ?? 0,
        settings: settingsOut,
        effective,
      };
    });

  return { globalDefaults, sops, departments: dashboardDepartments };
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.adminSopExamSettings(),
      lmsServerTtl.adminSopExamSettings,
      buildSopList,
    );
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'private, no-store, max-age=0' },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    await connectDB();
    const body = (await req.json()) as Record<string, unknown>;
    const rawCode = String(body.sopCode || '').trim();
    if (!rawCode) {
      return NextResponse.json({ error: 'sopCode is required' }, { status: 400 });
    }
    const sopCode = (
      baseIdentifierFromIdentifier(rawCode) || rawCode
    ).toUpperCase();

    if (body.reset === true) {
      await SopExamSettings.deleteOne({ sopCode });
      invalidateLmsServerKeys(lmsServerKeys.adminSopExamSettings());
      const list = await buildSopList();
      return NextResponse.json({
        ok: true,
        reset: true,
        sopCode,
        ...list,
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
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    invalidateLmsServerKeys(lmsServerKeys.adminSopExamSettings());

    const { isSopMcqApprovedForLms } = await import('@/lib/lmsMcqApproval');
    const mcqApproved = await isSopMcqApprovedForLms(sopCode);
    const fallback: SopExamSettingsPayload = {
      ...baseUpdate,
      lmsApproved: mcqApproved,
      employeeRules: [],
    };
    return NextResponse.json({
      ok: true,
      sopCode,
      settings: {
        ...payloadFromDoc(saved, fallback),
        lmsApproved: mcqApproved,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
