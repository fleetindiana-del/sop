import { AsyncLocalStorage } from "async_hooks";

/**
 * Who answers prompts that the pipelines send down the Codex path:
 * the local `codex` CLI, or GrokBot through the MCP AI-task queue.
 */
export type AgentBackend = "codex" | "grokbot";

const backendStore = new AsyncLocalStorage<AgentBackend>();

/** Machine-wide default; CODEX_BACKEND=grokbot sends every Codex call to GrokBot. */
function defaultAgentBackend(): AgentBackend {
  return process.env.CODEX_BACKEND?.trim().toLowerCase() === "grokbot" ? "grokbot" : "codex";
}

export function currentAgentBackend(): AgentBackend {
  return backendStore.getStore() ?? defaultAgentBackend();
}

/** Runs `fn` (and everything it awaits) with the given backend. */
export function runWithAgentBackend<T>(backend: AgentBackend, fn: () => T): T {
  return backendStore.run(backend, fn);
}

export function parseAgentBackend(value: unknown): AgentBackend | undefined {
  return value === "grokbot" || value === "codex" ? value : undefined;
}
