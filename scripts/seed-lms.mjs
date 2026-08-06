import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const envPath = path.join(process.cwd(), ".env.local");
const env = fs.readFileSync(envPath, "utf8");
const uri = env.match(/^MONGODB_URI=(.+)$/m)?.[1]?.trim();

const EmployeeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    designation: { type: String, required: true, trim: true },
    department: { type: String, required: true, trim: true },
    employeeId: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    lmsUsername: { type: String, trim: true, unique: true, sparse: true },
    lmsPasswordHash: { type: String, select: false },
  },
  { timestamps: true },
);

await mongoose.connect(uri);
const Employee = mongoose.models.Employee || mongoose.model("Employee", EmployeeSchema);

const lmsPasswordHash = await bcrypt.hash("123", 12);

try {
  const employee = await Employee.findOneAndUpdate(
    { lmsUsername: "login" },
    {
      name: "LMS Demo User",
      designation: "Trainee",
      department: "QA",
      isActive: true,
      lmsUsername: "login",
      lmsPasswordHash,
    },
    { upsert: true, returnDocument: 'after' },
  );
  console.log("OK: LMS demo login created/updated");
  console.log("DB:", mongoose.connection.db.databaseName);
  console.log("Username: login");
  console.log("Password: 123");
  console.log("Employee:", employee.name);
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
} finally {
  await mongoose.disconnect();
}
