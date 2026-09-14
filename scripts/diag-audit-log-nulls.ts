/** Read-only: understand what "null values" mean in audit_logs before deciding
 *  what's safe to delete. Run: npx tsx scripts/diag-audit-log-nulls.ts
 */
import fs from "fs";
import mongoose from "mongoose";

function loadEnv() {
  const env = fs.readFileSync(".env.local", "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

async function main() {
  loadEnv();
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no db connection");
  const coll = db.collection("audit_logs");

  const total = await coll.countDocuments();
  console.log("Total audit_logs docs:", total);

  const fields = [
    "entityId",
    "entityLabel",
    "sopName",
    "department",
    "userId",
    "userName",
    "userRole",
    "summary",
    "action",
    "entityType",
    "comments",
    "ipAddress",
    "userAgent",
  ];
  for (const f of fields) {
    const nullCount = await coll.countDocuments({
      $or: [{ [f]: null }, { [f]: { $exists: false } }, { [f]: "" }],
    });
    console.log(`${f}: ${nullCount} null/empty/missing (${((nullCount / total) * 100).toFixed(1)}%)`);
  }

  const emptyDiff = await coll.countDocuments({
    fieldsChanged: { $size: 0 },
    action: "updated",
  });
  console.log(`action=updated with empty fieldsChanged: ${emptyDiff}`);

  const noPrevUpdated = await coll.countDocuments({
    action: "updated",
    $and: [
      { $or: [{ previousValues: null }, { previousValues: { $exists: false } }] },
      { $or: [{ updatedValues: null }, { updatedValues: { $exists: false } }] },
    ],
  });
  console.log(`action=updated with no previousValues AND no updatedValues: ${noPrevUpdated}`);

  console.log("\nSample docs missing entityLabel or summary:");
  const bad = await coll
    .find({ $or: [{ entityLabel: null }, { entityLabel: "" }, { summary: null }, { summary: "" }] })
    .limit(5)
    .toArray();
  console.log(JSON.stringify(bad, null, 2));

  console.log("\nSample of 3 random docs (to see overall shape):");
  const sample = await coll.aggregate([{ $sample: { size: 3 } }]).toArray();
  console.log(JSON.stringify(sample, null, 2));

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
