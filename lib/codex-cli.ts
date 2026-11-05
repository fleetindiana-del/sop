import { spawn } from "child_process";
import { errorMessage, extractJsonPayload, isJsonParseError, sleep } from "@/lib/llm-utils";
import {
  registerComplianceSubprocess,
  unregisterComplianceSubprocess,
} from "@/lib/compliance-run-control";
import { registerMcqSubprocess, unregisterMcqSubprocess } from "@/lib/mcq-run-control";
import { parseMcqBatchJson, type ParsedMcq } from "@/lib/mcq-json-parse";
import { currentAgentBackend } from "@/lib/agent-backend";
import { runGrokbotPrompt } from "@/lib/grokbot-llm";

const CODEX_CLI_TIMEOUT_MS = Number(process.env.CODEX_CLI_TIMEOUT_MS) || 300_000;
const CODEX_CLI_MAX_ATTEMPTS = Number(process.env.CODEX_CLI_MAX_ATTEMPTS) || 2;

/** Codex model for structured batches (ChatGPT subscription — no API key).
 *  Must be a model the ChatGPT plan exposes to Codex: API-only ids (gpt-4.1) and
 *  the mini tiers (gpt-5.4-mini) are rejected with a 400 "not supported when using
 *  Codex with a ChatGPT account". */
const DEFAULT_MCQ_CODEX_MODEL = "gpt-5.6-sol";

export function getMcqCodexModel(): string {
  return process.env.MCQ_CODEX_MODEL ?? DEFAULT_MCQ_CODEX_MODEL;
}

/** Compliance Codex model — must be supported on ChatGPT subscription (gpt-4.1 is API-only). */
export function getComplianceCodexModel(): string {
  return process.env.COMPLIANCE_CODEX_MODEL ?? DEFAULT_MCQ_CODEX_MODEL;
}

export interface CodexCliHealth {
  ok: boolean;
  model: string;
  loggedIn: boolean;
  authMode?: string;
  codexVersion?: string;
  error?: string;
}

type DoctorCheck = {
  status?: string;
  summary?: string;
  details?: Record<string, string>;
};

type DoctorReport = {
  overallStatus?: string;
  codexVersion?: string;
  checks?: Record<string, DoctorCheck>;
};

/** Verify local Codex CLI is installed and logged in (ChatGPT subscription). */
export async function checkCodexCliHealth(): Promise<CodexCliHealth> {
  const model = getMcqCodexModel();
  if (currentAgentBackend() === "grokbot") {
    return { ok: true, model: "grokbot", loggedIn: true, authMode: "GrokBot via MCP task queue" };
  }
  try {
    const { stdout, code } = await runCodex(["doctor", "--json"], undefined, 30_000);

    let report: DoctorReport;
    try {
      report = JSON.parse(stdout) as DoctorReport;
    } catch {
      return {
        ok: false,
        model,
        loggedIn: false,
        error:
          code !== 0
            ? `codex doctor exited with code ${code}`
            : "codex doctor returned invalid JSON",
      };
    }

    const auth = report.checks?.["auth.credentials"];
    const install = report.checks?.installation;
    const authOk = auth?.status === "ok";
    const installOk = install?.status === "ok";

    if (!installOk) {
      return {
        ok: false,
        model,
        loggedIn: false,
        codexVersion: report.codexVersion,
        error: install?.summary ?? "Codex CLI is not installed. Run: npm install -g @openai/codex",
      };
    }

    if (!authOk) {
      return {
        ok: false,
        model,
        loggedIn: false,
        codexVersion: report.codexVersion,
        error: auth?.summary ?? "Not logged in. Run: codex login",
      };
    }

    return {
      ok: true,
      model,
      loggedIn: true,
      authMode: auth?.details?.["stored auth mode"],
      codexVersion: report.codexVersion,
    };
  } catch (error) {
    return {
      ok: false,
      model,
      loggedIn: false,
      error: errorMessage(error),
    };
  }
}

export type CodexCliJsonOptions = {
  runKey?: string;
  signal?: AbortSignal;
  subprocessScope?: "mcq" | "compliance";
};

function registerCliSubprocess(
  runKey: string | undefined,
  proc: import("child_process").ChildProcess,
  scope: "mcq" | "compliance" = "mcq",
): void {
  if (!runKey) return;
  if (scope === "compliance") registerComplianceSubprocess(runKey, proc);
  else registerMcqSubprocess(runKey, proc);
}

function unregisterCliSubprocess(
  runKey: string | undefined,
  scope: "mcq" | "compliance" = "mcq",
  proc?: import("child_process").ChildProcess,
): void {
  if (!runKey) return;
  if (scope === "compliance") unregisterComplianceSubprocess(runKey);
  else unregisterMcqSubprocess(runKey, proc);
}

function codexSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.TERM || env.TERM === "dumb") env.TERM = "xterm-256color";
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  return env;
}

function runCodex(
  args: string[],
  stdin?: string,
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("codex", args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      env: codexSpawnEnv(),
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Codex CLI timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Failed to start Codex CLI: ${err.message}. ` +
            "Install with: npm install -g @openai/codex, then run: codex login",
        ),
      );
    });

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });

    if (stdin !== undefined) {
      proc.stdin.write(stdin, "utf8");
    }
    proc.stdin.end();
  });
}

const MCQ_JSON_RETRY =
  "\n\nIMPORTANT: Your last reply had no usable questions. Return ONLY raw JSON. Each question needs explanation (why the correct option is right) and sopReference (SOP quote). correctAnswer = A, B, C, or D.";

const FACT_JSON_RETRY =
  '\n\nIMPORTANT: Return ONLY raw JSON — no markdown. Use {"facts":[{"id":"F001","topic":"...","fact":"..."}]} with at least 10 facts.';

function isMcqEmptyError(error: unknown): boolean {
  const msg = errorMessage(error).toLowerCase();
  return isJsonParseError(error) || msg.includes("no usable") || msg.includes("empty");
}

function extractCodexStdout(text: string): string {
  return extractJsonPayload(text);
}
function wrapMcqCodexPrompt(system: string, user: string): string {
  return `${system}

${user}

Respond with ONLY raw JSON — no markdown fences or commentary.`;
}

const CODEX_USAGE_LIMIT_PREFIX = "Codex usage limit reached";
const CODEX_USAGE_LIMIT_RECHECK_MS = 10 * 60_000;
let codexUsageLimit: { message: string; checkedAt: number } | null = null;

/** True when the ChatGPT account behind `codex login` has no Codex quota left. */
export function isCodexUsageLimitError(error: unknown): boolean {
  return errorMessage(error).includes(CODEX_USAGE_LIMIT_PREFIX);
}

async function runCodexExecPrompt(
  prompt: string,
  model: string,
  options?: CodexCliJsonOptions,
  label = "codex",
): Promise<string> {
  if (currentAgentBackend() === "grokbot") {
    return runGrokbotPrompt(prompt, {
      kind: options?.subprocessScope === "compliance" ? "compliance" : "mcq",
      label,
      runKey: options?.runKey,
      signal: options?.signal,
    });
  }
  // Quota is account-wide: once hit, fail instantly instead of spawning hundreds of
  // doomed `codex exec` processes (each burns minutes on "Reconnecting... 5/5").
  if (codexUsageLimit && Date.now() - codexUsageLimit.checkedAt < CODEX_USAGE_LIMIT_RECHECK_MS) {
    throw new Error(codexUsageLimit.message);
  }
  return new Promise<string>((resolve, reject) => {
    const args = [
      "exec",
      // User config starts MCP servers (including a local one that is often down).
      // A failed MCP handshake aborts the whole exec before any JSON is returned.
      "--ignore-user-config",
      "-m",
      model,
      "-s",
      "read-only",
      "--ephemeral",
      "--dangerously-bypass-approvals-and-sandbox",
      "-",
    ];

    const proc = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], shell: true, env: codexSpawnEnv() });

    if (options?.runKey) registerCliSubprocess(options.runKey, proc, options.subprocessScope);

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (options?.runKey) unregisterCliSubprocess(options.runKey, options.subprocessScope, proc);
      fn();
    };

    const onAbort = () => {
      try {
        if (process.platform === "win32" && proc.pid) {
          spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { shell: true, stdio: "ignore" });
        } else {
          proc.kill();
        }
      } catch {
        /* ignore */
      }
      finish(() => reject(new Error("Generation cancelled")));
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      try {
        if (process.platform === "win32" && proc.pid) {
          spawn("taskkill", ["/F", "/T", "/PID", String(proc.pid)], { shell: true, stdio: "ignore" });
        } else {
          proc.kill();
        }
      } catch {
        /* ignore */
      }
      finish(() =>
        reject(
          new Error(
            `Codex CLI timed out after ${CODEX_CLI_TIMEOUT_MS / 1000}s (model: ${model}). ` +
              "Increase CODEX_CLI_TIMEOUT_MS in .env.local.",
          ),
        ),
      );
    }, CODEX_CLI_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err: Error) => {
      finish(() => reject(new Error(`Failed to start Codex CLI: ${err.message}`)));
    });

    proc.on("close", (code: number | null) => {
      if (options?.signal) options.signal.removeEventListener("abort", onAbort);
      if (code !== 0) {
        const limit = stderr.match(/You've hit your usage limit[^\r\n]*/i)?.[0];
        if (limit) {
          const message = `${CODEX_USAGE_LIMIT_PREFIX}: ${limit.slice(0, 300)}`;
          codexUsageLimit = { message, checkedAt: Date.now() };
          finish(() => reject(new Error(message)));
          return;
        }
        const apiErr = stderr.match(/ERROR:\s*(\{[\s\S]*?\})(?=\nERROR:|\n*$)/)?.[1];
        let detail = stderr.trim();
        if (apiErr) {
          try {
            const parsed = JSON.parse(apiErr) as { error?: { message?: string } };
            if (parsed.error?.message) detail = parsed.error.message;
          } catch {
            detail = apiErr.slice(0, 400);
          }
        } else {
          detail = stderr.slice(-800) || stdout.slice(-400) || `exit code ${code}`;
        }
        finish(() => reject(new Error(`Codex CLI exited with code ${code}: ${detail}`)));
      } else {
        finish(() => resolve(stdout.trim()));
      }
    });

    proc.stdin.write(prompt, "utf8");
    proc.stdin.end();
  });
}

/** Codex CLI for arbitrary JSON tasks (fact extraction, etc.). */
export async function generateCodexCliJson<T>(
  system: string,
  user: string,
  parse: (text: string) => T,
  label: string,
  modelOverride?: string,
  options?: CodexCliJsonOptions,
): Promise<T> {
  const model = modelOverride ?? getMcqCodexModel();
  let lastError: unknown;
  let userBlock = user;

  for (let attempt = 0; attempt < CODEX_CLI_MAX_ATTEMPTS + 1; attempt++) {
    if (options?.signal?.aborted) throw new Error("Generation cancelled");
    try {
      const prompt = wrapMcqCodexPrompt(system, userBlock);
      const raw = await runCodexExecPrompt(prompt, model, options, label);
      const text = extractCodexStdout(raw);
      return parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < CODEX_CLI_MAX_ATTEMPTS && isMcqEmptyError(error)) {
        userBlock =
          user +
          (label.includes("fact")
            ? FACT_JSON_RETRY
            : "\n\nIMPORTANT: Return ONLY raw JSON. No markdown fences or commentary.");
        await sleep(2000);
        continue;
      }
      throw new Error(
        `Codex (${model}) ${label} failed: ${errorMessage(lastError).slice(0, 220)}`,
      );
    }
  }

  throw lastError ?? new Error(`Codex CLI ${label} request failed`);
}

/** Codex CLI for MCQ batches — uses local ChatGPT subscription via `codex exec`. */
export async function generateCodexCliMcqBatch(
  system: string,
  user: string,
  modelOverride?: string,
  options?: CodexCliJsonOptions,
): Promise<ParsedMcq[]> {
  const model = modelOverride ?? getMcqCodexModel();
  let lastError: unknown;
  let userBlock = user;

  for (let attempt = 0; attempt < CODEX_CLI_MAX_ATTEMPTS + 1; attempt++) {
    if (options?.signal?.aborted) throw new Error("Generation cancelled");
    try {
      const prompt = wrapMcqCodexPrompt(system, userBlock);
      const raw = await runCodexExecPrompt(prompt, model, options, "MCQ batch");
      const text = extractCodexStdout(raw);
      const questions = parseMcqBatchJson(text, "codex-cli-mcq");
      if (questions.length === 0) throw new SyntaxError("No usable MCQs in Codex response");
      return questions;
    } catch (error) {
      lastError = error;
      if (attempt < CODEX_CLI_MAX_ATTEMPTS && isMcqEmptyError(error)) {
        userBlock = user + MCQ_JSON_RETRY;
        await sleep(2000);
        continue;
      }
      throw new Error(
        `Codex (${model}) MCQ batch failed: ${errorMessage(lastError).slice(0, 220)}`,
      );
    }
  }

  throw lastError ?? new Error("Codex CLI MCQ request failed");
}
