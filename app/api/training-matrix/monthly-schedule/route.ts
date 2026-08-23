import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import TrainingMatrixUpload from '@/models/TrainingMatrixUpload';
import TrainingMatrixRecord from '@/models/TrainingMatrixRecord';
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

type UploadSnap = {
  sopMonthMap?: Record<string, string>;
  sopCodes?: string[];
  employees?: Array<{ name?: string; training?: Record<string, boolean> }>;
};

// GET /api/training-matrix/monthly-schedule?sopCode=QAGE01-10
//
// Returns month-wise employee counts plus every (department, month) assignment
// for the SOP from the latest Excel upload per department (matching overview)
// plus manual Manage SOP allocations from TrainingMatrixRecord.
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
      TrainingMatrixUpload.find({ 'snapshot.sopMonthMap': { $exists: true } })
        .sort({ uploadedAt: -1 })
        .select('department year snapshot uploadedAt')
        .lean(),
      TrainingMatrixRecord.find({
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
    // TrainingMatrixRecord allocations must not add extra months for a
    // department that is already assigned via Excel.
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

    // Keep only the newest upload per department — same rule as overview route.
    const latestByDept = new Map<string, { department: string; year?: number; snapshot?: UploadSnap }>();
    for (const upload of uploads as Array<{ department: string; year?: number; snapshot?: UploadSnap }>) {
      const dept = normalizeDept(upload.department);
      if (!dept || latestByDept.has(dept)) continue;
      latestByDept.set(dept, upload);
    }

    for (const upload of latestByDept.values()) {
      const snap = upload.snapshot;
      if (!snap?.sopMonthMap || !snap?.employees) continue;

      const dept = normalizeDept(upload.department);
      const year: number = upload.year ?? new Date().getFullYear();

      // Normalize sopMonthMap to one month per base code — same as overview route.
      const sopMonthMap: Record<string, string> = {};
      for (const [k, m] of Object.entries(snap.sopMonthMap)) {
        const b = stripVersion(k);
        if (b && m) sopMonthMap[b] = m;
      }

      const excelCodes = new Set<string>((snap.sopCodes || []).map(stripVersion).filter(Boolean));
      const monthNameRaw = sopMonthMap[base];
      const monthNames = monthNameRaw
        ? monthNameRaw.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
      const inExcel = excelCodes.has(base);

      if (monthNames.length === 0 && !inExcel) continue;

      if (monthNames.length > 0) {
        if (dept) excelAssignedDepts.add(dept);
        const empCount = snap.employees.filter((e) =>
          !isLeftEmployee(leftKeys, dept, e.name) &&
          Object.entries(e.training || {}).some(([k, v]) => stripVersion(k) === base && v === true),
        ).length;

        for (const monthName of monthNames) {
          addAssignment(dept, monthName, year);

          const monthNum = MONTH_NAME_TO_NUM[monthName.toLowerCase()];
          if (monthNum) {
            const key = `${monthNum}-${year}`;
            const existing = byMonthYear.get(key);
            if (existing) {
              existing.count += empCount;
            } else {
              byMonthYear.set(key, { month: monthNum, year, monthName, count: empCount });
            }
          }
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
