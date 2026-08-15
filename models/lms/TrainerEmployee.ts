import mongoose, { Document, Schema } from 'mongoose';

/**
 * Explicit trainer → employee roster.
 *
 * Trainers implicitly see every active employee in their `trainerDepartments`;
 * this collection lets a trainer curate the subset they are responsible for so
 * the monthly dashboard and scheduler can be narrowed to "my employees".
 */
export interface ITrainerEmployee extends Document {
  /** Employee._id of the trainer. */
  trainerId: string;
  employeeId: string;
  /** Denormalised for listing without a join; refreshed on read. */
  employeeName: string;
  department: string;
  designation?: string;
  addedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const TrainerEmployeeSchema = new Schema<ITrainerEmployee>(
  {
    trainerId: { type: String, required: true, index: true },
    employeeId: { type: String, required: true, index: true },
    employeeName: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true, index: true },
    designation: { type: String, trim: true },
    addedBy: { type: String, required: true },
  },
  { timestamps: true },
);

TrainerEmployeeSchema.index({ trainerId: 1, employeeId: 1 }, { unique: true });

export default (mongoose.models.TrainerEmployee as mongoose.Model<ITrainerEmployee>) ||
  mongoose.model<ITrainerEmployee>('TrainerEmployee', TrainerEmployeeSchema, 'lmstraineremployees');
