import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth, forbidUnlessDepartmentAccess } from "@/lib/withAuth";
import { deleteBanksForFamily, type McqDeleteScope } from "@/lib/mcq-bank-write";
import { mcqResolveDept } from "@/lib/mcq-bank-utils";
import MCQBank from "@/models/MCQBank";

const DELETE_PASSWORD = process.env.SOP_DELETE_PASSWORD ?? "indiana132";

// DELETE /api/mcq-bank/delete
// Body: { identifier: string, scope: "eng"|"guj"|"both", password: string }
export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer"]);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    const { identifier, scope, password } = body;

    if (!identifier || typeof identifier !== "string") {
      return NextResponse.json({ error: "identifier required" }, { status: 400 });
    }
    if (!["eng", "guj", "both"].includes(scope)) {
      return NextResponse.json({ error: "Invalid scope" }, { status: 400 });
    }
    if (password !== DELETE_PASSWORD) {
      return NextResponse.json({ error: "Incorrect password. MCQs were not deleted." }, { status: 403 });
    }

    await connectDB();
    const sample = await MCQBank.findOne({ sopIdentifier: identifier })
      .select("sopIdentifier department")
      .lean();
    if (sample) {
      const denied = forbidUnlessDepartmentAccess(
        auth.session.user.role,
        auth.session.user.department,
        mcqResolveDept(String(sample.sopIdentifier ?? ""), String(sample.department ?? "")),
      );
      if (denied) return denied;
    }

    const deleted = await deleteBanksForFamily(identifier, scope as McqDeleteScope);
    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete MCQs" },
      { status: 500 },
    );
  }
}
