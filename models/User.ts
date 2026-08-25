import mongoose, { Schema, Document, Model } from "mongoose";

export interface IUser extends Document {
  username: string;
  passwordHash: string;
  name: string;
  email?: string;
  role: "admin" | "sop_admin" | "trainer" | "viewer";
  department?: string;
  designation?: string;
  /**
   * Marks this login as a trainer. Mirrored onto the matching Employee record
   * (see `lib/userTrainerSync.ts`) because LMS trainer access reads
   * `Employee.isTrainer`.
   */
  isTrainer?: boolean;
  /**
   * Allowlist of page keys from `lib/page-registry.ts`.
   * Undefined = never configured, so legacy role defaults apply.
   */
  pageAccess?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    username: { type: String, required: true, unique: true, trim: true, lowercase: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    role: { type: String, enum: ["admin", "sop_admin", "trainer", "viewer"], default: "viewer" },
    department: { type: String, trim: true },
    designation: { type: String, trim: true },
    isTrainer: { type: Boolean, default: false },
    pageAccess: { type: [String], default: undefined },
  },
  { timestamps: true },
);

if (mongoose.models.User) {
  delete mongoose.models.User;
}

const User: Model<IUser> = mongoose.model<IUser>("User", UserSchema);

export default User;
