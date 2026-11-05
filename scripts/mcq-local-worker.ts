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

async function connectWorkerDb(shouldStop: () => boolean): Promise<boolean> {
  const { connectDB } = await import("@/lib/mongodb");
  while (!shouldStop()) {
    console.log("[mcq-worker] connecting to MongoDB…");
    try {
      await connectDB();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[mcq-worker] MongoDB unreachable (${message}). Retrying in ${CODEX_RETRY_MS / 1000}s.`);
      await sleep(CODEX_RETRY_MS);
    }
  }
  return false;
}

/**
 * Compliance runs requested by GrokBot (autoRun). Same V3 engine as the
 * Compliance page; GrokBot answers each clause through the AI task queue.
 */
async function runAutoComplianceRequests(shouldStop: () => boolean, pollMs: number) {
  const { claimNextAutoRunRequest, failAutoRunRequest, requeueStaleAutoRunRequests } = await import(
    "@/lib/complianceRunRequests"
  );
  const { runComplianceV3Job } = await import("@/lib/start-compliance-v3-async");
  const { runWithAgentBackend } = await import("@/lib/agent-backend");

  const requeued = await requeueStaleAutoRunRequests().catch(() => 0);
  if (requeued) console.log(`[compliance-worker] re-queued ${requeued} interrupted run(s)`);
  console.log("[compliance-worker] watching for GrokBot compliance requests");

  while (!shouldStop()) {
    const req = await claimNextAutoRunRequest().catch((err) => {
      console.warn("[compliance-worker] claim failed:", err instanceof Error ? err.message : err);
      return null;
    });
    if (!req) {
      await sleep(pollMs);
      continue;
    }
    const backend = req.agentBackend ?? "grokbot";
    console.log(`[compliance-worker] starting ${req.sopIdentifier} (${backend})`);
    try {
      await runWithAgentBackend(backend, () =>
        runComplianceV3Job({ sopId: String(req.sopId), provider: "codex", includeAnnexures: true }),
      );
      // A saved report already completed the request; this only closes stopped runs.
      await failAutoRunRequest(req._id, "The run stopped before a report was saved.");
      console.log(`[compliance-worker] finished ${req.sopIdentifier}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[compliance-worker] ${req.sopIdentifier} failed:`, message);
      await failAutoRunRequest(req._id, message).catch(() => undefined);
    }
  }
}

async function main() {
  loadEnv();
  const POLL_MS = Number(process.env.MCQ_WORKER_POLL_MS) || 8_000;
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI not set — add the production MongoDB URI to .env.local");
  }

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Connect before loading the MCQ pipeline. That import graph is large, and
  // pulling it in while Next is still compiling the first routes exhausts
  // Windows commit memory (Turbopack then aborts on a small Rust allocation).
  const connected = await connectWorkerDb(() => stopping);
  if (!connected) return;

  const { checkCodexCliHealth } = await import("@/lib/codex-cli");
  const { claimNextLocalMcqJob, updateMcqGenJob } = await import("@/lib/mcq-gen-job-store");
  const { runMcqGeneration } = await import("@/lib/mcq-generation");
  const { currentAgentBackend, runWithAgentBackend } = await import("@/lib/agent-backend");

  const complianceLoop = runAutoComplianceRequests(() => stopping, POLL_MS).catch((err) => {
    console.error("[compliance-worker] stopped:", err instanceof Error ? err.message : err);
  });

  const ready = await waitForCodex(checkCodexCliHealth, () => stopping, POLL_MS);

  while (ready && !stopping) {
    let claimedId = "";
    try {
      const job = await claimNextLocalMcqJob();
      if (!job) {
        await sleep(POLL_MS);
        continue;
      }
      claimedId = job.identifier;
      const backend = job.agentBackend ?? currentAgentBackend();
      console.log(`[mcq-worker] starting ${job.identifier} (${job.mode}, ${backend})`);
      await runWithAgentBackend(backend, () =>
        runMcqGeneration(job.identifier, job.mode, "codex", job.languageScope),
      );
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

  await complianceLoop;
  console.log("[mcq-worker] stopped");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
