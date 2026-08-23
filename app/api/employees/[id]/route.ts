import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { connectDB } from '@/lib/mongodb';
import { generateUniqueLmsUsername } from '@/lib/lms-credentials';
import {
  parseDateOfJoining,
  resolveInductionTrainingRequired,
  formatDateOfJoiningInput,
} from '@/lib/employeeInduction';
import { invalidateEmployeeAssignmentsCache } from '@/lib/employeeAssignments';
import { parseTrainerDepartments } from '@/lib/employeeTrainer';
import { bustTrainerScheduleCaches } from '@/lib/lmsTrainerCache';
import { invalidateManageSopViewCache } from '@/lib/manageSopViewCache';
import Employee from '@/models/Employee';

export const dynamic = 'force-dynamic';

// PATCH /api/employees/[id] — update profile fields and/or the learning-module password.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await connectDB();
    const { id } = await params;
    const body = await req.json();
    const allowed = ['name', 'designation', 'department', 'employeeId', 'isActive', 'isTrainer'];
    const update: Record<string, unknown> = {};
    for (const k of allowed) {
      if (body[k] !== undefined) {
        if (k === 'isTrainer' || k === 'isActive') {
          update[k] = body[k] === true;
        } else {
          update[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
        }
      }
    }

    if (body.dateOfJoining !== undefined) {
      update.dateOfJoining = parseDateOfJoining(body.dateOfJoining) ?? null;
    }

    const existing = await Employee.findById(id).select('+lmsPasswordHash');
    if (!existing) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });

    const nextDoj = body.dateOfJoining !== undefined
      ? (parseDateOfJoining(body.dateOfJoining) ?? undefined)
      : existing.dateOfJoining;

    if (body.inductionTrainingRequired !== undefined || body.dateOfJoining !== undefined) {
      const manual = body.inductionTrainingRequired !== undefined
        ? body.inductionTrainingRequired === true
        : existing.inductionTrainingRequired;
      update.inductionTrainingRequired = resolveInductionTrainingRequired(nextDoj, manual);
    }

    const nextIsTrainer = body.isTrainer !== undefined
      ? body.isTrainer === true
      : !!existing.isTrainer;
    const nextHomeDept = typeof update.department === 'string'
      ? update.department
      : existing.department;

    if (body.trainerDepartments !== undefined || body.isTrainer !== undefined || body.department !== undefined) {
      if (nextIsTrainer) {
        const trainerDepts = parseTrainerDepartments(
          body.trainerDepartments !== undefined
            ? body.trainerDepartments
            : existing.trainerDepartments,
          nextHomeDept,
        );
        if (trainerDepts.length === 0) {
          return NextResponse.json(
            { error: 'Select at least one department for a trainer' },
            { status: 400 },
          );
        }
        update.isTrainer = true;
        update.trainerDepartments = trainerDepts;
      } else {
        update.isTrainer = false;
        update.trainerDepartments = [];
      }
    }

    // Optional learning-module password set/reset.
    if (typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length < 4) {
        return NextResponse.json({ error: 'Password must be at least 4 characters' }, { status: 400 });
      }
      update.lmsPasswordHash = await bcrypt.hash(body.password, 12);
    }

    // Ensure every employee has a login handle (covers records created before
    // credentials existed, and any whose name changed without one).
    if (!existing.lmsUsername) {
      update.lmsUsername = await generateUniqueLmsUsername(
        (update.name as string) || existing.name,
        id,
      );
    }

    // Prefer document.save() so array fields like trainerDepartments are always
    // persisted (findByIdAndUpdate can drop unknown paths on a stale compiled model).
    existing.set(update);
    if (Object.prototype.hasOwnProperty.call(update, 'trainerDepartments')) {
      existing.markModified('trainerDepartments');
    }
    if (Object.prototype.hasOwnProperty.call(update, 'isActive')) {
      existing.markModified('isActive');
    }
    await existing.save();

    // Confirm Left/active actually landed in MongoDB — do not trust in-memory state.
    if (Object.prototype.hasOwnProperty.call(update, 'isActive')) {
      const persisted = await Employee.findById(id).select('isActive').lean<{ isActive?: boolean } | null>();
      const expected = update.isActive === true;
      if (!persisted || persisted.isActive !== expected) {
        return NextResponse.json(
          { error: 'Failed to persist left/active status in the database. Please try again.' },
          { status: 500 },
        );
      }
      existing.isActive = persisted.isActive;
      bustTrainerScheduleCaches();
    }

    invalidateEmployeeAssignmentsCache();
    void invalidateManageSopViewCache();

    // Never leak the hash; report whether a password is set instead.
    const out = existing.toObject();
    delete out.lmsPasswordHash;
    const hasLmsPassword = !!update.lmsPasswordHash || !!existing.lmsPasswordHash;
    return NextResponse.json({
      employee: {
        ...out,
        trainerDepartments: Array.isArray(out.trainerDepartments)
          ? out.trainerDepartments
          : [],
        dateOfJoining: out.dateOfJoining
          ? formatDateOfJoiningInput(out.dateOfJoining as Date)
          : undefined,
        hasLmsPassword,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// DELETE /api/employees/[id] — hard delete (employees can also be deactivated via PATCH isActive=false)
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await connectDB();
    const { id } = await params;
    const employee = await Employee.findByIdAndDelete(id);
    if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 });
    return NextResponse.json({ message: `Employee ${employee.name} deleted` });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
