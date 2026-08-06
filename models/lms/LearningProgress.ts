import mongoose, { Schema, Document } from 'mongoose';

export interface IVideoStepProgress {
  completed: boolean;
  percentage: number;   // 0-100 watch percentage
  lastTimestamp: number; // seconds into the video
}

export interface ISimpleStepProgress {
  completed: boolean;
}

export interface IQuizAttemptRecord {
  attempt: number;
  score: number; // 0-100
  at: Date;
}

export interface IQuizStepProgress {
  completed: boolean;
  passed: boolean;
  score: number;      // 0-100 — latest attempt
  attempts: number;
  /** Score for each formal attempt, in order. */
  attemptHistory: IQuizAttemptRecord[];
}

export interface ILearningProgress extends Document {
  employeeId: mongoose.Types.ObjectId;
  sopCode: string;
  /** Subset of step keys that actually have content for this SOP. */
  availableSteps: string[];
  status: 'not_started' | 'in_progress' | 'completed';
  overallPercentage: number;
  steps: {
    videoEn: IVideoStepProgress;
    videoGu: IVideoStepProgress;
    slidesEn: ISimpleStepProgress;
    slidesGu: ISimpleStepProgress;
    sopPdf: ISimpleStepProgress;
    quiz: IQuizStepProgress;
  };
  startedAt?: Date;
  completedAt?: Date;
  lastAccessedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const videoStepSchema = {
  completed:     { type: Boolean, default: false },
  percentage:    { type: Number, default: 0 },
  lastTimestamp: { type: Number, default: 0 },
};

const simpleStepSchema = {
  completed: { type: Boolean, default: false },
};

const quizAttemptSchema = {
  attempt: { type: Number, required: true },
  score:   { type: Number, required: true },
  at:      { type: Date, default: Date.now },
};

const LearningProgressSchema = new Schema<ILearningProgress>(
  {
    employeeId:     { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    sopCode:        { type: String, required: true, index: true },
    availableSteps: { type: [String], default: [] },
    status: {
      type: String,
      enum: ['not_started', 'in_progress', 'completed'],
      default: 'not_started',
    },
    overallPercentage: { type: Number, default: 0 },
    steps: {
      videoEn:  { type: videoStepSchema,  default: () => ({}) },
      videoGu:  { type: videoStepSchema,  default: () => ({}) },
      slidesEn: { type: simpleStepSchema, default: () => ({}) },
      slidesGu: { type: simpleStepSchema, default: () => ({}) },
      sopPdf:   { type: simpleStepSchema, default: () => ({}) },
      quiz: {
        type: {
          completed: { type: Boolean, default: false },
          passed:    { type: Boolean, default: false },
          score:     { type: Number,  default: 0 },
          attempts:  { type: Number,  default: 0 },
          attemptHistory: { type: [quizAttemptSchema], default: [] },
        },
        default: () => ({}),
      },
    },
    startedAt:      { type: Date },
    completedAt:    { type: Date },
    lastAccessedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

LearningProgressSchema.index({ employeeId: 1, sopCode: 1 }, { unique: true });

export default mongoose.models.LearningProgress ||
  mongoose.model<ILearningProgress>('LearningProgress', LearningProgressSchema);
