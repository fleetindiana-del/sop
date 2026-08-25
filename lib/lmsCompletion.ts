/**
 * The single definition of "this training is complete".
 *
 * This rule used to exist in three places with two different meanings: the
 * learner's progress endpoint treated the assessment as the only mandatory step
 * (pass the exam in *either* language → 100% and a certificate), while the admin
 * and trainer roll-ups required every available step in *every* language to be
 * ticked. The result was learners holding certificates while the admin capsules
 * reported zero completions.
 *
 * Everything that reports completion must go through here.
 */

/** Progress step ids a learner can complete. */
export const LMS_STEP_IDS = [
  'videoEn', 'videoGu',
  'slidesEn', 'slidesGu',
  'sopPdf', 'sopPdfGu',
  'quiz', 'quizGu',
] as const;

export type LmsStepId = (typeof LMS_STEP_IDS)[number];

/**
 * Progress steps behind each column the admin and trainer screens show.
 *
 * The two entries in each group are the same material in English and Gujarati,
 * not two separate requirements — see {@link componentStatus}.
 */
export const COMPONENT_GROUPS = {
  videos: ['videoEn', 'videoGu'],
  slides: ['slidesEn', 'slidesGu'],
  sopDoc: ['sopPdf', 'sopPdfGu'],
  mcq: ['quiz', 'quizGu'],
} as const;

export type ComponentKey = keyof typeof COMPONENT_GROUPS;
export type ComponentStatus = 'completed' | 'not_completed' | 'na';
export type SopStatus = 'completed' | 'not_completed';

export function isStepDone(
  steps: Record<string, unknown> | undefined,
  stepId: string,
): boolean {
  const s = steps?.[stepId] as { completed?: boolean } | undefined;
  return s?.completed === true;
}

function isQuizStep(stepId: string): boolean {
  return stepId === 'quiz' || stepId === 'quizGu';
}

/**
 * Overall completion percentage for one SOP.
 *
 * - With an assessment: the assessment is the only mandatory step. Passing it in
 *   either language completes the training and unlocks the certificate. Before
 *   that, optional material shows partial progress capped at 90%.
 * - Without an assessment: every available step counts equally.
 */
export function recalcOverallPercent(
  steps: Record<string, unknown>,
  availableSteps: readonly string[],
): number {
  if (availableSteps.length === 0) return 0;

  const quizKeys = availableSteps.filter(isQuizStep);
  if (quizKeys.length > 0) {
    if (quizKeys.some((k) => isStepDone(steps, k))) return 100;

    const optionalSteps = availableSteps.filter((k) => !isQuizStep(k));
    if (optionalSteps.length === 0) return 0;
    const doneOptional = optionalSteps.filter((k) => isStepDone(steps, k)).length;
    return Math.round((doneOptional / optionalSteps.length) * 90);
  }

  const completedCount = availableSteps.filter((k) => isStepDone(steps, k)).length;
  return Math.round((completedCount / availableSteps.length) * 100);
}

/**
 * Whether one learner has completed one SOP.
 *
 * The learner's stored record wins when it says completed: that is the state
 * they were shown and the state their certificate was issued against, and it
 * was calculated from the steps that existed at the time. Recomputing from
 * today's journey content is the fallback for records written before a step was
 * added, or never written at all.
 */
export function isSopComplete(input: {
  steps?: Record<string, unknown>;
  /** Step ids the SOP currently offers, from `getJourneyContentBatch`. */
  availableSteps: readonly string[];
  /** Stored `LearningProgress.status`, when the caller selected it. */
  status?: string;
  /** Stored `LearningProgress.overallPercentage`, when the caller selected it. */
  overallPercentage?: number;
}): boolean {
  if (input.status === 'completed' && (input.overallPercentage ?? 0) >= 100) return true;
  return recalcOverallPercent(input.steps ?? {}, input.availableSteps) >= 100;
}

/**
 * Status of one component column for one SOP.
 *
 * `na` when the SOP carries no material of this kind. Otherwise the learner
 * only has to complete the material in *one* language: the LMS presents English
 * and Gujarati as a choice ("pick the one you read most comfortably"), so
 * requiring both would mark every bilingual SOP permanently incomplete.
 */
export function componentStatus(
  availableSet: ReadonlySet<string>,
  steps: Record<string, unknown> | undefined,
  groupSteps: readonly string[],
): ComponentStatus {
  const present = groupSteps.filter((s) => availableSet.has(s));
  if (present.length === 0) return 'na';
  return present.some((s) => isStepDone(steps, s)) ? 'completed' : 'not_completed';
}

/** Every component column for one SOP. */
export function componentStatuses(
  availableSet: ReadonlySet<string>,
  steps: Record<string, unknown> | undefined,
): Record<ComponentKey, ComponentStatus> {
  return Object.fromEntries(
    (Object.keys(COMPONENT_GROUPS) as ComponentKey[]).map((key) => [
      key,
      componentStatus(availableSet, steps, COMPONENT_GROUPS[key]),
    ]),
  ) as Record<ComponentKey, ComponentStatus>;
}
