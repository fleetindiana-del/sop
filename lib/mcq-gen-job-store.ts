import MCQGenJob, { type McqGenLanguage, type McqGenMode } from "@/models/MCQGenJob";
import { isMcqRunActiveInProcess } from "@/lib/mcq-run-control";
import { normalizeSopIdentifierKey, sopIdentifierMatchFilter } from "@/lib/sopIdentifierNormalize";

/** Grace period after queueing before treating a non-started job as orphaned. */
const MCQ_QUEUE_GRACE_MS = 30_000;
/** Running jobs with no in-process worker are only stale after this long. */
const MCQ_RUNNING_STALE_MS = 5 * 60_000;

/** One canonical job id per SOP (QAMI34-08 and QAMI34-8 → QAMI34-8). */
export function canonicalMcqJobId(identifier: string): string {
  return normalizeSopIdentifierKey(identifier.trim());
}

export function mcqGenJobMatchFilter(identifier: string): Record<string, unknown> {
  return sopIdentifierMatchFilter(identifier, "identifier");
}

/**
 * Collapse duplicate MCQGenJob rows for identifier variants into a single
 * document keyed by the canonical id. Returns that canonical id.
 */
export async function ensureSingleMcqGenJob(identifier: string): Promise<string> {
  const canonicalId = canonicalMcqJobId(identifier);
  const all = await MCQGenJob.find(mcqGenJobMatchFilter(identifier))
    .sort({ updatedAt: -1 })
    .lean();

  if (all.length === 0) return canonicalId;

  const canonicalDoc = all.find((j) => j.identifier === canonicalId);
  const keeper = canonicalDoc ?? all[0];
  const deleteIds = all
    .filter((j) => String(j._id) !== String(keeper._id))
    .map((j) => j._id);

  if (deleteIds.length > 0) {
    await MCQGenJob.deleteMany({ _id: { $in: deleteIds } });
  }

  if (keeper.identifier !== canonicalId) {
    const conflict = await MCQGenJob.findOne({ identifier: canonicalId }).lean();
    if (conflict && String(conflict._id) !== String(keeper._id)) {
      const keeperNewer =
        new Date(keeper.updatedAt ?? 0).getTime() > new Date(conflict.updatedAt ?? 0).getTime();
      if (keeperNewer) {
        await MCQGenJob.updateOne(
          { _id: conflict._id },
          {
            $set: {
              mode: keeper.mode,
              languageScope: keeper.languageScope,
              status: keeper.status,
              phase: keeper.phase,
              percent: keeper.percent,
              languages: keeper.languages,
              totalInserted: keeper.totalInserted,
              totalSkipped: keeper.totalSkipped,
              totalFailedBatches: keeper.totalFailedBatches,
              error: keeper.error,
              cancelRequested: keeper.cancelRequested,
              logs: keeper.logs,
              startedAt: keeper.startedAt,
              finishedAt: keeper.finishedAt,
              updatedAt: new Date(),
            },
          },
        );
      }
      await MCQGenJob.deleteOne({ _id: keeper._id });
      return canonicalId;
    }
    await MCQGenJob.updateOne({ _id: keeper._id }, { $set: { identifier: canonicalId } });
  }

  return canonicalId;
}

/** Upsert the single job row for this SOP family (never hits identifier unique dup). */
export async function upsertMcqGenJob(
  identifier: string,
  $set: Record<string, unknown>,
): Promise<string> {
  const canonicalId = await ensureSingleMcqGenJob(identifier);
  await MCQGenJob.updateOne(
    { identifier: canonicalId },
    { $set: { ...$set, identifier: canonicalId, updatedAt: new Date() } },
    { upsert: true },
  );
  return canonicalId;
}

/** Update job progress; creates the row if missing. */
export async function updateMcqGenJob(
  identifier: string,
  $set: Record<string, unknown>,
): Promise<void> {
  await upsertMcqGenJob(identifier, $set);
}

export async function findMcqGenJob(identifier: string) {
  const canonicalId = canonicalMcqJobId(identifier);
  let job = await MCQGenJob.findOne({ identifier: canonicalId }).lean();
  if (!job) {
    job = await MCQGenJob.findOne(mcqGenJobMatchFilter(identifier)).lean();
  }
  return job;
}

/** Clear DB rows stuck in queued/running when no in-process run exists (enqueue only). */
export async function healOrphanedMcqGenJobIfNeeded(
  identifier: string,
  job: {
    status: string;
    awaitingLocalWorker?: boolean;
    updatedAt?: Date | string | null;
    startedAt?: Date | string | null;
  },
): Promise<boolean> {
  if (job.status !== "queued" && job.status !== "running") return false;
  if (isMcqRunActiveInProcess(identifier)) return false;
  // Production queues Codex work for a local worker — do not fail these as orphans.
  if (job.status === "queued" && job.awaitingLocalWorker) return false;

  const now = Date.now();
  const updatedMs = new Date(job.updatedAt ?? 0).getTime();
  const startedMs = new Date(job.startedAt ?? job.updatedAt ?? 0).getTime();
  const ageMs = now - updatedMs;
  const runAgeMs = now - startedMs;

  if (job.status === "queued" && runAgeMs < MCQ_QUEUE_GRACE_MS) return false;
  if (job.status === "running" && ageMs < MCQ_RUNNING_STALE_MS) return false;

  await updateMcqGenJob(identifier, {
    status: "failed",
    phase: "Previous run interrupted",
    error: "Generation did not finish — you can start again",
    finishedAt: new Date(),
  });
  return true;
}

/** Atomically take the oldest Codex job waiting for a local worker. */
export async function claimNextLocalMcqJob(): Promise<{
  identifier: string;
  mode: McqGenMode;
  languageScope?: McqGenLanguage;
} | null> {
  const job = await MCQGenJob.findOneAndUpdate(
    {
      status: "queued",
      awaitingLocalWorker: true,
      cancelRequested: { $ne: true },
    },
    {
      $set: {
        status: "running",
        awaitingLocalWorker: false,
        phase: "Claimed by local Codex worker",
        updatedAt: new Date(),
      },
    },
    { sort: { startedAt: 1 }, new: true },
  ).lean();

  if (!job?.identifier) return null;
  return {
    identifier: job.identifier,
    mode: (job.mode ?? "generate") as McqGenMode,
    languageScope: job.languageScope,
  };
}
