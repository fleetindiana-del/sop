/** Read-only: SOPs whose current version has no video (as the dashboard counts). */
import fs from "fs";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const SCRATCH = "C:/Users/rohth/AppData/Local/Temp/claude/d--dev-sop/cb2bb116-c8e9-49c6-9283-eb152126de17/scratchpad";
async function main() {
  const { groupSOPRecords, extractIdentifierFromFilename } = await import("@/lib/sop-utils");
  const { connectDB } = await import("@/lib/mongodb");
  const SOP = (await import("@/models/SOP")).default;
  const mongoose = (await import("mongoose")).default;
  const fam = (c: string) => c.toUpperCase().replace(/-\d+$/, "").replace(/^([A-Z]+)0+(\d+)/, "$1$2");

  const eFam = new Set<string>();
  for (const f of fs.readFileSync(`${SCRATCH}/e-videos.txt`, "utf8").split(/\r?\n/).filter(Boolean)) {
    const id = extractIdentifierFromFilename(f.split("/").pop()!);
    if (id) eFam.add(fam(id));
  }
  eFam.add("QAGE53"); // files on E have no version in the name

  await connectDB();
  const rows = groupSOPRecords(await SOP.find({ isObsolete: { $ne: true } }));
  const missing = rows.filter((r) => r.media.videos.en + r.media.videos.gu === 0);
  const byDept = new Map<string, string[]>();
  const onE: string[] = [];
  for (const r of missing.sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }))) {
    const code = r.identifier;
    if (eFam.has(fam(code))) onE.push(`${code} (${r.department})`);
    byDept.set(r.department, [...(byDept.get(r.department) || []), code]);
  }
  console.log(`TOTAL ${rows.length} | with video ${rows.length - missing.length} | without ${missing.length}`);
  console.log(`ON_E ${onE.join(", ")}`);
  const out: string[] = [];
  for (const [d, list] of [...byDept].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`DEPT ${d} (${list.length}): ${list.join(", ")}`);
    out.push(...list.map((c) => `${c}\t${d}`));
  }
  fs.writeFileSync(`${SCRATCH}/sops-without-videos.txt`, out.join("\n"));
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
