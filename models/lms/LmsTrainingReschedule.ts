import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Moves an LMS SOP exam from one planned month to another.
 * The effective schedule used for due/overdue is `toYear`/`toMonth`.
 * The original month is not treated as overdue after a reschedule.
 */
export interface ILmsTrainingReschedule extends Document {
  department: string;
  sopCode: string;
  /** Optional — when set, only this employee is moved; otherwise department-wide. */
  employeeId?: mongoose.Types.ObjectId | null;
  employeeName?: string | null;
  fromYear: number;
  fromMonth: number;
  toYear: number;
  toMonth: number;
  note?: string;
  createdByEmployeeId?: mongoose.Types.ObjectId;
  createdByName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ILmsTrainingReschedule>(
  {
    department: { type: String, required: true, index: true, trim: true },
    sopCode: { type: String, required: true, trim: true, uppercase: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', default: null, index: true },
    employeeName: { type: String, default: null, trim: true },
    fromYear: { type: Number, required: true },
    fromMonth: { type: Number, required: true, min: 1, max: 12 },
    toYear: { type: Number, required: true },
    toMonth: { type: Number, required: true, min: 1, max: 12 },
    note: { type: String, default: '' },
    createdByEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    createdByName: { type: String },
  },
  { timestamps: true },
);

schema.index({ department: 1, sopCode: 1, employeeId: 1, fromYear: 1, fromMonth: 1 });

const LmsTrainingReschedule: Model<ILmsTrainingReschedule> =
  mongoose.models.LmsTrainingReschedule ||
  mongoose.model<ILmsTrainingReschedule>('LmsTrainingReschedule', schema);

export default LmsTrainingReschedule;
