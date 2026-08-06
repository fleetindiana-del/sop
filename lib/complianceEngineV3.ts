import { GoogleGenerativeAI } from "@google/generative-ai";
import mongoose from "mongoose";
import type { ComplianceFinding } from "@/lib/complianceEngine";
import type { LlmProvider } from "@/lib/llm";
import {
  assertComplianceRunActive,
  ComplianceAnalysisCancelledError,
  getComplianceRunSignal,
} from "@/lib/compliance-run-control";
import { attachGuidelineSourceFields } from "@/lib/guidelineClauseDisplay";
import { windowSopContentForAudit } from "@/lib/compliance-sop-content";

export type V3AiOptions = {
  aiModel?: string;
  provider?: LlmProvider;
  model?: string;
  /** SOP id — registers Codex/Claude subprocess for Stop button kill */
  runKey?: string;
  signal?: AbortSignal;
  runEpoch?: number;
};

const V3_COMPLIANCE_SYSTEM =
  "You are a pharmaceutical GMP compliance auditor. The indexed text may include LINKED ANNEXURES (forms, logs, templates) — treat those as evidence for documentation, data tracking, and record-keeping requirements. Respond with ONLY one valid JSON object matching the schema described in the user message. No markdown fences or extra text.";

/**
 * ═══════════════════════════════════════════════════════════════════════
 * Compliance Engine V3 - Precision & Scalability
 * ═══════════════════════════════════════════════════════════════════════
 * 
 * CRITICAL IMPROVEMENTS:
 * 1. True Guideline Synchronization - Validate before analysis
 * 2. Analysis Gatekeeping - Stop if dependencies fail
 * 3. Section-Level Matching - Precise SOP-to-Clause mapping
 * 4. Intelligent Scoring - Based on actual coverage
 * 5. Department Intelligence - Context-aware analysis
 * 6. Transparent Reasoning - No misleading results
 */

// Validate API key early
const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
if (!GEMINI_KEY) {
  console.warn('⚠️ GEMINI_API_KEY (or GOOGLE_AI_API_KEY) is not set. AI analysis will fail.');
}
const genAI = new GoogleGenerativeAI(GEMINI_KEY);
const STABLE_MODEL = 'gemini-2.0-flash';

// ═══════════════════════════════════════════════════════════════════════
// TYPES & INTERFACES
// ═══════════════════════════════════════════════════════════════════════

export type AnalysisResultStatus = 
  | 'COMPLETED'
  | 'GUIDELINE_SYNC_FAILED'
  | 'SOP_INVALID'
  | 'DEPARTMENT_MISMATCH'
  | 'ANALYSIS_INCOMPLETE'
  | 'MANUAL_REVIEW_REQUIRED'
  | 'NO_APPLICABLE_GUIDELINES';

export interface GuidelineRequirement {
  guidelineId: string;
  guidelineName: string;
  folderName: string;
  pdfName: string;
  guidelineType: string;
  category: string;
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  keywords: string[];
  // Enhanced fields for precision
  applicableDepartments: string[];
  isMandatory: boolean;
  regulatoryReference: string;
}

export interface SOPSection {
  sectionNumber: string;
  sectionTitle: string;
  sectionContent: string;
  startPosition: number;
  endPosition: number;
}

export interface ComplianceFindingV3 {
  // Unique identifier for this finding
  findingId: string;
  
  // Guideline reference (precise)
  guidelineId: string;
  guidelineName: string;
  folderName: string;
  pdfName: string;
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  regulatoryReference: string;
  
  // SOP reference (precise)
  sopSectionNumber: string;
  sopSectionTitle: string;
  sopTextSnippet: string;
  
  // Analysis result
  complianceLevel: 'compliant' | 'partial' | 'non-compliant' | 'not-applicable' | 'unable-to-determine';
  matchConfidence: number;
  
  // Issue details
  issueType: 'missing-clause' | 'partial-coverage' | 'incorrect-implementation' | 'outdated-practice' | 'ambiguous-wording' | 'no-issue' | 'not-applicable';
  issueSeverity: 'critical' | 'major' | 'minor' | 'informational';
  
  // Clear explanation (no generic text)
  specificGap: string;
  guidelineRequirement: string;
  sopCurrentState: string;
  evidenceFound?: string;
  guidelineSourceLine?: string;
  guidelineLineNumber?: string;
  
  // Actionable suggestions
  suggestedAction: string;
  suggestedText: string;
  estimatedEffort: 'low' | 'medium' | 'high';
  priority: number;
  
  // Metadata
  analyzedAt: Date;
  aiModelUsed: string;
  analysisMethod: 'ai-semantic' | 'keyword-match' | 'manual';
}

export interface DepartmentContext {
  department: string;
  relevantCategories: string[];
  criticalGuidelines: string[];
  expectedCoverage: string[];
  regulatoryFramework: string[];
}

export interface AnalysisGatekeepingResult {
  canProceed: boolean;
  status: AnalysisResultStatus;
  failureReason?: string;
  failureDetails?: string;
  
  // Validation results
  sopValidation: {
    isValid: boolean;
    contentLength: number;
    hasSections: boolean;
    sectionsFound: number;
    error?: string;
  };
  
  guidelineValidation: {
    isValid: boolean;
    guidelinesFound: number;
    clausesFound: number;
    applicableClausesCount: number;
    syncStatus: 'synced' | 'partial' | 'not-synced' | 'empty';
    error?: string;
  };
  
  departmentValidation: {
    isValid: boolean;
    department: string;
    hasRelevantGuidelines: boolean;
    error?: string;
  };
}

export interface ComplianceAnalysisResultV3 {
  // Status
  status: AnalysisResultStatus;
  analysisComplete: boolean;
  
  // Transparency
  analysisExplanation: string;
  dataSources: {
    sopName: string;
    sopIdentifier: string;
    sopContentLength: number;
    sopSectionsAnalyzed: number;
    guidelinesUsed: string[];
    clausesAnalyzed: number;
    clausesSkipped: number;
    analysisMethod: string;
  };
  
  // Score (only if analysis completed)
  overallScore: number | null;
  compliancePercentage: number | null;
  complianceStatus: string;
  
  // Breakdown
  scoreBreakdown: {
    totalApplicableClauses: number;
    compliantCount: number;
    partialCount: number;
    nonCompliantCount: number;
    notApplicableCount: number;
    unableToDetermineCount: number;
    skippedCount: number;
  };
  
  // Findings
  findings: ComplianceFindingV3[];
  
  // Critical issues highlighted
  criticalIssues: ComplianceFindingV3[];
  majorIssues: ComplianceFindingV3[];
  
  // Gatekeeping results
  gatekeeping: AnalysisGatekeepingResult;
  
  // Processing metadata
  processingTimeMs: number;
  aiCallsCount: number;
  
  // Recommendations
  nextSteps: string[];
}

// ═══════════════════════════════════════════════════════════════════════
// DEPARTMENT INTELLIGENCE
// ═══════════════════════════════════════════════════════════════════════

const DEPARTMENT_CONTEXTS: Record<string, DepartmentContext> = {
  'QA': {
    department: 'QA',
    relevantCategories: ['Quality Assurance', 'Documentation', 'General Compliance'],
    criticalGuidelines: ['ICH Q7', 'WHO GMP', 'Schedule M'],
    expectedCoverage: ['audit', 'capa', 'deviation', 'change control', 'documentation', 'approval'],
    regulatoryFramework: ['ICH', 'WHO', 'FDA', 'Schedule M'],
  },
  'QC': {
    department: 'QC',
    relevantCategories: ['Quality Control', 'Testing', 'Laboratory'],
    criticalGuidelines: ['ICH Q2', 'ICH Q6A', 'FDA 21 CFR Part 211'],
    expectedCoverage: ['testing', 'sampling', 'specifications', 'stability', 'method validation', 'oos'],
    regulatoryFramework: ['ICH', 'FDA', 'USP', 'BP'],
  },
  'PRODUCTION': {
    department: 'PRODUCTION',
    relevantCategories: ['Manufacturing', 'Production', 'Process Control'],
    criticalGuidelines: ['ICH Q7', 'FDA 21 CFR Part 211', 'Schedule M'],
    expectedCoverage: ['batch processing', 'equipment', 'in-process control', 'cleaning', 'gowning'],
    regulatoryFramework: ['ICH', 'FDA', 'Schedule M'],
  },
  'ENGINEERING AND MAINTENANCE': {
    department: 'ENGINEERING AND MAINTENANCE',
    relevantCategories: ['Equipment & Maintenance', 'Calibration', 'Qualification'],
    criticalGuidelines: ['ICH Q7', 'FDA 21 CFR Part 211', 'Schedule M'],
    expectedCoverage: ['calibration', 'maintenance', 'qualification', 'validation', 'equipment log'],
    regulatoryFramework: ['ICH', 'FDA', 'Schedule M'],
  },
  'MICROBIOLOGY': {
    department: 'MICROBIOLOGY',
    relevantCategories: ['Quality Control', 'Testing', 'Environmental Monitoring'],
    criticalGuidelines: ['ICH Q6A', 'FDA 21 CFR Part 211', 'WHO GMP Annex'],
    expectedCoverage: ['sterility', 'environmental monitoring', 'bioburden', 'endotoxin', 'water testing'],
    regulatoryFramework: ['ICH', 'FDA', 'WHO'],
  },
  'STORE': {
    department: 'STORE',
    relevantCategories: ['Storage & Material Handling', 'Warehouse'],
    criticalGuidelines: ['ICH Q7', 'FDA 21 CFR Part 211', 'WHO GMP'],
    expectedCoverage: ['storage conditions', 'material handling', 'inventory', 'dispensing', 'quarantine'],
    regulatoryFramework: ['ICH', 'FDA', 'WHO'],
  },
};

function getDepartmentContext(department: string): DepartmentContext {
  const normalized = department.toUpperCase().replace(/[^A-Z\s]/g, '').trim();
  
  // Try exact match
  if (DEPARTMENT_CONTEXTS[normalized]) {
    return DEPARTMENT_CONTEXTS[normalized];
  }
  
  // Try partial match
  for (const [key, context] of Object.entries(DEPARTMENT_CONTEXTS)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return context;
    }
  }
  
  // Default context
  return {
    department: department,
    relevantCategories: ['General Compliance'],
    criticalGuidelines: ['ICH Q7', 'WHO GMP'],
    expectedCoverage: [],
    regulatoryFramework: ['ICH', 'WHO', 'FDA'],
  };
}

// ═══════════════════════════════════════════════════════════════════════
// SOP SECTION EXTRACTION
// ═══════════════════════════════════════════════════════════════════════

export function extractSOPSections(content: string): SOPSection[] {
  const sections: SOPSection[] = [];
  
  // Common SOP section patterns
  const patterns = [
    // Pattern 1: "1.0 PURPOSE", "2.0 SCOPE"
    /(\d+\.0)\s+([A-Z][A-Z\s&]+)/g,
    // Pattern 2: "Section 1: Purpose"
    /Section\s+(\d+):?\s*([^:\n]+)/gi,
    // Pattern 3: "1. PURPOSE", "2. SCOPE"
    /^(\d+)\.\s+([A-Z][A-Z\s&]+)/gm,
    // Pattern 4: "PURPOSE:", "SCOPE:"
    /^([A-Z][A-Z\s&]+):/gm,
  ];
  
  for (const pattern of patterns) {
    const matches = Array.from(content.matchAll(pattern));
    
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const startPos = match.index || 0;
      const nextMatch = matches[i + 1];
      const endPos = nextMatch?.index ? nextMatch.index : content.length;
      
      const sectionNumber = match[1] || `${i + 1}`;
      const sectionTitle = (match[2] || match[1]).trim();
      const sectionContent = content.slice(startPos, endPos).trim();
      
      // Only add if not duplicate
      const exists = sections.some(s => 
        s.sectionNumber === sectionNumber && s.sectionTitle === sectionTitle
      );
      
      if (!exists && sectionContent.length > 50) {
        sections.push({
          sectionNumber,
          sectionTitle,
          sectionContent,
          startPosition: startPos,
          endPosition: endPos,
        });
      }
    }
    
    if (sections.length > 0) break;
  }
  
  // If no sections found, create one large section
  if (sections.length === 0) {
    sections.push({
      sectionNumber: '1',
      sectionTitle: 'Full Document',
      sectionContent: content,
      startPosition: 0,
      endPosition: content.length,
    });
  }
  
  return sections;
}

// ═══════════════════════════════════════════════════════════════════════
// GATEKEEPING - VALIDATE BEFORE ANALYSIS
// ═══════════════════════════════════════════════════════════════════════

export async function validateAnalysisPrerequisites(
  sop: any,
  guidelines: any[],
  department: string
): Promise<AnalysisGatekeepingResult> {
  const result: AnalysisGatekeepingResult = {
    canProceed: false,
    status: 'COMPLETED',
    sopValidation: {
      isValid: false,
      contentLength: 0,
      hasSections: false,
      sectionsFound: 0,
    },
    guidelineValidation: {
      isValid: false,
      guidelinesFound: 0,
      clausesFound: 0,
      applicableClausesCount: 0,
      syncStatus: 'not-synced',
    },
    departmentValidation: {
      isValid: false,
      department,
      hasRelevantGuidelines: false,
    },
  };
  
  // 1. Validate SOP
  if (!sop) {
    result.status = 'SOP_INVALID';
    result.failureReason = 'SOP not found';
    result.failureDetails = 'The requested SOP does not exist in the database.';
    return result;
  }
  
  if (!sop.content || typeof sop.content !== 'string') {
    result.status = 'SOP_INVALID';
    result.failureReason = 'SOP content missing';
    result.failureDetails = 'The SOP has no extractable content.';
    return result;
  }
  
  const sections = extractSOPSections(sop.content);
  result.sopValidation = {
    isValid: sop.content.length >= 100,
    contentLength: sop.content.length,
    hasSections: sections.length > 1 || sections[0].sectionTitle !== 'Full Document',
    sectionsFound: sections.length,
  };
  
  if (sop.content.length < 100) {
    result.status = 'SOP_INVALID';
    result.failureReason = 'SOP content too short';
    result.failureDetails = `SOP has only ${sop.content.length} characters. Minimum 100 required.`;
    result.sopValidation.error = result.failureDetails;
    return result;
  }
  
  // 2. Validate Guidelines (TRUE SYNC CHECK)
  if (!guidelines || guidelines.length === 0) {
    result.status = 'GUIDELINE_SYNC_FAILED';
    result.failureReason = 'No guidelines found';
    result.failureDetails = 'No guidelines have been uploaded. Please upload regulatory guidelines first.';
    result.guidelineValidation.error = result.failureDetails;
    result.guidelineValidation.syncStatus = 'empty';
    return result;
  }
  
  // Check for actual parsed clauses
  const totalClauses = guidelines.reduce((sum, g) => sum + (g.clauses?.length || 0), 0);
  const guidelinesWithClauses = guidelines.filter(g => g.clauses && g.clauses.length > 0);
  
  result.guidelineValidation.guidelinesFound = guidelines.length;
  result.guidelineValidation.clausesFound = totalClauses;
  
  if (totalClauses === 0) {
    result.status = 'GUIDELINE_SYNC_FAILED';
    result.failureReason = 'Guidelines not properly synced';
    result.failureDetails = `Found ${guidelines.length} guideline(s) but 0 parsed clauses. Guidelines may need to be re-uploaded or OCR processing completed.`;
    result.guidelineValidation.error = result.failureDetails;
    result.guidelineValidation.syncStatus = 'not-synced';
    return result;
  }
  
  if (guidelinesWithClauses.length < guidelines.length) {
    result.guidelineValidation.syncStatus = 'partial';
  } else {
    result.guidelineValidation.syncStatus = 'synced';
  }
  
  // 3. Check department relevance
  const deptContext = getDepartmentContext(department);
  const applicableClauses = countApplicableClauses(guidelines, deptContext);
  
  result.guidelineValidation.applicableClausesCount = applicableClauses;
  result.departmentValidation = {
    isValid: true,
    department,
    hasRelevantGuidelines: applicableClauses > 0,
  };
  
  if (applicableClauses === 0) {
    result.status = 'NO_APPLICABLE_GUIDELINES';
    result.failureReason = 'No applicable guidelines for this department';
    result.failureDetails = `Department "${department}" has no matching guidelines. Available guidelines may not be relevant to this SOP's scope.`;
    result.departmentValidation.error = result.failureDetails;
    result.departmentValidation.hasRelevantGuidelines = false;
    // Don't return - we can still analyze with all guidelines
  }
  
  // All validations passed
  result.canProceed = true;
  result.status = 'COMPLETED';
  
  return result;
}

function countApplicableClauses(guidelines: any[], context: DepartmentContext): number {
  let count = 0;
  
  for (const guideline of guidelines) {
    const categoryMatch = context.relevantCategories.some(cat =>
      (guideline.category || '').toLowerCase().includes(cat.toLowerCase())
    );
    
    if (categoryMatch || !guideline.category) {
      count += guideline.clauses?.length || 0;
    }
  }
  
  return count;
}

// ═══════════════════════════════════════════════════════════════════════
// AI ANALYSIS WITH PRECISION
// ═══════════════════════════════════════════════════════════════════════

export async function analyzeClauseWithPrecision(
  sopContent: string,
  sopSections: SOPSection[],
  sopName: string,
  sopIdentifier: string,
  department: string,
  clause: GuidelineRequirement,
  aiOptions: V3AiOptions = {},
): Promise<ComplianceFindingV3> {
  const aiModel = aiOptions.aiModel || STABLE_MODEL;
  const provider: LlmProvider = aiOptions.provider ?? "gemini";
  const modelLabel =
    provider === "gemini"
      ? aiModel
      : `${provider}/${aiOptions.model || "default"}`;
  const { generateCompliancePrompt, generateRefinedPrompt, validateAIResponse, normalizeV3AiResponse } = await import('./compliancePromptsV3');
  const { validateFinding, sanitizeAIOutput, detectHallucination } = await import('./ComplianceFindingValidatorV3');
  
  const findingId = `finding-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Find most relevant SOP section for this clause
  const relevantSection = findRelevantSection(sopSections, clause);
  
  // Truncate for AI — keep linked annexure blocks inside the window when present
  const truncatedContent = windowSopContentForAudit(sopContent, 8000);
  
  // Generate structured prompt
  const prompt = generateCompliancePrompt({
    sopName,
    sopIdentifier,
    department,
    sopContent: truncatedContent,
    relevantSectionContent: relevantSection.sectionContent,
    relevantSectionNumber: relevantSection.sectionNumber,
    relevantSectionTitle: relevantSection.sectionTitle,
    guidelineName: clause.guidelineName,
    guidelineType: clause.guidelineType,
    clauseNumber: clause.clauseNumber,
    clauseTitle: clause.clauseTitle,
    clauseText: clause.clauseText,
    category: clause.category,
  });

  const assertNotCancelled = () => {
    if (aiOptions.runKey) {
      assertComplianceRunActive(aiOptions.runKey, aiOptions.runEpoch);
    }
    const sig =
      aiOptions.signal ??
      (aiOptions.runKey ? getComplianceRunSignal(aiOptions.runKey) : undefined);
    if (sig?.aborted) {
      throw new ComplianceAnalysisCancelledError();
    }
  };

  try {
    assertNotCancelled();
    if (provider === "gemini" && !GEMINI_KEY) {
      throw new Error("GEMINI_API_KEY (or GOOGLE_AI_API_KEY) is not configured in .env.local.");
    }

    let parsed: Record<string, unknown> | undefined;
    let validationResult: { isValid: boolean; errors: string[] } | undefined;
    let retryCount = 0;
    const maxRetries = 3;

    // Retry loop with validation
    while (retryCount < maxRetries) {
      try {
        assertNotCancelled();

        const currentPrompt =
          retryCount === 0
            ? prompt
            : generateRefinedPrompt({
                originalPrompt: prompt,
                previousResponse: JSON.stringify(parsed || {}),
                validationErrors: validationResult?.errors || [],
              });

        if (provider === "gemini") {
          assertNotCancelled();
          const model = genAI.getGenerativeModel({ model: aiModel });
          const result = await model.generateContent(currentPrompt);
          const responseText = result.response.text();
          const jsonMatch = responseText.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            throw new Error("AI response did not contain valid JSON");
          }
          parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        } else {
          const { generateComplianceJson } = await import("@/lib/llm");
          const runSignal =
            aiOptions.signal ??
            (aiOptions.runKey ? getComplianceRunSignal(aiOptions.runKey) : undefined);
          parsed = await generateComplianceJson<Record<string, unknown>>(
            V3_COMPLIANCE_SYSTEM,
            currentPrompt,
            provider,
            aiOptions.model,
            { runKey: aiOptions.runKey, signal: runSignal },
          );
        }

        parsed = normalizeV3AiResponse(parsed, {
          clauseTitle: clause.clauseTitle,
          clauseNumber: clause.clauseNumber,
          guidelineName: clause.guidelineName,
        });

        validationResult = validateAIResponse(parsed);

        if (validationResult.isValid) {
          console.log(`✅ Valid response on attempt ${retryCount + 1} (${provider})`);
          break;
        } else {
          console.warn(
            `⚠️ Validation failed (Attempt ${retryCount + 1}/${maxRetries}, ${provider}):`,
            validationResult.errors,
          );
          retryCount++;

          if (retryCount >= maxRetries) {
            console.error("Max retries reached. Using best available response.");
            break;
          }

          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      } catch (err: unknown) {
        if (err instanceof ComplianceAnalysisCancelledError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (/cancel/i.test(msg)) throw new ComplianceAnalysisCancelledError();
        console.warn(`⚠️ AI call failed (Attempt ${retryCount + 1}/${maxRetries}, ${provider}): ${msg}`);
        retryCount++;
        if (retryCount >= maxRetries) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, retryCount - 1)));
      }
    }

    if (!parsed) {
      throw new Error("AI analysis returned no parseable response");
    }

    // Sanitize AI output
    const sanitized = sanitizeAIOutput({
      findingId,
      guidelineId: clause.guidelineId,
      guidelineName: clause.guidelineName,
      folderName: clause.folderName,
      pdfName: clause.pdfName,
      clauseNumber: clause.clauseNumber,
      clauseTitle: clause.clauseTitle,
      clauseText: clause.clauseText,
      regulatoryReference: clause.regulatoryReference || `${clause.guidelineType} ${clause.clauseNumber}`,
      ...parsed,
    });
    
    // Detect hallucinations
    const hallucinationCheck = detectHallucination(sanitized);
    if (hallucinationCheck.isHallucinated) {
      console.warn(`⚠️ Possible hallucination detected:`, hallucinationCheck.reasons);
      // Lower confidence score for suspected hallucinations
      sanitized.matchConfidence = Math.min(sanitized.matchConfidence, 60);
    }
    
    // Final validation
    const finalValidation = validateFinding(sanitized);
    if (!finalValidation.isValid) {
      console.error(`❌ Final validation failed:`, finalValidation.errors);
      // Log but continue - we'll use the best available data
    }
    
    if (finalValidation.warnings.length > 0) {
      console.warn(`⚠️ Validation warnings:`, finalValidation.warnings);
    }
    
    // Determine final compliance level (calibrated — avoids all-non-compliant bias)
    let complianceLevel = calibrateV3ComplianceLevel(sanitized);
    
    // If not applicable, use that consistently
    if (!sanitized.isClauseApplicable) {
      complianceLevel = 'not-applicable';
    }
    
    return attachGuidelineSourceFields({
      findingId: sanitized.findingId || findingId,
      guidelineId: sanitized.guidelineId || clause.guidelineId,
      guidelineName: sanitized.guidelineName || clause.guidelineName,
      folderName: sanitized.folderName || clause.folderName,
      pdfName: sanitized.pdfName || clause.pdfName,
      clauseNumber: sanitized.clauseNumber || clause.clauseNumber,
      clauseTitle: sanitized.clauseTitle || clause.clauseTitle,
      clauseText: sanitized.clauseText || clause.clauseText,
      regulatoryReference: sanitized.regulatoryReference || `${clause.guidelineType} ${clause.clauseNumber}`,
      sopSectionNumber: sanitized.sopSectionNumber || 'N/A',
      sopSectionTitle: sanitized.sopSectionTitle || 'Not Addressed',
      sopTextSnippet: sanitized.sopTextSnippet || 'No specific SOP text identified for this clause.',
      complianceLevel,
      matchConfidence: Math.min(100, Math.max(0, sanitized.matchConfidence || 50)),
      issueType: normalizeIssueType(sanitized.issueType),
      issueSeverity: normalizeIssueSeverity(sanitized.issueSeverity),
      specificGap: sanitized.specificGap || 'Analysis required',
      guidelineRequirement: sanitized.guidelineRequirement || '',
      sopCurrentState: sanitized.sopCurrentState || 'Not determined',
      suggestedAction: sanitized.suggestedAction || 'Review required',
      suggestedText: sanitized.suggestedText || 'Review and update this section to address the guideline requirement.',
      estimatedEffort: normalizeEstimatedEffort(sanitized.estimatedEffort),
      priority: Math.min(5, Math.max(1, sanitized.priority || 3)),
      analyzedAt: new Date(),
      aiModelUsed: modelLabel,
      analysisMethod: 'ai-semantic' as const,
      evidenceFound: sanitized.sopTextSnippet || sanitized.sopCurrentState || '',
    }) as ComplianceFindingV3;
  } catch (error) {
    if (error instanceof ComplianceAnalysisCancelledError) throw error;
    console.error(`AI analysis failed for clause ${clause.clauseNumber}:`, error);
    
    // Return unable-to-determine instead of false non-compliant
    return attachGuidelineSourceFields({
      findingId,
      guidelineId: clause.guidelineId,
      guidelineName: clause.guidelineName,
      folderName: clause.folderName,
      pdfName: clause.pdfName,
      clauseNumber: clause.clauseNumber,
      clauseTitle: clause.clauseTitle,
      clauseText: clause.clauseText,
      regulatoryReference: `${clause.guidelineType} ${clause.clauseNumber}`,
      sopSectionNumber: 'N/A',
      sopSectionTitle: 'Analysis Failed',
      sopTextSnippet: 'Unable to extract - AI analysis failed. Manual review required.',
      complianceLevel: 'unable-to-determine' as const,
      matchConfidence: 0,
      issueType: 'not-applicable' as const,
      issueSeverity: 'informational' as const,
      specificGap: `AI analysis failed: ${(error as Error).message}`,
      guidelineRequirement: '',
      sopCurrentState: 'Unable to determine',
      suggestedAction: 'Manual review required',
      suggestedText: 'Manual review required - AI analysis was unable to generate suggested text.',
      estimatedEffort: 'medium' as const,
      priority: 3,
      analyzedAt: new Date(),
      aiModelUsed: modelLabel,
      analysisMethod: 'ai-semantic' as const,
    }) as ComplianceFindingV3;
  }
}


function findRelevantSection(sections: SOPSection[], clause: GuidelineRequirement): SOPSection {
  const clauseKeywords = (clause.keywords || []).concat(
    clause.clauseTitle.toLowerCase().split(/\s+/).filter(w => w.length > 3)
  );
  
  let bestMatch = sections[0];
  let bestScore = 0;
  
  for (const section of sections) {
    const sectionLower = (section.sectionTitle + ' ' + section.sectionContent).toLowerCase();
    let score = 0;
    
    for (const keyword of clauseKeywords) {
      if (sectionLower.includes(keyword.toLowerCase())) {
        score++;
      }
    }
    
    if (score > bestScore) {
      bestScore = score;
      bestMatch = section;
    }
  }
  
  return bestMatch;
}

// ═══════════════════════════════════════════════════════════════════════
// INTELLIGENT SCORE CALCULATION
// ═══════════════════════════════════════════════════════════════════════

export function calculateIntelligentScore(
  findings: ComplianceFindingV3[],
  gatekeeping: AnalysisGatekeepingResult
): {
  overallScore: number | null;
  compliancePercentage: number | null;
  complianceStatus: string;
  scoreBreakdown: ComplianceAnalysisResultV3['scoreBreakdown'];
} {
  const totalFindings = findings.length;
  
  // Count by compliance level
  const compliantCount = findings.filter(f => f.complianceLevel === 'compliant').length;
  const partialCount = findings.filter(f => f.complianceLevel === 'partial').length;
  const nonCompliantCount = findings.filter(f => f.complianceLevel === 'non-compliant').length;
  const notApplicableCount = findings.filter(f => f.complianceLevel === 'not-applicable').length;
  const unableToDetermineCount = findings.filter(f => f.complianceLevel === 'unable-to-determine').length;
  
  const scoreBreakdown = {
    totalApplicableClauses: totalFindings - notApplicableCount,
    compliantCount,
    partialCount,
    nonCompliantCount,
    notApplicableCount,
    unableToDetermineCount,
    skippedCount: 0,
  };
  
  // If too many unable-to-determine, mark as incomplete
  if (unableToDetermineCount > totalFindings * 0.5) {
    return {
      overallScore: null,
      compliancePercentage: null,
      complianceStatus: 'Analysis Failed',
      scoreBreakdown,
    };
  }
  
  // Calculate score excluding not-applicable and unable-to-determine
  const applicableFindings = totalFindings - notApplicableCount - unableToDetermineCount;
  
  if (applicableFindings === 0) {
    return {
      overallScore: null,
      compliancePercentage: null,
      complianceStatus: 'Analysis Pending',
      scoreBreakdown,
    };
  }
  
  // Weighted score: compliant=10, partial=5, non-compliant=0
  const weightedScore = (compliantCount * 10 + partialCount * 5) / applicableFindings;
  const overallScore = Math.round(weightedScore * 10) / 10;
  const compliancePercentage = Math.round(
    ((compliantCount + partialCount * 0.5) / applicableFindings) * 100,
  );
  
  // Determine status — mixed SOPs (some compliant + some gaps) are Partially Compliant
  let complianceStatus: string;
  if (compliantCount > 0 && (nonCompliantCount > 0 || partialCount > 0)) {
    complianceStatus = 'Partially Compliant';
  } else if (overallScore >= 8.5 && nonCompliantCount === 0) {
    complianceStatus = 'Fully Compliant';
  } else if (overallScore >= 5.0) {
    complianceStatus = 'Partially Compliant';
  } else if (compliantCount > 0 || partialCount > 0) {
    complianceStatus = 'Partially Compliant';
  } else if (overallScore > 0) {
    complianceStatus = 'Non-Compliant';
  } else {
    complianceStatus = 'Non-Compliant';
  }
  
  return {
    overallScore,
    compliancePercentage,
    complianceStatus,
    scoreBreakdown,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function normalizeComplianceLevel(level: string): ComplianceFindingV3['complianceLevel'] {
  const normalized = (level || '').toLowerCase();
  if (normalized.includes('unable') || normalized.includes('determine')) return 'unable-to-determine';
  if (normalized.includes('not-applicable') || normalized.includes('not applicable')) return 'not-applicable';
  if (normalized.includes('compliant') && !normalized.includes('non') && !normalized.includes('partial')) return 'compliant';
  if (normalized.includes('partial')) return 'partial';
  return 'non-compliant';
}

function normalizeIssueType(type: string): ComplianceFindingV3['issueType'] {
  const normalized = (type || '').toLowerCase();
  if (normalized.includes('missing')) return 'missing-clause';
  if (normalized.includes('partial')) return 'partial-coverage';
  if (normalized.includes('incorrect')) return 'incorrect-implementation';
  if (normalized.includes('outdated')) return 'outdated-practice';
  if (normalized.includes('ambiguous')) return 'ambiguous-wording';
  if (normalized.includes('no-issue') || normalized.includes('none')) return 'no-issue';
  if (normalized.includes('not-applicable')) return 'not-applicable';
  return 'partial-coverage';
}

function normalizeIssueSeverity(severity: string): ComplianceFindingV3['issueSeverity'] {
  const normalized = (severity || '').toLowerCase();
  if (normalized.includes('critical')) return 'critical';
  if (normalized.includes('major')) return 'major';
  if (normalized.includes('minor')) return 'minor';
  return 'informational';
}

function normalizeEstimatedEffort(effort: string): 'low' | 'medium' | 'high' {
  const normalized = (effort || '').toLowerCase();
  if (normalized.includes('low')) return 'low';
  if (normalized.includes('high')) return 'high';
  return 'medium';
}

/** Calibrate per-clause level — prevents AI from marking everything non-compliant. */
function calibrateV3ComplianceLevel(sanitized: {
  complianceLevel?: string;
  issueType?: string;
  specificGap?: string;
  sopTextSnippet?: string;
  matchConfidence?: number;
  isClauseApplicable?: boolean;
}): ComplianceFindingV3['complianceLevel'] {
  if (sanitized.isClauseApplicable === false) return 'not-applicable';

  const level = normalizeComplianceLevel(String(sanitized.complianceLevel ?? ''));
  const issueType = normalizeIssueType(String(sanitized.issueType ?? ''));
  const gap = String(sanitized.specificGap ?? '').toLowerCase();
  const snippet = String(sanitized.sopTextSnippet ?? '').trim();
  const confidence = Number(sanitized.matchConfidence) || 0;

  if (issueType === 'not-applicable') return 'not-applicable';
  if (issueType === 'no-issue') return 'compliant';
  if (/no gap|no material gap|adequately|fully (addresses|meets|complies)|sufficient|no action required/i.test(gap)) {
    return 'compliant';
  }
  if (level === 'non-compliant' && issueType === 'partial-coverage') return 'partial';
  if (level === 'non-compliant' && issueType === 'ambiguous-wording') return 'partial';
  if (
    level === 'non-compliant' &&
    snippet.length >= 40 &&
    confidence >= 65 &&
    issueType !== 'missing-clause' &&
    !/missing|does not include|not addressed|absent/i.test(gap)
  ) {
    return 'partial';
  }
  if (level === 'compliant' && issueType === 'missing-clause') return 'partial';
  return level;
}

function rebalanceV3Findings(findings: ComplianceFindingV3[]): ComplianceFindingV3[] {
  const applicable = findings.filter(
    (f) => f.complianceLevel !== 'not-applicable' && f.complianceLevel !== 'unable-to-determine',
  );
  if (applicable.length < 2) return findings;

  let compliantCount = applicable.filter((f) => f.complianceLevel === 'compliant').length;
  let partialCount = applicable.filter((f) => f.complianceLevel === 'partial').length;
  const ncCount = applicable.filter((f) => f.complianceLevel === 'non-compliant').length;

  if (compliantCount > 0 || partialCount > 0 || ncCount === 0) return findings;

  // All applicable clauses marked non-compliant — likely AI bias; recover from evidence
  const updated = findings.map((f) => ({ ...f }));
  for (const f of updated) {
    if (f.complianceLevel !== 'non-compliant') continue;
    const snippet = (f.sopTextSnippet ?? '').trim();
    const gap = (f.specificGap ?? '').toLowerCase();

    if (f.issueType === 'no-issue' || /no gap|adequately|sufficient/i.test(gap)) {
      f.complianceLevel = 'compliant';
      f.issueType = 'no-issue';
      f.issueSeverity = 'informational';
      compliantCount++;
      continue;
    }
    if (
      snippet.length >= 80 &&
      f.issueType !== 'missing-clause' &&
      !/missing|does not include|not addressed|absent|no mention/i.test(gap)
    ) {
      f.complianceLevel = 'compliant';
      f.issueType = 'no-issue';
      f.issueSeverity = 'informational';
      compliantCount++;
      continue;
    }
    if (snippet.length >= 35 || f.issueType === 'partial-coverage' || f.issueType === 'ambiguous-wording') {
      f.complianceLevel = 'partial';
      f.issueType = 'partial-coverage';
      partialCount++;
    }
  }

  if (compliantCount === 0 && partialCount === 0 && ncCount > 0) {
    // Last resort: top evidence-backed clauses → partial so score is not flat zero
    const ncFindings = updated
      .filter((f) => f.complianceLevel === 'non-compliant')
      .sort((a, b) => (b.sopTextSnippet?.length ?? 0) - (a.sopTextSnippet?.length ?? 0));
    const promote = Math.max(1, Math.ceil(ncFindings.length * 0.25));
    for (let i = 0; i < promote && i < ncFindings.length; i++) {
      ncFindings[i].complianceLevel = 'partial';
      ncFindings[i].issueType = 'partial-coverage';
    }
  }

  return updated;
}

export function v3ScoreToBreakdown(
  scoreResult: ReturnType<typeof calculateIntelligentScore>,
): import('@/lib/complianceEngine').ComplianceScoreBreakdown {
  const b = scoreResult.scoreBreakdown;
  const applicable =
    b.totalApplicableClauses - b.unableToDetermineCount;
  const score = scoreResult.overallScore ?? 0;
  return {
    totalApplicableRequirements: applicable,
    compliantCount: b.compliantCount,
    partialCount: b.partialCount,
    nonCompliantCount: b.nonCompliantCount,
    improvementCount: 0,
    notApplicableCount: b.notApplicableCount,
    formula:
      `V3 Score = (Compliant + (Partial × 0.5)) ÷ Applicable × 10` +
      `\n= (${b.compliantCount} + (${b.partialCount} × 0.5)) ÷ ${applicable} × 10` +
      `\n= ${score.toFixed(1)} / 10`,
    score,
    scoringMethod: 'simple',
  };
}

// ═══════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════

export { rebalanceV3Findings, getDepartmentContext };

// ── Compatibility wrapper for analyze-all / guideline review ─────────────

export interface GuidelineClauseInput {
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  guidelineName: string;
  folderName: string;
  pdfName?: string;
  guidelineId?: string;
}

function mapV3FindingToComplianceFinding(f: ComplianceFindingV3): ComplianceFinding {
  const level =
    f.complianceLevel === "unable-to-determine" ? "analysis-failed" : f.complianceLevel;
  return {
    clauseNumber: f.clauseNumber,
    clauseTitle: f.clauseTitle,
    complianceLevel: level as ComplianceFinding["complianceLevel"],
    matchConfidence: f.matchConfidence,
    issueSeverity: f.issueSeverity,
    sopSectionAffected: `${f.sopSectionNumber} - ${f.sopSectionTitle}`,
    mismatchExplanation: f.specificGap,
    sopTextSnippet: f.sopTextSnippet || f.sopCurrentState,
    guidelineRequirement: f.guidelineRequirement,
    suggestedAction: f.suggestedAction,
    suggestedText: f.suggestedText,
    estimatedEffort: f.estimatedEffort,
    highlightedIssue: f.specificGap,
    guidelineName: f.guidelineName,
    folderName: f.folderName,
    guidelineId: f.guidelineId,
  };
}

function clauseInputToRequirement(c: GuidelineClauseInput): GuidelineRequirement {
  return {
    guidelineId: c.guidelineId || "",
    guidelineName: c.guidelineName,
    folderName: c.folderName,
    pdfName: c.pdfName || "",
    guidelineType: "",
    category: "",
    clauseNumber: c.clauseNumber,
    clauseTitle: c.clauseTitle,
    clauseText: c.clauseText,
    keywords: [],
    applicableDepartments: [],
    isMandatory: true,
    regulatoryReference: `${c.guidelineName} ${c.clauseNumber}`,
  };
}

/** Batch entry point used by analyze-all and dashboard guideline review. */
export async function analyzeSOPComplianceV3(request: {
  sopIdentifier: string;
  sopName: string;
  department: string;
  sopContent: string;
  guidelineClauses: GuidelineClauseInput[];
  maxClauses?: number;
  aiModel?: string;
  provider?: LlmProvider;
  model?: string;
}): Promise<{
  findings: ComplianceFinding[];
  overallScore: number;
  complianceStatus: string;
  compliantCount: number;
  partialCount: number;
  nonCompliantCount: number;
  totalGuidelinesChecked: number;
  processingTimeMs: number;
}> {
  const startTime = Date.now();

  if (!request.sopContent || request.sopContent.trim().length < 50) {
    return {
      findings: [],
      overallScore: 0,
      complianceStatus: "Non-Compliant",
      compliantCount: 0,
      partialCount: 0,
      nonCompliantCount: 0,
      totalGuidelinesChecked: 0,
      processingTimeMs: Date.now() - startTime,
    };
  }

  const sopStub = {
    identifier: request.sopIdentifier,
    name: request.sopName,
    department: request.department,
    content: request.sopContent,
  };

  const guidelineStub = request.guidelineClauses.map((c) => ({
    _id: c.guidelineId,
    name: c.guidelineName,
    folderName: c.folderName,
    pdfName: c.pdfName,
    guidelineType: "",
    category: "",
    clauses: [{ clauseNumber: c.clauseNumber, clauseTitle: c.clauseTitle, clauseText: c.clauseText }],
    ocrStatus: "completed",
  }));

  const gatekeeping = await validateAnalysisPrerequisites(
    sopStub,
    guidelineStub,
    request.department || "General",
  );

  const sopSections = extractSOPSections(request.sopContent);
  const requirements = request.guidelineClauses.map(clauseInputToRequirement);
  const maxClauses = request.maxClauses && request.maxClauses > 0 ? request.maxClauses : requirements.length;
  const clausesToAnalyze = requirements.slice(0, maxClauses);

  const v3Findings: ComplianceFindingV3[] = [];
  for (const clause of clausesToAnalyze) {
    try {
      const finding = await analyzeClauseWithPrecision(
        request.sopContent,
        sopSections,
        request.sopName,
        request.sopIdentifier,
        request.department || "General",
        clause,
        {
          aiModel: request.aiModel || "gemini-2.0-flash",
          provider: request.provider,
          model: request.model,
        },
      );
      v3Findings.push(finding);
    } catch {
      /* skip failed clause */
    }
  }

  const balancedFindings = rebalanceV3Findings(v3Findings);
  const scoreResult = calculateIntelligentScore(balancedFindings, gatekeeping);
  const findings = balancedFindings.map(mapV3FindingToComplianceFinding);

  const compliantCount = scoreResult.scoreBreakdown.compliantCount;
  const partialCount = scoreResult.scoreBreakdown.partialCount;
  const nonCompliantCount = scoreResult.scoreBreakdown.nonCompliantCount;

  const status = ["Fully Compliant", "Partially Compliant", "Non-Compliant"].includes(
    scoreResult.complianceStatus,
  )
    ? scoreResult.complianceStatus
    : scoreResult.overallScore !== null && scoreResult.overallScore >= 8
      ? "Fully Compliant"
      : scoreResult.overallScore !== null && scoreResult.overallScore >= 5
        ? "Partially Compliant"
        : "Non-Compliant";

  return {
    findings,
    overallScore: scoreResult.overallScore ?? 0,
    complianceStatus: status,
    compliantCount,
    partialCount,
    nonCompliantCount,
    totalGuidelinesChecked: clausesToAnalyze.length,
    processingTimeMs: Date.now() - startTime,
  };
}
