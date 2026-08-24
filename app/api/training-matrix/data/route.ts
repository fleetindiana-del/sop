import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import TrainingMatrixRecord from '@/models/TrainingMatrixRecord';
import TrainingMatrixUpload from '@/models/TrainingMatrixUpload';
import SOP from '@/models/SOP';
import { getLeftEmployeeKeys, isLeftEmployee } from '@/lib/leftEmployees';
import {
  getEmployeeMasterIndex,
  currentDesignation,
  identityKeysForDesignation,
  employeeMasterKey,
} from '@/lib/employeeMaster';
import { canonTrainingMatrixDepartment } from '@/lib/trainingMatrixDepartments';

const STATUS_PRIORITY: Record<string, number> = {
  completed: 4,
  pending: 3,
  not_required: 2,
  na: 1,
};

export async function GET(request: NextRequest) {
  try {
    await connectDB();
    const sp = request.nextUrl.searchParams;

    const dept      = sp.get('department') || 'all';
    const monthP    = sp.get('month')      || 'all';
    const yearP     = sp.get('year')       || 'all';
    const search    = (sp.get('search')    || '').toLowerCase();
    const sopSearch = (sp.get('sop')       || '').toLowerCase();
    const desigF    = sp.get('designation')|| 'all';
    const statusF   = sp.get('status')     || 'all';
    const includeObsolete = sp.get('includeObsolete') === '1';

    const match: Record<string, any> = {};
    if (dept    !== 'all') match.department   = dept;
    if (monthP  !== 'all') match.month        = parseInt(monthP);
    if (yearP   !== 'all') match.year         = parseInt(yearP);
    // NOTE: designation is deliberately NOT matched against TrainingMatrixRecord.
    // Records store the designation held when each row was recorded, so matching
    // there hid anyone who has since been re-designated (and surfaced them under
    // their old title). The filter is applied below against Employee Master.
    if (search)            match.employeeName = { $regex: search, $options: 'i' };
    if (sopSearch)         match.sopCode      = { $regex: sopSearch, $options: 'i' };
    // Don't filter by status here — we need all statuses to build the employee map correctly

    const stripVersion = (code: string) =>
      String(code || '').toUpperCase().replace(/-\d+$/, '').trim();
    const obsoleteBaseSet = new Set<string>();
    if (!includeObsolete) {
      const obs = await SOP.find({ isObsolete: true }, { identifier: 1 }).lean() as any[];
      for (const r of obs) {
        const base = stripVersion(String(r?.identifier || ''));
        if (base) obsoleteBaseSet.add(base);
      }
    }

    const [recordsRaw, leftKeys, masterIndex] = await Promise.all([
      TrainingMatrixRecord.find(match)
        .sort({ department: 1, employeeName: 1, sopCode: 1 })
        .lean(),
      getLeftEmployeeKeys(),
      getEmployeeMasterIndex(),
    ]);
    const records = (includeObsolete
      ? recordsRaw
      : (recordsRaw as any[]).filter((r: any) => !obsoleteBaseSet.has(stripVersion(String(r?.sopCode || ''))))
    ).filter((r: any) => !isLeftEmployee(leftKeys, r.department, r.employeeName));

    // Build employee map with SOP matrix
    // Key: department||employeeName
    // For each SOP, keep the highest-priority status across all months
    const empMap: Record<string, {
      employeeName: string;
      designation: string;
      department: string;
      trainings: Record<string, { status: string; raw: string; priority: number }>;
    }> = {};

    const sopSet = new Set<string>();

    for (const r of records) {
      // Skip na records — they contribute nothing to counts
      if (r.status === 'na') continue;

      const key = `${r.department}||${r.employeeName}`;
      if (!empMap[key]) {
        empMap[key] = {
          employeeName: r.employeeName,
          // Employee Master wins; the record's stored designation is only a
          // fallback for roster rows that were never mirrored into Employee.
          designation: currentDesignation(masterIndex, r.department, r.employeeName, r.designation),
          department: r.department,
          trainings: {},
        };
      }

      const priority = STATUS_PRIORITY[r.status] ?? 0;
      const existing = empMap[key].trainings[r.sopCode];

      // Only update if this status has higher priority than existing
      if (!existing || priority > existing.priority) {
        empMap[key].trainings[r.sopCode] = { status: r.status, raw: r.rawSymbol, priority };
      }

      sopSet.add(r.sopCode);
    }

    const employees = Object.values(empMap).map(emp => {
      const trainingValues = Object.values(emp.trainings);
      const completed    = trainingValues.filter(t => t.status === 'completed').length;
      const not_required = trainingValues.filter(t => t.status === 'not_required').length;
      const pending      = trainingValues.filter(t => t.status === 'pending').length;
      const required     = completed + pending;
      const totalSOPs    = required + not_required; // Total = Required + Not Required (no NA)
      const pct          = required > 0 ? Math.round((completed / required) * 100) : 0;

      // Strip out the priority field before returning
      const trainings: Record<string, { status: string; raw: string }> = {};
      for (const [sop, t] of Object.entries(emp.trainings)) {
        trainings[sop] = { status: t.status, raw: t.raw };
      }

      return { ...emp, trainings, completed, not_required, na: 0, pending, required, totalSOPs, completionPct: pct };
    });

    // Apply the designation filter against the employee's CURRENT designation,
    // resolved through Employee Master rather than the historical record value.
    const designationFiltered = desigF !== 'all'
      ? (() => {
          const { keys } = identityKeysForDesignation(
            masterIndex,
            desigF,
            dept !== 'all' ? dept : null,
          );
          const wanted = desigF.trim().toLowerCase();
          return employees.filter((e) =>
            keys.has(employeeMasterKey(e.department, e.employeeName)) ||
            keys.has(`${e.department}||${e.employeeName}`.trim().toLowerCase()) ||
            // Excel-only roster rows have no Employee Master record; fall back to
            // the designation carried on the row itself so they stay filterable.
            (!masterIndex.byIdentity.has(employeeMasterKey(e.department, e.employeeName)) &&
              e.designation.trim().toLowerCase() === wanted),
          );
        })()
      : employees;

    // Apply status filter after building (filter employees by status presence)
    const filteredEmployees = statusF !== 'all'
      ? designationFiltered.filter(e => Object.values(e.trainings).some(t => t.status === statusF))
      : designationFiltered;

    const sopCodes = [...sopSet].sort();

    // Filter options
    const departments   = await TrainingMatrixRecord.distinct('department');
    const years         = (await TrainingMatrixRecord.distinct('year')).sort();
    // Designation options come from Employee Master, not from the historical
    // records — otherwise the dropdown lists titles nobody holds any more and
    // omits ones just assigned.
    const designations = dept !== 'all'
      ? (masterIndex.designationsByDepartment.get(
          canonTrainingMatrixDepartment(dept) || dept,
        ) || [])
      : masterIndex.designations;
    const monthsRaw     = await TrainingMatrixRecord.aggregate([
      { $group: { _id: { month: '$month', monthName: '$monthName' } } },
      { $sort: { '_id.month': 1 } },
    ]);
    const months = monthsRaw.map(m => ({ month: m._id.month, monthName: m._id.monthName }));

    // Upload history
    const uploads = await TrainingMatrixUpload.find(dept !== 'all' ? { department: dept } : {})
      .sort({ uploadedAt: -1 }).limit(20).lean();

    return NextResponse.json({
      success: true,
      employees: filteredEmployees,
      sopCodes,
      filters: { departments, years, months, designations },
      uploads,
      total: records.length,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
