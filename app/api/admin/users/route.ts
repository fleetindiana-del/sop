import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/mongodb";
import { requireSuperAdmin } from "@/lib/withAuth";
import { syncEmployeeTrainerFlag } from "@/lib/userTrainerSync";
import User, { type IUser } from "@/models/User";
import type { AppRole } from "@/lib/auth";

const ROLES: AppRole[] = ["admin", "sop_admin", "trainer", "viewer"];

function toPublicUser(user: IUser) {
  return {
    id: user._id.toString(),
    username: user.username,
    name: user.name,
    email: user.email ?? "",
    role: user.role,
    department: user.department ?? "",
    designation: user.designation ?? "",
    isTrainer: user.isTrainer === true,
    pageAccess: Array.isArray(user.pageAccess) ? user.pageAccess : null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function GET() {
  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const users = await User.find({})
      .select("-passwordHash")
      .sort({ role: 1, username: 1 })
      .lean();

    return NextResponse.json({
      success: true,
      users: users.map((u) => ({
        id: u._id.toString(),
        username: u.username,
        name: u.name,
        email: u.email ?? "",
        role: u.role,
        department: u.department ?? "",
        designation: u.designation ?? "",
        isTrainer: u.isTrainer === true,
        pageAccess: Array.isArray(u.pageAccess) ? u.pageAccess : null,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list users" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const body = await request.json();
    const username = String(body.username || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    const role = (String(body.role || "viewer").trim().toLowerCase() || "viewer") as AppRole;
    const email = String(body.email || "").trim().toLowerCase() || undefined;
    const department = String(body.department || "").trim() || undefined;
    const designation = String(body.designation || "").trim() || undefined;
    const isTrainer = body.isTrainer === true;

    if (!username || !name) {
      return NextResponse.json({ error: "Username and name are required" }, { status: 400 });
    }
    if (password.length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters" }, { status: 400 });
    }
    if (!ROLES.includes(role)) {
      return NextResponse.json({ error: "Invalid role" }, { status: 400 });
    }

    const existing = await User.findOne({ username }).lean();
    if (existing) {
      return NextResponse.json({ error: "Username already exists" }, { status: 409 });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      username,
      name,
      passwordHash,
      role,
      email,
      department,
      designation,
      isTrainer,
    });

    // Trainer access is read from the Employee record, so mirror it there. Only
    // when granting: a new login created with the box unticked must not demote
    // an existing trainer who merely shares the name.
    const sync = isTrainer ? await syncEmployeeTrainerFlag(user, true) : undefined;

    return NextResponse.json(
      { success: true, user: toPublicUser(user), trainerSync: sync },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create user" },
      { status: 500 },
    );
  }
}
