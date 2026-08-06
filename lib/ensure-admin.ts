import bcrypt from "bcryptjs";
import User from "@/models/User";

const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin123";

export async function ensureDefaultAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);

  const user = await User.findOneAndUpdate(
    { username: ADMIN_USERNAME },
    {
      $set: {
        username: ADMIN_USERNAME,
        passwordHash,
        name: "Admin",
        email: "admin@local",
        role: "admin",
        department: "QA",
        designation: "Administrator",
      },
    },
    { upsert: true, returnDocument: 'after', runValidators: true },
  );

  if (!user?.passwordHash) {
    throw new Error("Failed to create admin user");
  }

  return user;
}
