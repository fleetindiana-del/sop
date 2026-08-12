/**
 * Repair MCQ banks that were wrongly flagged obsolete.
 *
 * A department-scoped call to /api/mcq-bank/stats used to reconcile the GLOBAL
 * obsolete flags against only the caller's visible SOP families, so every bank
 * outside those departments was marked "no active SOP in registry". Obsolete
 * banks are excluded from /api/lms/assets and /api/lms/quiz, which removed the
 * Start Test button for those SOPs in the LMS.
 *
 * This revives banks whose SOP family IS still active in the registry.
 *
 *   npx tsx scripts/revive-orphaned-mcq-banks.ts          # dry run
 *   npx tsx scripts/revive-orphaned-mcq-banks.ts --apply  # write
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
  const apply = process.argv.includes("--apply");

  await mongoose.connect(process.env.MONGODB_URI!);

  // Imported after connect so module-level model registration sees the connection.
  const { getGroupedRegistryRows } = await import("@/lib/dashboardRegistrySource");
  const { buildActiveSopFamilyMap } = await import("@/lib/mcq-bank-utils");
  const { sopFamilyGroupKey } = await import("@/lib/sop-utils");
  const { OBSOLETE_MCQ_REASON } = await import("@/lib/mcq-bank-sync");

  const activeFamilies = buildActiveSopFamilyMap(await getGroupedRegistryRows());
  const col = mongoose.connection.collection("mcqbanks");

  const obsolete = (await col
    .find({ isObsolete: true, obsoleteReason: OBSOLETE_MCQ_REASON })
    .project({ sopIdentifier: 1, language: 1, totalQuestions: 1 })
    .toArray()) as Array<{ _id: unknown; sopIdentifier: string; language?: string; totalQuestions?: number }>;

  const revive = obsolete.filter((b) =>
    activeFamilies.has(sopFamilyGroupKey({ identifier: String(b.sopIdentifier ?? "").trim() })),
  );

  console.log(`orphan-flagged banks: ${obsolete.length}`);
  console.log(`…with an ACTIVE SOP family (will revive): ${revive.length}`);
  for (const b of revive.slice(0, 20)) {
    console.log(`  ${b.sopIdentifier} [${b.language}] q=${b.totalQuestions}`);
  }
  if (revive.length > 20) console.log(`  … +${revive.length - 20} more`);

  if (!apply) {
    console.log("\nDry run — re-run with --apply to write.");
  } else {
    const res = await col.updateMany(
      { _id: { $in: revive.map((b) => b._id) } as never },
      { $set: { isObsolete: false }, $unset: { obsoleteAt: "", obsoleteReason: "" } },
    );
    console.log(`\nRevived ${res.modifiedCount} banks.`);
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
