import { NextResponse } from 'next/server';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import { buildSopList } from '@/app/api/lms/admin/sop-exam-settings/route';
import { getOrBuildLmsCache, lmsServerKeys, lmsServerTtl } from '@/lib/lmsCache';

export const dynamic = 'force-dynamic';

/**
 * GET /api/lms/trainer/exam-catalog
 * SOPs in the trainer's departments that have an MCQ bank — i.e. the exams a
 * trainer can schedule. Mirrors the universe of LMS Admin Exam Settings.
 */
export async function GET() {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  try {
    const list = await getOrBuildLmsCache(
      lmsServerKeys.adminSopExamSettings(),
      lmsServerTtl.adminSopExamSettings,
      buildSopList,
    );
    const depts = auth.trainer.trainerDepartments;

    const exams = list.sops
      .filter((s) => deptMatchesTrainerScope(s.department, depts))
      .map((s) => ({
        sopCode: s.sopCode,
        sopName: s.sopName,
        department: s.department,
        questionCount: s.bankQuestionCount,
        /** All MCQs checked in MCQ Bank — exam is ready for learners. */
        lmsApproved: s.effective.lmsApproved,
        examQuestionCount: s.effective.examQuestionCount,
        passingScore: s.effective.passingScore,
      }));

    return NextResponse.json({
      departments: depts,
      exams,
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
