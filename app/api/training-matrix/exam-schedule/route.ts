import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireAuth } from '@/lib/withAuth';
import TrainingExamSchedule from '@/models/TrainingExamSchedule';
import Employee from '@/models/Employee';
import { invalidateEmployeeAssignmentsCache } from '@/lib/employeeAssignments';
import {
  loadMonthRequirements,
  deptScheduleKey,
  employeeOverrideKey,
  parseDateOnly,
  monthOfDate,
  yearOfDate,
  serializeSchedule,
  stripVersion,
  normalizeDept,
  toDateOnlyIso,
  MONTH_NAMES,
} from '@/lib/trainingExamSchedule';

export const dynamic = 'force-dynamic';

// GET /api/training-matrix/exam-schedule?year=2026&month=1&view=dept|employee&employee=Name&department=QA
export async function GET(req: NextRequest) {
  try {
    const auth = await requireAuth(['admin', 'trainer', 'viewer']);
    if (auth.error) return auth.error;

    await connectDB();
    const { searchParams } = req.nextUrl;
    const year = Number(searchParams.get('year')) || new Date().getFullYear();
    const monthParam = searchParams.get('month');
    const month = monthParam ? Number(monthParam) : undefined;
    const view = searchParams.get('view') === 'employee' ? 'employee' : 'dept';
    const employeeFilter = String(searchParams.get('employee') || '').trim();
    const departmentFilter = normalizeDept(searchParams.get('department') || '');

    const requirements = await loadMonthRequirements(year, month);

    const scheduleFilter: Record<string, unknown> = {
      year,
      status: { $ne: 'cancelled' },
    };
    if (month) scheduleFilter.plannedMonth = month;

    const schedules = await TrainingExamSchedule.find(scheduleFilter).lean();

    const deptSchedules = schedules.filter((s) => s.scope === 'department');
    const empOverrides = schedules.filter((s) => s.scope === 'employee');

    const assignedDeptKeys = new Set(
      deptSchedules.map((s) =>
        deptScheduleKey(s.sopCode, s.department, s.year, s.plannedMonth),
      ),
    );

    const unassigned = requirements.filter((r) => {
      const key = deptScheduleKey(r.sopCode, r.department, r.year, r.plannedMonth);
      return !assignedDeptKeys.has(key);
    });

    let events: Array<{
      id: string;
      sopCode: string;
      sopName: string;
      department: string;
      year: number;
      plannedMonth: number;
      examDate: string;
      scope: string;
      employeeName?: string;
      employeeId?: string;
      status: string;
      color: string;
      title: string;
      inherited: boolean;
      isOverride: boolean;
      departmentScheduleId?: string;
    }> = deptSchedules.map((s) => {
      const ser = serializeSchedule(s);
      return {
        ...ser,
        title: `${ser.sopCode} — ${ser.department}`,
        inherited: false,
        isOverride: false,
      };
    });

    const employees = await Employee.find({ isActive: true })
      .select('name designation department employeeId')
      .sort({ department: 1, name: 1 })
      .lean();

    const employeeList = employees
      .map((e) => ({
        name: e.name,
        designation: e.designation,
        department: normalizeDept(e.department),
        employeeId: e.employeeId || undefined,
      }))
      .filter((e) => e.department);

    if (view === 'employee') {
      const targetEmployees = employeeList.filter((e) => {
        if (employeeFilter && e.name.toLowerCase() !== employeeFilter.toLowerCase()) {
          return false;
        }
        if (departmentFilter && e.department !== departmentFilter) return false;
        return true;
      });

      const overrideByKey = new Map(
        empOverrides.map((o) => [
          employeeOverrideKey(
            o.sopCode,
            o.department,
            o.year,
            o.plannedMonth,
            String(o.employeeName || ''),
          ),
          o,
        ]),
      );

      const empEvents: typeof events = [];
      for (const emp of targetEmployees) {
        for (const dept of deptSchedules) {
          if (normalizeDept(dept.department) !== emp.department) continue;
          if (month && dept.plannedMonth !== month) continue;

          const oKey = employeeOverrideKey(
            dept.sopCode,
            dept.department,
            dept.year,
            dept.plannedMonth,
            emp.name,
          );
          const override = overrideByKey.get(oKey);
          if (override) {
            const ser = serializeSchedule(override);
            empEvents.push({
              ...ser,
              title: `${ser.sopCode} — ${emp.name}`,
              inherited: false,
              isOverride: true,
              employeeName: emp.name,
            });
          } else {
            const ser = serializeSchedule(dept);
            empEvents.push({
              ...ser,
              // Synthetic id for inherited events (not a real override row)
              id: `inherited:${ser.id}:${emp.name}`,
              title: `${ser.sopCode} — ${emp.name}`,
              inherited: true,
              isOverride: false,
              employeeName: emp.name,
              departmentScheduleId: ser.id,
            });
          }
        }

        // Orphan overrides (no matching dept schedule) — still show
        for (const o of empOverrides) {
          if (String(o.employeeName || '').toLowerCase() !== emp.name.toLowerCase()) continue;
          if (normalizeDept(o.department) !== emp.department) continue;
          const oKey = employeeOverrideKey(
            o.sopCode,
            o.department,
            o.year,
            o.plannedMonth,
            emp.name,
          );
          // Already added via matching dept above
          const already = empEvents.some(
            (ev) => ev.isOverride && ev.id === String(o._id),
          );
          if (already) continue;
          // Check if we already have via override map path
          if (
            empEvents.some(
              (ev) =>
                ev.isOverride &&
                stripVersion(ev.sopCode) === stripVersion(o.sopCode) &&
                ev.employeeName === emp.name &&
                ev.plannedMonth === o.plannedMonth,
            )
          ) {
            continue;
          }
          void oKey;
          const ser = serializeSchedule(o);
          empEvents.push({
            ...ser,
            title: `${ser.sopCode} — ${emp.name}`,
            inherited: false,
            isOverride: true,
            employeeName: emp.name,
          });
        }
      }
      events = empEvents;
    }

    const monthLabel = month ? MONTH_NAMES[month] || String(month) : 'all months';

    return NextResponse.json({
      year,
      month: month || null,
      view,
      monthLabel,
      events,
      unassigned: unassigned.map((u) => ({
        ...u,
        color: undefined,
        key: deptScheduleKey(u.sopCode, u.department, u.year, u.plannedMonth),
      })),
      unassignedCount: unassigned.length,
      employees: employeeList,
      banner:
        unassigned.length > 0
          ? `${unassigned.length} training${unassigned.length === 1 ? '' : 's'} still need dates${
              month ? ` in ${MONTH_NAMES[month]}` : ''
            }`
          : null,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// POST /api/training-matrix/exam-schedule — create/upsert department or employee assignment
export async function POST(req: NextRequest) {
  try {
    const auth = await requireAuth(['admin']);
    if (auth.error) return auth.error;

    await connectDB();
    const body = await req.json();
    const sopCode = stripVersion(body.sopCode);
    const department = normalizeDept(body.department);
    const plannedMonth = Number(body.plannedMonth);
    const year = Number(body.year) || new Date().getFullYear();
    const scope = body.scope === 'employee' ? 'employee' : 'department';
    const employeeName = String(body.employeeName || '').trim();
    const employeeId = body.employeeId ? String(body.employeeId).trim() : undefined;
    const sopName = body.sopName ? String(body.sopName).trim() : undefined;
    const createdBy =
      body.createdBy ||
      auth.session?.user?.username ||
      auth.session?.user?.name ||
      'manage-sop-calendar';

    const examDate = parseDateOnly(String(body.examDate || ''));
    if (!sopCode || !department || !plannedMonth || !examDate) {
      return NextResponse.json(
        { error: 'sopCode, department, plannedMonth, and examDate (YYYY-MM-DD) are required' },
        { status: 400 },
      );
    }
    if (plannedMonth < 1 || plannedMonth > 12) {
      return NextResponse.json({ error: 'plannedMonth must be 1–12' }, { status: 400 });
    }
    if (scope === 'employee' && !employeeName) {
      return NextResponse.json(
        { error: 'employeeName is required for employee scope' },
        { status: 400 },
      );
    }

    const allowOutsideMonth = body.allowOutsideMonth === true;
    const dateMonth = monthOfDate(examDate);
    const dateYear = yearOfDate(examDate);
    if (!allowOutsideMonth && (dateMonth !== plannedMonth || dateYear !== year)) {
      return NextResponse.json(
        {
          error: `Exam date must fall within planned month ${MONTH_NAMES[plannedMonth]} ${year} (got ${toDateOnlyIso(examDate)})`,
          warning: true,
        },
        { status: 400 },
      );
    }

    const filter: Record<string, unknown> = {
      sopCode,
      department,
      year,
      plannedMonth,
      scope,
      status: { $ne: 'cancelled' },
    };
    if (scope === 'employee') {
      filter.employeeName = new RegExp(
        `^${employeeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        'i',
      );
    }

    const update = {
      sopCode,
      sopName,
      department,
      year,
      plannedMonth,
      examDate,
      scope,
      employeeName: scope === 'employee' ? employeeName : undefined,
      employeeId: scope === 'employee' ? employeeId : undefined,
      status: 'scheduled' as const,
      updatedBy: createdBy,
    };

    let doc = await TrainingExamSchedule.findOne(filter);
    if (doc) {
      Object.assign(doc, update);
      await doc.save();
    } else {
      doc = await TrainingExamSchedule.create({ ...update, createdBy });
    }

    invalidateEmployeeAssignmentsCache();

    return NextResponse.json({ schedule: serializeSchedule(doc.toObject()) }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('duplicate key') || msg.includes('E11000')) {
      return NextResponse.json({ error: 'Schedule already exists for this key' }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
