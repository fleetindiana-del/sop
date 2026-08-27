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
import { isSopMcqApprovedForLms } from '@/lib/lmsMcqApproval';

/** Trainers answer this many questions per exam (or the full pool if smaller). */
export const TRAINER_EXAM_QUESTION_COUNT = 100;

/** Randomly pick `cap` items when the pool is larger; otherwise return the pool as-is. */
export function sampleTrainerExamQuestions<T>(
  rows: T[],
  cap: number = TRAINER_EXAM_QUESTION_COUNT,
): T[] {
  if (rows.length <= cap) return rows;
  const picked = rows.slice();
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked.slice(0, cap);
}

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
  /** Trainers sit up to TRAINER_EXAM_QUESTION_COUNT questions with unlimited attempts until they score 100%. */
  isTrainer: boolean;
  /**
   * When true, exam samples from the full non-similar MCQ pool (not the SOP's
   * learner examQuestionCount). Trainers are still capped at TRAINER_EXAM_QUESTION_COUNT.
   */
  allExamQuestions: boolean;
  /** True when every MCQ for this SOP is checked in MCQ Bank (display only; does not lock exams). */
  lmsApproved: boolean;
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
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
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

  // LMS exam release is driven by MCQ Bank: all questions must be checked.
  const lmsApproved = await isSopMcqApprovedForLms(code);

  // SOP employee rule beats everything else for that person on this SOP.
  const empRule: ISopEmployeeExamRule | undefined =
    employee?.id && sopDoc?.employeeRules?.length
      ? sopDoc.employeeRules.find((r) => r.employeeId === employee.id)
      : undefined;

  const isTrainer = employee?.isTrainer === true || empRule?.isTrainer === true;

  // Trainers: up to 100 questions from the full pool + unlimited attempts + 100% to pass.
  const applyTrainerRules = <T extends {
    passingScore: number;
    maxAttempts: number;
    examQuestionCount: number;
  }>(settings: T): T & { isTrainer: boolean; allExamQuestions: boolean } => {
    if (!isTrainer) {
      return { ...settings, isTrainer: false, allExamQuestions: false };
    }
    return {
      ...settings,
      examQuestionCount: TRAINER_EXAM_QUESTION_COUNT,
      passingScore: 100,
      defaultPassingScore: 100,
      maxAttempts: 0,
      isTrainer: true,
      allExamQuestions: true,
    } as T & { isTrainer: boolean; allExamQuestions: boolean };
  };

  if (empRule) {
    const flags = flagsFromShuffleMode(empRule.shuffleMode);
    const pass = isTrainer ? 100 : empRule.passingScore;
    return applyTrainerRules({
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
      lmsApproved,
      sopCode: code,
    });
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

  return applyTrainerRules({
    ...base,
    ...flags,
    passingScore,
    hasSopOverride,
    hasEmployeeRule: false,
    lmsApproved,
    sopCode: code,
  });
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
    isTrainer: resolved.isTrainer,
    allExamQuestions: resolved.allExamQuestions,
    lmsApproved: resolved.lmsApproved,
  };
}
