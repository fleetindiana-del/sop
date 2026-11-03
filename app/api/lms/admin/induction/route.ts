import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { requireLmsManager } from '@/lib/lmsTrainerAuth';
import { canViewEmployees } from '@/lib/lmsExamReview';
import { isAdmin } from '@/lib/roles';
import {
  getEmployeeAssignmentsMap,
  employeeAssignmentMapKey,
  type EmployeeSopAssignment,
} from '@/lib/employeeAssignments';
import { filterIgnoredAssignments, listTrainingIgnores } from '@/lib/lmsTrainingIgnore';
import {
  ensureInductionCertificate,
  findInductionCertificates,
  loadInductionSummaries,
  type InductionCertificateView,
  type InductionSummary,
} from '@/lib/lmsInduction';
import Employee from '@/models/Employee';
import InductionCertificate from '@/models/lms/InductionCertificate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type EmployeeLean = {
  _id: unknown;
  name: string;
  employeeId?: string;
  designation?: string;
  department?: string;
  dateOfJoining?: Date;
  inductionTrainingRequired?: boolean;
  isActive?: boolean;
};

export interface AdminInductionRow extends InductionSummary {
  id: string;
  name: string;
  employeeCode: string;
  designation: string;
  department: string;
  dateOfJoining?: string;
  isActive: boolean;
  certificate: InductionCertificateView | null;
}

// GET /api/lms/admin/induction — every employee assigned induction training
// (flagged) or holding an induction certificate, with per-SOP attempts,
// completion dates and the consolidated certificate. Admins see everyone;
// trainers see their departments.
export async function GET() {
  const auth = await requireLmsManager();
  if (!auth.ok) return auth.response;

  try {
    await connectDB();
    const certifiedIds = await InductionCertificate.distinct('employeeId');
    let employees = await Employee.find({
      isDeleted: { $ne: true },
      $or: [
        { inductionTrainingRequired: true, isActive: { $ne: false } },
        { _id: { $in: certifiedIds } },
      ],
    })
      .select('name employeeId designation department dateOfJoining inductionTrainingRequired isActive')
      .lean<EmployeeLean[]>();

    const session = await getServerSession(authOptions);
    if (!(session?.user?.role && isAdmin(session.user.role))) {
      const access = await canViewEmployees(employees.map((e) => String(e._id)));
      if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
      employees = employees.filter((e) => access.ids.has(String(e._id)));
    }

    const departments = [...new Set(employees.map((e) => String(e.department || '').trim()).filter(Boolean))];
    const [assignmentsMap, ignoreLists] = await Promise.all([
      departments.length ? getEmployeeAssignmentsMap({ departments }) : Promise.resolve(new Map<string, EmployeeSopAssignment[]>()),
      Promise.all(departments.map(async (d) => [d, await listTrainingIgnores(d)] as const)),
    ]);
    const ignoresByDept = new Map(ignoreLists);

    const withAssignments = employees.map((e) => {
      const dept = String(e.department || '').trim();
      const id = String(e._id);
      const raw = e.inductionTrainingRequired === true
        ? assignmentsMap.get(employeeAssignmentMapKey(dept, e.name)) || []
        : [];
      return { e, id, assignments: filterIgnoredAssignments(raw, ignoresByDept.get(dept) || [], dept) };
    });
    const [summaries, certificates] = await Promise.all([
      loadInductionSummaries(withAssignments.map(({ id, assignments }) => ({ id, assignments }))),
      findInductionCertificates(withAssignments.map(({ id }) => id)),
    ]);

    const rows: AdminInductionRow[] = [];
    for (const { e, id } of withAssignments) {
      let summary = summaries.get(id)!;
      let certificate = certificates.get(id) || null;
      if (!certificate && summary.status === 'completed') {
        certificate = await ensureInductionCertificate(e, summary);
      }
      // The certificate is the record of completed induction, even once the
      // employee is no longer flagged for it.
      if (certificate && summary.status !== 'completed' && summary.total === 0) {
        summary = {
          status: 'completed',
          total: certificate.sops.length,
          completedCount: certificate.sops.length,
          completedAt: certificate.completedAt,
          sops: certificate.sops,
        };
      }
      rows.push({
        ...summary,
        id,
        name: e.name,
        employeeCode: e.employeeId || '',
        designation: e.designation || '',
        department: String(e.department || ''),
        dateOfJoining: e.dateOfJoining ? new Date(e.dateOfJoining).toISOString().slice(0, 10) : undefined,
        isActive: e.isActive !== false,
        certificate,
      });
    }
    rows.sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name));

    return NextResponse.json({ employees: rows });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
