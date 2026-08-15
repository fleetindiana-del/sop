/**
 * Translate English MCQ banks into Gujarati via the Codex CLI, storing each
 * translation against its MASTER question (one MCQ, many languages) rather than
 * creating separate questions.
 *
 * Requires a local Codex login (`codex login`) — no OpenAI API key.
 *
 * Run:
 *   npx tsx scripts/translate-mcqs.ts                 # all departments, all active English banks
 *   npx tsx scripts/translate-mcqs.ts --dept Store    # one department
 *   npx tsx scripts/translate-mcqs.ts --sop MAGE01    # one SOP family
 *   npx tsx scripts/translate-mcqs.ts --limit 5       # first 5 banks only
 *   npx tsx scripts/translate-mcqs.ts --max-per-bank 8  # pilot: 8 questions per bank
 *   npx tsx scripts/translate-mcqs.ts --retranslate   # redo questions that already have Gujarati
 *   npx tsx scripts/translate-mcqs.ts --allow-untranslated-options  # permit Latin-script options
 *   npx tsx scripts/translate-mcqs.ts --dry-run       # report what would run, call no model
 *
 * Safe to re-run: questions that already have an up-to-date Gujarati translation
 * are skipped, so an interrupted run resumes where it stopped.
 */
import fs from "fs";
import mongoose from "mongoose";
import {
  TRANSLATION_BATCH_SIZE,
  ensureBankMcqIds,
  saveBankTranslations,
  toMasterMcqs,
  translateMcqBatch,
} from "@/lib/mcqTranslation";
import { checkCodexCliHealth } from "@/lib/codex-cli";

function loadEnv() {
  const env = fs.readFileSync(".env.local", "utf8");
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  loadEnv();
  await mongoose.connect(process.env.MONGODB_URI!);

  const dept = arg("dept");
  const sop = arg("sop");
  const limit = Number(arg("limit")) || 0;
  const maxPerBank = Number(arg("max-per-bank")) || 0;
  const retranslate = flag("retranslate");
  // Escape hatch for banks whose options are proper nouns or brand names that the
  // model legitimately leaves in Latin script.
  const allowUntranslatedOptions = flag("allow-untranslated-options");
  const dryRun = flag("dry-run");

  if (!dryRun) {
    const health = await checkCodexCliHealth();
    if (!health.ok) {
      console.error(`Codex CLI not usable: ${health.error}`);
      process.exit(1);
    }
    console.log(`Codex ready — model ${health.model} (${health.authMode ?? "chatgpt login"})\n`);
  }

  const col = mongoose.connection.db!.collection("mcqbanks");
  const filter: Record<string, unknown> = {
    isObsolete: { $ne: true },
    // Master text is English; Gujarati banks are the legacy standalone sets.
    $or: [{ language: "English" }, { language: { $exists: false } }],
  };
  if (dept) filter.department = new RegExp(`^${dept}$`, "i");
  if (sop) filter.sopIdentifier = new RegExp(sop.replace(/-/g, "-?"), "i");

  // List banks WITHOUT their mcqs arrays — a server-side sort over full banks
  // exceeds Mongo's 32MB in-memory sort limit. Questions are loaded per bank below.
  let banks = await col
    .find(filter, { projection: { sopIdentifier: 1, sopName: 1, department: 1 } })
    .toArray();
  banks.sort(
    (a, b) =>
      String(a.department ?? '').localeCompare(String(b.department ?? '')) ||
      String(a.sopIdentifier ?? '').localeCompare(String(b.sopIdentifier ?? '')),
  );
  if (limit > 0) banks = banks.slice(0, limit);

  console.log(`Banks to process: ${banks.length}${dept ? ` (dept=${dept})` : ""}\n`);

  let totalTranslated = 0;
  let totalSkipped = 0;
  const allFailures: Array<{ sop: string; mcqId: string; reason: string }> = [];

  for (const [n, bank] of banks.entries()) {
    const label = `${bank.sopIdentifier} [${bank.department}]`;

    const assigned = dryRun ? 0 : await ensureBankMcqIds(bank._id);
    const fresh = await col.findOne({ _id: bank._id }, { projection: { mcqs: 1 } });

    // A dry run skips id assignment, so stand in ids purely for counting — real
    // runs always have persisted ids by this point.
    const rows = ((fresh?.mcqs ?? []) as Parameters<typeof toMasterMcqs>[0]).map((m, i) =>
      dryRun && !m.mcqId ? { ...m, mcqId: `dry-${i}` } : m,
    );
    let masters = toMasterMcqs(rows, "gu", { includeTranslated: retranslate });
    if (maxPerBank > 0) masters = masters.slice(0, maxPerBank);

    const total = (fresh?.mcqs ?? []).length;
    if (masters.length === 0) {
      console.log(`[${n + 1}/${banks.length}] ${label} — up to date (${total} MCQs)`);
      continue;
    }

    console.log(
      `[${n + 1}/${banks.length}] ${label} — ${masters.length}/${total} to translate` +
        (assigned ? ` (assigned ${assigned} ids)` : ""),
    );
    if (dryRun) {
      totalSkipped += masters.length;
      continue;
    }

    for (let i = 0; i < masters.length; i += TRANSLATION_BATCH_SIZE) {
      const batch = masters.slice(i, i + TRANSLATION_BATCH_SIZE);
      try {
        const { translations, failures } = await translateMcqBatch(batch, { lang: "gu", allowUntranslatedOptions });

        // Rejected questions get one solo retry — a bad batch is usually one
        // question confusing the model, not all of them.
        for (const f of failures) {
          const master = batch.find((m) => m.mcqId === f.mcqId);
          if (!master) continue;
          const retry = await translateMcqBatch([master], { lang: "gu" });
          const t = retry.translations.get(master.mcqId);
          if (t) translations.set(master.mcqId, t);
          else {
            allFailures.push({
              sop: String(bank.sopIdentifier),
              mcqId: f.mcqId,
              reason: retry.failures[0]?.reason ?? f.reason,
            });
          }
        }

        const written = await saveBankTranslations(bank._id, "gu", translations);
        totalTranslated += written;
        console.log(
          `    batch ${Math.floor(i / TRANSLATION_BATCH_SIZE) + 1}: ${written}/${batch.length} saved`,
        );
      } catch (err) {
        console.error(`    batch failed: ${err instanceof Error ? err.message : String(err)}`);
        for (const m of batch) {
          allFailures.push({
            sop: String(bank.sopIdentifier),
            mcqId: m.mcqId,
            reason: "batch call failed",
          });
        }
      }
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Translated + stored : ${totalTranslated}`);
  if (dryRun) console.log(`Would translate     : ${totalSkipped}`);
  if (allFailures.length) {
    console.log(`\nRejected (${allFailures.length}) — master left untranslated, safe to re-run:`);
    for (const f of allFailures.slice(0, 40)) {
      console.log(`  ${f.sop} ${f.mcqId.slice(0, 8)} — ${f.reason}`);
    }
    if (allFailures.length > 40) console.log(`  … and ${allFailures.length - 40} more`);
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
