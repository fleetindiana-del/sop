import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { requireAuth } from "@/lib/withAuth";
import { actorFromSession, logSopAudit, snapshotSop } from "@/lib/audit-log";
import * as XLSX from "xlsx";

/**
 * Parse the standard location Excel format:
 *   Col A – Sr. No.
 *   Col B – DP No. (physical location, merged across rows)
 *   Col C – SOP No. / Annexure No.
 *   Col D – SOP Title (ignored)
 *
 * Section header rows (e.g. "WADHWAN-2") and "NA" SOP entries are skipped.
 * The DP No. value carries forward when a cell is blank (merged-cell behaviour).
 */
function parseLocationXlsx(buffer: ArrayBuffer): Array<{ identifier: string; location: string }> {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  const results: Array<{ identifier: string; location: string }> = [];
  let currentLocation = "";

  for (const row of rows) {
    const dpNo = String(row[1] ?? "").trim();
    const sopNo = String(row[2] ?? "").trim();

    // Skip completely empty rows
    if (!dpNo && !sopNo) continue;

    // Update current location when the DP No. cell is non-empty
    if (dpNo) currentLocation = dpNo;

    // Skip rows with no SOP number, "NA" placeholders, or section headers
    // (section headers appear in col B only, with nothing in col C)
    if (!sopNo || sopNo.toUpperCase() === "NA") continue;

    // Skip rows where the "SOP No." cell looks like a column heading
    if (/sop\s*no|annexure/i.test(sopNo)) continue;

    results.push({ identifier: sopNo, location: currentLocation });
  }

  return results;
}

/**
 * Fallback: parse a simple 2-column CSV/TSV file.
 *   Col 1 – identifier
 *   Col 2 – location
 */
function parseLocationCsv(text: string): Array<{ identifier: string; location: string }> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const rows: Array<{ identifier: string; location: string }> = [];

  for (const [index, line] of lines.entries()) {
    const parts = line.split(delimiter).map((p) => p.trim().replace(/^"|"$/g, ""));
    if (index === 0 && /identifier|sop/i.test(parts[0]) && /location/i.test(parts[1] ?? "")) {
      continue;
    }
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    rows.push({ identifier: parts[0], location: parts[1] });
  }

  return rows;
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file?.size) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const isXlsx = /\.(xlsx|xls)$/i.test(file.name);
    let rows: Array<{ identifier: string; location: string }>;

    if (isXlsx) {
      const buffer = await file.arrayBuffer();
      rows = parseLocationXlsx(buffer);
    } else {
      const text = await file.text();
      rows = parseLocationCsv(text);
    }

    if (!rows.length) {
      return NextResponse.json({ error: "No valid location rows found in file" }, { status: 400 });
    }

    const results: Array<{ identifier: string; success: boolean; error?: string }> = [];

    for (const row of rows) {
      const escaped = row.identifier.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
      const group = await SOP.find({
        identifier: new RegExp(`^${escaped}$`, "i"),
      });

      if (!group.length) {
        results.push({ identifier: row.identifier, success: false, error: "SOP not found" });
        continue;
      }

      const changed = group.filter((sop) => (sop.location ?? "") !== row.location);
      const previous = changed.length ? snapshotSop(changed[0]) : null;

      await Promise.all(group.map((sop) => sop.updateOne({ location: row.location })));

      if (previous && changed.length) {
        await logSopAudit({
          actor: actorFromSession(auth.session, request),
          action: "updated",
          sop: { ...changed[0].toObject(), location: row.location },
          previous,
          comments: `Location imported from ${file.name}`,
        });
      }
      results.push({ identifier: row.identifier, success: true });
    }

    if (results.some((r) => r.success)) {
      invalidateDashboardSopsCache();
    }

    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to import locations" },
      { status: 500 },
    );
  }
}
