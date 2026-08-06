import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import MCQReview from "@/models/MCQReview";

export const dynamic = "force-dynamic";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const { id } = await params;
    const body = await request.json();
    const { reviewStatus, markedDoneBy, editedQuestion, editedBy } = body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
    }

    const update: Record<string, any> = {};
    if (reviewStatus) update.reviewStatus = reviewStatus;
    if (reviewStatus === "done") {
      update.markedDoneBy = markedDoneBy || "unknown";
      update.markedDoneAt = new Date();
    }
    if (editedQuestion) {
      update.editedQuestion = editedQuestion;
      update.editedBy = editedBy || "unknown";
      update.editedAt = new Date();
    }

    const review = await MCQReview.findByIdAndUpdate(id, { $set: update }, { returnDocument: 'after' });
    if (!review) {
      return NextResponse.json({ success: false, error: "Review not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true, review });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await connectDB();
    const { id } = await params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ success: false, error: "Invalid id" }, { status: 400 });
    }
    await MCQReview.findByIdAndDelete(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
