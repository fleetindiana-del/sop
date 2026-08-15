import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import Notification from "@/models/Notification";

export const dynamic = "force-dynamic";

function toDto(row: {
  _id: unknown;
  type: string;
  title: string;
  body: string;
  href?: string;
  read: boolean;
  readAt?: Date;
  requestId?: unknown;
  sopIdentifier?: string;
  department?: string;
  createdAt?: Date;
}) {
  return {
    id: String(row._id),
    type: row.type,
    title: row.title,
    body: row.body,
    href: row.href ?? "",
    read: Boolean(row.read),
    readAt: row.readAt ? new Date(row.readAt).toISOString() : null,
    requestId: row.requestId ? String(row.requestId) : null,
    sopIdentifier: row.sopIdentifier ?? "",
    department: row.department ?? "",
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : new Date().toISOString(),
  };
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const userId = new mongoose.Types.ObjectId(auth.session.user.id);
    const countOnly = request.nextUrl.searchParams.get("count") === "1";

    if (countOnly) {
      const unreadCount = await Notification.countDocuments({ userId, read: false });
      return NextResponse.json({ success: true, unreadCount });
    }

    const [items, unreadCount] = await Promise.all([
      Notification.find({ userId }).sort({ createdAt: -1 }).limit(50).lean(),
      Notification.countDocuments({ userId, read: false }),
    ]);

    return NextResponse.json({
      success: true,
      unreadCount,
      notifications: items.map(toDto),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load notifications" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json().catch(() => ({}));
    const userId = new mongoose.Types.ObjectId(auth.session.user.id);
    const now = new Date();

    if (body.all === true) {
      await Notification.updateMany(
        { userId, read: false },
        { $set: { read: true, readAt: now } },
      );
    } else {
      const ids = Array.isArray(body.ids)
        ? body.ids
            .map((id: unknown) => String(id))
            .filter((id: string) => mongoose.Types.ObjectId.isValid(id))
            .map((id: string) => new mongoose.Types.ObjectId(id))
        : [];
      if (!ids.length) {
        return NextResponse.json({ error: "No notification ids provided" }, { status: 400 });
      }
      await Notification.updateMany(
        { _id: { $in: ids }, userId },
        { $set: { read: true, readAt: now } },
      );
    }

    const unreadCount = await Notification.countDocuments({ userId, read: false });
    return NextResponse.json({ success: true, unreadCount });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update notifications" },
      { status: 500 },
    );
  }
}
