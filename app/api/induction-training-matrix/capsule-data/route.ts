import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import InductionTrainingMatrixRecord from '@/models/InductionTrainingMatrixRecord';
import SOP from '@/models/SOP';
import { getLeftEmployeeKeys, isLeftEmployee, isLeftEmployeeName } from '@/lib/leftEmployees';

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const sp = request.nextUrl.searchParams;

    const view   = sp.get('view')       || 'dept';    // 'dept' | 'employee'
    const monthP = sp.get('month')      || 'all';
    const yearP  = sp.get('year')       || new Date().getFullYear().toString();
    const deptF  = sp.get('department') || 'all';
    const empF   = (sp.get('employee')  || '').trim();
    const sopF   = (sp.get('sop')       || '').trim();
    const statusF = sp.get('status')    || 'all';     // 'pending' | 'completed' | 'all'
    const examF   = sp.get('examPending') || 'false';
    const includeObsolete = sp.get('includeObsolete') === '1';

    const match: Record<string, any> = {};
    if (monthP !== 'all') match.month      = parseInt(monthP);
    if (yearP  !== 'all') match.year       = parseInt(yearP);
    if (deptF  !== 'all') match.department = deptF;
    if (empF)             match.employeeName = { $regex: empF, $options: 'i' };
    if (sopF)             match.sopCode      = { $regex: sopF, $options: 'i' };

    // Default: hide obsolete SOP codes from all training-matrix views
    // (InductionTrainingMatrixRecord stores SOP codes without version; SOP.identifier may have version.)
    const stripVersion = (code: string) =>
      String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
    const obsoleteBaseSet = (() => {
      // lazy populated below only when needed
      return new Set<string>();
    })();
    if (!includeObsolete) {
      const obs = await SOP.find({ isObsolete: true }, { identifier: 1 }).lean() as any[];
      for (const r of obs) {
        const base = stripVersion(String(r?.identifier || ''));
        if (base) obsoleteBaseSet.add(base);
      }
    }

    const [recordsRaw, leftKeys] = await Promise.all([
      InductionTrainingMatrixRecord.find(match).lean(),
      getLeftEmployeeKeys(),
    ]);
    const records = (includeObsolete
      ? recordsRaw
      : recordsRaw.filter((r: any) => !obsoleteBaseSet.has(stripVersion(String(r?.sopCode || ''))))
    ).filter((r: any) => !isLeftEmployee(leftKeys, r.department, r.employeeName));

    // ── Fetch exam data from TrainingMatrix (linked test sessions) ────────────
    let examRows: Array<{
      employeeName: string;
      department: string;
      sopIdentifier: string;
      passStatus: string;
      trainingDate: Date;
    }> = [];
    try {
      const TM = (await import('@/models/TrainingMatrix')).default;
      const examMatch: Record<string, any> = {};
      if (deptF !== 'all') examMatch.department = deptF;
      if (empF)             examMatch.employeeName = { $regex: empF, $options: 'i' };
      examRows = await TM.find(examMatch, {
        employeeName: 1, department: 1, sopIdentifier: 1,
        passStatus: 1, trainingDate: 1,
      }).lean() as any[];
      examRows = examRows.filter((e) => !isLeftEmployee(leftKeys, e.department, e.employeeName));
    } catch (_) { /* no exam data */ }

    // Build exam lookup: key = `dept|emp|sopCode` → passStatus
    // Also count per dept+month and per emp+month
    const examByDeptMonth = new Map<string, { total: number; completed: number; pending: number }>();
    const examByEmpMonth  = new Map<string, { total: number; completed: number; pending: number; pendingSops: string[] }>();

    for (const e of examRows) {
      const d = new Date(e.trainingDate);
      const eMonth = d.getMonth() + 1;
      const eYear  = d.getFullYear();
      if (monthP !== 'all' && eMonth !== parseInt(monthP)) continue;
      if (yearP  !== 'all' && eYear  !== parseInt(yearP))  continue;

      const dKey = `${eYear}-${eMonth}|${e.department}`;
      if (!examByDeptMonth.has(dKey)) examByDeptMonth.set(dKey, { total: 0, completed: 0, pending: 0 });
      const de = examByDeptMonth.get(dKey)!;
      de.total++;
      if (e.passStatus === 'Pass' || e.passStatus === 'Fail') de.completed++;
      else de.pending++;

      const eKey = `${eYear}-${eMonth}|${e.employeeName}`;
      if (!examByEmpMonth.has(eKey)) examByEmpMonth.set(eKey, { total: 0, completed: 0, pending: 0, pendingSops: [] });
      const ee = examByEmpMonth.get(eKey)!;
      ee.total++;
      if (e.passStatus === 'Pass' || e.passStatus === 'Fail') ee.completed++;
      else { ee.pending++; ee.pendingSops.push(e.sopIdentifier); }
    }

    // ── Fetch SOP file availability (docx/pdf) for missing-file counts ────────
    // Build sopCode → { hasDocx, hasPdf } map
    const sopFileMap = new Map<string, { hasDocx: boolean; hasPdf: boolean }>();
    try {
      // Collect all sopCodes in our records
      const allSopCodes = [...new Set(records.map(r => r.sopCode))];
      if (allSopCodes.length > 0) {
        const sopDocs = await SOP.find({ identifier: { $in: allSopCodes } }, {
          identifier: 1, fileType: 1,
        }).lean() as any[];
        // A SOP identifier might have both docx and pdf entries
        for (const s of sopDocs) {
          const existing = sopFileMap.get(s.identifier) || { hasDocx: false, hasPdf: false };
          if (s.fileType === 'docx') existing.hasDocx = true;
          if (s.fileType === 'pdf')  existing.hasPdf  = true;
          sopFileMap.set(s.identifier, existing);
        }
      }
    } catch (_) { /* SOP file check unavailable */ }

    // ─────────────────────────────────────────────────────────────────────────
    // VIEW: DEPARTMENT WISE
    // ─────────────────────────────────────────────────────────────────────────
    if (view === 'dept') {
      // Group: month+year → department → aggregated stats
      type DeptCapsule = {
        department: string;
        month: number;
        monthName: string;
        year: number;
        sopCount: number;
        employeeCount: number;
        examsScheduled: number;
        examsCompleted: number;
        examsPending: number;
        completed: number;
        pending: number;
        notRequired: number;
        na: number;
        total: number;
        completionPct: number;
        topPendingSops: string[];
        topPendingEmployees: string[];
        missingDocx: number;
        missingPdf: number;
      };

      type MonthGroup = {
        month: number;
        monthName: string;
        year: number;
        capsules: DeptCapsule[];
      };

      // month+year → dept → { sopCodes, employees, statuses, ... }
      // TERMINOLOGY:
      //   pending    = tick (√) = employee IS scheduled/required for this SOP — exam not yet done
      //   completed  = explicitly marked done/trained — exam passed
      //   notRequired = X / empty = not applicable to this employee
      const monthDeptMap = new Map<string, Map<string, {
        // Only SOPs that have a tick (scheduled) — not_required SOPs are not "assigned"
        scheduledSopCodes: Set<string>;
        employees: Set<string>;
        trainedCount: number;    // completed (done/trained)
        pendingCount: number;    // pending (tick = scheduled, not yet done)
        notRequired: number;
        na: number;
        // sopCode → employees who still have tick (pending)
        sopPendingEmps: Map<string, Set<string>>;
        // employee → count of pending (tick) SOPs
        empPending: Map<string, number>;
      }>>();

      for (const r of records) {
        const mk = `${r.year}-${r.month}`;
        if (!monthDeptMap.has(mk)) monthDeptMap.set(mk, new Map());
        const dm = monthDeptMap.get(mk)!;

        if (!dm.has(r.department)) {
          dm.set(r.department, {
            scheduledSopCodes: new Set(), employees: new Set(),
            trainedCount: 0, pendingCount: 0, notRequired: 0, na: 0,
            sopPendingEmps: new Map(), empPending: new Map(),
          });
        }
        const ds = dm.get(r.department)!;
        ds.employees.add(r.employeeName);

        if (r.status === 'completed') {
          // Marked as done/trained — counts as scheduled
          ds.trainedCount++;
          ds.scheduledSopCodes.add(r.sopCode);
        } else if (r.status === 'pending') {
          // Tick (√) — scheduled but not yet trained
          ds.pendingCount++;
          ds.scheduledSopCodes.add(r.sopCode);
          if (!ds.sopPendingEmps.has(r.sopCode)) ds.sopPendingEmps.set(r.sopCode, new Set());
          ds.sopPendingEmps.get(r.sopCode)!.add(r.employeeName);
          ds.empPending.set(r.employeeName, (ds.empPending.get(r.employeeName) || 0) + 1);
        } else if (r.status === 'not_required') {
          ds.notRequired++;
        } else {
          ds.na++;
        }
      }

      const monthGroups: MonthGroup[] = [];
      for (const [mk, dm] of monthDeptMap) {
        const [yr, mo] = mk.split('-').map(Number);
        const capsules: DeptCapsule[] = [];

        for (const [dept, ds] of dm) {
          // scheduledCount = employees who have a tick (pending) + those marked done
          const scheduledCount = ds.trainedCount + ds.pendingCount;
          // completionPct = how many of the scheduled ones are actually done
          const pct = scheduledCount > 0 ? Math.round((ds.trainedCount / scheduledCount) * 100) : 0;

          // Top pending SOPs = SOPs with most employees still having a tick
          const topPendingSops = [...ds.sopPendingEmps.entries()]
            .sort((a, b) => b[1].size - a[1].size)
            .slice(0, 5)
            .map(([code]) => code);

          // Top pending employees = employees with most tick-SOPs still pending
          const topPendingEmployees = [...ds.empPending.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([name]) => name);

          // Missing DOCX / PDF — only check SOPs that are actually scheduled (have a tick)
          let missingDocx = 0, missingPdf = 0;
          for (const sopCode of ds.scheduledSopCodes) {
            const fileInfo = sopFileMap.get(sopCode);
            if (!fileInfo || !fileInfo.hasDocx) missingDocx++;
            if (!fileInfo || !fileInfo.hasPdf)  missingPdf++;
          }

          // Exam data
          const examKey = `${yr}-${mo}|${dept}`;
          const exam = examByDeptMonth.get(examKey) || { total: 0, completed: 0, pending: 0 };

          // Status filter
          if (statusF === 'pending'   && ds.pendingCount  === 0) continue;
          if (statusF === 'completed' && ds.trainedCount  === 0) continue;
          if (examF === 'true'        && exam.pending     === 0) continue;

          capsules.push({
            department:      dept,
            month:           mo,
            monthName:       records.find(r => r.month === mo && r.year === yr)?.monthName || '',
            year:            yr,
            sopCount:        ds.scheduledSopCodes.size,  // only scheduled SOPs
            employeeCount:   ds.employees.size,
            examsScheduled:  exam.total,
            examsCompleted:  exam.completed,
            examsPending:    exam.pending,
            completed:       ds.trainedCount,    // done/trained count
            pending:         ds.pendingCount,    // tick = scheduled, not yet trained
            notRequired:     ds.notRequired,
            na:              ds.na,
            total:           scheduledCount,     // total scheduled (tick + done)
            completionPct:   pct,
            topPendingSops,
            topPendingEmployees,
            missingDocx,
            missingPdf,
          });
        }

        // Sort capsules alphabetically by department
        capsules.sort((a, b) => a.department.localeCompare(b.department));

        if (capsules.length > 0) {
          monthGroups.push({
            month: mo, year: yr,
            monthName: capsules[0]?.monthName || '',
            capsules,
          });
        }
      }

      monthGroups.sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);

      // Filter options
      const departments = await InductionTrainingMatrixRecord.distinct('department');
      const years = (await InductionTrainingMatrixRecord.distinct('year')).sort();
      const monthsRaw = await InductionTrainingMatrixRecord.aggregate([
        { $group: { _id: { month: '$month', monthName: '$monthName', year: '$year' } } },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]);
      const months = monthsRaw.map(m => ({ month: m._id.month, monthName: m._id.monthName, year: m._id.year }));

      return NextResponse.json({ success: true, view: 'dept', monthGroups, filters: { departments, years, months } });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // VIEW: EMPLOYEE WISE
    // ─────────────────────────────────────────────────────────────────────────
    type EmpCapsule = {
      employeeName: string;
      department: string;
      designation: string;
      month: number;
      monthName: string;
      year: number;
      totalScheduled: number;
      examsScheduled: number;
      examsCompleted: number;
      examsPending: number;
      completed: number;
      pending: number;
      notRequired: number;
      na: number;
      completionPct: number;
      pendingSopCodes: string[];
      completedSopCodes: string[];
      upcomingExamSops: string[];
      missingTraining: number;
    };

    // emp+month → EmpCapsule
    const empMonthMap = new Map<string, EmpCapsule>();

    for (const r of records) {
      const key = `${r.employeeName}|${r.year}-${r.month}`;
      if (!empMonthMap.has(key)) {
        empMonthMap.set(key, {
          employeeName: r.employeeName,
          department:   r.department,
          designation:  r.designation,
          month:        r.month,
          monthName:    r.monthName,
          year:         r.year,
          totalScheduled: 0,
          examsScheduled: 0, examsCompleted: 0, examsPending: 0,
          completed: 0, pending: 0, notRequired: 0, na: 0,
          completionPct: 0,
          pendingSopCodes: [], completedSopCodes: [], upcomingExamSops: [],
          missingTraining: 0,
        });
      }
      const cap = empMonthMap.get(key)!;
      // Only count as scheduled if tick (pending) or explicitly done (completed)
      if (r.status === 'completed') {
        cap.totalScheduled++;
        cap.completed++;
        cap.completedSopCodes.push(r.sopCode);
      } else if (r.status === 'pending') {
        cap.totalScheduled++;
        cap.pending++;
        cap.pendingSopCodes.push(r.sopCode);
      } else if (r.status === 'not_required') {
        cap.notRequired++;
      } else {
        cap.na++;
      }
    }

    // Enrich with exam data
    for (const [, cap] of empMonthMap) {
      const eKey = `${cap.year}-${cap.month}|${cap.employeeName}`;
      const exam = examByEmpMonth.get(eKey);
      if (exam) {
        cap.examsScheduled  = exam.total;
        cap.examsCompleted  = exam.completed;
        cap.examsPending    = exam.pending;
        cap.upcomingExamSops = exam.pendingSops.slice(0, 5);
      }
      // completionPct = trained / scheduled (tick+done)
      cap.completionPct = cap.totalScheduled > 0
        ? Math.round((cap.completed / cap.totalScheduled) * 100)
        : 0;
      cap.missingTraining = cap.pending;
    }

    let capsuleList = [...empMonthMap.values()];

    // Apply status filter
    if (statusF === 'pending')   capsuleList = capsuleList.filter(c => c.pending > 0);
    if (statusF === 'completed') capsuleList = capsuleList.filter(c => c.completed > 0);
    if (examF === 'true')        capsuleList = capsuleList.filter(c => c.examsPending > 0);

    // Sort: month asc, then employee name
    capsuleList.sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      if (a.month !== b.month) return a.month - b.month;
      return a.employeeName.localeCompare(b.employeeName);
    });

    // Filter options
    const departments = await InductionTrainingMatrixRecord.distinct('department');
    const years = (await InductionTrainingMatrixRecord.distinct('year')).sort();
    const monthsRaw = await InductionTrainingMatrixRecord.aggregate([
      { $group: { _id: { month: '$month', monthName: '$monthName', year: '$year' } } },
      { $sort: { '_id.year': 1, '_id.month': 1 } },
    ]);
    const months = monthsRaw.map(m => ({ month: m._id.month, monthName: m._id.monthName, year: m._id.year }));
    const employees = (await InductionTrainingMatrixRecord.distinct('employeeName', deptF !== 'all' ? { department: deptF } : {}))
      .filter((name: string) =>
        deptF !== 'all'
          ? !isLeftEmployee(leftKeys, deptF, name)
          : !isLeftEmployeeName(leftKeys, name),
      );

    return NextResponse.json({
      success: true,
      view: 'employee',
      capsules: capsuleList,
      filters: { departments, years, months, employees: employees.sort() },
    });

  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
