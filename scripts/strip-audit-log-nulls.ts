/** One-off: strip null-valued keys out of previousValues/updatedValues across
 *  existing audit_logs docs. These nulls come from historical backfill (see
 *  lib/audit-history.ts), which stores a full snapshotSop() dump — including
 *  every field the SOP never had set — as updatedValues. They carry no audit
 *  information (the field name already appears in fieldsChanged) and just
 *  bloat every doc. Top-level fields (entityLabel, summary, action, user*,
 *  timestamps, etc.) are untouched.
 *
 *  Run:
 *    npx tsx scripts/strip-audit-log-nulls.ts --dry   (preview: how many docs affected)
 *    npx tsx scripts/strip-audit-log-nulls.ts         (apply)
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

function stripNullsExpr(field: string) {
  return {
    $cond: [
      { $eq: [{ $type: `$${field}` }, "object"] },
      {
        $arrayToObject: {
          $filter: {
            input: { $objectToArray: `$${field}` },
            cond: { $ne: ["$$this.v", null] },
          },
        },
      },
      `$${field}`,
    ],
  };
}

async function main() {
  loadEnv();
  const dry = process.argv.includes("--dry");
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db;
  if (!db) throw new Error("no db connection");
  const coll = db.collection("audit_logs");

  // Only touch docs that actually have at least one null inside either object —
  // avoids a no-op write (and oplog churn) on the majority of live-generated docs.
  const nullValueFilter = {
    $or: [
      {
        $expr: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $objectToArray: { $ifNull: ["$previousValues", {}] } },
                  cond: { $eq: ["$$this.v", null] },
                },
              },
            },
            0,
          ],
        },
      },
      {
        $expr: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $objectToArray: { $ifNull: ["$updatedValues", {}] } },
                  cond: { $eq: ["$$this.v", null] },
                },
              },
            },
            0,
          ],
        },
      },
    ],
  };

  const affected = await coll.countDocuments(nullValueFilter);
  console.log(`Docs with at least one null-valued entry in previousValues/updatedValues: ${affected}`);

  if (dry) {
    const sample = await coll.find(nullValueFilter).limit(1).toArray();
    console.log("Sample doc updatedValues before cleanup:", JSON.stringify(sample[0]?.updatedValues, null, 2));
    await mongoose.disconnect();
    return;
  }

  const result = await coll.updateMany(nullValueFilter, [
    { $set: { previousValues: stripNullsExpr("previousValues"), updatedValues: stripNullsExpr("updatedValues") } },
  ]);
  console.log("Matched:", result.matchedCount, "Modified:", result.modifiedCount);

  const stats = await db.stats();
  console.log("DB total after cleanup:", {
    dataSize: (stats.dataSize / 1024 / 1024).toFixed(1) + " MB",
    storageSize: (stats.storageSize / 1024 / 1024).toFixed(1) + " MB",
  });

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
