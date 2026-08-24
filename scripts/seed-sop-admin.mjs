/**
 * Seed the SOP Admin account for Rahul Garambha.
 *
 * SOP Admin has every administrative capability except user administration
 * (Login & Passwords, Access Management), which stays Super-Admin-only.
 *
 * Idempotent: if the account already exists it is promoted to `sop_admin` and
 * its name/department are corrected, but the password is left alone so a
 * re-run never resets a password the user has changed. Pass --reset-password
 * to force the default password back on.
 *
 *   node scripts/seed-sop-admin.mjs
 *   node scripts/seed-sop-admin.mjs --reset-password
 *
 * Credentials can be overridden with SOP_ADMIN_USERNAME / SOP_ADMIN_PASSWORD.
 */
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { MONGO_CONNECT_OPTIONS } from "../lib/mongo-client-options.mjs";

const envPath = path.join(process.cwd(), ".env.local");
const env = fs.readFileSync(envPath, "utf8");
const uri = env.match(/^MONGODB_URI=(.+)$/m)?.[1]?.trim();
if (!uri) {
  console.error("FAIL: MONGODB_URI not found in .env.local");
  process.exit(1);
}

const USERNAME = (process.env.SOP_ADMIN_USERNAME || "rahul.garambha").toLowerCase().trim();
const PASSWORD = process.env.SOP_ADMIN_PASSWORD || "SopAdmin@123";
const FULL_NAME = "Rahul Garambha";
const resetPassword = process.argv.includes("--reset-password");

const UserSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true },
    email: String,
    role: { type: String, default: "viewer" },
    department: String,
    designation: String,
    pageAccess: { type: [String], default: undefined },
  },
  { timestamps: true },
);

async function connectWithRetry(target, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      await mongoose.connect(target, MONGO_CONNECT_OPTIONS);
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

try {
  const existing = await User.findOne({ username: USERNAME });

  if (existing) {
    existing.name = FULL_NAME;
    existing.role = "sop_admin";
    // pageAccess must stay unset so role defaults apply; a stale allowlist from
    // a previous viewer/trainer role would otherwise narrow the SOP Admin.
    existing.pageAccess = undefined;
    existing.set("pageAccess", undefined);
    if (resetPassword || !existing.passwordHash) {
      existing.passwordHash = await bcrypt.hash(PASSWORD, 12);
    }
    await existing.save();
    console.log(`OK: Promoted existing account "${USERNAME}" to SOP Admin`);
    console.log(
      resetPassword || !existing.passwordHash
        ? `Password: ${PASSWORD}  (change on first login)`
        : "Password: unchanged",
    );
  } else {
    const passwordHash = await bcrypt.hash(PASSWORD, 12);
    await User.create({
      username: USERNAME,
      passwordHash,
      name: FULL_NAME,
      email: `${USERNAME}@local`,
      role: "sop_admin",
      department: "QA",
      designation: "SOP Admin",
    });
    console.log("OK: SOP Admin created");
    console.log(`Username: ${USERNAME}`);
    console.log(`Password: ${PASSWORD}  (change on first login)`);
  }

  console.log("DB:", mongoose.connection.db.databaseName);
  console.log("Role: sop_admin — all admin capability except Login & Passwords / Access Management");
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
} finally {
  await mongoose.disconnect();
}
