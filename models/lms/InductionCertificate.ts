import mongoose, { Schema, Document } from 'mongoose';

/**
 * One consolidated certificate per employee for their whole induction
 * training, issued once every induction SOP exam is completed. Each SOP's
 * outcome is kept on the certificate so it stays printable as issued.
 */
export interface IInductionCertificateSop {
  sopCode: string;
  sopName: string;
  attempts: number;
  passedOnAttempt?: number;
  score?: number;
  completedAt?: Date;
}

export interface IInductionCertificate extends Document {
  certificateNumber: string;
  employeeId: mongoose.Types.ObjectId;
  employeeName: string;
  employeeCode?: string;
  designation: string;
  department: string;
  dateOfJoining?: Date;
  sops: IInductionCertificateSop[];
  /** Date the last induction SOP was completed. */
  completedAt: Date;
  issuedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const InductionCertificateSopSchema = new Schema<IInductionCertificateSop>(
  {
    sopCode: { type: String, required: true },
    sopName: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    passedOnAttempt: { type: Number },
    score: { type: Number },
    completedAt: { type: Date },
  },
  { _id: false },
);

const InductionCertificateSchema = new Schema<IInductionCertificate>(
  {
    certificateNumber: { type: String, required: true, unique: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true, unique: true },
    employeeName: { type: String, required: true },
    employeeCode: { type: String },
    designation: { type: String, default: '' },
    department: { type: String, default: '' },
    dateOfJoining: { type: Date },
    sops: { type: [InductionCertificateSopSchema], default: [] },
    completedAt: { type: Date, required: true },
    issuedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export default mongoose.models.InductionCertificate ||
  mongoose.model<IInductionCertificate>('InductionCertificate', InductionCertificateSchema);
