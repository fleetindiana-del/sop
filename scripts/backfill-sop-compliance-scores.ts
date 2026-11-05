import fs from "fs";
import { connectDB } from "@/lib/mongodb";
import { backfillComplianceOntoSops } from "@/lib/complianceReportStorage";

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const env = fs.readFileSync(file, "utf8");
      for (const line of env.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (!m || process.env[m[1]]) continue;
        let value = m[2].trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        process.env[m[1]] = value;
      }
      return;
    } catch {
      /* try next */
    }
  }
}

async function main() {
  loadEnv();
  await connectDB();
  const updated = await backfillComplianceOntoSops();
  console.log(`Copied compliance scores onto ${updated} SOP(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
