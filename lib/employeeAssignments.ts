import TrainingMatrixRecord from '@/models/TrainingMatrixRecord';
import TrainingMatrixUpload from '@/models/TrainingMatrixUpload';
import InductionTrainingMatrixRecord from '@/models/InductionTrainingMatrixRecord';
import InductionTrainingMatrixUpload from '@/models/InductionTrainingMatrixUpload';
import Employee from '@/models/Employee';
import SOP, { type ISOP } from '@/models/SOP';
import MatrixSOPAssignment from '@/models/MatrixSOPAssignment';
import TrainingExamSchedule from '@/models/TrainingExamSchedule';
import ScheduledExam from '@/models/lms/ScheduledExam';
import { getGroupedRegistryRows } from '@/lib/dashboardRegistrySource';
import { normalizeDepartment } from '@/lib/department-colors';
import { baseIdentifierFromIdentifier } from '@/lib/sop-utils';
import {
  buildExcelToDbBaseLookup,
  expandSopIdentifierVariants,
  resolveExcelCodeToDbBase,
} from '@/lib/sopIdentifierNormalize';
import { invalidateLmsServerPrefix } from '@/lib/lmsCache';
import { resolveTrainerDepartments } from '@/lib/employeeTrainer';
import {
  resolveSopFamilyNames,
  isPlaceholderSopName,
  hasGujaratiScript,
  cleanSopDisplayName,
  isInvalidSopAssignmentCode,
} from '@/lib/sop-name-resolution';
import {
  normalizeDept,
  toDateOnlyIso,
  deptScheduleKey,
  employeeOverrideKey,
} from '@/lib/trainingExamSchedule';

const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface EmployeeSopAssignment {
  sopCode: string;
  sopName?: string;
  sopNameGujarati?: string;
  sopDepartment?: string;
  month: number;
  monthName: string;
  year: number;
  trainingType: 'induction' | 'training';
  status?: string;
  /** ISO date (YYYY-MM-DD) when the exam is scheduled, if assigned on the calendar. */
  examDate?: string;
  /** ISO date of the current SOP document expiry, if known. */
  expiryDate?: string;
  /** True when a department trainer scheduled this exam directly for the employee. */
  scheduledByTrainer?: boolean;
  /** Name of the trainer who scheduled it (only with `scheduledByTrainer`). */
  scheduledBy?: string;
}

function empKey(department: string, name: string): string {
  return `${department}||${name}`.trim().toLowerCase();
}

// Each SOP counts once per employee — the same SOP scheduled across several
// months (or surfaced by both the records and the snapshot sources) must not
// inflate the assigned-SOP count. Dedup on the SOP code alone.
function assignmentKey(a: Pick<EmployeeSopAssignment, 'sopCode'>): string {
  return String(a.sopCode || '').toUpperCase().trim();
}

// Earlier = smaller (year, month). Used to keep the first scheduled occurrence.
function isEarlier(
  a: Pick<EmployeeSopAssignment, 'month' | 'year'>,
  b: Pick<EmployeeSopAssignment, 'month' | 'year'>,
): boolean {
  if (a.year !== b.year) return a.year < b.year;
  return a.month < b.month;
}

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

function monthNameToNum(name: string): number | null {
  const idx = MONTH_NAMES.findIndex(
    (m) => m && m.toLowerCase() === String(name || '').trim().toLowerCase(),
  );
  return idx > 0 ? idx : null;
}

/** sopMonthMap values may list several months: "January,March,February". */
function parseScheduleMonthNumbers(monthVal: string): number[] {
  return String(monthVal || '')
    .split(',')
    .map((part) => monthNameToNum(part.trim()))
    .filter((m): m is number => m !== null);
}

function primaryScheduleFromMonthVal(monthVal: string): { month: number; monthName: string } | null {
  const months = parseScheduleMonthNumbers(monthVal);
  if (!months.length) return null;
  const month = Math.min(...months);
  return { month, monthName: MONTH_NAMES[month] || String(monthVal).trim() };
}

export function inferTrainingType(rawSymbol: string): 'induction' | 'training' {
  const s = String(rawSymbol || '').trim();
  if (!s) return 'training';
  const lower = s.toLowerCase();
  if (lower === 'i' || lower === 'ind' || lower.includes('induction')) return 'induction';
  return 'training';
}

interface SopLookup {
  families: Map<string, ISOP[]>;
  registryByBase: Map<string, { name: string; nameGujarati?: string; department: string; expiryDate?: string }>;
  matrixByDeptCode: Map<string, { sopName: string; department: string }>;
  matrixByCode: Map<string, { sopName: string; department: string }>;
  recordNameByBase: Map<string, string>;
}

function deptLookupKey(dept: string, base: string): string {
  return `${normalizeDepartment(dept).toLowerCase()}||${base.toUpperCase()}`;
}

function pickRecordName(
  code: string,
  candidates: Array<string | undefined>,
): string | undefined {
  for (const raw of candidates) {
    const cleaned = raw ? cleanSopDisplayName(raw) : '';
    if (cleaned && !isPlaceholderSopName(cleaned, code) && !hasGujaratiScript(cleaned)) {
      return cleaned;
    }
  }
  return undefined;
}

function pickSopDepartment(records: ISOP[]): string | undefined {
  if (!records.length) return undefined;
  const en = records.find(
    (r) => r.language !== 'Gujarati' && r.department && r.department !== 'General',
  );
  if (en?.department) return en.department;
  const any = records.find((r) => r.department && r.department !== 'General');
  return any?.department || records[0]?.department;
}

function enrichAssignment(
  assignment: EmployeeSopAssignment,
  employeeDept: string,
  lookup: SopLookup,
): void {
  const base = stripVersion(assignment.sopCode);
  const registry = lookup.registryByBase.get(base);
  const family = lookup.families.get(base) || [];
  const matrix =
    lookup.matrixByDeptCode.get(deptLookupKey(employeeDept, base)) ||
    lookup.matrixByCode.get(base);
  const matrixName = matrix?.sopName || assignment.sopName;
  const resolved = resolveSopFamilyNames(
    family,
    assignment.sopCode,
    registry?.name || matrixName,
  );

  const english =
    pickRecordName(assignment.sopCode, [
      registry?.name,
      lookup.recordNameByBase.get(base),
      resolved.englishName,
      matrix?.sopName,
      assignment.sopName,
    ]) ||
    resolved.gujaratiName ||
    registry?.nameGujarati ||
    assignment.sopCode;

  assignment.sopName = english;
  const gujarati =
    registry?.nameGujarati ||
    resolved.gujaratiName;
  if (gujarati && gujarati !== english) {
    assignment.sopNameGujarati = gujarati;
  }
  assignment.sopDepartment = normalizeDepartment(
    registry?.department ||
    pickSopDepartment(family) ||
    matrix?.department ||
    employeeDept,
  );

  // Prefer registry expiry, then latest family record with an expiryDate.
  const registryExpiry = registry?.expiryDate;
  if (registryExpiry) {
    assignment.expiryDate = String(registryExpiry).slice(0, 10);
  } else {
    const withExpiry = [...family]
      .filter((r) => r.expiryDate)
      .sort((a, b) => (b.versionNum ?? 0) - (a.versionNum ?? 0));
    const exp = withExpiry[0]?.expiryDate;
    if (exp) {
      assignment.expiryDate = new Date(exp).toISOString().slice(0, 10);
    }
  }
}

/** Build SOP family index + matrix assignment lookups for name/dept resolution. */
async function buildSopLookup(): Promise<SopLookup> {
  const [sops, registryRows, matrixRows, matrixRecordNames] = await Promise.all([
    SOP.find({ isObsolete: { $ne: true } })
      .select('name identifier sopBaseId language department expiryDate versionNum')
      .lean(),
    getGroupedRegistryRows(),
    MatrixSOPAssignment.find({ isActive: true })
      .select('department sopCode sopName')
      .lean(),
    TrainingMatrixRecord.aggregate<{ _id: string; names: string[] }>([
      { $match: { status: { $ne: 'na' }, sopName: { $exists: true, $ne: '' } } },
      { $group: { _id: { $toUpper: '$sopCode' }, names: { $addToSet: '$sopName' } } },
    ]),
  ]);

  const families = new Map<string, ISOP[]>();
  for (const s of sops as unknown as ISOP[]) {
    const base = String(s.sopBaseId || stripVersion(s.identifier)).toUpperCase();
    if (!base) continue;
    if (!families.has(base)) families.set(base, []);
    families.get(base)!.push(s);
  }

  const registryByBase = new Map<string, { name: string; nameGujarati?: string; department: string; expiryDate?: string }>();
  for (const row of registryRows) {
    if (row.isObsolete) continue;
    const base = stripVersion(row.identifier).toUpperCase();
    if (!base || registryByBase.has(base)) continue;
    registryByBase.set(base, {
      name: row.name,
      nameGujarati: row.nameGujarati,
      department: row.department,
      expiryDate: row.expiryDate ? String(row.expiryDate).slice(0, 10) : undefined,
    });
  }

  const recordNameByBase = new Map<string, string>();
  for (const row of matrixRecordNames) {
    const base = stripVersion(row._id).toUpperCase();
    if (!base) continue;
    const name = pickRecordName(base, row.names);
    if (name) recordNameByBase.set(base, name);
  }

  const matrixByDeptCode = new Map<string, { sopName: string; department: string }>();
  const matrixByCode = new Map<string, { sopName: string; department: string }>();
  const preferMatrixEntry = (
    existing: { sopName: string; department: string } | undefined,
    candidate: { sopName: string; department: string },
    base: string,
  ) => {
    if (!existing) return candidate;
    const existingOk = !isPlaceholderSopName(existing.sopName, base);
    const candidateOk = !isPlaceholderSopName(candidate.sopName, base);
    if (!existingOk && candidateOk) return candidate;
    return existing;
  };

  for (const row of matrixRows as Array<{ department: string; sopCode: string; sopName: string }>) {
    const base = stripVersion(row.sopCode);
    const dept = normalizeDepartment(String(row.department || '').trim());
    if (!base || !dept) continue;
    const entry = { sopName: row.sopName, department: dept };
    const deptKey = deptLookupKey(dept, base);
    matrixByDeptCode.set(
      deptKey,
      preferMatrixEntry(matrixByDeptCode.get(deptKey), entry, base),
    );
    matrixByCode.set(base, preferMatrixEntry(matrixByCode.get(base), entry, base));
  }

  return { families, registryByBase, matrixByDeptCode, matrixByCode, recordNameByBase };
}

// Building the assignments map scans the whole training-matrix + SOP
// collections, so it is by far the heaviest part of the employees page. The
// employees list and the training-status endpoints both need it and fire within
// milliseconds of each other, so a short-lived in-memory cache lets the second
// caller reuse the first one's work instead of recomputing it from scratch.
const ASSIGNMENTS_CACHE_TTL_MS = 15_000;

interface AssignmentsCache {
  expiresAt: number;
  promise: Promise<Map<string, EmployeeSopAssignment[]>>;
}

declare global {
  // eslint-disable-next-line no-var
  var __employeeAssignmentsCache: AssignmentsCache | undefined;
}

export function invalidateEmployeeAssignmentsCache(): void {
  global.__employeeAssignmentsCache = undefined;
  invalidateLmsServerPrefix('lms:admin:');
}

export function getEmployeeAssignmentsMap(
  opts?: { force?: boolean },
): Promise<Map<string, EmployeeSopAssignment[]>> {
  const now = Date.now();
  const cached = global.__employeeAssignmentsCache;
  if (!opts?.force && cached && cached.expiresAt > now) {
    return cached.promise;
  }

  const promise = computeEmployeeAssignmentsMap().catch((err) => {
    // Never cache a failed computation.
    if (global.__employeeAssignmentsCache?.promise === promise) {
      global.__employeeAssignmentsCache = undefined;
    }
    throw err;
  });

  global.__employeeAssignmentsCache = {
    expiresAt: now + ASSIGNMENTS_CACHE_TTL_MS,
    promise,
  };
  return promise;
}

/** Match training-matrix overview: only registry SOP codes, not junk Excel symbols. */
async function buildMatrixAssignableCodeFilter(): Promise<(raw: string) => boolean> {
  const registry = await getGroupedRegistryRows();
  const active = registry.filter((r) => !r.isObsolete);
  const dbBaseSet = new Set<string>();
  for (const row of active) {
    const base = baseIdentifierFromIdentifier(row.identifier);
    if (base) dbBaseSet.add(base);
  }

  const obsoleteBaseSet = new Set<string>();
  for (const row of registry.filter((r) => r.isObsolete)) {
    const base = baseIdentifierFromIdentifier(row.identifier);
    if (base) obsoleteBaseSet.add(base.toUpperCase());
    for (const variant of expandSopIdentifierVariants(row.identifier)) {
      const stripped = stripVersion(variant);
      if (stripped) obsoleteBaseSet.add(stripped);
    }
  }

  const excelToDbBase = buildExcelToDbBaseLookup(active);
  return (raw: string): boolean => {
    const stripped = stripVersion(raw);
    if (!stripped || isInvalidSopAssignmentCode(stripped)) return false;
    if (obsoleteBaseSet.has(stripped)) return false;
    const dbBase = resolveExcelCodeToDbBase(stripped, excelToDbBase);
    if (dbBase) {
      if (obsoleteBaseSet.has(dbBase)) return false;
      return dbBaseSet.has(dbBase);
    }
    return dbBaseSet.has(stripped);
  };
}

async function computeEmployeeAssignmentsMap(): Promise<Map<string, EmployeeSopAssignment[]>> {
  // empKey → (sopCode → kept assignment). One entry per SOP per employee.
  const byEmp = new Map<string, Map<string, EmployeeSopAssignment>>();
  const [lookup, isMatrixAssignableCode, records, uploads] = await Promise.all([
    buildSopLookup(),
    buildMatrixAssignableCodeFilter(),
    TrainingMatrixRecord.find({ status: { $ne: 'na' } })
      .select('employeeName department sopCode sopName month monthName year rawSymbol status')
      .sort({ year: -1, month: 1, sopCode: 1 })
      .lean(),
    TrainingMatrixUpload.find({
      fileType: 'main',
      'snapshot.employees': { $exists: true },
    })
      .sort({ uploadedAt: -1 })
      .lean(),
  ]);

  const add = (department: string, name: string, assignment: EmployeeSopAssignment) => {
    if (!isMatrixAssignableCode(assignment.sopCode)) return;
    const key = empKey(department, name);
    if (!byEmp.has(key)) byEmp.set(key, new Map());
    const bySop = byEmp.get(key)!;
    const dedupeKey = assignmentKey(assignment);
    const existing = bySop.get(dedupeKey);
    // Keep the earliest-scheduled occurrence of each SOP.
    if (!existing || isEarlier(assignment, existing)) bySop.set(dedupeKey, assignment);
  };

  const latestByDept = new Map<string, {
    year: number;
    snapshot: {
      sopMonthMap?: Record<string, string>;
      employees?: Array<{ name?: string; training?: Record<string, boolean> }>;
    };
  }>();

  for (const up of uploads as Array<{
    department?: string;
    year?: number;
    snapshot?: {
      sopMonthMap?: Record<string, string>;
      employees?: Array<{ name?: string; training?: Record<string, boolean> }>;
    };
  }>) {
    const dept = String(up.department || '').trim();
    if (!dept || latestByDept.has(dept)) continue;
    if (!up.snapshot?.employees?.length || !up.snapshot?.sopMonthMap) continue;
    latestByDept.set(dept, { year: up.year ?? new Date().getFullYear(), snapshot: up.snapshot });
  }

  // Employees in the latest Excel snapshot use that list (scheduled = due + completed).
  const snapshotEmployeeKeysByDept = new Map<string, Set<string>>();

  for (const [dept, { year, snapshot }] of latestByDept) {
    const baseToSchedule = new Map<string, { month: number; monthName: string; rawCode: string }>();
    for (const [rawKey, monthName] of Object.entries(snapshot.sopMonthMap || {})) {
      if (!isMatrixAssignableCode(rawKey)) continue;
      const base = stripVersion(rawKey);
      const primary = primaryScheduleFromMonthVal(monthName);
      if (!base || !primary) continue;
      if (!baseToSchedule.has(base)) {
        baseToSchedule.set(base, { month: primary.month, monthName: primary.monthName, rawCode: rawKey });
      }
    }

    for (const emp of snapshot.employees || []) {
      const name = String(emp.name || '').trim();
      if (!name || !emp.training) continue;
      const empLookupKey = empKey(dept, name);
      if (!snapshotEmployeeKeysByDept.has(dept)) snapshotEmployeeKeysByDept.set(dept, new Set());
      snapshotEmployeeKeysByDept.get(dept)!.add(empLookupKey);

      for (const [sopCode] of Object.entries(emp.training)) {
        if (!isMatrixAssignableCode(sopCode)) continue;
        const sched = baseToSchedule.get(stripVersion(sopCode));
        if (!sched) continue;
        add(dept, name, {
          sopCode,
          month: sched.month,
          monthName: sched.monthName,
          year,
          trainingType: 'training',
        });
      }
    }
  }

  for (const r of records as Array<{
    employeeName: string;
    department: string;
    sopCode: string;
    sopName?: string;
    month: number;
    monthName: string;
    year: number;
    rawSymbol?: string;
    status?: string;
  }>) {
    const name = String(r.employeeName || '').trim();
    const department = String(r.department || '').trim();
    if (!name || !department || !r.sopCode || !isMatrixAssignableCode(r.sopCode)) continue;
    const empLookupKey = empKey(department, name);
    if (snapshotEmployeeKeysByDept.get(department)?.has(empLookupKey)) continue;
    add(department, name, {
      sopCode: r.sopCode,
      sopName: r.sopName,
      month: r.month,
      monthName: r.monthName || MONTH_NAMES[r.month] || `Month ${r.month}`,
      year: r.year,
      trainingType: inferTrainingType(r.rawSymbol || ''),
      status: r.status,
    });
  }

  // Materialize the deduped per-employee maps into the array shape callers expect.
  const map = new Map<string, EmployeeSopAssignment[]>();
  for (const [key, bySop] of byEmp) {
    map.set(
      key,
      [...bySop.values()].filter((a) => isMatrixAssignableCode(a.sopCode)),
    );
  }

  for (const [key, list] of map) {
    const employeeDept = key.split('||')[0] || '';
    for (const a of list) enrichAssignment(a, employeeDept, lookup);
    list.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      if (a.month !== b.month) return a.month - b.month;
      return a.sopCode.localeCompare(b.sopCode);
    });
  }

  // Trainers manage ALL SOPs in every department they are eligible for.
  // All of those SOPs are merged under the trainer's HOME department key so
  // consumers that look up empKey(homeDept, name) see the combined total.
  const trainers = await Employee.find({ isActive: true, isTrainer: true })
    .select('name department trainerDepartments isTrainer')
    .lean<Array<{
      name: string;
      department: string;
      trainerDepartments?: string[];
      isTrainer?: boolean;
    }>>();

  for (const trainer of trainers) {
    const name = String(trainer.name || '').trim();
    const homeDept = String(trainer.department || '').trim();
    if (!name || !homeDept) continue;

    const trainerDepts = resolveTrainerDepartments({
      ...trainer,
      isTrainer: true,
    });
    if (trainerDepts.length === 0) continue;

    const homeKey = empKey(homeDept, name);
    const existing = map.get(homeKey) || [];
    const existingCodes = new Set(existing.map((a) => assignmentKey(a)));

    for (const dept of trainerDepts) {
      // Prefer exact snapshot key; also try case-insensitive match.
      let deptSnap = latestByDept.get(dept);
      if (!deptSnap) {
        for (const [snapDept, snap] of latestByDept) {
          if (snapDept.toLowerCase() === dept.toLowerCase()) {
            deptSnap = snap;
            break;
          }
        }
      }
      if (!deptSnap?.snapshot.sopMonthMap) continue;

      for (const [rawKey, monthName] of Object.entries(deptSnap.snapshot.sopMonthMap)) {
        if (!isMatrixAssignableCode(rawKey)) continue;
        const base = stripVersion(rawKey);
        if (existingCodes.has(base)) continue;
        const primary = primaryScheduleFromMonthVal(monthName);
        if (!primary) continue;
        const assignment: EmployeeSopAssignment = {
          sopCode: rawKey,
          month: primary.month,
          monthName: primary.monthName,
          year: deptSnap.year,
          trainingType: 'training',
          sopDepartment: dept,
        };
        enrichAssignment(assignment, dept, lookup);
        existing.push(assignment);
        existingCodes.add(base);
      }
    }

    if (existing.length > 0) {
      existing.sort((a, b) => {
        if (a.year !== b.year) return b.year - a.year;
        if (a.month !== b.month) return a.month - b.month;
        return a.sopCode.localeCompare(b.sopCode);
      });
      map.set(homeKey, existing);
    }
  }

  await mergeInductionAssignments(map, lookup);
  await attachExamDates(map);
  // Runs last: a trainer-scheduled exam is authoritative over the matrix date.
  await mergeTrainerScheduledExams(map, lookup);

  return map;
}

/**
 * Fold trainer-scheduled exams into the assignment map so they appear in the
 * employee's LMS even when the SOP is not on their training-matrix row. An
 * existing assignment for the same SOP is retargeted to the trainer's month and
 * deadline rather than duplicated.
 */
async function mergeTrainerScheduledExams(
  map: Map<string, EmployeeSopAssignment[]>,
  lookup: SopLookup,
): Promise<void> {
  const schedules = await ScheduledExam.find({ status: 'scheduled' })
    .select('employeeId employeeName department sopCode sopName scheduledDate month year trainerName')
    .lean<Array<{
      employeeId: string;
      employeeName: string;
      department: string;
      sopCode: string;
      sopName?: string;
      scheduledDate: Date;
      month: number;
      year: number;
      trainerName?: string;
    }>>();

  if (schedules.length === 0) return;

  // The employee is the source of truth for name/department: a rename or a
  // transfer after scheduling must not strand the exam under the old key.
  const employeeIds = [...new Set(schedules.map((s) => s.employeeId).filter(Boolean))];
  const liveEmployees = await Employee.find({ _id: { $in: employeeIds }, isActive: true })
    .select('_id name department')
    .lean<Array<{ _id: unknown; name: string; department: string }>>();
  const liveById = new Map(
    liveEmployees.map((e) => [String(e._id), { name: e.name, department: e.department }]),
  );

  for (const s of schedules) {
    const live = liveById.get(String(s.employeeId));
    // Inactive or deleted employees drop out — their exams must not resurface.
    if (s.employeeId && !live) continue;
    const department = String(live?.department || s.department || '').trim();
    const name = String(live?.name || s.employeeName || '').trim();
    const code = stripVersion(s.sopCode);
    if (!department || !name || !code || isInvalidSopAssignmentCode(code)) continue;

    const key = empKey(department, name);
    const list = map.get(key) || [];
    const examDate = toDateOnlyIso(new Date(s.scheduledDate));
    // Version-insensitive: a schedule for "ABC" owns an existing "ABC-00" row.
    const existing = list.find((a) => stripVersion(a.sopCode) === code);

    if (existing) {
      existing.month = s.month;
      existing.monthName = MONTH_NAMES[s.month] || existing.monthName;
      existing.year = s.year;
      existing.examDate = examDate;
      existing.scheduledByTrainer = true;
      existing.scheduledBy = s.trainerName;
      continue;
    }

    const assignment: EmployeeSopAssignment = {
      sopCode: code,
      sopName: s.sopName,
      month: s.month,
      monthName: MONTH_NAMES[s.month] || `Month ${s.month}`,
      year: s.year,
      trainingType: 'training',
      examDate,
      scheduledByTrainer: true,
      scheduledBy: s.trainerName,
    };
    enrichAssignment(assignment, department, lookup);
    list.push(assignment);
    map.set(key, list);
  }

  for (const list of map.values()) {
    list.sort((a, b) => {
      if (a.year !== b.year) return b.year - a.year;
      if (a.month !== b.month) return a.month - b.month;
      return a.sopCode.localeCompare(b.sopCode);
    });
  }
}

/**
 * Attach calendar exam dates: employee override wins, else department schedule
 * for the assignment's month/year.
 */
async function attachExamDates(
  map: Map<string, EmployeeSopAssignment[]>,
): Promise<void> {
  const schedules = await TrainingExamSchedule.find({
    status: { $ne: 'cancelled' },
  })
    .select('sopCode department year plannedMonth examDate scope employeeName')
    .lean();

  if (!schedules.length) return;

  const deptByKey = new Map<string, string>();
  const overrideByKey = new Map<string, string>();

  for (const s of schedules) {
    const examDate =
      s.examDate instanceof Date
        ? toDateOnlyIso(s.examDate)
        : toDateOnlyIso(new Date(s.examDate as unknown as string));
    if (s.scope === 'department') {
      deptByKey.set(
        deptScheduleKey(s.sopCode, s.department, s.year, s.plannedMonth),
        examDate,
      );
    } else if (s.scope === 'employee' && s.employeeName) {
      overrideByKey.set(
        employeeOverrideKey(
          s.sopCode,
          s.department,
          s.year,
          s.plannedMonth,
          s.employeeName,
        ),
        examDate,
      );
    }
  }

  for (const [key, list] of map) {
    const [deptRaw, ...nameParts] = key.split('||');
    const department = normalizeDept(deptRaw || '');
    const employeeName = nameParts.join('||').trim();
    for (const a of list) {
      const code = stripVersion(a.sopCode);
      const oKey = employeeOverrideKey(
        code,
        department,
        a.year,
        a.month,
        employeeName,
      );
      const dKey = deptScheduleKey(code, department, a.year, a.month);
      const examDate = overrideByKey.get(oKey) || deptByKey.get(dKey);
      if (examDate) a.examDate = examDate;
    }
  }
}

async function mergeInductionAssignments(
  map: Map<string, EmployeeSopAssignment[]>,
  lookup: SopLookup,
): Promise<void> {
  const flagged = await Employee.find({ inductionTrainingRequired: true, isActive: true })
    .select('name department designation dateOfJoining')
    .lean<Array<{ name: string; department: string; designation: string }>>();

  if (flagged.length === 0) return;

  const add = (department: string, name: string, assignment: EmployeeSopAssignment) => {
    if (isInvalidSopAssignmentCode(assignment.sopCode)) return;
    const key = empKey(department, name);
    if (!map.has(key)) map.set(key, []);
    const list = map.get(key)!;
    const dedupeKey = assignmentKey(assignment);
    const existing = list.find((a) => assignmentKey(a) === dedupeKey);
    if (!existing || isEarlier(assignment, existing)) {
      if (existing) {
        const idx = list.indexOf(existing);
        list[idx] = assignment;
      } else {
        list.push(assignment);
      }
    }
  };

  const flaggedKeys = new Set(flagged.map((e) => empKey(e.department, e.name)));

  const inductionRecords = await InductionTrainingMatrixRecord.find({
    status: { $ne: 'na' },
  })
    .select('employeeName department sopCode sopName month monthName year rawSymbol status')
    .lean();

  for (const r of inductionRecords as Array<{
    employeeName: string;
    department: string;
    sopCode: string;
    sopName?: string;
    month: number;
    monthName: string;
    year: number;
    rawSymbol?: string;
    status?: string;
  }>) {
    const key = empKey(r.department, r.employeeName);
    if (!flaggedKeys.has(key)) continue;
    if (isInvalidSopAssignmentCode(r.sopCode)) continue;
    add(r.department, r.employeeName, {
      sopCode: r.sopCode,
      sopName: r.sopName,
      month: r.month,
      monthName: r.monthName || MONTH_NAMES[r.month] || `Month ${r.month}`,
      year: r.year,
      trainingType: 'induction',
      status: r.status,
    });
  }

  // Fallback: dept induction matrix SOPs for flagged employees with no per-employee records yet.
  const uploads = await InductionTrainingMatrixUpload.find({
    fileType: 'main',
    'snapshot.sopMonthMap': { $exists: true },
  })
    .sort({ uploadedAt: -1 })
    .lean();

  const latestInductionByDept = new Map<string, {
    year: number;
    snapshot: { sopMonthMap?: Record<string, string> };
  }>();

  for (const up of uploads as Array<{
    department?: string;
    year?: number;
    snapshot?: { sopMonthMap?: Record<string, string> };
  }>) {
    const dept = String(up.department || '').trim();
    if (!dept || latestInductionByDept.has(dept) || !up.snapshot?.sopMonthMap) continue;
    latestInductionByDept.set(dept, { year: up.year ?? new Date().getFullYear(), snapshot: up.snapshot });
  }

  for (const emp of flagged) {
    const key = empKey(emp.department, emp.name);
    const existing = map.get(key) || [];
    const hasInduction = existing.some((a) => a.trainingType === 'induction');
    if (hasInduction) continue;

    const snap = latestInductionByDept.get(String(emp.department || '').trim());
    if (!snap?.snapshot.sopMonthMap) continue;

    for (const [rawKey, monthName] of Object.entries(snap.snapshot.sopMonthMap)) {
      if (isInvalidSopAssignmentCode(rawKey)) continue;
      const primary = primaryScheduleFromMonthVal(monthName);
      if (!primary) continue;
      add(emp.department, emp.name, {
        sopCode: rawKey,
        month: primary.month,
        monthName: primary.monthName,
        year: snap.year,
        trainingType: 'induction',
      });
    }
  }

  for (const [key, list] of map) {
    const employeeDept = key.split('||')[0] || '';
    const filtered = list.filter((a) => !isInvalidSopAssignmentCode(a.sopCode));
    map.set(key, filtered);
    for (const a of filtered) {
      if (a.trainingType === 'induction') enrichAssignment(a, employeeDept, lookup);
    }
  }
}
