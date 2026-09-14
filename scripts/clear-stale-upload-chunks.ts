/** One-off: delete stray SopUploadChunk docs left over from failed/incomplete
 *  chunked uploads. These are ephemeral by design (1h TTL) and were the main
 *  contributor to the cluster hitting its storage quota. Run:
 *    npx tsx scripts/clear-stale-upload-chunks.ts
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

  const coll = db.collection("sopuploadchunks");
  const count = await coll.countDocuments();
  console.log(`Deleting ${count} stale sopuploadchunks docs...`);
  const result = await coll.deleteMany({});
  console.log("Deleted:", result.deletedCount);

  const stats = await db.stats();
  console.log("DB total after delete:", {
    dataSize: (stats.dataSize / 1024 / 1024).toFixed(1) + " MB",
    storageSize: (stats.storageSize / 1024 / 1024).toFixed(1) + " MB",
  });

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
