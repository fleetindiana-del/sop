import mongoose, { Document, Model, Schema } from "mongoose";

/** One save / change / delete request made from any page (see lib/activity-log.ts). */
export interface IActivityLog extends Document {
  timestamp: Date;
  method: string;
  path: string;
  query?: string;
  pageKey: string;
  pageLabel: string;
  status: number;
  ok: boolean;
  error?: string;
  durationMs: number;
  userId?: string;
  userName: string;
  userRole: string;
  userDepartment?: string;
  department?: string;
  via: "web" | "lms" | "api";
  ipAddress?: string;
  userAgent?: string;
}

const ActivityLogSchema = new Schema<IActivityLog>(
  {
    timestamp: { type: Date, required: true, default: Date.now },
    method: { type: String, required: true },
    path: { type: String, required: true },
    query: { type: String },
    pageKey: { type: String, required: true },
    pageLabel: { type: String, required: true },
    status: { type: Number, required: true },
    ok: { type: Boolean, required: true },
    error: { type: String },
    durationMs: { type: Number, required: true },
    userId: { type: String },
    userName: { type: String, required: true },
    userRole: { type: String, required: true },
    userDepartment: { type: String },
    department: { type: String },
    via: { type: String, enum: ["web", "lms", "api"], required: true },
    ipAddress: { type: String },
    userAgent: { type: String },
  },
  { collection: "activity_logs", versionKey: false },
);

ActivityLogSchema.index({ timestamp: -1 });
ActivityLogSchema.index({ pageKey: 1, timestamp: -1 });
ActivityLogSchema.index({ userName: 1, timestamp: -1 });
ActivityLogSchema.index({ path: 1, timestamp: -1 });
ActivityLogSchema.index({ ok: 1, timestamp: -1 });

const ActivityLog: Model<IActivityLog> =
  (mongoose.models.ActivityLog as Model<IActivityLog>) ||
  mongoose.model<IActivityLog>("ActivityLog", ActivityLogSchema);

export default ActivityLog;
