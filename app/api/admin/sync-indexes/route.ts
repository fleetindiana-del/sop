import { NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import MCQBank from "@/models/MCQBank";
import { requireAuth } from "@/lib/withAuth";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  await connectDB();

  const results = [];
  for (const Model of [SOP, MCQBank] as const) {
    const before = await Model.collection.indexes();
    await Model.syncIndexes();
    const after = await Model.collection.indexes();
    console.log(`[sync-indexes] ${Model.modelName} before:`, before.map((i) => i.name));
    console.log(`[sync-indexes] ${Model.modelName} after:`, after.map((i) => i.name));
    results.push({
      model: Model.modelName,
      before: before.map((i) => ({ name: i.name, key: i.key })),
      after: after.map((i) => ({ name: i.name, key: i.key })),
    });
  }

  return NextResponse.json({ results });
}
