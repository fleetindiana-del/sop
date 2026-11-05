import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { requireAuth } from "@/lib/withAuth";
import { languageFromContentScript } from "@/lib/sop-name-resolution";
import { withActivityLog } from "@/lib/activity-log";

async function handlePOST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({}));
  // Optional: restrict to a base-code prefix (e.g. "MAGE" or "PREG"). Empty = all records.
  const prefix: string = (body.prefix ?? "").trim().toUpperCase();

  await connectDB();

  const query = prefix ? { sopBaseId: new RegExp(`^${prefix}`, "i") } : {};
  const records = await SOP.find(query).select("_id sopBaseId language fileType content fileUrl");

  let retagged = 0;
  const errors: string[] = [];

  for (const record of records) {
    try {
      // Only re-tag when the stored language is clearly wrong per the content script.
      const storedLang = record.language as string | undefined;
      // We only care about English↔Gujarati. Skip records without a clear language.
      if (storedLang !== "English" && storedLang !== "Gujarati") continue;

      const detected = languageFromContentScript(record.content, storedLang as "English" | "Gujarati");
      if (detected === storedLang) continue; // already correct

      await record.updateOne({ language: detected });
      retagged++;
    } catch (err) {
      errors.push(`${record._id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (retagged > 0) invalidateDashboardSopsCache();

  return NextResponse.json({
    scanned: records.length,
    retagged,
    errors: errors.slice(0, 20),
  });
}

export const POST = withActivityLog(handlePOST);
