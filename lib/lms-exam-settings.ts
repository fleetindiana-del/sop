import ExamSettings, {
  resolvePassingScore,
  type IExamSettings,
  type IPassingScoreRule,
} from '@/models/lms/ExamSettings';
import SopExamSettings, {
  flagsFromShuffleMode,
  shuffleModeFromFlags,
  type ISopEmployeeExamRule,
  type ShuffleMode,
} from '@/models/lms/SopExamSettings';
import { baseIdentifierFromIdentifier } from '@/lib/sop-utils';

export interface ResolvedExamSettings {
  trialQuestionCount: number;
  examQuestionCount: number;
  /** Employee-resolved pass mark (rules applied against the SOP/global default). */
  passingScore: number;
  /** Base pass mark before employee/dept rules (SOP override or global default). */
  defaultPassingScore: number;
  maxAttempts: number;
  timeLimitMinutes: number;
  shuffleMode: ShuffleMode;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  showAnswersAfterTrial: boolean;
  allowRetakeAfterPass: boolean;
  /** True when a SopExamSettings document exists for this SOP. */
  hasSopOverride: boolean;
  /** True when a SOP employee-specific rule was applied. */
  hasEmployeeRule: boolean;
  sopCode: string;
}

function normalizeSopCode(sopCode: string): string {
  const raw = String(sopCode || '').trim();
  return (baseIdentifierFromIdentifier(raw) || raw).toUpperCase();
}

/**
 * Resolve effective exam settings for a SOP:
 * global defaults ← SOP override ← SOP employee rule (if any)
 * ← global employee/dept passing-score rules (only when no SOP employee rule).
 */
export async function resolveExamSettingsForSop(
  sopCode: string,
  employee?: {
    id?: string;
    department?: string;
    designation?: string;
    isTrainer?: boolean;
  } | null,
): Promise<ResolvedExamSettings> {
  const code = normalizeSopCode(sopCode);

  const [globalDoc, sopDoc] = await Promise.all([
    ExamSettings.findOneAndUpdate(
      { settingsKey: 'global' },
      { $setOnInsert: { settingsKey: 'global' } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean<IExamSettings>(),
    code
      ? SopExamSettings.findOne({ sopCode: code }).lean()
      : Promise.resolve(null),
  ]);

  const globalShuffle = shuffleModeFromFlags(
    globalDoc?.shuffleQuestions ?? true,
    globalDoc?.shuffleOptions ?? false,
  );

  const base = {
    trialQuestionCount: globalDoc?.trialQuestionCount ?? 5,
    examQuestionCount: globalDoc?.examQuestionCount ?? 20,
    defaultPassingScore: globalDoc?.passingScore ?? 80,
    maxAttempts: globalDoc?.maxAttempts ?? 0,
    timeLimitMinutes: globalDoc?.timeLimitMinutes ?? 0,
    shuffleMode: globalShuffle,
    showAnswersAfterTrial: globalDoc?.showAnswersAfterTrial ?? true,
    allowRetakeAfterPass: globalDoc?.allowRetakeAfterPass ?? true,
  };

  const hasSopOverride = !!sopDoc;
  if (sopDoc) {
    base.trialQuestionCount = sopDoc.trialQuestionCount ?? base.trialQuestionCount;
    base.examQuestionCount = sopDoc.examQuestionCount ?? base.examQuestionCount;
    base.defaultPassingScore = sopDoc.passingScore ?? base.defaultPassingScore;
    base.maxAttempts = sopDoc.maxAttempts ?? base.maxAttempts;
    base.timeLimitMinutes = sopDoc.timeLimitMinutes ?? base.timeLimitMinutes;
    base.shuffleMode = sopDoc.shuffleMode ?? base.shuffleMode;
    base.showAnswersAfterTrial = sopDoc.showAnswersAfterTrial ?? base.showAnswersAfterTrial;
    base.allowRetakeAfterPass = sopDoc.allowRetakeAfterPass ?? base.allowRetakeAfterPass;
  }

  // SOP employee rule beats everything else for that person on this SOP.
  const empRule: ISopEmployeeExamRule | undefined =
    employee?.id && sopDoc?.employeeRules?.length
      ? sopDoc.employeeRules.find((r) => r.employeeId === employee.id)
      : undefined;

  const isTrainer = employee?.isTrainer === true || empRule?.isTrainer === true;

  if (empRule) {
    const flags = flagsFromShuffleMode(empRule.shuffleMode);
    const pass = isTrainer ? 100 : empRule.passingScore;
    return {
      trialQuestionCount: empRule.trialQuestionCount,
      examQuestionCount: empRule.examQuestionCount,
      defaultPassingScore: pass,
      passingScore: pass,
      maxAttempts: empRule.maxAttempts,
      timeLimitMinutes: empRule.timeLimitMinutes,
      shuffleMode: empRule.shuffleMode,
      ...flags,
      showAnswersAfterTrial: empRule.showAnswersAfterTrial,
      allowRetakeAfterPass: empRule.allowRetakeAfterPass,
      hasSopOverride,
      hasEmployeeRule: true,
      sopCode: code,
    };
  }

  const flags = flagsFromShuffleMode(base.shuffleMode);
  const rules: IPassingScoreRule[] = globalDoc?.passingScoreRules ?? [];
  let passingScore = resolvePassingScore(
    rules,
    employee?.department ?? '',
    employee?.designation ?? '',
    base.defaultPassingScore,
    employee?.id,
  );
  // Trainers must achieve 100% on every exam, even without a per-SOP rule.
  if (isTrainer) passingScore = 100;

  return {
    ...base,
    ...flags,
    passingScore,
    hasSopOverride,
    hasEmployeeRule: false,
    sopCode: code,
  };
}

/** Learner-facing settings payload returned by quiz APIs. */
export function toLearnerQuizSettings(resolved: ResolvedExamSettings) {
  return {
    passingScore: resolved.passingScore,
    timeLimitMinutes: resolved.timeLimitMinutes,
    shuffleMode: resolved.shuffleMode,
    shuffleQuestions: resolved.shuffleQuestions,
    shuffleOptions: resolved.shuffleOptions,
    showAnswersAfterTrial: resolved.showAnswersAfterTrial,
    allowRetakeAfterPass: resolved.allowRetakeAfterPass,
    maxAttempts: resolved.maxAttempts,
    examQuestionCount: resolved.examQuestionCount,
    trialQuestionCount: resolved.trialQuestionCount,
    hasSopOverride: resolved.hasSopOverride,
    hasEmployeeRule: resolved.hasEmployeeRule,
  };
}
