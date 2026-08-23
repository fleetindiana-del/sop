/**
 * Local Codex MCQ worker.
 *
 * Production (Vercel) cannot run Codex CLI. New SOP uploads queue MCQGenJob
 * rows with awaitingLocalWorker=true. This process polls MongoDB and runs them.
 *
 * Requires .env.local MONGODB_URI to be the SAME database as production.
 *
 *   npm run mcq:worker
 *   npm run dev          # also starts this worker
 */
import fs from "fs";

const CODEX_RETRY_MS = 30_000;

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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCodex(
  checkCodexCliHealth: typeof import("@/lib/codex-cli").checkCodexCliHealth,
  shouldStop: () => boolean,
  pollMs: number,
): Promise<boolean> {
  while (!shouldStop()) {
    const health = await checkCodexCliHealth();
    if (health.ok && health.loggedIn) {
      console.log(`[mcq-worker] Codex ready (${health.model}). Polling every ${pollMs / 1000}s.`);
      return true;
    }
    console.warn(
      `[mcq-worker] Codex not ready (${health.error ?? "not logged in"}). Retrying in ${CODEX_RETRY_MS / 1000}s. Run: codex login`,
    );
    await sleep(CODEX_RETRY_MS);
  }
  return false;
}

async function main() {
  loadEnv();
  const POLL_MS = Number(process.env.MCQ_WORKER_POLL_MS) || 8_000;
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — add the production MongoDB URI to .env.local");
  }

  const { checkCodexCliHealth } = await import("@/lib/codex-cli");
  const { claimNextLocalMcqJob, updateMcqGenJob } = await import("@/lib/mcq-gen-job-store");
  const { runMcqGeneration } = await import("@/lib/mcq-generation");
  const { connectDB } = await import("@/lib/mongodb");

  console.log("[mcq-worker] connecting to MongoDB…");
  await connectDB();

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const ready = await waitForCodex(checkCodexCliHealth, () => stopping, POLL_MS);
  if (!ready) return;

  while (!stopping) {
    let claimedId = "";
    try {
      const job = await claimNextLocalMcqJob();
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }
      claimedId = job.identifier;
      console.log(`[mcq-worker] starting ${job.identifier} (${job.mode})`);
      await runMcqGeneration(job.identifier, job.mode, "codex", job.languageScope);
      console.log(`[mcq-worker] finished ${job.identifier}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[mcq-worker] job failed:", message);
      if (claimedId) {
        await updateMcqGenJob(claimedId, {
          status: "failed",
          awaitingLocalWorker: false,
          phase: "Local Codex worker failed",
          error: message,
          finishedAt: new Date(),
        }).catch(() => undefined);
      }
      await sleep(POLL_MS);
    }
  }

  console.log("[mcq-worker] stopped");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
