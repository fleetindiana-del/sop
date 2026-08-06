import bcrypt from "bcryptjs";
import User from "@/models/User";

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin123";

/**
 * Ensure the default admin exists. Do not re-hash / overwrite on every request —
 * that made Vercel logins feel hung (bcrypt cost on every authorize/connect).
 */
export async function ensureDefaultAdmin() {
  const existing = await User.findOne({ username: ADMIN_USERNAME }).select("+passwordHash");
  if (existing?.passwordHash) {
    return existing;
  }

  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
  const user = await User.findOneAndUpdate(
    { username: ADMIN_USERNAME },
    {
      $setOnInsert: {
        username: ADMIN_USERNAME,
        passwordHash,
        name: "Admin",
        email: "admin@local",
        role: "admin",
        department: "QA",
        designation: "Administrator",
      },
    },
    { upsert: true, returnDocument: "after", runValidators: true },
  );

  if (!user?.passwordHash) {
    throw new Error("Failed to create admin user");
  }

  return user;
}
