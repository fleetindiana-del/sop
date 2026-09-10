/** READ-ONLY: inspect SopFilesImportJob history for annexure files that
 *  failed to import, to see the actual recorded error messages.
 *  Run: npx tsx scripts/diag-annexure-import-failures.ts */
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
  const jobs = mongoose.connection.collection("sopfilesimportjobs");

  const cursor = jobs.find({}, { projection: { files: 1, totals: 1, createdAt: 1, scopes: 1 } });
  const failuresByMessage = new Map<string, number>();
  const failureExamples: any[] = [];
  let totalJobs = 0;
  let totalFailedFiles = 0;

  for await (const job of cursor) {
    totalJobs++;
    for (const f of job.files ?? []) {
      const isAnnexPath = /annex(ure)?|appendix/i.test(f.relativePath || f.fileName || "");
      if (f.status === "failed" && isAnnexPath) {
        totalFailedFiles++;
        const msg = f.message || "(no message)";
        failuresByMessage.set(msg, (failuresByMessage.get(msg) ?? 0) + 1);
        if (failureExamples.length < 30) {
          failureExamples.push({ relativePath: f.relativePath, message: f.message, jobDate: job.createdAt });
        }
      }
    }
  }

  console.log(`Scanned ${totalJobs} import job(s). Found ${totalFailedFiles} failed annexure file result(s).\n`);
  console.log("=== Failure message breakdown ===");
  for (const [msg, count] of [...failuresByMessage.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${count}x  ${msg}`);
  }
  console.log("\n=== Examples ===");
  for (const ex of failureExamples) {
    console.log(`  [${new Date(ex.jobDate).toISOString()}] ${ex.relativePath} -> ${ex.message}`);
  }

  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
