/**
 * Assess every active SOP that has no completed compliance report.
 * Uses the same Codex compliance pipeline as Run All Pending, one SOP at a time.
 * Each saved SOP note records that Codex performed the assessment.
 *
 *   npx tsx scripts/run-pending-compliance.ts
 */
import fs from "fs";
import { connectDB } from "@/lib/mongodb";
import ComplianceReport from "@/models/ComplianceReport";
import ComplianceRunRequest from "@/models/ComplianceRunRequest";
import { getGroupedRegistryRows } from "@/lib/dashboardRegistrySource";
import { normalizeSopIdentifierKey } from "@/lib/sopIdentifierNormalize";
import { completeMatchingComplianceRunRequests } from "@/lib/complianceRunRequests";
import { runComplianceV5Job } from "@/lib/start-compliance-v5-async";
import { checkCodexCliHealth, getComplianceCodexModel } from "@/lib/codex-cli";

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

async function listPending() {
  await connectDB();
  const grouped = await getGroupedRegistryRows();
  const active = grouped.filter((s) => !s.isObsolete);
  const analyzed = await ComplianceReport.find({ analysisStatus: "completed" })
    .select("sopId sopIdentifier")
    .lean();
  const analyzedKeys = new Set<string>();
  for (const r of analyzed) {
    if (r.sopId) analyzedKeys.add(`id:${String(r.sopId)}`);
    const key = normalizeSopIdentifierKey(r.sopIdentifier ?? "");
    if (key) analyzedKeys.add(`code:${key}`);
  }
  return active.filter(
    (s) =>
      !analyzedKeys.has(`id:${String(s.id)}`) &&
      !analyzedKeys.has(`code:${normalizeSopIdentifierKey(s.identifier ?? "")}`),
  );
}

/** Dashboard "request a compliance run" rows, oldest first, ahead of the rest. */
async function requestedFirst<T extends { id: string; identifier?: string }>(pending: T[]) {
  const requests = await ComplianceRunRequest.find({
    status: { $in: ["pending", "in_progress"] },
  })
    .sort({ createdAt: 1 })
    .select("sopId sopIdentifier")
    .lean();

  const rank = new Map<string, number>();
  requests.forEach((r, i) => {
    if (r.sopId) rank.set(`id:${String(r.sopId)}`, i);
    const key = normalizeSopIdentifierKey(r.sopIdentifier ?? "");
    if (key && !rank.has(`code:${key}`)) rank.set(`code:${key}`, i);
  });

  const orderOf = (sop: T) => {
    const byId = rank.get(`id:${String(sop.id)}`);
    const byCode = rank.get(`code:${normalizeSopIdentifierKey(sop.identifier ?? "")}`);
    if (byId == null && byCode == null) return Number.POSITIVE_INFINITY;
    return Math.min(byId ?? Number.POSITIVE_INFINITY, byCode ?? Number.POSITIVE_INFINITY);
  };

  const sorted = [...pending].sort((a, b) => orderOf(a) - orderOf(b));
  const requestedCount = sorted.filter((sop) => orderOf(sop) !== Number.POSITIVE_INFINITY).length;
  return { sorted, requestedCount };
}

/** Close open requests whose SOP already has a completed report. */
async function closeRequestsAlreadyReported() {
  const [open, reports] = await Promise.all([
    ComplianceRunRequest.find({ status: { $in: ["pending", "in_progress"] } }).lean(),
    ComplianceReport.find({ analysisStatus: "completed" })
      .select(
        "_id sopId sopIdentifier sopName department overallScore complianceStatus analyzedAt compliantCount partialCount nonCompliantCount",
      )
      .lean(),
  ]);
  if (!open.length || !reports.length) return 0;

  const byId = new Map<string, (typeof reports)[number]>();
  const byCode = new Map<string, (typeof reports)[number]>();
  for (const report of reports) {
    if (report.sopId) byId.set(String(report.sopId), report);
    const key = normalizeSopIdentifierKey(report.sopIdentifier ?? "");
    if (key && !byCode.has(key)) byCode.set(key, report);
  }

  let closed = 0;
  const seen = new Set<string>();
  for (const req of open) {
    const report =
      (req.sopId ? byId.get(String(req.sopId)) : undefined) ??
      byCode.get(normalizeSopIdentifierKey(req.sopIdentifier ?? ""));
    if (!report) continue;
    const key = String(report._id);
    if (seen.has(key)) continue;
    seen.add(key);
    closed += await completeMatchingComplianceRunRequests(report);
  }
  return closed;
}

async function main() {
  loadEnv();
  // PENDING_PROVIDER=gemini PENDING_MODEL=gemini-2.5-flash-lite for a fast run.
  const provider = (process.env.PENDING_PROVIDER ?? "codex") as "codex" | "gemini";
  let model: string | undefined = process.env.PENDING_MODEL;
  if (provider === "codex") {
    const health = await checkCodexCliHealth();
    if (!health.ok || !health.loggedIn) {
      throw new Error(health.error ?? "Codex CLI is not logged in. Run: codex login");
    }
    model ??= getComplianceCodexModel();
  }
  console.log(`${provider} ready (${model ?? "default model"}).`);
  await connectDB();

  const closed = await closeRequestsAlreadyReported();
  if (closed) console.log(`Closed ${closed} request(s) that already had a completed report.`);

  const { sorted: pending, requestedCount } = await requestedFirst(await listPending());
  console.log(`Pending SOPs: ${pending.length} (${requestedCount} requested first)`);
  let done = 0;
  let failed = 0;
  for (const sop of pending) {
    const n = done + failed + 1;
    console.log(`[${n}/${pending.length}] ${sop.identifier} — ${sop.name}`);
    try {
      await runComplianceV5Job({
        sopId: sop.id,
        provider,
        model,
        forceRefresh: false,
        includeAnnexures: true,
      });
      done += 1;
    } catch (err) {
      failed += 1;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`FAILED ${sop.identifier}: ${message}`);
      if (message.includes("Codex usage limit reached")) {
        console.error("Stopping queue: Codex quota is exhausted for every remaining SOP.");
        break;
      }
    }
  }
  console.log(`Finished. Completed ${done}, failed ${failed}, of ${pending.length}.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
