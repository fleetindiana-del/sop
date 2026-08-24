import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireSuperAdmin } from "@/lib/withAuth";
import User, { type IUser } from "@/models/User";
import type { AppRole } from "@/lib/auth";

const ROLES: AppRole[] = ["admin", "sop_admin", "trainer", "viewer"];

type RouteContext = { params: Promise<{ id: string }> };

function toPublicUser(user: IUser) {
  return {
    id: user._id.toString(),
    username: user.username,
    name: user.name,
    email: user.email ?? "",
    role: user.role,
    department: user.department ?? "",
    designation: user.designation ?? "",
    pageAccess: Array.isArray(user.pageAccess) ? user.pageAccess : null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  try {
    const { id } = await context.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
    }

    await connectDB();
    const body = await request.json();
    const user = await User.findById(id);
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    if (body.name !== undefined) {
      const name = String(body.name || "").trim();
      if (!name) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
      user.name = name;
    }
    if (body.email !== undefined) {
      user.email = String(body.email || "").trim().toLowerCase() || undefined;
    }
    if (body.department !== undefined) {
      user.department = String(body.department || "").trim() || undefined;
    }
    if (body.designation !== undefined) {
      user.designation = String(body.designation || "").trim() || undefined;
    }
    if (body.role !== undefined) {
      const role = String(body.role || "").trim().toLowerCase() as AppRole;
      if (!ROLES.includes(role)) {
        return NextResponse.json({ error: "Invalid role" }, { status: 400 });
      }
      // Prevent demoting yourself out of admin by accident
      if (
        auth.session?.user?.id === id &&
        user.role === "admin" &&
        role !== "admin"
      ) {
        return NextResponse.json(
          { error: "You cannot remove your own admin role" },
          { status: 400 },
        );
      }
      // Keep at least one admin
      if (user.role === "admin" && role !== "admin") {
        const adminCount = await User.countDocuments({ role: "admin" });
        if (adminCount <= 1) {
          return NextResponse.json(
            { error: "Cannot demote the last admin user" },
            { status: 400 },
          );
        }
      }
      user.role = role;
    }
    if (body.password !== undefined && body.password !== "") {
      const password = String(body.password);
      if (password.length < 6) {
        return NextResponse.json(
          { error: "Password must be at least 6 characters" },
          { status: 400 },
        );
      }
      user.passwordHash = await bcrypt.hash(password, 12);
    }

    await user.save();
    return NextResponse.json({ success: true, user: toPublicUser(user) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update user" },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const auth = await requireSuperAdmin();
  if (auth.error) return auth.error;

  try {
    const { id } = await context.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
    }

    await connectDB();
    const user = await User.findById(id);
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    if (auth.session?.user?.id === id) {
      return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 });
    }

    if (user.role === "admin") {
      const adminCount = await User.countDocuments({ role: "admin" });
      if (adminCount <= 1) {
        return NextResponse.json({ error: "Cannot delete the last admin user" }, { status: 400 });
      }
    }

    await User.findByIdAndDelete(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete user" },
      { status: 500 },
    );
  }
}
