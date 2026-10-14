/**
 * Upload the remaining E: drive videos/slides through the app's own
 * processMediaUpload (which now attaches to the current SOP version).
 *   npx tsx .tmp-diag/upload-remaining.ts          # dry run: show target version
 *   npx tsx .tmp-diag/upload-remaining.ts --apply  # upload
 */
import fs from "fs";
import path from "path";
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const APPLY = process.argv.includes("--apply");

// identifier → files. QAGE53 files carry no version, so name the SOP explicitly.
const BATCHES: Array<{ identifier: string; files: string[] }> = [
  { identifier: "QAIC37-00", files: ["New folder/QAIC37-00-BRIEF.mp4", "New folder/QAIC37-00-EXPLAINER.mp4", "New folder/QAIC37-00-SLIDES.pdf"] },
  { identifier: "QAMI01-06", files: ["Microbiology/QAMI01-06-BRIEF.mp4", "Microbiology/QAMI01-06-EXPLAINER.mp4"] },
  { identifier: "PRCL23-02", files: ["PRCL23-02-Brief.mp4", "PRCL23-02-Explainer.mp4", "PRCL23-02-Slides.pdf"] },
  { identifier: "PREG04-04", files: ["PREG04-04-Brief.mp4", "PREG04-04-Explainer.mp4", "PREG04-04-Slides.pdf"] },
  { identifier: "PREG10-07", files: ["PREG10-07-Brief.mp4", "PREG10-07-Explainer.mp4", "PREG10-07-Slides.pdf"] },
  { identifier: "QAMI29-03", files: ["QAMI29-03-BRIEF.mp4", "QAMI29-03-EXPLAINER.mp4", "QAMI29-03-SLIDES.pdf"] },
  { identifier: "QAGE53-06", files: ["QAGE53-brief.mp4", "QAGE53-explainer.mp4"] },
];

async function main() {
  const { asMediaArray, maxVersionInGroup, recordsForVersion, sopFamilyGroupKey, sopFamilyIdentifierRegex } =
    await import("@/lib/sop-utils");
  const { connectDB } = await import("@/lib/mongodb");
  const SOP = (await import("@/models/SOP")).default;
  const { processMediaUpload } = await import("@/lib/media-upload");
  const mongoose = (await import("mongoose")).default;
  await connectDB();

  for (const { identifier, files } of BATCHES) {
    // Same resolution as findSopGroup in lib/media-upload.ts.
    const family = await SOP.find({
      identifier: { $regex: sopFamilyIdentifierRegex(identifier) },
      isObsolete: { $ne: true },
    });
    const key = family[0] ? sopFamilyGroupKey(family[0]) : "";
    const group = family.filter((r) => sopFamilyGroupKey(r) === key);
    const current = group.length ? recordsForVersion(group, maxVersionInGroup(group)) : [];
    void asMediaArray;
    const target = current[0]?.identifier ?? "NOT FOUND";

    // Skip files already attached to the current version (re-runs after a partial upload).
    const attached = new Set(current.flatMap((r) => (r.sopDocuments ?? []).map((d) => String(d.fileName))));
    const wanted = files.filter((f) => !attached.has(path.basename(f)));
    console.log(`${identifier.padEnd(10)} → ${target.padEnd(10)} upload ${wanted.length}, already attached ${files.length - wanted.length}`);
    if (!APPLY || !current.length) continue;

    // One file per request so a slow upload cannot time out the rest.
    for (const rel of wanted) {
      const fd = new FormData();
      fd.set("identifier", identifier);
      const buf = fs.readFileSync(path.join("E:/", rel));
      const file = new File([buf], path.basename(rel), { type: rel.endsWith(".pdf") ? "application/pdf" : "video/mp4" });
      fd.append(rel.endsWith(".pdf") ? "slides" : "videos", file);
      const { results } = await processMediaUpload(fd);
      for (const r of results) console.log(`   ${r.success ? "OK  " : "FAIL"} ${r.file}${r.error ? ` — ${r.error}` : ""}`);
    }
  }
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
