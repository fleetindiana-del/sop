import { NextRequest, NextResponse } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import { requireAuth } from '@/lib/withAuth';
import InductionMatrixSOPAssignment from '@/models/InductionMatrixSOPAssignment';
import SOP from '@/models/SOP';
import {
  inductionDeptKey,
  listInductionDesignationRows,
  stripInductionSopVersion,
} from '@/lib/inductionDesignationAssignments';
import { invalidateInductionTrainingMatrixCache } from '@/lib/inductionTrainingMatrixCache';
import { invalidateEmployeeAssignmentsCache } from '@/lib/employeeAssignments';

export const dynamic = 'force-dynamic';

type Ticks = Record<string, Record<string, boolean>>;

/** Manage SOP keys induction checkboxes as "<department>|<full designation>". */
function splitKey(key: string): { department: string; designation: string } | null {
  const idx = key.indexOf('|');
  if (idx <= 0) return null;
  const department = key.slice(0, idx).trim();
  const designation = key.slice(idx + 1).trim();
  return department && designation ? { department, designation } : null;
}

// GET /api/induction-training-matrix/designation-ticks → { ticks: { [sopCode]: { "dept|designation": true } } }
export async function GET() {
  const auth = await requireAuth();
  if (auth.error) return auth.error;
  try {
    await connectDB();
    const rows = await listInductionDesignationRows();
    const ticks: Ticks = {};
    for (const row of rows) {
      const inner = (ticks[row.sopCode] ||= {});
      for (const d of row.designationApplicability) inner[`${row.department}|${d}`] = true;
    }
    return NextResponse.json({ ticks });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

// PUT /api/induction-training-matrix/designation-ticks
// Body: { ticks: { [sopCode]: { "dept|designation": boolean } } } — the full
// induction state for each SOP sent; departments left with no ticked
// designation have their assignment deactivated.
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(['admin', 'trainer']);
  if (auth.error) return auth.error;
  try {
    const body = await req.json().catch(() => ({}));
    const ticks: Ticks = body?.ticks && typeof body.ticks === 'object' ? body.ticks : {};
    const actor = auth.session?.user?.email || auth.session?.user?.name || 'admin';
    await connectDB();

    let saved = 0;
    let removed = 0;
    const now = new Date();

    for (const [rawCode, inner] of Object.entries(ticks)) {
      const sopCode = stripInductionSopVersion(rawCode);
      const codeRe = `^${sopCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?$`;
      if (!sopCode || !inner || typeof inner !== 'object') continue;

      // department key → { display name, ticked designations }
      const byDept = new Map<string, { department: string; designations: Set<string> }>();
      for (const [key, value] of Object.entries(inner)) {
        const parsed = splitKey(key);
        if (!parsed) continue;
        const dk = inductionDeptKey(parsed.department);
        const entry = byDept.get(dk) || { department: parsed.department, designations: new Set<string>() };
        if (value) entry.designations.add(parsed.designation);
        byDept.set(dk, entry);
      }
      if (byDept.size === 0) continue;

      const existing = await InductionMatrixSOPAssignment.find({ isActive: true, sopCode: { $regex: codeRe, $options: 'i' } });

      let sop: { _id: unknown; name?: string } | null = null;
      for (const [dk, { department, designations }] of byDept) {
        const current = existing.filter((r) => inductionDeptKey(r.department) === dk);
        if (designations.size === 0) {
          for (const r of current) {
            r.isActive = false;
            r.deletedAt = now;
            r.deletedBy = actor;
            await r.save();
            removed++;
          }
          continue;
        }
        const list = [...designations].sort();
        if (current.length > 0) {
          const [keep, ...dupes] = current;
          keep.designationApplicability = list;
          keep.updatedBy = actor;
          await keep.save();
          for (const d of dupes) {
            d.isActive = false;
            d.deletedAt = now;
            d.deletedBy = actor;
            await d.save();
          }
        } else {
          if (!sop) {
            sop = await SOP.findOne({
              isObsolete: { $ne: true },
              $or: [{ sopBaseId: sopCode }, { identifier: { $regex: codeRe, $options: 'i' } }],
            })
              .sort({ versionNum: -1 })
              .select('_id name')
              .lean<{ _id: unknown; name?: string }>();
          }
          if (!sop) continue;
          await InductionMatrixSOPAssignment.create({
            department,
            sopId: sop._id,
            sopCode,
            sopName: String(sop.name || sopCode),
            effectiveMonth: now.getMonth() + 1,
            effectiveYear: now.getFullYear(),
            designationApplicability: list,
            isActive: true,
            createdBy: actor,
          });
        }
        saved++;
      }
    }

    await invalidateInductionTrainingMatrixCache();
    invalidateEmployeeAssignmentsCache();

    return NextResponse.json({ ok: true, saved, removed });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
