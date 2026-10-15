/**
 * Normalize stored SOP identifiers to the two-digit canonical form
 * (QAGE1-1 → QAGE01-01, QAGE01-8 → QAGE01-08). Only the identifier string changes —
 * every record keeps its _id, so linked questions, files, media, training records,
 * exam results and version history stay attached.
 *
 * Usage:
 *   npx tsx scripts/normalize-sop-version-digits.ts            # dry run (default)
 *   npx tsx scripts/normalize-sop-version-digits.ts --apply    # write; saves a backup JSON first
 *   npx tsx scripts/normalize-sop-version-digits.ts --revert backups/sop-version-digits-<ts>.json
 *
 * Not touched (internal keys / base codes without a revision, matched by normalized key):
 * mcqgenjobs, sopfilesimportmanifests, sops.sopBaseId, LMS collections.
 */
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { canonicalSopIdentifier } from "@/lib/sopIdentifierNormalize";

/** collection → identifier field. Unique compound indexes are handled per-document. */
const TARGETS: Array<[string, string]> = [
  ["sops", "identifier"],
  ["mcqbanks", "sopIdentifier"],
  ["mcqbanktestresults", "sopIdentifier"],
  ["compliancereports", "sopIdentifier"],
  ["complianceanalysisjobs", "sopIdentifier"],
  ["compliancerunrequests", "sopIdentifier"],
  ["recheckruns", "sopIdentifier"],
  ["notifications", "sopIdentifier"],
  ["trainingmatrixes", "sopIdentifier"],
  ["trainingmatricesrecord", "sopCode"],
  ["matricessopassignment", "sopCode"],
  ["inductiontrainingmatricesrecord", "sopCode"],
  ["inductionmatricessopassignment", "sopCode"],
];

/** Only standard codes with a revision suffix are rewritten. */
const STANDARD = /^[A-Za-z]{2,6}\d+-\d+$/;

type Change = { collection: string; field: string; _id: unknown; from: string; to: string };

function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const env = fs.readFileSync(file, "utf8");
      for (const line of env.split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
      }
      return;
    } catch {
      /* ignore */
    }
  }
}

async function collectChanges(db: mongoose.mongo.Db): Promise<Change[]> {
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
  const changes: Change[] = [];
  for (const [collection, field] of TARGETS) {
    if (!existing.has(collection)) continue;
    const cursor = db
      .collection(collection)
      .find({ [field]: { $type: "string" } }, { projection: { [field]: 1 } });
    for await (const doc of cursor) {
      const from = String(doc[field]);
      if (!STANDARD.test(from.trim())) continue;
      const to = canonicalSopIdentifier(from);
      if (to && to !== from) changes.push({ collection, field, _id: doc._id, from, to });
    }
  }
  return changes;
}

/** Records that already exist under two spellings of one version — reported, never auto-merged. */
async function reportEquivalentDuplicates(db: mongoose.mongo.Db) {
  const checks: Array<{ collection: string; field: string; groupBy: string[]; filter: object }> = [
    { collection: "sops", field: "identifier", groupBy: ["language", "fileType"], filter: { isObsolete: { $ne: true } } },
    { collection: "mcqbanks", field: "sopIdentifier", groupBy: ["language"], filter: { isObsolete: { $ne: true } } },
    { collection: "matricessopassignment", field: "sopCode", groupBy: ["department"], filter: { isActive: true } },
  ];
  for (const { collection, field, groupBy, filter } of checks) {
    const rows = await db
      .collection(collection)
      .find(filter, { projection: { [field]: 1, ...Object.fromEntries(groupBy.map((g) => [g, 1])) } })
      .toArray();
    const groups = new Map<string, Set<string>>();
    for (const r of rows) {
      const raw = String(r[field] ?? "");
      if (!STANDARD.test(raw)) continue;
      const key = [canonicalSopIdentifier(raw), ...groupBy.map((g) => String(r[g] ?? ""))].join(" | ");
      if (!groups.has(key)) groups.set(key, new Set());
      groups.get(key)!.add(raw);
    }
    const mixed = [...groups].filter(([, spellings]) => spellings.size > 1);
    console.log(
      `  ${collection}: ${mixed.length} group(s) already stored under multiple spellings` +
        (mixed.length ? ` (review manually; e.g. ${mixed.slice(0, 5).map(([k, s]) => `${k} ← [${[...s].join(", ")}]`).join("; ")})` : ""),
    );
  }
}

async function applyChanges(db: mongoose.mongo.Db, changes: Change[]) {
  let updated = 0;
  const conflicts: Change[] = [];
  for (const c of changes) {
    try {
      const res = await db
        .collection(c.collection)
        .updateOne({ _id: c._id as never, [c.field]: c.from }, { $set: { [c.field]: c.to } });
      updated += res.modifiedCount;
    } catch (e) {
      if ((e as { code?: number }).code === 11000) conflicts.push(c);
      else throw e;
    }
  }
  return { updated, conflicts };
}

async function bustCaches() {
  const { invalidateDashboardSopsCache } = await import("@/lib/server-cache");
  const { invalidateMcqBankAggregateCache } = await import("@/lib/mcqBankAggregateCache");
  invalidateDashboardSopsCache();
  await Promise.resolve(invalidateMcqBankAggregateCache());
  // Persistent cache invalidation is fire-and-forget; give it a moment before disconnecting.
  await new Promise((r) => setTimeout(r, 2000));
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const revertIdx = args.indexOf("--revert");
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;

  if (revertIdx >= 0) {
    const file = args[revertIdx + 1];
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Change[];
    let restored = 0;
    for (const c of saved) {
      const res = await db
        .collection(c.collection)
        .updateOne(
          { _id: new mongoose.Types.ObjectId(String(c._id)), [c.field]: c.to },
          { $set: { [c.field]: c.from } },
        );
      restored += res.modifiedCount;
    }
    console.log(`Reverted ${restored}/${saved.length} change(s) from ${file}`);
    await bustCaches();
    await mongoose.disconnect();
    return;
  }

  const changes = await collectChanges(db);
  const byCollection = new Map<string, Change[]>();
  for (const c of changes) {
    if (!byCollection.has(c.collection)) byCollection.set(c.collection, []);
    byCollection.get(c.collection)!.push(c);
  }

  console.log(`${apply ? "APPLY" : "DRY RUN"} — ${changes.length} identifier(s) to normalize`);
  for (const [collection, list] of byCollection) {
    const samples = [...new Map(list.map((c) => [c.from, c.to]))].slice(0, 5);
    console.log(`  ${collection.padEnd(32)} ${String(list.length).padStart(6)}  e.g. ${samples.map(([f, t]) => `${f}→${t}`).join(", ")}`);
  }
  console.log("Pre-existing equivalent duplicates:");
  await reportEquivalentDuplicates(db);

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to write changes.");
    await mongoose.disconnect();
    return;
  }

  const backupDir = path.join(process.cwd(), "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, `sop-version-digits-${Date.now()}.json`);
  fs.writeFileSync(backupFile, JSON.stringify(changes, null, 2));
  console.log(`\nBackup written: ${backupFile}`);

  const { updated, conflicts } = await applyChanges(db, changes);
  console.log(`Updated ${updated} document(s).`);
  if (conflicts.length) {
    console.log(`Skipped ${conflicts.length} change(s) — a record with the canonical spelling already exists (unique index):`);
    for (const c of conflicts.slice(0, 50)) console.log(`  ${c.collection} ${String(c._id)} ${c.from} → ${c.to}`);
  }
  await bustCaches();
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
