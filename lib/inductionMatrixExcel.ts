import * as XLSX from 'xlsx';
import { canonTrainingMatrixDepartment, TRAINING_MATRIX_CORE_DEPARTMENTS } from '@/lib/trainingMatrixDepartments';

/**
 * Parser for Induction Training Matrix Excel uploads. Every layout is reduced to
 * department → SOP → designations, which is what the induction assignments
 * (`InductionMatrixSOPAssignment`, same as the Manage SOP induction ticks) store;
 * employees flagged for induction then receive the SOPs of their designation.
 *
 * Supported layouts (any sheet of the workbook):
 *  1. Designation columns — a header row of designations (optionally under a
 *     "DESIGNATION" banner), each column listing the SOP codes for it.
 *  2. List — a header row with an "SOP" column plus optional Department / Month /
 *     Designation columns; one row per SOP (no designation = whole department).
 *  3. Employee matrix — a row of SOP codes across, one row per employee (name,
 *     designation) with ticks; the ticked employees' designations are used.
 *
 * Department resolution order: Department column → "Department: X" text above the
 * table → sheet name → file name → SOP code prefix (e.g. QAGE01 → QA).
 */

export type InductionParsedSop = {
  sopCode: string;
  designations: string[];
  /** First scheduled month (1–12) when the file gives one. */
  month: number | null;
};

export type InductionParsedDept = {
  department: string;
  sops: InductionParsedSop[];
};

export const MONTH_NUM_TO_NAME = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_ALIASES: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

/** Two-letter SOP code prefixes → department label. */
const CODE_PREFIX_DEPT: Record<string, string> = {
  QA: 'QA', QC: 'QC', MI: 'Microbiology', MB: 'Microbiology', PR: 'Production', PD: 'Production',
  ST: 'Store', SR: 'Store', WH: 'Store', EN: 'Engineering', EG: 'Engineering',
  PE: 'Personnel', HR: 'Personnel',
};

const TICKS = new Set(['√', '✓', '✔', '☑', 'TRUE', 'YES', 'Y', '1']);

const SOP_CODE_RE = /^[A-Z]{2,}[A-Z0-9/\-]*\d[A-Z0-9/\-]*$/i;

const NON_DESIGNATION_HEADER =
  /^(sr|s|sl)\.?\s*(no|number)\.?$|^(employee\s*)?name$|\b(sop|code|doc(ument)?\s*no|title|month|dep(artmen)?t|remarks?)\b/i;

function clean(v: unknown): string {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function isSopCode(v: unknown): boolean {
  const s = clean(v).replace(/\s+/g, '');
  return s.length >= 3 && s.length <= 40 && SOP_CODE_RE.test(s);
}

function normSop(v: unknown): string {
  return clean(v).replace(/\s+/g, '').toUpperCase();
}

function parseMonth(v: unknown): number | null {
  const t = clean(v).toLowerCase();
  if (!t) return null;
  const word = t.match(/[a-z]+/)?.[0];
  if (word && MONTH_ALIASES[word]) return MONTH_ALIASES[word];
  return null;
}

function isTick(v: unknown): boolean {
  const t = clean(v).toUpperCase();
  return Boolean(t) && TICKS.has(t);
}

/** Resolve a raw label onto a known department, or null when it is not one. */
export function resolveKnownDepartment(raw: string, known: readonly string[]): string | null {
  const text = clean(raw);
  if (!text) return null;
  const candidates = [text, ...text.split(/[_\-()\[\],.]+/).map(clean).filter(Boolean)];
  for (const c of candidates) {
    const canon = canonTrainingMatrixDepartment(c);
    if (!canon) continue;
    const hit = known.find((d) => d.toLowerCase() === canon.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

/** Majority department implied by SOP code prefixes (QAGE01 → QA). */
function deptFromCodes(codes: string[], known: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const code of codes) {
    const d = CODE_PREFIX_DEPT[code.slice(0, 2).toUpperCase()];
    const hit = d ? resolveKnownDepartment(d, known) : null;
    if (hit) counts.set(hit, (counts.get(hit) || 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [d, n] of counts) {
    if (n > bestN) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

type SopEntry = { designations: Set<string>; allDesignations: boolean; month: number | null };
type Builder = Map<string, SopEntry>;

function getBuilder(map: Map<string, Builder>, dept: string): Builder {
  let b = map.get(dept);
  if (!b) {
    b = new Map();
    map.set(dept, b);
  }
  return b;
}

/** Prefix words that change rank — "Sr. Executive" must not collapse to "Executive". */
const RANK_WORDS = new Set([
  'sr', 'senior', 'jr', 'junior', 'asst', 'assistant', 'deputy', 'dy', 'associate',
  'chief', 'head', 'trainee', 'lead', 'principal', 'general', 'gm', 'vice', 'vp',
]);

/**
 * The Excel names role-specific designations ("IPQA Officer", "Officer (Artwork)")
 * while Employee Master usually stores the base ("Officer"). Also apply each
 * column to its base designation: drop the parenthetical, then a leading
 * function qualifier unless it is a rank word.
 */
export function designationVariants(designation: string): string[] {
  const full = clean(designation);
  const out = new Set<string>([full]);
  const noParen = clean(full.replace(/\([^)]*\)/g, ' '));
  if (noParen) out.add(noParen);
  const words = noParen.split(' ');
  if (words.length >= 2) {
    const prefix = words.slice(0, -1).map((w) => w.toLowerCase().replace(/[^a-z]/g, ''));
    if (!prefix.some((w) => RANK_WORDS.has(w))) out.add(words[words.length - 1]);
  }
  return [...out].filter(Boolean);
}

function addSop(b: Builder, code: string, designation: string | null, month: number | null) {
  let e = b.get(code);
  if (!e) {
    e = { designations: new Set(), allDesignations: false, month: null };
    b.set(code, e);
  }
  if (designation) for (const d of designationVariants(designation)) e.designations.add(d);
  else e.allDesignations = true;
  if (month && !e.month) e.month = month;
}

function findHeaderCol(row: string[], re: RegExp, exclude?: RegExp): number {
  return row.findIndex((c) => re.test(c) && !(exclude && exclude.test(c)));
}

function deptFromPreamble(rows: string[][], uptoRow: number, known: readonly string[]): string | null {
  for (let r = 0; r < uptoRow; r += 1) {
    for (const cell of rows[r] || []) {
      const m = cell.match(/dep(?:artmen)?t\.?\s*(?:name)?\s*[:\-]\s*(.+)$/i);
      if (m) {
        const d = resolveKnownDepartment(m[1], known);
        if (d) return d;
      }
    }
  }
  return null;
}

type SheetResult = { ok: boolean; missingDept?: boolean };

/** Layout 1: designation headers with SOP codes listed beneath each. */
function parseDesignationColumns(
  rows: string[][],
  fallbackDept: string | null,
  known: readonly string[],
  out: Map<string, Builder>,
): SheetResult | null {
  const scanRows = Math.min(rows.length, 25);
  let best: { row: number; cols: number[] } | null = null;
  for (let r = 0; r < scanRows; r += 1) {
    const header = rows[r] || [];
    const cols: number[] = [];
    for (let c = 0; c < header.length; c += 1) {
      const h = header[c];
      if (!h || isSopCode(h) || NON_DESIGNATION_HEADER.test(h) || /^\d+$/.test(h)) continue;
      if (MONTH_ALIASES[h.toLowerCase()]) continue;
      let codes = 0;
      for (let rr = r + 1; rr < Math.min(rows.length, r + 6); rr += 1) {
        if (isSopCode(rows[rr]?.[c])) codes += 1;
      }
      if (codes >= 2) cols.push(c);
    }
    if (cols.length > 0 && (!best || cols.length > best.cols.length)) best = { row: r, cols };
  }
  if (!best) return null;

  const bannerAbove = rows
    .slice(0, best.row)
    .some((row) => row.some((c) => /designation/i.test(c)));
  if (best.cols.length < 2 && !bannerAbove) return null;

  const codes: string[] = [];
  for (const c of best.cols) {
    for (let r = best.row + 1; r < rows.length; r += 1) {
      if (isSopCode(rows[r]?.[c])) codes.push(normSop(rows[r][c]));
    }
  }
  const dept = deptFromPreamble(rows, best.row, known) ?? fallbackDept ?? deptFromCodes(codes, known);
  if (!dept) return { ok: true, missingDept: true };

  const b = getBuilder(out, dept);
  for (const c of best.cols) {
    const designation = clean(rows[best.row][c]);
    for (let r = best.row + 1; r < rows.length; r += 1) {
      const cell = rows[r]?.[c];
      if (isSopCode(cell)) addSop(b, normSop(cell), designation, null);
    }
  }
  return { ok: true };
}

/** Layout 2: list with an "SOP" column. */
function parseList(
  rows: string[][],
  fallbackDept: string | null,
  known: readonly string[],
  out: Map<string, Builder>,
): SheetResult | null {
  const scanRows = Math.min(rows.length, 25);
  for (let r = 0; r < scanRows; r += 1) {
    const header = (rows[r] || []).map((c) => c.toLowerCase());
    const sopCol = findHeaderCol(header, /sop|document\s*no|doc\.?\s*no/, /name|title|desc/);
    if (sopCol < 0) continue;
    const dataRows = rows.slice(r + 1).filter((row) => isSopCode(row[sopCol]));
    if (dataRows.length === 0) continue;

    const deptCol = findHeaderCol(header, /dep(artmen)?t/);
    const monthCol = findHeaderCol(header, /month|schedule/);
    const desigCol = findHeaderCol(header, /desig/);
    const sheetDept =
      deptFromPreamble(rows, r, known) ??
      fallbackDept ??
      deptFromCodes(dataRows.map((row) => normSop(row[sopCol])), known);

    let added = 0;
    for (const row of dataRows) {
      const dept = (deptCol >= 0 ? resolveKnownDepartment(row[deptCol], known) : null) ?? sheetDept;
      if (!dept) continue;
      const designation = desigCol >= 0 ? clean(row[desigCol]) : '';
      addSop(getBuilder(out, dept), normSop(row[sopCol]), designation || null, monthCol >= 0 ? parseMonth(row[monthCol]) : null);
      added += 1;
    }
    return { ok: true, missingDept: added === 0 };
  }
  return null;
}

/** Layout 3: employee matrix with a row of SOP codes across. */
function parseEmployeeMatrix(
  rows: string[][],
  fallbackDept: string | null,
  known: readonly string[],
  out: Map<string, Builder>,
): SheetResult | null {
  const scanRows = Math.min(rows.length, 25);
  let sopRow = -1;
  let bestN = 1;
  for (let r = 0; r < scanRows; r += 1) {
    const n = (rows[r] || []).filter(isSopCode).length;
    if (n > bestN) {
      bestN = n;
      sopRow = r;
    }
  }
  if (sopRow < 0) return null;

  const codeRow = rows[sopRow];
  const firstSopCol = codeRow.findIndex(isSopCode);
  const allCodes = codeRow.filter(isSopCode).map(normSop);
  const dept = deptFromPreamble(rows, sopRow, known) ?? fallbackDept ?? deptFromCodes(allCodes, known);
  if (!dept) return { ok: true, missingDept: true };

  // Month per column: nearest row above the SOP row with month labels, forward-filled.
  const colMonth: Array<number | null> = codeRow.map(() => null);
  for (let r = sopRow - 1; r >= 0; r -= 1) {
    const row = rows[r] || [];
    if (!row.some((c) => parseMonth(c))) continue;
    let active: number | null = null;
    for (let c = 0; c < codeRow.length; c += 1) {
      const m = parseMonth(row[c]);
      if (m) active = m;
      colMonth[c] = active;
    }
    break;
  }

  const headerRows = [rows[sopRow] || [], rows[sopRow - 1] || [], rows[sopRow - 2] || []]
    .map((row) => row.slice(0, firstSopCol).map((c) => c.toLowerCase()));
  let desigCol = -1;
  for (const h of headerRows) if (desigCol < 0) desigCol = findHeaderCol(h, /desig/);
  if (desigCol < 0 && firstSopCol >= 2) desigCol = 1;

  const b = getBuilder(out, dept);
  for (let c = firstSopCol; c < codeRow.length; c += 1) {
    if (!isSopCode(codeRow[c])) continue;
    const code = normSop(codeRow[c]);
    let any = false;
    for (let r = sopRow + 1; r < rows.length; r += 1) {
      if (!isTick(rows[r]?.[c])) continue;
      const designation = desigCol >= 0 ? clean(rows[r][desigCol]) : '';
      addSop(b, code, designation || null, colMonth[c]);
      any = true;
    }
    if (!any) addSop(b, code, null, colMonth[c]);
  }
  return { ok: true };
}

export type InductionParseResult =
  | { ok: true; departments: InductionParsedDept[] }
  | { ok: false; error: string };

export function parseInductionMatrixWorkbook(
  buffer: Buffer,
  fileName: string,
  knownDepartments: readonly string[],
): InductionParseResult {
  const known = [...new Set([...TRAINING_MATRIX_CORE_DEPARTMENTS, ...knownDepartments])];
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch (e) {
    return { ok: false, error: `Could not read Excel file: ${e instanceof Error ? e.message : String(e)}` };
  }

  const fileDept = resolveKnownDepartment(fileName.replace(/\.xlsx$/i, ''), known);
  const out = new Map<string, Builder>();
  let anyLayout = false;
  let missingDept = false;

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;
    const rows = (XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false, blankrows: true }) as unknown[][])
      .map((row) => row.map(clean));
    const sheetDept = resolveKnownDepartment(sheetName, known) ?? fileDept;
    const res =
      parseDesignationColumns(rows, sheetDept, known, out) ??
      parseList(rows, sheetDept, known, out) ??
      parseEmployeeMatrix(rows, sheetDept, known, out);
    if (res?.ok) anyLayout = true;
    if (res?.missingDept) missingDept = true;
  }

  if (out.size === 0) {
    if (anyLayout && missingDept) {
      return {
        ok: false,
        error: `Could not determine the department. Name the file or sheet after the department (e.g. "QA") or add a Department column. Known: ${known.join(', ')}.`,
      };
    }
    return {
      ok: false,
      error: 'No SOP codes found. Expected designation columns listing SOP codes, an "SOP No" column, or a row of SOP codes.',
    };
  }

  const departments: InductionParsedDept[] = [];
  for (const [department, b] of out) {
    departments.push({
      department,
      sops: [...b.entries()].map(([sopCode, e]) => ({
        sopCode,
        // Any "whole department" row means the SOP applies to every designation.
        designations: e.allDesignations ? [] : [...e.designations].sort((x, y) => x.localeCompare(y)),
        month: e.month,
      })),
    });
  }
  return { ok: true, departments };
}
