import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerScopedTool } from "@/lib/mcp-sop-tools";
import {
  GROKBOT_TASK_LEASE_MS,
  claimGrokbotTasks,
  failGrokbotTask,
  grokbotQueueStats,
  submitGrokbotResult,
} from "@/lib/grokbot-llm";

const ANSWER_RULES = [
  "You are the AI model behind the SOP software, standing in for Codex. Each task's prompt is the exact prompt Codex would receive.",
  "Answer exactly as the prompt instructs and return ONLY the raw JSON it asks for — no markdown fences, no commentary.",
  "Base every statement on the SOP / guideline text inside the prompt. Do not invent clauses, quotes or facts.",
  `Submit each answer with submit_ai_task_result within ${Math.round(GROKBOT_TASK_LEASE_MS / 60_000)} minutes, or call fail_ai_task if you cannot answer; unanswered claims go back to the queue.`,
  "Keep calling claim_ai_tasks until it returns no tasks — a compliance audit sends one task per guideline clause.",
];

export function registerAiTaskTools(server: McpServer) {
  registerScopedTool(
    server,
    "get_ai_task_queue",
    {
      title: "AI task queue status",
      description:
        "How many compliance / MCQ prompts are waiting for GrokBot to answer, and how long the oldest has waited.",
      inputSchema: z.object({}),
      readOnly: true,
    },
    "ai:work",
    async () => grokbotQueueStats(),
  );

  registerScopedTool(
    server,
    "claim_ai_tasks",
    {
      title: "Claim AI tasks",
      description:
        "Take the oldest waiting AI prompts (V3 compliance clause reviews, MCQ batches, fact extraction, Gujarati translation). Answer each and submit it with submit_ai_task_result.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(5).optional().describe("How many tasks to take at once (default 1)."),
        kind: z.enum(["compliance", "mcq"]).optional().describe("Only take this kind of task."),
      }),
    },
    "ai:work",
    async ({ limit, kind }, principal) => {
      const tasks = await claimGrokbotTasks(principal.keyId, limit ?? 1, kind);
      return tasks.length ? { rules: ANSWER_RULES, tasks } : { tasks: [], message: "No AI tasks waiting." };
    },
  );

  registerScopedTool(
    server,
    "submit_ai_task_result",
    {
      title: "Submit AI task answer",
      description:
        "Send your JSON answer for a claimed task. The waiting compliance or MCQ run validates and saves it exactly as it would a Codex answer. Invalid JSON is rejected so you can fix and resubmit.",
      inputSchema: z.object({
        taskId: z.string().min(1),
        output: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .describe("The raw JSON answer (string or object)."),
      }),
    },
    "ai:work",
    async ({ taskId, output }, principal) =>
      submitGrokbotResult(principal.keyId, taskId, typeof output === "string" ? output : JSON.stringify(output)),
  );

  registerScopedTool(
    server,
    "fail_ai_task",
    {
      title: "Give up on an AI task",
      description: "Mark a claimed task as unanswerable (e.g. the prompt is truncated). The run treats it like a failed Codex call and retries or skips it.",
      inputSchema: z.object({
        taskId: z.string().min(1),
        reason: z.string().min(1).max(500),
      }),
    },
    "ai:work",
    async ({ taskId, reason }, principal) => failGrokbotTask(principal.keyId, taskId, reason),
  );
}
