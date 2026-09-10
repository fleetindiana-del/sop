import mongoose, { Schema, Document, Model } from "mongoose";

/**
 * An annexure whose parent SOP couldn't be found at upload time. The file is
 * still saved to storage so nothing is lost; resolvePendingAnnexuresForSop
 * (lib/sop-annexure.ts) retries the link whenever a matching main SOP is
 * uploaded afterward.
 */
export interface IPendingAnnexure extends Document {
  fileName: string;
  relativePath: string;
  filePath: string;
  fileType: string;
  language: string;
  annexureLabel?: string;
  checksum: string;
  /** The parent code extracted at upload time (may lack a revision suffix). */
  parentIdentifier: string;
  versionNum?: number;
  resolved: boolean;
  resolvedAt?: Date;
  resolvedSopId?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PendingAnnexureSchema = new Schema<IPendingAnnexure>(
  {
    fileName: { type: String, required: true },
    relativePath: { type: String, required: true },
    filePath: { type: String, required: true },
    fileType: { type: String, required: true },
    language: { type: String, default: "English" },
    annexureLabel: String,
    checksum: { type: String, required: true, index: true },
    parentIdentifier: { type: String, required: true, index: true },
    versionNum: Number,
    resolved: { type: Boolean, default: false },
    resolvedAt: Date,
    resolvedSopId: { type: Schema.Types.ObjectId, ref: "SOP" },
  },
  { timestamps: true },
);

PendingAnnexureSchema.index({ parentIdentifier: 1, resolved: 1 });

if (mongoose.models.PendingAnnexure) delete mongoose.models.PendingAnnexure;
const PendingAnnexure: Model<IPendingAnnexure> = mongoose.model<IPendingAnnexure>(
  "PendingAnnexure",
  PendingAnnexureSchema,
);
export default PendingAnnexure;
