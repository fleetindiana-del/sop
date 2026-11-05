import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { applyEditsToMCQs } from "@/lib/mcqReviewHelper";
import { withActivityLog } from "@/lib/activity-log";

export const dynamic = "force-dynamic";

function enrichQuestion(mcq: any, bank: any, idx: number) {
  return {
    ...mcq,
    mcqBankId: bank._id.toString(),
    questionIndex: idx,
    sopName: bank.sopName,
    sopIdentifier: bank.sopIdentifier,
    _id: bank.sopId?.toString() || bank._id.toString(),
  };
}

async function handlePOST(request: NextRequest) {
  try {
    const body = await request.json();
    const { mode, difficulty, sopIds, bankIds, questionCount = 20 } = body;

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    const bankFilter: Record<string, any> = { isObsolete: { $ne: true } };
    if (mode === "manual") {
      const ids = bankIds?.length ? bankIds : sopIds;
      if (Array.isArray(ids) && ids.length > 0) {
        const objectIds = ids.map((id: string) => new mongoose.Types.ObjectId(id));
        if (bankIds?.length) {
          bankFilter._id = { $in: objectIds };
        } else {
          bankFilter.sopId = { $in: objectIds };
        }
      }
    }

    const banks = await db.collection("mcqbanks").find(bankFilter).toArray();

    if (banks.length === 0) {
      return NextResponse.json({ error: "No MCQ banks found" }, { status: 404 });
    }

    let allQuestions: any[] = [];
    for (const bank of banks) {
      const mcqs: any[] = (bank.mcqs as any[]) || [];
      for (let i = 0; i < mcqs.length; i++) {
        if (mode === "manual" && difficulty && difficulty !== "Any") {
          if (mcqs[i].difficulty !== difficulty) continue;
        }
        allQuestions.push(enrichQuestion(mcqs[i], bank, i));
      }
    }

    allQuestions = await applyEditsToMCQs(allQuestions);
    allQuestions = allQuestions.sort(() => 0.5 - Math.random()).slice(0, questionCount);

    return NextResponse.json({
      success: true,
      questions: allQuestions,
      totalAvailable: allQuestions.length,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
