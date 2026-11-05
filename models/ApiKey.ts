import mongoose, { Schema, Document, Model } from "mongoose";

export interface IApiKey extends Document {
  name: string;
  /** sha256 of the full key; the plaintext is shown once at creation and never stored. */
  keyHash: string;
  /** First characters of the key so admins can tell keys apart. */
  displayPrefix: string;
  /** Dashboard user the key acts as; its role and departments still apply. */
  userId: mongoose.Types.ObjectId;
  scopes: string[];
  expiresAt?: Date;
  revokedAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ApiKeySchema = new Schema<IApiKey>(
  {
    name: { type: String, required: true, trim: true },
    keyHash: { type: String, required: true, unique: true },
    displayPrefix: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    scopes: { type: [String], default: [] },
    expiresAt: { type: Date },
    revokedAt: { type: Date },
    lastUsedAt: { type: Date },
  },
  { timestamps: true },
);

const ApiKey: Model<IApiKey> =
  (mongoose.models.ApiKey as Model<IApiKey>) ||
  mongoose.model<IApiKey>("ApiKey", ApiKeySchema);

export default ApiKey;
