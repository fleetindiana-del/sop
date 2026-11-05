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

function reshuffleOptions(q: any): any {
  const shuffled = [...q.options].sort(() => 0.5 - Math.random());
  return { ...q, options: shuffled };
}

async function handlePOST(request: NextRequest) {
  try {
    const body = await request.json();
    const { mode, difficulty, sopId, bankId, questionCount = 20 } = body;

    if (!sopId && !bankId) {
      return NextResponse.json({ error: "sopId or bankId is required" }, { status: 400 });
    }

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    const bankFilter: Record<string, any> = { isObsolete: { $ne: true } };
    if (bankId) {
      bankFilter._id = new mongoose.Types.ObjectId(bankId);
    } else {
      bankFilter.sopId = new mongoose.Types.ObjectId(sopId);
    }

    const banks = await db.collection("mcqbanks").find(bankFilter).toArray();

    if (banks.length === 0) {
      return NextResponse.json({ error: "No MCQ bank found for this SOP" }, { status: 404 });
    }

    let pool: any[] = [];
    for (const bank of banks) {
      const mcqs: any[] = (bank.mcqs as any[]) || [];
      for (let i = 0; i < mcqs.length; i++) {
        if (mode === "manual" && difficulty && difficulty !== "Any") {
          if (mcqs[i].difficulty !== difficulty) continue;
        }
        pool.push(enrichQuestion(mcqs[i], bank, i));
      }
    }

    if (pool.length === 0) {
      return NextResponse.json({ error: "No questions match the selected criteria" }, { status: 404 });
    }

    pool = await applyEditsToMCQs(pool);
    pool = pool.sort(() => 0.5 - Math.random());

    // Reinforcement cycling: repeat pool until questionCount is reached
    const result: any[] = [];
    let passNumber = 0;
    while (result.length < questionCount) {
      const needed = questionCount - result.length;
      const isReinforcement = passNumber > 0;

      // Re-shuffle pool order for each reinforcement pass
      const pass = pool.sort(() => 0.5 - Math.random()).slice(0, needed);

      for (const q of pass) {
        if (isReinforcement) {
          result.push({ ...reshuffleOptions(q), isReinforcement: true });
        } else {
          result.push(q);
        }
      }

      if (pool.length === 0) break;
      passNumber++;
      if (result.length >= questionCount) break;
    }

    return NextResponse.json({
      success: true,
      questions: result,
      totalAvailable: pool.length,
      isTargeted: true,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
