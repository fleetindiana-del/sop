import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Designation Master — the controlled list of job titles employees can hold.
 *
 * Employee Master remains the source of truth for which designation a given
 * person currently holds; this collection is the source of truth for which
 * designations *exist*. The Edit Employee form picks from here rather than
 * accepting free text, which is what stops near-duplicate titles
 * ("Sr. Officer" / "Senior Officer") from fragmenting matrix filters.
 *
 * Historical records (training, attendance, assessments, certificates) keep the
 * designation string captured at the time and are never rewritten when an entry
 * here is renamed or removed.
 */
export interface IDesignation extends Document {
  name: string;
  /** Lowercased `name`, used for the case-insensitive uniqueness guarantee. */
  nameLower: string;
  description?: string;
  isActive: boolean;
  createdBy: string;
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DesignationSchema = new Schema<IDesignation>(
  {
    name: { type: String, required: true, trim: true },
    // A separate lowercased field keeps uniqueness case-insensitive without
    // relying on a collation-aware index.
    nameLower: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: String, required: true },
    updatedBy: { type: String },
  },
  { timestamps: true, collection: "designations" },
);

DesignationSchema.index({ name: 1 });

const Designation: Model<IDesignation> =
  (mongoose.models.Designation as Model<IDesignation>) ||
  mongoose.model<IDesignation>("Designation", DesignationSchema);

export default Designation;
