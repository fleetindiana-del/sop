import mongoose, { Document, Schema } from 'mongoose';

export type ScheduledExamStatus = 'scheduled' | 'cancelled';

/**
 * A trainer-scheduled LMS exam for one employee.
 *
 * Completion is never stored here — it is derived from LearningProgress at read
 * time so the trainer dashboard reflects learner activity without any manual
 * status update (see `lib/lmsExamScheduling.ts`).
 */
export interface IScheduledExam extends Document {
  /** Employee._id of the trainer who scheduled it. */
  trainerId: string;
  trainerName: string;
  employeeId: string;
  /** Denormalised so assignment lookups (dept||name) work without a join. */
  employeeName: string;
  department: string;
  designation?: string;
  /** Base SOP identifier (version suffix stripped). */
  sopCode: string;
  sopName?: string;
  /** Deadline the employee must complete the exam by (UTC date-only). Sitting 1. */
  scheduledDate: Date;
  /** Makeup date for employees absent on sitting 1. */
  scheduledDate2?: Date;
  /** Makeup date for employees absent on sitting 2. */
  scheduledDate3?: Date;
  /** Month/year the exam belongs to — derived from scheduledDate. */
  month: number;
  year: number;
  status: ScheduledExamStatus;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ScheduledExamSchema = new Schema<IScheduledExam>(
  {
    trainerId: { type: String, required: true, index: true },
    trainerName: { type: String, required: true, trim: true },
    employeeId: { type: String, required: true, index: true },
    employeeName: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true, index: true },
    designation: { type: String, trim: true },
    sopCode: { type: String, required: true, uppercase: true, trim: true, index: true },
    sopName: { type: String, trim: true },
    scheduledDate: { type: Date, required: true, index: true },
    scheduledDate2: { type: Date },
    scheduledDate3: { type: Date },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    status: {
      type: String,
      enum: ['scheduled', 'cancelled'],
      default: 'scheduled',
      index: true,
    },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

ScheduledExamSchema.index({ year: 1, month: 1, department: 1 });
ScheduledExamSchema.index({ employeeId: 1, status: 1 });
// One live schedule per employee × SOP × month × year — rescheduling updates it.
ScheduledExamSchema.index(
  { employeeId: 1, sopCode: 1, year: 1, month: 1 },
  { unique: true, partialFilterExpression: { status: 'scheduled' } },
);

export default (mongoose.models.ScheduledExam as mongoose.Model<IScheduledExam>) ||
  mongoose.model<IScheduledExam>('ScheduledExam', ScheduledExamSchema, 'lmsscheduledexams');
