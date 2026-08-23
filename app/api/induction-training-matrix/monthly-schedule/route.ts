import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import InductionTrainingMatrixUpload from '@/models/InductionTrainingMatrixUpload';
import InductionTrainingMatrixRecord from '@/models/InductionTrainingMatrixRecord';
import { getLeftEmployeeKeys, isLeftEmployee } from '@/lib/leftEmployees';

export const dynamic = 'force-dynamic';

function stripVersion(code: string): string {
  return String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTH_NAME_TO_NUM: Record<string, number> = Object.fromEntries(
  MONTH_NAMES.map((m, i) => [m.toLowerCase(), i + 1]),
);

function normalizeDept(raw: string | undefined | null): string {
  const u = String(raw || '').trim();
  if (!u) return '';
  const up = u.toUpperCase();
  if (up === 'QA') return 'QA';
  if (up === 'QC') return 'QC';
  if (/^MICRO/.test(up)) return 'Microbiology';
  if (/^PROD/.test(up)) return 'Production';
  if (/^STOR/.test(up)) return 'Store';
  if (/^ENG/.test(up)) return 'Engineering';
  if (/^PERSON/.test(up) || up === 'HR') return 'Personnel';
  return u;
}

type ScheduleAssignment = {
  department: string;
  month: number;
  monthName: string;
  year: number;
};

// GET /api/induction-training-matrix/monthly-schedule?sopCode=QAGE01-10
//
// Returns month-wise employee counts plus every (department, month) assignment
// for the SOP — including multiple months per department when versioned Excel
// columns or manual Manage SOP allocations map the same base code differently.
export async function GET(req: NextRequest) {
  try {
    await connectDB();
    const sopCode = req.nextUrl.searchParams.get('sopCode');
    if (!sopCode) {
      return NextResponse.json({ error: 'sopCode is required' }, { status: 400 });
    }

    const base = stripVersion(sopCode);
    const sopCodePattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`, 'i');

    const [uploads, records, leftKeys] = await Promise.all([
      InductionTrainingMatrixUpload.find(
        { 'snapshot.sopMonthMap': { $exists: true } },
        { department: 1, year: 1, snapshot: 1 },
      ).lean(),
      InductionTrainingMatrixRecord.find({
        status: { $ne: 'na' },
        sopCode: sopCodePattern,
      })
        .select('department month monthName year')
        .lean(),
      getLeftEmployeeKeys(),
    ]);

    const assignmentKeys = new Set<string>();
    const assignments: ScheduleAssignment[] = [];
    // Departments whose month is fixed by the latest Excel upload. The Excel
    // snapshot is the source of truth (it drives the matrix), so manual
    // record allocations must not add extra months for a department that is
    // already assigned via Excel.
    const excelAssignedDepts = new Set<string>();

    const addAssignment = (department: string, monthName: string, year: number) => {
      const dept = normalizeDept(department);
      const monthNum = MONTH_NAME_TO_NUM[String(monthName || '').trim().toLowerCase()];
      if (!dept || !monthNum) return;
      const key = `${dept}|${monthNum}|${year}`;
      if (assignmentKeys.has(key)) return;
      assignmentKeys.add(key);
      assignments.push({
        department: dept,
        month: monthNum,
        monthName: MONTH_NAMES[monthNum - 1] || monthName,
        year,
      });
    };

    const byMonthYear = new Map<
      string,
      { month: number; year: number; monthName: string; count: number }
    >();

    for (const upload of uploads) {
      const snap = (upload as any).snapshot as {
        sopMonthMap?: Record<string, string>;
        employees?: Array<{ name?: string; training?: Record<string, boolean> }>;
      } | undefined;

      if (!snap?.sopMonthMap || !snap?.employees) continue;

      const dept = normalizeDept((upload as any).department);
      const year: number = (upload as any).year ?? new Date().getFullYear();

      const baseToRawKeys: Record<string, string[]> = {};
      for (const [rawKey, monthName] of Object.entries(snap.sopMonthMap)) {
        const b = stripVersion(rawKey);
        if (b !== base) continue;
        addAssignment(dept, monthName, year);
        if (dept) excelAssignedDepts.add(dept);
        if (!baseToRawKeys[b]) baseToRawKeys[b] = [];
        baseToRawKeys[b].push(rawKey);
      }

      const rawKeys = new Set<string>(baseToRawKeys[base] ?? []);
      rawKeys.add(base);
      if (!rawKeys.size) continue;

      for (const [rawKey, monthName] of Object.entries(snap.sopMonthMap)) {
        if (!rawKeys.has(rawKey)) continue;

        const monthNum = MONTH_NAME_TO_NUM[monthName.toLowerCase()];
        if (!monthNum) continue;

        const key = `${monthNum}-${year}`;
        const empCount = snap.employees.filter(
          (e) =>
            !isLeftEmployee(leftKeys, dept, e.name) &&
            e.training?.[rawKey] === true,
        ).length;

        const existing = byMonthYear.get(key);
        if (existing) {
          existing.count += empCount;
        } else {
          byMonthYear.set(key, { month: monthNum, year, monthName, count: empCount });
        }
      }
    }

    for (const r of records as Array<{
      department?: string;
      month?: number;
      monthName?: string;
      year?: number;
    }>) {
      // Skip manual allocations for departments already pinned by Excel.
      if (excelAssignedDepts.has(normalizeDept(r.department))) continue;
      const monthName = r.monthName || MONTH_NAMES[(r.month || 1) - 1] || '';
      addAssignment(String(r.department || ''), monthName, r.year ?? new Date().getFullYear());
    }

    assignments.sort(
      (a, b) =>
        a.department.localeCompare(b.department) ||
        a.year - b.year ||
        a.month - b.month,
    );

    const schedule = [...byMonthYear.values()].sort((a, b) =>
      a.year !== b.year ? a.year - b.year : a.month - b.month,
    );

    return NextResponse.json({ sopCode: base, schedule, assignments });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
