import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import ActivityLog from "@/models/ActivityLog";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function countBy(field: string, filter: Record<string, unknown>, limit = 50) {
  const rows = await ActivityLog.aggregate<{ _id: string; count: number; failed: number }>([
    { $match: filter },
    { $group: { _id: `$${field}`, count: { $sum: 1 }, failed: { $sum: { $cond: ["$ok", 0, 1] } } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);
  return rows.map((row) => ({ [field]: row._id, count: row.count, failed: row.failed }));
}

/**
 * GET /api/activity-logs?pageKey=training-matrix&userName=&department=QA&method=POST&status=failed&q=&from=2026-11-01&to=2026-11-05&page=1&limit=50
 * Activity audit log for every page: each save / change / delete request — who, when, from which page
 * (pageKey/pageLabel, e.g. training-matrix, mcq-bank, lms-admin, lms = learner LMS), which API endpoint,
 * HTTP status and error. Add summary=1 for counts by page, user, endpoint and day instead of rows.
 * SOP field-level before/after history is in /api/audit-logs.
 */
export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const params = request.nextUrl.searchParams;
    const value = (name: string) => params.get(name)?.trim() ?? "";

    const filter: Record<string, unknown> = {};
    if (value("pageKey")) filter.pageKey = value("pageKey");
    if (value("method")) filter.method = value("method").toUpperCase();
    if (value("userName")) filter.userName = new RegExp(`^${escapeRegex(value("userName"))}$`, "i");
    if (value("status") === "failed") filter.ok = false;
    if (value("status") === "ok") filter.ok = true;
    if (value("department")) {
      const rx = new RegExp(`^${escapeRegex(value("department"))}$`, "i");
      filter.$or = [{ department: rx }, { userDepartment: rx }];
    }
    if (value("q")) {
      const rx = new RegExp(escapeRegex(value("q")), "i");
      filter.$and = [{ $or: [{ path: rx }, { pageLabel: rx }, { userName: rx }, { error: rx }, { query: rx }] }];
    }
    const range: { $gte?: Date; $lte?: Date } = {};
    const from = new Date(`${value("from")}T00:00:00.000`);
    const to = new Date(`${value("to")}T23:59:59.999`);
    if (value("from") && !Number.isNaN(from.getTime())) range.$gte = from;
    if (value("to") && !Number.isNaN(to.getTime())) range.$lte = to;
    if (range.$gte || range.$lte) filter.timestamp = range;

    if (value("summary") === "1") {
      const [total, byPage, byUser, byEndpoint, byDay] = await Promise.all([
        ActivityLog.countDocuments(filter),
        countBy("pageLabel", filter),
        countBy("userName", filter),
        countBy("path", filter),
        ActivityLog.aggregate<{ _id: string; count: number }>([
          { $match: filter },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$timestamp" } }, count: { $sum: 1 } } },
          { $sort: { _id: -1 } },
          { $limit: 31 },
        ]),
      ]);
      return NextResponse.json(
        {
          success: true,
          total,
          byPage,
          byUser,
          byEndpoint,
          byDay: byDay.map((row) => ({ day: row._id, count: row.count })),
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
    const limit = Math.min(200, Math.max(1, Number(params.get("limit") ?? 50) || 50));
    const [items, total] = await Promise.all([
      ActivityLog.find(filter, { _id: 0 }).sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ActivityLog.countDocuments(filter),
    ]);

    return NextResponse.json({ success: true, items, total, page, limit }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("GET /api/activity-logs error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load activity logs" },
      { status: 500 },
    );
  }
}
