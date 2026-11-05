import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
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
    const { sopIds } = body;

    if (!sopIds || !Array.isArray(sopIds) || sopIds.length === 0) {
      return NextResponse.json({ error: "sopIds array required (min 1)" }, { status: 400 });
    }

    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    const objectIds = sopIds.map((id: string) => new mongoose.Types.ObjectId(id));
    const banks = await db
      .collection("mcqbanks")
      .find({ sopId: { $in: objectIds }, isObsolete: { $ne: true } })
      .toArray();

    if (banks.length === 0) {
      return NextResponse.json({ error: "No MCQ banks found for the given SOPs" }, { status: 404 });
    }

    let allQuestions: any[] = [];
    for (const bank of banks) {
      const mcqs = (bank.mcqs as any[]) || [];
      for (let i = 0; i < mcqs.length; i++) {
        allQuestions.push(enrichQuestion(mcqs[i], bank, i));
      }
    }

    allQuestions = allQuestions.sort(() => 0.5 - Math.random()).slice(0, 20);

    return NextResponse.json({ success: true, questions: allQuestions, totalAvailable: allQuestions.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
