import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { withActivityLog } from "@/lib/activity-log";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    const ids = searchParams.get("ids");
    const sopId = searchParams.get("sopId");
    const identifier = searchParams.get("identifier");
    const difficulty = searchParams.get("difficulty");
    const folderDept = searchParams.get("folderDepartment");
    const folderSub = searchParams.get("folderSubcategory");
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
    const limit = Math.min(1000, Math.max(1, parseInt(searchParams.get("limit") || "10", 10)));
    const summary = searchParams.get("summary") === "true";
    const includeObsolete = searchParams.get("includeObsolete") === "1";

    const col = db.collection("mcqbanks");

    const filter: Record<string, any> = {};
    if (!includeObsolete) filter.isObsolete = { $ne: true };
    if (id) {
      filter._id = new mongoose.Types.ObjectId(id);
    } else if (ids) {
      const idList = ids
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      filter._id = { $in: idList.map((s) => new mongoose.Types.ObjectId(s)) };
    }
    if (sopId) filter.sopId = new mongoose.Types.ObjectId(sopId);
    if (identifier) filter.sopIdentifier = identifier;
    if (folderDept) filter.folderDepartment = folderDept;
    if (folderSub) filter.folderSubcategory = folderSub;

    if (summary) {
      const pipeline: object[] = [
        { $match: filter },
        { $sort: { createdAt: -1 } },
        {
          $project: {
            sopId: 1,
            sopIdentifier: 1,
            sopName: 1,
            department: 1,
            folderDepartment: 1,
            folderSubcategory: 1,
            language: 1,
            createdAt: 1,
            difficultyDistribution: 1,
            totalQuestions: { $size: { $ifNull: ["$mcqs", []] } },
            checkedCount: {
              $size: {
                $filter: {
                  input: { $ifNull: ["$mcqs", []] },
                  as: "q",
                  cond: { $eq: ["$$q.isChecked", true] },
                },
              },
            },
            reviewedCount: {
              $size: {
                $filter: {
                  input: { $ifNull: ["$mcqs", []] },
                  as: "q",
                  cond: { $eq: ["$$q.isReviewed", true] },
                },
              },
            },
            similarCount: {
              $size: {
                $filter: {
                  input: { $ifNull: ["$mcqs", []] },
                  as: "q",
                  cond: { $eq: ["$$q.isSimilar", true] },
                },
              },
            },
          },
        },
        { $skip: (page - 1) * limit },
        { $limit: limit },
      ];

      const total = await col.countDocuments(filter);
      const mcqBanks = await col.aggregate(pipeline).toArray();

      return NextResponse.json({
        success: true,
        mcqBanks,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    }

    const total = await col.countDocuments(filter);
    let banks = await col
      .find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    banks = banks.map((bank) => {
      if (Array.isArray(bank.mcqs)) {
        bank.totalQuestions = bank.mcqs.length;
        if (difficulty && difficulty !== "Any") {
          bank.mcqs = (bank.mcqs as any[]).filter((q: any) => q.difficulty === difficulty);
        }
      }
      return bank;
    });

    return NextResponse.json({
      success: true,
      mcqBanks: banks,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to fetch MCQ banks" },
      { status: 500 },
    );
  }
}

async function handleDELETE(request: NextRequest) {
  try {
    await connectDB();
    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    await db.collection("mcqbanks").deleteOne({ _id: new mongoose.Types.ObjectId(id) });
    return NextResponse.json({ success: true, deleted: id });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to delete" },
      { status: 500 },
    );
  }
}

export const DELETE = withActivityLog(handleDELETE);
