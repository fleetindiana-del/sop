import mongoose, { Document, Model, Schema } from "mongoose";

export const AUDIT_ENTITY_TYPES = ["sop", "department", "designation", "employee"] as const;
export type AuditEntityType = (typeof AUDIT_ENTITY_TYPES)[number];

export const AUDIT_ACTIONS = [
  "created",
  "updated",
  "uploaded",
  "obsoleted",
  "restored",
  "deleted",
  "renamed",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface IAuditLog extends Document {
  timestamp: Date;
  entityType: AuditEntityType;
  entityId: string;
  entityLabel: string;
  sopName?: string;
  department?: string;
  userId: string;
  userName: string;
  userRole: string;
  userDepartment?: string;
  action: AuditAction;
  fieldsChanged: string[];
  previousValues?: Record<string, unknown>;
  updatedValues?: Record<string, unknown>;
  summary: string;
  comments?: string;
  ipAddress?: string;
  userAgent?: string;
  systemGenerated: boolean;
  source?: "live" | "historical";
  dedupeKey?: string;
  createdAt: Date;
  updatedAt: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    timestamp: { type: Date, required: true, default: Date.now, index: true },
    entityType: { type: String, enum: AUDIT_ENTITY_TYPES, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    entityLabel: { type: String, required: true, index: true },
    sopName: { type: String, index: true },
    department: { type: String, index: true },
    userId: { type: String, required: true, index: true },
    userName: { type: String, required: true, index: true },
    userRole: { type: String, required: true, index: true },
    userDepartment: { type: String },
    action: { type: String, enum: AUDIT_ACTIONS, required: true, index: true },
    fieldsChanged: { type: [String], default: [] },
    previousValues: { type: Schema.Types.Mixed },
    updatedValues: { type: Schema.Types.Mixed },
    summary: { type: String, required: true },
    comments: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },
    systemGenerated: { type: Boolean, default: false },
    source: { type: String, enum: ["live", "historical"], default: "live", index: true },
    dedupeKey: { type: String, index: true },
  },
  { timestamps: true, collection: "audit_logs" },
);

AuditLogSchema.index({ timestamp: -1 });
AuditLogSchema.index({ entityType: 1, timestamp: -1 });
AuditLogSchema.index({ action: 1, timestamp: -1 });
AuditLogSchema.index({ department: 1, timestamp: -1 });
AuditLogSchema.index({ userName: 1, timestamp: -1 });
AuditLogSchema.index({ entityLabel: 1, timestamp: -1 });
AuditLogSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

const AuditLog: Model<IAuditLog> =
  (mongoose.models.AuditLog as Model<IAuditLog>) ||
  mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);

export default AuditLog;
