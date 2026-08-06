import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { connectDB } from "@/lib/mongodb";
import User from "@/models/User";

export async function POST() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "true") {
    return NextResponse.json({ error: "Seeding disabled in production" }, { status: 403 });
  }

  try {
    await connectDB();
    const username = (process.env.SEED_ADMIN_USERNAME ?? "admin").toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD ?? "admin123";
    const passwordHash = await bcrypt.hash(password, 12);

    const user = await User.findOneAndUpdate(
      { username },
      {
        username,
        passwordHash,
        name: "Admin",
        role: "admin",
        department: "QA",
        designation: "Administrator",
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    );

    return NextResponse.json({
      message: "Admin user ready",
      username: user.username,
      password,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Seed failed" },
      { status: 500 },
    );
  }
}
