import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { connectDB } from '@/lib/mongodb';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { generateUniqueLmsUsername } from '@/lib/lms-credentials';
import { syncEmployeesFromMatrixThrottled } from '@/lib/syncEmployeesFromMatrix';
import {
  parseDateOfJoining,
  resolveInductionTrainingRequired,
  formatDateOfJoiningInput,
} from '@/lib/employeeInduction';
import { parseTrainerDepartments } from '@/lib/employeeTrainer';
import { invalidateEmployeeDerivedCaches } from '@/lib/employeeCacheInvalidation';
import Employee from '@/models/Employee';

export const dynamic = 'force-dynamic';

// GET /api/employees?department=QA&search=John&includeInactive=1
export async function GET(req: NextRequest) {
  try {
    await connectDB();

    const { searchParams } = new URL(req.url);
    const department      = searchParams.get('department');
    const search          = searchParams.get('search') || '';
    const includeInactive = searchParams.get('includeInactive') === '1';
    const includeAssignments = searchParams.get('includeAssignments') === '1';
    const deletedOnly = searchParams.get('deletedOnly') === '1';
    // The first (fast) page load passes skipSync=1 so the roster renders
    // immediately; the follow-up assignments request keeps the roster mirrored
    // to the training matrix. The sync is also throttled so it never re-runs the
    // heavy scan on back-to-back reads.
    const skipSync = searchParams.get('skipSync') === '1';

    if (!skipSync) {
      await syncEmployeesFromMatrixThrottled();
    }

    const filter: Record<string, unknown> = {};
    if (department)       filter.department = { $regex: new RegExp(`^${department}$`, 'i') };
    if (deletedOnly) {
      filter.isDeleted = true;
    } else {
      filter.isDeleted = { $ne: true };
      if (!includeInactive) filter.isActive = true;
    }
    if (search)           filter.$or = [
      { name:        { $regex: search, $options: 'i' } },
      { designation: { $regex: search, $options: 'i' } },
      { employeeId:  { $regex: search, $options: 'i' } },
    ];

    const employees = await Employee.find(filter)
      .select('+lmsPasswordHash')
      .sort({ name: 1 })
      .lean();

    // Replace the raw hash with a boolean so the client knows whether a
    // learning-module password is set without the hash ever leaving the server.
    const safe = employees.map((emp) => {
      const { lmsPasswordHash, ...rest } = emp as typeof emp & { lmsPasswordHash?: string };
      const dateOfJoining = rest.dateOfJoining
        ? formatDateOfJoiningInput(rest.dateOfJoining as Date)
        : undefined;
      return {
        ...rest,
        dateOfJoining,
        hasLmsPassword: !!lmsPasswordHash,
      };
    });

    if (!includeAssignments) {
      return NextResponse.json({ employees: safe });
    }

    const assignmentsMap = await getEmployeeAssignmentsMap();
    const enriched = safe.map((emp) => {
      const key = `${emp.department}||${emp.name}`.trim().toLowerCase();
      return {
        ...emp,
        assignments: assignmentsMap.get(key) || [],
      };
    });

    return NextResponse.json({ employees: enriched });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// POST /api/employees — create a new employee
export async function POST(req: NextRequest) {
  try {
    await connectDB();
    const body = await req.json();
    const { name, designation, department, employeeId, password, dateOfJoining, inductionTrainingRequired, isTrainer, trainerDepartments } = body;

    if (!name?.trim() || !designation?.trim() || !department?.trim()) {
      return NextResponse.json({ error: 'name, designation, and department are required' }, { status: 400 });
    }

    const doj = parseDateOfJoining(dateOfJoining);
    const inductionRequired = resolveInductionTrainingRequired(doj, inductionTrainingRequired === true);
    const trainer = isTrainer === true;
    const trainerDepts = trainer
      ? parseTrainerDepartments(trainerDepartments, department.trim())
      : [];
    if (trainer && trainerDepts.length === 0) {
      return NextResponse.json(
        { error: 'Select at least one department for a trainer' },
        { status: 400 },
      );
    }

    let lmsPasswordHash: string | undefined;
    if (typeof password === 'string' && password.length > 0) {
      if (password.length < 4) {
        return NextResponse.json({ error: 'Password must be at least 4 characters' }, { status: 400 });
      }
      lmsPasswordHash = await bcrypt.hash(password, 12);
    }

    const lmsUsername = await generateUniqueLmsUsername(name);
    const created = await Employee.create({
      name: name.trim(),
      designation: designation.trim(),
      department: department.trim(),
      employeeId: employeeId?.trim() || undefined,
      dateOfJoining: doj,
      inductionTrainingRequired: inductionRequired,
      isTrainer: trainer,
      trainerDepartments: trainerDepts,
      lmsUsername,
      lmsPasswordHash,
    });

    const employee = created.toObject();
    delete employee.lmsPasswordHash;
    invalidateEmployeeDerivedCaches();
    return NextResponse.json({
      employee: {
        ...employee,
        trainerDepartments: Array.isArray(employee.trainerDepartments)
          ? employee.trainerDepartments
          : [],
        dateOfJoining: doj ? formatDateOfJoiningInput(doj) : undefined,
        hasLmsPassword: !!lmsPasswordHash,
      },
    }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('duplicate key') || msg.includes('E11000')) {
      return NextResponse.json({ error: 'An employee with this name already exists in this department' }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
