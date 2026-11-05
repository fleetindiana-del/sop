import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import MCQReview from "@/models/MCQReview";
import { withActivityLog } from "@/lib/activity-log";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const sopId = searchParams.get("sopId");

    const filter: Record<string, any> = {};
    if (status) filter.reviewStatus = status;
    if (sopId) {
      try {
        filter.sopId = new mongoose.Types.ObjectId(sopId);
      } catch {
        filter.sopIdentifier = sopId;
      }
    }

    const reviews = await MCQReview.find(filter).sort({ flaggedAt: -1 }).lean();
    return NextResponse.json({ success: true, reviews });
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
    const { mcqBankId, questionIndex, sopId, sopName, sopIdentifier, question, flaggedBy, reviewNotes } =
      body;

    if (!mcqBankId || questionIndex === undefined || !question) {
      return NextResponse.json(
        { success: false, error: "mcqBankId, questionIndex, and question are required" },
        { status: 400 },
      );
    }

    const existing = await MCQReview.findOne({
      originalMcqBankId: new mongoose.Types.ObjectId(mcqBankId),
      originalQuestionIndex: questionIndex,
    });

    if (existing) {
      return NextResponse.json({
        success: true,
        alreadyFlagged: true,
        message: "This question has already been flagged for review.",
        review: existing,
      });
    }

    // sopId may not always be a valid ObjectId (could be a string identifier)
    let sopObjectId: mongoose.Types.ObjectId | undefined;
    try {
      if (sopId) sopObjectId = new mongoose.Types.ObjectId(sopId);
    } catch {
      // non-fatal
    }

    const review = await MCQReview.create({
      originalMcqBankId: new mongoose.Types.ObjectId(mcqBankId),
      originalQuestionIndex: questionIndex,
      ...(sopObjectId ? { sopId: sopObjectId } : {}),
      sopName: sopName || "",
      sopIdentifier: sopIdentifier || "",
      originalQuestion: question,
      flaggedBy: flaggedBy || "anonymous",
      reviewNotes: reviewNotes || "",
      flaggedAt: new Date(),
    });

    return NextResponse.json({ success: true, review }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to flag question" },
      { status: 500 },
    );
  }
}

export const POST = withActivityLog(handlePOST);
