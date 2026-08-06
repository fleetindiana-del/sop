import mongoose, { Schema, Document, Model } from "mongoose";

export type RecheckPointStatus = "addressed" | "open";

export interface IRecheckPointResult {
  /** Full original finding snapshot so the UI renders identically to the report. */
  finding: Record<string, unknown>;
  status: RecheckPointStatus;
  evidence: string;
  note: string;
  /** Best-matching excerpt from the revised SOP for this requirement, regardless of status. */
  revisedExcerpt: string;
  ignored: boolean;
  /** Addressed by an earlier run — carried forward verbatim, not re-audited this run. */
  carriedForward?: boolean;
  /** Where this point came from: the original report, or a new issue raised by an earlier re-check. */
  origin?: "report" | "new-issue";
}

/** One annexure whose text was merged into the recheck prompt. */
export interface IRecheckAnnexure {
  label: string;
  fileName: string;
  chars: number;
  /** "uploaded" = supplied with this re-check, "linked" = pulled from the SOP record. */
  source?: "uploaded" | "linked";
  /** Openable link, only for annexures uploaded with this run. */
  fileUrl?: string;
}

export interface IRecheckNewIssue {
  clauseNumber: string;
  clauseTitle: string;
  guidelineName: string;
  issue: string;
  severity: "low" | "medium" | "high";
  suggestion: string;
  ignored: boolean;
}

export interface IRecheckRun extends Document {
  reportId: mongoose.Types.ObjectId;
  sopId?: mongoose.Types.ObjectId;
  sopIdentifier: string;
  sopName: string;
  department?: string;
  fileName: string;
  /** Openable link to the exact document that was uploaded for this run. */
  fileUrl?: string;
  verdict: "compliant" | "issues";
  score: number;
  resolvedCount: number;
  openCount: number;
  results: IRecheckPointResult[];
  newIssues: IRecheckNewIssue[];
  /** Annexure files whose text was merged into the recheck LLM prompt. */
  annexuresIncluded?: IRecheckAnnexure[];
  annexuresSkipped?: { label: string; fileName: string; reason: string }[];
  /** How many of the included annexures were uploaded with this run (rest are linked to the SOP). */
  uploadedAnnexureCount?: number;
  annexureChars?: number;
  /** Explicit flag: linked annexure text was included in this recheck. */
  annexuresRead?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const PointResultSchema = new Schema<IRecheckPointResult>(
  {
    finding: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ["addressed", "open"], required: true },
    evidence: { type: String, default: "" },
    note: { type: String, default: "" },
    revisedExcerpt: { type: String, default: "" },
    ignored: { type: Boolean, default: false },
    carriedForward: { type: Boolean, default: false },
    origin: { type: String, enum: ["report", "new-issue"], default: "report" },
  },
  { _id: false },
);

const NewIssueSchema = new Schema<IRecheckNewIssue>(
  {
    clauseNumber: { type: String, default: "" },
    clauseTitle: { type: String, default: "" },
    guidelineName: { type: String, default: "" },
    issue: { type: String, default: "" },
    severity: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    suggestion: { type: String, default: "" },
    ignored: { type: Boolean, default: false },
  },
  { _id: false },
);

const RecheckRunSchema = new Schema<IRecheckRun>(
  {
    reportId: { type: Schema.Types.ObjectId, ref: "ComplianceReport", required: true, index: true },
    sopId: { type: Schema.Types.ObjectId, ref: "SOP" },
    sopIdentifier: { type: String, default: "" },
    sopName: { type: String, default: "" },
    department: { type: String, default: "" },
    fileName: { type: String, default: "" },
    fileUrl: { type: String, default: "" },
    verdict: { type: String, enum: ["compliant", "issues"], default: "issues" },
    score: { type: Number, default: 0 },
    resolvedCount: { type: Number, default: 0 },
    openCount: { type: Number, default: 0 },
    results: { type: [PointResultSchema], default: [] },
    newIssues: { type: [NewIssueSchema], default: [] },
    annexuresIncluded: {
      type: [
        {
          label: { type: String, default: "" },
          fileName: { type: String, default: "" },
          chars: { type: Number, default: 0 },
          source: { type: String, enum: ["uploaded", "linked"], default: "linked" },
          fileUrl: { type: String, default: "" },
        },
      ],
      default: [],
    },
    uploadedAnnexureCount: { type: Number, default: 0 },
    annexuresSkipped: {
      type: [
        {
          label: { type: String, default: "" },
          fileName: { type: String, default: "" },
          reason: { type: String, default: "" },
        },
      ],
      default: [],
    },
    annexureChars: { type: Number, default: 0 },
    annexuresRead: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const RecheckRun: Model<IRecheckRun> =
  (mongoose.models.RecheckRun as Model<IRecheckRun>) ||
  mongoose.model<IRecheckRun>("RecheckRun", RecheckRunSchema);

export default RecheckRun;
