import mongoose, { Schema, Document, Model } from "mongoose";
import type {
  ExtractedLabel,
  FaceReadability,
  LabelAssetMeta,
  LabelFinding,
  LabelPreview,
  LabelScoreBreakdown,
  LabelVersionComparison,
  LabelVersionSnapshot,
  ProductClassification,
  UnreadableRegion,
} from "@/lib/label-compliance/types";

export interface ILabelComplianceReport extends Document {
  productName: string;
  brandName?: string;
  productClassification: ProductClassification;
  classificationConfidence: number;
  classificationReason?: string;
  classificationConfirmed?: boolean;
  classificationOverride?: ProductClassification;
  notes?: string;
  assets: LabelAssetMeta[];
  previews: LabelPreview[];
  extractedLabel: ExtractedLabel;
  unreadableRegions: UnreadableRegion[];
  readability: FaceReadability[];
  findings: LabelFinding[];
  score: LabelScoreBreakdown;
  complianceStatus: "Fully Compliant" | "Partially Compliant" | "Non-Compliant" | "Analysis Failed";
  analysisStatus: "extracted" | "completed" | "failed";
  analysisEngineVersion: string;
  modelNotes?: string;
  versionNumber: number;
  versions: LabelVersionSnapshot[];
  latestComparison?: LabelVersionComparison;
  createdBy?: string;
  analyzedAt: Date;
  lastRecheckAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const FindingSchema = new Schema(
  {
    findingId: { type: String, required: true, index: true },
    ruleId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    regulation: { type: String, default: "" },
    severity: { type: String, enum: ["critical", "high", "medium", "low"], required: true },
    status: { type: String, enum: ["fail", "pass", "review"], required: true },
    evidenceFace: { type: String, enum: ["front", "back", "side", "pdf", "unknown"] },
    evidence: { type: String, default: "" },
    claim: { type: String },
    recommendation: { type: String, default: "" },
    lifecycle: {
      type: String,
      enum: [
        "detected",
        "reviewed",
        "correction-suggested",
        "corrected",
        "re-uploaded",
        "revalidated",
        "closed",
      ],
      default: "detected",
      index: true,
    },
    source: { type: String, enum: ["rule-engine", "vision", "merged"], default: "merged" },
  },
  { _id: false },
);

const LabelComplianceReportSchema = new Schema<ILabelComplianceReport>(
  {
    productName: { type: String, required: true, trim: true, index: true },
    brandName: { type: String, trim: true },
    productClassification: {
      type: String,
      enum: [
        "nutraceutical",
        "health-supplement",
        "fsdu",
        "fsmp",
        "functional-food",
        "novel-food",
        "unknown",
      ],
      required: true,
      index: true,
    },
    classificationConfidence: { type: Number, min: 0, max: 100, default: 0 },
    classificationReason: { type: String, default: "" },
    classificationConfirmed: { type: Boolean, default: false },
    classificationOverride: { type: String },
    notes: { type: String, trim: true },
    assets: [
      {
        face: { type: String, enum: ["front", "back", "side", "pdf"], required: true },
        fileName: { type: String, required: true },
        mimeType: { type: String, required: true },
        sizeBytes: { type: Number, default: 0 },
      },
    ],
    previews: {
      type: [
        {
          face: { type: String, enum: ["front", "back", "side", "pdf"] },
          mimeType: { type: String },
          dataBase64: { type: String },
        },
      ],
      default: [],
    },
    extractedLabel: { type: Schema.Types.Mixed, required: true },
    unreadableRegions: { type: Schema.Types.Mixed, default: [] },
    readability: { type: Schema.Types.Mixed, default: [] },
    findings: { type: [FindingSchema], default: [] },
    score: {
      totalRules: { type: Number, default: 0 },
      applicableRules: { type: Number, default: 0 },
      passed: { type: Number, default: 0 },
      critical: { type: Number, default: 0 },
      high: { type: Number, default: 0 },
      medium: { type: Number, default: 0 },
      low: { type: Number, default: 0 },
      review: { type: Number, default: 0 },
      score: { type: Number, default: 0 },
      formula: { type: String, default: "" },
    },
    complianceStatus: {
      type: String,
      enum: ["Fully Compliant", "Partially Compliant", "Non-Compliant", "Analysis Failed"],
      default: "Non-Compliant",
      index: true,
    },
    analysisStatus: {
      type: String,
      enum: ["extracted", "completed", "failed"],
      default: "extracted",
      index: true,
    },
    analysisEngineVersion: { type: String, default: "label-v1" },
    modelNotes: { type: String },
    versionNumber: { type: Number, default: 1 },
    versions: { type: Schema.Types.Mixed, default: [] },
    latestComparison: { type: Schema.Types.Mixed },
    createdBy: { type: String, trim: true },
    analyzedAt: { type: Date, default: Date.now, index: true },
    lastRecheckAt: { type: Date },
  },
  { timestamps: true },
);

LabelComplianceReportSchema.index({ analyzedAt: -1 });
LabelComplianceReportSchema.index({ productName: 1, analyzedAt: -1 });

if (process.env.NODE_ENV !== "production" && mongoose.models.LabelComplianceReport) {
  delete mongoose.models.LabelComplianceReport;
}

const LabelComplianceReport: Model<ILabelComplianceReport> =
  mongoose.models.LabelComplianceReport ||
  mongoose.model<ILabelComplianceReport>("LabelComplianceReport", LabelComplianceReportSchema);

export default LabelComplianceReport;
