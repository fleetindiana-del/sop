import mongoose, { Schema, Document, Model } from "mongoose";

export type LlmTaskKind = "compliance" | "mcq";
export type LlmTaskStatus = "pending" | "claimed" | "completed" | "failed" | "cancelled";

/** One prompt waiting for GrokBot to answer in place of the Codex CLI. */
export interface ILlmTask extends Document {
  kind: LlmTaskKind;
  label: string;
  prompt: string;
  status: LlmTaskStatus;
  /** SOP id / identifier of the run that is waiting, for cancellation and display. */
  runKey?: string;
  queuedAt: Date;
  claimedAt?: Date;
  claimedByKeyId?: string;
  claimCount: number;
  completedAt?: Date;
  result?: string;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const LlmTaskSchema = new Schema<ILlmTask>(
  {
    kind: { type: String, enum: ["compliance", "mcq"], required: true },
    label: { type: String, default: "" },
    prompt: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "claimed", "completed", "failed", "cancelled"],
      default: "pending",
    },
    runKey: { type: String },
    queuedAt: { type: Date, default: Date.now },
    claimedAt: { type: Date },
    claimedByKeyId: { type: String },
    claimCount: { type: Number, default: 0 },
    completedAt: { type: Date },
    result: { type: String },
    error: { type: String },
  },
  { timestamps: true },
);

LlmTaskSchema.index({ status: 1, queuedAt: 1 });
LlmTaskSchema.index({ createdAt: 1 }, { expireAfterSeconds: 3 * 24 * 60 * 60 });

const LlmTask: Model<ILlmTask> =
  (mongoose.models.LlmTask as Model<ILlmTask>) ||
  mongoose.model<ILlmTask>("LlmTask", LlmTaskSchema);

export default LlmTask;
