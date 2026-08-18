import { NextResponse } from 'next/server';
import { requireLmsTrainer, deptMatchesTrainerScope } from '@/lib/lmsTrainerAuth';
import { buildSopList } from '@/app/api/lms/admin/sop-exam-settings/route';
import { getOrBuildLmsCache, lmsServerKeys, lmsServerTtl } from '@/lib/lmsCache';
import { buildTrainerMcqCatalogMap } from '@/lib/trainerMcqCatalog';

export const dynamic = 'force-dynamic';

/**
 * GET /api/lms/trainer/exam-catalog
 * SOPs in the trainer's departments with per-language MCQ readiness.
 */
export async function GET() {
  const auth = await requireLmsTrainer();
  if (!auth.ok) return auth.response;

  try {
    const [list, catalogMap] = await Promise.all([
      getOrBuildLmsCache(
        lmsServerKeys.adminSopExamSettings(),
        lmsServerTtl.adminSopExamSettings,
        buildSopList,
      ),
      buildTrainerMcqCatalogMap(),
    ]);
    const depts = auth.trainer.trainerDepartments;
    const settingsByCode = new Map(list.sops.map((s) => [s.sopCode, s]));

    const exams = [...catalogMap.values()]
      .filter((s) => deptMatchesTrainerScope(s.department, depts))
      .map((entry) => {
        const settings = settingsByCode.get(entry.sopCode);
        return {
          sopCode: entry.sopCode,
          sopIdentifier: entry.sopIdentifier,
          sopVersion: entry.sopVersion,
          sopName: entry.sopName,
          sopNameGujarati: entry.sopNameGujarati,
          department: entry.department,
          language: entry.language,
          isDualLanguage: entry.isDualLanguage,
          needsEn: entry.needsEn,
          needsGu: entry.needsGu,
          eng: entry.eng,
          guj: entry.guj,
          pdfEng: entry.pdfEng,
          pdfGuj: entry.pdfGuj,
          videoEng: entry.videoEng,
          videoGuj: entry.videoGuj,
          questionCount: entry.questionCount,
          lmsApproved: entry.lmsApproved,
          examQuestionCount: settings?.effective.examQuestionCount,
          passingScore: settings?.effective.passingScore,
        };
      })
      .sort((a, b) => a.sopCode.localeCompare(b.sopCode));

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
