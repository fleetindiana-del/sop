import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import { syncEmployeeTrainerFlag } from "@/lib/userTrainerSync";
import { resolveLmsEmployeeLink } from "@/lib/userEmployeeLink";
import { isSharedLmsLogin, syncLmsPasswordFromUser } from "@/lib/lmsSharedLogin";
import { serializeAssignedDepartments } from "@/lib/access-control";
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
    isTrainer: user.isTrainer === true,
    lmsEmployeeId: user.lmsEmployeeId ? String(user.lmsEmployeeId) : "",
    sharedLmsLogin: isSharedLmsLogin(user),
    pageAccess: Array.isArray(user.pageAccess) ? user.pageAccess : null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(["admin"]);
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

    /** Kept in plain text only for the duration of this request, to hash again for the LMS. */
    let plainPassword = "";

    if (body.name !== undefined) {
      const name = String(body.name || "").trim();
      if (!name) return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
      user.name = name;
    }
    if (body.email !== undefined) {
      user.email = String(body.email || "").trim().toLowerCase() || undefined;
    }
    // `departments` is the multi-select; `department` stays for single-value callers.
    if (body.departments !== undefined || body.department !== undefined) {
      user.department = serializeAssignedDepartments(
        body.departments !== undefined ? body.departments : body.department,
      );
    }
    if (body.designation !== undefined) {
      user.designation = String(body.designation || "").trim() || undefined;
    }
    if (body.isTrainer !== undefined) {
      user.isTrainer = body.isTrainer === true;
    }
    if (body.sharedLmsLogin !== undefined) {
      user.sharedLmsLogin = body.sharedLmsLogin === true;
    }
    if (body.lmsEmployeeId !== undefined) {
      const link = await resolveLmsEmployeeLink(body.lmsEmployeeId, id);
      if (!link.ok) return NextResponse.json({ error: link.error }, { status: 400 });
      user.lmsEmployeeId = link.employeeId;
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
      plainPassword = password;
    }

    await user.save();

    // One password for both modules, so a reset here has to reach the LMS half
    // on the Employee record too — the dashboard hash cannot be reused.
    const lmsSync =
      plainPassword && isSharedLmsLogin(user)
        ? await syncLmsPasswordFromUser(user, plainPassword)
        : undefined;

    // Trainer access is read from the Employee record, so mirror it there.
    const trainerSync =
      body.isTrainer !== undefined
        ? await syncEmployeeTrainerFlag(user, user.isTrainer === true)
        : undefined;

    return NextResponse.json({ success: true, user: toPublicUser(user), trainerSync, lmsSync });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update user" },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(["admin"]);
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
