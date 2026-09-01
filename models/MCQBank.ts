import mongoose, { Schema, Document, Model } from "mongoose";

export type DifficultyLevel = "Easy" | "Medium" | "Hard";

export interface IOptionVariant {
  text: string;
  isCorrect: boolean;
}

/** Language codes an MCQ can be translated into. The master text is always English. */
export type McqTranslationLang = "gu";

/**
 * One language version of a master MCQ. This is NOT an independent question —
 * `options` must stay in the SAME ORDER as the master's `options`, so the master's
 * correct index carries over unchanged and scoring is identical in every language.
 * `correctAnswer` is the translated text at that same index (mirroring how the
 * master stores option TEXT rather than a letter).
 */
export interface IMcqTranslation {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation: string;
  /** The master's `sopReference` in this language — clause numbers unchanged, the
   *  clause title translated. Absent on translations made before it was captured;
   *  readers fall back to the master's English reference. */
  sopReference?: string;
  /** Model/provider that produced the translation, e.g. "codex:gpt-5.4-mini". */
  model: string;
  translatedAt: Date;
  /** Set when the English master changed after this translation was made. */
  isStale?: boolean;
  /** Set once a trainer/admin has confirmed the translation reads correctly. */
  isVerified?: boolean;
}

export interface IMCQ {
  /**
   * Stable per-question id, assigned at write time. Translations, LMS question
   * ids and review state key off this rather than array position, which shifts
   * whenever a question is deleted or the bank is regenerated.
   */
  mcqId?: string;
  aiIcon: string;
  question: string;
  difficulty: DifficultyLevel;
  difficultyStars: "⭐" | "⭐⭐" | "⭐⭐⭐";
  options: string[];
  correctAnswer: string;
  explanation: string;
  sopReference: string;
  optionVariants: IOptionVariant[];
  isChecked?: boolean;
  isReviewed?: boolean;
  isSimilar?: boolean;
  /** True when this MCQ was generated from linked annexure content (Annex swap). */
  fromAnnexure?: boolean;
  /** True when this MCQ came from creative/scenario fill near the bank cap. */
  isCreative?: boolean;
  /** Language versions of THIS question, keyed by language code (e.g. "gu"). */
  translations?: Map<McqTranslationLang, IMcqTranslation> | Record<string, IMcqTranslation>;
}

/**
 * What the generation run did with the SOP's linked annexures. Recorded at write
 * time because the registry cannot tell after the fact whether a bank's questions
 * saw annexure text — annexures may have been linked after the MCQs were made.
 */
export interface IMcqAnnexureUsage {
  /** Annexure files linked to the SOP family when this run started. */
  linkedCount: number;
  /** Linked annexures whose text was extracted and folded into the prompt. */
  includedCount: number;
  /** Linked annexures that could not be read (missing file, image-only, .doc). */
  skippedCount: number;
  /** Labels of the annexures whose text was included. */
  includedLabels: string[];
  recordedAt: Date;
}

export interface IMCQBank extends Document {
  sopId: mongoose.Types.ObjectId;
  sopName: string;
  sopIdentifier: string;
  department: string;
  folderDepartment?: string;
  folderSubcategory?: string;
  mcqs: IMCQ[];
  generatedAt: Date;
  totalQuestions: number;
  /** How many masters carry a stored translation, per language. Denormalized like
   *  `totalQuestions`: LMS counts must not walk `$mcqs` on Atlas (45s timeouts). */
  translatedCounts?: Partial<Record<McqTranslationLang, number>>;
  difficultyDistribution: { easy: number; medium: number; hard: number };
  aiModel?: string;
  language?: "English" | "Gujarati";
  /** Absent on banks generated before annexure usage was tracked. */
  annexureUsage?: IMcqAnnexureUsage;
  isObsolete?: boolean;
  obsoleteAt?: Date;
  obsoleteReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OptionVariantSchema = new Schema<IOptionVariant>(
  { text: { type: String, required: true }, isCorrect: { type: Boolean, required: true } },
  { _id: false },
);

const McqTranslationSchema = new Schema<IMcqTranslation>(
  {
    question: { type: String, required: true },
    options: {
      type: [String],
      required: true,
      validate: { validator: (v: string[]) => v.length === 4, message: "Exactly 4 options required" },
    },
    correctAnswer: { type: String, required: true },
    explanation: { type: String, default: "" },
    sopReference: { type: String, default: "" },
    model: { type: String, default: "" },
    translatedAt: { type: Date, default: Date.now },
    isStale: { type: Boolean, default: false },
    isVerified: { type: Boolean, default: false },
  },
  { _id: false },
);

const MCQSchema = new Schema<IMCQ>(
  {
    mcqId: { type: String },
    aiIcon: { type: String, required: true },
    question: { type: String, required: true },
    difficulty: { type: String, enum: ["Easy", "Medium", "Hard"], required: true },
    difficultyStars: { type: String, enum: ["⭐", "⭐⭐", "⭐⭐⭐"], required: true },
    options: {
      type: [String],
      required: true,
      validate: { validator: (v: string[]) => v.length === 4, message: "Exactly 4 options required" },
    },
    correctAnswer: { type: String, required: true },
    explanation: { type: String, required: true },
    sopReference: { type: String, required: true },
    optionVariants: { type: [OptionVariantSchema], default: [] },
    isChecked: { type: Boolean, default: false },
    isReviewed: { type: Boolean, default: false },
    isSimilar: { type: Boolean, default: false },
    fromAnnexure: { type: Boolean, default: false },
    isCreative: { type: Boolean, default: false },
    translations: { type: Map, of: McqTranslationSchema, default: undefined },
  },
  { _id: false },
);

const McqAnnexureUsageSchema = new Schema<IMcqAnnexureUsage>(
  {
    linkedCount: { type: Number, default: 0 },
    includedCount: { type: Number, default: 0 },
    skippedCount: { type: Number, default: 0 },
    includedLabels: { type: [String], default: [] },
    recordedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const MCQBankSchema = new Schema<IMCQBank>(
  {
    sopId: { type: Schema.Types.ObjectId, ref: "SOP", required: true },
    sopName: { type: String, required: true },
    sopIdentifier: { type: String, required: true },
    department: { type: String, required: true, default: "General" },
    folderDepartment: { type: String },
    folderSubcategory: { type: String },
    mcqs: {
      type: [MCQSchema],
      required: true,
      validate: { validator: (v: IMCQ[]) => v.length >= 1 && v.length <= 500, message: "MCQs must be 1–500" },
    },
    generatedAt: { type: Date, default: Date.now },
    totalQuestions: { type: Number, required: true },
    translatedCounts: { type: Map, of: Number, default: undefined },
    difficultyDistribution: {
      easy: { type: Number, default: 0 },
      medium: { type: Number, default: 0 },
      hard: { type: Number, default: 0 },
    },
    aiModel: { type: String, default: "gemini-2.5-flash" },
    language: { type: String, enum: ["English", "Gujarati"], default: "English" },
    annexureUsage: { type: McqAnnexureUsageSchema },
    isObsolete: { type: Boolean, default: false },
    obsoleteAt: { type: Date },
    obsoleteReason: { type: String },
  },
  { timestamps: true },
);

MCQBankSchema.pre("save", function () {
  if (this.mcqs) this.totalQuestions = this.mcqs.length;
});

MCQBankSchema.index({ "mcqs.mcqId": 1 });
MCQBankSchema.index({ sopId: 1 });
MCQBankSchema.index({ sopId: 1, language: 1 });
MCQBankSchema.index({ sopIdentifier: 1 });
MCQBankSchema.index({ department: 1 });
MCQBankSchema.index({ folderDepartment: 1 });
MCQBankSchema.index({ folderDepartment: 1, folderSubcategory: 1 });

if (mongoose.models.MCQBank) delete mongoose.models.MCQBank;
const MCQBank: Model<IMCQBank> = mongoose.model<IMCQBank>("MCQBank", MCQBankSchema);
export default MCQBank;
