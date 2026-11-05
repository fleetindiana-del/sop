import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { errorMessage, extractJsonPayload, sleep } from "@/lib/llm-utils";
import LlmTask, { type LlmTaskKind } from "@/models/LlmTask";

const POLL_MS = 2_000;
/** A claimed task goes back to the queue if GrokBot has not answered within this window. */
export const GROKBOT_TASK_LEASE_MS = Number(process.env.GROKBOT_TASK_LEASE_MS) || 10 * 60_000;
const PICKUP_TIMEOUT_MS = Number(process.env.GROKBOT_PICKUP_TIMEOUT_MS) || 10 * 60_000;
const MAX_WAIT_MS = Number(process.env.GROKBOT_TASK_MAX_MS) || 45 * 60_000;
const UNAVAILABLE_COOLDOWN_MS = 5 * 60_000;
const WEBHOOK_MIN_GAP_MS = 60_000;

const UNAVAILABLE_PREFIX = "GrokBot is not answering";
let unavailableUntil = 0;
let lastWebhookAt = 0;

/** True when no GrokBot picked up a task in time; runs should stop instead of retrying every clause. */
export function isGrokbotUnavailableError(error: unknown): boolean {
  return errorMessage(error).includes(UNAVAILABLE_PREFIX);
}

async function notifyGrokbot(): Promise<void> {
  const url = process.env.GROKBOT_WEBHOOK_URL?.trim();
  if (!url || Date.now() - lastWebhookAt < WEBHOOK_MIN_GAP_MS) return;
  lastWebhookAt = Date.now();
  try {
    const pending = await LlmTask.countDocuments({ status: "pending" });
    const secret = process.env.GROKBOT_WEBHOOK_SECRET?.trim();
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify({
        event: "ai_tasks_pending",
        pending,
        message: "SOP software has AI tasks waiting. Use claim_ai_tasks / submit_ai_task_result until the queue is empty.",
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    console.warn(`[grokbot] webhook failed: ${errorMessage(error)}`);
  }
}

async function cancelTask(id: mongoose.Types.ObjectId, reason: string) {
  await LlmTask.updateOne(
    { _id: id, status: { $in: ["pending", "claimed"] } },
    { $set: { status: "cancelled", error: reason } },
  ).catch(() => undefined);
}

/**
 * Queue a prompt for GrokBot and wait for its answer. Same contract as one
 * `codex exec` call: prompt in, raw model text out.
 */
export async function runGrokbotPrompt(
  prompt: string,
  options: { kind: LlmTaskKind; label: string; runKey?: string; signal?: AbortSignal },
): Promise<string> {
  if (Date.now() < unavailableUntil) {
    throw new Error(`${UNAVAILABLE_PREFIX} — no AI task was picked up recently. Ask GrokBot to process the AI task queue, then retry.`);
  }
  if (options.signal?.aborted) throw new Error("Generation cancelled");

  await connectDB();
  const task = await LlmTask.create({
    kind: options.kind,
    label: options.label,
    prompt,
    runKey: options.runKey,
    status: "pending",
    queuedAt: new Date(),
  });
  void notifyGrokbot();

  const startedAt = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    if (options.signal?.aborted) {
      await cancelTask(task._id, "Run cancelled");
      throw new Error("Generation cancelled");
    }

    const row = await LlmTask.findById(task._id).select("status result error queuedAt").lean();
    if (!row) throw new Error("GrokBot task disappeared from the queue");

    if (row.status === "completed") {
      unavailableUntil = 0;
      return row.result ?? "";
    }
    if (row.status === "failed") throw new Error(`GrokBot could not answer: ${row.error ?? "no reason given"}`);
    if (row.status === "cancelled") throw new Error("Generation cancelled");

    const now = Date.now();
    if (row.status === "pending" && now - new Date(row.queuedAt).getTime() > PICKUP_TIMEOUT_MS) {
      await cancelTask(task._id, "Not picked up in time");
      unavailableUntil = now + UNAVAILABLE_COOLDOWN_MS;
      throw new Error(
        `${UNAVAILABLE_PREFIX}: no task was picked up within ${Math.round(PICKUP_TIMEOUT_MS / 60_000)} min. ` +
          "Ask GrokBot to process the AI task queue (claim_ai_tasks).",
      );
    }
    if (now - startedAt > MAX_WAIT_MS) {
      await cancelTask(task._id, "Timed out");
      throw new Error(`GrokBot task timed out after ${Math.round(MAX_WAIT_MS / 60_000)} min`);
    }
  }
}

export async function claimGrokbotTasks(keyId: string, limit: number, kind?: LlmTaskKind) {
  await connectDB();
  const claimed = [];
  for (let i = 0; i < limit; i++) {
    const leaseCutoff = new Date(Date.now() - GROKBOT_TASK_LEASE_MS);
    const task = await LlmTask.findOneAndUpdate(
      {
        $or: [{ status: "pending" }, { status: "claimed", claimedAt: { $lt: leaseCutoff } }],
        ...(kind ? { kind } : {}),
      },
      {
        $set: { status: "claimed", claimedAt: new Date(), claimedByKeyId: keyId },
        $inc: { claimCount: 1 },
      },
      { sort: { queuedAt: 1 }, new: true },
    ).lean();
    if (!task) break;
    claimed.push({
      taskId: String(task._id),
      kind: task.kind,
      label: task.label,
      prompt: task.prompt,
    });
  }
  return claimed;
}

async function explainUnclaimable(taskId: string, keyId: string): Promise<string> {
  const task = await LlmTask.findById(taskId).select("status claimedByKeyId").lean();
  if (!task) return "Unknown taskId";
  if (task.status === "cancelled") return "This task is no longer needed (the run was cancelled or timed out). Skip it.";
  if (task.status === "completed") return "This task was already answered.";
  if (task.status === "pending" || task.claimedByKeyId !== keyId) {
    return "Your claim on this task expired; claim it again with claim_ai_tasks.";
  }
  return `Task is ${task.status}`;
}

export async function submitGrokbotResult(keyId: string, taskId: string, output: string) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) throw new Error("Invalid taskId");
  let json: string;
  try {
    json = extractJsonPayload(output);
    JSON.parse(json);
  } catch {
    throw new Error(
      "Output is not valid JSON. Return ONLY the raw JSON object the prompt asks for (no markdown, no commentary) and submit again.",
    );
  }

  await connectDB();
  const updated = await LlmTask.findOneAndUpdate(
    { _id: taskId, status: "claimed", claimedByKeyId: keyId },
    { $set: { status: "completed", result: json, completedAt: new Date() } },
  ).lean();
  if (!updated) throw new Error(await explainUnclaimable(taskId, keyId));
  return { taskId, accepted: true };
}

export async function failGrokbotTask(keyId: string, taskId: string, reason: string) {
  if (!mongoose.Types.ObjectId.isValid(taskId)) throw new Error("Invalid taskId");
  await connectDB();
  const updated = await LlmTask.findOneAndUpdate(
    { _id: taskId, status: "claimed", claimedByKeyId: keyId },
    { $set: { status: "failed", error: reason.slice(0, 500), completedAt: new Date() } },
  ).lean();
  if (!updated) throw new Error(await explainUnclaimable(taskId, keyId));
  return { taskId, failed: true };
}

export async function grokbotQueueStats() {
  await connectDB();
  const [pending, claimed, completedLastHour, oldest] = await Promise.all([
    LlmTask.countDocuments({ status: "pending" }),
    LlmTask.countDocuments({ status: "claimed" }),
    LlmTask.countDocuments({ status: "completed", completedAt: { $gt: new Date(Date.now() - 3_600_000) } }),
    LlmTask.findOne({ status: "pending" }).sort({ queuedAt: 1 }).select("queuedAt kind label").lean(),
  ]);
  return {
    pending,
    claimed,
    completedLastHour,
    oldestPending: oldest
      ? {
          kind: oldest.kind,
          label: oldest.label,
          waitingSeconds: Math.round((Date.now() - new Date(oldest.queuedAt).getTime()) / 1000),
        }
      : null,
  };
}
