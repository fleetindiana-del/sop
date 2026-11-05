import mongoose, { Schema, Document, Model } from "mongoose";

export interface ISOP extends Document {
  name: string;
  identifier: string;
  department: string;
  fileUrl: string;
  fileType: "pdf" | "docx";
  content: string;
  language?: "English" | "Gujarati";
  checksum?: string;
  uploadedAt: Date;
  processedAt?: Date;
  status: "uploaded" | "processing" | "completed" | "failed";
  mcqCount: number;
  processArea?: string;
  owner?: string;
  version?: string;
  /** Base SOP code without version suffix (e.g. PEGE11 for PEGE11-11). */
  sopBaseId?: string;
  /** Numeric version for reliable grouping (e.g. 11). */
  versionNum?: number;
  effectiveDate?: Date;
  reviewDate?: Date;
  expiryDate?: Date;
  guidelineReference?: string;
  mergedSOPId?: string;
  lastReviewedBy?: string;
  remarks?: string;
  folderPath?: string;
  parentFolder?: string;
  subfolderLevel?: number;
  originalFileName?: string;
  location?: string;
  validityPeriod?: number;
  complianceStatus?: "compliant" | "partial" | "non-compliant" | "pending";
  /** Weighted guideline score, 0–10, copied from the latest completed assessment. */
  complianceScore?: number;
  complianceNotes?: string;
  lastReviewedAt?: Date;
  nextReviewDate?: Date;
  metadata?: {
    fileSize: number;
    pageCount?: number;
    wordCount?: number;
  };
  assignedTrainers?: mongoose.Types.ObjectId[];
  trainerRetrainingStatus?: {
    trainerId: mongoose.Types.ObjectId;
    status: "pending" | "completed";
    lastTrainedAt?: Date;
  }[];
  isObsolete?: boolean;
  obsoleteAt?: Date;
  obsoleteReason?: string;
  /** Annexure roman labels required per the SOP ANNEXURES section (e.g. I, II, III). */
  requiredAnnexures?: string[];
  /** True for records auto-created by the Bunny relink scan (not explicit uploads).
   *  Such records must NOT count toward version completeness. */
  linkedFromBunny?: boolean;
  /** Prior-version DOCX only: EFF. DATE / REVIEW DT. header pair validated. */
  headerDatesValid?: boolean;
  deptManualOverride?: boolean;
  sopDocuments?: {
    fileName?: string;
    filePath?: string;
    fileType?: string;
    language?: string;
    documentKind?: "main" | "annexure" | "media";
    annexureLabel?: string;
    checksum?: string;
    parentIdentifier?: string;
  }[];
  mediaLinks?: {
    videos?: { en?: string | string[]; gu?: string | string[] };
    slides?: { en?: string | string[]; gu?: string | string[] };
    thumbnail?: string;
  };
  pipelineStatus?:
    | "idle"
    | "mcq_generating"
    | "similarity_checking"
    | "compliance_checking"
    | "compliance_fixing"
    | "updating_platform"
    | "approved"
    | "failed";
  /** Parsed clause index for MCQ generation; invalidated when content hash changes. */
  mcqClauseCache?: IMcqClauseCache;
  /** Parsed SOP sections + hashes for compliance incremental review. */
  complianceStructureCache?: IComplianceStructureCache;
  createdAt: Date;
  updatedAt: Date;
}

export interface IMcqClauseCache {
  contentHash: string;
  clauses: { id: string; summary: string; text: string }[];
  parsedAt: Date;
}

export interface IComplianceStructureCache {
  contentHash: string;
  sectionHashes: {
    sectionId: string;
    title: string;
    hash: string;
    lineStart: number;
    lineEnd: number;
  }[];
  sectionSummary: string;
  parsedAt: Date;
}

const SOPSchema = new Schema<ISOP>(
  {
    name: { type: String, required: true, trim: true },
    identifier: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true, default: "General" },
    fileUrl: { type: String, required: true },
    fileType: { type: String, enum: ["pdf", "docx"], required: true },
    content: { type: String, required: true },
    language: { type: String, enum: ["English", "Gujarati"], default: "English" },
    checksum: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
    processedAt: { type: Date },
    status: {
      type: String,
      enum: ["uploaded", "processing", "completed", "failed"],
      default: "uploaded",
    },
    mcqCount: { type: Number, default: 0 },
    processArea: { type: String, trim: true },
    owner: { type: String, trim: true },
    version: { type: String, trim: true, default: "1.0" },
    sopBaseId: { type: String, trim: true, index: true },
    versionNum: { type: Number, index: true },
    effectiveDate: { type: Date },
    reviewDate: { type: Date },
    expiryDate: { type: Date },
    guidelineReference: { type: String, trim: true },
    mergedSOPId: { type: String },
    lastReviewedBy: { type: String, trim: true },
    remarks: { type: String },
    folderPath: { type: String, trim: true },
    parentFolder: { type: String, trim: true },
    subfolderLevel: { type: Number, default: 0 },
    originalFileName: { type: String, trim: true },
    location: { type: String, trim: true },
    validityPeriod: { type: Number, default: 24 },
    complianceStatus: {
      type: String,
      enum: ["compliant", "partial", "non-compliant", "pending"],
      default: "pending",
    },
    complianceScore: { type: Number, min: 0, max: 10 },
    complianceNotes: { type: String },
    lastReviewedAt: { type: Date },
    nextReviewDate: { type: Date },
    metadata: {
      fileSize: Number,
      pageCount: Number,
      wordCount: Number,
    },
    assignedTrainers: [{ type: Schema.Types.ObjectId, ref: "User" }],
    trainerRetrainingStatus: [
      {
        trainerId: { type: Schema.Types.ObjectId, ref: "User" },
        status: { type: String, enum: ["pending", "completed"], default: "pending" },
        lastTrainedAt: Date,
      },
    ],
    isObsolete: { type: Boolean, default: false },
    obsoleteAt: { type: Date },
    obsoleteReason: { type: String },
    requiredAnnexures: [{ type: String, trim: true }],
    linkedFromBunny: { type: Boolean, default: false },
    headerDatesValid: { type: Boolean },
    deptManualOverride: { type: Boolean, default: false },
    sopDocuments: [
      {
        fileName: String,
        filePath: String,
        fileType: String,
        language: String,
        documentKind: { type: String, enum: ["main", "annexure", "media"] },
        annexureLabel: String,
        checksum: String,
        parentIdentifier: String,
      },
    ],
    mediaLinks: {
      videos: { en: Schema.Types.Mixed, gu: Schema.Types.Mixed },
      slides: { en: Schema.Types.Mixed, gu: Schema.Types.Mixed },
      thumbnail: String,
    },
    pipelineStatus: {
      type: String,
      enum: [
        "idle",
        "mcq_generating",
        "similarity_checking",
        "compliance_checking",
        "compliance_fixing",
        "updating_platform",
        "approved",
        "failed",
      ],
      default: "idle",
    },
    mcqClauseCache: {
      contentHash: { type: String, trim: true },
      clauses: [
        {
          id: { type: String, trim: true },
          summary: { type: String, trim: true },
          text: { type: String },
        },
      ],
      parsedAt: { type: Date },
    },
    complianceStructureCache: {
      contentHash: { type: String, trim: true },
      sectionHashes: [
        {
          sectionId: { type: String, trim: true },
          title: { type: String, trim: true },
          hash: { type: String, trim: true },
          lineStart: { type: Number },
          lineEnd: { type: Number },
        },
      ],
      sectionSummary: { type: String },
      parsedAt: { type: Date },
    },
  },
  { timestamps: true },
);

SOPSchema.index({ identifier: 1 });
SOPSchema.index({ sopBaseId: 1, versionNum: 1, language: 1, fileType: 1 });
SOPSchema.index({ status: 1 });
SOPSchema.index({ uploadedAt: -1 });
SOPSchema.index({ updatedAt: -1 });
SOPSchema.index({ folderPath: 1 });
SOPSchema.index({ parentFolder: 1 });
SOPSchema.index({ department: 1, folderPath: 1 });
SOPSchema.index({ checksum: 1 });
SOPSchema.index({ pipelineStatus: 1 });
SOPSchema.index({ department: 1 });
SOPSchema.index({ isObsolete: 1 });
SOPSchema.index({ expiryDate: 1 });

const SOP: Model<ISOP> =
  mongoose.models.SOP || mongoose.model<ISOP>("SOP", SOPSchema);

export default SOP;
