import { NextRequest, NextResponse } from 'next/server';
import type { Types } from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import { requireAuth } from '@/lib/withAuth';
import Department from '@/models/Department';
import SOP from '@/models/SOP';
import InductionMatrixSOPAssignment from '@/models/InductionMatrixSOPAssignment';
import InductionTrainingMatrixRecord from '@/models/InductionTrainingMatrixRecord';
import InductionTrainingMatrixUpload from '@/models/InductionTrainingMatrixUpload';
import { MONTH_NUM_TO_NAME, parseInductionMatrixWorkbook, type InductionParsedDept } from '@/lib/inductionMatrixExcel';
import { inductionDeptKey } from '@/lib/inductionDesignationAssignments';
import { buildExcelToDbBaseLookup, resolveExcelCodeToDbBase } from '@/lib/sopIdentifierNormalize';
import { baseIdentifierFromIdentifier } from '@/lib/sop-utils';
import { invalidateInductionTrainingMatrixCache } from '@/lib/inductionTrainingMatrixCache';
import { invalidateEmployeeAssignmentsCache } from '@/lib/employeeAssignments';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type FileResult =
  | {
      ok: true;
      fileName: string;
      department: string;
      sops: number;
      designations: number;
      unmatchedSops: string[];
    }
  | { ok: false; fileName: string; error: string };

type SopMeta = { _id: Types.ObjectId; base: string; name: string; versionNum: number };

// POST /api/induction-training-matrix/upload — multipart `files[]` (.xlsx), `clearAll`.
//
// The Excel lists, per department, which SOPs each designation must take for
// induction. It is written as induction assignments (`InductionMatrixSOPAssignment`,
// the same rows the Manage SOP induction ticks save), so every employee flagged
// for induction receives the SOPs of their designation. Each uploaded
// department's previous induction assignments are replaced. The main Training
// Matrix is untouched.
export async function POST(req: NextRequest) {
  const auth = await requireAuth(['admin', 'trainer']);
  if (auth.error) return auth.error;

  try {
    const form = await req.formData();
    const files = form.getAll('files').filter((f): f is File => typeof f !== 'string');
    if (files.length === 0) {
      return NextResponse.json({ success: false, error: 'No files uploaded.' }, { status: 400 });
    }

    await connectDB();
    const [deptDocs, sopDocs] = await Promise.all([
      Department.find({}, { name: 1 }).lean<Array<{ name?: string }>>(),
      SOP.find({ isObsolete: { $ne: true } })
        .select('_id identifier name versionNum')
        .lean<Array<{ _id: Types.ObjectId; identifier?: string; name?: string; versionNum?: number }>>(),
    ]);
    const knownDepartments = deptDocs.map((d) => String(d.name || '').trim()).filter(Boolean);

    // DB base code → latest SOP, plus the Excel-code → DB-base resolver the overview uses.
    const sopByBase = new Map<string, SopMeta>();
    for (const doc of sopDocs) {
      const identifier = String(doc.identifier || '').trim();
      if (!identifier) continue;
      const base = baseIdentifierFromIdentifier(identifier);
      const meta = { _id: doc._id, base, name: String(doc.name || '').trim() || base, versionNum: Number(doc.versionNum || 0) };
      const existing = sopByBase.get(base);
      if (!existing || meta.versionNum >= existing.versionNum) sopByBase.set(base, meta);
    }
    const excelToDbBase = buildExcelToDbBaseLookup(sopDocs);
    const resolveSop = (code: string): SopMeta | null => {
      const base = resolveExcelCodeToDbBase(code, excelToDbBase) || baseIdentifierFromIdentifier(code);
      return sopByBase.get(base) ?? null;
    };

    // Parse everything first so a bad file never wipes existing data.
    const results: FileResult[] = [];
    const parsed: Array<{ fileName: string; dept: InductionParsedDept }> = [];
    for (const file of files) {
      if (!/\.xlsx$/i.test(file.name)) {
        results.push({ ok: false, fileName: file.name, error: 'Only .xlsx files are supported.' });
        continue;
      }
      const res = parseInductionMatrixWorkbook(Buffer.from(await file.arrayBuffer()), file.name, knownDepartments);
      if (!res.ok) {
        results.push({ ok: false, fileName: file.name, error: res.error });
        continue;
      }
      for (const dept of res.departments) parsed.push({ fileName: file.name, dept });
    }

    if (parsed.length === 0) {
      const firstError = results.find((r) => !r.ok) as Extract<FileResult, { ok: false }> | undefined;
      return NextResponse.json(
        { success: false, error: firstError?.error || 'No usable data found in the uploaded files.', results },
        { status: 400 },
      );
    }

    const actor = auth.session.user?.email || auth.session.user?.name || 'admin';
    const now = new Date();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    // Legacy per-employee snapshots/records override the designation-driven
    // induction view, so clear them; uploads below are kept only as history.
    await Promise.all([
      InductionTrainingMatrixRecord.deleteMany({}),
      InductionTrainingMatrixUpload.deleteMany({}),
    ]);

    for (const { fileName, dept } of parsed) {
      const dk = inductionDeptKey(dept.department);

      // Merge Excel codes that resolve to the same DB SOP.
      const bySop = new Map<string, { meta: SopMeta; designations: Set<string>; all: boolean; month: number | null }>();
      const unmatched: string[] = [];
      for (const s of dept.sops) {
        const meta = resolveSop(s.sopCode);
        if (!meta) {
          unmatched.push(s.sopCode);
          continue;
        }
        const entry = bySop.get(meta.base) || { meta, designations: new Set<string>(), all: false, month: null };
        if (s.designations.length === 0) entry.all = true;
        for (const d of s.designations) entry.designations.add(d);
        entry.month = entry.month || s.month;
        bySop.set(meta.base, entry);
      }

      // Replace this department's induction assignments.
      const activeIds = (
        await InductionMatrixSOPAssignment.find({ isActive: true }).select('_id department').lean<Array<{ _id: Types.ObjectId; department: string }>>()
      )
        .filter((r) => inductionDeptKey(r.department) === dk)
        .map((r) => r._id);
      if (activeIds.length > 0) {
        await InductionMatrixSOPAssignment.updateMany(
          { _id: { $in: activeIds } },
          { $set: { isActive: false, deletedAt: now, deletedBy: actor, updatedBy: actor } },
        );
      }

      const docs = [...bySop.values()].map(({ meta, designations, all, month: m }) => ({
        department: dept.department,
        sopId: meta._id,
        sopCode: meta.base,
        sopName: meta.name,
        effectiveMonth: m || month,
        effectiveYear: year,
        designationApplicability: all ? [] : [...designations].sort((a, b) => a.localeCompare(b)),
        isActive: true,
        createdBy: actor,
      }));
      if (docs.length > 0) await InductionMatrixSOPAssignment.insertMany(docs);

      const designationCount = new Set(dept.sops.flatMap((s) => s.designations)).size;
      await InductionTrainingMatrixUpload.create({
        department: dept.department,
        fileName,
        fileType: 'main',
        month,
        year,
        monthName: MONTH_NUM_TO_NAME[month],
        employeeCount: 0,
        sopCount: docs.length,
        recordsImported: docs.length,
        uploadedAt: now,
        uploadedBy: actor,
      });

      results.push({
        ok: true,
        fileName,
        department: dept.department,
        sops: docs.length,
        designations: designationCount,
        unmatchedSops: unmatched,
      });
    }

    await invalidateInductionTrainingMatrixCache();
    invalidateEmployeeAssignmentsCache();

    return NextResponse.json({ success: true, results });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
