import mongoose, { Schema, Document, Model } from "mongoose";

export type NotificationType = "compliance_run_requested" | "compliance_run_completed";

export interface INotification extends Document {
  userId: mongoose.Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  href?: string;
  read: boolean;
  readAt?: Date;
  requestId?: mongoose.Types.ObjectId;
  sopIdentifier?: string;
  department?: string;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: ["compliance_run_requested", "compliance_run_completed"],
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    href: { type: String, trim: true },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date },
    requestId: { type: Schema.Types.ObjectId, ref: "ComplianceRunRequest", index: true },
    sopIdentifier: { type: String, trim: true, index: true },
    department: { type: String, trim: true },
  },
  { timestamps: true },
);

NotificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

const Notification: Model<INotification> =
  (mongoose.models.Notification as Model<INotification>) ||
  mongoose.model<INotification>("Notification", NotificationSchema);

export default Notification;
