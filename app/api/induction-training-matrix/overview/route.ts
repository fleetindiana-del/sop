import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import SOP from '@/models/SOP';
import MCQBank from '@/models/MCQBank';
import InductionTrainingMatrixUpload from '@/models/InductionTrainingMatrixUpload';
import DepartmentTrainer from '@/models/DepartmentTrainer';
import { groupSOPRecords, baseIdentifierFromIdentifier, sopFamilyGroupKey } from '@/lib/sop-utils';
import {
  aliasSopStatusByCode,
  buildMcqStatMapsFromAgg,
  lookupMcqCombinedStat,
  lookupMcqLangStat,
} from '@/lib/trainingMatrixMcqStats';
import {
  buildExcelToDbBaseLookup,
  dbBasePresentInExcelCodes,
  expandSopIdentifierVariants,
  resolveExcelCodeToDbBase,
} from '@/lib/sopIdentifierNormalize';
import { getServerGroupedCache, setServerGroupedCache, invalidateDashboardSopsCache } from '@/lib/server-cache';
import { SOP_LIST_EXCLUDE } from '@/lib/sop-list-projection';
import { findLatestUploadsByDepartment } from '@/lib/latestMatrixUploads';
import { getInductionTrainingMatrixCacheEntry, setInductionTrainingMatrixCached } from '@/lib/inductionTrainingMatrixCache';
import { resolveEngGujFilePaths } from '@/lib/pathLanguageDetection';
import { getEmployeeMasterIndex, currentDesignation } from '@/lib/employeeMaster';

export const dynamic = 'force-dynamic';

// ─────────────────────────────────────────────────────────────────────────────
// Training Matrix overview — backed by the same SOP registry the Dashboard uses
// (SOP collection → groupSOPRecords) plus MCQ stats from the MCQ collection.
//
// The UI labels MCQ "created" as "≥90 per required language", so we keep that
// threshold. If your SOPs use fewer MCQs, lower MCQ_CREATED_THRESHOLD below.
// ─────────────────────────────────────────────────────────────────────────────

const MCQ_CREATED_THRESHOLD = 90;

const DEFAULT_DEPARTMENTS = ['QA', 'QC', 'Microbiology', 'Production', 'Store', 'Engineering', 'Personnel'];

type LangKey = 'ENG' | 'GUJ';

/** Map any stored department string onto the canonical Training Matrix set. */
function canonDept(raw: string): string {
  const t = String(raw || '').toLowerCase();
  if (/micro/.test(t)) return 'Microbiology';
  if (/engineer|maint/.test(t)) return 'Engineering';
  if (/person|\bhr\b/.test(t)) return 'Personnel';
  if (/\bqa\b|quality.?assur/.test(t)) return 'QA';
  if (/\bqc\b|quality.?cont/.test(t)) return 'QC';
  if (/store/.test(t)) return 'Store';
  if (/prod/.test(t)) return 'Production';
  return String(raw || '').trim();
}

function isValidDept(d: string): boolean {
  return Boolean(d) && !/^(unknown|general)$/i.test(d);
}

const CANON_MONTH: Record<string, string> = {
  january: 'January', jan: 'January',
  february: 'February', feb: 'February',
  march: 'March', mar: 'March',
  april: 'April', apr: 'April',
  may: 'May',
  june: 'June', jun: 'June',
  july: 'July', jul: 'July',
  august: 'August', aug: 'August',
  september: 'September', sep: 'September', sept: 'September',
  october: 'October', oct: 'October',
  november: 'November', nov: 'November',
  december: 'December', dec: 'December',
};

function canonMonthLabel(raw: string): string {
  const t = String(raw || '').trim();
  if (!t) return t;
  return CANON_MONTH[t.toLowerCase()] || t;
}

function monthCountsFromSchedule(excel: { excelCodes: Set<string>; sopMonthMap: Record<string, string> } | null): Record<string, number> {
  if (!excel) return {};
  const smm = excel.sopMonthMap ?? {};
  const mc: Record<string, number> = {};
  for (const base of excel.excelCodes) {
    const mo = smm[base];
    if (!mo) continue;
    let primary: string | null = null;
    for (const part of mo.split(',').map((s: string) => s.trim()).filter(Boolean)) {
      const m = canonMonthLabel(part);
      if (m) {
        primary = m;
        break;
      }
    }
    if (primary) mc[primary] = (mc[primary] || 0) + 1;
  }
  return mc;
}

// ── MCQ buckets (ported from the reference overview) ─────────────────────────
type LangStat = { totalQuestions: number; approvedCount: number };

function buildEmptyMcqBuckets() {
  return {
    mcqCreatedCount: 0, mcqNotCreatedCount: 0,
    mcqCreatedList: [] as string[], mcqNotCreatedList: [] as string[],
    mcqEngOnlyCreatedCount: 0, mcqEngOnlyNotCreatedCount: 0,
    mcqEngOnlyCreatedList: [] as string[], mcqEngOnlyNotCreatedList: [] as string[],
    mcqDualEngCreatedCount: 0, mcqDualEngNotCreatedCount: 0,
    mcqDualEngCreatedList: [] as string[], mcqDualEngNotCreatedList: [] as string[],
    mcqDualGujCreatedCount: 0, mcqDualGujNotCreatedCount: 0,
    mcqDualGujCreatedList: [] as string[], mcqDualGujNotCreatedList: [] as string[],
    mcqDualBothCreatedCount: 0, mcqDualEitherIncompleteCount: 0,
    mcqDualBothCreatedList: [] as string[], mcqDualEitherIncompleteList: [] as string[],
    mcqDualSopCount: 0,
    mcqEngCreatedCount: 0, mcqEngNotCreatedCount: 0,
    mcqEngCreatedList: [] as string[], mcqEngNotCreatedList: [] as string[],
    mcqGujCreatedCount: 0, mcqGujNotCreatedCount: 0,
    mcqGujCreatedList: [] as string[], mcqGujNotCreatedList: [] as string[],
    mcqAllApprovedCount: 0, mcqPartiallyApprovedCount: 0, mcqNotApprovedCount: 0,
    mcqAllApprovedList: [] as string[], mcqPartiallyApprovedList: [] as string[], mcqNotApprovedList: [] as string[],
    mcqApprovedNonDualCount: 0, mcqApprovalPartialNonDualCount: 0, mcqApprovalMissingNonDualCount: 0,
    mcqApprovedNonDualList: [] as string[], mcqApprovalPartialNonDualList: [] as string[], mcqApprovalMissingNonDualList: [] as string[],
    mcqApprovedDualCount: 0, mcqApprovalPartialDualCount: 0, mcqApprovalMissingDualCount: 0,
    mcqApprovedDualList: [] as string[], mcqApprovalPartialDualList: [] as string[], mcqApprovalMissingDualList: [] as string[],
    mcqDualSlotEngAllApprovedCount: 0, mcqDualSlotEngPartiallyApprovedCount: 0, mcqDualSlotEngNotApprovedCount: 0,
    mcqDualSlotEngAllApprovedList: [] as string[], mcqDualSlotEngPartiallyApprovedList: [] as string[], mcqDualSlotEngNotApprovedList: [] as string[],
    mcqDualSlotGujAllApprovedCount: 0, mcqDualSlotGujPartiallyApprovedCount: 0, mcqDualSlotGujNotApprovedCount: 0,
    mcqDualSlotGujAllApprovedList: [] as string[], mcqDualSlotGujPartiallyApprovedList: [] as string[], mcqDualSlotGujNotApprovedList: [] as string[],
    mcqEngAllApprovedCount: 0, mcqEngPartiallyApprovedCount: 0, mcqEngNotApprovedCount: 0,
    mcqEngAllApprovedList: [] as string[], mcqEngPartiallyApprovedList: [] as string[], mcqEngNotApprovedList: [] as string[],
    mcqGujAllApprovedCount: 0, mcqGujPartiallyApprovedCount: 0, mcqGujNotApprovedCount: 0,
    mcqGujAllApprovedList: [] as string[], mcqGujPartiallyApprovedList: [] as string[], mcqGujNotApprovedList: [] as string[],
  };
}
type McqBuckets = ReturnType<typeof buildEmptyMcqBuckets>;

function computeMcqBuckets(
  sopCodes: Iterable<string>,
  dbBaseLangs: Map<string, Set<LangKey>>,
  resolveLangStat: (code: string) => { eng: LangStat; guj: LangStat } | undefined,
): McqBuckets {
  const b = buildEmptyMcqBuckets();
  const T = MCQ_CREATED_THRESHOLD;
  for (const code of sopCodes) {
    const langSet = dbBaseLangs.get(code) || new Set<LangKey>(['ENG']);
    const isDual = langSet.has('GUJ');
    const langStat = resolveLangStat(code);
    const engTq = langStat?.eng.totalQuestions ?? 0;
    const engApproved = langStat?.eng.approvedCount ?? 0;
    const gujTq = langStat?.guj.totalQuestions ?? 0;
    const gujApproved = langStat?.guj.approvedCount ?? 0;
    const engOk = engTq >= T;
    const gujOk = gujTq >= T;
    const sopOk = isDual ? (engOk && gujOk) : engOk;

    if (sopOk) { b.mcqCreatedCount++; b.mcqCreatedList.push(code); }
    else { b.mcqNotCreatedCount++; b.mcqNotCreatedList.push(code); }

    if (!isDual) {
      if (engOk) { b.mcqEngOnlyCreatedCount++; b.mcqEngOnlyCreatedList.push(code); }
      else { b.mcqEngOnlyNotCreatedCount++; b.mcqEngOnlyNotCreatedList.push(code); }
    } else {
      b.mcqDualSopCount++;
      if (engOk) { b.mcqDualEngCreatedCount++; b.mcqDualEngCreatedList.push(code); }
      else { b.mcqDualEngNotCreatedCount++; b.mcqDualEngNotCreatedList.push(code); }
      if (gujOk) { b.mcqDualGujCreatedCount++; b.mcqDualGujCreatedList.push(code); }
      else { b.mcqDualGujNotCreatedCount++; b.mcqDualGujNotCreatedList.push(code); }
      if (engOk && gujOk) { b.mcqDualBothCreatedCount++; b.mcqDualBothCreatedList.push(code); }
      else { b.mcqDualEitherIncompleteCount++; b.mcqDualEitherIncompleteList.push(code); }
    }

    if (engOk) { b.mcqEngCreatedCount++; b.mcqEngCreatedList.push(code); }
    else { b.mcqEngNotCreatedCount++; b.mcqEngNotCreatedList.push(code); }
    if (isDual) {
      if (gujOk) { b.mcqGujCreatedCount++; b.mcqGujCreatedList.push(code); }
      else { b.mcqGujNotCreatedCount++; b.mcqGujNotCreatedList.push(code); }
    }

    if (sopOk) {
      if (!isDual) {
        if (engTq > 0 && engApproved >= engTq) {
          b.mcqAllApprovedCount++; b.mcqAllApprovedList.push(code);
          b.mcqApprovedNonDualCount++; b.mcqApprovedNonDualList.push(code);
        } else if (engApproved > 0) {
          b.mcqPartiallyApprovedCount++; b.mcqPartiallyApprovedList.push(code);
          b.mcqApprovalPartialNonDualCount++; b.mcqApprovalPartialNonDualList.push(code);
        } else {
          b.mcqNotApprovedCount++; b.mcqNotApprovedList.push(code);
          b.mcqApprovalMissingNonDualCount++; b.mcqApprovalMissingNonDualList.push(code);
        }
      } else {
        const engFull = engTq > 0 && engApproved >= engTq;
        const gujFull = gujTq > 0 && gujApproved >= gujTq;
        const engNone = engApproved === 0;
        const gujNone = gujApproved === 0;
        if (engFull && gujFull) {
          b.mcqAllApprovedCount++; b.mcqAllApprovedList.push(code);
          b.mcqApprovedDualCount++; b.mcqApprovedDualList.push(code);
        } else if (engNone || gujNone) {
          b.mcqNotApprovedCount++; b.mcqNotApprovedList.push(code);
          b.mcqApprovalMissingDualCount++; b.mcqApprovalMissingDualList.push(code);
        } else {
          b.mcqPartiallyApprovedCount++; b.mcqPartiallyApprovedList.push(code);
          b.mcqApprovalPartialDualCount++; b.mcqApprovalPartialDualList.push(code);
        }
        if (engTq > 0 && engApproved >= engTq) { b.mcqDualSlotEngAllApprovedCount++; b.mcqDualSlotEngAllApprovedList.push(code); }
        else if (engApproved > 0) { b.mcqDualSlotEngPartiallyApprovedCount++; b.mcqDualSlotEngPartiallyApprovedList.push(code); }
        else { b.mcqDualSlotEngNotApprovedCount++; b.mcqDualSlotEngNotApprovedList.push(code); }
        if (gujTq > 0 && gujApproved >= gujTq) { b.mcqDualSlotGujAllApprovedCount++; b.mcqDualSlotGujAllApprovedList.push(code); }
        else if (gujApproved > 0) { b.mcqDualSlotGujPartiallyApprovedCount++; b.mcqDualSlotGujPartiallyApprovedList.push(code); }
        else { b.mcqDualSlotGujNotApprovedCount++; b.mcqDualSlotGujNotApprovedList.push(code); }
      }
    }

    if (engTq > 0) {
      if (engApproved >= engTq) { b.mcqEngAllApprovedCount++; b.mcqEngAllApprovedList.push(code); }
      else if (engApproved > 0) { b.mcqEngPartiallyApprovedCount++; b.mcqEngPartiallyApprovedList.push(code); }
      else { b.mcqEngNotApprovedCount++; b.mcqEngNotApprovedList.push(code); }
    } else { b.mcqEngNotApprovedCount++; b.mcqEngNotApprovedList.push(code); }
    if (isDual) {
      if (gujTq > 0) {
        if (gujApproved >= gujTq) { b.mcqGujAllApprovedCount++; b.mcqGujAllApprovedList.push(code); }
        else if (gujApproved > 0) { b.mcqGujPartiallyApprovedCount++; b.mcqGujPartiallyApprovedList.push(code); }
        else { b.mcqGujNotApprovedCount++; b.mcqGujNotApprovedList.push(code); }
      } else { b.mcqGujNotApprovedCount++; b.mcqGujNotApprovedList.push(code); }
    }
  }
  return b;
}

// Snapshot is considered fresh for this long. Older-but-present snapshots are
// still served instantly while a background recompute refreshes them (SWR).
const OVERVIEW_FRESH_TTL_MS = 10 * 60 * 1000;

// Guards against piling up concurrent recomputes (one in-flight at a time).
let overviewRevalidating = false;

async function revalidateOverviewInBackground() {
  if (overviewRevalidating) return;
  overviewRevalidating = true;
  try {
    const payload = await computeOverviewPayload(false);
    await setInductionTrainingMatrixCached(payload);
  } catch (err) {
    console.error('[training-matrix/overview] background revalidate failed', err);
  } finally {
    overviewRevalidating = false;
  }
}

export async function GET(request: NextRequest) {
  try {
    const forceFresh = request.nextUrl.searchParams.get('refresh') === '1';

    // Explicit refresh: recompute synchronously from a fresh registry.
    if (forceFresh) {
      const payload = await computeOverviewPayload(true);
      await setInductionTrainingMatrixCached(payload);
      return NextResponse.json(payload);
    }

    // Connect first so the durable (Mongo) snapshot fallback is reachable.
    await connectDB();

    const entry = await getInductionTrainingMatrixCacheEntry();
    if (entry) {
      // Serve immediately. If the snapshot is stale, refresh it in the
      // background so the *next* request is fresh — the user never waits.
      const age = Date.now() - (entry.computedAt || 0);
      if (age > OVERVIEW_FRESH_TTL_MS) {
        void revalidateOverviewInBackground();
      }
      return NextResponse.json(entry.payload);
    }

    // Nothing cached anywhere (very first load or after invalidation): compute now.
    const payload = await computeOverviewPayload(false);
    await setInductionTrainingMatrixCached(payload);
    return NextResponse.json(payload);
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to load overview' },
      { status: 500 },
    );
  }
}

async function computeOverviewPayload(forceFresh: boolean) {
    await connectDB();

    if (forceFresh) invalidateDashboardSopsCache();

    // Fire every independent DB read in parallel. On a cold (free-tier) Atlas each
    // round-trip can cost ~30s, so collapsing the 3 previously-sequential trips
    // (SOP.find → MCQBank.aggregate → trainers/uploads) into one Promise.all cuts
    // the cold-start compute from ~90s to ~30s — enough to finish and persist a
    // durable snapshot, after which every load is instant.
    //   1. SOP registry (skipped if the shared grouped cache is already warm)
    //   2. MCQ stats from `mcqbanks` (one doc per SOP + language)
    //   3. Trainers + induction upload snapshots
    const cachedRegistry = getServerGroupedCache();
    const [sopRecords, mcqAgg, trainerDocs, uploads, masterIndex] = await Promise.all([
      cachedRegistry ? Promise.resolve(null) : SOP.find({}).select(SOP_LIST_EXCLUDE).lean(),
      MCQBank.aggregate([
        { $match: { isObsolete: { $ne: true } } },
        {
          $project: {
            sopIdentifier: 1,
            language: 1,
            totalQuestions: { $ifNull: ['$totalQuestions', { $size: { $ifNull: ['$mcqs', []] } }] },
            approvedCount: {
              $size: {
                $filter: {
                  input: { $ifNull: ['$mcqs', []] },
                  as: 'm',
                  cond: { $eq: ['$$m.isChecked', true] },
                },
              },
            },
          },
        },
      ]),
      DepartmentTrainer.find({}).select('departmentName sopIdentifier trainerName').lean(),
      findLatestUploadsByDepartment(InductionTrainingMatrixUpload, {
        snapshot: { $exists: true, $ne: null },
      }),
      getEmployeeMasterIndex(),
    ]);

    // 1. Same SOP source as the Dashboard: collapse versions into one row per family.
    let registry = cachedRegistry;
    if (!registry) {
      registry = groupSOPRecords(sopRecords as never[]);
      setServerGroupedCache(registry);
    }
    const active = registry.filter((r) => !r.isObsolete);
    const excelToDbBase = buildExcelToDbBaseLookup(active);
    const dbBaseInExcelSet = (dbBase: string, codes: Set<string>) =>
      dbBasePresentInExcelCodes(dbBase, codes, excelToDbBase);

    const stripVer = (c: string) => String(c || '').toUpperCase().replace(/-\d+$/, '').trim();

    const { mcqLangStatMap, mcqStatMap } = buildMcqStatMapsFromAgg(
      mcqAgg as Array<{ sopIdentifier: string; language: string | null; totalQuestions: number; approvedCount: number }>,
    );
    const dbBaseToFamKey = new Map<string, string>();

    // 3. Per-family metadata, languages, department.
    const dbBaseSet = new Set<string>();
    const dbBaseLangs = new Map<string, Set<LangKey>>();
    const dbBaseMeta = new Map<string, {
      title: string;
      gujaratiName?: string;
      isDualLanguage: boolean;
      dept: string;
      expired: boolean;
      nearExpiry: boolean;
      noDate: boolean;
      targetDate: string | null;
    }>();
    const dbDocPathsByCode: Record<string, { eng?: string; guj?: string; id?: string }> = {};
    const deptSet = new Set<string>(DEFAULT_DEPARTMENTS);

    for (const row of active) {
      const base = baseIdentifierFromIdentifier(row.identifier);
      if (!base || dbBaseSet.has(base)) continue;
      dbBaseSet.add(base);
      dbBaseToFamKey.set(base, sopFamilyGroupKey(row));

      const langs = new Set<LangKey>();
      if (row.language === 'ENG' || row.language === 'ENG-GUJ') langs.add('ENG');
      if (row.language === 'GUJ' || row.language === 'ENG-GUJ') langs.add('GUJ');
      if (langs.size === 0) langs.add('ENG');
      dbBaseLangs.set(base, langs);

      const dept = canonDept(row.department);
      if (isValidDept(dept)) deptSet.add(dept);

      const expired = row.expiryTier === 'expired';
      const nearExpiry = row.expiryTier === 'high';
      const noDate = row.expiryTier === 'none';
      const targetDate = row.expiryDate || null;
      dbBaseMeta.set(base, {
        title: row.name || '',
        gujaratiName: row.nameGujarati,
        isDualLanguage: row.language === 'ENG-GUJ' || !!(row.name && row.nameGujarati),
        dept: isValidDept(dept) ? dept : 'General',
        expired,
        nearExpiry,
        noDate,
        targetDate,
      });

      // Document paths for the in-app viewer. Prefer DOCX, fall back to PDF.
      // Slot assignment (files.docx.en / .gu) is authoritative; path hints only
      // reroute clearly Gujarati filenames or resolve mis-tagged language metadata.
      const { eng: engPath, guj: gujPath } = resolveEngGujFilePaths({
        docx: row.files?.docx,
        pdf: row.files?.pdf,
      });
      if (engPath || gujPath) {
        dbDocPathsByCode[base] = {
          ...(engPath ? { eng: engPath } : {}),
          ...(gujPath ? { guj: gujPath } : {}),
          id: row.identifier,
        };
      }
    }

    // Augment language slots from Gujarati titles and MCQ banks — many SOPs store
    // Gujarati text under language="English" but still have Gujarati MCQ banks.
    for (const base of dbBaseSet) {
      const langs = dbBaseLangs.get(base) || new Set<LangKey>(['ENG']);
      const meta = dbBaseMeta.get(base)!;
      const ls = lookupMcqLangStat(base, dbBaseToFamKey, mcqLangStatMap);
      if ((ls?.eng.totalQuestions ?? 0) > 0) langs.add('ENG');
      if ((ls?.guj.totalQuestions ?? 0) > 0) langs.add('GUJ');
      if (meta.gujaratiName) langs.add('GUJ');
      if (meta.title) langs.add('ENG');
      dbBaseLangs.set(base, langs);
      meta.isDualLanguage = langs.has('ENG') && langs.has('GUJ');
    }

    const obsoleteBaseSet = new Set<string>();
    for (const row of registry.filter((r) => r.isObsolete)) {
      const base = baseIdentifierFromIdentifier(row.identifier);
      if (base) obsoleteBaseSet.add(base.toUpperCase());
      for (const variant of expandSopIdentifierVariants(row.identifier)) {
        const s = stripVer(variant);
        if (s) obsoleteBaseSet.add(s);
      }
    }

    const isMatrixAssignableCode = (raw: string): boolean => {
      const stripped = stripVer(raw);
      if (!stripped) return false;
      if (obsoleteBaseSet.has(stripped)) return false;
      const dbBase = resolveExcelCodeToDbBase(stripped, excelToDbBase);
      if (dbBase) {
        if (obsoleteBaseSet.has(dbBase)) return false;
        return dbBaseSet.has(dbBase);
      }
      return dbBaseSet.has(stripped);
    };

    const departments = [
      ...DEFAULT_DEPARTMENTS,
      ...[...deptSet].filter((d) => !DEFAULT_DEPARTMENTS.includes(d)).sort((a, b) => a.localeCompare(b)),
    ];

    // 4. Department → base codes.
    const codesByDept: Record<string, string[]> = {};
    for (const d of departments) codesByDept[d] = [];
    for (const base of dbBaseSet) {
      const d = dbBaseMeta.get(base)!.dept;
      if (!codesByDept[d]) codesByDept[d] = [];
      codesByDept[d].push(base);
    }
    for (const d of Object.keys(codesByDept)) codesByDept[d].sort((a, b) => a.localeCompare(b));

    // 5. sopStatusByCode (used by the table + detail panels).
    const sopStatusByCode: Record<string, {
      expired: boolean; targetDate: string | null; totalQuestions: number; approvedCount: number;
      engTotalQuestions: number; engApprovedCount: number; gujTotalQuestions: number; gujApprovedCount: number;
      title: string; gujaratiName?: string; isDualLanguage: boolean;
    }> = {};
    for (const base of dbBaseSet) {
      const meta = dbBaseMeta.get(base)!;
      const ls = lookupMcqLangStat(base, dbBaseToFamKey, mcqLangStatMap);
      const combined = lookupMcqCombinedStat(base, dbBaseToFamKey, mcqStatMap);
      sopStatusByCode[base] = {
        expired: meta.expired,
        targetDate: meta.targetDate,
        totalQuestions: combined.totalQuestions,
        approvedCount: combined.approvedCount,
        engTotalQuestions: ls?.eng.totalQuestions ?? 0,
        engApprovedCount: ls?.eng.approvedCount ?? 0,
        gujTotalQuestions: ls?.guj.totalQuestions ?? 0,
        gujApprovedCount: ls?.guj.approvedCount ?? 0,
        title: meta.title,
        gujaratiName: meta.gujaratiName,
        isDualLanguage: meta.isDualLanguage,
      };
    }
    aliasSopStatusByCode(sopStatusByCode, dbBaseSet, excelToDbBase, stripVer);

    // 5b. Trainers (from `departmenttrainers`) and induction upload snapshots
    //     (from `inductiontrainingmatricesupload`) — both fetched in the parallel
    //     batch above to avoid extra sequential round-trips on a cold cluster.
    // base SOP code → trainer names (SOP-specific), and dept → trainer names (dept-level).
    const sopTrainerMap = new Map<string, Set<string>>();
    const deptTrainerMap = new Map<string, Set<string>>();
    for (const t of trainerDocs as Array<{ departmentName?: string; sopIdentifier?: string; trainerName?: string }>) {
      const name = String(t.trainerName || '').trim();
      if (!name) continue;
      if (t.sopIdentifier) {
        const base = baseIdentifierFromIdentifier(String(t.sopIdentifier));
        if (base) {
          if (!sopTrainerMap.has(base)) sopTrainerMap.set(base, new Set());
          sopTrainerMap.get(base)!.add(name);
        }
      } else if (t.departmentName) {
        const d = canonDept(String(t.departmentName));
        if (!deptTrainerMap.has(d)) deptTrainerMap.set(d, new Set());
        deptTrainerMap.get(d)!.add(name);
      }
    }
    // Resolve per-SOP trainer: SOP-specific first, then dept-level.
    const baseTrainerCount = new Map<string, number>();
    const baseTrainerName = new Map<string, string>();
    for (const base of dbBaseSet) {
      const ownerDept = dbBaseMeta.get(base)!.dept;
      let names: Set<string> | undefined;
      if (sopTrainerMap.has(base) && sopTrainerMap.get(base)!.size) names = sopTrainerMap.get(base)!;
      else if (deptTrainerMap.has(ownerDept) && deptTrainerMap.get(ownerDept)!.size) names = deptTrainerMap.get(ownerDept)!;
      baseTrainerCount.set(base, names ? names.size : 0);
      if (names) baseTrainerName.set(base, [...names].join(', '));
    }

    // Latest snapshot per canonical department.
    const normalizeTraining = (training: Record<string, boolean> | undefined) => {
      const out: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(training || {})) {
        const b = stripVer(k);
        if (!b || !isMatrixAssignableCode(b)) continue;
        out[b] = out[b] || !!v;
      }
      return out;
    };
    type SnapEmp = { name: string; designation: string; department: string; training: Record<string, boolean> };
    type DeptExcel = {
      uploaded: boolean; fileUrl: string | null; uploadedAt: string | null; fileName?: string;
      excelCodes: Set<string>; employees: SnapEmp[]; monthCounts: Record<string, number>; sopMonthMap: Record<string, string>;
    };
    const excelByDept = new Map<string, DeptExcel>();
    for (const up of uploads as Array<{ department: string; uploadedAt?: Date; fileUrl?: string; fileName?: string; snapshot?: { sopCodes?: string[]; monthCounts?: Record<string, number>; sopMonthMap?: Record<string, string>; employees?: SnapEmp[] } }>) {
      const dept = canonDept(up.department);
      if (excelByDept.has(dept)) continue; // uploads are sorted desc — keep newest
      const snap = up.snapshot || {};
      const excelCodes = new Set<string>();
      for (const raw of snap.sopCodes || []) {
        const b = stripVer(String(raw));
        if (b && isMatrixAssignableCode(b)) excelCodes.add(b);
      }
      const sopMonthMap: Record<string, string> = {};
      for (const [k, m] of Object.entries(snap.sopMonthMap || {})) {
        const b = stripVer(k);
        if (b && m && isMatrixAssignableCode(b)) {
          sopMonthMap[b] = m;
          excelCodes.add(b);
        }
      }
      const employees = (snap.employees || []).map((e) => ({
        name: e.name,
        // Employee Master owns the current designation; the upload snapshot
        // value is only a fallback for rows with no Employee Master record.
        designation: currentDesignation(masterIndex, dept, e.name, e.designation),
        department: dept,
        training: normalizeTraining(e.training),
      }));
      excelByDept.set(dept, {
        uploaded: true,
        fileUrl: up.fileUrl || null,
        uploadedAt: up.uploadedAt ? new Date(up.uploadedAt).toISOString() : null,
        fileName: up.fileName,
        excelCodes, employees, monthCounts: snap.monthCounts || {}, sopMonthMap,
      });
    }

    // How many distinct departments contain each SOP code in Excel (repetition).
    const sopCodeToDeptCount = new Map<string, number>();
    for (const { excelCodes } of excelByDept.values()) {
      for (const c of excelCodes) {
        const key = resolveExcelCodeToDbBase(c, excelToDbBase) || c;
        sopCodeToDeptCount.set(key, (sopCodeToDeptCount.get(key) || 0) + 1);
      }
    }

    // Global union of every Excel code across all department uploads.
    const allExcelUnion = new Set<string>();
    for (const { excelCodes } of excelByDept.values()) {
      for (const c of excelCodes) allExcelUnion.add(c);
    }

    const allExcelEmployees: SnapEmp[] = [];

    // 6. Card builder shared by Total + per-dept.
    const buildCard = (codes: string[], deptName: string, excel: DeptExcel | null) => {
      const expiredList = codes.filter((c) => dbBaseMeta.get(c)!.expired);
      const expiredCount = expiredList.length;
      const okayCount = codes.length - expiredCount;
      const okayList = codes.filter((c) => !dbBaseMeta.get(c)!.expired);
      const nearExpiryList = codes.filter((c) => dbBaseMeta.get(c)!.nearExpiry);
      const noDateList = codes.filter((c) => dbBaseMeta.get(c)!.noDate);
      const excelCodesSet = excel?.excelCodes ?? new Set<string>();
      // DB SOP codes per language (matches engNeeded / gujNeeded). Used by the
      // "Lang (DB)" chips so a click reveals exactly the counted SOPs.
      const engDbList = codes.filter((c) => (dbBaseLangs.get(c) || new Set(['ENG'])).has('ENG'));
      const gujDbList = codes.filter((c) => (dbBaseLangs.get(c) || new Set(['ENG'])).has('GUJ'));
      const langDbListByKey: Record<string, string[]> = { ENG: engDbList, GUJ: gujDbList };
      const engNeeded = engDbList.length;
      const gujNeeded = gujDbList.length;
      const engFound = codes.filter((c) => dbBaseInExcelSet(c, excelCodesSet) && (dbBaseLangs.get(c) || new Set(['ENG'])).has('ENG')).length;
      const engMissing = codes.filter((c) => !dbBaseInExcelSet(c, excelCodesSet) && (dbBaseLangs.get(c) || new Set(['ENG'])).has('ENG')).length;
      const gujFound = codes.filter((c) => dbBaseInExcelSet(c, excelCodesSet) && (dbBaseLangs.get(c) || new Set(['ENG'])).has('GUJ')).length;
      const gujMissing = codes.filter((c) => !dbBaseInExcelSet(c, excelCodesSet) && (dbBaseLangs.get(c) || new Set(['ENG'])).has('GUJ')).length;
      const langBreakdown = [
        { key: 'ENG', label: 'ENG', found: excel ? engFound : engNeeded, missing: excel ? engMissing : 0 },
        ...(gujNeeded > 0 ? [{ key: 'GUJ', label: 'GUJ', found: excel ? gujFound : gujNeeded, missing: excel ? gujMissing : 0 }] : []),
      ];
      const mcq = computeMcqBuckets(codes, dbBaseLangs, (code) =>
        lookupMcqLangStat(code, dbBaseToFamKey, mcqLangStatMap),
      );

      // SOP-wise trainer buckets (scope = this card's DB SOP codes).
      const sop0TrainerList = codes.filter((c) => (baseTrainerCount.get(c) ?? 0) === 0);
      const sop1TrainerList = codes.filter((c) => (baseTrainerCount.get(c) ?? 0) === 1);
      const sop2PlusTrainerList = codes.filter((c) => (baseTrainerCount.get(c) ?? 0) >= 2);
      const sopTrainersAssigned = codes.filter((c) => (baseTrainerCount.get(c) ?? 0) > 0).length;
      const sopTrainersMissingList = codes
        .filter((c) => (baseTrainerCount.get(c) ?? 0) === 0)
        .map((c) => ({ sopCode: c, title: dbBaseMeta.get(c)!.title, department: deptName }));

      // Excel / training-matrix enrichment from the upload snapshot.
      const excelCodes = excelCodesSet;
      const employees = excel?.employees ?? [];
      const foundInDb = codes.filter((c) => dbBaseInExcelSet(c, excelCodes));
      const missingFromExcelCodes = codes.filter((c) => !dbBaseInExcelSet(c, excelCodes));
      const missingFromExcelList = missingFromExcelCodes.map((c) => ({ sopCode: c, title: dbBaseMeta.get(c)!.title, department: deptName }));
      const fullyTrained = employees.filter((e) => {
        const vals = Object.values(e.training || {});
        return vals.length > 0 && vals.every(Boolean);
      }).length;

      // Trainer rows scoped to Excel-found SOPs (matches the reference "trainers" capsule).
      const trainersAssigned = foundInDb.filter((c) => (baseTrainerCount.get(c) ?? 0) > 0).length;
      const trainersMissingList = foundInDb
        .filter((c) => (baseTrainerCount.get(c) ?? 0) === 0)
        .map((c) => ({ sopCode: c, month: excel?.sopMonthMap?.[c] || '', department: deptName }));

      // Repetition buckets (how many departments share each SOP in Excel).
      // Use allExcelUnion (not just this dept's own Excel) so that per-dept bucket
      // sums reflect global coverage — matching the total card's excelSopCount.
      const foundInAnyExcel = codes.filter((c) => dbBaseInExcelSet(c, allExcelUnion));
      const repeat3PlusList: Array<{ sopCode: string; title: string; department: string; count: number }> = [];
      const repeat2List: typeof repeat3PlusList = [];
      const repeat1List: typeof repeat3PlusList = [];
      for (const c of foundInAnyExcel) {
        const count = sopCodeToDeptCount.get(c) || 1;
        const item = { sopCode: c, title: dbBaseMeta.get(c)!.title, department: deptName, count };
        if (count >= 3) repeat3PlusList.push(item);
        else if (count === 2) repeat2List.push(item);
        else repeat1List.push(item);
      }

      // Excel SOP dept split: for each Excel code determine its DB owner dept.
      // foundByDept counts Excel SOPs grouped by their DB owner department.
      // missingByDept counts DB-owned SOPs absent from ANY Excel upload (global).
      const excelDeptSplitFoundByDept: Record<string, number> = {};
      const excelDeptSplitMissingByDept: Record<string, number> = {};
      const excelDeptSplitMissingListByDept: Record<string, Array<{ sopCode: string; title: string; department: string }>> = {};
      for (const d of departments) {
        excelDeptSplitFoundByDept[d] = 0;
        excelDeptSplitMissingByDept[d] = 0;
        excelDeptSplitMissingListByDept[d] = [];
      }
      let excelDeptSplitUnknownFound = 0;
      if (excel) {
        for (const c of excelCodes) {
          const dbBase = resolveExcelCodeToDbBase(c, excelToDbBase);
          const meta = dbBase ? dbBaseMeta.get(dbBase) : undefined;
          if (!meta) {
            excelDeptSplitUnknownFound++;
            continue;
          }
          const owner = meta.dept;
          if (departments.includes(owner)) {
            excelDeptSplitFoundByDept[owner] = (excelDeptSplitFoundByDept[owner] || 0) + 1;
          } else {
            excelDeptSplitUnknownFound++;
          }
        }
      }
      for (const d of departments) {
        const ownerCodes = codesByDept[d] || [];
        const missingCodes = ownerCodes.filter((c) => !dbBaseInExcelSet(c, allExcelUnion));
        excelDeptSplitMissingByDept[d] = missingCodes.length;
        excelDeptSplitMissingListByDept[d] = missingCodes.map((c) => ({
          sopCode: c,
          title: dbBaseMeta.get(c)!.title,
          department: d,
        }));
      }
      const excelDeptSplit = {
        total: excelCodes.size,
        foundByDept: excelDeptSplitFoundByDept,
        missingByDept: excelDeptSplitMissingByDept,
        missingListByDept: excelDeptSplitMissingListByDept,
        unknownFound: excelDeptSplitUnknownFound,
        unknownMissing: 0,
      };

      return {
        ...mcq,
        sopCount: excelCodes.size,
        foundInDb: foundInDb.length,
        foundInDbList: foundInDb,
        langBreakdown,
        langDbListByKey,
        okayCount,
        okayList,
        expiredCount,
        expiredList,
        nearExpiryCount: nearExpiryList.length,
        nearExpiryList,
        noDateCount: noDateList.length,
        noDateList,
        // Legacy aliases — same 30-day "Near" tier as the Dashboard.
        dueSoon30Count: nearExpiryList.length,
        dueSoon30List: nearExpiryList,
        trainersAssigned,
        trainersMissing: trainersMissingList.length,
        sopTrainersAssigned,
        sopTrainersMissing: sopTrainersMissingList.length,
        sopTrainersMissingList,
        sop0TrainerCount: sop0TrainerList.length,
        sop1TrainerCount: sop1TrainerList.length,
        sop2PlusTrainerCount: sop2PlusTrainerList.length,
        sop0TrainerList,
        sop1TrainerList,
        sop2PlusTrainerList,
        missingFromExcel: missingFromExcelCodes.length,
        missingFromExcelList,
        trainersMissingList,
        trainerBySopCode: Object.fromEntries(codes.map((c) => [c, baseTrainerName.get(c) || '']).filter(([, v]) => v)),
        repeat3PlusCount: repeat3PlusList.length,
        repeat2Count: repeat2List.length,
        repeat1Count: repeat1List.length,
        repeat3PlusList,
        repeat2List,
        repeat1List,
        excelDeptSplit,
        sopCodes: [...excelCodes].sort((a, b) => a.localeCompare(b)),
        employeeCount: employees.length,
        fullyTrained,
        incomplete: employees.length - fullyTrained,
        monthCounts: excel?.monthCounts ?? {},
        employees,
      };
    };

    // 7. Per-department cards.
    const perDept: Record<string, ReturnType<typeof buildCard> & { uploaded: boolean; fileUrl: null; uploadedAt: null }> = {};
    const sopCodesByDept: Record<string, string[]> = {};
    const sopMonthMapByDept: Record<string, Record<string, string>> = {};
    const monthCountsByDept: Record<string, Record<string, number>> = {};
    for (const dept of departments) {
      const codes = codesByDept[dept] || [];
      const excel = excelByDept.get(dept) || null;
      const card = buildCard(codes, dept, excel);
      for (const e of card.employees) allExcelEmployees.push(e);
      sopCodesByDept[dept] = card.sopCodes;
      sopMonthMapByDept[dept] = excel?.sopMonthMap ?? {};
      const deptMonthCounts = monthCountsFromSchedule(excel);
      monthCountsByDept[dept] = deptMonthCounts;
      perDept[dept] = {
        ...card,
        monthCounts: deptMonthCounts,
        uploaded: excel?.uploaded ?? false,
        fileUrl: (excel?.fileUrl ?? null) as null,
        uploadedAt: (excel?.uploadedAt ?? null) as null,
        ...(excel?.fileName ? { fileName: excel.fileName } : {}),
      };
    }

    // 8. Total card — aggregate Excel data across all departments.
    const allCodes = [...dbBaseSet].sort((a, b) => a.localeCompare(b));
    const totalExcel: DeptExcel = {
      uploaded: excelByDept.size > 0,
      fileUrl: null, uploadedAt: null,
      excelCodes: new Set<string>(),
      employees: allExcelEmployees,
      monthCounts: {},
      sopMonthMap: {},
    };
    for (const ex of excelByDept.values()) {
      for (const c of ex.excelCodes) totalExcel.excelCodes.add(c);
      for (const [m, n] of Object.entries(ex.monthCounts)) totalExcel.monthCounts[m] = (totalExcel.monthCounts[m] || 0) + n;
      Object.assign(totalExcel.sopMonthMap, ex.sopMonthMap);
    }
    const totalBase = buildCard(allCodes, 'Total', totalExcel);
    const dbSopsByDept: Record<string, Array<{
      sopCode: string;
      title: string;
      gujaratiName?: string;
      isDualLanguage: boolean;
    }>> = {};
    const dbSopCountsByDept: Record<string, number> = {};
    for (const dept of departments) {
      const codes = codesByDept[dept] || [];
      dbSopsByDept[dept] = codes.map((c) => {
        const meta = dbBaseMeta.get(c)!;
        return {
          sopCode: c,
          title: meta.title,
          gujaratiName: meta.gujaratiName,
          isDualLanguage: meta.isDualLanguage,
        };
      });
      dbSopCountsByDept[dept] = codes.length;
    }
    const departmentCount = departments.filter((d) => (codesByDept[d] || []).length > 0).length;
    const uploadedDepartmentCount = departments.filter((d) => excelByDept.has(d)).length;

    const totalCard = {
      ...totalBase,
      dbSopCount: dbBaseSet.size,
      dbSopsByDept,
      dbSopCountsByDept,
      excelSopCount: totalBase.foundInDb,
      missingSopCount: totalBase.missingFromExcel,
      departmentCount,
      uploadedDepartmentCount,
      totalDepartments: departments.length,
    };

    const payload = {
      success: true,
      departments,
      perDept,
      totalCard,
      employees: allExcelEmployees,
      sopCodesByDept,
      sopMonthMapByDept,
      monthCountsByDept,
      sopStatusByCode,
      dbDocPathsByCode,
    };
    return payload;
}
