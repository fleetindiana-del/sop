import mongoose, { Schema, Document, Model } from "mongoose";

/** "generate" = first-time bank; "regenerate" = archive current + build fresh;
 *  "continue" = append more MCQs to the existing bank without archiving. */
export type McqGenMode = "generate" | "regenerate" | "continue";
export type McqGenStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type McqGenLangStatus = "pending" | "running" | "done" | "failed";

export interface IMcqGenLangProgress {
  language: "English" | "Gujarati";
  status: McqGenLangStatus;
  batchesDone: number;
  batchesTotal: number;
  collected: number; // unique MCQs gathered this run (pre-write)
  target: number;
  inserted: number; // landed in the bank
  skipped: number; // deduped / recycled
}

export type McqGenLanguage = "English" | "Gujarati";

export interface IMcqGenJob extends Document {
  identifier: string;
  mode: McqGenMode;
  /** When set, only this language is generated/regenerated/continued. */
  languageScope?: McqGenLanguage;
  /** Provider the local/production worker should use (codex jobs wait for a local CLI). */
  provider?: "gemini" | "ollama" | "claude" | "codex";
  /** True when the job is waiting for a local Codex worker (production cannot run Codex). */
  awaitingLocalWorker?: boolean;
  status: McqGenStatus;
  /** Human-readable current phase, e.g. "Generating English — batch 3/4 (75 MCQs)". */
  phase: string;
  /** Overall completion 0–100, derived from batches across all languages. */
  percent: number;
  languages: IMcqGenLangProgress[];
  totalInserted: number;
  totalSkipped: number;
  /** Batches that errored (503/parse/etc.) and were abandoned. */
  totalFailedBatches: number;
  /** Set when the run aborts (overload circuit breaker, no SOP, etc.). */
  error?: string;
  /** When true, the background run stops after the current batch. */
  cancelRequested?: boolean;
  /** Rolling log of recent generation events, capped at 30 entries. */
  logs: string[];
  startedAt: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const LangProgressSchema = new Schema<IMcqGenLangProgress>(
  {
    language: { type: String, enum: ["English", "Gujarati"], required: true },
    status: {
      type: String,
      enum: ["pending", "running", "done", "failed"],
      default: "pending",
    },
    batchesDone: { type: Number, default: 0 },
    batchesTotal: { type: Number, default: 0 },
    collected: { type: Number, default: 0 },
    target: { type: Number, default: 0 },
    inserted: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
  },
  { _id: false },
);

const MCQGenJobSchema = new Schema<IMcqGenJob>(
  {
    // One live job per SOP identifier — re-running upserts/replaces it so the
    // status endpoint always reflects the most recent run.
    identifier: { type: String, required: true, unique: true },
    mode: { type: String, enum: ["generate", "regenerate", "continue"], required: true },
    languageScope: { type: String, enum: ["English", "Gujarati"] },
    provider: { type: String, enum: ["gemini", "ollama", "claude", "codex"] },
    awaitingLocalWorker: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed", "cancelled"],
      default: "queued",
    },
    phase: { type: String, default: "Queued" },
    percent: { type: Number, default: 0 },
    languages: { type: [LangProgressSchema], default: [] },
    totalInserted: { type: Number, default: 0 },
    totalSkipped: { type: Number, default: 0 },
    totalFailedBatches: { type: Number, default: 0 },
    error: { type: String },
    cancelRequested: { type: Boolean, default: false },
    logs: { type: [String], default: [] },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date },
  },
  { timestamps: true },
);

MCQGenJobSchema.index({ status: 1, awaitingLocalWorker: 1, startedAt: 1 });

if (mongoose.models.MCQGenJob) delete mongoose.models.MCQGenJob;
const MCQGenJob: Model<IMcqGenJob> = mongoose.model<IMcqGenJob>("MCQGenJob", MCQGenJobSchema);
export default MCQGenJob;
