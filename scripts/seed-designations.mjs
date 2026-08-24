/**
 * Seed the Designation Master from the designations already in use.
 *
 * Sources, in precedence order (Employee Master first — it is the source of
 * truth for who currently holds what):
 *   1. Employee.designation
 *   2. TrainingMatrixRecord.designation          (historical / Excel roster)
 *   3. InductionTrainingMatrixRecord.designation (historical / Excel roster)
 *   4. TrainingMatrixUpload.snapshot.employees[].designation
 *
 * Idempotent: re-running adds only designations that are missing. Existing
 * entries are never renamed or deactivated, so edits made in the Designation
 * Master survive a re-run.
 *
 *   node scripts/seed-designations.mjs
 */
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import { MONGO_CONNECT_OPTIONS } from "../lib/mongo-client-options.mjs";

const envPath = path.join(process.cwd(), ".env.local");
const env = fs.readFileSync(envPath, "utf8");
const uri = env.match(/^MONGODB_URI=(.+)$/m)?.[1]?.trim();
if (!uri) {
  console.error("FAIL: MONGODB_URI not found in .env.local");
  process.exit(1);
}

const DesignationSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    nameLower: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: String,
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
    updatedBy: String,
  },
  { timestamps: true, collection: "designations" },
);

async function connectWithRetry(target, attempts = 3) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    try {
      await mongoose.connect(target, MONGO_CONNECT_OPTIONS);
      return;
    } catch (err) {
      lastError = err;
      await mongoose.disconnect().catch(() => {});
      if (i < attempts) await new Promise((r) => setTimeout(r, i * 1500));
    }
  }
  throw lastError;
}

await connectWithRetry(uri);

const Designation =
  mongoose.models.Designation || mongoose.model("Designation", DesignationSchema);

try {
  const db = mongoose.connection.db;

  // Read the raw collections directly so this script does not depend on the
  // app's compiled Mongoose models.
  const collect = async (collection, field) => {
    try {
      const values = await db.collection(collection).distinct(field, {});
      return values.filter((v) => typeof v === "string");
    } catch {
      return [];
    }
  };

  const [fromEmployees, fromMatrix, fromInduction] = await Promise.all([
    collect("employees", "designation"),
    collect("trainingmatricesrecord", "designation"),
    collect("inductiontrainingmatricesrecord", "designation"),
  ]);

  // Upload snapshots hold designations inside an array of subdocuments.
  let fromSnapshots = [];
  try {
    const uploads = await db
      .collection("trainingmatricesupload")
      .find({ "snapshot.employees": { $exists: true } })
      .project({ "snapshot.employees.designation": 1 })
      .toArray();
    fromSnapshots = uploads.flatMap((u) =>
      (u?.snapshot?.employees ?? []).map((e) => e?.designation).filter((d) => typeof d === "string"),
    );
  } catch {
    /* collection may not exist */
  }

  // Preserve the casing seen in Employee Master when the same title appears in
  // several sources with different capitalisation.
  const byLower = new Map();
  const add = (raw) => {
    const name = String(raw || "").trim();
    if (!name || name === "—") return;
    const key = name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, name);
  };
  fromEmployees.forEach(add);
  fromMatrix.forEach(add);
  fromInduction.forEach(add);
  fromSnapshots.forEach(add);

  if (byLower.size === 0) {
    console.log("No designations found in the system — nothing to seed.");
    process.exit(0);
  }

  const existing = await Designation.distinct("nameLower");
  const existingSet = new Set(existing.map((v) => String(v).toLowerCase()));

  const toInsert = [...byLower.entries()]
    .filter(([lower]) => !existingSet.has(lower))
    .map(([lower, name]) => ({
      name,
      nameLower: lower,
      isActive: true,
      createdBy: "seed",
    }));

  if (toInsert.length > 0) {
    await Designation.insertMany(toInsert, { ordered: false });
  }

  console.log("OK: Designation Master seeded");
  console.log("DB:", db.databaseName);
  console.log(`Found in system: ${byLower.size}`);
  console.log(`Already present:  ${byLower.size - toInsert.length}`);
  console.log(`Inserted:         ${toInsert.length}`);
  if (toInsert.length) {
    console.log("New entries:", toInsert.map((d) => d.name).sort().join(", "));
  }
} catch (err) {
  console.error("FAIL:", err.message);
  process.exit(1);
} finally {
  await mongoose.disconnect();
}
