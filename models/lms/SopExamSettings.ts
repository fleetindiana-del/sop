import mongoose, { Schema, Document } from 'mongoose';

/**
 * How questions/options are presented to employees for a given SOP exam.
 *
 * - options:   shuffle A/B/C/D only; same question set for everyone
 * - questions: different question samples per employee (order randomised)
 * - both:      shuffle options + different questions per employee
 * - none:      fixed question set and option order for all employees
 */
export type ShuffleMode = 'options' | 'questions' | 'both' | 'none';

export const SHUFFLE_MODES: ShuffleMode[] = ['options', 'questions', 'both', 'none'];

/** Per-employee override for a single SOP (highest priority for that person). */
export interface ISopEmployeeExamRule {
  employeeId: string;
  employeeName: string;
  department?: string;
  designation?: string;
  /** When true, this employee must achieve 100% to pass the exam. */
  isTrainer?: boolean;
  trialQuestionCount: number;
  examQuestionCount: number;
  passingScore: number;
  maxAttempts: number;
  timeLimitMinutes: number;
  shuffleMode: ShuffleMode;
  showAnswersAfterTrial: boolean;
  allowRetakeAfterPass: boolean;
}

export interface ISopExamSettings extends Document {
  /** Base SOP code (family key), e.g. PEGE11 — unique. */
  sopCode: string;
  trialQuestionCount: number;
  examQuestionCount: number;
  passingScore: number;
  maxAttempts: number;
  timeLimitMinutes: number;
  shuffleMode: ShuffleMode;
  showAnswersAfterTrial: boolean;
  allowRetakeAfterPass: boolean;
  /**
   * When true, the SOP is released for LMS training/exams.
   * When false, learners can still see the assignment but cannot start the exam.
   */
  lmsApproved: boolean;
  /** Employee-specific overrides for this SOP. */
  employeeRules: ISopEmployeeExamRule[];
  updatedAt: Date;
  createdAt: Date;
}

const SopEmployeeExamRuleSchema = new Schema<ISopEmployeeExamRule>(
  {
    employeeId:            { type: String, required: true },
    employeeName:          { type: String, required: true },
    department:            { type: String, default: '' },
    designation:           { type: String, default: '' },
    isTrainer:             { type: Boolean, default: false },
    trialQuestionCount:    { type: Number, default: 5,  min: 0, max: 50 },
    examQuestionCount:     { type: Number, default: 20, min: 1, max: 200 },
    passingScore:          { type: Number, default: 80, min: 1, max: 100 },
    maxAttempts:           { type: Number, default: 0,  min: 0 },
    timeLimitMinutes:      { type: Number, default: 0,  min: 0 },
    shuffleMode:           { type: String, enum: SHUFFLE_MODES, default: 'questions' },
    showAnswersAfterTrial: { type: Boolean, default: true },
    allowRetakeAfterPass:  { type: Boolean, default: true },
  },
  { _id: false },
);

const SopExamSettingsSchema = new Schema<ISopExamSettings>(
  {
    sopCode:               { type: String, required: true, unique: true, uppercase: true, trim: true },
    trialQuestionCount:    { type: Number, default: 5,   min: 0, max: 50 },
    examQuestionCount:     { type: Number, default: 20,  min: 1, max: 200 },
    passingScore:          { type: Number, default: 80,  min: 1, max: 100 },
    maxAttempts:           { type: Number, default: 0,   min: 0 },
    timeLimitMinutes:      { type: Number, default: 0,   min: 0 },
    shuffleMode:           {
      type: String,
      enum: SHUFFLE_MODES,
      default: 'questions',
    },
    showAnswersAfterTrial: { type: Boolean, default: true },
    allowRetakeAfterPass:  { type: Boolean, default: true },
    // Default true so existing SOPs stay exam-ready until an admin unchecks Approved.
    lmsApproved:           { type: Boolean, default: true },
    employeeRules:         { type: [SopEmployeeExamRuleSchema], default: [] },
  },
  { timestamps: true },
);

SopExamSettingsSchema.index({ sopCode: 1 }, { unique: true });
SopExamSettingsSchema.index({ 'employeeRules.employeeId': 1 });

export function shuffleModeFromFlags(
  shuffleQuestions: boolean,
  shuffleOptions: boolean,
): ShuffleMode {
  if (shuffleQuestions && shuffleOptions) return 'both';
  if (shuffleQuestions) return 'questions';
  if (shuffleOptions) return 'options';
  return 'none';
}

export function flagsFromShuffleMode(mode: ShuffleMode): {
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
} {
  return {
    shuffleQuestions: mode === 'questions' || mode === 'both',
    shuffleOptions: mode === 'options' || mode === 'both',
  };
}

if (mongoose.models.SopExamSettings) delete mongoose.models.SopExamSettings;
export default mongoose.model<ISopExamSettings>('SopExamSettings', SopExamSettingsSchema);
