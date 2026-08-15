import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireAuth, forbidUnlessDepartmentAccess } from "@/lib/withAuth";
import { isComplianceOperator } from "@/lib/page-access";
import SOP from "@/models/SOP";
import ComplianceRunRequest from "@/models/ComplianceRunRequest";
import {
  findComplianceOperators,
  notifyUsers,
  toRequestDto,
} from "@/lib/complianceRunRequests";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const inbox = request.nextUrl.searchParams.get("inbox") === "1";
    const userId = auth.session.user.id;
    const operator = isComplianceOperator(
      auth.session.user.role,
      auth.session.user.pageAccess,
    );

    if (inbox) {
      if (!operator) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const requests = await ComplianceRunRequest.find({
        status: { $in: ["pending", "in_progress"] },
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();
      return NextResponse.json({
        success: true,
        requests: requests.map(toRequestDto),
      });
    }

    const requests = await ComplianceRunRequest.find({
      requesterId: new mongoose.Types.ObjectId(userId),
    })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    return NextResponse.json({
      success: true,
      requests: requests.map(toRequestDto),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list requests" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const sopId = String(body.sopId || "").trim();
    const department = String(body.department || "").trim();
    const note = String(body.note || "").trim().slice(0, 500);

    if (!sopId || !mongoose.Types.ObjectId.isValid(sopId)) {
      return NextResponse.json({ error: "Select a valid SOP" }, { status: 400 });
    }
    if (!department) {
      return NextResponse.json({ error: "Select a department" }, { status: 400 });
    }

    const denied = forbidUnlessDepartmentAccess(
      auth.session.user.role,
      auth.session.user.department,
      department,
    );
    if (denied) return denied;

    const sop = await SOP.findById(sopId)
      .select("_id identifier name department isObsolete")
      .lean();
    if (!sop) {
      return NextResponse.json({ error: "SOP not found" }, { status: 404 });
    }
    if (sop.isObsolete) {
      return NextResponse.json({ error: "Cannot request a run for an obsolete SOP" }, { status: 400 });
    }

    const deniedSop = forbidUnlessDepartmentAccess(
      auth.session.user.role,
      auth.session.user.department,
      sop.department,
    );
    if (deniedSop) return deniedSop;

    const existing = await ComplianceRunRequest.findOne({
      requesterId: new mongoose.Types.ObjectId(auth.session.user.id),
      sopId: sop._id,
      status: { $in: ["pending", "in_progress"] },
    });
    if (existing) {
      return NextResponse.json(
        {
          success: true,
          alreadyOpen: true,
          request: toRequestDto(existing),
        },
        { status: 200 },
      );
    }

    const operators = await findComplianceOperators(auth.session.user.id);
    const notifiedUserIds = operators.map((u) => u._id as mongoose.Types.ObjectId);

    const created = await ComplianceRunRequest.create({
      sopId: sop._id,
      sopIdentifier: sop.identifier,
      sopName: sop.name,
      department,
      requesterId: new mongoose.Types.ObjectId(auth.session.user.id),
      requesterName: auth.session.user.name,
      requesterUsername: auth.session.user.username,
      status: "pending",
      note,
      notifiedUserIds,
    });

    await notifyUsers(notifiedUserIds, {
      type: "compliance_run_requested",
      title: `Compliance run requested: ${sop.identifier}`,
      body: `${auth.session.user.name} requested a compliance check for ${sop.name} (${department}). Run this locally from the Compliance Engine.`,
      href: `/compliance?requestId=${created._id.toString()}&sopId=${sop._id.toString()}`,
      requestId: created._id,
      sopIdentifier: sop.identifier,
      department,
    });

    return NextResponse.json(
      {
        success: true,
        request: toRequestDto(created),
        notifiedCount: notifiedUserIds.length,
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create request" },
      { status: 500 },
    );
  }
}
