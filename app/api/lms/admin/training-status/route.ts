import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import {
  getOrBuildLmsCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import Employee from '@/models/Employee';
import LearningProgress from '@/models/lms/LearningProgress';
import Certificate from '@/models/lms/Certificate';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';

export const dynamic = 'force-dynamic';

function empKey(department: string, name: string): string {
  return `${department}||${name}`.trim().toLowerCase();
}

// GET /api/lms/admin/training-status?department=QA
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { searchParams } = req.nextUrl;
  const department = searchParams.get('department');

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.adminTrainingStatus(department || 'all'),
      lmsServerTtl.adminTrainingStatus,
      async () => {
        await connectDB();

        const empFilter: Record<string, unknown> = { isActive: { $ne: false } };
        if (department) empFilter.department = { $regex: new RegExp(`^${department}$`, 'i') };

        const employees = await Employee.find(empFilter)
          .select('_id name designation department isActive')
          .sort({ name: 1 })
          .lean<{ _id: unknown; name: string; designation: string; department: string; isActive: boolean }[]>();

        const employeeIds = employees.map((e) => e._id);

        const assignmentsMap = await getEmployeeAssignmentsMap();

        const [progressList, certList] = await Promise.all([
          LearningProgress.find({ employeeId: { $in: employeeIds } })
            .select('employeeId sopCode status')
            .lean(),
          Certificate.find({ employeeId: { $in: employeeIds } })
            .select('employeeId sopCode')
            .lean(),
        ]);

        const progressByEmp = new Map<string, Set<string>>();
        const startedByEmp  = new Map<string, number>();
        for (const p of progressList) {
          const id  = String((p as { employeeId: unknown }).employeeId);
          const sop = String((p as { sopCode: string }).sopCode);
          const st  = String((p as { status: string }).status);
          if (!progressByEmp.has(id)) progressByEmp.set(id, new Set());
          if (st === 'completed') progressByEmp.get(id)!.add(sop.toUpperCase());
          startedByEmp.set(id, (startedByEmp.get(id) ?? 0) + 1);
        }

        const certsByEmp = new Map<string, number>();
        for (const c of certList) {
          const id = String((c as { employeeId: unknown }).employeeId);
          certsByEmp.set(id, (certsByEmp.get(id) ?? 0) + 1);
        }

        const records = employees.map((emp) => {
          const id          = String(emp._id);
          const key         = empKey(emp.department, emp.name);
          const assignments = assignmentsMap.get(key) ?? [];
          const completedSet = progressByEmp.get(id) ?? new Set<string>();

          const totalSops     = assignments.length;
          const completedSops = assignments.filter(
            (a) => completedSet.has(a.sopCode.toUpperCase()),
          ).length;
          const certCount = certsByEmp.get(id) ?? 0;
          const inProgress = startedByEmp.get(id) ?? 0;

          const effectiveTotal     = totalSops > 0 ? totalSops : inProgress;
          const effectiveCompleted = totalSops > 0 ? completedSops : (progressByEmp.get(id)?.size ?? 0);

          const overallPct = effectiveTotal > 0
            ? Math.round((effectiveCompleted / effectiveTotal) * 100)
            : 0;

          let status: 'completed' | 'in_progress' | 'not_started' = 'not_started';
          if (effectiveTotal > 0 && effectiveCompleted === effectiveTotal) status = 'completed';
          else if (inProgress > 0) status = 'in_progress';

          return {
            employeeId:       id,
            employeeName:     emp.name,
            designation:      emp.designation,
            department:       emp.department,
            isActive:         emp.isActive,
            totalSops:        effectiveTotal,
            completedSops:    effectiveCompleted,
            certCount,
            overallPct,
            status,
          };
        });

        return { records };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(120) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
