import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import * as XLSX from 'xlsx';

import { invalidateTrainingMatrixCache } from '@/lib/trainingMatrixCache';
import { invalidateManageSopViewCache } from '@/lib/manageSopViewCache';
import { bustTrainerScheduleCaches } from '@/lib/lmsTrainerCache';
import { sopBaseDisplayFromIdentifier, sopFamilyCodesMatch } from '@/lib/sopIdentifierNormalize';
import { syncEmployeesFromMatrix } from '@/lib/syncEmployeesFromMatrix';
import MatrixSOPAssignment from '@/models/MatrixSOPAssignment';
import SOP from '@/models/SOP';
import TrainingMatrixRecord from '@/models/TrainingMatrixRecord';
import TrainingMatrixUpload from '@/models/TrainingMatrixUpload';

type DeptFile = {
  department: string;
  filePath: string;
};

type ColumnDef = {
  monthName: string;
  month: number;
  sopCode: string;
};

type ParsedEmployee = {
  name: string;
  designation: string;
  training: Record<string, boolean>;
};

type ParsedWorkbook = {
  department: string;
  filePath: string;
  fileName: string;
  year: number;
  employees: ParsedEmployee[];
  columns: ColumnDef[];
  sopCodes: string[];
  sopMonthMap: Record<string, string>;
  monthCounts: Record<string, number>;
  recordCount: number;
};

const FILES: DeptFile[] = [
  {
    department: 'QA',
    filePath: 'c:\\dev\\software\\sop\\docs\\excel\\1. Training Matrix_QA (TM-QA-26-00).xlsx',
  },
  {
    department: 'QC',
    filePath: 'c:\\dev\\software\\sop\\docs\\excel\\2. Training Matrix_QC (TM-QC-26-00).xlsx',
  },
  {
    department: 'Microbiology',
    filePath: 'c:\\dev\\software\\sop\\docs\\excel\\3. Training Matrix_Microbiology (TM-MI-26-00).xlsx',
  },
  {
    department: 'Production',
    filePath: 'c:\\dev\\software\\sop\\docs\\excel\\4. Training Matrix_Production (TM-PR-26-00).xlsx',
  },
  {
    department: 'Store',
    filePath: 'c:\\dev\\software\\sop\\docs\\excel\\5. Training Matrix_Store (TM-ST-26-00).xlsx',
  },
  {
    department: 'Engineering',
    filePath: 'c:\\dev\\software\\sop\\docs\\excel\\6. Training Matrix_Engineering (TM-EN-26-00).xlsx',
  },
  {
    department: 'Personnel',
    filePath: 'c:\\dev\\software\\sop\\docs\\excel\\7. Training Matrix_Personnel (TM-PE-26-00).xlsx',
  },
];

const MONTH_NAME_TO_NUM: Record<string, number> = {
  JANUARY: 1,
  FEBRUARY: 2,
  MARCH: 3,
  APRIL: 4,
  MAY: 5,
  JUNE: 6,
  JULY: 7,
  AUGUST: 8,
  SEPTEMBER: 9,
  OCTOBER: 10,
  NOVEMBER: 11,
  DECEMBER: 12,
};

const MONTH_NUM_TO_NAME = [
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

function loadEnv() {
  const envPath = path.join(process.cwd(), '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('Please define MONGODB_URI in .env.local');
  }
  await mongoose.connect(uri);
}

function parseYearFromFileName(fileName: string): number {
  const m = fileName.match(/-([0-9]{2})-[0-9]{2}\)\.xlsx$/i);
  if (!m) return new Date().getFullYear();
  return 2000 + Number(m[1]);
}

function cleanCell(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeSopCode(value: unknown): string {
  return cleanCell(value).toUpperCase();
}

function isAssignedCell(value: unknown): boolean {
  const raw = cleanCell(value);
  if (!raw) return false;
  const normalized = raw.toUpperCase();
  return ['√', '✓', '✔', 'TRUE', 'YES', 'Y', '1'].includes(normalized);
}

function stripVersion(code: string): string {
  return String(code || '')
    .toUpperCase()
    .replace(/-\d+$/, '')
    .trim();
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function parseWorkbook(entry: DeptFile): ParsedWorkbook {
  const workbook = XLSX.readFile(entry.filePath, { cellDates: false });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!firstSheet || !firstSheet['!ref']) {
    throw new Error(`No usable sheet found in ${entry.filePath}`);
  }

  const range = XLSX.utils.decode_range(firstSheet['!ref']);
  let activeMonth = '';
  const columns: ColumnDef[] = [];
  for (let col = 2; col <= range.e.c; col += 1) {
    const monthCell = firstSheet[XLSX.utils.encode_cell({ r: 0, c: col })];
    const sopCell = firstSheet[XLSX.utils.encode_cell({ r: 1, c: col })];
    const monthLabel = cleanCell(monthCell?.v);
    if (monthLabel) activeMonth = monthLabel.toUpperCase();
    const sopCode = normalizeSopCode(sopCell?.v);
    if (!activeMonth || !sopCode) continue;
    const month = MONTH_NAME_TO_NUM[activeMonth];
    if (!month) {
      throw new Error(`Unknown month header "${activeMonth}" in ${entry.filePath}`);
    }
    columns.push({ monthName: MONTH_NUM_TO_NAME[month], month, sopCode });
  }

  const employees: ParsedEmployee[] = [];
  let recordCount = 0;
  for (let row = 2; row <= range.e.r; row += 1) {
    const name = cleanCell(firstSheet[XLSX.utils.encode_cell({ r: row, c: 0 })]?.v);
    const designation = cleanCell(firstSheet[XLSX.utils.encode_cell({ r: row, c: 1 })]?.v);
    if (!name) continue;

    const training: Record<string, boolean> = {};
    for (const [index, column] of columns.entries()) {
      const cell = firstSheet[XLSX.utils.encode_cell({ r: row, c: index + 2 })];
      if (!isAssignedCell(cell?.v)) continue;
      training[column.sopCode] = true;
      recordCount += 1;
    }

    employees.push({ name, designation, training });
  }

  const monthMap = new Map<string, string[]>();
  const monthCounts: Record<string, number> = {};
  for (const column of columns) {
    if (!monthMap.has(column.sopCode)) monthMap.set(column.sopCode, []);
    const months = monthMap.get(column.sopCode)!;
    if (!months.includes(column.monthName)) months.push(column.monthName);
    monthCounts[column.monthName] = (monthCounts[column.monthName] || 0) + 1;
  }

  const sopMonthMap: Record<string, string> = {};
  for (const [sopCode, months] of monthMap.entries()) {
    sopMonthMap[sopCode] = months.join(',');
  }

  const fileName = path.basename(entry.filePath);
  return {
    department: entry.department,
    filePath: entry.filePath,
    fileName,
    year: parseYearFromFileName(fileName),
    employees,
    columns,
    sopCodes: dedupeStrings(columns.map((c) => c.sopCode)),
    sopMonthMap,
    monthCounts,
    recordCount,
  };
}

async function buildSopLookup() {
  const docs = await SOP.find({ isObsolete: { $ne: true } })
    .select('_id identifier name sopBaseId versionNum')
    .lean<Array<{ _id: mongoose.Types.ObjectId; identifier?: string; name?: string; sopBaseId?: string; versionNum?: number }>>();

  const byBase = new Map<string, { _id: mongoose.Types.ObjectId; identifier: string; name: string; versionNum: number }>();
  const all = new Map<string, { _id: mongoose.Types.ObjectId; identifier: string; name: string; versionNum: number }>();

  for (const doc of docs) {
    const identifier = cleanCell(doc.identifier).toUpperCase();
    const base = cleanCell(doc.sopBaseId || identifier || stripVersion(identifier)).toUpperCase();
    if (!identifier || !base) continue;
    const candidate = {
      _id: doc._id,
      identifier,
      name: cleanCell(doc.name) || identifier,
      versionNum: Number(doc.versionNum || 0),
    };
    const existing = byBase.get(base);
    if (!existing || candidate.versionNum >= existing.versionNum) {
      byBase.set(base, candidate);
    }
    all.set(identifier, candidate);
  }

  const resolve = (excelCode: string) => {
    const directBase = byBase.get(stripVersion(excelCode));
    if (directBase) return directBase;

    const padded = sopBaseDisplayFromIdentifier(excelCode);
    if (padded) {
      const byPaddedBase = byBase.get(stripVersion(padded));
      if (byPaddedBase) return byPaddedBase;
    }

    for (const candidate of all.values()) {
      if (sopFamilyCodesMatch(candidate.identifier, excelCode)) return candidate;
    }
    return undefined;
  };

  return { resolve };
}

async function applyWorkbook(parsed: ParsedWorkbook, sopLookup: Awaited<ReturnType<typeof buildSopLookup>>) {
  const department = parsed.department;
  const year = parsed.year;

  const upload = await TrainingMatrixUpload.create({
    department,
    fileName: parsed.fileName,
    fileType: 'main',
    month: 1,
    year,
    monthName: 'January',
    employeeCount: parsed.employees.length,
    sopCount: parsed.sopCodes.length,
    recordsImported: parsed.recordCount,
    uploadedAt: new Date(),
    uploadedBy: 'excel-sync',
    snapshot: {
      sopCodes: parsed.sopCodes,
      sopMonthMap: parsed.sopMonthMap,
      monthCounts: parsed.monthCounts,
      employees: parsed.employees,
    },
  });

  await TrainingMatrixRecord.deleteMany({ department, year });

  const recordOps: mongoose.AnyBulkWriteOperation[] = [];
  for (const employee of parsed.employees) {
    for (const column of parsed.columns) {
      if (!employee.training[column.sopCode]) continue;
      recordOps.push({
        insertOne: {
          document: {
            uploadId: upload._id,
            department,
            employeeName: employee.name,
            designation: employee.designation,
            sopCode: column.sopCode,
            sopName: column.sopCode,
            month: column.month,
            year,
            monthName: column.monthName,
            status: 'completed',
            rawSymbol: '√',
            sourceFile: parsed.fileName,
            isAddendum: false,
          },
        },
      });
    }
  }
  if (recordOps.length > 0) {
    await TrainingMatrixRecord.bulkWrite(recordOps, { ordered: false });
  }

  const assignedDesignationsBySop = new Map<string, Set<string>>();
  for (const employee of parsed.employees) {
    for (const sopCode of Object.keys(employee.training)) {
      if (!assignedDesignationsBySop.has(sopCode)) {
        assignedDesignationsBySop.set(sopCode, new Set());
      }
      if (employee.designation) {
        assignedDesignationsBySop.get(sopCode)!.add(employee.designation);
      }
    }
  }

  const activeRows = await MatrixSOPAssignment.find({ department, isActive: true })
    .select('_id sopCode')
    .lean<Array<{ _id: mongoose.Types.ObjectId; sopCode: string }>>();
  const activeByBase = new Map<string, Array<{ _id: mongoose.Types.ObjectId; sopCode: string }>>();
  for (const row of activeRows) {
    const base = stripVersion(row.sopCode);
    if (!activeByBase.has(base)) activeByBase.set(base, []);
    activeByBase.get(base)!.push(row);
  }

  const workbookBases = new Set(parsed.sopCodes.map((code) => stripVersion(code)));
  const staleIds = activeRows
    .filter((row) => !workbookBases.has(stripVersion(row.sopCode)))
    .map((row) => row._id);
  if (staleIds.length > 0) {
    await MatrixSOPAssignment.updateMany(
      { _id: { $in: staleIds } },
      {
        $set: {
          isActive: false,
          deletedAt: new Date(),
          deletedBy: 'excel-sync',
          updatedBy: 'excel-sync',
        },
      },
    );
  }

  for (const sopCode of parsed.sopCodes) {
    const base = stripVersion(sopCode);
    const sopMeta = sopLookup.resolve(base);
    if (!sopMeta) continue;
    const designations = Array.from(assignedDesignationsBySop.get(sopCode) || []).sort((a, b) =>
      a.localeCompare(b),
    );
    const monthNames = cleanCell(parsed.sopMonthMap[sopCode])
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
    const effectiveMonth = MONTH_NAME_TO_NUM[(monthNames[0] || 'JANUARY').toUpperCase()] || 1;

    const existing = activeByBase.get(base) || [];
    if (existing.length > 0) {
      await MatrixSOPAssignment.updateMany(
        { _id: { $in: existing.map((row) => row._id) } },
        {
          $set: {
            sopId: sopMeta._id,
            sopCode: sopMeta.identifier,
            sopName: sopMeta.name,
            effectiveMonth,
            effectiveYear: year,
            designationApplicability: designations,
            isActive: true,
            deletedAt: undefined,
            deletedBy: undefined,
            updatedBy: 'excel-sync',
          },
        },
      );
      continue;
    }

    await MatrixSOPAssignment.create({
      department,
      sopId: sopMeta._id,
      sopCode: sopMeta.identifier,
      sopName: sopMeta.name,
      effectiveMonth,
      effectiveYear: year,
      designationApplicability: designations,
      isActive: true,
      createdBy: 'excel-sync',
      updatedBy: 'excel-sync',
    });
  }

  return {
    department,
    employees: parsed.employees.length,
    sopCodes: parsed.sopCodes.length,
    records: parsed.recordCount,
  };
}

async function main() {
  loadEnv();
  const apply = process.argv.includes('--apply');
  const parsed = FILES.map(parseWorkbook);
  await connectMongo();
  const sopLookup = await buildSopLookup();

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : 'dry-run',
        workbooks: parsed.map((item) => ({
          department: item.department,
          fileName: item.fileName,
          year: item.year,
          employees: item.employees.length,
          sopCodes: item.sopCodes.length,
          assignedCells: item.recordCount,
          missingInSopDb: item.sopCodes
            .map((code) => stripVersion(code))
            .filter((base) => !sopLookup.resolve(base)),
        })),
      },
      null,
      2,
    ),
  );

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to write DB changes.');
    await mongoose.disconnect();
    return;
  }

  const results = [];
  for (const workbook of parsed) {
    results.push(await applyWorkbook(workbook, sopLookup));
  }

  const employeeSync = await syncEmployeesFromMatrix();
  bustTrainerScheduleCaches();
  await Promise.all([
    invalidateTrainingMatrixCache(),
    invalidateManageSopViewCache(),
  ]);

  console.log(
    JSON.stringify(
      {
        applied: results,
        employeeSync,
      },
      null,
      2,
    ),
  );

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await mongoose.disconnect();
  } catch {
    // ignore disconnect failures on fatal exit
  }
  process.exit(1);
});
