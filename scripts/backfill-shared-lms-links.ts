/**
 * Link shared dashboard logins to their unique Employee record so LMS history
 * (progress, certificates, exams) stays on the existing learner id.
 */
import fs from "fs";
import mongoose from "mongoose";
import { autoLinkSharedUserToEmployee } from "@/lib/userEmployeeLink";
import { connectDB } from "@/lib/mongodb";
import User from "@/models/User";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const env = fs.readFileSync(file, "utf8");
      for (const line of env.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
        }
      }
      return;
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  loadEnv();
  await connectDB();

  const users = await User.find({
    $or: [{ lmsEmployeeId: { $exists: false } }, { lmsEmployeeId: null }],
  });

  const linked: string[] = [];
  const skipped: string[] = [];

  for (const user of users) {
    const result = await autoLinkSharedUserToEmployee(user);
    if (result.linked) {
      await user.save();
      linked.push(`${user.username} → ${result.employeeName} (${user.lmsEmployeeId})`);
    } else {
      skipped.push(`${user.username} (${user.name})`);
    }
  }

  console.log("Linked:", linked.length);
  for (const line of linked) console.log("  ", line);
  console.log("Unchanged:", skipped.length);

  const sanjay = await User.findOne({ username: "sanjay" }).lean();
  console.log("Sanjay Chauhan login:", {
    username: sanjay?.username,
    name: sanjay?.name,
    role: sanjay?.role,
    isTrainer: sanjay?.isTrainer,
    sharedLmsLogin: sanjay?.sharedLmsLogin,
    lmsEmployeeId: String(sanjay?.lmsEmployeeId || ""),
  });

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
