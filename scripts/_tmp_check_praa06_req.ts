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
    .find({ identifier: { $regex: /^PRAA06(-\d+)?$/i } })
    .project({ identifier: 1, requiredAnnexures: 1, fileType: 1, language: 1, content: 1 })
    .toArray();
  for (const s of sops) {
    console.log(`\n=== ${s.identifier} (${s.fileType}, ${s.language}) ===`);
    console.log("requiredAnnexures:", JSON.stringify(s.requiredAnnexures));
    const content = String(s.content || "");
    const idx = content.toUpperCase().search(/ANNEXURE/);
    if (idx >= 0) {
      console.log("CONTEXT around 'ANNEXURE' in content:\n", content.slice(Math.max(0, idx - 300), idx + 500));
    } else {
      console.log("(no 'ANNEXURE' substring found in content)");
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
