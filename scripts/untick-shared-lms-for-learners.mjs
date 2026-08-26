/**
 * Untick "Same password for Dashboard and LMS" on every learner login.
 *
 * A learner (any role that is not admin / sop_admin / trainer) has no dashboard
 * to bridge from — their learning-module password belongs on the Employee
 * record — so `User.sharedLmsLogin` is set to false for them. Logins that
 * predate the flag (undefined) count as shared and are updated too.
 *
 * Dry run by default; pass --apply to write.
 *
 *   node scripts/untick-shared-lms-for-learners.mjs
 *   node scripts/untick-shared-lms-for-learners.mjs --apply
 */
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { MONGO_CONNECT_OPTIONS } from "../lib/mongo-client-options.mjs";

const envPath = path.join(process.cwd(), ".env.local");
const env = fs.readFileSync(envPath, "utf8");
const uri = env.match(/^MONGODB_URI=(.+)$/m)?.[1]?.trim();
if (!uri) {
  console.error("FAIL: MONGODB_URI not found in .env.local");
  process.exit(1);
}

const apply = process.argv.includes("--apply");

/** Roles that run the application — everyone else is a learner. */
const PRIVILEGED_ROLES = ["admin", "sop_admin", "trainer"];

const UserSchema = new mongoose.Schema(
  {
    username: String,
    name: String,
    role: String,
    sharedLmsLogin: Boolean,
  },
  { timestamps: true, strict: false },
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

const filter = {
  role: { $nin: PRIVILEGED_ROLES },
  sharedLmsLogin: { $ne: false },
};

try {
  console.log("DB:", mongoose.connection.db.databaseName);

  const pending = await User.find(filter).select("username name role sharedLmsLogin").lean();
  console.log(`Learner logins still sharing the dashboard password: ${pending.length}`);
  for (const u of pending) {
    console.log(`  - ${u.username} (${u.role}) — ${u.name}`);
  }

  if (!pending.length) {
    console.log("Nothing to do.");
  } else if (!apply) {
    console.log("\nDry run. Re-run with --apply to write.");
  } else {
    const res = await User.updateMany(filter, { $set: { sharedLmsLogin: false } });
    console.log(`\nOK: unticked on ${res.modifiedCount} login(s)`);
    const left = await User.countDocuments(filter);
    console.log(`Remaining shared learner logins: ${left}`);
  }
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
} finally {
  await mongoose.disconnect();
}
