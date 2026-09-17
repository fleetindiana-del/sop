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
  const pending = await db.collection("pendingannexures")
    .find({ parentIdentifier: { $regex: /PEGE22|PRAA06/i } })
    .toArray();
  console.log("PENDING:", JSON.stringify(pending, null, 2));

  const banks = await db.collection("mcqbanks")
    .find({ sopIdentifier: { $regex: /^(PEGE22|PRAA06)/i } })
    .project({ sopIdentifier: 1, language: 1, annexureUsage: 1, isObsolete: 1 })
    .toArray();
  console.log("BANKS:", JSON.stringify(banks, null, 2));

  // also check for any sopDocuments annexure anywhere referencing PRAA06 in filePath (mislinked)
  const stray = await db.collection("sops")
    .find({ "sopDocuments.filePath": { $regex: /PRAA06/i }, "sopDocuments.documentKind": "annexure" })
    .project({ identifier: 1, sopDocuments: 1 })
    .toArray();
  console.log("STRAY PRAA06 FILEPATHS:", JSON.stringify(stray.map(s => ({identifier: s.identifier, docs: (s.sopDocuments||[]).filter((d:any)=>d.documentKind==='annexure')})), null, 2));

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
