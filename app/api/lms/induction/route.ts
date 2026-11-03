import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { getEmployeeAssignmentsMap, employeeAssignmentMapKey } from '@/lib/employeeAssignments';
import { filterIgnoredAssignments, listTrainingIgnores } from '@/lib/lmsTrainingIgnore';
import { resolveExamRecordSubject } from '@/lib/lmsExamReview';
import { ensureInductionCertificate, loadInductionSummaries } from '@/lib/lmsInduction';
import Employee from '@/models/Employee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/lms/induction?employeeId= — induction training record (every
// induction SOP with attempts, completion date and score) plus the consolidated
// induction certificate, issued here once all induction SOPs are completed.
// Without employeeId: the signed-in learner. With it: admins, or trainers for
// employees in their departments.
export async function GET(req: NextRequest) {
  const subject = await resolveExamRecordSubject(req.nextUrl.searchParams.get('employeeId') || '');
  if (!subject.ok) return NextResponse.json({ error: subject.error }, { status: subject.status });

  try {
    await connectDB();
    const employee = await Employee.findById(subject.employeeId)
      .select('name employeeId designation department dateOfJoining inductionTrainingRequired')
      .lean<{
        _id: unknown;
        name: string;
        employeeId?: string;
        designation?: string;
        department?: string;
        dateOfJoining?: Date;
        inductionTrainingRequired?: boolean;
      }>();
    if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

    const department = employee.department || '';
    const assignmentsMap = await getEmployeeAssignmentsMap({ departments: [department].filter(Boolean) });
    const assignments = filterIgnoredAssignments(
      assignmentsMap.get(employeeAssignmentMapKey(department, employee.name)) || [],
      await listTrainingIgnores(department),
      department,
    );
    const id = String(employee._id);
    const summary = (await loadInductionSummaries([{ id, assignments }])).get(id)!;
    const certificate = await ensureInductionCertificate(employee, summary);

    return NextResponse.json({
      employee: {
        id,
        name: employee.name,
        employeeCode: employee.employeeId || '',
        designation: employee.designation || '',
        department,
        dateOfJoining: employee.dateOfJoining ? new Date(employee.dateOfJoining).toISOString().slice(0, 10) : undefined,
        inductionTrainingRequired: employee.inductionTrainingRequired === true,
      },
      isSelf: subject.isSelf,
      summary,
      certificate,
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
