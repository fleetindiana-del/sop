import mongoose, { Schema, Document } from 'mongoose';

/**
 * The questions a learner answered incorrectly in one formal exam attempt, and
 * which of them they acknowledged — the source of the Acknowledgement Letter and
 * the attempt detail view.
 *
 * One document per (employee, SOP, attempt), written when the attempt is
 * submitted with every wrong question unacknowledged. Ticking the
 * acknowledgement on the review screen sets `acknowledged` on that question;
 * unticking clears it. The question itself stays — it was still answered wrong.
 */
export interface IAcknowledgedQuestion {
  questionId: string;
  question: string;
  /** Letter the learner chose; empty when the question was left unanswered. */
  givenAnswer: string;
  givenText: string;
  correctAnswer: string;
  correctText: string;
  sopReference?: string;
  explanation?: string;
  /** Ticked by the learner. Entries saved before the flag existed were stored only when ticked. */
  acknowledged?: boolean;
  acknowledgedAt?: Date;
}

export interface IExamAcknowledgement extends Document {
  employeeId: mongoose.Types.ObjectId;
  sopCode: string;
  sopName?: string;
  /** Progress step the attempt was recorded under ('quiz', or legacy 'quizGu'). */
  step: string;
  attempt: number;
  /** Score of the attempt, copied from its attempt record. */
  score: number;
  /** When the attempt was submitted, copied from its attempt record. */
  attemptAt?: Date;
  questions: IAcknowledgedQuestion[];
  createdAt: Date;
  updatedAt: Date;
}

const AcknowledgedQuestionSchema = new Schema<IAcknowledgedQuestion>(
  {
    questionId:     { type: String, required: true },
    question:       { type: String, required: true },
    givenAnswer:    { type: String, default: '' },
    givenText:      { type: String, default: '' },
    correctAnswer:  { type: String, required: true },
    correctText:    { type: String, default: '' },
    sopReference:   { type: String, default: '' },
    explanation:    { type: String, default: '' },
    acknowledged:   { type: Boolean, default: false },
    acknowledgedAt: { type: Date },
  },
  { _id: false },
);

const ExamAcknowledgementSchema = new Schema<IExamAcknowledgement>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    sopCode:    { type: String, required: true },
    sopName:    { type: String, default: '' },
    step:       { type: String, default: 'quiz' },
    attempt:    { type: Number, required: true },
    score:      { type: Number, default: 0 },
    attemptAt:  { type: Date },
    questions:  { type: [AcknowledgedQuestionSchema], default: [] },
  },
  { timestamps: true },
);

ExamAcknowledgementSchema.index({ employeeId: 1, sopCode: 1, attempt: 1 }, { unique: true });

export default mongoose.models.ExamAcknowledgement ||
  mongoose.model<IExamAcknowledgement>('ExamAcknowledgement', ExamAcknowledgementSchema);
