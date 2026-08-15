import mongoose, { Schema, Document, Model } from "mongoose";

export type ComplianceRunRequestStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface IComplianceRunResultSummary {
  overallScore: number;
  complianceStatus: string;
  analyzedAt?: Date;
  compliantCount: number;
  partialCount: number;
  nonCompliantCount: number;
}

export interface IComplianceRunRequest extends Document {
  sopId: mongoose.Types.ObjectId;
  sopIdentifier: string;
  sopName: string;
  department: string;
  requesterId: mongoose.Types.ObjectId;
  requesterName: string;
  requesterUsername: string;
  status: ComplianceRunRequestStatus;
  note?: string;
  notifiedUserIds: mongoose.Types.ObjectId[];
  reportId?: mongoose.Types.ObjectId;
  resultSummary?: IComplianceRunResultSummary;
  completedAt?: Date;
  completedByName?: string;
  cancelledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ResultSummarySchema = new Schema<IComplianceRunResultSummary>(
  {
    overallScore: { type: Number, default: 0 },
    complianceStatus: { type: String, default: "" },
    analyzedAt: { type: Date },
    compliantCount: { type: Number, default: 0 },
    partialCount: { type: Number, default: 0 },
    nonCompliantCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const ComplianceRunRequestSchema = new Schema<IComplianceRunRequest>(
  {
    sopId: { type: Schema.Types.ObjectId, ref: "SOP", required: true, index: true },
    sopIdentifier: { type: String, required: true, trim: true, index: true },
    sopName: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true, index: true },
    requesterId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    requesterName: { type: String, required: true, trim: true },
    requesterUsername: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["pending", "in_progress", "completed", "cancelled"],
      default: "pending",
      index: true,
    },
    note: { type: String, trim: true, default: "" },
    notifiedUserIds: { type: [Schema.Types.ObjectId], default: [] },
    reportId: { type: Schema.Types.ObjectId, ref: "ComplianceReport" },
    resultSummary: { type: ResultSummarySchema },
    completedAt: { type: Date },
    completedByName: { type: String, trim: true },
    cancelledAt: { type: Date },
  },
  { timestamps: true },
);

ComplianceRunRequestSchema.index({ requesterId: 1, createdAt: -1 });
ComplianceRunRequestSchema.index({ status: 1, createdAt: -1 });

const ComplianceRunRequest: Model<IComplianceRunRequest> =
  (mongoose.models.ComplianceRunRequest as Model<IComplianceRunRequest>) ||
  mongoose.model<IComplianceRunRequest>("ComplianceRunRequest", ComplianceRunRequestSchema);

export default ComplianceRunRequest;
