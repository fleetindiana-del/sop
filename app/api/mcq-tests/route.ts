import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import MCQBank from "@/models/MCQBank";
import MCQBankTestResult from "@/models/MCQBankTestResult";
import { withActivityLog } from "@/lib/activity-log";

export const dynamic = "force-dynamic";

function calcGrade(score: number): "A+" | "A" | "B+" | "B" | "C" | "D" | "F" {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "B+";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 60) return "D";
  return "F";
}

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId") || "";

    const banks = await MCQBank.find({ isObsolete: { $ne: true } })
      .select("sopName sopIdentifier totalQuestions difficultyDistribution department language")
      .sort({ createdAt: -1 })
      .lean();

    const results = userId
      ? await MCQBankTestResult.find({ userId })
          .select("mcqBankId score isPassed grade attemptNumber completedAt")
          .sort({ completedAt: -1 })
          .lean()
      : [];

    const resultsByBank = new Map<string, any[]>();
    for (const r of results) {
      const key = r.mcqBankId.toString();
      if (!resultsByBank.has(key)) resultsByBank.set(key, []);
      resultsByBank.get(key)!.push(r);
    }

    const mcqBanks = banks.map((bank) => {
      const id = (bank as any)._id.toString();
      const attempts = resultsByBank.get(id) || [];
      const bestScore = attempts.length ? Math.max(...attempts.map((a: any) => a.score)) : null;
      return { ...bank, attempts, totalAttempts: attempts.length, bestScore };
    });

    return NextResponse.json({ success: true, mcqBanks });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}

async function handlePOST(request: NextRequest) {
  try {
    await connectDB();
    const body = await request.json();
    const { userId, mcqBankId, answers, timeTaken, startedAt, testName, username, userFullName } = body;

    if (!userId || !mcqBankId || !Array.isArray(answers)) {
      return NextResponse.json(
        { success: false, error: "userId, mcqBankId, and answers[] are required" },
        { status: 400 },
      );
    }

    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    // Use native driver to avoid stripping subdoc flags
    const bankDoc = await db
      .collection("mcqbanks")
      .findOne({ _id: new mongoose.Types.ObjectId(mcqBankId) });

    if (!bankDoc) {
      return NextResponse.json({ success: false, error: "MCQ bank not found" }, { status: 404 });
    }

    const attemptNumber =
      (await MCQBankTestResult.countDocuments({ userId, mcqBankId })) + 1;

    const diffBreak = {
      easy: { correct: 0, total: 0 },
      medium: { correct: 0, total: 0 },
      hard: { correct: 0, total: 0 },
    };
    const questions: any[] = [];
    let correct = 0;
    let skipped = 0;

    for (const answer of answers) {
      const mcq = (bankDoc.mcqs as any[])[answer.questionIndex];
      if (!mcq) continue;

      const isSkipped = !answer.selectedAnswer;
      const isCorrect = !isSkipped && answer.selectedAnswer === mcq.correctAnswer;
      if (isSkipped) skipped++;
      if (isCorrect) correct++;

      const diff = (mcq.difficulty as string).toLowerCase() as "easy" | "medium" | "hard";
      if (diffBreak[diff]) {
        diffBreak[diff].total++;
        if (isCorrect) diffBreak[diff].correct++;
      }

      questions.push({
        questionIndex: answer.questionIndex,
        question: mcq.question,
        aiIcon: mcq.aiIcon || "❓",
        difficulty: mcq.difficulty,
        difficultyStars: mcq.difficultyStars,
        options: mcq.options,
        selectedAnswer: answer.selectedAnswer || "",
        correctAnswer: mcq.correctAnswer,
        isCorrect,
        explanation: mcq.explanation || "",
        sopReference: mcq.sopReference || "",
      });
    }

    const total = questions.length;
    const score = total > 0 ? Math.round((correct / total) * 100) : 0;

    const result = await MCQBankTestResult.create({
      userId,
      username: username || userId,
      userFullName: userFullName || username || userId,
      mcqBankId,
      sopName: bankDoc.sopName,
      sopIdentifier: bankDoc.sopIdentifier,
      testName: testName || "Test",
      questions,
      totalQuestions: total,
      correctAnswers: correct,
      incorrectAnswers: total - correct - skipped,
      skippedQuestions: skipped,
      score,
      grade: calcGrade(score),
      isPassed: score >= 70,
      passingScore: 70,
      difficultyBreakdown: diffBreak,
      timeTaken: timeTaken || 0,
      startedAt: startedAt ? new Date(startedAt) : new Date(),
      completedAt: new Date(),
      attemptNumber,
    });

    return NextResponse.json({ success: true, testResult: result }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to save result" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
