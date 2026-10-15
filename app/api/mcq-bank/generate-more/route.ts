import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import MCQBank from "@/models/MCQBank";
import SOP from "@/models/SOP";
import { generateJson } from "@/lib/gemini";
import { appendGeneratedToBank, MCQ_BANK_CAP, type BankInputMcq } from "@/lib/mcq-bank-write";
import { MCQ_REPLACE_SYSTEM } from "@/lib/mcq-generation-prompts";
import { MCQ_CONTENT_LIMIT, mcqPromptSopExcerpt } from "@/lib/mcq-source-text";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { requireAuth } from "@/lib/withAuth";
import { sopIdentifierEquivalentRegex } from "@/lib/sopIdentifierNormalize";

const REPLACE_PROMPT = MCQ_REPLACE_SYSTEM;

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { identifier, language = "English", count = 3 } = await request.json();
    if (!identifier) {
      return NextResponse.json({ error: "identifier required" }, { status: 400 });
    }

    const sop = await SOP.findOne({
      identifier: sopIdentifierEquivalentRegex(identifier),
      language,
    });
    if (!sop) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }

    // Only send a small recent sample of existing questions as "avoid" context —
    // sending the entire bank (often 100+) bloated input tokens and slowed every
    // call. appendGeneratedToBank still dedups against the full bank locally, so
    // uniqueness is guaranteed regardless of what the model sees.
    const existingBank = await MCQBank.findOne({ sopId: sop._id, language, isObsolete: { $ne: true } })
      .select("mcqs.question")
      .lean();
    const bankSize = existingBank?.mcqs?.length ?? 0;
    if (bankSize >= MCQ_BANK_CAP) {
      return NextResponse.json(
        { error: `Bank already has the maximum of ${MCQ_BANK_CAP} MCQs` },
        { status: 400 },
      );
    }
    const room = MCQ_BANK_CAP - bankSize;
    const askCount = Math.min(Number(count) || 3, room);

    const excluded = (existingBank?.mcqs ?? [])
      .slice(-20)
      .map((m) => m.question)
      .join("\n- ");

    const excerpt = mcqPromptSopExcerpt(sop.content, 0, MCQ_CONTENT_LIMIT);
    const result = await generateJson<{ questions: BankInputMcq[] }>(
      REPLACE_PROMPT,
      `SOP text:\n${excerpt}\n\nAvoid repeating:\n- ${excluded}\n\nGenerate ${askCount} new unique questions in ${language}.`,
      { maxAttempts: 2, fastFail503: true },
    );

    // appendGeneratedToBank dedups against the existing bank before appending.
    const { inserted, total } = await appendGeneratedToBank(sop, language, result.questions ?? []);

    await SOP.updateMany({ identifier, language }, { mcqCount: total });
    invalidateDashboardSopsCache();

    return NextResponse.json({ replaced: inserted, mcqCount: total });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Generate more failed" },
      { status: 500 },
    );
  }
}
