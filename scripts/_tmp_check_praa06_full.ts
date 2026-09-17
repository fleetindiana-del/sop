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
  const sop = await db.collection("sops")
    .findOne({ identifier: "PRAA06-05", fileType: "docx" }, { projection: { content: 1 } });
  const content = String(sop?.content || "");
  // find every occurrence of ANNEXURE
  const re = /ANNEXURE/gi;
  let m;
  let i = 0;
  while ((m = re.exec(content)) && i < 20) {
    console.log(`\n--- occurrence @ ${m.index} ---`);
    console.log(content.slice(Math.max(0, m.index - 150), m.index + 250));
    i++;
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
