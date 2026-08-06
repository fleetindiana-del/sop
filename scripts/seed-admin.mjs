import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { MONGO_CONNECT_OPTIONS } from "../lib/mongo-client-options.mjs";

const envPath = path.join(process.cwd(), ".env.local");
const env = fs.readFileSync(envPath, "utf8");
const uri = env.match(/^MONGODB_URI=(.+)$/m)?.[1]?.trim();

const UserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    email: String,
    role: { type: String, default: "admin" },
    department: String,
    designation: String,
  },
  { timestamps: true },
);

async function connectWithRetry(uri, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      await mongoose.connect(uri, MONGO_CONNECT_OPTIONS);
      return;
    } catch (err) {
      lastError = err;
      await mongoose.disconnect().catch(() => {});
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 1500));
    }
  }
  throw lastError;
}

await connectWithRetry(uri);
const User = mongoose.models.User || mongoose.model("User", UserSchema);

const passwordHash = await bcrypt.hash("admin123", 12);

try {
  const user = await User.findOneAndUpdate(
    { username: "admin" },
    {
      username: "admin",
      passwordHash,
      name: "Admin",
      email: "admin@local",
      role: "admin",
      department: "QA",
      designation: "Administrator",
    },
    { upsert: true, returnDocument: 'after' },
  );
  console.log("OK: Admin created/updated");
  console.log("DB:", mongoose.connection.db.databaseName);
  console.log("Username:", user.username);
} catch (err) {
  console.error("FAIL:", err.message);
  if (err.code === 11000) {
    console.error("Duplicate key - checking indexes...");
    const indexes = await User.collection.indexes();
    console.error("Indexes:", JSON.stringify(indexes));
  }
  process.exit(1);
} finally {
  await mongoose.disconnect();
}
