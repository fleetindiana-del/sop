import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { connectDB } from '@/lib/mongodb';
import { getEmployeeAssignmentsMap } from '@/lib/employeeAssignments';
import { getJourneyContentBatch } from '@/lib/lmsJourneyContent';
import { verifyLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import {
  getOrBuildLmsCache,
  lmsCacheControl,
  lmsServerKeys,
  lmsServerTtl,
} from '@/lib/lmsCache';
import { baseIdentifierFromIdentifier } from '@/lib/sop-utils';
import { filterIgnoredAssignments, listTrainingIgnores } from '@/lib/lmsTrainingIgnore';
import { getMcqApprovedMapForCodes, familyKeyForLmsCode } from '@/lib/lmsMcqApproval';
import Employee from '@/models/Employee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Which learning resources exist for an SOP — drives the dashboard quick-action
 *  buttons. Each flag maps to a journey step id the buttons deep-link to. */
export interface SopAssetFlags {
  videoEn: boolean;
  videoGu: boolean;
  sop: boolean;
  sopGu: boolean;
  slidesEn: boolean;
  slidesGu: boolean;
  mcqEn: boolean;
  mcqGu: boolean;
  /** True when every MCQ for this SOP is checked in MCQ Bank (LMS ✔/✖ only). */
  lmsApproved: boolean;
  /** True when the current SOP document expiry date is in the past. */
  sopExpired: boolean;
}

// GET /api/lms/assets — per-assigned-SOP resource availability for the learner.
export async function GET() {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  if (!payload) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  try {
    const body = await getOrBuildLmsCache(
      lmsServerKeys.assets(payload.sub),
      lmsServerTtl.userDashboard,
      async () => {
        await connectDB();
        const employee = await Employee.findById(payload.sub)
          .lean<{ name: string; department: string; isActive: boolean }>();
        if (!employee || !employee.isActive) return { assets: {} };

        const assignmentsMap = await getEmployeeAssignmentsMap();
        const key = `${employee.department}||${employee.name}`.trim().toLowerCase();
        const ignoreRules = await listTrainingIgnores(employee.department);
        const assignments = filterIgnoredAssignments(
          assignmentsMap.get(key) || [],
          ignoreRules,
          employee.department,
        );
        const codes = assignments.map((a) => a.sopCode).filter(Boolean);

        const [contentMap, mcqApprovedMap] = await Promise.all([
          getJourneyContentBatch(codes),
          getMcqApprovedMapForCodes(codes),
        ]);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const expiredByCode = new Map<string, boolean>();
        for (const a of assignments) {
          const expired = Boolean(
            a.expiryDate && new Date(`${a.expiryDate}T00:00:00`) < today,
          );
          expiredByCode.set(a.sopCode.toUpperCase(), expired);
          const fam = (baseIdentifierFromIdentifier(a.sopCode) || a.sopCode).toUpperCase();
          expiredByCode.set(fam, expired || expiredByCode.get(fam) === true);
        }

        const assets: Record<string, SopAssetFlags> = {};
        for (const [code, content] of contentMap) {
          const fam = (baseIdentifierFromIdentifier(code) || code).toUpperCase();
          const famKey = familyKeyForLmsCode(code);
          assets[code] = {
            videoEn: content.videosEn.length > 0,
            videoGu: content.videosGu.length > 0,
            sop: Boolean(content.sopPdfUrl),
            sopGu: Boolean(content.sopPdfUrlGu),
            slidesEn: content.slidesEn.length > 0,
            slidesGu: content.slidesGu.length > 0,
            mcqEn: content.mcqCount > 0,
            mcqGu: content.mcqCountGu > 0,
            // Approved = all MCQs ticked in MCQ Bank (same rule as MCQ Bank "Approved").
            lmsApproved:
              mcqApprovedMap.get(code) === true
              || mcqApprovedMap.get(code.toUpperCase()) === true
              || mcqApprovedMap.get(famKey) === true,
            sopExpired: expiredByCode.get(code.toUpperCase()) === true
              || expiredByCode.get(fam) === true,
          };
        }
        return { assets };
      },
    );

    return NextResponse.json(body, { headers: lmsCacheControl(60) });
  } catch (err: unknown) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
