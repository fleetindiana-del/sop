/**
 * One-off: reconcile Employee.isTrainer for every trainer-flagged User login.
 *
 * The Trainer checkbox on Login & Passwords is supposed to mirror onto the
 * linked Employee record (`syncEmployeeTrainerFlag`, called from the user
 * create/update routes), but several existing logins predate that sync or
 * were edited before it fired — leaving Employee.isTrainer=false even though
 * the login is role=trainer / isTrainer=true. That desync is what let a
 * trainer show up in their own department's Employee-wise roster in the LMS
 * Trainer View, instead of being excluded like every other trainer.
 *
 * Run: npx tsx scripts/backfill-trainer-employee-sync.ts
 */
import fs from "fs";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { syncEmployeeTrainerFlag } from "@/lib/userTrainerSync";
import User from "@/models/User";

function loadEnv() {
  const env = fs.readFileSync(".env.local", "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

async function main() {
  loadEnv();
  await connectDB();

  const trainerUsers = await User.find({
    $or: [{ isTrainer: true }, { role: "trainer" }],
  });
  console.log(`Checking ${trainerUsers.length} trainer-flagged login(s)...`);

  let fixed = 0;
  let unmatched = 0;
  for (const user of trainerUsers) {
    const result = await syncEmployeeTrainerFlag(user, true);
    if (!result.matched) {
      unmatched++;
      console.log(`  no employee match: ${user.username} (${user.name})`);
      continue;
    }
    console.log(`  ok: ${user.username} -> ${result.employeeName}`);
    fixed++;
  }

  console.log(`\nDone. ${fixed} matched (already-correct or just-fixed), ${unmatched} unmatched.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
