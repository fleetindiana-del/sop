import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import { generateUniqueLmsUsername } from '@/lib/lms-credentials';
import {
  parseDateOfJoining,
  resolveInductionTrainingRequired,
  formatDateOfJoiningInput,
} from '@/lib/employeeInduction';
import { parseTrainerDepartments } from '@/lib/employeeTrainer';
import {
  invalidateEmployeeDerivedCaches,
  touchesEmployeeIdentity,
} from '@/lib/employeeCacheInvalidation';
import { refreshTrainerRosterIdentity } from '@/lib/lmsTrainerEmployees';
import { logAuditEvent, resolveAuditActor } from '@/lib/audit-log';
import Employee from '@/models/Employee';
import TrainerEmployee from '@/models/lms/TrainerEmployee';

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

    if (body.isDeleted === false) {
      update.isDeleted = false;
      update.deletedAt = null;
      update.deletedKind = undefined;
      if (body.isActive === undefined) update.isActive = true;
    } else if (body.isDeleted === true) {
      update.isDeleted = true;
      update.isActive = false;
      update.deletedAt = new Date();
      update.deletedKind = 'deleted';
    }

    // Designation change: stamp the previous value and the time, so LMS and
    // admin screens can confirm the update landed without reading the audit log.
    const priorDesignation = String(existing.designation || '').trim();
    const nextDesignation =
      typeof update.designation === 'string' ? update.designation.trim() : priorDesignation;
    const designationChanged =
      update.designation !== undefined && nextDesignation !== priorDesignation;
    if (designationChanged) {
      update.previousDesignation = priorDesignation;
      update.designationUpdatedAt = new Date();
    }

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
    if (Object.prototype.hasOwnProperty.call(update, 'isDeleted')) {
      existing.markModified('isDeleted');
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
      if (expected === false) {
        const identity = {
          name: String(existing.name || '').trim(),
          department: String(existing.department || '').trim(),
        };
        if (identity.name && identity.department) {
          const twins = await Employee.find({
            _id: { $ne: existing._id },
            name: identity.name,
            department: identity.department,
            isActive: { $ne: false },
          }).select('_id').lean<Array<{ _id: typeof existing._id }>>();
          const twinIds = twins.map((t) => t._id);
          if (twinIds.length > 0) {
            await Employee.updateMany(
              { _id: { $in: twinIds } },
              { $set: { isActive: false } },
            );
          }
          await TrainerEmployee.deleteMany({
            employeeId: { $in: [id, ...twinIds.map((tid) => String(tid))] },
          });
        } else {
          await TrainerEmployee.deleteMany({ employeeId: id });
        }
      }
    }

    // Every employee edit gets the full fan-out. Identity (designation included)
    // is denormalised into matrix rows, filter dropdowns, trainer rosters and
    // LMS admin views; a password change flips `hasLmsAccess` on the trainer
    // scheduling views. This used to fire only on the Mark-as-Left path, which
    // is why a designation change kept rendering the old title until each
    // cache's TTL (up to 5 minutes) expired.
    invalidateEmployeeDerivedCaches();

    // Full audit trail for designation changes: who, what, when.
    if (designationChanged) {
      await logAuditEvent({
        actor: await resolveAuditActor(req),
        entityType: 'employee',
        entityId: id,
        entityLabel: String(existing.name || '').trim() || id,
        department: String(existing.department || '').trim() || undefined,
        action: 'updated',
        fieldsChanged: ['designation'],
        previousValues: { designation: priorDesignation },
        updatedValues: { designation: nextDesignation },
        summary:
          `Changed designation for ${existing.name}: ` +
          `${priorDesignation || '(none)'} → ${nextDesignation || '(none)'}`,
      });
    }

    // Keep the denormalised copy on trainer rosters pointing at the new values.
    if (touchesEmployeeIdentity(update)) {
      await refreshTrainerRosterIdentity(id, {
        name: existing.name,
        department: existing.department,
        designation: existing.designation,
      });
    }

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

// DELETE /api/employees/[id] — archive to Obsolete / Deleted (not a hard wipe).
// Left employees stay on the Left tab via PATCH isActive=false; this path takes
// them off both live rosters. A missing id is treated as already gone so the
// UI can drop the row instead of getting stuck on "Employee not found".
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await connectDB();
    const { id } = await params;
    const { searchParams } = req.nextUrl;
    const name = String(searchParams.get('name') || '').trim();
    const department = String(searchParams.get('department') || '').trim();
    const designation = String(searchParams.get('designation') || '').trim();

    let employee = mongoose.isValidObjectId(id) ? await Employee.findById(id) : null;
    if (!employee && name && department) {
      employee = await Employee.findOne({ name, department });
    }

    if (!employee && name && department) {
      employee = await Employee.create({
        name,
        department,
        designation: designation || '—',
        isActive: false,
        isDeleted: true,
        deletedAt: new Date(),
        deletedKind: 'obsolete',
      });
    }

    if (!employee) {
      return NextResponse.json({
        alreadyRemoved: true,
        message: 'Employee was not in Employee Master and has been dropped from the list',
      });
    }

    if (!employee.isDeleted) {
      employee.set({
        isDeleted: true,
        isActive: false,
        deletedAt: new Date(),
        deletedKind: 'deleted',
      });
      employee.markModified('isDeleted');
      await employee.save();
    }

    const identity = {
      name: String(employee.name || '').trim(),
      department: String(employee.department || '').trim(),
    };
    if (identity.name && identity.department) {
      await Employee.updateMany(
        {
          _id: { $ne: employee._id },
          name: identity.name,
          department: identity.department,
          isDeleted: { $ne: true },
        },
        {
          $set: {
            isDeleted: true,
            isActive: false,
            deletedAt: new Date(),
            deletedKind: 'obsolete',
          },
        },
      );
    }

    await TrainerEmployee.deleteMany({ employeeId: String(employee._id) });
    invalidateEmployeeDerivedCaches();

    const out = employee.toObject();
    delete out.lmsPasswordHash;
    return NextResponse.json({
      message: `Employee ${employee.name} moved to Obsolete / Deleted`,
      employee: {
        ...out,
        dateOfJoining: out.dateOfJoining
          ? formatDateOfJoiningInput(out.dateOfJoining as Date)
          : undefined,
      },
    });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
