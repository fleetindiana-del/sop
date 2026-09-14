/** Read-only: report MongoDB storage usage per collection to find what's
 *  filling the cluster's space quota. Run:
 *    npx tsx scripts/diag-db-stats.ts
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

  const stats = await db.stats();
  console.log("DB total:", {
    dataSize: (stats.dataSize / 1024 / 1024).toFixed(1) + " MB",
    storageSize: (stats.storageSize / 1024 / 1024).toFixed(1) + " MB",
    indexSize: (stats.indexSize / 1024 / 1024).toFixed(1) + " MB",
  });

  const collections = await db.listCollections().toArray();
  const rows: { name: string; sizeMB: string; storageMB: string; count: number }[] = [];
  for (const c of collections) {
    const cstats = await db.command({ collStats: c.name });
    rows.push({
      name: c.name,
      sizeMB: (cstats.size / 1024 / 1024).toFixed(1),
      storageMB: (cstats.storageSize / 1024 / 1024).toFixed(1),
      count: cstats.count,
    });
  }
  rows.sort((a, b) => Number(b.storageMB) - Number(a.storageMB));
  console.table(rows);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
