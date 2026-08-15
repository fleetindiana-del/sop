import mongoose, { Document, Schema } from 'mongoose';

export type AttendanceStatus = 'present' | 'absent';

/**
 * One employee's attendance for a training session.
 *
 * Employee identity is denormalised alongside the id because an attendance sheet
 * is a signed record of who was in the room on a given day: it must still read
 * correctly years later, after the employee has been renamed, moved department
 * or deactivated.
 */
export interface IAttendanceRecord {
  employeeId: string;
  employeeName: string;
  designation?: string;
  department: string;
  /** Payroll/employee code as shown on the roster, when the employee has one. */
  employeeCode?: string;
  status: AttendanceStatus;
  /** Optional note from the trainer, typically the reason for an absence. */
  remark?: string;
}

/**
 * An attendance sheet for one SOP training session: one trainer, one department,
 * one date, and every employee who was expected — each marked present or absent.
 *
 * The session (not the individual) is the stored unit because that is how the
 * trainer records and later reviews it, and it keeps one save atomic. Per-employee
 * reporting still works: `records.employeeId` is indexed.
 */
export interface ITrainingAttendance extends Document {
  /** Employee._id of the trainer who conducted and recorded the session. */
  trainerId: string;
  trainerName: string;
  department: string;
  /** Base SOP identifier (version suffix stripped). */
  sopCode: string;
  sopName?: string;
  /** Day the training was conducted (UTC date-only). */
  trainingDate: Date;
  /** Month/year the session belongs to — derived from trainingDate. */
  month: number;
  year: number;
  records: IAttendanceRecord[];
  presentCount: number;
  absentCount: number;
  totalCount: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AttendanceRecordSchema = new Schema<IAttendanceRecord>(
  {
    employeeId: { type: String, required: true },
    employeeName: { type: String, required: true, trim: true },
    designation: { type: String, trim: true },
    department: { type: String, required: true, trim: true },
    employeeCode: { type: String, trim: true },
    status: {
      type: String,
      enum: ['present', 'absent'],
      required: true,
      default: 'present',
    },
    remark: { type: String, trim: true },
  },
  { _id: false },
);

const TrainingAttendanceSchema = new Schema<ITrainingAttendance>(
  {
    trainerId: { type: String, required: true, index: true },
    trainerName: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true, index: true },
    sopCode: { type: String, required: true, uppercase: true, trim: true, index: true },
    sopName: { type: String, trim: true },
    trainingDate: { type: Date, required: true, index: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    records: { type: [AttendanceRecordSchema], default: [] },
    presentCount: { type: Number, default: 0 },
    absentCount: { type: Number, default: 0 },
    totalCount: { type: Number, default: 0 },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

/** Keep the roll-up counts truthful without the caller having to remember. */
TrainingAttendanceSchema.pre('save', function () {
  const records = this.records ?? [];
  this.presentCount = records.filter((r) => r.status === 'present').length;
  this.absentCount = records.filter((r) => r.status === 'absent').length;
  this.totalCount = records.length;
});

TrainingAttendanceSchema.index({ year: 1, month: 1, department: 1 });
TrainingAttendanceSchema.index({ 'records.employeeId': 1 });
// One sheet per SOP × department × day. Re-saving the same session edits that
// sheet instead of filing a second, contradictory record of the same room.
TrainingAttendanceSchema.index(
  { sopCode: 1, department: 1, trainingDate: 1 },
  { unique: true },
);

export default (mongoose.models.TrainingAttendance as mongoose.Model<ITrainingAttendance>) ||
  mongoose.model<ITrainingAttendance>(
    'TrainingAttendance',
    TrainingAttendanceSchema,
    'lmstrainingattendance',
  );
