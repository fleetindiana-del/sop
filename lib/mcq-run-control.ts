import type { ChildProcess } from "child_process";
import { normalizeSopIdentifierKey } from "@/lib/sopIdentifierNormalize";

const cancelledKeys = new Set<string>();
/** Child processes spawned by local CLI providers (e.g. Claude Code) — killed on cancel.
 *  A run can have several in flight at once (parallel translation batches), so every
 *  live process is tracked, not just the most recent one. */
const subprocessProcs = new Map<string, Set<ChildProcess>>();

function killProcs(key: string): void {
  for (const proc of subprocessProcs.get(key) ?? []) {
    if (proc.killed) continue;
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }
}
const runControllers = new Map<string, AbortController>();

/** Canonical key so PRCL17-05 and PRCL17-5 share one run/cancel slot. */
export function mcqRunKey(identifier: string): string {
  return normalizeSopIdentifierKey(identifier.trim());
}

export function beginMcqRun(identifier: string): AbortController {
  const key = mcqRunKey(identifier);
  cancelledKeys.delete(key);
  runControllers.get(key)?.abort();
  const ac = new AbortController();
  runControllers.set(key, ac);
  return ac;
}

export function endMcqRun(identifier: string): void {
  const key = mcqRunKey(identifier);
  cancelledKeys.delete(key);
  runControllers.delete(key);
  killProcs(key);
  subprocessProcs.delete(key);
}

/** In-process stop: flag + abort signal + kill CLI subprocess if running. */
export function requestMcqRunStop(identifier: string): void {
  const key = mcqRunKey(identifier);
  cancelledKeys.add(key);
  runControllers.get(key)?.abort();
  killProcs(key);
}

export function isMcqRunStopRequested(identifier: string): boolean {
  return cancelledKeys.has(mcqRunKey(identifier));
}

export function getMcqRunSignal(identifier: string): AbortSignal | undefined {
  return runControllers.get(mcqRunKey(identifier))?.signal;
}

/** True while this identifier has an active in-process MCQ run (not just a DB row). */
export function isMcqRunActiveInProcess(identifier: string): boolean {
  return runControllers.has(mcqRunKey(identifier));
}

export function registerMcqSubprocess(identifier: string, proc: ChildProcess): void {
  const key = mcqRunKey(identifier);
  const set = subprocessProcs.get(key) ?? new Set<ChildProcess>();
  set.add(proc);
  subprocessProcs.set(key, set);
}

export function unregisterMcqSubprocess(identifier: string, proc?: ChildProcess): void {
  const key = mcqRunKey(identifier);
  const set = subprocessProcs.get(key);
  if (!set) return;
  // Without a handle the caller cannot say which sibling finished; only clear the
  // slot when it is the last one, so a parallel batch is never untracked early.
  if (proc) set.delete(proc);
  else if (set.size <= 1) set.clear();
  if (set.size === 0) subprocessProcs.delete(key);
}

/** @deprecated Use registerMcqSubprocess */
export const registerMcqClaudeProc = registerMcqSubprocess;
/** @deprecated Use unregisterMcqSubprocess */
export const unregisterMcqClaudeProc = unregisterMcqSubprocess;

/** Emergency: stop every in-process MCQ run (dev server). */
export function requestStopAllMcqRuns(): void {
  for (const key of new Set([...runControllers.keys(), ...subprocessProcs.keys(), ...cancelledKeys])) {
    requestMcqRunStop(key);
  }
}
