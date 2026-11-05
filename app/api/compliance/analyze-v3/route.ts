import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import { connectDB } from '@/lib/mongodb';
import SOP from '@/models/SOP';
import ComplianceRunRequest from '@/models/ComplianceRunRequest';
import SOPGuideline from '@/models/SOPGuideline';
import ComplianceAnalysisJob from '@/models/ComplianceAnalysisJob';
import {
  validateAnalysisPrerequisites,
  analyzeClauseWithPrecision,
  calculateIntelligentScore,
  extractSOPSections,
  getDepartmentContext,
  rebalanceV3Findings,
  v3ScoreToBreakdown,
  GuidelineRequirement,
  ComplianceFindingV3,
  AnalysisResultStatus,
} from '@/lib/complianceEngineV3';
import { validateFindings } from '@/lib/ComplianceFindingValidatorV3';
import { validateDataSync, autoFixDataSync } from '@/lib/syncValidator';
import { saveComplianceReport } from '@/lib/complianceReportStorage';
import { requireAuth } from '@/lib/withAuth';
import { isCodexUsageLimitError } from '@/lib/codex-cli';
import { isGrokbotUnavailableError } from '@/lib/grokbot-llm';
import { runWithAgentBackend } from '@/lib/agent-backend';
import type { ComplianceFinding } from '@/lib/complianceEngine';
import type { LlmProvider } from '@/lib/llm';
import {
  beginComplianceRun,
  endComplianceRun,
  isComplianceAnalysisCancelledError,
  isComplianceRunActiveInProcess,
  assertComplianceRunActive,
} from '@/lib/compliance-run-control';
import { resolveComplianceSopContent } from '@/lib/compliance-sop-content';

/**
 * ═══════════════════════════════════════════════════════════════════════
 * COMPLIANCE ANALYSIS API V3 - Precision & Scalability
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * KEY IMPROVEMENTS:
 * 1. True Gatekeeping - Won't analyze without valid data
 * 2. Department Intelligence - Context-aware analysis
 * 3. Transparent Results - Clear explanation of why scores are given
 * 4. No Misleading Scores - 0/10 only when truly non-compliant
 */

// Helper: Update job progress
async function updateJobProgress(jobId: string, updates: any) {
  await ComplianceAnalysisJob.findOneAndUpdate(
    { jobId },
    { 
      ...updates,
      lastHeartbeat: new Date(),
    }
  );
}

// Helper: Log error with proper field name
async function logJobError(
  jobId: string,
  errorType: string,
  errorMessage: string,
  affectedStep: string,
  errorStack?: string
) {
  await ComplianceAnalysisJob.findOneAndUpdate(
    { jobId },
    {
      $push: {
        jobErrors: {
          errorType,
          errorMessage,
          errorStack,
          affectedStep,
          timestamp: new Date(),
          recoverable: !['sop-not-found', 'no-guidelines'].includes(errorType),
        },
      },
      status: 'failed',
      currentStep: 'failed',
      completedAt: new Date(),
      isActive: false,
    }
  );
}

/**
 * POST: Start Compliance Analysis V3
 */
export const maxDuration = 300;

/**
 * provider "grokbot" runs the Codex pipeline unchanged, but each prompt is
 * answered by GrokBot through the MCP AI-task queue instead of `codex exec`.
 */
export async function POST(request: NextRequest) {
  const body = await request.clone().json().catch(() => null);
  if (body?.provider === 'codex') return runWithAgentBackend('codex', () => analyzeV3(request));
  if (body?.provider !== 'grokbot') return analyzeV3(request);
  // A V3 audit outlives a Vercel request; the local worker runs it instead.
  if (process.env.VERCEL) return queueGrokbotRun(String(body.sopId ?? ''));
  return runWithAgentBackend('grokbot', () => analyzeV3(request));
}

async function queueGrokbotRun(sopId: string) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;
  if (!mongoose.Types.ObjectId.isValid(sopId)) {
    return NextResponse.json({ success: false, error: 'Missing SOP ID' }, { status: 400 });
  }
  await connectDB();
  const sop = await SOP.findById(sopId).select('identifier name department').lean();
  if (!sop) return NextResponse.json({ success: false, error: 'SOP not found' }, { status: 404 });

  const user = auth.session.user;
  const open = await ComplianceRunRequest.findOne({
    sopId: sop._id,
    autoRun: true,
    status: { $in: ['pending', 'in_progress'] },
  }).select('_id').lean();
  const requestId = open?._id ?? (await ComplianceRunRequest.create({
    sopId: sop._id,
    sopIdentifier: sop.identifier,
    sopName: sop.name,
    department: sop.department || 'General',
    requesterId: new mongoose.Types.ObjectId(user.id),
    requesterName: user.name || user.username || 'User',
    requesterUsername: user.username || '',
    status: 'pending',
    autoRun: true,
    agentBackend: 'grokbot',
  }))._id;

  return NextResponse.json({
    success: true,
    queued: true,
    requestId: String(requestId),
    overallScore: null,
    complianceStatus: 'Queued for GrokBot',
    userMessage:
      'Queued for GrokBot. The local SOP worker runs the audit and GrokBot answers it; the report appears when it is saved.',
  }, { status: 202 });
}

async function analyzeV3(request: NextRequest) {
  const auth = await requireAuth(["admin", "trainer", "viewer"]);
  if (auth.error) return auth.error;

  const startTime = Date.now();
  console.log('\n🔍 ═════ COMPLIANCE ANALYSIS V3 - PRECISION MODE ═════');
  
  let jobId: string | null = null;
  let aiCallsCount = 0;
  
  try {
    await connectDB();
    
    const body = await request.json();
    const {
      sopId,
      guidelineFilters,
      guidelineIds,
      config,
      provider: bodyProvider,
      model: bodyModel,
      includeAnnexures,
      requireAnnexures,
    } = body;
    // Default ON — linked annexures carry forms/logs that close "data not tracked" gaps.
    const withAnnexures = includeAnnexures !== false;
    const mustHaveAnnexures = requireAnnexures === true;
    const userId = auth.session.user.id;

    const provider: LlmProvider | undefined =
      bodyProvider === 'grokbot'
        ? 'codex'
        : bodyProvider === 'codex' || bodyProvider === 'claude' || bodyProvider === 'ollama' || bodyProvider === 'gemini'
          ? bodyProvider
          : undefined;
    const modelOverride = typeof bodyModel === 'string' && bodyModel.trim() ? bodyModel.trim() : undefined;
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 0: VALIDATE REQUEST
    // ═══════════════════════════════════════════════════════════════════
    if (!sopId) {
      return NextResponse.json({
        success: false,
        error: 'Missing SOP ID',
        userMessage: 'Please provide a valid SOP ID to analyze.',
      }, { status: 400 });
    }
    
    if (!userId) {
      return NextResponse.json({
        success: false,
        error: 'Missing User ID',
        userMessage: 'User authentication required.',
      }, { status: 401 });
    }
    
    // Gemini API key only required when using Gemini (default)
    const effectiveProvider: LlmProvider = provider ?? 'gemini';
    if (effectiveProvider === 'gemini') {
      const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
      if (!geminiKey) {
        console.error('❌ GEMINI_API_KEY (or GOOGLE_AI_API_KEY) is not set.');
        return NextResponse.json({
          success: false,
          error: 'AI API key not configured',
          userMessage: 'The Gemini AI API key is not configured. Please add GEMINI_API_KEY to your .env.local file and restart the server.',
          analysisExplanation: 'Analysis cannot proceed because the AI service (Google Gemini) API key is missing. Please contact your administrator.',
          nextSteps: [
            'Add GEMINI_API_KEY=your-api-key to the .env.local file',
            'Restart the development server',
            'Try the analysis again',
          ],
        }, { status: 500 });
      }
    }
    
    jobId = `job-v3-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    console.log(`✅ Job ID: ${jobId}`);
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: FETCH SOP
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n📄 Step 1: Fetching SOP...');
    
    const job = new ComplianceAnalysisJob({
      jobId,
      sopId,
      sopIdentifier: 'fetching...',
      sopName: 'fetching...',
      department: 'Unknown',
      status: 'processing',
      currentStep: 'fetching-sop',
      progress: 5,
      config: {
        aiModel: config?.aiModel || 'gemini-2.0-flash',
        maxClausesToAnalyze: config?.maxClausesToAnalyze || 50,
        guidelineFilters,
        provider: effectiveProvider,
        model: modelOverride,
        retryOnFailure: true,
        retryCount: 0,
        maxRetries: 3,
      },
      triggeredBy: userId,
      queuedAt: new Date(),
      startedAt: new Date(),
    });
    
    await job.save();
    
    const resolvedSop = await resolveComplianceSopContent(sopId, {
      includeAnnexures: withAnnexures,
    });
    const sop = resolvedSop?.record;
    
    if (!sop) {
      await logJobError(jobId, 'sop-not-found', 
        `SOP with ID "${sopId}" not found.`, 'sop-fetch');
      
      return NextResponse.json({
        success: false,
        jobId,
        error: 'SOP not found',
        status: 'SOP_INVALID',
        userMessage: 'The SOP you\'re trying to analyze doesn\'t exist.',
        analysisExplanation: 'Analysis cannot proceed because the SOP was not found in the database.',
      }, { status: 404 });
    }
    
    console.log(`✅ SOP: ${sop.name} (${sop.identifier})`);
    console.log(`   Department: ${sop.department}`);
    console.log(`   Content: ${sop.content?.length || 0} characters`);
    if (withAnnexures) {
      const annexChars = resolvedSop?.annexureSupplementChars ?? 0;
      console.log(`   Annexures: ${annexChars} characters`);
      if (mustHaveAnnexures && !annexChars) {
        const message = 'No readable linked annexures were found for this SOP.';
        await logJobError(jobId, 'annexures-not-found', message, 'sop-fetch');
        return NextResponse.json(
          { success: false, error: message, userMessage: message },
          { status: 422 },
        );
      }
    }

    if (isComplianceRunActiveInProcess(sopId)) {
      await ComplianceAnalysisJob.findOneAndUpdate(
        { jobId },
        { status: 'cancelled', isActive: false, completedAt: new Date() },
      );
      return NextResponse.json(
        {
          success: false,
          error: 'Compliance analysis already running for this SOP. Click Stop first or wait for it to finish.',
        },
        { status: 409 },
      );
    }

    const { controller, runEpoch } = beginComplianceRun(sopId);

    try {
    
    // Extract SOP sections
    const sopSections = extractSOPSections(sop.content || '');
    console.log(`   Sections found: ${sopSections.length}`);
    
    await updateJobProgress(jobId, {
      sopIdentifier: sop.identifier,
      sopName: sop.name,
      department: sop.department,
      'steps.sopFetch.status': 'completed',
      'steps.sopFetch.completedAt': new Date(),
      'steps.sopFetch.sopContentLength': sop.content?.length || 0,
      progress: 15,
    });
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: FETCH & FILTER GUIDELINES
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n📚 Step 2: Fetching guidelines...');
    
    await updateJobProgress(jobId, {
      currentStep: 'fetching-guidelines',
      'steps.guidelineFetch.status': 'in-progress',
      'steps.guidelineFetch.startedAt': new Date(),
    });
    
    const guidelineQuery: any = {};
    if (guidelineFilters?.folderName) guidelineQuery.folderName = guidelineFilters.folderName;
    if (guidelineFilters?.category) guidelineQuery.category = guidelineFilters.category;
    if (guidelineFilters?.guidelineType) guidelineQuery.guidelineType = guidelineFilters.guidelineType;
    // Restrict to the guidelines the user explicitly selected
    if (Array.isArray(guidelineIds) && guidelineIds.length > 0) {
      guidelineQuery._id = { $in: guidelineIds };
    }

    const guidelines = await SOPGuideline.find(guidelineQuery)
      .select('name folderName pdfName guidelineType category clauses ocrStatus')
      .lean();
    
    // Filter for guidelines with valid clauses
    const validGuidelines = guidelines.filter(g => 
      g.clauses && 
      Array.isArray(g.clauses) && 
      g.clauses.length > 0 &&
      (g.ocrStatus === 'completed' || !g.ocrStatus) // Include if completed or field doesn't exist
    );
    
    
    console.log(`   Guidelines found: ${guidelines.length} (${validGuidelines.length} with valid clauses)`);
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: GATEKEEPING - VALIDATE PREREQUISITES (CRITICAL!)
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n🔐 Step 3: Validating prerequisites (Gatekeeping)...');
    
    const gatekeeping = await validateAnalysisPrerequisites(
      sop,
      validGuidelines,
      sop.department || 'General'
    );
    
    console.log(`   SOP Valid: ${gatekeeping.sopValidation.isValid}`);
    console.log(`   Guidelines Synced: ${gatekeeping.guidelineValidation.syncStatus}`);
    console.log(`   Clauses Found: ${gatekeeping.guidelineValidation.clausesFound}`);
    console.log(`   Applicable Clauses: ${gatekeeping.guidelineValidation.applicableClausesCount}`);
    console.log(`   Can Proceed: ${gatekeeping.canProceed}`);
    
    // If gatekeeping fails, return clear explanation
    if (!gatekeeping.canProceed && gatekeeping.status === 'GUIDELINE_SYNC_FAILED') {
      await logJobError(jobId, 'no-guidelines', gatekeeping.failureDetails || 'Guideline sync failed', 'guideline-fetch');
      
      return NextResponse.json({
        success: false,
        jobId,
        status: gatekeeping.status,
        error: gatekeeping.failureReason,
        userMessage: gatekeeping.failureDetails,
        gatekeeping,
        analysisExplanation: `Analysis was stopped because: ${gatekeeping.failureDetails}. This is NOT a compliance failure - it means we cannot analyze yet.`,
        nextSteps: [
          'Upload regulatory guidelines to the Guidelines section',
          'Ensure guidelines are properly processed (OCR completed)',
          'Try again after uploading guidelines',
        ],
      }, { status: 400 });
    }
    
    if (!gatekeeping.canProceed && gatekeeping.status === 'SOP_INVALID') {
      await logJobError(jobId, 'validation-error', gatekeeping.failureDetails || 'SOP invalid', 'sop-fetch');
      
      return NextResponse.json({
        success: false,
        jobId,
        status: gatekeeping.status,
        error: gatekeeping.failureReason,
        userMessage: gatekeeping.failureDetails,
        gatekeeping,
        analysisExplanation: `Analysis was stopped because: ${gatekeeping.failureDetails}`,
      }, { status: 400 });
    }
    
    await updateJobProgress(jobId, {
      'steps.guidelineFetch.status': 'completed',
      'steps.guidelineFetch.completedAt': new Date(),
      'steps.guidelineFetch.guidelinesFound': validGuidelines.length,
      'steps.guidelineFetch.clausesFound': gatekeeping.guidelineValidation.clausesFound,
      progress: 25,
    });
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 4: PREPARE CLAUSES WITH DEPARTMENT CONTEXT
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n🏢 Step 4: Applying department intelligence...');
    
    const deptContext = getDepartmentContext(sop.department || 'General');
    console.log(`   Department: ${deptContext.department}`);
    console.log(`   Relevant categories: ${deptContext.relevantCategories.join(', ')}`);
    
    // Build clauses list with proper typing
    const allClauses: GuidelineRequirement[] = validGuidelines.flatMap(guideline =>
      (guideline.clauses || []).map((clause: any) => ({
        guidelineId: guideline._id?.toString() || '',
        guidelineName: guideline.name || 'Unknown Guideline',
        folderName: guideline.folderName || '',
        pdfName: guideline.pdfName || '',
        guidelineType: guideline.guidelineType || '',
        category: guideline.category || '',
        clauseNumber: clause.clauseNumber || '',
        clauseTitle: clause.clauseTitle || '',
        clauseText: clause.clauseText || '',
        keywords: clause.keywords || [],
        applicableDepartments: [],
        isMandatory: true,
        regulatoryReference: `${guideline.guidelineType || ''} ${clause.clauseNumber || ''}`,
      }))
    );
    
    // Limit clauses
    const maxClauses = config?.maxClausesToAnalyze || 50;
    const clausesToAnalyze = allClauses.slice(0, maxClauses);
    
    console.log(`   Total clauses: ${allClauses.length}`);
    console.log(`   Clauses to analyze: ${clausesToAnalyze.length}`);
    
    await updateJobProgress(jobId, {
      totalClauses: clausesToAnalyze.length,
      progress: 30,
    });
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 5: AI ANALYSIS WITH PRECISION
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n🤖 Step 5: Analyzing clauses with AI (precision mode)...');
    
    await updateJobProgress(jobId, {
      currentStep: 'analyzing-clauses',
      'steps.clauseAnalysis.status': 'in-progress',
      'steps.clauseAnalysis.startedAt': new Date(),
    });
    
    const findings: ComplianceFindingV3[] = [];
    const guidelinesUsedMap = new Map();
    let analysisErrors = 0;
    
    for (let i = 0; i < clausesToAnalyze.length; i++) {
      assertComplianceRunActive(sopId, runEpoch);

      const clause = clausesToAnalyze[i];
      const progress = 30 + Math.floor((i / clausesToAnalyze.length) * 45);
      
      console.log(`   [${i + 1}/${clausesToAnalyze.length}] ${clause.clauseNumber} - ${clause.clauseTitle.substring(0, 40)}...`);
      
      await updateJobProgress(jobId, {
        clausesAnalyzed: i + 1,
        progress,
        currentClause: {
          clauseNumber: clause.clauseNumber,
          clauseTitle: clause.clauseTitle,
          startedAt: new Date(),
        },
      });
      
      try {
        const finding = await analyzeClauseWithPrecision(
          sop.content || '',
          sopSections,
          sop.name,
          sop.identifier,
          sop.department || 'General',
          clause,
          {
            aiModel: config?.aiModel || 'gemini-2.0-flash',
            provider: effectiveProvider,
            model: modelOverride,
            runKey: sopId,
            signal: controller.signal,
            runEpoch,
          },
        );
        
        aiCallsCount++;
        findings.push(finding);
        
        // Track guidelines used
        const key = clause.guidelineId;
        if (!guidelinesUsedMap.has(key)) {
          guidelinesUsedMap.set(key, {
            guidelineId: clause.guidelineId,
            guidelineName: clause.guidelineName,
            folderName: clause.folderName,
            pdfName: clause.pdfName,
            guidelineType: clause.guidelineType,
            category: clause.category,
            totalClauses: 0,
            clausesChecked: 0,
          });
        }
        const usage = guidelinesUsedMap.get(key);
        usage.totalClauses++;
        usage.clausesChecked++;
        
        // Log result
        const emoji = finding.complianceLevel === 'compliant' ? '✅' : 
                      finding.complianceLevel === 'partial' ? '🟡' :
                      finding.complianceLevel === 'not-applicable' ? '⬜' :
                      finding.complianceLevel === 'unable-to-determine' ? '❓' : '❌';
        console.log(`      ${emoji} ${finding.complianceLevel} (${finding.matchConfidence}%)`);
        
      } catch (clauseError) {
        if (isComplianceAnalysisCancelledError(clauseError)) throw clauseError;
        if (isCodexUsageLimitError(clauseError)) throw clauseError;
        if (isGrokbotUnavailableError(clauseError)) throw clauseError;
        console.error(`      ❌ Error: ${(clauseError as Error).message}`);
        analysisErrors++;
      }
    }
    
    console.log(`\n✅ Analysis completed: ${findings.length}/${clausesToAnalyze.length} clauses`);
    if (analysisErrors > 0) {
      console.log(`   ⚠️ Errors: ${analysisErrors}`);
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 5.5: VALIDATE FINDINGS (STRICT MODE)
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n🔍 Step 5.5: Validating findings quality...');
    
    const validation = validateFindings(findings);
    
    console.log(`   Total findings: ${validation.summary.total}`);
    console.log(`   Valid: ${validation.summary.valid}`);
    console.log(`   Invalid: ${validation.summary.invalid}`);
    console.log(`   Warnings: ${validation.summary.warnings}`);
    
    // Log validation issues
    if (validation.invalidFindings.length > 0) {
      console.warn(`\n⚠️ VALIDATION WARNINGS: ${validation.invalidFindings.length} findings have quality issues:`);
      validation.invalidFindings.forEach(({ finding, validation: v }, idx) => {
        console.warn(`   ${idx + 1}. ${finding.clauseNumber}:`);
        v.errors.forEach(err => console.warn(`      ❌ ${err}`));
        v.warnings.forEach(warn => console.warn(`      ⚠️ ${warn}`));
      });
    }
    
    // Use only valid findings for report (or all if we want to show issues)
    const validatedFindings = validation.validFindings.length > 0 
      ? validation.validFindings 
      : findings; // Fallback to all findings if validation is too strict

    const reportFindings = rebalanceV3Findings(validatedFindings as ComplianceFindingV3[]);
    
    console.log(`   Using ${reportFindings.length} findings for report`);
    console.log(`   Mix: ✓${reportFindings.filter(f => f.complianceLevel === 'compliant').length} ~${reportFindings.filter(f => f.complianceLevel === 'partial').length} ✗${reportFindings.filter(f => f.complianceLevel === 'non-compliant').length} N/A${reportFindings.filter(f => f.complianceLevel === 'not-applicable').length}`);
    
    await updateJobProgress(jobId, {
      'steps.clauseAnalysis.status': 'completed',
      'steps.clauseAnalysis.completedAt': new Date(),
      'steps.clauseAnalysis.clausesAnalyzed': findings.length,
      'steps.clauseAnalysis.clausesFailed': analysisErrors,
      'steps.clauseAnalysis.validationWarnings': validation.summary.warnings,
      'steps.clauseAnalysis.validationErrors': validation.summary.invalid,
      progress: 75,
    });
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 6: INTELLIGENT SCORE CALCULATION
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n📊 Step 6: Calculating intelligent score...');
    
    await updateJobProgress(jobId, {
      currentStep: 'calculating-score',
      'steps.scoreCalculation.status': 'in-progress',
      'steps.scoreCalculation.startedAt': new Date(),
    });
    
    const scoreResult = calculateIntelligentScore(reportFindings, gatekeeping);
    
    console.log(`   Overall Score: ${scoreResult.overallScore ?? 'N/A'}/10`);
    console.log(`   Compliance %: ${scoreResult.compliancePercentage ?? 'N/A'}%`);
    console.log(`   Status: ${scoreResult.complianceStatus}`);
    console.log(`   Breakdown:`);
    console.log(`     - Compliant: ${scoreResult.scoreBreakdown.compliantCount}`);
    console.log(`     - Partial: ${scoreResult.scoreBreakdown.partialCount}`);
    console.log(`     - Non-Compliant: ${scoreResult.scoreBreakdown.nonCompliantCount}`);
    console.log(`     - Not Applicable: ${scoreResult.scoreBreakdown.notApplicableCount}`);
    console.log(`     - Unable to Determine: ${scoreResult.scoreBreakdown.unableToDetermineCount}`);
    
    // Extract critical and major issues
    const criticalIssues = reportFindings.filter(f => f.issueSeverity === 'critical' && f.complianceLevel !== 'compliant');
    const majorIssues = reportFindings.filter(f => f.issueSeverity === 'major' && f.complianceLevel !== 'compliant');
    
    await updateJobProgress(jobId, {
      overallScore: scoreResult.overallScore,
      complianceStatus: scoreResult.complianceStatus,
      'steps.scoreCalculation.status': 'completed',
      'steps.scoreCalculation.completedAt': new Date(),
      'steps.scoreCalculation.overallScore': scoreResult.overallScore,
      'steps.scoreCalculation.complianceStatus': scoreResult.complianceStatus,
      progress: 85,
    });
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 7: SAVE REPORT WITH FULL TRANSPARENCY
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n💾 Step 7: Saving report...');
    
    await updateJobProgress(jobId, {
      currentStep: 'saving-report',
      'steps.reportSave.status': 'in-progress',
      'steps.reportSave.startedAt': new Date(),
    });
    
    // Build transparent explanation
    const analysisExplanation = buildAnalysisExplanation(
      sop,
      guidelines,
      findings,
      scoreResult,
      gatekeeping
    );
    
    // Build next steps
    const nextSteps = buildNextSteps(scoreResult, criticalIssues, majorIssues);
    
    // ═══════════════════════════════════════════════════════════════════
    // STEP 6.5: DATA SYNCHRONIZATION VALIDATION
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n🔄 Step 6.5: Validating data synchronization...');
    
    // Prepare report data for sync validation
    const reportData = {
      overallScore: scoreResult.overallScore ?? 0,
      complianceStatus: scoreResult.complianceStatus,
      compliancePercentage: scoreResult.compliancePercentage ?? 0,
      scoreBreakdown: {
        totalChecks: scoreResult.scoreBreakdown.totalApplicableClauses || 0,
        compliantCount: scoreResult.scoreBreakdown.compliantCount || 0,
        partialCount: scoreResult.scoreBreakdown.partialCount || 0,
        nonCompliantCount: scoreResult.scoreBreakdown.nonCompliantCount || 0,
        notApplicableCount: scoreResult.scoreBreakdown.notApplicableCount || 0,
        skippedCount: scoreResult.scoreBreakdown.skippedCount || 0,
      },
      findings: reportFindings.map(f => ({
        complianceLevel: f.complianceLevel,
        matchConfidence: f.matchConfidence,
      })),
    };
    
    const syncValidation = validateDataSync(reportData);
    
    if (!syncValidation.isValid) {
      console.warn('   ⚠️ Data synchronization issues detected:');
      syncValidation.errors.forEach(err => console.warn(`      ❌ ${err}`));
      
      if (syncValidation.autoFixable) {
        console.log('   🔧 Auto-fixing data synchronization issues...');
        const fixed = autoFixDataSync(reportData);
        
        // Update scoreResult with fixed data
        scoreResult.overallScore = fixed.overallScore;
        scoreResult.compliancePercentage = fixed.compliancePercentage;
        scoreResult.complianceStatus = fixed.complianceStatus;
        scoreResult.scoreBreakdown.compliantCount = fixed.scoreBreakdown.compliantCount;
        scoreResult.scoreBreakdown.partialCount = fixed.scoreBreakdown.partialCount;
        scoreResult.scoreBreakdown.nonCompliantCount = fixed.scoreBreakdown.nonCompliantCount;
        
        console.log('   ✅ Data synchronized successfully');
      }
    } else {
      console.log('   ✅ Data synchronization validated');
    }
    
    const clauseByKey = new Map(
      clausesToAnalyze.map((c) => [`${c.guidelineId}:${c.clauseNumber}`, c]),
    );

    const mappedFindings = reportFindings.map((f) => {
      const clause = clauseByKey.get(`${f.guidelineId}:${f.clauseNumber}`);
      return {
      clauseNumber: f.clauseNumber || "N/A",
      clauseTitle: f.clauseTitle || "Unknown Clause",
      complianceLevel: (f.complianceLevel === "unable-to-determine"
        ? "analysis-failed"
        : f.complianceLevel) as ComplianceFinding["complianceLevel"],
      matchConfidence: f.matchConfidence,
      issueSeverity: f.issueSeverity as ComplianceFinding["issueSeverity"],
      sopSectionAffected: `${f.sopSectionNumber || "N/A"} - ${f.sopSectionTitle || "Unknown"}`,
      mismatchExplanation: (f.specificGap || "No explanation available").slice(0, 2000),
      sopTextSnippet: (f.sopTextSnippet || f.sopCurrentState || "No SOP text available.").slice(0, 2000),
      guidelineRequirement: (f.guidelineRequirement || clause?.clauseText?.slice(0, 600) || "See guideline clause text").slice(0, 2000),
      clauseText: (clause?.clauseText || f.clauseText || "").slice(0, 6000),
      evidenceFound: (f.sopTextSnippet || f.sopCurrentState || "").slice(0, 2000),
      guidelineSourceLine: f.guidelineSourceLine,
      guidelineLineNumber: f.guidelineLineNumber,
      suggestedAction: (f.suggestedAction || "Manual review required").slice(0, 2000),
      suggestedText: (f.suggestedText || "Manual review required.").slice(0, 2000),
      estimatedEffort: f.estimatedEffort,
      highlightedIssue: (f.specificGap || "").slice(0, 2000),
      guidelineName: f.guidelineName,
      folderName: f.folderName,
      guidelineId: f.guidelineId,
    };
    });

    const reportStatus = ["Fully Compliant", "Partially Compliant", "Non-Compliant", "Analysis Pending", "Analysis Failed"].includes(scoreResult.complianceStatus)
      ? scoreResult.complianceStatus
      : "Analysis Failed";

    const report = await saveComplianceReport({
      sopId: sop._id.toString(),
      sopIdentifier: sop.identifier,
      sopName: sop.name,
      sopVersion: sop.version || "1.0",
      department: sop.department,
      findings: mappedFindings,
      overallScore: scoreResult.overallScore ?? 0,
      complianceStatus: reportStatus,
      scoreBreakdown: v3ScoreToBreakdown(scoreResult),
      analysisEngineVersion: "v3",
      processingTimeMs: Date.now() - startTime,
      annexuresChecked: resolvedSop?.annexureStatus === "checked",
      annexureStatus: resolvedSop?.annexureStatus ?? "none",
      linkedAnnexureCount: resolvedSop?.linkedAnnexureCount ?? 0,
      annexureChars: resolvedSop?.annexureSupplementChars ?? 0,
      annexuresIncluded: resolvedSop?.annexuresIncluded ?? [],
      annexuresSkipped: resolvedSop?.annexuresSkipped ?? [],
    });
    console.log(`✅ Report saved: ${report._id}`);

    await SOP.updateMany(
      { identifier: sop.identifier },
      {
        complianceStatus:
          (scoreResult.overallScore ?? 0) >= 8
            ? "compliant"
            : (scoreResult.overallScore ?? 0) >= 5
              ? "partial"
              : "non-compliant",
      },
    );
    
    await updateJobProgress(jobId, {
      complianceReportId: report._id,
      status: 'completed',
      currentStep: 'completed',
      completedAt: new Date(),
      processingTimeMs: Date.now() - startTime,
      isActive: false,
      'steps.reportSave.status': 'completed',
      'steps.reportSave.completedAt': new Date(),
      'steps.reportSave.reportId': report._id,
      progress: 100,
    });
    
    const totalTime = Date.now() - startTime;
    console.log(`\n✅ ANALYSIS COMPLETE: ${totalTime}ms`);
    console.log(`   AI Calls: ${aiCallsCount}`);
    console.log(`═════════════════════════════════════\n`);
    
    return NextResponse.json({
      success: true,
      jobId,
      reportId: report._id,
      
      // SOP Info
      sopIdentifier: sop.identifier,
      sopName: sop.name,
      department: sop.department,
      
      // Score (transparent)
      overallScore: scoreResult.overallScore,
      compliancePercentage: scoreResult.compliancePercentage,
      complianceStatus: scoreResult.complianceStatus,
      
      // Breakdown
      statistics: scoreResult.scoreBreakdown,
      
      // Critical findings
      criticalIssuesCount: criticalIssues.length,
      majorIssuesCount: majorIssues.length,
      
      // Transparency
      analysisExplanation,
      dataSources: {
        sopName: sop.name,
        sopIdentifier: sop.identifier,
        sopContentLength: sop.content?.length || 0,
        sopSectionsAnalyzed: sopSections.length,
        guidelinesUsed: Array.from(guidelinesUsedMap.values()).map((g: any) => g.guidelineName),
        clausesAnalyzed: findings.length,
        clausesSkipped: clausesToAnalyze.length - findings.length,
        aiCallsCount,
        analysisMethod: 'AI Semantic Analysis (V3)',
      },
      
      // Gatekeeping results
      gatekeeping: {
        sopValid: gatekeeping.sopValidation.isValid,
        guidelinesSync: gatekeeping.guidelineValidation.syncStatus,
        clausesFound: gatekeeping.guidelineValidation.clausesFound,
        applicableClauses: gatekeeping.guidelineValidation.applicableClausesCount,
      },
      
      // Next steps
      nextSteps,
      
      // Processing info
      processingTimeMs: totalTime,
      annexureSupplementChars: resolvedSop?.annexureSupplementChars ?? 0,
      message: 'Analysis completed with V3 precision engine',
      reportUrl: `/compliance/report/${report._id}`,
    });

    } catch (runError) {
      if (isComplianceAnalysisCancelledError(runError)) {
        if (jobId) {
          await ComplianceAnalysisJob.findOneAndUpdate(
            { jobId },
            {
              status: 'cancelled',
              currentStep: 'failed',
              completedAt: new Date(),
              isActive: false,
            },
          );
        }
        console.log('⏹ V3 analysis cancelled by user');
        return NextResponse.json({
          success: false,
          cancelled: true,
          jobId,
          error: 'Analysis stopped by user',
        });
      }
      throw runError;
    } finally {
      endComplianceRun(sopId);
    }
    
  } catch (error) {
    if (isComplianceAnalysisCancelledError(error)) {
      return NextResponse.json({
        success: false,
        cancelled: true,
        jobId,
        error: 'Analysis stopped by user',
      });
    }
    console.error('❌ FATAL ERROR:', error);
    
    if (jobId) {
      await logJobError(
        jobId,
        'other',
        'Unexpected error during analysis',
        'unknown',
        (error as Error).stack
      );
    }
    
    return NextResponse.json({
      success: false,
      jobId,
      error: 'Analysis failed',
      userMessage: 'An unexpected error occurred. Please try again.',
      technicalDetails: (error as Error).message,
    }, { status: 500 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function buildAnalysisExplanation(
  sop: any,
  guidelines: any[],
  findings: ComplianceFindingV3[],
  scoreResult: any,
  gatekeeping: any
): string {
  const parts: string[] = [];
  
  parts.push(`Analysis performed on ${sop.name} (${sop.identifier}) from ${sop.department} department.`);
  parts.push(`SOP content: ${sop.content?.length || 0} characters.`);
  parts.push(`Guidelines checked: ${guidelines.length} sources with ${findings.length} clauses analyzed.`);
  
  if (scoreResult.overallScore !== null) {
    parts.push(`Score: ${scoreResult.overallScore}/10 (${scoreResult.compliancePercentage}% compliant).`);
    parts.push(`Breakdown: ${scoreResult.scoreBreakdown.compliantCount} compliant, ${scoreResult.scoreBreakdown.partialCount} partial, ${scoreResult.scoreBreakdown.nonCompliantCount} non-compliant.`);
  } else {
    parts.push(`Score could not be calculated: ${scoreResult.complianceStatus}.`);
  }
  
  return parts.join(' ');
}

function buildNextSteps(
  scoreResult: any,
  criticalIssues: ComplianceFindingV3[],
  majorIssues: ComplianceFindingV3[]
): string[] {
  const steps: string[] = [];
  
  if (criticalIssues.length > 0) {
    steps.push(`Address ${criticalIssues.length} critical issue(s) immediately`);
  }
  
  if (majorIssues.length > 0) {
    steps.push(`Review ${majorIssues.length} major issue(s) for compliance gaps`);
  }
  
  if (scoreResult.scoreBreakdown.partialCount > 0) {
    steps.push('Review partial compliance items for improvement opportunities');
  }
  
  if (scoreResult.overallScore !== null && scoreResult.overallScore >= 8) {
    steps.push('Maintain current compliance standards through regular reviews');
  } else if (scoreResult.overallScore !== null && scoreResult.overallScore >= 5) {
    steps.push('Create action plan to address non-compliant areas');
  } else if (scoreResult.overallScore !== null) {
    steps.push('Prioritize comprehensive SOP revision to meet regulatory requirements');
  }
  
  if (steps.length === 0) {
    steps.push('Review the analysis results and consult with QA team');
  }
  
  return steps;
}
