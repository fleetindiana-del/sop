import mongoose, { Schema, Document, Model } from 'mongoose';

/**
 * Rollout helper: hide historical LMS assignments from Due / In Progress / Upcoming.
 * - sopCode set  → ignore that SOP for the department + month/year
 * - sopCode null → ignore all SOPs for the department + month/year
 */
export interface ILmsTrainingIgnore extends Document {
  department: string;
  year: number;
  month: number;
  sopCode?: string | null;
  ignoredByEmployeeId?: mongoose.Types.ObjectId;
  ignoredByName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const schema = new Schema<ILmsTrainingIgnore>(
  {
    department: { type: String, required: true, index: true, trim: true },
    year: { type: Number, required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12, index: true },
    sopCode: { type: String, default: null, trim: true, uppercase: true },
    ignoredByEmployeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    ignoredByName: { type: String },
  },
  { timestamps: true },
);

schema.index(
  { department: 1, year: 1, month: 1, sopCode: 1 },
  { unique: true },
);

const LmsTrainingIgnore: Model<ILmsTrainingIgnore> =
  mongoose.models.LmsTrainingIgnore ||
  mongoose.model<ILmsTrainingIgnore>('LmsTrainingIgnore', schema);

export default LmsTrainingIgnore;
