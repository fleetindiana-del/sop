import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import { enqueueMcqGeneration, parseMcqLanguage, canStartCodexMcqHere } from "@/lib/mcq-generation";
import { runWithAgentBackend } from "@/lib/agent-backend";
import { withActivityLog } from "@/lib/activity-log";

// Kick off generation in the background and return immediately. The previous
// implementation awaited the full dual-language run (up to 16+ Gemini calls plus
// retries), which routinely blew past the HTTP timeout. The client now polls
// GET /api/sop/generate-mcqs/status?identifier=… for live progress.
async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const identifier = body.identifier?.trim();
    if (!identifier) {
      return NextResponse.json({ error: "identifier is required" }, { status: 400 });
    }
    const p = body.provider;
    // GrokBot runs the Codex pipeline; it answers the prompts via the AI task queue.
    const viaGrokbot = p === "grokbot";
    const provider =
      p === "ollama" ? "ollama" :
      p === "gemini" ? "gemini" :
      p === "codex" || viaGrokbot ? "codex" :
      "claude";
    const modeOverride = body.mode === "continue" ? "continue" : undefined;
    const languageScope = parseMcqLanguage(body.language);

    const startWorker =
      provider !== "codex" ? true :
      viaGrokbot ? !process.env.VERCEL :
      await runWithAgentBackend("codex", canStartCodexMcqHere);

    const job = await enqueueMcqGeneration(identifier, provider, modeOverride, languageScope, {
      startWorker,
      agentBackend: viaGrokbot ? "grokbot" : provider === "codex" ? "codex" : undefined,
    });
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    console.error("POST /api/sop/generate-mcqs error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MCQ generation failed" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
