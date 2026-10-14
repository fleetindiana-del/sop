import fs from "fs";
import mongoose from "mongoose";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
(async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
  const rows = await mongoose.connection.db!.collection("audit_logs")
    .find({ timestamp: { $gte: new Date(Date.now() - 30 * 60_000) }, comments: { $regex: /^Attached (video|slide)/ } })
    .sort({ timestamp: 1 }).project({ timestamp: 1, entityLabel: 1, comments: 1 }).toArray();
  for (const r of rows) console.log(r.timestamp.toISOString().slice(11, 19), r.entityLabel, r.comments);
  await mongoose.disconnect();
})();
