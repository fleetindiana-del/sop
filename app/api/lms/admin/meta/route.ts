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
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { sopFamilyCodesMatch } from '@/lib/sopIdentifierNormalize';
import { baseIdentifierFromIdentifier } from '@/lib/sop-utils';
import { getDashboardDepartments, isDashboardDepartmentName } from '@/lib/dashboardDepartments';
import Employee from '@/models/Employee';

export const dynamic = 'force-dynamic';

function empKey(department: string, name: string): string {
  return `${department}||${name}`.trim().toLowerCase();
}

function normalizeSopCode(raw: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  return (baseIdentifierFromIdentifier(trimmed) || trimmed).toUpperCase();
}

// GET /api/lms/admin/meta
// Optional ?sopCode= — when set, returns only employees assigned to that SOP family.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const sopCode = normalizeSopCode(req.nextUrl.searchParams.get('sopCode') || '');

  try {
    const body = await getOrBuildLmsCache(
      sopCode ? lmsServerKeys.adminMetaForSop(sopCode) : lmsServerKeys.adminMeta(),
      lmsServerTtl.adminMeta,
      async () => {
        await connectDB();

        const employees = await Employee.find({ isActive: true })
          .select('_id name department designation isTrainer')
          .sort({ name: 1 })
          .lean<{
            _id: unknown;
            name: string;
            department: string;
            designation: string;
            isTrainer?: boolean;
          }[]>();

        let filtered = employees;

        if (sopCode) {
          const assignmentsMap = await getEmployeeAssignmentsMap();
          filtered = employees.filter((e) => {
            const assignments = assignmentsMap.get(empKey(e.department, e.name)) ?? [];
            return assignments.some((a) => sopFamilyCodesMatch(a.sopCode, sopCode));
          });
        }

        const dashboardDepartments = await getDashboardDepartments();
        const dashboardDeptSet = new Set(dashboardDepartments.map((d) => d.toLowerCase()));

        // Keep employee rows, but department dropdowns only list dashboard depts.
        const designations = [...new Set(filtered.map((e) => e.designation).filter(Boolean))].sort();

        return {
          sopCode: sopCode || undefined,
          departments: dashboardDepartments,
          designations,
          employees: filtered
            .filter((e) => {
              const dept = String(e.department || '').trim();
              // When listing for a SOP, keep all assigned employees even if their
              // HR dept string differs; for the global meta list, prefer dashboard depts.
              if (sopCode) return true;
              return isDashboardDepartmentName(dept) && dashboardDeptSet.has(dept.toLowerCase());
            })
            .map((e) => ({
              id: String(e._id),
              name: e.name,
              department: e.department,
              designation: e.designation,
              isTrainer: e.isTrainer === true,
            })),
        };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(sopCode ? 60 : 300) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
