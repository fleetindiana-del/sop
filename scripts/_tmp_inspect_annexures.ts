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
  const db = mongoose.connection.db!;
  const sops = await db.collection("sops")
    .find({ identifier: { $regex: /^(PEGE22|PRAA06)(-\d+)?$/i } })
    .project({ identifier: 1, name: 1, department: 1, sopDocuments: 1, isObsolete: 1 })
    .toArray();
  for (const s of sops) {
    console.log(`\n=== ${s.identifier} (${s.name}) obsolete=${s.isObsolete} ===`);
    for (const d of s.sopDocuments ?? []) {
      if (d.documentKind === "annexure") {
        console.log("  ANNEXURE:", JSON.stringify({
          fileName: d.fileName, filePath: d.filePath, annexureLabel: d.annexureLabel,
          checksum: d.checksum, language: d.language,
        }));
      }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
