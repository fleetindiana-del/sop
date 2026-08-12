import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import { enqueueMcqGeneration, parseMcqLanguage } from "@/lib/mcq-generation";

// Kick off generation in the background and return immediately. The previous
// implementation awaited the full dual-language run (up to 16+ Gemini calls plus
// retries), which routinely blew past the HTTP timeout. The client now polls
// GET /api/sop/generate-mcqs/status?identifier=… for live progress.
export async function POST(request: NextRequest) {
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
    const provider =
      p === "ollama" ? "ollama" :
      p === "gemini" ? "gemini" :
      p === "codex" ? "codex" :
      "claude";
    const modeOverride = body.mode === "continue" ? "continue" : undefined;
    const languageScope = parseMcqLanguage(body.language);

    const job = await enqueueMcqGeneration(identifier, provider, modeOverride, languageScope);
    return NextResponse.json(job, { status: 202 });
  } catch (error) {
    console.error("POST /api/sop/generate-mcqs error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "MCQ generation failed" },
      { status: 500 },
    );
  }
}
