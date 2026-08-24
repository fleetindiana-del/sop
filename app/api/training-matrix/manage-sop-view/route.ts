import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import MatrixSOPAssignment from "@/models/MatrixSOPAssignment";
import TrainingMatrixRecord from "@/models/TrainingMatrixRecord";
import TrainingMatrixUpload from "@/models/TrainingMatrixUpload";
import Employee from "@/models/Employee";
import { getDashboardSopsCache } from "@/lib/dashboardSopsCache";
import {
  getDashboardRegistryPayload,
  getGroupedRegistryRows,
} from "@/lib/dashboardRegistrySource";
import {
  getTrainingMatrixCached as getTrainingMatrixOverviewCached,
  invalidateTrainingMatrixCache,
  setTrainingMatrixCached,
} from "@/lib/trainingMatrixCache";
import { computeOverviewPayload } from "@/app/api/training-matrix/overview/route";
import { invalidateInductionTrainingMatrixCache } from "@/lib/inductionTrainingMatrixCache";
import {
  getEmployeeAssignmentsMap,
  employeeAssignmentMapKey,
} from "@/lib/employeeAssignments";
import {
  getManageSopViewCacheEntry,
  getManageSopViewMemoryEntry,
  invalidateManageSopViewCache,
  runManageSopViewRebuildSingleflight,
  setManageSopViewCached,
} from "@/lib/manageSopViewCache";
import { bustTrainerScheduleCaches } from "@/lib/lmsTrainerCache";
import { filterPrimaryRegistryRowsUniqueByFamily } from "@/lib/registryPrimaryRows";
import {
  expandSopIdentifierVariants,
  sopBaseDisplayFromIdentifier,
  sopFamilyKeyFromIdentifier,
  sopCodeMatchesSearch,
} from "@/lib/sopIdentifierNormalize";
import {
  getTrainingMatrixDepartments,
} from "@/lib/trainingMatrixDepartments.server";
import {
  resolveTrainingMatrixDepartment,
  canonTrainingMatrixDepartment,
} from "@/lib/trainingMatrixDepartments";
import { resolveTrainerDepartments } from "@/lib/employeeTrainer";
import SOP from "@/models/SOP";
import { getLeftEmployeeKeys, isLeftEmployee } from "@/lib/leftEmployees";

const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MANAGE_SOP_API_LOG = "[manage-sop][api]";

function hasUnassignedEmployeesPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  return Array.isArray((payload as { unassignedEmployees?: unknown }).unassignedEmployees);
}

function nowMs(): number {
  if (
    typeof performance !== "undefined" &&
    typeof performance.now === "function"
  ) {
    return performance.now();
  }
  return Date.now();
}

function elapsedMs(startMs: number): number {
  return Number((nowMs() - startMs).toFixed(1));
}

// Same revision stripping as training-matrix/overview (dbSopCount universe).
function stripVersion(code: string): string {
  return String(code || "")
    .toUpperCase()
    .replace(/-\d+$/, "")
    .trim();
}

/** Map internal base keys (QAGE4) to registry display codes (QAGE04). */
function buildSopDisplayCodeMaps(registryRows: Array<{ sopNo?: string; identifier?: string }>) {
  const displayByStripBase = new Map<string, string>();
  const displayByFamilyKey = new Map<string, string>();

  for (const row of registryRows) {
    const id = String(row?.sopNo || row?.identifier || "").trim();
    if (!id) continue;
    const display = sopBaseDisplayFromIdentifier(id);
    const fk = sopFamilyKeyFromIdentifier(id);
    if (fk) displayByFamilyKey.set(fk, display);
    for (const variant of expandSopIdentifierVariants(id)) {
      const base = stripVersion(variant);
      if (base) displayByStripBase.set(base.toUpperCase(), display);
    }
  }

  const resolveDisplaySopCode = (code: string): string => {
    const upper = String(code || "").trim().toUpperCase();
    if (!upper) return "";
    const direct = displayByStripBase.get(upper);
    if (direct) return direct;
    const fk =
      sopFamilyKeyFromIdentifier(upper) ||
      sopFamilyKeyFromIdentifier(`${upper}-0`);
    if (fk) {
      const fromFamily = displayByFamilyKey.get(fk);
      if (fromFamily) return fromFamily;
    }
    return sopBaseDisplayFromIdentifier(upper) || upper;
  };

  return { resolveDisplaySopCode };
}

function resolveActiveMatrixYear(
  uploads: Array<{ year?: number }>,
): number {
  const fallback = new Date().getFullYear();
  let max = fallback;
  for (const up of uploads) {
    const y = Number(up?.year);
    if (Number.isInteger(y) && y >= 2000 && y <= fallback + 1) {
      max = Math.max(max, y);
    }
  }
  return max;
}

function buildRecordMatch(
  yearAll: boolean,
  year: number,
  activeYear: number,
): Record<string, unknown> {
  const match: Record<string, unknown> = { status: { $ne: "na" } };
  // year=all scopes to the active matrix year — scanning every historical row
  // is too slow on remote MongoDB and is not what the live matrix UI reflects.
  match.year = yearAll ? activeYear : year;
  return match;
}

// Keep designation matching resilient across historical data formats:
// - full names: "Sr Executive"
// - short codes: "SE"
// - packed strings: "SE, EX, CH"
function desigAbbr(designation: string): string {
  const cleaned = String(designation || "")
    .replace(/[^a-zA-Z ]/g, "")
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
}

function normalizeDesignationToken(input: string): string {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Full name + 2-letter abbr tokens so "Sr Executive" matches "SE" and vice versa. */
function designationMatchTokens(input: string): string[] {
  const raw = String(input || "").trim();
  if (!raw) return [];
  const tokens = new Set<string>();
  for (const part of raw.split(/[;,/|]/).map((p) => p.trim()).filter(Boolean)) {
    const full = normalizeDesignationToken(part);
    if (full) tokens.add(full);
    const abbr = normalizeDesignationToken(desigAbbr(part));
    if (abbr) tokens.add(abbr);
  }
  return Array.from(tokens);
}

function designationSetsOverlap(
  left: string | string[],
  right: string | string[],
): boolean {
  const a = new Set(
    (Array.isArray(left) ? left : [left]).flatMap(designationMatchTokens),
  );
  if (a.size === 0) return false;
  for (const t of (Array.isArray(right) ? right : [right]).flatMap(
    designationMatchTokens,
  )) {
    if (t && a.has(t)) return true;
  }
  return false;
}

type SnapshotEmployee = {
  name?: string;
  designation?: string;
  training?: Record<string, boolean>;
};

function snapshotEmployeeNameKey(name: string): string {
  return String(name || "").trim().toLowerCase();
}

function escapeRegExp(value: string): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertSnapshotEmployeeTraining(
  employees: SnapshotEmployee[],
  name: string,
  designation: string,
  sopCode: string,
  assigned: boolean,
): void {
  const key = snapshotEmployeeNameKey(name);
  if (!key || !sopCode) return;
  let emp = employees.find(
    (row) => snapshotEmployeeNameKey(String(row?.name || "")) === key,
  );
  if (!emp) {
    emp = {
      name: String(name || "").trim(),
      designation: String(designation || "").trim(),
      training: {},
    };
    employees.push(emp);
  }
  if (!emp.training) emp.training = {};
  if (assigned) emp.training[sopCode] = true;
  else delete emp.training[sopCode];
  if (designation && !emp.designation) emp.designation = designation;
}

/**
 * Clear one named employee's training flag for a SOP, matching on the version-
 * stripped code so "QAGE115-02" also clears a flag stored as "QAGE115".
 */
function clearSnapshotEmployeeTraining(
  employees: SnapshotEmployee[],
  name: string,
  sopCode: string,
): void {
  const key = snapshotEmployeeNameKey(name);
  const base = stripVersion(sopCode);
  if (!key || !base) return;
  const emp = employees.find(
    (row) => snapshotEmployeeNameKey(String(row?.name || "")) === key,
  );
  if (!emp?.training) return;
  for (const code of Object.keys(emp.training)) {
    if (stripVersion(code) === base) delete emp.training[code];
  }
}

type RosterEmployee = {
  name: string;
  designation: string;
  isTrainer?: boolean;
  assignedSopCodes?: string[];
};

export interface SOPViewDesignationStat {
  designation: string;
  isAssigned: boolean;
  count: number;
}

export interface SOPViewDeptStat {
  department: string;
  isAssigned: boolean;
  designations: SOPViewDesignationStat[];
  monthlyCounts: Record<number, number>;
  total: number;
  // Schedule data: which month (1–12) this SOP runs in for this dept, per
  // TrainingMatrixUpload.snapshot.sopMonthMap. null when not scheduled.
  scheduledMonth: number | null;
  isScheduled: boolean;
}

export interface SOPViewRow {
  sopCode: string;
  /** Registry-aligned document code for UI (e.g. QAGE04 vs internal QAGE4). */
  displaySopCode?: string;
  sopName: string;
  gujaratiName?: string;
  isDualLanguage?: boolean;
  primaryDepartment: string;
  deptStats: SOPViewDeptStat[];
  grandTotal: number;
}

export interface ManageSOPViewResponse {
  sops: SOPViewRow[];
  departments: string[];
  designationsByDept: Record<string, string[]>;
  employeeCountsByDeptDesig: Record<string, Record<string, number>>;
  // Resolved employee roster per department — name + designation, sorted by name.
  // Used by the page's Employees view to render names in place of designation abbreviations.
  employeesByDept: Record<string, RosterEmployee[]>;
  // Active employees with no SOP training assignments (same source as employee master).
  unassignedEmployees: Array<{ name: string; designation: string; department: string }>;
  stats: {
    total: number;
    assigned: number;
    unassigned: number;
    unassignedEmployees: number;
  };
  // sopCountsByDeptMonth[dept][month1to12] = number of SOPs scheduled in that (dept, month)
  // Pre-computed server-side so the client can render the per-row month cells without
  // recomputing on every checkbox click.
  sopCountsByDeptMonth: Record<string, Record<number, number>>;
  // sopCountsByMonth[month1to12] = number of SOPs scheduled in any dept in that month
  sopCountsByMonth: Record<number, number>;
  // sopCountsByDept[dept] = number of SOPs scheduled in that dept (any month)
  sopCountsByDept: Record<string, number>;
  // Base SOP codes that the main training-matrix page counts as "missing from Excel"
  // (i.e. the canonical unassigned list — sourced from the overview API). Used by the
  // Manage SOP page so the unassigned card and its filter use the same set the main
  // page counts.
  unassignedSopCodes: string[];
  // Cells the user has explicitly allocated through this page (records inserted with
  // sourceFile='manage-sop-manual'). Shape: { sopCode: { dept: [month1, month2, ...] } }.
  // Used by the UI to keep ONLY the user-allocated cells highlighted after a refresh —
  // unrelated historical training records do NOT trigger the highlight.
  manualAllocations: Record<string, Record<string, number[]>>;
  // Designations the user explicitly assigned per (sopCode, dept) when allocating
  // a manual training record. Lets the UI tick the matching designation checkboxes
  // after a refresh — the MatrixSOPAssignment fallback alone misses these because
  // manual allocations don't write to MatrixSOPAssignment.
  manualDesignations: Record<string, Record<string, string[]>>;
  year: number | "all";
}

export const dynamic = "force-dynamic";

// Snapshot is considered fresh for this long. Older-but-present snapshots are
// still served instantly while a background recompute refreshes them (SWR), so
// users never block on the heavy rebuild.
const MANAGE_SOP_FRESH_TTL_MS = 10 * 60 * 1000;

async function revalidateManageSopViewInBackground(
  request: NextRequest,
  ctx: {
    cacheYear: number | "all";
    search: string;
    yearAll: boolean;
    year: number;
    reqStartMs: number;
    forceFresh: boolean;
  },
): Promise<void> {
  try {
    await runManageSopViewRebuildSingleflight(ctx.cacheYear, ctx.search, () =>
      buildManageSopViewResponse(request, ctx),
    );
  } catch (err) {
    console.error(
      `${MANAGE_SOP_API_LOG} background revalidate FAILED year=${ctx.cacheYear} search="${ctx.search}"`,
      err,
    );
  }
}

/** When a rebuild times out or throws, serve the last good snapshot instead of 500. */
async function tryServeStaleManageSopViewFallback(
  cacheYear: number | "all",
  search: string,
  reqStartMs: number,
  cause: unknown,
): Promise<NextResponse | null> {
  try {
    const mem = getManageSopViewMemoryEntry(cacheYear, search);
    if (mem && hasUnassignedEmployeesPayload(mem.payload)) {
      console.warn(
        `${MANAGE_SOP_API_LOG} GET fallback=mem(stale) year=${cacheYear} search="${search}" totalMs=${elapsedMs(reqStartMs)}`,
        cause,
      );
      return NextResponse.json(mem.payload, { status: 200 });
    }
    await connectDB();
    const entry = await getManageSopViewCacheEntry(cacheYear, search);
    if (entry && hasUnassignedEmployeesPayload(entry.payload)) {
      console.warn(
        `${MANAGE_SOP_API_LOG} GET fallback=durable(stale) year=${cacheYear} search="${search}" totalMs=${elapsedMs(reqStartMs)}`,
        cause,
      );
      return NextResponse.json(entry.payload, { status: 200 });
    }
  } catch {
    // Fallback read failed too.
  }
  return null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const reqStartMs = nowMs();
  let cacheYear: number | "all" = "all";
  let search = "";
  try {
    const searchParams = request.nextUrl.searchParams;
    const yearParam = searchParams.get("year");
    const forceFresh = searchParams.get("refresh") === "1";
    // year=all (or omitted) → count training across every year, matching the source-of-truth
    // "main training matrix" view. A numeric year still scopes to that one year.
    const yearAll = !yearParam || yearParam === "all";
    const year = yearAll ? 0 : parseInt(yearParam) || new Date().getFullYear();
    search = searchParams.get("search")?.toLowerCase() || "";
    cacheYear = yearAll ? "all" : year;
    const ctx = { cacheYear, search, yearAll, year, reqStartMs, forceFresh };

    // Explicit refresh: recompute synchronously (single-flight dedups concurrent).
    // Never fall back to a pre-Update snapshot here — callers (Manage SOP Update)
    // treat a 200 as authoritative and would otherwise wipe just-saved ticks.
    if (forceFresh) {
      try {
        const response = await runManageSopViewRebuildSingleflight(cacheYear, search, () =>
          buildManageSopViewResponse(request, ctx),
        );
        return NextResponse.json(response, { status: 200 });
      } catch (error) {
        console.error(
          `${MANAGE_SOP_API_LOG} GET /api/training-matrix/manage-sop-view source=manage-sop refresh=1 FAILED totalMs=${elapsedMs(reqStartMs)}`,
          error,
        );
        return NextResponse.json(
          { error: "Failed to refresh SOP view data" },
          { status: 500 },
        );
      }
    }

    // Fast path: fresh memory hit, no DB round-trip.
    const mem = getManageSopViewMemoryEntry(cacheYear, search);
    if (
      mem &&
      Date.now() - mem.computedAt <= MANAGE_SOP_FRESH_TTL_MS &&
      hasUnassignedEmployeesPayload(mem.payload)
    ) {
      console.info(
        `${MANAGE_SOP_API_LOG} GET cache=HIT(mem,fresh) year=${cacheYear} search="${search}" totalMs=${elapsedMs(reqStartMs)}`,
      );
      return NextResponse.json(mem.payload, { status: 200 });
    }

    // Connect so the durable (Mongo) snapshot fallback is reachable.
    await connectDB();
    const entry = mem || (await getManageSopViewCacheEntry(cacheYear, search));
    if (entry && hasUnassignedEmployeesPayload(entry.payload)) {
      // Serve immediately. If stale, refresh in the background — the user never waits.
      const age = Date.now() - (entry.computedAt || 0);
      if (age > MANAGE_SOP_FRESH_TTL_MS) {
        void revalidateManageSopViewInBackground(request, ctx);
      }
      console.info(
        `${MANAGE_SOP_API_LOG} GET cache=HIT(${age > MANAGE_SOP_FRESH_TTL_MS ? "stale,revalidating" : "fresh"}) year=${cacheYear} search="${search}" totalMs=${elapsedMs(reqStartMs)}`,
      );
      return NextResponse.json(entry.payload, { status: 200 });
    }

    // Nothing cached anywhere: compute now (single-flight dedups concurrent cold loads).
    const response = await runManageSopViewRebuildSingleflight(cacheYear, search, async () => {
      const warm = await getManageSopViewCacheEntry(cacheYear, search);
      if (warm) return warm.payload;
      return buildManageSopViewResponse(request, ctx);
    });

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    const fallback = await tryServeStaleManageSopViewFallback(
      cacheYear,
      search,
      reqStartMs,
      error,
    );
    if (fallback) return fallback;

    console.error(
      `${MANAGE_SOP_API_LOG} GET /api/training-matrix/manage-sop-view source=manage-sop FAILED totalMs=${elapsedMs(reqStartMs)}`,
      error,
    );
    return NextResponse.json(
      { error: "Failed to fetch SOP view data" },
      { status: 500 },
    );
  }
}

async function buildManageSopViewResponse(
  request: NextRequest,
  ctx: {
    cacheYear: number | "all";
    search: string;
    yearAll: boolean;
    year: number;
    reqStartMs: number;
    forceFresh: boolean;
  },
): Promise<ManageSOPViewResponse> {
    const { cacheYear, search, yearAll, year, reqStartMs, forceFresh } = ctx;
    const dbConnectStartMs = nowMs();
    await connectDB();
    const dbConnectMs = elapsedMs(dbConnectStartMs);

    // Live department list (core + custom dashboard depts like "abcd").
    const departments = await getTrainingMatrixDepartments();
    const ensureDept = (name: string) => {
      if (!departments.some((d) => d.toLowerCase() === name.toLowerCase())) {
        departments.push(name);
      }
    };

    const dataFetchStartMs = nowMs();
    // Light queries first — derive the active matrix year, then scope the heavy
    // TrainingMatrixRecord aggregation to that year only (year=all is not a
    // full-history scan; it matches the current upload snapshot year).
    const [
      assignments,
      employees,
      scheduleUploads,
      dashboardCached,
      overviewCached,
      employeeAssignmentsMap,
      leftKeys,
    ] = await Promise.all([
      MatrixSOPAssignment.find({ isActive: true })
        .select("sopCode sopName department designationApplicability")
        .lean(),
      Employee.find({ isActive: true })
        .select("department designation name isTrainer trainerDepartments")
        .lean(),
      TrainingMatrixUpload.find({ "snapshot.sopMonthMap": { $exists: true } })
        .select("department snapshot.sopMonthMap snapshot.employees uploadedAt year")
        .sort({ uploadedAt: -1 })
        .lean(),
      getDashboardSopsCache(),
      getTrainingMatrixOverviewCached(),
      getEmployeeAssignmentsMap(),
      getLeftEmployeeKeys(),
    ]);

    const activeYear = resolveActiveMatrixYear(
      scheduleUploads as Array<{ year?: number }>,
    );
    const recordMatch = buildRecordMatch(yearAll, year, activeYear);

    const [trainingAgg, manualRecords] = await Promise.all([
      TrainingMatrixRecord.aggregate([
        { $match: recordMatch },
        {
          $group: {
            _id: {
              sopCode: "$sopCode",
              department: "$department",
              designation: "$designation",
              month: "$month",
              employeeName: "$employeeName",
            },
            count: { $sum: 1 },
          },
        },
      ]),
      TrainingMatrixRecord.find({
        ...recordMatch,
        sourceFile: "manage-sop-manual",
      })
        .select("sopCode department month designation")
        .lean(),
    ]);
    const dataFetchMs = elapsedMs(dataFetchStartMs);

    // Build dept → baseSopCode → monthNums (1..12) schedule map.
    // Multiple uploads per dept are merged; the most recent upload wins per (dept, sopCode).
    const scheduleMap = new Map<string, Map<string, number[]>>();
    for (const dept of departments) scheduleMap.set(dept, new Map());

    const normalizeDept = (raw: string | undefined | null): string | null => {
      const resolved = resolveTrainingMatrixDepartment(raw, departments);
      if (!resolved) return null;
      ensureDept(resolved);
      if (!scheduleMap.has(resolved)) scheduleMap.set(resolved, new Map());
      return resolved;
    };

    const monthNamesToNums = (raw: string): number[] => {
      const nums: number[] = [];
      for (const part of String(raw)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        const idx = MONTH_NAMES.findIndex(
          (m) => m && m.toLowerCase() === part.toLowerCase(),
        );
        if (idx > 0) nums.push(idx);
      }
      return nums;
    };

    for (const upload of scheduleUploads as any[]) {
      const dept = normalizeDept(upload?.department);
      if (!dept) continue;
      const deptSched = scheduleMap.get(dept)!;
      const sopMonthMap = upload?.snapshot?.sopMonthMap;
      if (!sopMonthMap) continue;
      for (const [rawKey, monthName] of Object.entries(sopMonthMap)) {
        const base = stripVersion(String(rawKey)).toUpperCase();
        if (!base) continue;
        if (deptSched.has(base)) continue; // latest upload wins
        const monthNums = monthNamesToNums(String(monthName));
        if (monthNums.length === 0) continue;
        deptSched.set(base, monthNums);
      }
    }

    // Pull the resolved registry rows from the dashboard payload.
    // Prefer cache, but fall back to on-demand compute if cache is cold so the
    // canonical SOP universe (427) is still correct (especially on refresh=1).
    let registryRows: any[] = [];
    try {
      let dashboard = (dashboardCached?.payload || null) as {
        success?: boolean;
        data?: any[];
      } | null;
      if (
        !dashboard ||
        !Array.isArray(dashboard?.data) ||
        dashboard.data.length === 0
      ) {
        dashboard = await getDashboardRegistryPayload();
      }
      registryRows = Array.isArray(dashboard?.data) ? dashboard.data : [];
    } catch {
      registryRows = [];
    }

    let groupedRegistryRows: Awaited<ReturnType<typeof getGroupedRegistryRows>> =
      [];
    if (registryRows.length === 0) {
      groupedRegistryRows = await getGroupedRegistryRows();
    }

    // Hydrate overview once up-front (needed for dbSop universe + unassigned counts).
    // On a forced refresh (e.g. right after a Manage SOP save) the cached overview
    // is stale — its missingFromExcel/assigned lists still reflect the pre-save
    // snapshot. getTrainingMatrixOverviewCached() returns that stale payload as-is,
    // so the unassigned/assigned counts would never move. Recompute the overview
    // synchronously via ?refresh=1 so this view AND the training-matrix page (which
    // reads the same overview snapshot) both reflect the new assignment.
    let overviewData: any = forceFresh ? null : overviewCached;
    if (!overviewData?.totalCard?.dbSopsByDept) {
      try {
        // In-process rather than fetching our own /overview route: the loopback
        // request and the JSON round trip of a large payload were pure overhead
        // on the Update path. Caching it here also means the client's follow-up
        // overview GET is a cache hit instead of another recompute.
        overviewData = await computeOverviewPayload(forceFresh);
        await setTrainingMatrixCached(overviewData);
      } catch {
        // Non-fatal; fallbacks below still apply.
      }
    }

    // Canonical SOP universe — same family-unique filter the Training Matrix
    // overview applies to get `dbSopCount`. Without this, codes that exist only
    // in TrainingMatrixRecord / MatrixSOPAssignment / snapshots / SOPLibrary /
    // MasterSOPRepository but were rejected by the dashboard filter (artifact-
    // only placeholders, non-standard IDs, or other-revision dupes) inflate the
    // total above Training Matrix's number.
    // Why: total in this modal MUST equal dbSopCount on the main page.
    // How to apply: restrict `sops` below to bases in this set.
    const canonicalRows = filterPrimaryRegistryRowsUniqueByFamily(registryRows);
    const canonicalBaseSet = new Set<string>();
    for (const row of canonicalRows as any[]) {
      const id = String(row?.sopNo || row?.identifier || "").trim();
      if (!id) continue;
      const base = stripVersion(id);
      if (base) canonicalBaseSet.add(base);
    }

    // Exact DB SOP universe from Training Matrix overview (dbSopCount, e.g. 427).
    const overviewDbSopCodes = new Map<string, string>();
    const overviewByDept = (
      overviewData as {
        totalCard?: {
          dbSopsByDept?: Record<
            string,
            Array<{ sopCode?: string; title?: string }>
          >;
        };
      } | null
    )?.totalCard?.dbSopsByDept;
    if (overviewByDept) {
      for (const list of Object.values(overviewByDept)) {
        if (!Array.isArray(list)) continue;
        for (const item of list) {
          const base = stripVersion(String(item?.sopCode || ""));
          if (!base || overviewDbSopCodes.has(base)) continue;
          overviewDbSopCodes.set(base, String(item?.title || "").trim());
        }
      }
    }

    const { resolveDisplaySopCode } = buildSopDisplayCodeMaps([
      ...registryRows,
      ...(canonicalRows as Array<{ sopNo?: string; identifier?: string }>),
    ]);

    // Build designation set per department AND count employees per dept per designation,
    // plus the resolved roster (name + designation) used by the Employees view.
    const designationsByDept = new Map<string, Set<string>>();
    const empCountMap = new Map<string, Map<string, number>>();
    const empRoster = new Map<string, RosterEmployee[]>();
    for (const dept of departments) {
      designationsByDept.set(dept, new Set<string>());
      empCountMap.set(dept, new Map<string, number>());
      empRoster.set(dept, []);
    }
    for (const emp of employees as any[]) {
      if (!emp.department || !emp.designation) continue;
      const empDept =
        resolveTrainingMatrixDepartment(emp.department, departments) ||
        String(emp.department).trim();
      if (!empDept) continue;
      ensureDept(empDept);
      if (!designationsByDept.has(empDept)) {
        designationsByDept.set(empDept, new Set<string>());
        empCountMap.set(empDept, new Map<string, number>());
        empRoster.set(empDept, []);
      }
      const set = designationsByDept.get(empDept);
      if (set) set.add(emp.designation as string);
      const deptMap = empCountMap.get(empDept);
      if (deptMap)
        deptMap.set(
          emp.designation as string,
          (deptMap.get(emp.designation as string) ?? 0) + 1,
        );
      const name = String((emp as any).name || "").trim();
      const isTrainer = !!(emp as any).isTrainer;
      const homeRoster = empRoster.get(empDept);
      if (homeRoster && name) {
        homeRoster.push({
          name,
          designation: emp.designation as string,
          ...(isTrainer ? { isTrainer: true } : {}),
        });
      }

      // Trainers also appear under every eligible trainer department.
      if (isTrainer && name) {
        const trainerDepts = resolveTrainerDepartments({
          department: empDept,
          trainerDepartments: (emp as any).trainerDepartments,
          isTrainer: true,
        });
        for (const rawDept of trainerDepts) {
          const tDept =
            resolveTrainingMatrixDepartment(rawDept, departments) ||
            String(rawDept).trim();
          if (!tDept || tDept.toLowerCase() === empDept.toLowerCase()) continue;
          ensureDept(tDept);
          if (!designationsByDept.has(tDept)) {
            designationsByDept.set(tDept, new Set<string>());
            empCountMap.set(tDept, new Map<string, number>());
            empRoster.set(tDept, []);
          }
          const tRoster = empRoster.get(tDept);
          if (!tRoster) continue;
          if (tRoster.some((r) => r.name.toLowerCase() === name.toLowerCase())) continue;
          tRoster.push({
            name,
            designation: emp.designation as string,
            isTrainer: true,
          });
        }
      }
    }
    for (const list of empRoster.values()) {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }

    // Excel-snapshot employees who are not (yet) in the Employee collection still
    // belong on the Manage SOP roster — otherwise assigned names vanish from the list.
    const snapshotRosterSeen = new Set<string>();
    for (const up of scheduleUploads as Array<{
      department?: string;
      snapshot?: { employees?: Array<{ name?: string; designation?: string }> };
    }>) {
      const empDept =
        resolveTrainingMatrixDepartment(up.department, departments) ||
        String(up.department || "").trim();
      if (!empDept) continue;
      const seenKey = empDept.toLowerCase();
      if (snapshotRosterSeen.has(seenKey)) continue;
      snapshotRosterSeen.add(seenKey);
      ensureDept(empDept);
      if (!empRoster.has(empDept)) empRoster.set(empDept, []);
      const roster = empRoster.get(empDept)!;
      for (const snapEmp of up.snapshot?.employees || []) {
        const name = String(snapEmp?.name || "").trim();
        if (!name) continue;
        if (isLeftEmployee(leftKeys, empDept, name)) continue;
        if (roster.some((r) => r.name.toLowerCase() === name.toLowerCase())) continue;
        roster.push({
          name,
          designation: String(snapEmp?.designation || "").trim() || "—",
        });
      }
      roster.sort((a, b) => a.name.localeCompare(b.name));
    }

    const lookupAssignedSops = (dept: string, name: string): string[] => {
      const assigns =
        employeeAssignmentsMap.get(employeeAssignmentMapKey(dept, name)) ||
        employeeAssignmentsMap.get(`${dept}||${name}`.trim().toLowerCase()) ||
        [];
      return [
        ...new Set(
          assigns
            .map((a) => stripVersion(a.sopCode))
            .filter(Boolean),
        ),
      ];
    };

    for (const [dept, list] of empRoster) {
      for (const emp of list) {
        const codes = lookupAssignedSops(dept, emp.name);
        if (codes.length) emp.assignedSopCodes = codes;
      }
    }

    // Employees with zero SOP assignments — powers the Unassigned Employees card.
    // Trainers (isTrainer=true) are excluded: they manage all SOPs in their department
    // and are auto-assigned to every scheduled SOP regardless of designation.
    const unassignedEmployees: Array<{
      name: string;
      designation: string;
      department: string;
      isTrainer?: boolean;
    }> = [];
    for (const emp of employees as Array<{
      name?: string;
      designation?: string;
      department?: string;
      isTrainer?: boolean;
    }>) {
      const name = String(emp.name || "").trim();
      const designation = String(emp.designation || "").trim();
      if (!name || !designation || !emp.department) continue;
      const empDept =
        resolveTrainingMatrixDepartment(emp.department, departments) ||
        String(emp.department).trim();
      if (!empDept) continue;
      // Trainers manage all dept SOPs — skip them from unassigned list.
      if (emp.isTrainer) continue;
      const assigned =
        employeeAssignmentsMap.get(employeeAssignmentMapKey(empDept, name)) ||
        employeeAssignmentsMap.get(`${empDept}||${name}`.trim().toLowerCase()) ||
        employeeAssignmentsMap.get(
          `${String(emp.department || "").trim()}||${name}`.trim().toLowerCase(),
        );
      if (assigned && assigned.length > 0) continue;
      unassignedEmployees.push({ name, designation, department: empDept });
    }
    unassignedEmployees.sort((a, b) => {
      const deptCmp = a.department.localeCompare(b.department);
      if (deptCmp !== 0) return deptCmp;
      return a.name.localeCompare(b.name);
    });

    // Build training data map: sopCode → dept → designation → month → count
    const trainingMap = new Map<
      string,
      Map<string, Map<string, Map<number, number>>>
    >();
    for (const record of trainingAgg) {
      const id = record._id as any;
      if (isLeftEmployee(leftKeys, id.department, id.employeeName)) continue;
      const stripCode = stripVersion(id.sopCode || "");
      const trainDept =
        resolveTrainingMatrixDepartment(id.department, departments) ||
        String(id.department || "").trim();
      if (!trainDept) continue;
      ensureDept(trainDept);
      if (!trainingMap.has(stripCode)) {
        trainingMap.set(stripCode, new Map());
      }
      const deptMap = trainingMap.get(stripCode)!;
      if (!deptMap.has(trainDept)) {
        deptMap.set(trainDept, new Map());
      }
      const designationMap = deptMap.get(trainDept)!;
      if (!designationMap.has(id.designation)) {
        designationMap.set(id.designation, new Map());
      }
      const monthMap = designationMap.get(id.designation)!;
      // Multiple SOP versions (e.g. ABC01-01, ABC01-02) collapse to the same base code
      // after stripVersion — accumulate, don't overwrite, or counts get silently dropped.
      const month = id.month as number;
      const inc = (record.count as number) || 0;
      monthMap.set(month, (monthMap.get(month) || 0) + inc);
    }

    // Build assignment map: sopCode → dept → { designationApplicability, isAssigned }
    const assignmentMap = new Map<string, Map<string, string[]>>();
    for (const assignment of assignments) {
      const stripCode = stripVersion(assignment.sopCode);
      const assignDept =
        resolveTrainingMatrixDepartment(assignment.department, departments) ||
        String(assignment.department || "").trim();
      if (!assignDept) continue;
      ensureDept(assignDept);
      if (!assignmentMap.has(stripCode)) {
        assignmentMap.set(stripCode, new Map());
      }
      const deptMap = assignmentMap.get(stripCode)!;
      deptMap.set(
        assignDept,
        assignment.designationApplicability || [],
      );
    }

    // Clean a name string by taking the last path segment and stripping any leading "CODE-VV"
    // prefix. Handles values stored as folder paths like:
    //   "5. STORE/BSGE - BSR---/BSGE01-05/BSGE01-05_HANDLING AND DISTRIBUTION OF FINISHED GOODS"
    const cleanName = (raw: string | undefined | null): string => {
      if (!raw) return "";
      let s = String(raw).trim();
      if (!s) return "";
      // If a path, take the last meaningful segment
      if (s.includes("/")) {
        const parts = s
          .split("/")
          .map((p) => p.trim())
          .filter(Boolean);
        if (parts.length) s = parts[parts.length - 1];
      }
      // Strip leading code prefix: "BSGE01-05_", "BSGE01-05 - ", "MAGE02-06 "
      s = s.replace(/^[A-Za-z]+\d+(?:[-.]\d+)*[\s_-]*/, "").trim();
      return s;
    };

    // Map normalized DB department values back to the canonical names used by the UI.
    const normalizeDeptValue = (
      raw: string | undefined | null,
    ): string | null => {
      const resolved = resolveTrainingMatrixDepartment(raw, departments);
      if (!resolved) return null;
      ensureDept(resolved);
      return resolved;
    };

    // Build sopCode → primaryDepartment map from dashboard registry + SOP collection.
    const primaryDeptMap = new Map<string, string>();
    for (const row of registryRows) {
      const id = row?.sopNo || row?.identifier;
      if (!id) continue;
      const base = stripVersion(String(id)).toUpperCase();
      if (!base || primaryDeptMap.has(base)) continue;
      const dept = normalizeDeptValue(row?.department);
      if (dept) primaryDeptMap.set(base, dept);
    }
    for (const sop of groupedRegistryRows) {
      if (!sop?.identifier) continue;
      const base = stripVersion(String(sop.identifier)).toUpperCase();
      if (!base || primaryDeptMap.has(base)) continue;
      const dept = normalizeDeptValue(sop.department);
      if (dept) primaryDeptMap.set(base, dept);
    }

    // Build per-language SOP name map. Priority: dashboard registry > MasterSOPRepository >
    // SOPLibrary > SOP collection. Skip placeholder names like "<CODE> - Prior Version".
    type NameInfo = { englishName?: string; gujaratiName?: string };
    const nameMap = new Map<string, NameInfo>();

    const isPlaceholderName = (name: string): boolean => {
      if (!name) return true;
      const trimmed = name.trim();
      if (!trimmed) return true;
      if (/prior\s*version/i.test(trimmed)) return true;
      if (/^[-–—√✓✗×•·*]+$/.test(trimmed)) return true;
      return false;
    };

    // Gujarati script lives in Unicode block U+0A80..U+0AFF. Whenever a name actually
    // contains Gujarati characters, treat it as Gujarati regardless of the upstream
    // language label — some sources (training records, master repo) store Gujarati
    // text under language='English' or with no language at all, which previously caused
    // the same string to land in both fields and render duplicated.
    const hasGujaratiScript = (s: string): boolean => /[઀-૿]/.test(s);

    const recordName = (
      rawIdentifier: string,
      language: string | undefined,
      name: string | undefined,
    ) => {
      if (!rawIdentifier || !name) return;
      const cleaned = cleanName(name);
      if (!cleaned || isPlaceholderName(cleaned)) return;
      const base = stripVersion(String(rawIdentifier)).toUpperCase();
      if (!base) return;
      if (!nameMap.has(base)) nameMap.set(base, {});
      const entry = nameMap.get(base)!;
      const labelLang = String(language || "English").toLowerCase();
      const isGujaratiText = hasGujaratiScript(cleaned);
      // Script wins over label
      const lang = isGujaratiText
        ? "gujarati"
        : labelLang === "gujarati"
          ? "english"
          : labelLang;
      if (lang === "gujarati") {
        if (!entry.gujaratiName) entry.gujaratiName = cleaned;
      } else {
        if (!entry.englishName) entry.englishName = cleaned;
      }
    };

    const recordEnglish = (rawIdentifier: string, name: string | undefined) =>
      recordName(rawIdentifier, "English", name);
    const recordGujarati = (rawIdentifier: string, name: string | undefined) =>
      recordName(rawIdentifier, "Gujarati", name);

    // 1. Dashboard registry — highest priority (already resolves clean english/gujarati names)
    for (const row of registryRows) {
      const id = row?.sopNo || row?.identifier || row?.sopIdentifier;
      if (!id) continue;
      recordEnglish(id, row?.englishName || row?.sopName || row?.name);
      recordGujarati(id, row?.gujaratiName);
    }
    // 2. Grouped SOP registry
    for (const sop of groupedRegistryRows) {
      const lang =
        sop.language === "GUJ" ? "Gujarati" : sop.language === "ENG-GUJ" ? "English" : "English";
      recordName(sop.identifier, lang, sop.name);
      if (sop.nameGujarati) recordGujarati(sop.identifier, sop.nameGujarati);
    }

    const lookupName = (
      base: string,
    ): {
      englishName: string;
      gujaratiName: string;
      isDualLanguage: boolean;
    } => {
      const upper = base.toUpperCase();
      const info = nameMap.get(upper) || {};
      const englishName = info.englishName || "";
      const gujaratiName = info.gujaratiName || "";
      return {
        englishName,
        gujaratiName,
        isDualLanguage: !!(englishName && gujaratiName),
      };
    };

    // Legacy map kept for compatibility paths below — prefers english
    const sopNameMap = new Map<string, string>();
    for (const [base, info] of nameMap) {
      if (info.englishName) sopNameMap.set(base, info.englishName);
    }

    // Collect all unique SOPs from training matrix records and assignments
    const sopSet = new Map<string, string>(); // sopCode → sopName

    // Helper to check if code/name is valid
    const isValidSopCode = (code: string): boolean => {
      if (!code || code.trim() === "") return false;
      const trimmed = code.trim();
      // Filter out placeholder/invalid entries (dashes, checkmarks, etc.)
      if (/^[-–—√✓✗×•·*]+$/.test(trimmed)) return false;
      return true;
    };

    const isValidSopName = (name: string): boolean => {
      if (!name || name.trim() === "") return false;
      const trimmed = name.trim();
      // Filter out placeholder/invalid entries
      if (/^[-–—√✓✗×•·*]+$/.test(trimmed)) return false;
      return true;
    };

    // Pick the best english name for an SOP. Always strip path/code prefixes and reject placeholders.
    const resolveName = (stripCode: string, recordName?: string): string => {
      const resolved = sopNameMap.get(stripCode.toUpperCase());
      if (resolved) return resolved;
      const cleaned = cleanName(recordName);
      if (cleaned && !isPlaceholderName(cleaned)) return cleaned;
      return stripCode;
    };

    // Add SOPs from aggregated training records (actual matrix data)
    // using grouped keys, which avoids a second full collection scan.
    for (const row of trainingAgg as Array<{ _id: { sopCode?: string } }>) {
      const stripCode = stripVersion(String(row?._id?.sopCode || ""));
      const sopName = resolveName(stripCode);
      if (isValidSopCode(stripCode) && isValidSopName(sopName)) {
        sopSet.set(stripCode, sopName);
      }
    }

    // Add SOPs from assignments (in case they have no training records yet)
    for (const assignment of assignments) {
      const stripCode = stripVersion(assignment.sopCode);
      if (!sopSet.has(stripCode)) {
        const sopName = resolveName(stripCode, assignment.sopName);
        if (isValidSopCode(stripCode) && isValidSopName(sopName)) {
          sopSet.set(stripCode, sopName);
        }
      }
    }

    // Add SOPs from the schedule (sopMonthMap) — these are the planned-training SOPs even
    // if they have no records or assignments yet.
    for (const [, deptSched] of scheduleMap) {
      for (const base of deptSched.keys()) {
        if (sopSet.has(base)) continue;
        const sopName = resolveName(base);
        if (isValidSopCode(base) && isValidSopName(sopName)) {
          sopSet.set(base, sopName);
        }
      }
    }

    // Build rows from the same universe as Training Matrix dbSopCount (427), not from
    // sopSet (training/schedule/library extras can inflate to 436+).
    let canonicalEntries: Array<[string, string]>;
    if (overviewDbSopCodes.size > 0) {
      canonicalEntries = [];
      for (const [code, titleFromOverview] of overviewDbSopCodes) {
        const sopName = resolveName(code, titleFromOverview);
        if (!isValidSopCode(code) || !isValidSopName(sopName)) continue;
        canonicalEntries.push([code, sopName]);
      }
    } else if (canonicalRows.length > 0) {
      // Mirror overview `dbBaseSet`: one row per stripVersion(base), not per registry row.
      canonicalEntries = [];
      const seenBases = new Set<string>();
      for (const row of canonicalRows as any[]) {
        const sopNo = String(row?.sopNo || row?.identifier || "").trim();
        const code = stripVersion(sopNo);
        if (!code || seenBases.has(code)) continue;
        seenBases.add(code);
        const sopName = resolveName(
          code,
          row?.englishName || row?.sopName || row?.name,
        );
        if (!isValidSopCode(code) || !isValidSopName(sopName)) continue;
        canonicalEntries.push([code, sopName]);
      }
    } else {
      canonicalEntries = Array.from(sopSet.entries());
    }

    // Apply search filter (match display codes too: QCMI1 ↔ QCMI01)
    const filteredSOPs = canonicalEntries.filter(([code, name]) => {
      if (!search) return true;
      return (
        sopCodeMatchesSearch(search, code, resolveDisplaySopCode(code)) ||
        name.toLowerCase().includes(search)
      );
    });

    // Build response rows
    const sops: SOPViewRow[] = filteredSOPs.map(([sopCode, sopName]) => {
      const deptStats: SOPViewDeptStat[] = departments.map((dept) => {
        const deptAssignmentsRaw = assignmentMap.get(sopCode)?.get(dept) || [];
        const deptAssignments = deptAssignmentsRaw
          .flatMap((v) => String(v || "").split(/[;,/|]/))
          .map((v) => v.trim())
          .filter(Boolean);
        const isAssigned = deptAssignments.length > 0;
        const assignedTokens = new Set(
          deptAssignments.map(normalizeDesignationToken),
        );

        const designationTraining =
          trainingMap.get(sopCode)?.get(dept) ||
          new Map<string, Map<number, number>>();
        const designations: SOPViewDesignationStat[] = Array.from(
          designationsByDept.get(dept) || new Set<string>(),
        ).map((designation: string): SOPViewDesignationStat => {
          const monthCounts =
            designationTraining.get(designation) || new Map<number, number>();
          const count: number = Array.from(monthCounts.values()).reduce(
            (a: number, b: number) => a + b,
            0,
          );
          const designationToken = normalizeDesignationToken(designation);
          const designationAbbrToken = normalizeDesignationToken(
            desigAbbr(designation),
          );
          return {
            designation,
            isAssigned:
              assignedTokens.has(designationToken) ||
              assignedTokens.has(designationAbbrToken),
            count,
          };
        });

        const monthlyCounts: Record<number, number> = {};
        for (let m = 1; m <= 12; m++) {
          let monthTotal = 0;
          for (const designationMap of designationTraining.values()) {
            monthTotal += designationMap.get(m) || 0;
          }
          monthlyCounts[m] = monthTotal;
        }

        const total = Object.values(monthlyCounts).reduce((a, b) => a + b, 0);

        // Schedule:
        //   1) Prefer the explicit schedule from TrainingMatrixUpload.snapshot.sopMonthMap
        //   2) Otherwise, treat the earliest month with records as the scheduled month
        // An SOP counts as scheduled for a dept if any of the following are true:
        //   - It appears in that dept's schedule snapshot
        //   - It has training records in that dept (total > 0)
        //   - It is assigned to that dept via MatrixSOPAssignment
        const schedMonths =
          scheduleMap.get(dept)?.get(sopCode.toUpperCase()) || [];
        let scheduledMonth: number | null = schedMonths[0] ?? null;
        if (!scheduledMonth) {
          for (let m = 1; m <= 12; m++) {
            if (monthlyCounts[m] && monthlyCounts[m] > 0) {
              scheduledMonth = m;
              break;
            }
          }
        }
        const isScheduled = !!scheduledMonth || isAssigned || total > 0;

        return {
          department: dept,
          isAssigned,
          designations,
          monthlyCounts,
          total,
          scheduledMonth,
          isScheduled,
        };
      });

      const grandTotal = deptStats.reduce((sum, ds) => sum + ds.total, 0);
      const nameInfo = lookupName(sopCode);
      // Always prefer the resolved english name; fall back to whatever resolveName returned (already cleaned).
      const finalEnglish =
        nameInfo.englishName || cleanName(sopName) || sopCode;
      // Only attach gujarati when we have a real english name + a real gujarati name (no gujarati-only rows).
      const gujarati =
        nameInfo.englishName && nameInfo.gujaratiName
          ? nameInfo.gujaratiName
          : undefined;

      // Primary department: from MasterSOPRepository / SOPLibrary if known,
      // otherwise from assignments — the dept with the most assigned designations.
      let primaryDepartment = primaryDeptMap.get(sopCode.toUpperCase()) || "";
      if (!primaryDepartment) {
        let bestDept = "";
        let bestScore = -1;
        for (const ds of deptStats) {
          const score = ds.designations.filter((d) => d.isAssigned).length;
          if (score > bestScore) {
            bestScore = score;
            bestDept = ds.department;
          }
        }
        if (bestScore > 0) primaryDepartment = bestDept;
      }

      return {
        sopCode,
        displaySopCode: resolveDisplaySopCode(sopCode),
        sopName: finalEnglish,
        gujaratiName: gujarati,
        isDualLanguage: !!gujarati,
        primaryDepartment,
        deptStats,
        grandTotal,
      };
    });

    const overviewDbSopCount = (
      overviewData as { totalCard?: { dbSopCount?: number } } | null
    )?.totalCard?.dbSopCount;
    const totalSOPs =
      typeof overviewDbSopCount === "number" && overviewDbSopCount > 0
        ? overviewDbSopCount
        : overviewDbSopCodes.size > 0
          ? overviewDbSopCodes.size
          : canonicalBaseSet.size > 0
            ? canonicalBaseSet.size
            : canonicalEntries.length;
    let overviewUnassignedCount = 0;
    const unassignedSopCodes = new Set<string>();
    try {
      const overviewJson = (overviewData || null) as {
        totalCard?: {
          missingFromExcelList?: Array<{ sopCode?: string }>;
          missingSopCount?: number;
        };
      } | null;
      // Unassigned = DB SOPs absent from EVERY Excel upload (global), exactly the
      // set the main Training Matrix "Unassigned / Missing" red count uses. Summing
      // each dept's own-Excel misses double-counts SOPs assigned in another dept's
      // Excel, which inflated this number (e.g. 43 instead of 9).
      const totalCard = overviewJson?.totalCard;
      const globalMissingList = Array.isArray(totalCard?.missingFromExcelList)
        ? totalCard!.missingFromExcelList!
        : [];
      for (const item of globalMissingList) {
        const code = stripVersion(String(item?.sopCode || "")).toUpperCase();
        if (code) unassignedSopCodes.add(code);
      }
      overviewUnassignedCount =
        Number(totalCard?.missingSopCount) || globalMissingList.length;
    } catch {
      // Overview unavailable — fall back to 0 rather than diverging numbers.
      overviewUnassignedCount = 0;
    }
    // Prefer the actual missing-code list size (same set the filter uses).
    const unassignedSOPs =
      unassignedSopCodes.size > 0 ? unassignedSopCodes.size : overviewUnassignedCount;

    // Convert designationsByDept to plain object
    const designationsByDeptObj: Record<string, string[]> = {};
    for (const [dept, set] of designationsByDept) {
      designationsByDeptObj[dept] = Array.from(set).sort();
    }

    // Convert employeeCountsByDeptDesig to plain object
    const employeeCountsByDeptDesigObj: Record<
      string,
      Record<string, number>
    > = {};
    for (const [dept, dMap] of empCountMap) {
      employeeCountsByDeptDesigObj[dept] = Object.fromEntries(dMap);
    }

    const employeesByDeptObj: Record<string, RosterEmployee[]> = {};
    for (const [dept, list] of empRoster) {
      employeesByDeptObj[dept] = list;
    }

    // Custom department order from the live list. SOPs with no resolvable primary dept go last.
    const deptOrder = new Map<string, number>(
      departments.map((d, i) => [d, i]),
    );
    const deptRank = (sop: SOPViewRow): number => {
      // Prefer the SOP's registry-based primary department; otherwise the first dept it counts for.
      if (sop.primaryDepartment && deptOrder.has(sop.primaryDepartment)) {
        return deptOrder.get(sop.primaryDepartment)!;
      }
      for (const ds of sop.deptStats) {
        if (ds.isScheduled || ds.isAssigned || (ds.total || 0) > 0) {
          const idx = deptOrder.get(ds.department);
          if (idx !== undefined) return idx;
        }
      }
      return departments.length; // unknown → last
    };

    // Pre-compute schedule SOP counts per (dept, month) DIRECTLY from the snapshot
    // upload data — same source-of-truth used by /api/training-matrix/overview. This
    // ensures the per-dept totals here match the main training-matrix card sums (702),
    // not 704 (which leaks SOPs picked up via training-record fallback).
    const sopCountsByDeptMonth: Record<string, Record<number, number>> = {};
    const sopCountsByMonth: Record<number, number> = {};
    const sopCountsByDept: Record<string, number> = {};
    for (const dept of departments) {
      sopCountsByDeptMonth[dept] = {};
      for (let m = 1; m <= 12; m++) sopCountsByDeptMonth[dept][m] = 0;
      sopCountsByDept[dept] = 0;
    }
    for (let m = 1; m <= 12; m++) sopCountsByMonth[m] = 0;
    const monthSopSeen = new Map<number, Set<string>>();
    for (let m = 1; m <= 12; m++) monthSopSeen.set(m, new Set());

    for (const dept of departments) {
      const sched = scheduleMap.get(dept);
      if (!sched) continue;
      for (const [, monthNums] of sched) {
        if (!monthNums.length) continue;
        sopCountsByDept[dept] = (sopCountsByDept[dept] || 0) + 1;
        const primaryMonth = monthNums[0];
        sopCountsByDeptMonth[dept][primaryMonth] =
          (sopCountsByDeptMonth[dept][primaryMonth] || 0) + 1;
      }
    }
    // Distinct SOPs per month across all depts (for the Σ row) — primary month only.
    for (const [, sched] of scheduleMap) {
      const localSeen = new Map<number, Set<string>>();
      for (const [base, monthNums] of sched) {
        if (!monthNums.length) continue;
        const monthNum = monthNums[0];
        if (!localSeen.has(monthNum)) localSeen.set(monthNum, new Set());
        localSeen.get(monthNum)!.add(base);
      }
      for (const [m, codes] of localSeen) {
        const seen = monthSopSeen.get(m)!;
        for (const c of codes) {
          if (!seen.has(c)) {
            seen.add(c);
            sopCountsByMonth[m] += 1;
          }
        }
      }
    }

    // Assigned = sum of all (sop, dept) scheduled entries = sum of dept totals (e.g. 702)
    const assignedCount = Object.values(sopCountsByDept).reduce(
      (a, b) => a + b,
      0,
    );

    // Build manual-allocation map from records inserted via the Manage SOP page.
    // Key by the SAME base sop code the UI uses (stripVersion + uppercase).
    const manualAllocations: Record<string, Record<string, number[]>> = {};
    const manualDesigSets: Record<string, Record<string, Set<string>>> = {};
    for (const r of manualRecords as Array<{
      sopCode?: string;
      department?: string;
      month?: number;
      designation?: string;
    }>) {
      const code = stripVersion(String(r.sopCode || "")).toUpperCase();
      const dept = r.department;
      const month = r.month;
      const designation = (r.designation || "").trim();
      if (!code || !dept || !Number.isInteger(month)) continue;
      if (!manualAllocations[code]) manualAllocations[code] = {};
      if (!manualAllocations[code][dept]) manualAllocations[code][dept] = [];
      if (!manualAllocations[code][dept].includes(month as number)) {
        manualAllocations[code][dept].push(month as number);
      }
      if (designation) {
        if (!manualDesigSets[code]) manualDesigSets[code] = {};
        if (!manualDesigSets[code][dept])
          manualDesigSets[code][dept] = new Set();
        manualDesigSets[code][dept].add(designation);
      }
    }
    const manualDesignations: Record<string, Record<string, string[]>> = {};
    for (const [code, byDept] of Object.entries(manualDesigSets)) {
      manualDesignations[code] = {};
      for (const [dept, set] of Object.entries(byDept)) {
        manualDesignations[code][dept] = Array.from(set);
      }
    }

    // Reflect manage-sop-manual designation picks in each row's deptStats so reload
    // shows the same ticks as the grid (not only via the separate manualDesignations map).
    for (const sop of sops) {
      const code = stripVersion(sop.sopCode).toUpperCase();
      const byDept = manualDesignations[code];
      if (!byDept) continue;
      for (const ds of sop.deptStats) {
        const manualDesigs = byDept[ds.department];
        if (!manualDesigs?.length) continue;
        for (const desig of manualDesigs) {
          const existing = ds.designations.find((d) => d.designation === desig);
          if (existing) {
            existing.isAssigned = true;
          } else {
            ds.designations.push({ designation: desig, isAssigned: true, count: 0 });
          }
        }
      }
    }

    const responseBuildStartMs = nowMs();
    const response: ManageSOPViewResponse = {
      sops: sops.sort((a: SOPViewRow, b: SOPViewRow) => {
        const ra = deptRank(a);
        const rb = deptRank(b);
        if (ra !== rb) return ra - rb;
        return a.sopCode.localeCompare(b.sopCode);
      }),
      departments,
      designationsByDept: designationsByDeptObj,
      employeeCountsByDeptDesig: employeeCountsByDeptDesigObj,
      employeesByDept: employeesByDeptObj,
      unassignedEmployees,
      stats: {
        total: totalSOPs,
        assigned: assignedCount,
        unassigned: unassignedSOPs,
        unassignedEmployees: unassignedEmployees.length,
      },
      sopCountsByDeptMonth,
      sopCountsByMonth,
      sopCountsByDept,
      unassignedSopCodes: Array.from(unassignedSopCodes),
      manualAllocations,
      manualDesignations,
      year: yearAll ? "all" : year,
    };
    const responseBuildMs = elapsedMs(responseBuildStartMs);

    const cacheStoreStartMs = nowMs();
    await setManageSopViewCached(cacheYear, search, response);
    const cacheStoreMs = elapsedMs(cacheStoreStartMs);

    console.info(
      `${MANAGE_SOP_API_LOG} GET /api/training-matrix/manage-sop-view source=manage-sop cache=MISS year=${cacheYear} search="${search}" dbConnectMs=${dbConnectMs} dataFetchMs=${dataFetchMs} buildMs=${responseBuildMs} cacheStoreMs=${cacheStoreMs} dashboardCache=${dashboardCached ? "HIT" : "MISS"} overviewCache=${overviewCached ? "HIT" : "MISS"} totalMs=${elapsedMs(reqStartMs)}`,
    );

    return response;
}

// ─── POST: persist manual edits into TrainingMatrixRecord ───────────────────────
// The Manage SOP page lets users toggle designations + months for a given SOP/dept.
// Each entry expands into one TrainingMatrixRecord per (employee in dept+designation,
// sopCode, month, year), upserted to be idempotent against the unique index
// { employeeName, sopCode, month, year, department }.

export interface ManageSOPApplyEntry {
  sopCode: string;
  sopName?: string;
  department: string;
  designations: string[]; // resolved designation names (not abbreviations)
  months: number[];
  year?: number;
}

export interface ManageSOPRemoveEntry {
  sopCode: string;
  sopName?: string;
  department: string;
  // When omitted/empty with removeAllDesignations=true, remove all designations.
  designations?: string[];
  months: number[];
  year?: number;
  removeAllDesignations?: boolean;
}

export interface ManageSOPEmployeeSopAssignment {
  employeeName: string;
  department: string;
  designation?: string;
  sops: Array<{
    sopCode: string;
    sopName?: string;
    months?: number[];
  }>;
}

/**
 * Un-tick one named employee from a SOP without touching their colleagues.
 * The designation-level `removals` channel cannot express this: it clears every
 * employee sharing that designation.
 */
export interface ManageSOPEmployeeSopRemoval {
  employeeName: string;
  department: string;
  sops: Array<{ sopCode: string }>;
}

export interface ManageSOPApplyRequest {
  entries?: ManageSOPApplyEntry[];
  removals?: ManageSOPRemoveEntry[];
  employeeSopAssignments?: ManageSOPEmployeeSopAssignment[];
  employeeSopRemovals?: ManageSOPEmployeeSopRemoval[];
}

async function getOrCreateManualUploadId(
  dept: string,
  year: number,
  month: number,
): Promise<any> {
  const filter = {
    department: dept,
    year,
    month,
    fileType: "addendum" as const,
    fileName: "manage-sop-manual",
  };
  const existing = await TrainingMatrixUpload.findOne(filter).lean();
  if (existing && (existing as any)._id) return (existing as any)._id;
  const created = await TrainingMatrixUpload.create({
    ...filter,
    monthName: MONTH_NAMES[month] || `Month ${month}`,
    uploadedBy: "manage-sop",
  });
  return created._id;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const reqStartMs = nowMs();
  try {
    const dbConnectStartMs = nowMs();
    await connectDB();
    const dbConnectMs = elapsedMs(dbConnectStartMs);
    const body = (await request.json()) as ManageSOPApplyRequest;
    const upsertEntries = Array.isArray(body?.entries) ? body.entries : [];
    const removalEntries = Array.isArray(body?.removals) ? body.removals : [];
    const employeeSopAssignments = Array.isArray(body?.employeeSopAssignments)
      ? body.employeeSopAssignments
      : [];
    const employeeSopRemovals = Array.isArray(body?.employeeSopRemovals)
      ? body.employeeSopRemovals
      : [];
    if (
      !body ||
      (upsertEntries.length === 0 &&
        removalEntries.length === 0 &&
        employeeSopAssignments.length === 0 &&
        employeeSopRemovals.length === 0)
    ) {
      console.info(
        `${MANAGE_SOP_API_LOG} POST /api/training-matrix/manage-sop-view source=manage-sop empty_payload dbConnectMs=${dbConnectMs} totalMs=${elapsedMs(reqStartMs)}`,
      );
      return NextResponse.json(
        { error: "No changes provided" },
        { status: 400 },
      );
    }

    const fallbackYear = new Date().getFullYear();
    const warnings: string[] = [];

    // ── Normalise & validate entries/removals up front ──────────────────────
    type NormEntry = {
      sopCode: string; sopName: string; department: string;
      designations: string[]; months: number[]; year: number;
    };
    type NormRemoval = {
      sopCode: string; department: string; months: number[];
      designations: string[]; removeAllDesignations: boolean; year: number;
    };

    const normEntries: NormEntry[] = upsertEntries.flatMap((entry) => {
      const sopCode = (entry.sopCode || "").trim();
      const department = (entry.department || "").trim();
      const designations = (entry.designations || []).map((d) => (d || "").trim()).filter(Boolean);
      const months = (entry.months || []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
      const year = entry.year && Number.isInteger(entry.year) ? entry.year : fallbackYear;
      if (!sopCode || !department || designations.length === 0 || months.length === 0) return [];
      return [{ sopCode, sopName: entry.sopName || sopCode, department, designations, months, year }];
    });

    const normRemovals: NormRemoval[] = removalEntries.flatMap((removal) => {
      const sopCode = (removal.sopCode || "").trim();
      const department = (removal.department || "").trim();
      const months = (removal.months || []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
      const designations = (removal.designations || []).map((d) => (d || "").trim()).filter(Boolean);
      const removeAllDesignations = removal.removeAllDesignations === true;
      const year = removal.year && Number.isInteger(removal.year) ? removal.year : fallbackYear;
      if (!sopCode || !department || months.length === 0) return [];
      if (!removeAllDesignations && designations.length === 0) return [];
      return [{ sopCode, department, months, designations, removeAllDesignations, year }];
    });

    // ── Phase 1 (parallel): deletions + employee lookups + main-upload fetches ──
    // Collect all unique (dept, year, month) keys we'll need uploadIds for.
    const uploadIdKeys = new Set<string>();
    for (const e of normEntries) {
      for (const m of e.months) uploadIdKeys.add(`${e.department}|${e.year}|${m}`);
    }
    const uniqueDepts = [
      ...new Set([
        ...normEntries.map((e) => e.department),
        ...normRemovals.map((r) => r.department),
        ...employeeSopAssignments.map((a) => String(a.department || "").trim()).filter(Boolean),
        ...employeeSopRemovals.map((r) => String(r.department || "").trim()).filter(Boolean),
      ]),
    ];
    // Designation-wide edits need the department roster. A named employee edit
    // only needs those exact people; avoid loading the entire Employee collection
    // for the common Add Employee / single-checkbox save path.
    const employeeLookupNames = [
      ...new Set(
        employeeSopAssignments
          .map((row) => String(row.employeeName || "").trim())
          .filter(Boolean),
      ),
    ];
    const activeEmployeeFilter: Record<string, unknown> = normEntries.length > 0
      ? { isActive: true }
      : employeeLookupNames.length > 0
        ? {
            isActive: true,
            name: {
              $in: employeeLookupNames.map(
                (name) => new RegExp(`^${escapeRegExp(name)}$`, "i"),
              ),
            },
          }
        : { _id: { $exists: false } };

    // The client emits one removal per (SOP, dept, month) — up to twelve per
    // department for a single row edit, each previously costing its own query
    // pair. Same-designation removals are merged so each (SOP, dept, year)
    // resolves in one round trip over all its months.
    type MergedRemoval = {
      sopCode: string; department: string; year: number;
      months: Set<number>; designations: string[]; removeAllDesignations: boolean;
    };
    const mergedRemovals = new Map<string, MergedRemoval>();
    for (const r of normRemovals) {
      const desigKey = r.removeAllDesignations
        ? "*"
        : [...r.designations].sort().join("");
      const key = `${r.sopCode}|${r.department}|${r.year}|${desigKey}`;
      const existing = mergedRemovals.get(key);
      if (existing) {
        for (const m of r.months) existing.months.add(m);
        continue;
      }
      mergedRemovals.set(key, {
        sopCode: r.sopCode,
        department: r.department,
        year: r.year,
        months: new Set(r.months),
        designations: r.designations,
        removeAllDesignations: r.removeAllDesignations,
      });
    }

    const [removalResults, allActiveEmployees, mainUploads, uploadIdResults] = await Promise.all([
      // All deletions in parallel
      Promise.all([...mergedRemovals.values()].map(async (r) => {
        const filter: Record<string, any> = {
          sopCode: r.sopCode, department: r.department, year: r.year,
          month: { $in: [...r.months] }, sourceFile: "manage-sop-manual",
        };
        if (r.removeAllDesignations) {
          return TrainingMatrixRecord.deleteMany(filter);
        }
        // Resilient designation match: load candidates then filter by token/abbr
        // so "Sr Executive" removals also clear records stored as "SE".
        const candidates = await TrainingMatrixRecord.find(filter)
          .select("_id designation")
          .lean<Array<{ _id: unknown; designation?: string }>>();
        const ids = candidates
          .filter((row) => designationSetsOverlap(row.designation || "", r.designations))
          .map((row) => row._id);
        if (ids.length === 0) return { deletedCount: 0 };
        return TrainingMatrixRecord.deleteMany({ _id: { $in: ids } });
      })),
      Employee.find(activeEmployeeFilter)
        .select("name designation isTrainer trainerDepartments department")
        .lean<Array<{
          name?: string;
          designation?: string;
          isTrainer?: boolean;
          department?: string;
        }>>(),
      // All main-upload fetches in parallel (one per unique dept)
      Promise.all(uniqueDepts.map((dept) =>
        TrainingMatrixUpload.findOne({
          department: dept, fileType: "main",
          snapshot: { $exists: true, $ne: null },
        }).sort({ uploadedAt: -1 }).lean()
      )),
      // All uploadId lookups in parallel (one per dept|year|month combo)
      Promise.all([...uploadIdKeys].map(async (key) => {
        const [dept, yearStr, monthStr] = key.split("|");
        const id = await getOrCreateManualUploadId(dept, Number(yearStr), Number(monthStr));
        return [key, id] as const;
      })),
    ]);

    const employeesForDept = (dept: string) =>
      allActiveEmployees.filter((emp) => {
        if (emp.isTrainer) return false;
        const empDept =
          resolveTrainingMatrixDepartment(emp.department, uniqueDepts) ||
          canonTrainingMatrixDepartment(String(emp.department || "")) ||
          String(emp.department || "").trim();
        return empDept.toLowerCase() === dept.toLowerCase();
      });

    const employeeResults = normEntries.map((e) =>
      employeesForDept(e.department).filter((emp) =>
        designationSetsOverlap(emp.designation || "", e.designations),
      ),
    );

    let totalRemoved = removalResults.reduce((s, r) => s + (r.deletedCount || 0), 0);
    const mainUploadByDept = new Map<string, any>(
      uniqueDepts.map((dept, i) => [dept, mainUploads[i]])
    );
    const uploadIdMap = new Map<string, any>(uploadIdResults);

    // Filter out entries with no employees and warn
    const validEntries = normEntries.filter((e, i) => {
      if ((employeeResults[i] as any[]).length > 0) return true;
      warnings.push(`No active employees found in ${e.department} for designations: ${e.designations.join(", ")}`);
      return false;
    });

    // ── Phase 2 (parallel): all bulkWrites + all snapshot updates ───────────
    type SnapshotPatch = {
      sopCode: string;
      sopName: string;
      months: number[];
      designations: string[];
      employees: Array<{ name: string; designation: string }>;
      namedOnly?: boolean;
    };
    const snapshotPatches = new Map<string, SnapshotPatch[]>(); // dept → patches
    const snapshotRemovalPatches = new Map<string, NormRemoval[]>(); // dept → removals
    // dept → named employees to un-tick from a SOP, leaving same-designation
    // colleagues assigned. Applied alongside the designation removals below.
    const snapshotEmployeeRemovals = new Map<
      string,
      Array<{ employeeName: string; sopCode: string }>
    >();

    const bulkWriteOps = validEntries.map((e, idx) => {
      const emps = employeeResults[normEntries.indexOf(e)] as any[];
      const ops: any[] = [];
      for (const month of e.months) {
        const uploadId = uploadIdMap.get(`${e.department}|${e.year}|${month}`);
        const monthName = MONTH_NAMES[month] || `Month ${month}`;
        for (const emp of emps) {
          const employeeName = String(emp.name || "").trim();
          if (!employeeName) continue;
          ops.push({
            updateOne: {
              filter: { employeeName, sopCode: e.sopCode, month, year: e.year, department: e.department },
              update: {
                $setOnInsert: {
                  uploadId, department: e.department, employeeName,
                  designation: String(emp.designation || "").trim(),
                  sopCode: e.sopCode, sopName: e.sopName, month, year: e.year,
                  monthName, rawSymbol: "✓", sourceFile: "manage-sop-manual", isAddendum: true,
                },
                $set: { status: "completed" },
              },
              upsert: true,
            },
          });
        }
      }
      // Accumulate snapshot patches per dept
      if (!snapshotPatches.has(e.department)) snapshotPatches.set(e.department, []);
      snapshotPatches.get(e.department)!.push({
        sopCode: e.sopCode,
        sopName: e.sopName,
        months: e.months,
        designations: e.designations,
        employees: (emps as Array<{ name?: string; designation?: string }>)
          .map((emp) => ({
            name: String(emp.name || "").trim(),
            designation: String(emp.designation || "").trim(),
          }))
          .filter((emp) => emp.name),
      });
      return ops;
    });

    for (const r of normRemovals) {
      if (!snapshotRemovalPatches.has(r.department)) snapshotRemovalPatches.set(r.department, []);
      snapshotRemovalPatches.get(r.department)!.push(r);
    }

    const monthNameToNumber = (name: string): number | null => {
      const idx = MONTH_NAMES.findIndex(
        (m) => m && m.toLowerCase() === String(name || "").trim().toLowerCase(),
      );
      return idx > 0 ? idx : null;
    };

    const monthsFromDeptSnapshot = (dept: string, sopCode: string): number[] => {
      const mainUpload: any = mainUploadByDept.get(dept);
      const snapshotMonthMap: Record<string, string> = mainUpload?.snapshot?.sopMonthMap || {};
      const base = stripVersion(sopCode);
      const months: number[] = [];
      for (const [k, v] of Object.entries(snapshotMonthMap)) {
        if (stripVersion(String(k)) !== base || !v) continue;
        for (const part of String(v).split(",").map((s) => s.trim()).filter(Boolean)) {
          const n = monthNameToNumber(part);
          if (n && !months.includes(n)) months.push(n);
        }
      }
      return months;
    };

    type ResolvedEmpAssign = {
      department: string;
      year: number;
      employeeName: string;
      designation: string;
      sopCode: string;
      sopName: string;
      months: number[];
    };
    const resolvedEmpAssigns: ResolvedEmpAssign[] = [];
    for (const row of employeeSopAssignments) {
      const department = String(row.department || "").trim();
      const employeeName = String(row.employeeName || "").trim();
      if (!department || !employeeName) {
        warnings.push("Skipped an employee SOP assignment with no name or department.");
        continue;
      }
      const live = employeesForDept(department).find(
        (emp) => String(emp.name || "").trim().toLowerCase() === employeeName.toLowerCase(),
      );
      // Employee Master first: this stamps a designation onto brand-new matrix
      // records, so a stale page must not write back the old title. The
      // client-supplied value is only a fallback for someone with no Employee
      // Master record (Excel-only roster row).
      const designation = String(live?.designation || row.designation || "").trim();
      const year = fallbackYear;
      const sops = Array.isArray(row.sops) ? row.sops : [];
      if (sops.length === 0) {
        warnings.push(`No SOPs selected for ${employeeName} (${department}).`);
        continue;
      }
      for (const sop of sops) {
        const sopCode = String(sop.sopCode || "").trim();
        if (!sopCode) continue;
        let months = (sop.months || []).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
        if (months.length === 0) months = monthsFromDeptSnapshot(department, sopCode);
        if (months.length === 0) months = [new Date().getMonth() + 1];
        resolvedEmpAssigns.push({
          department,
          year,
          employeeName,
          designation,
          sopCode,
          sopName: String(sop.sopName || sopCode).trim() || sopCode,
          months,
        });
        for (const m of months) uploadIdKeys.add(`${department}|${year}|${m}`);
      }
    }

    const missingUploadKeys = [...uploadIdKeys].filter((k) => !uploadIdMap.has(k));
    if (missingUploadKeys.length > 0) {
      const extraIds = await Promise.all(
        missingUploadKeys.map(async (key) => {
          const [dept, yearStr, monthStr] = key.split("|");
          const id = await getOrCreateManualUploadId(dept, Number(yearStr), Number(monthStr));
          return [key, id] as const;
        }),
      );
      for (const [key, id] of extraIds) uploadIdMap.set(key, id);
    }

    for (const item of resolvedEmpAssigns) {
      const ops: any[] = [];
      for (const month of item.months) {
        const uploadId = uploadIdMap.get(`${item.department}|${item.year}|${month}`);
        const monthName = MONTH_NAMES[month] || `Month ${month}`;
        ops.push({
          updateOne: {
            filter: {
              employeeName: item.employeeName,
              sopCode: item.sopCode,
              month,
              year: item.year,
              department: item.department,
            },
            update: {
              $setOnInsert: {
                uploadId,
                department: item.department,
                employeeName: item.employeeName,
                designation: item.designation,
                sopCode: item.sopCode,
                sopName: item.sopName,
                month,
                year: item.year,
                monthName,
                rawSymbol: "✓",
                sourceFile: "manage-sop-manual",
                isAddendum: true,
              },
              $set: { status: "completed" },
            },
            upsert: true,
          },
        });
      }
      if (ops.length) bulkWriteOps.push(ops);
      if (!snapshotPatches.has(item.department)) snapshotPatches.set(item.department, []);
      snapshotPatches.get(item.department)!.push({
        sopCode: item.sopCode,
        sopName: item.sopName,
        months: item.months,
        designations: item.designation ? [item.designation] : [],
        employees: [{ name: item.employeeName, designation: item.designation }],
        namedOnly: true,
      });
    }

    // ── Per-employee un-ticks ───────────────────────────────────────────────
    // Drop this one person's manual records for the SOP and clear their
    // snapshot training flag. Everyone else on the designation stays assigned.
    const employeeRemovalDeletes: Array<Promise<{ deletedCount?: number }>> = [];
    // An employee listed in the dept snapshot is excluded by clearing their
    // training flag, so only their manual rows are deleted. Someone absent from
    // the snapshot is assigned purely through records, so the un-tick has to
    // delete those records or it would silently reappear on the next load.
    const snapshotHasEmployee = (dept: string, name: string): boolean => {
      const mainUpload: any = mainUploadByDept.get(dept);
      const emps: SnapshotEmployee[] = Array.isArray(mainUpload?.snapshot?.employees)
        ? mainUpload.snapshot.employees
        : [];
      const key = snapshotEmployeeNameKey(name);
      return emps.some((e) => snapshotEmployeeNameKey(String(e?.name || "")) === key);
    };
    // Targets are collected first and then resolved with ONE query per department.
    // Querying per (employee, SOP) meant a separate scan of the department's
    // records for every tick in the batch.
    type EmpRemovalTarget = { nameKey: string; base: string; manualOnly: boolean };
    const removalTargetsByDept = new Map<string, EmpRemovalTarget[]>();
    const removalNamesByDept = new Map<string, Set<string>>();
    for (const row of employeeSopRemovals) {
      const department = String(row.department || "").trim();
      const employeeName = String(row.employeeName || "").trim();
      if (!department || !employeeName) {
        warnings.push("Skipped an employee SOP removal with no name or department.");
        continue;
      }
      const inSnapshot = snapshotHasEmployee(department, employeeName);
      for (const sop of Array.isArray(row.sops) ? row.sops : []) {
        const sopCode = String(sop.sopCode || "").trim();
        if (!sopCode) continue;
        if (!removalTargetsByDept.has(department)) {
          removalTargetsByDept.set(department, []);
          removalNamesByDept.set(department, new Set());
        }
        removalTargetsByDept.get(department)!.push({
          nameKey: employeeName.toLowerCase(),
          base: stripVersion(sopCode),
          manualOnly: inSnapshot,
        });
        removalNamesByDept.get(department)!.add(employeeName);
        if (!snapshotEmployeeRemovals.has(department)) {
          snapshotEmployeeRemovals.set(department, []);
        }
        snapshotEmployeeRemovals.get(department)!.push({ employeeName, sopCode });
      }
    }

    for (const [department, targets] of removalTargetsByDept) {
      const names = [...(removalNamesByDept.get(department) || [])];
      employeeRemovalDeletes.push(
        (async () => {
          // Narrowed by department + the exact names, which the
          // (employeeName, department) index serves. Case-insensitive regexes
          // ride along so a casing drift between snapshot and records still
          // matches; SOP codes are compared on the stripped base in JS.
          const candidates = await TrainingMatrixRecord.find({
            department,
            employeeName: {
              $in: [
                ...names,
                ...names.map((n) => new RegExp(`^${escapeRegExp(n)}$`, "i")),
              ],
            },
          })
            .select("_id employeeName sopCode sourceFile")
            .lean<Array<{ _id: unknown; employeeName?: string; sopCode?: string; sourceFile?: string }>>();
          const ids = candidates
            .filter((r) => {
              const nameKey = String(r.employeeName || "").trim().toLowerCase();
              const base = stripVersion(String(r.sopCode || ""));
              return targets.some(
                (t) =>
                  t.nameKey === nameKey &&
                  t.base === base &&
                  (!t.manualOnly || String(r.sourceFile || "") === "manage-sop-manual"),
              );
            })
            .map((r) => r._id);
          if (ids.length === 0) return { deletedCount: 0 };
          return TrainingMatrixRecord.deleteMany({ _id: { $in: ids } });
        })(),
      );
    }
    if (employeeRemovalDeletes.length > 0) {
      const results = await Promise.all(employeeRemovalDeletes);
      totalRemoved += results.reduce((s, r) => s + (r?.deletedCount || 0), 0);
    }

    // Final designation applicability per (sop, dept) — drives Training Matrix assignment rows.
    const assignmentDesigByKey = new Map<
      string,
      { sopCode: string; department: string; designations: string[] }
    >();
    for (const e of normEntries) {
      const key = `${stripVersion(e.sopCode)}|${e.department}`;
      assignmentDesigByKey.set(key, {
        sopCode: e.sopCode,
        department: e.department,
        designations: e.designations,
      });
    }
    for (const r of normRemovals) {
      if (!r.removeAllDesignations) continue;
      const key = `${stripVersion(r.sopCode)}|${r.department}`;
      if (!assignmentDesigByKey.has(key)) {
        assignmentDesigByKey.set(key, {
          sopCode: r.sopCode,
          department: r.department,
          designations: [],
        });
      }
    }

    const [bulkResults, ...snapshotResults] = await Promise.all([
      // One unordered bulkWrite for every entry and named assignment. These were
      // issued as a separate round trip per entry, which multiplied latency on a
      // multi-dept save; the ops all target one collection on distinct filters,
      // so the driver batches them just as safely in a single call.
      (async () => {
        const allOps = bulkWriteOps.flat();
        if (allOps.length === 0) return [];
        return [await TrainingMatrixRecord.bulkWrite(allOps, { ordered: false })];
      })(),
      // All snapshot updates in parallel (one per unique dept)
      ...[...snapshotPatches.entries()].map(async ([dept, patches]) => {
        try {
          const mainUpload: any = mainUploadByDept.get(dept);
          if (!mainUpload?._id) {
            warnings.push(`No main Training Matrix upload found for ${dept} — count cards will not refresh until an Excel is uploaded for this dept.`);
            return;
          }
          const snapshotCodes: string[] = Array.isArray(mainUpload?.snapshot?.sopCodes)
            ? mainUpload.snapshot.sopCodes : [];
          const snapshotEmployees: SnapshotEmployee[] = Array.isArray(mainUpload?.snapshot?.employees)
            ? (mainUpload.snapshot.employees as SnapshotEmployee[]).map((emp) => ({
                name: emp?.name,
                designation: emp?.designation,
                training: { ...(emp?.training || {}) },
              }))
            : [];

          const newSopCodes: string[] = [];
          const update: any = { $set: {} };
          for (const patch of patches) {
            const base = stripVersion(patch.sopCode);
            if (!snapshotCodes.some((c) => stripVersion(String(c)) === base)) {
              newSopCodes.push(patch.sopCode);
            }
            const snapshotMonthMap: Record<string, string> = mainUpload?.snapshot?.sopMonthMap || {};
            const patchBase = stripVersion(patch.sopCode);
            const existingMonths: string[] = [];
            for (const [k, v] of Object.entries(snapshotMonthMap)) {
              if (stripVersion(String(k)) === patchBase && v) {
                for (const m of String(v).split(',').map((s: string) => s.trim()).filter(Boolean)) {
                  existingMonths.push(m);
                }
              }
            }
            const newMonths = patch.months.map((m: number) => MONTH_NAMES[m] || `Month ${m}`);
            const allMonths = [...new Set([...existingMonths, ...newMonths])];
            update.$set[`snapshot.sopMonthMap.${patch.sopCode}`] = allMonths.join(',');
            if (!patch.namedOnly) {
              for (const emp of snapshotEmployees) {
                if (designationSetsOverlap(emp?.designation || "", patch.designations)) {
                  upsertSnapshotEmployeeTraining(
                    snapshotEmployees,
                    String(emp.name || ""),
                    String(emp.designation || ""),
                    patch.sopCode,
                    true,
                  );
                }
              }
            }
            for (const emp of patch.employees || []) {
              upsertSnapshotEmployeeTraining(
                snapshotEmployees,
                emp.name,
                emp.designation,
                patch.sopCode,
                true,
              );
            }
          }
          // This task rewrites the whole employees array, so any per-employee
          // un-tick for this dept must be folded in here rather than issued as a
          // competing $unset — otherwise whichever write lands last wins.
          for (const rm of snapshotEmployeeRemovals.get(dept) || []) {
            clearSnapshotEmployeeTraining(snapshotEmployees, rm.employeeName, rm.sopCode);
          }
          update.$set["snapshot.employees"] = snapshotEmployees;
          if (newSopCodes.length > 0) update.$addToSet = { "snapshot.sopCodes": { $each: newSopCodes } };
          await TrainingMatrixUpload.updateOne({ _id: mainUpload._id }, update);
        } catch (e) {
          warnings.push(`Failed to sync ${dept} snapshot: ${(e as Error).message}`);
        }
      }),
      // Clear training flags in snapshot when designations/months are removed.
      ...[...new Set([
        ...snapshotRemovalPatches.keys(),
        ...snapshotEmployeeRemovals.keys(),
      ])].map(async (dept) => {
        const removals = snapshotRemovalPatches.get(dept) || [];
        // Depts with additive patches already folded their per-employee un-ticks
        // into the full-array rewrite above; re-issuing them here would race it.
        const employeeRemovals = snapshotPatches.has(dept)
          ? []
          : snapshotEmployeeRemovals.get(dept) || [];
        if (removals.length === 0 && employeeRemovals.length === 0) return;
        try {
          const mainUpload: any = mainUploadByDept.get(dept);
          if (!mainUpload?._id) return;
          const snapshotEmployees: Array<{ name?: string; designation?: string; training?: Record<string, boolean> }> =
            Array.isArray(mainUpload?.snapshot?.employees) ? mainUpload.snapshot.employees : [];
          const unsetFields: Record<string, string> = {};

          for (const rm of employeeRemovals) {
            const target = snapshotEmployeeNameKey(rm.employeeName);
            const base = stripVersion(rm.sopCode);
            snapshotEmployees.forEach((emp, idx) => {
              if (snapshotEmployeeNameKey(String(emp?.name || "")) !== target) return;
              for (const code of Object.keys(emp?.training || {})) {
                if (stripVersion(code) === base) {
                  unsetFields[`snapshot.employees.${idx}.training.${code}`] = "";
                }
              }
            });
          }

          for (const removal of removals) {
            if (removal.removeAllDesignations) {
              snapshotEmployees.forEach((_emp, idx) => {
                // Prefer $unset so LMS no longer sees the key at all.
                unsetFields[`snapshot.employees.${idx}.training.${removal.sopCode}`] = "";
              });
              continue;
            }
            snapshotEmployees.forEach((emp, idx) => {
              if (designationSetsOverlap(emp?.designation || "", removal.designations)) {
                unsetFields[`snapshot.employees.${idx}.training.${removal.sopCode}`] = "";
              }
            });
          }

          if (Object.keys(unsetFields).length > 0) {
            await TrainingMatrixUpload.updateOne({ _id: mainUpload._id }, { $unset: unsetFields });
          }
        } catch (e) {
          warnings.push(`Failed to sync ${dept} snapshot removals: ${(e as Error).message}`);
        }
      }),
      // Keep MatrixSOPAssignment.designationApplicability aligned with Manage SOP edits.
      // Create a row when none exists so designation ticks survive reload without
      // depending solely on TrainingMatrixRecord counts.
      ...[...assignmentDesigByKey.values()].map(async (u) => {
        try {
          const base = stripVersion(u.sopCode);
          const filter = {
            department: u.department,
            isActive: true,
            $or: [{ sopCode: u.sopCode }, { sopCode: base }],
          };
          const existing = await MatrixSOPAssignment.findOne(filter).select("_id").lean();
          if (existing) {
            await MatrixSOPAssignment.updateMany(filter, {
              $set: { designationApplicability: u.designations },
            });
            return;
          }
          if (u.designations.length === 0) return;
          const sopDoc = await SOP.findOne({
            $or: [
              { identifier: u.sopCode },
              { identifier: base },
              { sopBaseId: base },
            ],
            isObsolete: { $ne: true },
          })
            .select("_id identifier name")
            .lean<{ _id: unknown; identifier?: string; name?: string }>();
          if (!sopDoc?._id) {
            warnings.push(
              `No master SOP found to create matrix assignment for ${u.sopCode} in ${u.department}`,
            );
            return;
          }
          const month = u.designations.length
            ? (normEntries.find(
                (e) =>
                  stripVersion(e.sopCode) === base && e.department === u.department,
              )?.months[0] || new Date().getMonth() + 1)
            : new Date().getMonth() + 1;
          await MatrixSOPAssignment.create({
            department: u.department,
            sopId: sopDoc._id,
            sopCode: sopDoc.identifier || u.sopCode,
            sopName: sopDoc.name || u.sopCode,
            effectiveMonth: month,
            effectiveYear: fallbackYear,
            designationApplicability: u.designations,
            isActive: true,
            createdBy: "manage-sop",
          });
        } catch (e) {
          warnings.push(
            `Failed to sync matrix assignment for ${u.sopCode} in ${u.department}: ${(e as Error).message}`,
          );
        }
      }),
    ]);

    let totalInserted = 0, totalMatched = 0, totalUnchanged = 0;
    for (const result of bulkResults) {
      if (!result) continue;
      totalInserted += (result as any).upsertedCount || 0;
      const matched = (result as any).matchedCount || 0;
      const modified = (result as any).modifiedCount || 0;
      totalMatched += matched;
      totalUnchanged += matched - modified;
    }

    // Drop caches before responding so the client's ?refresh=1 fetch never reads stale data.
    // Also bust LMS trainer / All Exams caches so assignment changes appear immediately.
    bustTrainerScheduleCaches();
    await Promise.all([
      invalidateTrainingMatrixCache(),
      invalidateInductionTrainingMatrixCache(),
      invalidateManageSopViewCache(),
    ]).catch(() => {});

    // The overview is deliberately NOT recomputed here. The client's follow-up
    // GET /manage-sop-view?refresh=1 rebuilds it synchronously as part of its own
    // build, so warming it here just put a second full recompute on the critical
    // path of every Update. It stays invalidated above, so any other caller's
    // next overview GET recomputes correctly.

    console.info(
      `${MANAGE_SOP_API_LOG} POST /api/training-matrix/manage-sop-view source=manage-sop dbConnectMs=${dbConnectMs} upsertEntries=${upsertEntries.length} removalEntries=${removalEntries.length} inserted=${totalInserted} removed=${totalRemoved} updated=${totalMatched} unchanged=${totalUnchanged} warnings=${warnings.length} totalMs=${elapsedMs(reqStartMs)}`,
    );

    return NextResponse.json(
      {
        success: true,
        inserted: totalInserted,
        removed: totalRemoved,
        updated: totalMatched,
        unchanged: totalUnchanged,
        warnings,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error(
      `${MANAGE_SOP_API_LOG} POST /api/training-matrix/manage-sop-view source=manage-sop FAILED totalMs=${elapsedMs(reqStartMs)}`,
      error,
    );
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to apply changes",
      },
      { status: 500 },
    );
  }
}
