import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectDB } from "@/lib/mongodb";
import { requireAuth, forbidUnlessDepartmentAccess } from "@/lib/withAuth";
import SOP from "@/models/SOP";
import { sopFamilyGroupKey, resolveSopVersion, versionFromIdentifier } from "@/lib/sop-utils";
import { normalizeMcqDifficulty } from "@/lib/mcq-bank-write";
import { getGroupedRegistryRows } from "@/lib/dashboardRegistrySource";
import { mcqResolveDept } from "@/lib/mcq-bank-utils";

const langCodeOf = (language: unknown): "EN" | "GU" =>
  String(language ?? "").toLowerCase() === "gujarati" ? "GU" : "EN";

// GET /api/mcq-bank/bank?id=<bankId>
// Uses native driver to preserve isChecked / isReviewed / isSimilar sub-doc fields.
// Also returns `siblings`: the same SOP family's banks keyed by language so the
// viewer can flip between the English and Gujarati versions of one SOP.
export async function GET(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error("Database not connected");

    const { searchParams } = new URL(request.url);
    const id = searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const col = db.collection("mcqbanks");
    const bank = await col.findOne({ _id: new mongoose.Types.ObjectId(id) });

    if (!bank) return NextResponse.json({ error: "Bank not found" }, { status: 404 });

    const bankDept = mcqResolveDept(
      String(bank.sopIdentifier ?? ""),
      String(bank.department ?? ""),
    );
    const denied = forbidUnlessDepartmentAccess(
      auth.session.user.role,
      auth.session.user.department,
      bankDept,
    );
    if (denied) return denied;

    // Fix stale totalQuestions
    if (Array.isArray(bank.mcqs)) {
      bank.totalQuestions = bank.mcqs.length;
      bank.mcqs = bank.mcqs.map((m) => ({
        ...m,
        difficulty: normalizeMcqDifficulty(m.difficulty),
      }));
    }

    // ── Sibling language banks (same SOP family) ──────────────────────────────
    // Family grouping is padding-insensitive, so compute the family key per bank
    // rather than matching identifiers literally. One entry per language.
    const famKey = sopFamilyGroupKey({ identifier: String(bank.sopIdentifier ?? "").trim() });
    const candidates = await col
      .find({ isObsolete: { $ne: true } }, { projection: { sopIdentifier: 1, language: 1 } })
      .toArray();

    const siblingByLang = new Map<"EN" | "GU", string>();
    for (const c of candidates) {
      const key = sopFamilyGroupKey({ identifier: String(c.sopIdentifier ?? "").trim() });
      if (key !== famKey) continue;
      const lc = langCodeOf(c.language);
      if (!siblingByLang.has(lc)) siblingByLang.set(lc, String(c._id));
    }
    // The requested bank always represents its own language.
    siblingByLang.set(langCodeOf(bank.language), String(bank._id));

    const siblings = [...siblingByLang.entries()].map(([langCode, bankId]) => ({ langCode, bankId }));

    // ── Current active version (Dashboard = single source of truth) ───────────
    // The bank doc stores the identifier/name of whatever version the MCQs were
    // generated from (e.g. MAGE01-07, v7). The SOP family's CURRENT version comes
    // from the Dashboard registry. We resolve it so the viewer shows the current
    // SOP No. / version rather than the stale stored one.
    //
    // Staleness is judged PER LANGUAGE: the English (v7) and Gujarati (v8) docs of
    // one SOP are just translations of the same revision but carry different suffix
    // numbers, so neither is "outdated" while it matches the latest version of its
    // OWN language. `isOutdated` flips true only when a genuinely newer version of
    // this bank's language is uploaded without regenerated MCQs.
    let current: {
      identifier: string;
      version: string;
      name: string;
      nameGujarati: string | null;
    } | null = null;
    let versionStatus: {
      language: "EN" | "GU";
      bankVersion: number;
      currentVersion: number;
      isOutdated: boolean;
    } | null = null;
    try {
      const grouped = await getGroupedRegistryRows();
      const famRow = grouped.find(
        (r) => !r.isObsolete && sopFamilyGroupKey(r) === famKey,
      );
      if (famRow) {
        current = {
          identifier: famRow.identifier,
          version: famRow.version,
          name: famRow.name,
          nameGujarati: famRow.nameGujarati ?? null,
        };

        // Latest version of THIS bank's language across the family's SOP records.
        const records = (await SOP.find({ _id: { $in: famRow.recordIds } })
          .select("identifier language version")
          .lean()) as { identifier: string; language?: string; version?: string }[];
        const bankLang = langCodeOf(bank.language);
        let currentLangVersion = 0;
        for (const r of records) {
          if (langCodeOf(r.language) !== bankLang) continue;
          const v = parseFloat(resolveSopVersion(r.identifier, r.version ?? null)) || 0;
          if (v > currentLangVersion) currentLangVersion = v;
        }
        const bankVersion = parseFloat(versionFromIdentifier(String(bank.sopIdentifier ?? "")) ?? "0") || 0;
        versionStatus = {
          language: bankLang,
          bankVersion,
          currentVersion: currentLangVersion,
          isOutdated: currentLangVersion > 0 && bankVersion > 0 && currentLangVersion > bankVersion,
        };
      }
    } catch {
      // Non-fatal: viewer falls back to the stored bank identifier/name.
    }

    return NextResponse.json({ success: true, bank, siblings, current, versionStatus });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed" },
      { status: 500 },
    );
  }
}
