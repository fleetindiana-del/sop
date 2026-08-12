import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { forbidUnlessDepartmentAccess, requireAuth } from "@/lib/withAuth";
import { mcqResolveDept } from "@/lib/mcq-bank-utils";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const { id } = await params;

    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    let objectId: mongoose.Types.ObjectId;
    try {
      objectId = new mongoose.Types.ObjectId(id);
    } catch {
      return NextResponse.json({ success: false, error: "Invalid bank ID" }, { status: 400 });
    }

    const col = db.collection("mcqbanks");
    const mcqBank = await col.findOne({ _id: objectId });

    if (!mcqBank) {
      return NextResponse.json({ success: false, error: "Bank not found" }, { status: 404 });
    }

    const denied = forbidUnlessDepartmentAccess(
      auth.session.user.role,
      auth.session.user.department,
      mcqResolveDept(String(mcqBank.sopIdentifier ?? ""), String(mcqBank.department ?? "")),
    );
    if (denied) return denied;

    if (Array.isArray(mcqBank.mcqs)) {
      mcqBank.totalQuestions = mcqBank.mcqs.length;
    }

    return NextResponse.json({ success: true, mcqBank });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Failed to fetch bank" },
      { status: 500 },
    );
  }
}
