import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireAuth, forbidUnlessDepartmentAccess } from "@/lib/withAuth";
import { mcqResolveDept } from "@/lib/mcq-bank-utils";

// POST /api/mcq-bank/edit-question
// Body: { bankId, questionIndex, question, options, correctAnswer, explanation }
export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    const body = await request.json();
    const { bankId, questionIndex, question, options, correctAnswer, explanation } = body;

    if (
      !bankId ||
      typeof questionIndex !== "number" ||
      typeof question !== "string" ||
      !Array.isArray(options) ||
      typeof correctAnswer !== "string"
    ) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }

    if (question.trim().length === 0) {
      return NextResponse.json({ error: "Question text cannot be empty" }, { status: 400 });
    }

    if (options.length < 2) {
      return NextResponse.json({ error: "At least 2 options required" }, { status: 400 });
    }

    const col = db.collection("mcqbanks");
    const existing = await col.findOne(
      { _id: new mongoose.Types.ObjectId(bankId) },
      { projection: { sopIdentifier: 1, department: 1 } },
    );
    if (!existing) {
      return NextResponse.json({ error: "Bank not found" }, { status: 404 });
    }
    const denied = forbidUnlessDepartmentAccess(
      auth.session.user.role,
      auth.session.user.department,
      mcqResolveDept(String(existing.sopIdentifier ?? ""), String(existing.department ?? "")),
    );
    if (denied) return denied;

    const result = await col.updateOne(
      { _id: new mongoose.Types.ObjectId(bankId) },
      {
        $set: {
          [`mcqs.${questionIndex}.question`]:     question.trim(),
          [`mcqs.${questionIndex}.options`]:      options,
          [`mcqs.${questionIndex}.correctAnswer`]: correctAnswer,
          [`mcqs.${questionIndex}.explanation`]:  explanation ?? "",
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return NextResponse.json({ error: "Bank not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, questionIndex });
  } catch (error) {
    console.error("[edit-question] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save" },
      { status: 500 },
    );
  }
}
