'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import FindingCard from './components/FindingCard';
import { GuidelineSelector } from './components/GuidelineSelector';
import { getScoreColorClass } from '@/lib/complianceFormatter';
import { useComplianceRunStore, complianceRunProgressPct } from '@/lib/store/compliance-run-store';
import { BookOpen, FileText, Layers, CheckCircle, Copy, X, Upload, Sparkles, Cpu, Bot, CheckSquare, Square, ScrollText, ArrowLeft, ClipboardList, CheckCircle2, AlertTriangle, XCircle, Minimize2, Maximize2, Loader2, RefreshCw, Trash2, ChevronDown, ChevronUp, ArrowUpDown, FileDown, Paperclip, History } from 'lucide-react';
import {
  annexureStatusBadgeClass,
  annexureStatusLabel,
  annexureStatusShortLabel,
  annexureStatusTitle,
  resolveAnnexureStatus,
} from '@/lib/annexureAuditDisplay';
import dynamic from 'next/dynamic';
import { exportComplianceReportToPdf } from '@/lib/complianceReportPdf';
import { PendingRunRequests } from '@/components/compliance/PendingRunRequests';
import { ComplianceModuleNav } from '@/components/compliance/ComplianceModuleNav';

const FinalSopModal = dynamic(() => import('@/components/compliance/FinalSopModal'), { ssr: false });
const SopSourcePreviewModal = dynamic(() => import('@/components/compliance/SopSourcePreviewModal'), { ssr: false });
const RecheckSopModal = dynamic(() => import('@/components/compliance/RecheckSopModal'), { ssr: false });

interface Guideline {
  _id: string;
  name: string;
  folder: string;
  clauses: { number: string; title: string; text: string }[];
}

interface GuidelineFolder {
  folderName: string;
  guidelineCount: number;
  totalClauses: number;
}

interface SOP {
  _id: string;
  identifier: string;
  name: string;
  department: string;
  version?: string;
  location?: string;
  language?: string;
}

interface ComplianceFinding {
  _id?: string;
  guidelineName: string;
  folderName?: string;
  clauseNumber: string;
  clauseTitle: string;
  clauseText?: string;
  complianceLevel: 'compliant' | 'partial' | 'non-compliant' | 'not-applicable' | 'analysis-failed';
  matchConfidence: number;
  issueSeverity?: 'critical' | 'major' | 'minor' | 'informational';
  sopSectionAffected?: string;
  mismatchExplanation?: string;
  impactAnalysis?: string;
  highlightedIssue?: string;
  sopTextSnippet?: string;
  guidelineRequirement?: string;
  suggestedAction?: string;
  suggestedText?: string;
  reviewStatus?: 'pending' | 'accepted' | 'disputed' | 'implemented';
  findingCategory?: string;
  riskLevel?: string;
  guidelineReference?: string;
  guidelineId?: string;
  evidenceFound?: string;
  evidenceMissing?: string;
  evidenceStrength?: string;
  pageNumber?: string;
  paragraphNumber?: string;
  guidelineLineNumber?: string;
  guidelineSourceLine?: string;
  requiresManualReview?: boolean;
  findingType?: string;
  mergedClauseRefs?: string[];
  applicability?: string;
  requirementCriticality?: string;
  scopeOwner?: string;
  whyApplies?: string;
  whyEvidenceInsufficient?: string;
  whyScoreReduced?: string;
  gapId?: string;
  resolved?: boolean;
  lastReviewedAt?: string;
}

interface TraceabilityMatrixEntry {
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  guidelineName: string;
  folderName: string;
  applicable: boolean;
  complianceStatus: string;
  supportingSopSection: string;
  confidenceScore: number;
}

interface CrossSopDependency {
  referencedType: string;
  referenceText: string;
  found: boolean;
  status: string;
  matchedSopIdentifier?: string;
  matchedSopName?: string;
  riskLevel: string;
  note: string;
}

interface ScoreBreakdown {
  totalApplicableRequirements: number;
  compliantCount: number;
  partialCount: number;
  nonCompliantCount: number;
  improvementCount: number;
  notApplicableCount: number;
  formula: string;
  score: number;
  scoringMethod?: string;
  weightedAchieved?: number;
  weightedTotal?: number;
  criticalRequirementCount?: number;
  majorRequirementCount?: number;
  minorRequirementCount?: number;
}

interface AuditCompleteness {
  totalGuidelinesReviewed: number;
  totalChaptersReviewed: number;
  totalClausesReviewed: number;
  applicableClauses: number;
  notApplicableClauses: number;
  compliantCount: number;
  partialCount: number;
  nonCompliantCount: number;
  criticalFindings: number;
  majorFindings: number;
  minorFindings: number;
  improvementOpportunities: number;
  clauseCoveragePct: number;
  sopCoveragePct: number;
  overallScore: number;
}

interface ComplianceReport {
  _id: string;
  sopId?: string;
  sopIdentifier: string;
  sopName: string;
  department: string;
  overallScore: number;
  complianceStatus: string;
  totalGuidelinesChecked: number;
  compliantCount: number;
  partialCount: number;
  nonCompliantCount: number;
  criticalCount?: number;
  majorCount?: number;
  minorCount?: number;
  improvementCount?: number;
  bestPracticeCount?: number;
  clauseCoveragePct?: number;
  scoreBreakdown?: ScoreBreakdown;
  auditCompleteness?: AuditCompleteness;
  traceabilityMatrix?: TraceabilityMatrixEntry[];
  crossSopDependencies?: CrossSopDependency[];
  /** Engine version that produced this report (e.g. "v3", "v4-batch", "v5"). */
  analysisEngineVersion?: string;
  findings: ComplianceFinding[];
  analyzedAt: string;
  /** True when linked annexure text was included in the guideline audit. */
  annexuresChecked?: boolean;
  annexureStatus?: 'none' | 'checked' | 'not-checked' | 'linked-unread';
  linkedAnnexureCount?: number;
  liveLinkedAnnexureCount?: number;
  annexureChars?: number;
  annexuresIncluded?: { label: string; fileName: string; chars: number }[];
  annexuresSkipped?: { label: string; fileName: string; reason: string }[];
  /** Newest revised-SOP recheck for this report (list/detail enrichment). */
  latestRecheck?: {
    runId: string;
    score: number;
    verdict?: string;
    createdAt?: string;
    annexuresRead: boolean;
    annexureStatusTracked: boolean;
    annexureChars: number;
    annexureLabels: string[];
  } | null;
}

type WorkflowStep = 'fetch-sops' | 'fetch-guidelines' | 'review' | 'analyze' | 'results';

/** Engine version label for a report — legacy reports without the field ran on V3. */
function engineVersionLabel(version?: string): string {
  const raw = (version || 'v3').trim();
  const base = raw.split('-')[0].toUpperCase();
  return base.startsWith('V') ? base : `V${base}`;
}

function shortGuidelineLabel(name: string): string {
  return name.replace(/\s*Guidelines?\s*$/i, '').trim() || name;
}

function ConsolidatedSectionCard({ sec }: {
  sec: {
    sectionKey: string;
    isMulti: boolean;
    findings: ComplianceFinding[];
    sources: string[];
    clauses: string[];
    combinedAction: string;
    combinedSuggestion: string;
  };
}) {
  const [refExpanded, setRefExpanded] = useState(false);
  return (
    <div className={`rounded-2xl border overflow-hidden ${sec.isMulti ? 'border-purple-300 bg-purple-50' : 'border-gray-200 bg-white'}`}>
      <div className={`px-5 py-3 flex items-center justify-between border-b ${sec.isMulti ? 'border-purple-200 bg-purple-100/60' : 'border-gray-100 bg-gray-50'}`}>
        <div className="flex items-center gap-3">
          <div className={`px-3 py-1 rounded-lg text-xs font-black uppercase tracking-wider ${sec.isMulti ? 'bg-purple-200 text-purple-800 border border-purple-300' : 'bg-gray-100 text-gray-600 border border-gray-200'}`}>
            Section {sec.sectionKey}
          </div>
          {sec.isMulti && (
            <span className="text-xs text-purple-600 font-semibold flex items-center gap-1">
              <Layers className="h-3.5 w-3.5" />{sec.findings.length} changes combined
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setRefExpanded(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all border ${refExpanded ? 'bg-blue-100 border-blue-300 text-blue-700' : 'bg-white border-gray-200 text-gray-500 hover:border-blue-300 hover:text-blue-600'}`}
          >
            <BookOpen className="h-3 w-3" />Guideline Refs
            {refExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
          </button>
          <button
            onClick={() => navigator.clipboard.writeText([sec.combinedAction, sec.combinedSuggestion ? `\nPROPOSED VERBIAGE:\n${sec.combinedSuggestion}` : ''].filter(Boolean).join('\n'))}
            className="text-[10px] text-gray-500 hover:text-gray-800 transition-colors flex items-center gap-1"
          >
            <Copy className="h-3 w-3" /> Copy
          </button>
        </div>
      </div>
      {refExpanded && (
        <div className="border-b border-blue-100 bg-blue-50">
          <div className="px-5 py-4 space-y-3">
            <p className="text-[9px] font-black text-blue-600 uppercase tracking-[0.2em]"><BookOpen className="h-3 w-3 inline mr-1" />Guideline Source References</p>
            {sec.findings.map((f, fi) => (
              <div key={fi} className="bg-white border border-blue-100 rounded-xl overflow-hidden">
                <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 flex items-center gap-3 flex-wrap">
                  {fi > 0 && sec.isMulti && (<span className="w-4 h-4 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-[9px] font-black flex-shrink-0">{fi + 1}</span>)}
                  <span className="flex items-center gap-1 px-2 py-0.5 bg-blue-100 border border-blue-200 rounded text-[10px] font-bold text-blue-700"><BookOpen className="h-2.5 w-2.5" />{f.folderName || f.guidelineName || 'Guideline'}</span>
                  {f.clauseNumber && <span className="flex items-center gap-1 px-2 py-0.5 bg-gray-50 border border-gray-200 rounded text-[10px] font-bold text-gray-600 font-mono">Clause {f.clauseNumber}</span>}
                </div>
                <div className="px-4 py-3 space-y-2">
                  {f.clauseTitle && <p className="text-[10px] font-black text-gray-700 uppercase tracking-wider">{f.clauseTitle}</p>}
                  {f.guidelineRequirement && <p className="text-xs text-gray-500 leading-relaxed border-l-2 border-blue-300 pl-3 font-mono">{f.guidelineRequirement}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="p-5 space-y-4">
        <div className="flex flex-wrap gap-2">
          {sec.sources.map(src => (
            <span key={src} className="flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 border border-blue-200 rounded-lg text-[10px] font-bold text-blue-700 uppercase tracking-wider">
              <BookOpen className="h-3 w-3" />{src}
            </span>
          ))}
          {sec.clauses.map(cl => (
            <span key={cl} className="flex items-center gap-1 px-2.5 py-1 bg-gray-100 border border-gray-200 rounded-lg text-[10px] font-bold text-gray-600">
              <FileText className="h-3 w-3" />Clause {cl}
            </span>
          ))}
        </div>
        {sec.isMulti && (
          <div className="space-y-1">
            <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Issues being resolved:</p>
            {sec.findings.map((f, i) => (
              <div key={i} className="flex items-start gap-2 text-xs text-gray-600">
                <span className="mt-0.5 w-4 h-4 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-[9px] font-black flex-shrink-0">{i + 1}</span>
                <span className="leading-relaxed">{f.mismatchExplanation || f.highlightedIssue || 'Gap identified'}</span>
              </div>
            ))}
          </div>
        )}
        <div>
          <p className="text-[10px] text-emerald-600 font-black uppercase tracking-wider mb-2 flex items-center gap-1">
            <CheckCircle className="h-3 w-3" />{sec.isMulti ? 'Consolidated Action' : 'Suggested Action'}
          </p>
          <p className="text-sm text-gray-800 font-medium leading-relaxed whitespace-pre-wrap">{sec.combinedAction}</p>
        </div>
        {sec.combinedSuggestion && (
          <div className="bg-gray-50 rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 bg-gray-100 border-b border-gray-200">
              <span className="text-[9px] text-emerald-700 font-black uppercase tracking-widest">{sec.isMulti ? 'Combined Proposed Verbiage' : 'Proposed Verbiage'}</span>
            </div>
            <div className="p-4"><pre className="text-gray-700 font-mono text-xs whitespace-pre-wrap leading-relaxed">{sec.combinedSuggestion}</pre></div>
          </div>
        )}
      </div>
    </div>
  );
}

function ChevronDownIcon() {
  return <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>;
}
function ChevronUpIcon() {
  return <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>;
}

// Short label for a section-wise sub-heading, e.g. "4.11.4.1 - Sampling procedure..." -> "4.11.4.1".
// Findings with no parseable section number are grouped under "General".
// Prefers § markers so "L042 [§4.2 Title]" → "4.2" (not the line number).
function sectionHeadingLabel(section?: string): string {
  const raw = (section || '').trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === 'not found' || lower === 'n/a' || lower === 'general') return 'General';
  const secMark = raw.match(/§\s*([A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*)/);
  if (secMark?.[1]) return secMark[1];
  const withoutLineRefs = raw.replace(/\bL\d{3,}\b/gi, ' ');
  const m = withoutLineRefs.match(/(\d+(?:\.\d+)*)/);
  return m ? m[1] : raw;
}

// Orders findings by the SOP section they map to (e.g. "4.11.4.1 - Sampling procedure...")
// so the report reads 1, 1.1, 1.2, 2, ... instead of jumping between sections. Findings
// with no parseable section number (e.g. "N/A - Not Addressed") sort to the end.
function compareSectionNumbers(a?: string, b?: string): number {
  const parse = (section?: string): number[] => {
    const id = sectionHeadingLabel(section);
    if (!id || id === 'General') return [];
    if (!/^\d/.test(id)) return [];
    return id.split('.').map((p) => {
      const n = Number(p);
      return Number.isFinite(n) ? n : -1;
    });
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.length === 0 || pb.length === 0) {
    if (pa.length !== pb.length) return pa.length === 0 ? 1 : -1;
    return (a || '').localeCompare(b || '');
  }
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] ?? -1;
    const vb = pb[i] ?? -1;
    if (va !== vb) return va - vb;
  }
  return (a || '').localeCompare(b || '');
}

type FindingsSortKey = 'severity' | 'section' | 'guideline' | 'confidence' | 'clause';
type FindingsGroupView = 'guideline' | 'section';

const FINDINGS_SORT_LABELS: Record<FindingsSortKey, string> = {
  severity: 'Severity',
  section: 'SOP Section',
  guideline: 'Guideline',
  confidence: 'Confidence',
  clause: 'Clause',
};

function findingSeverityRank(f: ComplianceFinding): number {
  const riskOrder: Record<string, number> = { Critical: 0, Major: 1, Minor: 2, Improvement: 3 };
  const levelOrder: Record<string, number> = {
    'non-compliant': 0,
    partial: 1,
    compliant: 2,
    'not-applicable': 3,
    'analysis-failed': 4,
  };
  return f.riskLevel ? (riskOrder[f.riskLevel] ?? 4) : (levelOrder[f.complianceLevel] ?? 5);
}

/** Normalize issueSeverity / riskLevel to a filter key. */
function findingSeverityKey(f: ComplianceFinding): 'critical' | 'major' | 'minor' | null {
  const raw = String(f.issueSeverity || f.riskLevel || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'critical' || raw.startsWith('critical')) return 'critical';
  if (raw === 'major' || raw.startsWith('major')) return 'major';
  if (raw === 'minor' || raw.startsWith('minor')) return 'minor';
  return null;
}

function compareFindings(a: ComplianceFinding, b: ComplianceFinding, key: FindingsSortKey, dir: 'asc' | 'desc'): number {
  const mul = dir === 'asc' ? 1 : -1;
  switch (key) {
    case 'severity': {
      const r = findingSeverityRank(a) - findingSeverityRank(b);
      if (r !== 0) return mul * r;
      return mul * ((b.matchConfidence ?? 0) - (a.matchConfidence ?? 0));
    }
    case 'section':
      return mul * compareSectionNumbers(a.sopSectionAffected, b.sopSectionAffected);
    case 'guideline': {
      const ga = (a.folderName || a.guidelineName || '').toLowerCase();
      const gb = (b.folderName || b.guidelineName || '').toLowerCase();
      const c = ga.localeCompare(gb);
      if (c !== 0) return mul * c;
      return mul * compareSectionNumbers(a.sopSectionAffected, b.sopSectionAffected);
    }
    case 'confidence':
      return mul * ((a.matchConfidence ?? 0) - (b.matchConfidence ?? 0));
    case 'clause': {
      const ca = (a.clauseNumber || '').toLowerCase();
      const cb = (b.clauseNumber || '').toLowerCase();
      return mul * ca.localeCompare(cb, undefined, { numeric: true });
    }
    default:
      return 0;
  }
}

type FindingListItem = { f: ComplianceFinding; i: number };

type FindingDisplayGroup = {
  key: string;
  items: (FindingListItem & { serial: number; subLabel: string; isNewSubGroup: boolean })[];
};

function buildGuidelineGroupedFindings(
  items: FindingListItem[],
  groupOrder: string[],
): FindingDisplayGroup[] {
  const map = new Map<string, FindingListItem[]>();
  for (const item of items) {
    const key = item.f.folderName || item.f.guidelineName || 'Other';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  const orderedKeys = [
    ...groupOrder.filter((k) => map.has(k)),
    ...[...map.keys()].filter((k) => !groupOrder.includes(k)),
  ];
  let serial = 0;
  return orderedKeys.map((key) => {
    const groupItems = [...map.get(key)!].sort((a, b) =>
      compareSectionNumbers(a.f.sopSectionAffected, b.f.sopSectionAffected),
    );
    let lastSubLabel: string | null = null;
    return {
      key,
      items: groupItems.map((item) => {
        const subLabel = sectionHeadingLabel(item.f.sopSectionAffected);
        const isNewSubGroup = subLabel !== lastSubLabel;
        lastSubLabel = subLabel;
        return { ...item, serial: ++serial, subLabel, isNewSubGroup };
      }),
    };
  });
}

function buildSectionGroupedFindings(items: FindingListItem[]): FindingDisplayGroup[] {
  const map = new Map<string, FindingListItem[]>();
  for (const item of items) {
    const key = sectionHeadingLabel(item.f.sopSectionAffected);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(item);
  }
  const orderedKeys = [...map.keys()].sort((a, b) => compareSectionNumbers(a, b));
  let serial = 0;
  return orderedKeys.map((key) => {
    const groupItems = map.get(key)!;
    let lastSubLabel: string | null = null;
    return {
      key,
      items: groupItems.map((item) => {
        const subLabel = item.f.folderName || item.f.guidelineName || 'Other';
        const isNewSubGroup = subLabel !== lastSubLabel;
        lastSubLabel = subLabel;
        return { ...item, serial: ++serial, subLabel, isNewSubGroup };
      }),
    };
  });
}

// ── Audit completeness report — verifies the entire guideline library was reviewed ──
function AuditCompletenessReport({ report }: { report: ComplianceReport }) {
  const ac = report.auditCompleteness;
  if (!ac) return null;

  const coverage = [
    { label: 'Guidelines Reviewed', value: ac.totalGuidelinesReviewed, tone: 'text-indigo-700' },
    { label: 'Chapters Reviewed', value: ac.totalChaptersReviewed, tone: 'text-indigo-700' },
    { label: 'Clauses Reviewed', value: ac.totalClausesReviewed, tone: 'text-indigo-700' },
    { label: 'Applicable Clauses', value: ac.applicableClauses, tone: 'text-blue-700' },
    { label: 'Not Applicable', value: ac.notApplicableClauses, tone: 'text-slate-500' },
  ];
  const outcomes = [
    { label: 'Compliant', value: ac.compliantCount, tone: 'text-emerald-600' },
    { label: 'Partially Compliant', value: ac.partialCount, tone: 'text-amber-600' },
    { label: 'Non-Compliant', value: ac.nonCompliantCount, tone: 'text-rose-600' },
    { label: 'Critical Findings', value: ac.criticalFindings, tone: 'text-red-600' },
    { label: 'Major Findings', value: ac.majorFindings, tone: 'text-orange-600' },
    { label: 'Minor Findings', value: ac.minorFindings, tone: 'text-yellow-600' },
    { label: 'Improvements', value: ac.improvementOpportunities, tone: 'text-sky-600' },
  ];

  return (
    <div className="mb-6 rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white overflow-hidden">
      <div className="px-5 py-3 bg-indigo-100/60 border-b border-indigo-200 flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm font-black text-indigo-800 flex items-center gap-2">
          🛡️ Audit Completeness Report
        </span>
        <span className="text-[11px] font-bold text-indigo-600">
          Full clause-by-clause regulatory audit · {ac.totalClausesReviewed} clauses across {ac.totalGuidelinesReviewed} guidelines
        </span>
      </div>
      <div className="p-5 space-y-5">
        <div>
          <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-2">Guideline Coverage</p>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            {coverage.map(m => (
              <div key={m.label} className="p-3 rounded-xl border border-indigo-100 bg-white text-center">
                <p className={`text-xl font-black leading-none ${m.tone}`}>{m.value}</p>
                <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mt-1.5 leading-tight">{m.label}</p>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="text-[10px] font-black text-indigo-500 uppercase tracking-widest mb-2">Compliance Outcomes</p>
          <div className="grid grid-cols-3 md:grid-cols-7 gap-2">
            {outcomes.map(m => (
              <div key={m.label} className="p-3 rounded-xl border border-gray-200 bg-white text-center">
                <p className={`text-xl font-black leading-none ${m.tone}`}>{m.value}</p>
                <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mt-1.5 leading-tight">{m.label}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="p-4 rounded-xl border border-purple-200 bg-purple-50 text-center">
            <p className="text-2xl font-black text-purple-700 leading-none">{ac.clauseCoveragePct}%</p>
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mt-1.5">Clause Coverage</p>
          </div>
          <div className="p-4 rounded-xl border border-fuchsia-200 bg-fuchsia-50 text-center">
            <p className="text-2xl font-black text-fuchsia-700 leading-none">{ac.sopCoveragePct}%</p>
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mt-1.5">SOP Coverage</p>
          </div>
          <div className={`p-4 rounded-xl border text-center ${
            ac.overallScore >= 8 ? 'border-emerald-200 bg-emerald-50'
              : ac.overallScore >= 5 ? 'border-amber-200 bg-amber-50'
              : 'border-rose-200 bg-rose-50'
          }`}>
            <p className={`text-2xl font-black leading-none ${getScoreColorClass(ac.overallScore)}`}>{ac.overallScore.toFixed(1)}/10</p>
            <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mt-1.5">Overall Compliance Score</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Regulatory dashboard metrics for a single report ──
function ReportMetrics({ report }: { report: ComplianceReport }) {
  const sb = report.scoreBreakdown;
  const applicable = sb?.totalApplicableRequirements ??
    (report.compliantCount + report.partialCount + report.nonCompliantCount);
  const pct = (n: number) => (applicable > 0 ? Math.round((n / applicable) * 100) : 0);
  const metrics = [
    { label: 'Requirements Evaluated', value: sb?.totalApplicableRequirements ?? applicable, tone: 'text-gray-800' },
    { label: 'Clause Coverage', value: `${report.clauseCoveragePct ?? 0}%`, tone: 'text-purple-700' },
    { label: 'Compliance', value: `${pct(report.compliantCount)}%`, tone: 'text-emerald-600' },
    { label: 'Partial', value: `${pct(report.partialCount)}%`, tone: 'text-amber-600' },
    { label: 'Gap', value: `${pct(report.nonCompliantCount)}%`, tone: 'text-rose-600' },
    { label: 'Critical', value: report.criticalCount ?? 0, tone: 'text-red-600' },
    { label: 'Major', value: report.majorCount ?? 0, tone: 'text-orange-600' },
    { label: 'Minor', value: report.minorCount ?? 0, tone: 'text-yellow-600' },
    { label: 'Improvements', value: report.improvementCount ?? report.bestPracticeCount ?? 0, tone: 'text-sky-600' },
  ];
  return (
    <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-9 gap-2 mb-6">
      {metrics.map(m => (
        <div key={m.label} className="p-3 rounded-xl border border-gray-200 bg-gray-50 text-center">
          <p className={`text-lg font-black leading-none ${m.tone}`}>{m.value}</p>
          <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mt-1.5 leading-tight">{m.label}</p>
        </div>
      ))}
    </div>
  );
}

// ── Score transparency panel ──
function ScoreTransparency({ report }: { report: ComplianceReport }) {
  const [open, setOpen] = useState(false);
  const sb = report.scoreBreakdown;
  if (!sb) return null;
  return (
    <div className="mb-6 rounded-xl border border-indigo-200 bg-indigo-50/50 overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full px-5 py-3 flex items-center justify-between text-left"
      >
        <span className="text-sm font-bold text-indigo-800 flex items-center gap-2">
          🧮 Score Transparency — how {sb.score.toFixed(1)}/10 was calculated
          {sb.scoringMethod === 'weighted' && (
            <span className="px-2 py-0.5 bg-indigo-200 text-indigo-800 rounded text-[10px] font-bold uppercase tracking-wider">Weighted</span>
          )}
        </span>
        {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </button>
      {open && (
        <div className="px-5 pb-5 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'Total Applicable', value: sb.totalApplicableRequirements },
              { label: 'Compliant', value: sb.compliantCount },
              { label: 'Partial', value: sb.partialCount },
              { label: 'Non-Compliant', value: sb.nonCompliantCount },
              { label: 'Improvements', value: sb.improvementCount },
            ].map(s => (
              <div key={s.label} className="bg-white rounded-lg border border-indigo-100 p-3 text-center">
                <p className="text-xl font-black text-indigo-700">{s.value}</p>
                <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mt-1">{s.label}</p>
              </div>
            ))}
          </div>
          {sb.scoringMethod === 'weighted' && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              {[
                { label: 'Critical Reqs (×5)', value: sb.criticalRequirementCount ?? 0 },
                { label: 'Major Reqs (×3)', value: sb.majorRequirementCount ?? 0 },
                { label: 'Minor Reqs (×1)', value: sb.minorRequirementCount ?? 0 },
                { label: 'Weight Achieved', value: sb.weightedAchieved ?? 0 },
                { label: 'Weight Total', value: sb.weightedTotal ?? 0 },
              ].map(s => (
                <div key={s.label} className="bg-indigo-50 rounded-lg border border-indigo-100 p-3 text-center">
                  <p className="text-lg font-black text-indigo-700">{s.value}</p>
                  <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider mt-1 leading-tight">{s.label}</p>
                </div>
              ))}
            </div>
          )}
          <pre className="bg-white rounded-lg border border-indigo-100 p-4 text-xs text-gray-700 font-mono whitespace-pre-wrap leading-relaxed">{sb.formula}</pre>
          <p className="text-[11px] text-indigo-600">
            Requirements are weighted by criticality (Critical=5, Major=3, Minor=1). Improvement opportunities
            and best-practice recommendations carry weight 0 — a recommendation never reduces the score, and a
            single minor gap cannot collapse the score of an otherwise compliant SOP.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Clause-by-clause traceability matrix ──
function TraceabilityMatrix({ matrix }: { matrix: TraceabilityMatrixEntry[] }) {
  const [open, setOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  if (!matrix?.length) return null;
  const statusStyle = (s: string) =>
    s === 'Compliant' ? 'bg-emerald-100 text-emerald-700'
      : s === 'Partial' ? 'bg-amber-100 text-amber-700'
      : s === 'Non-Compliant' ? 'bg-rose-100 text-rose-700'
      : s === 'Not Applicable' ? 'bg-slate-100 text-slate-600'
      : 'bg-gray-100 text-gray-500';
  const filtered = matrix.filter(m => statusFilter === 'all' || m.complianceStatus === statusFilter);
  return (
    <div className="mb-6 rounded-xl border border-gray-200 bg-white overflow-hidden">
      <button onClick={() => setOpen(v => !v)} className="w-full px-5 py-3 flex items-center justify-between text-left bg-gray-50 border-b border-gray-100">
        <span className="text-sm font-bold text-gray-800 flex items-center gap-2">
          🔗 Compliance Traceability Matrix — {matrix.length} clauses reviewed
        </span>
        {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </button>
      {open && (
        <div className="p-4">
          <div className="flex flex-wrap gap-2 mb-3">
            {['all', 'Compliant', 'Partial', 'Non-Compliant', 'Not Applicable', 'Not Analyzed'].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition-all ${statusFilter === s ? 'bg-purple-600 text-white border-purple-500' : 'bg-white text-gray-500 border-gray-200 hover:border-purple-300'}`}
              >
                {s === 'all' ? 'All' : s}
              </button>
            ))}
          </div>
          <div className="max-h-[420px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-white">
                <tr className="text-[10px] font-black text-gray-400 uppercase tracking-wider border-b border-gray-200">
                  <th className="py-2 pr-3">Clause</th>
                  <th className="py-2 pr-3">Title / Guideline</th>
                  <th className="py-2 pr-3">Applicable</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 pr-3">SOP Section</th>
                  <th className="py-2">Confidence</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m, i) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50 align-top">
                    <td className="py-2 pr-3 font-mono font-bold text-purple-700 text-xs whitespace-nowrap">{m.clauseNumber}</td>
                    <td className="py-2 pr-3 text-xs text-gray-700 max-w-[280px]">
                      <span className="font-semibold">{m.clauseTitle}</span>
                      <span className="block text-[10px] text-gray-400">{m.folderName || m.guidelineName}</span>
                    </td>
                    <td className="py-2 pr-3 text-xs">{m.applicable ? 'Yes' : 'No'}</td>
                    <td className="py-2 pr-3"><span className={`px-2 py-0.5 rounded text-[10px] font-bold ${statusStyle(m.complianceStatus)}`}>{m.complianceStatus}</span></td>
                    <td className="py-2 pr-3 text-[11px] text-gray-500 font-mono max-w-[160px] truncate" title={m.supportingSopSection}>{m.supportingSopSection || '—'}</td>
                    <td className="py-2 text-xs font-bold text-gray-600">{m.confidenceScore}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cross-SOP dependency validation ──
function CrossSopPanel({ deps }: { deps: CrossSopDependency[] }) {
  if (!deps?.length) return null;
  const statusStyle = (s: string) =>
    s === 'available' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : s === 'missing' ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <div className="mb-6 rounded-xl border border-fuchsia-200 bg-fuchsia-50/40 overflow-hidden">
      <div className="px-5 py-3 bg-fuchsia-100/50 border-b border-fuchsia-200">
        <span className="text-sm font-bold text-fuchsia-800">🧩 Cross-SOP Dependencies — {deps.length} referenced</span>
      </div>
      <div className="p-4 space-y-2">
        {deps.map((d, i) => (
          <div key={i} className="flex items-start justify-between gap-3 bg-white rounded-lg border border-fuchsia-100 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-bold text-gray-800">{d.referencedType}</p>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{d.note}</p>
              {d.matchedSopIdentifier && (
                <p className="text-[10px] text-fuchsia-600 font-mono mt-1">→ {d.matchedSopIdentifier}</p>
              )}
            </div>
            <span className={`flex-shrink-0 px-2.5 py-1 rounded-lg border text-[10px] font-bold capitalize ${statusStyle(d.status)}`}>{d.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ComplianceEnginePage() {
  const router = useRouter();

  const [currentStep, setCurrentStep] = useState<WorkflowStep>('fetch-sops');
  const [folders, setFolders] = useState<GuidelineFolder[]>([]);
  const [guidelines, setGuidelines] = useState<Guideline[]>([]);
  const [guidelineStats, setGuidelineStats] = useState<Record<string, {
    totalFindings: number; compliantCount: number; partialCount: number; nonCompliantCount: number; sopCount: number
  }>>({});
  const [sops, setSops] = useState<SOP[]>([]);
  const [sopTotal, setSopTotal] = useState(0);
  const [departments, setDepartments] = useState<string[]>([]);
  const [reports, setReports] = useState<ComplianceReport[]>([]);

  const [loadingSops, setLoadingSops] = useState(false);
  const [loadingGuidelines, setLoadingGuidelines] = useState(false);
  const [loadingReports, setLoadingReports] = useState(false);

  const {
    isAnalyzing,
    isPaused,
    analysisComplete,
    analysisStats,
    sopLists,
    startRun,
    stopRun,
    togglePause,
    runGeneration,
  } = useComplianceRunStore();

  const [activeChip, setActiveChip] = useState<'completed' | 'cached' | 'failed' | null>(null);

  const [preflightData, setPreflightData] = useState({ checked: false, existingCount: 0, newCount: 0 });
  const [selectedReport, setSelectedReport] = useState<ComplianceReport | null>(null);
  const [loadingFullReport, setLoadingFullReport] = useState(false);
  const [fullReportLoadError, setFullReportLoadError] = useState<string | null>(null);
  const [filterDepartment, setFilterDepartment] = useState('all');
  const [sopSortKey, setSopSortKey] = useState<'identifier' | 'version' | 'name' | 'location' | 'department'>('identifier');
  const [sopSortDir, setSopSortDir] = useState<'asc' | 'desc'>('asc');
  const [reportSortKey, setReportSortKey] = useState<'sopIdentifier' | 'sopName' | 'department' | 'overallScore' | 'complianceStatus' | 'analyzedAt'>('analyzedAt');
  const [reportSortDir, setReportSortDir] = useState<'asc' | 'desc'>('desc');
  const [reportFilterDepartment, setReportFilterDepartment] = useState('all');
  const [reportFilterAnnexures, setReportFilterAnnexures] = useState<
    'all' | 'checked' | 'none' | 'not-checked' | 'linked-unread'
  >('all');
  const [filterStatus, setFilterStatus] = useState<'all' | 'compliant' | 'partial' | 'non-compliant' | 'not-applicable'>('all');
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'critical' | 'major' | 'minor'>('all');
  const [hideNotApplicable, setHideNotApplicable] = useState(true);
  const [hideFailedFindings, setHideFailedFindings] = useState(true);
  const [filterGuideline, setFilterGuideline] = useState('all');
  const [selectedSopIds, setSelectedSopIds] = useState<Set<string>>(new Set());
  const [selectedGuidelineIds, setSelectedGuidelineIds] = useState<Set<string>>(new Set());

  const [selectedFindingIds, setSelectedFindingIds] = useState<Set<number>>(new Set());
  const [showConsolidatedSummary, setShowConsolidatedSummary] = useState(false);
  const [finalSopOpen, setFinalSopOpen] = useState(false);
  const [recheckOpen, setRecheckOpen] = useState(false);
  const [recheckInitialView, setRecheckInitialView] = useState<'run' | 'history'>('run');
  const [recheckTarget, setRecheckTarget] = useState<{
    _id: string;
    sopIdentifier: string;
    sopName: string;
  } | null>(null);
  const [sopPreviewOpen, setSopPreviewOpen] = useState(false);
  const [rerunningCompliance, setRerunningCompliance] = useState(false);
  const [isSummaryFullScreen, setIsSummaryFullScreen] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [hoveredFolder, setHoveredFolder] = useState<string | null>(null);
  const [activeFolder, setActiveFolder] = useState<string | null>(null);
  const [collapsedFindingGroups, setCollapsedFindingGroups] = useState<Set<string>>(new Set());
  const [findingsGroupView, setFindingsGroupView] = useState<FindingsGroupView>('guideline');
  const [findingsSortKey, setFindingsSortKey] = useState<FindingsSortKey>('section');
  const [findingsSortDir, setFindingsSortDir] = useState<'asc' | 'desc'>('asc');
  const [findingsSortOpen, setFindingsSortOpen] = useState(false);
  const findingsSortRef = useRef<HTMLDivElement | null>(null);
  const groupRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const findingsScrollRef = useRef<HTMLDivElement | null>(null);
  const reportExportRef = useRef<HTMLDivElement | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [applyingFixGapId, setApplyingFixGapId] = useState<string | null>(null);
  const [forceFullReanalysis, setForceFullReanalysis] = useState(false);
  const [llmInfo, setLlmInfo] = useState<{
    provider: 'gemini' | 'ollama' | 'claude' | 'codex';
    model: string;
    complianceModel: string;
    label: string;
  } | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<'claude' | 'codex' | 'gemini' | 'ollama' | null>('codex');
  const [selectedModel, setSelectedModel] = useState('claude-sonnet-4-6');
  const [claudeStatus, setClaudeStatus] = useState<{
    ok: boolean;
    model?: string;
    email?: string;
    subscriptionType?: string;
    error?: string;
    loading?: boolean;
  } | null>(null);
  const [codexStatus, setCodexStatus] = useState<{
    ok: boolean;
    model?: string;
    mcqModel?: string;
    complianceModel?: string;
    authMode?: string;
    codexVersion?: string;
    error?: string;
    loading?: boolean;
  } | null>(null);

  // Upload guidelines modal state
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [uploadFolder, setUploadFolder] = useState('');
  const [uploadFiles, setUploadFiles] = useState<FileList | null>(null);
  // When folder upload detects subfolders, store grouped structure
  const [uploadGroups, setUploadGroups] = useState<{ folder: string; files: File[] }[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; currentFolder: string }>({ current: 0, total: 0, currentFolder: '' });
  const [uploadResults, setUploadResults] = useState<{ name: string; clauses: number; status: string; error?: string; folder?: string }[] | null>(null);

  const fetchSops = async () => {
    setLoadingSops(true);
    try {
      const res = await fetch('/api/compliance/sops');
      const data = await res.json();
      if (data.success) {
        const loaded: SOP[] = data.sops ?? [];
        setSops(loaded);
        setSopTotal(data.total ?? loaded.length ?? 0);
        setDepartments(data.departments ?? []);
        // Keep existing selection on refresh; do not auto-select the entire library.
        setSelectedSopIds((prev) => {
          if (prev.size === 0) return prev;
          const valid = new Set(loaded.map((s) => s._id));
          return new Set([...prev].filter((id) => valid.has(id)));
        });
      }
    } catch { /* silent */ } finally { setLoadingSops(false); }
  };

  const fetchGuidelines = async () => {
    setLoadingGuidelines(true);
    try {
      const res = await fetch('/api/guidelines');
      const data = await res.json();
      if (data.guidelines) {
        const normalized = (data.guidelines as Guideline[]).map((g) => ({
          ...g,
          _id: String(g._id),
        }));
        setGuidelines(normalized);
        const folderMap: Record<string, GuidelineFolder> = {};
        for (const g of normalized) {
          if (!folderMap[g.folder]) folderMap[g.folder] = { folderName: g.folder, guidelineCount: 0, totalClauses: 0 };
          folderMap[g.folder].guidelineCount++;
          folderMap[g.folder].totalClauses += g.clauses?.length ?? 0;
        }
        setFolders(Object.values(folderMap));
        setSelectedGuidelineIds((prev) => {
          if (prev.size === 0 && normalized.length) {
            return new Set(normalized.map((g) => g._id));
          }
          return prev;
        });
      }
    } catch { /* silent */ } finally { setLoadingGuidelines(false); }
  };

  const handleDeleteGuideline = async (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm(`Delete guideline "${name}"?`)) return;
    try {
      const res = await fetch(`/api/guidelines/upload?id=${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        setGuidelines(prev => prev.filter(g => g._id !== id));
        setSelectedGuidelineIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } else {
        alert(data.error ?? 'Delete failed');
      }
    } catch { alert('Delete request failed'); }
  };

  const fetchReports = async () => {
    setLoadingReports(true);
    try {
      const res = await fetch('/api/compliance/analyze');
      const data = await res.json();
      if (data.success) setReports(data.reports ?? []);
    } catch { /* silent */ } finally { setLoadingReports(false); }
  };

  const runPreflightCheck = useCallback(async () => {
    const target = sops.filter((s) => selectedSopIds.has(s._id));
    if (!target.length) return;
    try {
      const res = await fetch('/api/compliance/check-existing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sopIds: target.map(s => s._id) }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const existingCount = target.filter(s => data.results?.[s._id]?.hasReport).length;
      setPreflightData({ checked: true, existingCount, newCount: target.length - existingCount });
    } catch {
      setPreflightData({ checked: false, existingCount: 0, newCount: 0 });
    }
  }, [sops, selectedSopIds]);

  useEffect(() => { if (currentStep === 'review') runPreflightCheck(); }, [currentStep, selectedSopIds, runPreflightCheck]);

  const runAnalysis = async () => {
    const candidates = sops.filter((s) => selectedSopIds.has(s._id));
    if (!candidates.length || selectedGuidelineIds.size === 0) return;
    setCurrentStep('analyze');
    setActiveChip(null);
    const selectedList = guidelines.filter((g) => selectedGuidelineIds.has(g._id));
    const guidelineLabel =
      selectedList.length === 1
        ? selectedList[0].name
        : `${selectedList.length} guidelines`;
    await startRun({
      candidates,
      guidelineIds: [...selectedGuidelineIds],
      guidelineLabel,
      forceRefresh: forceFullReanalysis,
      provider: selectedProvider,
      model:
        selectedProvider === 'claude'
          ? selectedModel
          : selectedProvider === 'codex'
            ? codexStatus?.complianceModel ?? 'gpt-5.4-mini'
            : undefined,
    });
  };

  const lastRunGenerationRef = useRef(0);
  useEffect(() => {
    if (runGeneration === 0 || runGeneration === lastRunGenerationRef.current) return;
    lastRunGenerationRef.current = runGeneration;

    void (async () => {
      const state = useComplianceRunStore.getState();
      await fetchReports();
      fetch('/api/compliance/guideline-stats')
        .then((r) => r.json())
        .then((d) => {
          if (d.success) setGuidelineStats(d.stats ?? {});
        })
        .catch(() => {});

      if (
        !state.wasStopped &&
        state.lastAnalyzedSopId &&
        state.analysisStats.total === 1
      ) {
        try {
          const listRes = await fetch('/api/compliance/analyze');
          const listData = await listRes.json();
          const candidate = sops.find((s) => s._id === state.lastAnalyzedSopId);
          const report = (listData.reports ?? []).find(
            (r: ComplianceReport) => r.sopIdentifier === candidate?.identifier,
          );
          if (report) {
            setCurrentStep('results');
            await handleSelectReport(report);
          }
        } catch {
          /* silent */
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to runGeneration only
  }, [runGeneration, sops]);

  const handleGuidelineUpload = async () => {
    // Bulk folder mode: one request per subfolder group
    if (uploadGroups?.length) {
      setUploading(true);
      setUploadResults(null);
      setUploadProgress({ current: 0, total: uploadGroups.length, currentFolder: '' });
      const allResults: { name: string; clauses: number; status: string; error?: string; folder?: string }[] = [];
      for (let i = 0; i < uploadGroups.length; i++) {
        const group = uploadGroups[i];
        setUploadProgress({ current: i + 1, total: uploadGroups.length, currentFolder: group.folder });
        try {
          const form = new FormData();
          form.append('folder', group.folder);
          for (const file of group.files) form.append('files', file);
          const res = await fetch('/api/guidelines/upload', { method: 'POST', body: form });
          const data = await res.json().catch(() => ({ success: false, error: `Server error (${res.status})` }));
          if (!data.results && !data.success) {
            allResults.push({ name: group.folder, clauses: 0, status: 'failed', error: data.error ?? `HTTP ${res.status}`, folder: group.folder });
          } else {
            for (const r of data.results ?? []) allResults.push({ ...r, folder: group.folder });
          }
        } catch (err) {
          allResults.push({ name: group.folder, clauses: 0, status: 'failed', error: err instanceof Error ? err.message : 'Upload failed', folder: group.folder });
        }
      }
      setUploadResults(allResults);
      if (allResults.some(r => r.status !== 'failed')) fetchGuidelines();
      setUploading(false);
      return;
    }

    // Single folder mode
    if (!uploadFolder.trim() || !uploadFiles?.length) return;
    setUploading(true);
    setUploadResults(null);
    try {
      const form = new FormData();
      form.append('folder', uploadFolder.trim());
      for (const file of Array.from(uploadFiles)) form.append('files', file);
      const res = await fetch('/api/guidelines/upload', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({ success: false, error: `Server error (${res.status})` }));
      if (!data.results && !data.success) {
        setUploadResults([{ name: 'Server Error', clauses: 0, status: 'failed', error: data.error ?? `HTTP ${res.status}` }]);
      } else {
        setUploadResults(data.results ?? []);
        if (data.success) fetchGuidelines();
      }
    } catch (err) {
      setUploadResults([{ name: 'Error', clauses: 0, status: 'failed', error: err instanceof Error ? err.message : 'Upload request failed' }]);
    } finally { setUploading(false); }
  };

  useEffect(() => {
    fetchSops();
    fetchGuidelines();
    fetchReports();
    fetch('/api/compliance/config')
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.llm) setLlmInfo(d.llm);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedProvider !== 'claude') {
      setClaudeStatus(null);
      return;
    }
    let cancelled = false;
    setClaudeStatus({ ok: false, loading: true });
    fetch('/api/llm/claude-status')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const c = data.claude ?? {};
        setClaudeStatus({
          ok: Boolean(data.success && c.loggedIn),
          model: c.model,
          email: c.email,
          subscriptionType: c.subscriptionType,
          error: c.error,
          loading: false,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setClaudeStatus({
          ok: false,
          error: e instanceof Error ? e.message : 'Could not check Claude status',
          loading: false,
        });
      });
    return () => { cancelled = true; };
  }, [selectedProvider]);

  useEffect(() => {
    if (selectedProvider !== 'codex') {
      setCodexStatus(null);
      return;
    }
    let cancelled = false;
    setCodexStatus({ ok: false, loading: true });
    fetch('/api/llm/codex-status')
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const c = data.codex ?? {};
        setCodexStatus({
          ok: Boolean(data.success && c.loggedIn),
          model: c.model,
          mcqModel: c.mcqModel,
          complianceModel: c.complianceModel,
          authMode: c.authMode,
          codexVersion: c.codexVersion,
          error: c.error,
          loading: false,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setCodexStatus({
          ok: false,
          error: e instanceof Error ? e.message : 'Could not check Codex status',
          loading: false,
        });
      });
    return () => { cancelled = true; };
  }, [selectedProvider]);

  const totalClauses = guidelines.reduce((s, g) => s + (g.clauses?.length ?? 0), 0);
  const selectedGuidelineCount = selectedGuidelineIds.size;
  const selectedGuidelines = useMemo(
    () => guidelines.filter((g) => selectedGuidelineIds.has(g._id)),
    [guidelines, selectedGuidelineIds],
  );
  const selectedGuidelineClauseCount = useMemo(
    () => selectedGuidelines.reduce((sum, g) => sum + (g.clauses?.length ?? 0), 0),
    [selectedGuidelines],
  );
  const selectedSopCount = selectedSopIds.size;
  const selectedSops = useMemo(
    () => sops.filter((s) => selectedSopIds.has(s._id)),
    [sops, selectedSopIds],
  );
  const selectedDepartmentCount = useMemo(() => {
    const depts = new Set(selectedSops.map((s) => s.department).filter(Boolean));
    return depts.size;
  }, [selectedSops]);

  const filteredSops = useMemo(
    () => sops.filter((s) => filterDepartment === 'all' || s.department === filterDepartment),
    [sops, filterDepartment],
  );

  const sortedSops = useMemo(() => {
    const dir = sopSortDir === 'asc' ? 1 : -1;
    const norm = (v?: string) => (v ?? '').trim().toLowerCase();
    const versionNum = (v?: string) => {
      const n = parseFloat(String(v ?? '').replace(/^v/i, ''));
      return Number.isFinite(n) ? n : 0;
    };
    return [...filteredSops].sort((a, b) => {
      switch (sopSortKey) {
        case 'identifier':
          return dir * norm(a.identifier).localeCompare(norm(b.identifier));
        case 'version':
          return dir * (versionNum(a.version) - versionNum(b.version)) ||
            dir * norm(a.version).localeCompare(norm(b.version));
        case 'name':
          return dir * norm(a.name).localeCompare(norm(b.name));
        case 'location':
          return dir * norm(a.location).localeCompare(norm(b.location));
        case 'department':
          return dir * norm(a.department).localeCompare(norm(b.department));
        default:
          return 0;
      }
    });
  }, [filteredSops, sopSortKey, sopSortDir]);

  const reportDepartments = useMemo(() => {
    const depts = new Set<string>();
    for (const r of reports ?? []) {
      const d = r.department?.trim();
      if (d) depts.add(d);
    }
    return [...depts].sort((a, b) => a.localeCompare(b));
  }, [reports]);

  const filteredReports = useMemo(() => {
    let list = reports ?? [];
    if (reportFilterDepartment !== 'all') {
      list = list.filter((r) => r.department === reportFilterDepartment);
    }
    if (reportFilterAnnexures !== 'all') {
      list = list.filter((r) => resolveAnnexureStatus(r) === reportFilterAnnexures);
    }
    return list;
  }, [reports, reportFilterDepartment, reportFilterAnnexures]);

  const sortedReports = useMemo(() => {
    const dir = reportSortDir === 'asc' ? 1 : -1;
    const norm = (v?: string) => (v ?? '').trim().toLowerCase();
    const statusRank = (status: string) => {
      switch (status) {
        case 'Fully Compliant': return 4;
        case 'Partially Compliant': return 3;
        case 'Non-Compliant': return 2;
        case 'Analysis Incomplete': return 1;
        default: return 0;
      }
    };
    return [...filteredReports].sort((a, b) => {
      switch (reportSortKey) {
        case 'sopIdentifier':
          return dir * norm(a.sopIdentifier).localeCompare(norm(b.sopIdentifier));
        case 'sopName':
          return dir * norm(a.sopName).localeCompare(norm(b.sopName));
        case 'department':
          return dir * norm(a.department).localeCompare(norm(b.department));
        case 'overallScore':
          return dir * (a.overallScore - b.overallScore);
        case 'complianceStatus':
          return dir * (statusRank(a.complianceStatus) - statusRank(b.complianceStatus)) ||
            dir * norm(a.complianceStatus).localeCompare(norm(b.complianceStatus));
        case 'analyzedAt':
          return dir * (new Date(a.analyzedAt).getTime() - new Date(b.analyzedAt).getTime());
        default:
          return 0;
      }
    });
  }, [filteredReports, reportSortKey, reportSortDir]);

  const toggleFindingGroup = (groupKey: string) => {
    setCollapsedFindingGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  // Export the full on-screen report (header + every finding) via print →
  // Save as PDF so the file matches the Compliance Result UI with selectable text.
  const handleExportPdf = async () => {
    if (!reportExportRef.current || !selectedReport || exportingPdf) return;
    setExportingPdf(true);
    const prevCollapsed = collapsedFindingGroups;
    if (prevCollapsed.size > 0) setCollapsedFindingGroups(new Set());
    // Wait for the group-expansion re-render to flush to the DOM.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const safeName = `${selectedReport.sopIdentifier || 'compliance'}-report`
        .replace(/[^\w.-]+/g, '_');
      await exportComplianceReportToPdf({
        element: reportExportRef.current,
        fileName: `${safeName}.pdf`,
        unclip: [findingsScrollRef.current],
      });
    } catch (err) {
      console.error('Compliance PDF export failed', err);
      alert('Could not open the print dialog. Please try again, then choose “Save as PDF”.');
    } finally {
      if (prevCollapsed.size > 0) setCollapsedFindingGroups(prevCollapsed);
      setExportingPdf(false);
    }
  };

  const scrollToFindingSubGroup = useCallback((groupKey: string, subLabel: string) => {
    setCollapsedFindingGroups((prev) => {
      if (!prev.has(groupKey)) return prev;
      const next = new Set(prev);
      next.delete(groupKey);
      return next;
    });
    const key = `${groupKey}::${subLabel}`;
    const scroll = () => {
      const el = sectionRefs.current[key];
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el.classList.add('ring-2', 'ring-purple-400', 'ring-offset-1', 'rounded');
      window.setTimeout(() => {
        el.classList.remove('ring-2', 'ring-purple-400', 'ring-offset-1', 'rounded');
      }, 1600);
    };
    window.setTimeout(scroll, 80);
  }, []);

  const toggleFindingsSort = (key: FindingsSortKey) => {
    if (findingsSortKey === key) {
      setFindingsSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setFindingsSortKey(key);
      setFindingsSortDir(key === 'confidence' ? 'desc' : 'asc');
    }
    setFindingsSortOpen(false);
  };

  const toggleSopSort = (key: typeof sopSortKey) => {
    if (sopSortKey === key) setSopSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSopSortKey(key);
      setSopSortDir('asc');
    }
  };

  const toggleReportSort = (key: typeof reportSortKey) => {
    if (reportSortKey === key) setReportSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setReportSortKey(key);
      setReportSortDir(key === 'analyzedAt' || key === 'overallScore' ? 'desc' : 'asc');
    }
  };

  const toggleSopSelection = (id: string) => {
    setSelectedSopIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setPreflightData({ checked: false, existingCount: 0, newCount: 0 });
  };

  const selectOnlySop = (id: string) => {
    setSelectedSopIds(new Set([id]));
    setPreflightData({ checked: false, existingCount: 0, newCount: 0 });
  };

  const urlHandledRef = useRef(false);
  useEffect(() => {
    if (urlHandledRef.current || sops.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const sopId = params.get('sopId');
    const requestId = params.get('requestId');
    if (!sopId && !requestId) return;
    urlHandledRef.current = true;
    if (sopId && sops.some((s) => s._id === sopId)) {
      selectOnlySop(sopId);
      const match = sops.find((s) => s._id === sopId);
      if (match?.department) setFilterDepartment(match.department);
    }
    if (requestId) {
      void fetch(`/api/compliance/run-requests/${requestId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge' }),
      });
    }
  }, [sops]);

  const setAllVisibleSopsSelected = (selected: boolean) => {
    setSelectedSopIds((prev) => {
      const next = new Set(prev);
      for (const sop of filteredSops) {
        if (selected) next.add(sop._id);
        else next.delete(sop._id);
      }
      return next;
    });
    setPreflightData({ checked: false, existingCount: 0, newCount: 0 });
  };

  const handleGuidelineSelectionChange = (ids: Set<string>) => {
    setSelectedGuidelineIds(ids);
    setPreflightData({ checked: false, existingCount: 0, newCount: 0 });
  };
  const allVisibleSopsSelected =
    filteredSops.length > 0 && filteredSops.every((s) => selectedSopIds.has(s._id));
  const someVisibleSopsSelected =
    filteredSops.some((s) => selectedSopIds.has(s._id)) && !allVisibleSopsSelected;

  const SopSortHeader = ({
    label,
    sortKey,
    className = '',
  }: {
    label: string;
    sortKey: typeof sopSortKey;
    className?: string;
  }) => {
    const active = sopSortKey === sortKey;
    return (
      <th className={`px-4 py-3 text-left ${className}`}>
        <button
          type="button"
          onClick={() => toggleSopSort(sortKey)}
          className={`inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider transition-colors ${
            active ? 'text-purple-700' : 'text-gray-500 hover:text-purple-600'
          }`}
        >
          {label}
          <span className={`text-[10px] ${active ? 'text-purple-600' : 'text-gray-300'}`}>
            {active ? (sopSortDir === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  };

  const ReportSortHeader = ({
    label,
    sortKey,
    className = '',
  }: {
    label: string;
    sortKey: typeof reportSortKey;
    className?: string;
  }) => {
    const active = reportSortKey === sortKey;
    return (
      <th className={`px-3 py-2 text-left ${className}`}>
        <button
          type="button"
          onClick={() => toggleReportSort(sortKey)}
          className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider transition-colors ${
            active ? 'text-purple-700' : 'text-gray-500 hover:text-purple-600'
          }`}
        >
          {label}
          <span className={`text-[10px] ${active ? 'text-purple-600' : 'text-gray-300'}`}>
            {active ? (reportSortDir === 'asc' ? '▲' : '▼') : '↕'}
          </span>
        </button>
      </th>
    );
  };

  const getStepStyle = (id: string) => {
    const isActive = currentStep === id;
    return `flex-1 flex items-center justify-center gap-2 py-3 px-4 rounded-xl transition-all border cursor-pointer ${isActive ? 'bg-purple-600 text-white shadow-lg border-purple-500' : 'bg-white text-gray-500 border-gray-200 hover:bg-purple-50 hover:border-purple-200'}`;
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Fully Compliant': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      case 'Partially Compliant': return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'Non-Compliant': return 'bg-rose-100 text-rose-700 border-rose-200';
      case 'Analysis Incomplete': return 'bg-sky-100 text-sky-800 border-sky-200';
      default: return 'bg-gray-100 text-gray-600 border-gray-200';
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 9) return 'text-emerald-600';
    if (score >= 6) return 'text-amber-600';
    return 'text-rose-600';
  };

  const handleToggleApplicable = (findingId: string, isChecked: boolean) => {
    // Marking a finding "Applicable" accepts its fix — which adds its point to
    // the Final SOP changed doc — and opens the Final SOP preview. Unchecking
    // removes the point from the changed doc.
    void handleReviewStatusChange(findingId, isChecked ? 'accepted' : 'pending');
    if (isChecked) setFinalSopOpen(true);
  };

  const handleSelectReport = async (report: ComplianceReport) => {
    setSelectedReport(report);
    setFilterGuideline('all');
    setIsFullScreen(true);
    setLoadingFullReport(true);
    setFullReportLoadError(null);
    try {
      const res = await fetch(`/api/compliance/analyze?reportId=${report._id}`);
      const data = await res.json();
      if (data.success && data.report) {
        setSelectedReport(data.report);
      } else {
        setFullReportLoadError(data.error ?? 'Could not load report findings');
      }
    } catch {
      setFullReportLoadError('Could not load report findings');
    } finally {
      setLoadingFullReport(false);
    }
  };

  const resolveSopIdForReport = useCallback((): string | null => {
    if (selectedReport?.sopId) return selectedReport.sopId;
    const match = sops.find((s) => s.identifier === selectedReport?.sopIdentifier);
    return match?._id ?? null;
  }, [selectedReport, sops]);

  const handleRerunComplianceForReport = useCallback(async () => {
    if (!selectedReport || isAnalyzing) return;
    const sopId = resolveSopIdForReport();
    const sop = sops.find((s) => s._id === sopId);
    if (!sop) {
      alert('Could not resolve SOP for this report.');
      return;
    }

    const fromFindings = [
      ...new Set(
        (selectedReport.findings ?? [])
          .map((f) => f.guidelineId)
          .filter((id): id is string => !!id?.trim()),
      ),
    ];
    const guidelineIds =
      fromFindings.length > 0 ? fromFindings : [...selectedGuidelineIds];
    if (!guidelineIds.length) {
      alert('No guidelines available to rerun compliance. Select guidelines in the review step first.');
      return;
    }

    const selectedList = guidelines.filter((g) => guidelineIds.includes(g._id));
    const guidelineLabel =
      selectedList.length === 1
        ? selectedList[0].name
        : `${selectedList.length} guidelines`;

    setRerunningCompliance(true);
    setFinalSopOpen(false);
    setCurrentStep('analyze');
    try {
      await startRun({
        candidates: [{ _id: sop._id, identifier: sop.identifier, name: sop.name }],
        guidelineIds,
        guidelineLabel,
        forceRefresh: true,
        provider: selectedProvider,
        model:
          selectedProvider === 'claude'
            ? selectedModel
            : selectedProvider === 'codex'
              ? codexStatus?.complianceModel ?? 'gpt-5.4-mini'
              : undefined,
      });
    } finally {
      setRerunningCompliance(false);
    }
  }, [
    selectedReport,
    isAnalyzing,
    resolveSopIdForReport,
    sops,
    selectedGuidelineIds,
    guidelines,
    selectedProvider,
    selectedModel,
    codexStatus?.complianceModel,
    startRun,
  ]);

  const handleReviewStatusChange = async (gapId: string, status: 'pending' | 'accepted' | 'disputed' | 'implemented') => {
    try {
      await fetch('/api/compliance/findings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gapId, reviewStatus: status }),
      });
      if (selectedReport) {
        setSelectedReport({
          ...selectedReport,
          findings: selectedReport.findings.map((f) =>
            (f.gapId ?? f._id) === gapId
              ? { ...f, reviewStatus: status, resolved: status === 'implemented' }
              : f,
          ),
        });
      }
    } catch { /* silent */ }
  };

  const handleApplyFix = async (gapId: string, finding: ComplianceFinding) => {
    const sopId = resolveSopIdForReport();
    if (!sopId) {
      alert('Could not resolve SOP for this report.');
      return;
    }
    if (!confirm('Apply this fix to the SOP? Only the targeted text will be modified.')) return;

    setApplyingFixGapId(gapId);
    try {
      const res = await fetch('/api/compliance/apply-fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gapId,
          sopId,
          originalText: finding.sopTextSnippet,
          replacementText: finding.suggestedText,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        alert(data.error ?? 'Apply fix failed');
        return;
      }
      alert(`Fix applied.\n\n${data.changeSummary}`);
      if (selectedReport) {
        await handleSelectReport(selectedReport);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Apply fix failed');
    } finally {
      setApplyingFixGapId(null);
    }
  };

  const handleDeleteReport = async (reportId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (!confirm('Delete this compliance report?')) return;
    await fetch(`/api/compliance/analyze?reportId=${reportId}`, { method: 'DELETE' });
    if (selectedReport?._id === reportId) setSelectedReport(null);
    fetchReports();
  };

  const guidelineFolders = useMemo(() => {
    const fromReport = selectedReport?.findings
      ?.map((f) => f.folderName)
      .filter(Boolean) as string[] | undefined;
    if (fromReport?.length) return [...new Set(fromReport)];
    return [...new Set(guidelines.map((g) => g.folder))];
  }, [selectedReport, guidelines]);

  const filteredFindings = useMemo(() => {
    if (!selectedReport?.findings) return [];
    return selectedReport.findings
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => {
        if (filterStatus !== 'all' && f.complianceLevel !== filterStatus) return false;
        if (filterSeverity !== 'all' && findingSeverityKey(f) !== filterSeverity) return false;
        if (filterGuideline !== 'all' && f.folderName !== filterGuideline) return false;
        if (hideNotApplicable && f.complianceLevel === 'not-applicable') return false;
        if (hideFailedFindings && f.complianceLevel === 'analysis-failed') return false;
        return true;
      });
  }, [selectedReport, filterStatus, filterSeverity, filterGuideline, hideNotApplicable, hideFailedFindings]);

  const sortedFindings = useMemo(() => {
    return [...filteredFindings].sort((a, b) => compareFindings(a.f, b.f, findingsSortKey, findingsSortDir));
  }, [filteredFindings, findingsSortKey, findingsSortDir]);

  const visibleFindings = sortedFindings;

  const groupedFindings = useMemo(
    () => buildGuidelineGroupedFindings(sortedFindings, folders.map((f) => f.folderName)),
    [sortedFindings, folders],
  );

  const sectionGroupedFindings = useMemo(
    () => buildSectionGroupedFindings(sortedFindings),
    [sortedFindings],
  );

  const displayGroupedFindings = findingsGroupView === 'guideline' ? groupedFindings : sectionGroupedFindings;

  // Falls back to the first group whenever the active one scrolls out of the
  // current filter/report (avoids setState-in-effect for the "no scroll yet" default).
  const displayActiveGroupKey = useMemo(() => {
    if (activeFolder && displayGroupedFindings.some((g) => g.key === activeFolder)) return activeFolder;
    return displayGroupedFindings[0]?.key ?? null;
  }, [activeFolder, displayGroupedFindings]);

  // Highlights the group chip for whichever group heading is currently at the top
  // of the scrollable findings list, so the header tracks what the user is reading.
  useEffect(() => {
    const root = findingsScrollRef.current;
    if (!root || displayGroupedFindings.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length === 0) return;
        const topMost = visible.reduce((a, b) => (a.boundingClientRect.top <= b.boundingClientRect.top ? a : b));
        const groupKey = (topMost.target as HTMLElement).dataset.groupKey;
        if (groupKey) setActiveFolder(groupKey);
      },
      { root, rootMargin: '0px 0px -75% 0px', threshold: 0 },
    );

    displayGroupedFindings.forEach((g) => {
      const el = groupRefs.current[g.key];
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [displayGroupedFindings]);

  useEffect(() => {
    if (!findingsSortOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!findingsSortRef.current?.contains(e.target as Node)) setFindingsSortOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [findingsSortOpen]);

  useEffect(() => {
    setCollapsedFindingGroups(new Set());
    setActiveFolder(null);
  }, [findingsGroupView]);

  const allFindingsSelected =
    visibleFindings.length > 0 && visibleFindings.every(({ i }) => selectedFindingIds.has(i));
  const someFindingsSelected = visibleFindings.some(({ i }) => selectedFindingIds.has(i));

  const toggleSelectAllFindings = () => {
    if (allFindingsSelected) {
      const next = new Set(selectedFindingIds);
      visibleFindings.forEach(({ i }) => next.delete(i));
      setSelectedFindingIds(next);
    } else {
      const next = new Set(selectedFindingIds);
      visibleFindings.forEach(({ i }) => next.add(i));
      setSelectedFindingIds(next);
    }
  };

  const normaliseSectionKey = (f: ComplianceFinding) => {
    const raw = f.sopSectionAffected || 'General';
    return sectionHeadingLabel(String(raw));
  };

  const consolidatedSections = useMemo(() => {
    if (!selectedReport?.findings) return [];
    const selected = selectedReport.findings.filter((_, i) => selectedFindingIds.has(i));
    const map = new Map<string, ComplianceFinding[]>();
    for (const f of selected) {
      const key = normaliseSectionKey(f);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return Array.from(map.entries()).map(([key, group]) => ({
      sectionKey: key,
      findings: group,
      isMulti: group.length > 1,
      sources: [...new Set(group.map(f => f.folderName || f.guidelineName || 'Guideline').filter(Boolean))],
      clauses: [...new Set(group.map(f => f.clauseNumber).filter(Boolean))],
      combinedAction: [...new Set(group.map(f => (f.suggestedAction ?? '').replace(/```[\s\S]*?```/g, '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(' '),
      combinedSuggestion: group.map(f => f.suggestedText ?? '').filter(Boolean).join('\n\n'),
    })).sort((a, b) => compareSectionNumbers(a.sectionKey, b.sectionKey));
  }, [selectedReport, selectedFindingIds]);

  const isActionableFix = (f: ComplianceFinding) =>
    (f.complianceLevel === 'partial' || f.complianceLevel === 'non-compliant') &&
    (f.suggestedText || f.suggestedAction) &&
    !!f.sopTextSnippet?.trim();

  const isApprovedFix = (f: ComplianceFinding) => {
    const status = f.reviewStatus ?? 'pending';
    return status === 'accepted' || status === 'implemented';
  };

  const actionableFixes = useMemo(
    () => (selectedReport?.findings ?? []).filter(isActionableFix),
    [selectedReport],
  );

  const approvedFixes = useMemo(
    () => actionableFixes.filter(isApprovedFix),
    [actionableFixes],
  );

  const pendingApprovalFixCount = actionableFixes.length - approvedFixes.length;

  const handleApproveAllFixes = async () => {
    if (!selectedReport) return;
    const toApprove = actionableFixes.filter((f) => !isApprovedFix(f));
    if (!toApprove.length) return;

    const gapIds = toApprove.map((f) => f.gapId ?? f._id);
    await Promise.all(
      gapIds.map((gapId) =>
        fetch('/api/compliance/findings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ gapId, reviewStatus: 'accepted' }),
        }),
      ),
    );

    const approvedSet = new Set(gapIds);
    setSelectedReport({
      ...selectedReport,
      findings: selectedReport.findings.map((f) =>
        approvedSet.has(f.gapId ?? f._id) ? { ...f, reviewStatus: 'accepted' as const } : f,
      ),
    });
  };

  const reportStatusTotals = useMemo(() => {
    const compliant = selectedReport?.compliantCount ?? 0;
    const partial = selectedReport?.partialCount ?? 0;
    const nonCompliant = selectedReport?.nonCompliantCount ?? 0;
    return { compliant, partial, nonCompliant, total: compliant + partial + nonCompliant };
  }, [selectedReport]);

  const reportSeverityTotals = useMemo(() => {
    const ac = selectedReport?.auditCompleteness;
    if (ac && (ac.criticalFindings || ac.majorFindings || ac.minorFindings)) {
      return {
        critical: ac.criticalFindings ?? 0,
        major: ac.majorFindings ?? 0,
        minor: ac.minorFindings ?? 0,
      };
    }
    const totals = { critical: 0, major: 0, minor: 0 };
    for (const f of selectedReport?.findings ?? []) {
      const key = findingSeverityKey(f);
      if (key) totals[key] += 1;
    }
    return totals;
  }, [selectedReport]);

  const findingsLoaded = (selectedReport?.findings?.length ?? 0) > 0;
  const expectsFindings = reportStatusTotals.total > 0;
  const findingsPending =
    !loadingFullReport && !fullReportLoadError && expectsFindings && !findingsLoaded;

  const statusPct = (n: number) =>
    reportStatusTotals.total > 0 ? Math.round((n / reportStatusTotals.total) * 100) : 0;


  const progressPct = complianceRunProgressPct(analysisStats);

  return (
    <div className="min-h-screen bg-[#f8f9fa] font-sans">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <h1 className="text-sm font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-700 to-purple-500 whitespace-nowrap shrink-0">
              Compliance Intelligence Engine
            </h1>
            <div className="hidden sm:block h-3.5 w-px bg-gray-200 shrink-0" />
            <div className="hidden sm:flex items-center gap-1.5 min-w-0">
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-indigo-50 text-indigo-800 border border-indigo-200 whitespace-nowrap"
                title="V3 precision engine: gatekeeping, per-clause analysis, intelligent scoring"
              >
                <span className="w-1 h-1 rounded-full bg-indigo-500 animate-pulse" />
                V3 · Active
              </span>
              {llmInfo && (
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide whitespace-nowrap ${
                    selectedProvider === 'ollama'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : selectedProvider === 'claude'
                      ? 'bg-violet-50 text-violet-700 border border-violet-200'
                      : selectedProvider === 'codex'
                      ? 'bg-sky-50 text-sky-700 border border-sky-200'
                      : 'bg-purple-50 text-purple-700 border border-purple-200'
                  }`}
                  title={
                    selectedProvider === 'claude'
                      ? `Claude model: ${selectedModel}`
                      : selectedProvider === 'codex'
                      ? `Codex model: ${codexStatus?.complianceModel ?? 'gpt-5.4-mini'}`
                      : `Compliance model: ${llmInfo.complianceModel}`
                  }
                >
                  <span className={`w-1 h-1 rounded-full ${
                    selectedProvider === 'ollama' ? 'bg-emerald-500'
                    : selectedProvider === 'claude' ? 'bg-violet-500'
                    : selectedProvider === 'codex' ? 'bg-sky-500'
                    : 'bg-purple-500'
                  }`} />
                  {selectedProvider === 'claude'
                    ? `Claude · ${selectedModel.includes('haiku') ? 'Haiku' : 'Sonnet'}`
                    : selectedProvider === 'codex'
                    ? `Codex · ${codexStatus?.complianceModel ?? 'gpt-5.4-mini'}`
                    : selectedProvider === 'ollama'
                    ? 'Ollama'
                    : selectedProvider === 'gemini'
                    ? `Gemini · ${llmInfo.complianceModel}`
                    : `LLM: ${llmInfo.label}`}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setSelectedProvider((p) => (p === 'claude' ? 'gemini' : 'claude'))}
              title={
                selectedProvider === 'claude' && claudeStatus?.ok
                  ? `Claude via your subscription (${claudeStatus.email ?? 'logged in'} · ${selectedModel}) — click for Gemini`
                  : selectedProvider === 'claude' && claudeStatus?.error
                    ? `Claude not connected: ${claudeStatus.error}`
                    : 'Use Claude Code for compliance analysis (default)'
              }
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                selectedProvider === 'claude'
                  ? claudeStatus?.ok === false && !claudeStatus?.loading
                    ? 'border border-red-600 bg-red-600 text-white hover:bg-red-700 ring-1 ring-red-300'
                    : 'border border-violet-600 bg-violet-600 text-white hover:bg-violet-700 ring-1 ring-violet-300'
                  : 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Sparkles className="h-3 w-3" />
              {selectedProvider === 'claude'
                ? claudeStatus?.loading
                  ? 'Claude…'
                  : claudeStatus?.ok
                    ? 'Claude ✓'
                    : 'Claude !'
                : 'Claude'}
            </button>
            <button
              type="button"
              onClick={() => setSelectedProvider('codex')}
              title={
                selectedProvider === 'codex' && codexStatus?.ok
                  ? `Codex via your ChatGPT subscription (${codexStatus.complianceModel ?? 'gpt-5.4-mini'}) — local CLI, no API key`
                  : selectedProvider === 'codex' && codexStatus?.error
                    ? `Codex not connected: ${codexStatus.error}`
                    : 'Codex — local CLI via ChatGPT subscription (no API key)'
              }
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                selectedProvider === 'codex'
                  ? codexStatus?.ok === false && !codexStatus?.loading
                    ? 'border border-red-600 bg-red-600 text-white hover:bg-red-700 ring-1 ring-red-300'
                    : 'border border-sky-600 bg-sky-600 text-white hover:bg-sky-700 ring-1 ring-sky-300'
                  : 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Bot className="h-3 w-3" />
              {selectedProvider === 'codex'
                ? codexStatus?.loading
                  ? 'Codex…'
                  : codexStatus?.ok
                    ? 'Codex ✓'
                    : 'Codex !'
                : 'Codex'}
            </button>
            <button
              type="button"
              onClick={() => setSelectedProvider('gemini')}
              title="Use Gemini for compliance analysis"
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                selectedProvider === 'gemini'
                  ? 'border border-blue-600 bg-blue-600 text-white hover:bg-blue-700 ring-1 ring-blue-300'
                  : 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              ◆ Gemini
            </button>
            <button
              type="button"
              onClick={() => setSelectedProvider((p) => (p === 'ollama' ? 'claude' : 'ollama'))}
              title={selectedProvider === 'ollama' ? 'Using local Ollama — click for Claude' : 'Use local Ollama for compliance'}
              className={`flex items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                selectedProvider === 'ollama'
                  ? 'border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 ring-1 ring-emerald-300'
                  : 'border border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Cpu className="h-3 w-3" />
              {selectedProvider === 'ollama' ? 'Local AI ✓' : 'Local AI'}
            </button>
            {selectedProvider === 'claude' && (
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                className="rounded-md border border-violet-300 bg-white px-1.5 py-1 text-[11px] font-medium text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400"
              >
                <option value="claude-haiku-4-5-20251001">Haiku 4.5 (fast)</option>
                <option value="claude-sonnet-4-6">Sonnet 4.6 (recommended)</option>
              </select>
            )}
            <button
              onClick={() => router.push('/dashboard')}
              className="flex items-center gap-1 px-2.5 py-1 bg-purple-600 hover:bg-purple-700 text-white rounded-md transition-all text-[11px] font-semibold shadow-sm"
            >
              ← Dashboard
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 pt-3 pb-6">
        <div className="mb-4">
          <ComplianceModuleNav />
        </div>
        {selectedProvider === 'claude' && claudeStatus && !claudeStatus.loading && !claudeStatus.ok && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Claude is not connected. Run <code className="rounded bg-red-100 px-1">claude auth login</code> in a terminal, then refresh.
            {claudeStatus.error ? ` — ${claudeStatus.error}` : ''}
          </div>
        )}
        {selectedProvider === 'codex' && codexStatus && !codexStatus.loading && !codexStatus.ok && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            Codex is not connected. Run <code className="rounded bg-red-100 px-1">codex login</code> in a terminal, then refresh.
            {codexStatus.error ? ` — ${codexStatus.error}` : ''}
          </div>
        )}
        {/* Step tabs */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          {([
            { id: 'fetch-sops',       label: '1. SOPs',       icon: '📄', count: sopTotal || sops.length },
            { id: 'fetch-guidelines', label: '2. Guidelines', icon: '📚', count: guidelines.length },
            { id: 'review',           label: '3. Review',     icon: '👁️', count: null },
            { id: 'analyze',          label: '4. Analyze',    icon: '🤖', count: null },
            { id: 'results',          label: '5. Results',    icon: '📊', count: reports.length },
          ] as const).map(step => (
            <button key={step.id} onClick={() => setCurrentStep(step.id)} className={getStepStyle(step.id)}>
              <span className="text-xl opacity-90">{step.icon}</span>
              <span className="font-semibold text-sm hidden md:inline">{step.label}</span>
              {step.count !== null && (
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${currentStep === step.id ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-500'}`}>
                  {step.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── UPLOAD GUIDELINES MODAL ── */}
        {uploadModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md flex flex-col max-h-[88vh]">

              {/* Header */}
              <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-gray-100 flex-shrink-0">
                <div>
                  <h2 className="text-xl font-bold text-gray-900">Upload Guidelines</h2>
                  <p className="text-xs text-gray-500 mt-0.5">PDFs are parsed and clauses extracted automatically</p>
                </div>
                <button onClick={() => { setUploadModalOpen(false); setUploadResults(null); setUploadGroups(null); setUploadFiles(null); setUploadFolder(''); }}
                  className="p-1.5 text-gray-400 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors">
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="px-6 py-5 overflow-y-auto flex-1 space-y-4">

                {/* ── Results view ── */}
                {uploadResults ? (
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                      {uploadResults.filter(r => r.status !== 'failed').length} / {uploadResults.length} processed successfully
                    </p>
                    {uploadResults.map((r, i) => (
                      <div key={i} className={`flex items-start justify-between px-3 py-2.5 rounded-xl border text-xs gap-2 ${r.status === 'failed' ? 'bg-rose-50 border-rose-200 text-rose-700' : r.status === 'updated' ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-emerald-50 border-emerald-200 text-emerald-700'}`}>
                        <div className="min-w-0 flex-1">
                          {r.folder && <span className="opacity-60 mr-1">📂 {r.folder} ›</span>}
                          <span className="font-semibold">{r.name}</span>
                          {r.error && <p className="text-[10px] mt-0.5 opacity-80">{r.error}</p>}
                        </div>
                        <span className="flex-shrink-0 font-bold capitalize whitespace-nowrap">
                          {r.status === 'failed' ? 'Failed' : `${r.status} · ${r.clauses} clauses`}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    {/* ── Bulk groups preview ── */}
                    {uploadGroups ? (
                      <div className="bg-purple-50 border border-purple-200 rounded-xl p-4">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="text-sm font-bold text-purple-800">📁 {uploadGroups.length} categories detected</p>
                            <p className="text-xs text-purple-600 mt-0.5">Each subfolder → separate guideline category</p>
                          </div>
                          <button type="button" onClick={() => { setUploadGroups(null); setUploadFiles(null); setUploadFolder(''); }}
                            className="text-xs text-purple-500 hover:text-purple-700 font-bold">Clear</button>
                        </div>
                        <div className="space-y-1.5 max-h-40 overflow-y-auto">
                          {uploadGroups.map((g, i) => (
                            <div key={i} className="flex items-center justify-between bg-white border border-purple-100 rounded-lg px-3 py-2">
                              <span className="text-sm font-semibold text-gray-800">📂 {g.folder}</span>
                              <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">{g.files.length} PDF{g.files.length !== 1 ? 's' : ''}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <>
                        {/* ── Category name ── */}
                        <div>
                          <label className="block text-sm font-semibold text-gray-700 mb-1.5">Folder / Category Name</label>
                          <input type="text" placeholder="e.g., EU GMP Part 1" value={uploadFolder}
                            onChange={e => setUploadFolder(e.target.value)} disabled={uploading}
                            className="w-full px-3.5 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-purple-400/30 focus:border-purple-400 disabled:opacity-50" />
                          <p className="text-[11px] text-gray-400 mt-1">Existing folders will be updated.</p>
                        </div>

                        {/* ── Selected files ── */}
                        {uploadFiles && uploadFiles.length > 0 && (
                          <div className="bg-purple-50 border border-purple-200 rounded-xl p-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-bold text-purple-700">{uploadFiles.length} PDF{uploadFiles.length > 1 ? 's' : ''} ready</span>
                              <button type="button" onClick={() => setUploadFiles(null)} className="text-[10px] text-purple-500 hover:text-purple-700 font-bold">Remove</button>
                            </div>
                            <ul className="space-y-1 max-h-24 overflow-y-auto">
                              {Array.from(uploadFiles).map((f, i) => (
                                <li key={i} className="text-xs text-gray-600 flex items-center gap-2 truncate">
                                  <span className="w-1.5 h-1.5 rounded-full bg-purple-400 flex-shrink-0" />{f.name}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    )}

                    {/* ── Picker buttons ── */}
                    <div className={`grid grid-cols-3 gap-2 ${uploading ? 'pointer-events-none opacity-40' : ''}`}>
                      <label className="flex flex-col items-center gap-1.5 p-3 border-2 border-dashed border-gray-200 rounded-xl cursor-pointer hover:border-purple-400 hover:bg-purple-50 transition-all text-center">
                        <span className="text-xl">📄</span>
                        <span className="text-xs font-semibold text-gray-700">Files</span>
                        <span className="text-[10px] text-gray-400">Select PDFs</span>
                        <input type="file" accept=".pdf" multiple className="hidden" disabled={uploading}
                          onChange={e => { if (e.target.files?.length) { setUploadGroups(null); setUploadFiles(e.target.files); } }} />
                      </label>

                      <label className="flex flex-col items-center gap-1.5 p-3 border-2 border-dashed border-purple-200 rounded-xl cursor-pointer hover:border-purple-500 hover:bg-purple-50 transition-all text-center">
                        <span className="text-xl">📁</span>
                        <span className="text-xs font-semibold text-purple-700">Folder</span>
                        <span className="text-[10px] text-gray-400">One category</span>
                        <input type="file" accept=".pdf" multiple className="hidden" disabled={uploading}
                          // @ts-expect-error webkitdirectory non-standard
                          webkitdirectory=""
                          onChange={e => {
                            const files = e.target.files;
                            if (!files?.length) return;
                            type WF = File & { webkitRelativePath?: string };
                            const pdfs = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.pdf'));
                            const dt = new DataTransfer(); pdfs.forEach(f => dt.items.add(f));
                            setUploadGroups(null); setUploadFiles(dt.files);
                            if (!uploadFolder.trim()) setUploadFolder((files[0] as WF).webkitRelativePath?.split('/')[0] || '');
                          }} />
                      </label>

                      <label className="flex flex-col items-center gap-1.5 p-3 border-2 border-dashed border-purple-400 rounded-xl cursor-pointer hover:border-purple-600 hover:bg-purple-50 transition-all text-center">
                        <span className="text-xl">🗂️</span>
                        <span className="text-xs font-semibold text-purple-800">Bulk</span>
                        <span className="text-[10px] text-gray-400">Subfolders</span>
                        <input type="file" accept=".pdf" multiple className="hidden" disabled={uploading}
                          // @ts-expect-error webkitdirectory non-standard
                          webkitdirectory=""
                          onChange={e => {
                            const files = e.target.files;
                            if (!files?.length) return;
                            type WF = File & { webkitRelativePath?: string };
                            const groupMap = new Map<string, File[]>();
                            for (const f of Array.from(files) as WF[]) {
                              if (!f.name.toLowerCase().endsWith('.pdf')) continue;
                              const parts = (f.webkitRelativePath ?? f.name).split('/');
                              const folder = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
                              if (!groupMap.has(folder)) groupMap.set(folder, []);
                              groupMap.get(folder)!.push(f);
                            }
                            if (groupMap.size <= 1) {
                              const dt = new DataTransfer();
                              (Array.from(files) as WF[]).filter(f => f.name.toLowerCase().endsWith('.pdf')).forEach(f => dt.items.add(f));
                              setUploadGroups(null); setUploadFiles(dt.files);
                              setUploadFolder((Array.from(files)[0] as WF).webkitRelativePath?.split('/')[0] || '');
                            } else {
                              setUploadFiles(null); setUploadFolder('');
                              setUploadGroups(Array.from(groupMap.entries()).map(([folder, files]) => ({ folder, files })));
                            }
                          }} />
                      </label>
                    </div>

                    {/* ── Bulk progress ── */}
                    {uploading && uploadGroups && (
                      <div>
                        <div className="flex justify-between text-xs text-gray-500 mb-1.5">
                          <span>Processing <span className="font-semibold text-purple-700">{uploadProgress.currentFolder}</span></span>
                          <span>{uploadProgress.current}/{uploadProgress.total}</span>
                        </div>
                        <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                          <div className="h-full bg-purple-600 rounded-full transition-all duration-500"
                            style={{ width: `${uploadProgress.total > 0 ? Math.round((uploadProgress.current / uploadProgress.total) * 100) : 0}%` }} />
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Footer */}
              <div className="flex gap-3 px-6 py-4 border-t border-gray-100 flex-shrink-0">
                <button onClick={() => { setUploadModalOpen(false); setUploadResults(null); setUploadGroups(null); setUploadFiles(null); setUploadFolder(''); }}
                  disabled={uploading}
                  className="flex-1 py-2.5 border border-gray-300 rounded-xl text-sm text-gray-700 font-semibold hover:bg-gray-50 transition-all disabled:opacity-50">
                  {uploadResults ? 'Close' : 'Cancel'}
                </button>
                {!uploadResults && (
                  <button onClick={handleGuidelineUpload}
                    disabled={uploading || (!uploadGroups?.length && (!uploadFolder.trim() || !uploadFiles?.length))}
                    className="flex-1 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2">
                    {uploading
                      ? <><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Processing...</>
                      : uploadGroups?.length ? `Upload ${uploadGroups.length} Categories` : 'Confirm Upload'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 1: SOPs ── */}
        {currentStep === 'fetch-sops' && (
          <>
            <PendingRunRequests
              onSelectSop={(sopId, department) => {
                selectOnlySop(sopId);
                if (department) setFilterDepartment(department);
              }}
            />
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-gray-800">SOP Repository</h2>
                <p className="text-gray-500 mt-1">{sopTotal || sops.length} SOPs across {departments.length} departments available for analysis.</p>
              </div>
              <button onClick={fetchSops} disabled={loadingSops} className="px-5 py-2.5 bg-purple-50 hover:bg-purple-100 text-purple-700 rounded-xl transition-all disabled:opacity-50 font-medium text-sm flex items-center gap-2 border border-purple-200">
                {loadingSops ? <><span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />Fetching...</> : '🔄 Refresh Data'}
              </button>
            </div>

            <div className="mb-6 flex items-center gap-3">
              <span className="text-sm font-medium text-gray-600">Filter by Department:</span>
              <div className="relative">
                <select
                  value={filterDepartment}
                  onChange={e => setFilterDepartment(e.target.value)}
                  className="pl-4 pr-10 py-2.5 bg-white border border-gray-200 rounded-lg text-gray-700 focus:outline-none focus:ring-2 focus:ring-purple-500/20 text-sm appearance-none cursor-pointer hover:border-purple-300 transition-all font-medium min-w-[240px]"
                >
                  <option value="all">All Departments ({sopTotal || sops.length})</option>
                  {departments.map(dept => (
                    <option key={dept} value={dept}>{dept} ({sops.filter(s => s.department === dept).length})</option>
                  ))}
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500 text-xs">▼</div>
              </div>
            </div>

            {loadingSops ? (
              <div className="text-center py-20 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-600 mx-auto mb-4" />
                <p className="text-gray-500">Loading SOPs...</p>
              </div>
            ) : (
              <div className="max-h-[600px] overflow-auto rounded-xl border border-gray-200">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="sticky top-0 z-10 bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="w-10 px-3 py-3">
                        <input
                          type="checkbox"
                          checked={allVisibleSopsSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someVisibleSopsSelected;
                          }}
                          onChange={(e) => setAllVisibleSopsSelected(e.target.checked)}
                          className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                          title="Select all visible SOPs"
                        />
                      </th>
                      <SopSortHeader label="SOP ID" sortKey="identifier" className="w-[140px]" />
                      <SopSortHeader label="Version" sortKey="version" className="w-[90px]" />
                      <SopSortHeader label="Title" sortKey="name" />
                      <SopSortHeader label="Location / Area" sortKey="location" className="w-[220px]" />
                      <SopSortHeader label="Department" sortKey="department" className="w-[140px]" />
                      <th className="w-[72px] px-3 py-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">Only</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {sortedSops.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-4 py-16 text-center text-gray-500">
                          No SOPs match the selected department filter.
                        </td>
                      </tr>
                    ) : (
                      sortedSops.map((sop) => {
                        const isSelected = selectedSopIds.has(sop._id);
                        return (
                        <tr
                          key={sop._id}
                          role="button"
                          tabIndex={0}
                          onClick={() => selectOnlySop(sop._id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              selectOnlySop(sop._id);
                            }
                          }}
                          title={`Select only ${sop.identifier} (use checkbox to add more)`}
                          className={`cursor-pointer transition-colors group ${
                            isSelected
                              ? 'bg-purple-50 ring-1 ring-inset ring-purple-300'
                              : 'hover:bg-purple-50/40'
                          }`}
                        >
                          <td className="px-3 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSopSelection(sop._id)}
                              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                            />
                          </td>
                          <td className="px-4 py-3 align-top">
                            <span className="inline-block text-purple-700 font-bold text-xs bg-purple-50 px-2 py-0.5 rounded border border-purple-100 font-mono">
                              {sop.identifier}
                            </span>
                          </td>
                          <td className="px-4 py-3 align-top text-gray-500 text-xs whitespace-nowrap">
                            {sop.version ? `v${sop.version}` : '—'}
                          </td>
                          <td className="px-4 py-3 align-top">
                            <p className={`font-medium transition-colors leading-snug ${
                              isSelected ? 'text-purple-700' : 'text-gray-800 group-hover:text-purple-700'
                            }`}>
                              {sop.name}
                            </p>
                            <span className="mt-1 inline-block text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                              {sop.language === 'Gujarati' ? 'GUJ' : 'ENG'}
                            </span>
                          </td>
                          <td className="px-4 py-3 align-top text-gray-600 text-xs leading-snug">
                            {sop.location ? (
                              <span className="inline-flex items-start gap-1">
                                <span className="text-gray-400 flex-shrink-0">📍</span>
                                <span>{sop.location}</span>
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 align-top">
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 bg-gray-50 border border-gray-200 text-gray-600 rounded-lg text-xs font-medium whitespace-nowrap">
                              🏢 {sop.department}
                            </span>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                selectOnlySop(sop._id);
                              }}
                              className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wide border transition-colors ${
                                selectedSopIds.size === 1 && isSelected
                                  ? 'bg-purple-600 text-white border-purple-600'
                                  : 'bg-white text-gray-500 border-gray-200 hover:border-purple-300 hover:text-purple-700'
                              }`}
                              title={`Run compliance for ${sop.identifier} only`}
                            >
                              Only
                            </button>
                          </td>
                        </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
                <div className="sticky bottom-0 border-t border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-500 flex items-center justify-between gap-4">
                  <span>
                    Showing {sortedSops.length} of {sopTotal || sops.length} SOPs
                    {filterDepartment !== 'all' ? ` in ${filterDepartment}` : ''}
                    {' · '}
                    <span className="text-purple-600 font-medium">{selectedSopCount} selected for analysis</span>
                  </span>
                  <span className="text-gray-400">Click a row for that SOP only · checkboxes to add more</span>
                </div>
              </div>
            )}

            <div className="flex justify-end mt-8 pt-6 border-t border-gray-100">
              <button onClick={() => setCurrentStep('fetch-guidelines')} className="px-8 py-3 bg-purple-600 text-white rounded-xl font-semibold hover:bg-purple-700 transition-all shadow-lg shadow-purple-200">
                Next: Guidelines →
              </button>
            </div>
          </div>
          </>
        )}

        {/* ── STEP 2: GUIDELINES ── */}
        {currentStep === 'fetch-guidelines' && (
          <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
            <div className="flex items-center justify-between mb-8">
              <div>
                <h2 className="text-2xl font-bold text-gray-800">Compliance Guidelines</h2>
                <p className="text-gray-500 mt-1">Managing {guidelines.length} guidelines ({totalClauses} clauses) across {folders.length} categories.</p>
              </div>
              <div className="flex gap-3">
                <button onClick={() => { setUploadFolder(''); setUploadFiles(null); setUploadResults(null); setUploadModalOpen(true); }} className="px-5 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-all shadow-sm font-medium text-sm flex items-center gap-2">
                  <Upload className="h-4 w-4" /> Upload Files
                </button>
                <button onClick={fetchGuidelines} disabled={loadingGuidelines} className="px-5 py-2.5 bg-gray-50 hover:bg-gray-100 text-gray-600 rounded-lg transition-all disabled:opacity-50 font-medium text-sm border border-gray-200">
                  {loadingGuidelines ? 'Refreshing...' : 'Refresh'}
                </button>
              </div>
            </div>

            {/* Guideline multi-select */}
            {loadingGuidelines ? (
              <div className="text-center py-20 bg-gray-50 rounded-xl border border-dashed border-gray-200 mb-8">
                <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-600 mx-auto mb-4" />
                <p className="text-gray-500">Loading guidelines...</p>
              </div>
            ) : (
              <div className="mb-8">
                <GuidelineSelector
                  guidelines={guidelines}
                  folders={folders}
                  selectedIds={selectedGuidelineIds}
                  onSelectionChange={handleGuidelineSelectionChange}
                  guidelineStats={guidelineStats}
                  onDelete={handleDeleteGuideline}
                />
              </div>
            )}

            {/* Folder summary — click to toggle all guidelines in category */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
              {folders.map(folder => {
                const inFolder = guidelines.filter((g) => g.folder === folder.folderName);
                const selectedInFolder = inFolder.filter((g) => selectedGuidelineIds.has(g._id)).length;
                const allInFolder = inFolder.length > 0 && selectedInFolder === inFolder.length;
                return (
                <button
                  key={folder.folderName}
                  type="button"
                  onClick={() => {
                    const next = new Set(selectedGuidelineIds);
                    for (const g of inFolder) {
                      if (allInFolder) next.delete(g._id);
                      else next.add(g._id);
                    }
                    handleGuidelineSelectionChange(next);
                  }}
                  className={`p-5 rounded-xl border text-left transition-all hover:shadow-md ${
                    allInFolder
                      ? 'bg-purple-100 border-purple-400 ring-2 ring-purple-300'
                      : selectedInFolder > 0
                        ? 'bg-purple-50 border-purple-200'
                        : 'bg-purple-50 border-purple-100 hover:border-purple-300'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-purple-500 opacity-80">📁</span>
                    <p className="text-gray-800 font-semibold truncate" title={folder.folderName}>{folder.folderName}</p>
                  </div>
                  <div className="flex items-end justify-between">
                    <div>
                      <p className="text-2xl font-bold text-purple-700 leading-none">{selectedInFolder}/{folder.guidelineCount}</p>
                      <p className="text-xs text-gray-500 mt-1">Selected</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-medium text-gray-700">{folder.totalClauses}</p>
                      <p className="text-xs text-gray-400">Clauses</p>
                    </div>
                  </div>
                </button>
                );
              })}
            </div>

            <div className="flex justify-between mt-8 pt-6 border-t border-gray-100">
              <button onClick={() => setCurrentStep('fetch-sops')} className="px-6 py-2.5 bg-gray-100 text-gray-600 rounded-xl font-semibold hover:bg-gray-200 transition-all">← Back</button>
              <button
                onClick={() => setCurrentStep('review')}
                disabled={selectedGuidelineIds.size === 0 || guidelines.length === 0}
                className="px-8 py-3 bg-purple-600 text-white rounded-xl font-semibold hover:bg-purple-700 transition-all shadow-lg shadow-purple-200 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Next: Review →
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 3: REVIEW ── */}
        {currentStep === 'review' && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
              <h2 className="text-2xl font-bold text-gray-800 mb-6">Review Configuration</h2>

              <div className="mb-8">
                <GuidelineSelector
                  guidelines={guidelines}
                  folders={folders}
                  selectedIds={selectedGuidelineIds}
                  onSelectionChange={handleGuidelineSelectionChange}
                  maxHeight="max-h-80"
                />
              </div>

              <div className="mb-6">
                <div className="flex items-center justify-between gap-4 mb-3">
                  <label className="block text-sm font-semibold text-gray-700">SOPs to analyze</label>
                  <div className="flex items-center gap-2 text-xs">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSopIds(new Set(sops.map((s) => s._id)));
                        setPreflightData({ checked: false, existingCount: 0, newCount: 0 });
                      }}
                      className="px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:border-purple-300 hover:text-purple-700"
                    >
                      Select all ({sopTotal || sops.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedSopIds(new Set());
                        setPreflightData({ checked: false, existingCount: 0, newCount: 0 });
                      }}
                      className="px-2.5 py-1 rounded-lg border border-gray-200 text-gray-600 hover:border-purple-300 hover:text-purple-700"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto rounded-xl border border-gray-200 divide-y divide-gray-100">
                  {sops.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-gray-500">No SOPs loaded.</p>
                  ) : (
                    sops.map((s) => (
                      <div
                        key={s._id}
                        className={`flex items-start gap-3 px-4 py-3 hover:bg-purple-50/50 ${
                          selectedSopIds.has(s._id) ? 'bg-purple-50/80' : ''
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={selectedSopIds.has(s._id)}
                          onChange={() => toggleSopSelection(s._id)}
                          className="mt-1 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-gray-800">
                            <span className="font-mono text-purple-700">{s.identifier}</span>
                            {' — '}
                            {s.name}
                          </span>
                          <span className="block text-xs text-gray-500 mt-0.5">{s.department}</span>
                        </span>
                        <button
                          type="button"
                          onClick={() => selectOnlySop(s._id)}
                          className={`px-2 py-1 rounded-lg text-[10px] font-bold uppercase border flex-shrink-0 ${
                            selectedSopIds.size === 1 && selectedSopIds.has(s._id)
                              ? 'bg-purple-600 text-white border-purple-600'
                              : 'bg-white text-gray-500 border-gray-200 hover:border-purple-300'
                          }`}
                        >
                          Only
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  {selectedSopCount} of {sopTotal || sops.length} SOPs selected
                </p>
              </div>

              {preflightData.checked && selectedSopCount > 0 && (
                <div className="p-4 bg-purple-50 border border-purple-200 rounded-xl mb-6">
                  <p className="text-sm font-semibold text-purple-700 mb-2">Analysis Scope</p>
                  <div className="flex flex-wrap gap-3">
                    <span className="px-3 py-1 bg-white text-purple-700 rounded-full text-xs font-bold border border-purple-200">
                      {(preflightData.existingCount + preflightData.newCount)} SOPs will be analyzed
                    </span>
                    {preflightData.existingCount > 0 && (
                      <span className="px-3 py-1 bg-blue-50 text-blue-700 rounded-full text-xs font-bold border border-blue-200">
                        {preflightData.existingCount} already have reports (will be refreshed)
                      </span>
                    )}
                    {preflightData.newCount > 0 && (
                      <span className="px-3 py-1 bg-green-50 text-green-700 rounded-full text-xs font-bold border border-green-200">
                        {preflightData.newCount} new (first analysis)
                      </span>
                    )}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-4 mb-8">
                {[
                  { label: 'TARGET SOPS', value: selectedSopCount, sub: selectedSopCount === 0 ? 'none selected' : selectedSopCount === 1 ? selectedSops[0]?.department ?? '1 department' : `across ${selectedDepartmentCount} department${selectedDepartmentCount === 1 ? '' : 's'}`, color: 'border-purple-200 bg-purple-50' },
                  { label: 'GUIDELINES', value: selectedGuidelineCount, sub: `${selectedGuidelineClauseCount} clauses to verify`, color: 'border-pink-200 bg-pink-50' },
                  { label: 'VALIDATION POINTS', value: selectedGuidelineClauseCount, sub: 'across selected guidelines', color: 'border-amber-200 bg-amber-50' },
                ].map(card => (
                  <div key={card.label} className={`p-6 rounded-xl border ${card.color}`}>
                    <p className="text-[10px] font-black text-gray-500 uppercase tracking-widest mb-2">{card.label}</p>
                    <p className="text-4xl font-bold text-gray-800">{card.value}</p>
                    <p className="text-xs text-gray-500 mt-1">{card.sub}</p>
                  </div>
                ))}
              </div>

              <div className="bg-gray-50 rounded-xl border border-gray-200 p-6">
                <h3 className="font-bold text-gray-800 mb-4">Process Overview</h3>
                <div className="space-y-3">
                  {['Gatekeeping validates SOP + guidelines before any AI calls', 'Per-clause V3 precision analysis with finding validation', 'Evidence-based scoring (Compliant, Partial, Non-Compliant) with section mapping', 'Intelligent score calculation and transparent report breakdown'].map((step, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <span className="w-6 h-6 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-xs font-black flex-shrink-0">{i + 1}</span>
                      <p className="text-sm text-gray-600">{step}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Provider summary — toggles are in the header */}
            <div className="bg-violet-50 border border-violet-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide mb-2">V3 Engine · AI Provider for this run</p>
              <p className="text-sm text-gray-700">
                Analysis uses the <strong>V3 precision engine</strong> (per-clause gatekeeping, validation, intelligent scoring).
                {' '}
                {selectedProvider === 'claude' && (
                  <>LLM: <strong>Claude {selectedModel.includes('haiku') ? 'Haiku' : 'Sonnet'}</strong> via Claude Code.</>
                )}
                {selectedProvider === 'codex' && (
                  <>LLM: <strong>Codex</strong> ({codexStatus?.complianceModel ?? 'gpt-5.4-mini'}) via your ChatGPT subscription.</>
                )}
                {selectedProvider === 'gemini' && (
                  <>LLM: <strong>Gemini</strong> ({llmInfo?.complianceModel ?? 'cloud'}).</>
                )}
                {selectedProvider === 'ollama' && (
                  <>LLM: <strong>local Ollama</strong>.</>
                )}
                {' '}Switch provider in the header.
              </p>
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={forceFullReanalysis}
                onChange={(e) => setForceFullReanalysis(e.target.checked)}
                className="rounded border-gray-300"
              />
              Force full re-analysis (skip incremental review — use when guidelines or SOP changed significantly)
            </label>

            <div className="flex justify-between">
              <button onClick={() => setCurrentStep('fetch-guidelines')} className="px-6 py-2.5 bg-gray-100 text-gray-600 rounded-xl font-semibold hover:bg-gray-200 transition-all">← Back</button>
              <button
                onClick={runAnalysis}
                disabled={
                  selectedSopCount === 0
                  || selectedGuidelineIds.size === 0
                  || guidelines.length === 0
                  || (selectedProvider === 'claude' && claudeStatus !== null && !claudeStatus.loading && !claudeStatus.ok)
                  || (selectedProvider === 'codex' && codexStatus !== null && !codexStatus.loading && !codexStatus.ok)
                }
                className={`px-10 py-3.5 rounded-xl font-bold text-base text-white disabled:opacity-50 disabled:cursor-not-allowed transition-all shadow-lg ${
                  selectedProvider === 'claude'
                    ? 'bg-violet-600 hover:bg-violet-700 shadow-violet-200'
                    : selectedProvider === 'codex'
                    ? 'bg-sky-600 hover:bg-sky-700 shadow-sky-200'
                    : selectedProvider === 'ollama'
                    ? 'bg-emerald-600 hover:bg-emerald-700 shadow-emerald-200'
                    : 'bg-purple-600 hover:bg-purple-700 shadow-purple-200'
                }`}
              >
                🚀 Start V3 Analysis
                {selectedProvider === 'claude'
                  ? ` · ${selectedModel.includes('haiku') ? 'Haiku' : 'Sonnet'}`
                  : selectedProvider === 'codex'
                  ? ` · Codex`
                  : selectedProvider === 'gemini'
                  ? ' · Gemini'
                  : selectedProvider === 'ollama'
                  ? ' · Ollama'
                  : ''}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 4: ANALYZE ── */}
        {currentStep === 'analyze' && (
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-xl font-bold text-gray-800">
                    {isAnalyzing ? 'V3 Precision Analysis Running...' : analysisComplete ? '✅ V3 Analysis Complete' : 'Analysis'}
                  </h2>
                  <p className="text-xs font-semibold text-indigo-600 mt-1 uppercase tracking-wide">
                    V3 Engine · {selectedProvider === 'codex' ? `Codex (${codexStatus?.complianceModel ?? 'gpt-5.4-mini'})` : selectedProvider === 'claude' ? `Claude (${selectedModel})` : selectedProvider === 'ollama' ? 'Ollama' : selectedProvider === 'gemini' ? `Gemini (${llmInfo?.complianceModel ?? 'cloud'})` : 'Provider'}
                  </p>
                  {isAnalyzing && analysisStats.currentSopName && (
                    <p className="text-sm text-gray-500 mt-1">
                      {analysisStats.currentSopIdentifier} — {analysisStats.currentSopName}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  {isAnalyzing && (
                    <>
                      <button
                        onClick={togglePause}
                        className={`flex items-center gap-2 px-4 py-2 rounded-xl border font-semibold text-sm transition-all ${isPaused ? 'bg-purple-600 text-white border-purple-500' : 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100'}`}
                      >
                        {isPaused ? '▶ Resume' : '⏸ Pause'}
                      </button>
                      <button
                        onClick={() => void stopRun()}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl border font-semibold text-sm transition-all bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100"
                      >
                        ⏹ Stop
                      </button>
                    </>
                  )}
                  <div className={`px-4 py-2 rounded-xl border font-black text-sm ${isAnalyzing ? 'bg-purple-100 text-purple-700 border-purple-200' : analysisComplete ? 'bg-emerald-100 text-emerald-700 border-emerald-200' : 'bg-gray-100 text-gray-600 border-gray-200'}`}>
                    {progressPct}% DONE
                  </div>
                </div>
              </div>

              {/* Progress bar */}
              <div className="relative h-3 bg-gray-200 rounded-full overflow-hidden mb-6">
                <div className="absolute inset-y-0 left-0 bg-purple-600 rounded-full transition-all duration-500" style={{ width: `${progressPct}%` }}>
                  <span className="absolute inset-0 flex items-center justify-center text-[8px] font-bold text-white">{analysisStats.completed + analysisStats.cached + analysisStats.failed}/{analysisStats.total}</span>
                </div>
              </div>

              {/* Stats cards */}
              <div className="grid grid-cols-4 gap-4 mb-6">
                {[
                  { label: 'COMPLETED', value: analysisStats.completed, color: 'bg-emerald-50 border-emerald-200', dot: 'bg-emerald-500', chip: 'completed' as const },
                  { label: 'CACHED', value: analysisStats.cached, color: 'bg-blue-50 border-blue-200', dot: 'bg-blue-500', chip: 'cached' as const },
                  { label: 'REMAINING', value: Math.max(0, analysisStats.total - analysisStats.completed - analysisStats.cached - analysisStats.failed), color: 'bg-purple-50 border-purple-200', dot: 'bg-purple-500', chip: null },
                  { label: 'FAILED', value: analysisStats.failed, color: 'bg-rose-50 border-rose-200', dot: 'bg-rose-400', chip: 'failed' as const },
                ].map(card => (
                  <button
                    key={card.label}
                    onClick={() => card.chip && setActiveChip(activeChip === card.chip ? null : card.chip)}
                    className={`p-4 rounded-xl border ${card.color} text-left transition-all ${card.chip ? 'hover:shadow-md cursor-pointer' : 'cursor-default'} ${activeChip === card.chip ? 'ring-2 ring-purple-400' : ''}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`w-2 h-2 rounded-full ${card.dot}`} />
                      <span className="text-[10px] font-black text-gray-500 uppercase tracking-wider">{card.label}</span>
                    </div>
                    <p className="text-2xl font-bold text-gray-800">{card.value}</p>
                  </button>
                ))}
              </div>

              {/* Current SOP being analyzed */}
              {isAnalyzing && analysisStats.currentSopName && (
                <div className="p-4 bg-purple-50 border border-purple-200 rounded-xl flex items-center gap-4">
                  <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center text-white font-black text-sm flex-shrink-0">C</div>
                  <div>
                    <p className="text-[10px] font-black text-purple-600 uppercase tracking-wider">ANALYZING SOP {analysisStats.completed + 1} OF {analysisStats.total}</p>
                    <p className="font-bold text-gray-800">{analysisStats.currentSopName}</p>
                    <p className="text-xs text-purple-600 font-mono">{analysisStats.currentSopIdentifier}</p>
                  </div>
                </div>
              )}

              {/* Chip list */}
              {activeChip && (
                <div className="mt-4 p-4 bg-gray-50 rounded-xl border border-gray-200 max-h-48 overflow-y-auto space-y-1">
                  {sopLists[activeChip].map((item, i) => (
                    <div key={i} className="py-1">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-mono text-purple-600 font-bold text-xs">{item.identifier}</span>
                        <span className="text-gray-600 text-xs truncate mx-2">{item.name}</span>
                        {'score' in item && typeof item.score === 'number' && (
                          <span className={`text-xs font-bold ${item.score >= 8 ? 'text-emerald-600' : item.score >= 5 ? 'text-amber-600' : 'text-rose-600'}`}>{item.score}/10</span>
                        )}
                      </div>
                      {'error' in item && item.error && (
                        <p className="text-[10px] text-rose-500 mt-0.5 leading-tight">{item.error}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* SOP progress map */}
              <div className="mt-6 bg-gray-50 rounded-xl border border-gray-200 p-4">
                <p className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-3">SOP Progress Map</p>
                <div className="flex flex-wrap gap-1.5">
                  {Array.from({ length: analysisStats.total }, (_, i) => {
                    const completed = i < analysisStats.completed + analysisStats.cached;
                    const failed = i >= analysisStats.completed + analysisStats.cached && i < analysisStats.completed + analysisStats.cached + analysisStats.failed;
                    const inProgress = i === analysisStats.completed + analysisStats.cached + analysisStats.failed && isAnalyzing;
                    return (
                      <div
                        key={i}
                        className={`w-4 h-4 rounded-sm transition-colors ${inProgress ? 'bg-purple-500 animate-pulse' : completed ? 'bg-emerald-500' : failed ? 'bg-rose-400' : 'bg-gray-200'}`}
                      />
                    );
                  })}
                </div>
                <div className="flex items-center gap-4 mt-2">
                  {[{ color: 'bg-emerald-500', label: 'Analyzed' }, { color: 'bg-purple-500', label: 'In Progress' }, { color: 'bg-rose-400', label: 'Failed' }, { color: 'bg-gray-200', label: 'Pending' }].map(l => (
                    <span key={l.label} className="flex items-center gap-1.5 text-[10px] text-gray-500">
                      <span className={`w-2.5 h-2.5 rounded-sm ${l.color}`} />{l.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {analysisComplete && (
              <div className="flex justify-center">
                <button onClick={() => setCurrentStep('results')} className="px-10 py-3.5 bg-purple-600 text-white rounded-xl font-bold hover:bg-purple-700 transition-all shadow-lg shadow-purple-200">
                  View Results →
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 5: Results — matches reference dev folder grid layout */}
        {currentStep === 'results' && (
          <div className={`${isFullScreen ? 'fixed inset-0 z-50 bg-[#f8f9fa] px-0.5 pt-3 pb-6 overflow-hidden' : 'grid grid-cols-1 xl:grid-cols-12 gap-8 h-[calc(100vh-160px)]'}`}>

            {!isFullScreen && (
            <div className={`${selectedReport ? 'xl:col-span-4' : 'xl:col-span-12'} bg-white rounded-2xl border border-gray-200 shadow-sm flex flex-col overflow-hidden transition-all duration-500`}>
              <div className="px-4 py-2.5 border-b border-gray-100 flex items-center justify-between gap-2 sticky top-0 bg-white z-10">
                <h2 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                  Generated Reports
                  <span className="px-1.5 py-0.5 bg-purple-100 text-purple-700 text-[10px] rounded-full font-bold">
                    {reportFilterDepartment === 'all' && reportFilterAnnexures === 'all'
                      ? reports?.length || 0
                      : `${filteredReports.length}/${reports?.length || 0}`}
                  </span>
                </h2>
                <div className="flex items-center gap-1.5">
                  {(reports ?? []).some((r) => resolveAnnexureStatus(r) !== 'checked') && (
                    <span
                      className="hidden sm:inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold border border-amber-200 bg-amber-50 text-amber-800"
                      title="Reports where annexures were not connected or not readable — re-run after linking annexures"
                    >
                      <Paperclip className="h-3 w-3" />
                      {(reports ?? []).filter((r) => resolveAnnexureStatus(r) !== 'checked').length} need annexure check
                    </span>
                  )}
                  <button
                    onClick={fetchReports}
                    className="p-1.5 hover:bg-gray-100 text-gray-400 hover:text-purple-600 rounded-md transition-all"
                    title="Refresh"
                  >
                    <RefreshCw className={`h-4 w-4 ${loadingReports ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>

              {loadingReports ? (
                <div className="flex-1 flex flex-col items-center justify-center p-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-3" />
                  <p className="text-gray-400 text-sm">Loading...</p>
                </div>
              ) : (reports?.length || 0) === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center p-12 text-gray-400">
                  <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center mb-4">
                    <span className="text-2xl grayscale opacity-50">📊</span>
                  </div>
                  <p className="font-medium text-gray-500">No reports generated</p>
                  <button
                    onClick={() => setCurrentStep('review')}
                    className="mt-4 text-purple-600 text-sm font-medium hover:underline"
                  >
                    Start New Analysis
                  </button>
                </div>
              ) : (
                <>
                <div className="px-4 py-2 border-b border-gray-100 flex flex-wrap items-center gap-2 bg-gray-50/50">
                  <span className="text-[11px] font-semibold text-gray-500">Department:</span>
                  <div className="relative">
                    <select
                      value={reportFilterDepartment}
                      onChange={(e) => setReportFilterDepartment(e.target.value)}
                      className="pl-2.5 pr-7 py-1 bg-white border border-gray-200 rounded-md text-gray-700 focus:outline-none focus:ring-1 focus:ring-purple-400 text-[11px] appearance-none cursor-pointer hover:border-purple-300 transition-all font-medium min-w-[140px]"
                    >
                      <option value="all">All ({reports?.length || 0})</option>
                      {reportDepartments.map((dept) => (
                        <option key={dept} value={dept}>
                          {dept} ({(reports ?? []).filter((r) => r.department === dept).length})
                        </option>
                      ))}
                    </select>
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-[9px]">▼</div>
                  </div>
                  <span className="text-[11px] font-semibold text-gray-500">Annexures:</span>
                  <div className="relative">
                    <select
                      value={reportFilterAnnexures}
                      onChange={(e) =>
                        setReportFilterAnnexures(
                          e.target.value as 'all' | 'checked' | 'none' | 'not-checked' | 'linked-unread',
                        )
                      }
                      className="pl-2.5 pr-7 py-1 bg-white border border-gray-200 rounded-md text-gray-700 focus:outline-none focus:ring-1 focus:ring-purple-400 text-[11px] appearance-none cursor-pointer hover:border-purple-300 transition-all font-medium min-w-[190px]"
                    >
                      <option value="all">All</option>
                      <option value="checked">
                        Done (
                        {(reports ?? []).filter((r) => resolveAnnexureStatus(r) === 'checked').length})
                      </option>
                      <option value="not-checked">
                        Connected — not checked (
                        {(reports ?? []).filter((r) => resolveAnnexureStatus(r) === 'not-checked').length})
                      </option>
                      <option value="none">
                        No annexure connected (
                        {(reports ?? []).filter((r) => resolveAnnexureStatus(r) === 'none').length})
                      </option>
                      <option value="linked-unread">
                        Linked / unread (
                        {(reports ?? []).filter((r) => resolveAnnexureStatus(r) === 'linked-unread').length})
                      </option>
                    </select>
                    <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-400 text-[9px]">▼</div>
                  </div>
                  {(reportFilterDepartment !== 'all' || reportFilterAnnexures !== 'all') && (
                    <button
                      type="button"
                      onClick={() => {
                        setReportFilterDepartment('all');
                        setReportFilterAnnexures('all');
                      }}
                      className="text-[10px] font-medium text-purple-600 hover:text-purple-800 hover:underline"
                    >
                      Clear filters
                    </button>
                  )}
                  <span className="ml-auto text-[10px] text-gray-400">
                    Showing {sortedReports.length} report{sortedReports.length !== 1 ? 's' : ''}
                  </span>
                </div>
                <div className={`overflow-auto flex-1 ${selectedReport ? '' : 'max-h-[calc(100vh-260px)]'}`}>
                  <table className="w-full min-w-[1070px] text-left border-collapse">
                    <thead className="sticky top-0 z-[1] bg-gray-50 border-b border-gray-200">
                      <tr>
                        <ReportSortHeader label="ID" sortKey="sopIdentifier" className="w-[110px]" />
                        <ReportSortHeader label="Title" sortKey="sopName" />
                        <ReportSortHeader label="Department" sortKey="department" className="w-[100px]" />
                        <th className="w-[110px] px-2 py-2 text-[10px] font-black uppercase tracking-wide text-gray-500">
                          Annexures
                        </th>
                        <ReportSortHeader label="Score" sortKey="overallScore" className="w-[90px]" />
                        <th
                          className="w-[70px] px-2 py-2 text-[10px] font-black uppercase tracking-wide text-gray-500"
                          title="Compliance engine version used for this analysis"
                        >
                          Version
                        </th>
                        <th
                          className="w-[95px] px-2 py-2 text-[10px] font-black uppercase tracking-wide text-gray-500"
                          title="Score from the latest Upload SOP & Re-run"
                        >
                          Re-run
                        </th>
                        <th
                          className="w-[120px] px-2 py-2 text-[10px] font-black uppercase tracking-wide text-gray-500"
                          title="Whether linked annexures were considered on the latest re-run"
                        >
                          Re-run annex.
                        </th>
                        <ReportSortHeader label="Status" sortKey="complianceStatus" className="w-[140px]" />
                        <ReportSortHeader label="Date" sortKey="analyzedAt" className="w-[90px]" />
                        <th className="w-[72px] px-2 py-2 text-[10px] font-black uppercase tracking-wide text-gray-500">
                          History
                        </th>
                        <th className="w-10 px-2 py-2" aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 bg-white">
                      {sortedReports.length === 0 ? (
                        <tr>
                          <td colSpan={12} className="px-4 py-10 text-center text-sm text-gray-500">
                            No reports match the selected filters.
                          </td>
                        </tr>
                      ) : (
                      sortedReports.map((report) => {
                        const isSelected = selectedReport?._id === report._id;
                        const annexStatus = resolveAnnexureStatus(report);
                        const lastRecheck = report.latestRecheck ?? null;
                        return (
                          <tr
                            key={report._id}
                            role="button"
                            tabIndex={0}
                            onClick={() => {
                              handleSelectReport(report);
                              setFilterStatus('all');
                              setFilterSeverity('all');
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                handleSelectReport(report);
                                setFilterStatus('all');
                                setFilterSeverity('all');
                              }
                            }}
                            className={`cursor-pointer transition-colors group ${
                              isSelected
                                ? 'bg-purple-50 ring-1 ring-inset ring-purple-300'
                                : 'hover:bg-purple-50/40'
                            }`}
                          >
                            <td className="px-3 py-2 align-middle">
                              <span className="inline-block text-purple-700 font-bold text-[11px] bg-purple-50 px-1.5 py-0.5 rounded border border-purple-100 font-mono whitespace-nowrap">
                                {report.sopIdentifier}
                              </span>
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <span
                                className={`block text-[11px] font-semibold uppercase leading-snug line-clamp-2 ${isSelected ? 'text-purple-700' : 'text-gray-700'}`}
                                title={report.sopName}
                              >
                                {report.sopName}
                              </span>
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <span
                                className="block text-[11px] font-medium text-gray-600 leading-snug line-clamp-2"
                                title={report.department || '—'}
                              >
                                {report.department?.trim() || '—'}
                              </span>
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <span
                                className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-black uppercase tracking-wide ${annexureStatusBadgeClass(annexStatus)}`}
                                title={annexureStatusTitle(report)}
                              >
                                <Paperclip className="h-2.5 w-2.5" />
                                {annexureStatusShortLabel(annexStatus)}
                              </span>
                            </td>
                            <td className="px-3 py-2 align-middle whitespace-nowrap">
                              <div className="flex items-center gap-1.5">
                                <span className={`w-2 h-2 rounded-full shrink-0 ${
                                  report.overallScore >= 7 ? 'bg-emerald-500' :
                                  report.overallScore >= 4 ? 'bg-amber-500' :
                                  'bg-rose-500'
                                }`} />
                                <span className={`text-sm font-black tabular-nums ${getScoreColor(report.overallScore)}`}>
                                  {report.overallScore}
                                </span>
                                <span className="text-[10px] text-gray-400 font-medium">/10</span>
                              </div>
                            </td>
                            <td className="px-3 py-2 align-middle whitespace-nowrap">
                              <span
                                className="inline-block px-1.5 py-0.5 rounded border border-violet-200 bg-violet-50 text-[9px] font-black uppercase tracking-wide text-violet-700"
                                title={`Analyzed with the ${engineVersionLabel(report.analysisEngineVersion)} compliance engine`}
                              >
                                {engineVersionLabel(report.analysisEngineVersion)}
                              </span>
                            </td>
                            <td className="px-3 py-2 align-middle whitespace-nowrap">
                              {lastRecheck ? (
                                <div
                                  className="flex items-center gap-1.5"
                                  title={
                                    lastRecheck.createdAt
                                      ? `Last re-run ${new Date(lastRecheck.createdAt).toLocaleString()}`
                                      : 'Latest Upload SOP & Re-run score'
                                  }
                                >
                                  <span className={`text-sm font-black tabular-nums ${getScoreColor(lastRecheck.score)}`}>
                                    {lastRecheck.score.toFixed(1)}
                                  </span>
                                  <span className="text-[10px] text-gray-400 font-medium">/10</span>
                                </div>
                              ) : (
                                <span className="text-[11px] text-gray-400">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2 align-middle">
                              {!lastRecheck ? (
                                <span className="text-[11px] text-gray-400">—</span>
                              ) : !lastRecheck.annexureStatusTracked ? (
                                <span
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-gray-200 bg-gray-50 text-[9px] font-black uppercase tracking-wide text-gray-600"
                                  title="Older re-run — annexure use was not recorded"
                                >
                                  Unknown
                                </span>
                              ) : lastRecheck.annexuresRead ? (
                                <span
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-emerald-200 bg-emerald-50 text-[9px] font-black uppercase tracking-wide text-emerald-800"
                                  title={
                                    lastRecheck.annexureLabels.length
                                      ? `Annexures considered: ${lastRecheck.annexureLabels.join(', ')}`
                                      : 'Annexures were considered on this re-run'
                                  }
                                >
                                  Yes
                                </span>
                              ) : (
                                <span
                                  className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-[9px] font-black uppercase tracking-wide text-amber-800"
                                  title="Annexures were not considered on this re-run"
                                >
                                  No
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 align-middle">
                              <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wide border whitespace-nowrap ${getStatusColor(report.complianceStatus)}`}>
                                {report.complianceStatus}
                              </span>
                            </td>
                            <td className="px-3 py-2 align-middle whitespace-nowrap">
                              <span className="text-[11px] text-gray-500 font-mono">
                                {new Date(report.analyzedAt).toLocaleDateString()}
                              </span>
                            </td>
                            <td className="px-2 py-2 align-middle" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={() => {
                                  setRecheckInitialView('history');
                                  setRecheckTarget({
                                    _id: report._id,
                                    sopIdentifier: report.sopIdentifier,
                                    sopName: report.sopName,
                                  });
                                  setRecheckOpen(true);
                                }}
                                className="inline-flex items-center gap-1 px-1.5 py-1 rounded-md text-[10px] font-bold text-purple-700 border border-purple-200 bg-purple-50 hover:bg-purple-100 transition-colors"
                                title="View re-check history"
                              >
                                <History className="h-3 w-3" />
                                History
                              </button>
                            </td>
                            <td className="px-2 py-2 align-middle" onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                onClick={(e) => handleDeleteReport(report._id, e)}
                                className="p-1 hover:bg-rose-50 text-gray-300 hover:text-rose-500 rounded opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                                title="Delete Report"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })
                      )}
                    </tbody>
                  </table>
                </div>
                </>
              )}
            </div>
            )}

            {selectedReport && (
              <div ref={reportExportRef} className={`${isFullScreen ? 'h-full' : 'xl:col-span-8'} flex flex-col gap-2 overflow-hidden animate-in fade-in slide-in-from-right-4 duration-300`}>

                <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-2.5 pt-1 pb-1.5 relative overflow-hidden flex-shrink-0">
                  {/* Row 1: back, SOP, guidelines, score, status, View Final SOP */}
                  <div className="flex flex-nowrap items-center justify-between gap-2">
                    <div className="flex flex-nowrap items-center gap-1.5 min-w-0 flex-1 overflow-x-auto">
                      <button
                        data-pdf-hide
                        onClick={() => {
                          setIsFullScreen(false);
                          setSelectedReport(null);
                        }}
                        className="p-1 bg-gray-50 hover:bg-gray-100 text-gray-500 rounded-md transition-all border border-gray-200 shrink-0"
                        title="Back to Generated Reports"
                      >
                        <ArrowLeft className="h-4 w-4" />
                      </button>
                      {selectedReport.sopName && (
                        <button
                          type="button"
                          onClick={() => setSopPreviewOpen(true)}
                          className="text-xs font-black text-gray-800 leading-tight shrink-0 whitespace-nowrap text-left hover:text-purple-700 hover:underline underline-offset-2 transition-colors"
                          title="Preview source SOP document"
                        >
                          {selectedReport.sopIdentifier ? `${selectedReport.sopIdentifier} — ` : ''}{selectedReport.sopName}
                        </button>
                      )}
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-black uppercase tracking-wide shrink-0 ${annexureStatusBadgeClass(resolveAnnexureStatus(selectedReport))}`}
                        title={annexureStatusTitle(selectedReport)}
                      >
                        <Paperclip className="h-2.5 w-2.5" />
                        {annexureStatusLabel(resolveAnnexureStatus(selectedReport))}
                      </span>
                      {displayGroupedFindings.length > 0 && (
                        <div className="flex flex-nowrap items-center gap-1 shrink-0">
                          {displayGroupedFindings.map((group) => {
                            const isActive = displayActiveGroupKey === group.key;
                            const chipLabel = findingsGroupView === 'guideline'
                              ? shortGuidelineLabel(group.key)
                              : `Sec ${group.key}`;
                            return (
                              <div
                                key={group.key}
                                className="relative"
                                onMouseEnter={() => setHoveredFolder(group.key)}
                                onMouseLeave={() => setHoveredFolder((v) => (v === group.key ? null : v))}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    groupRefs.current[group.key]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                                  }
                                  className={`flex items-center gap-0.5 px-1.5 py-px rounded text-[9px] font-bold border transition-colors ${
                                    isActive
                                      ? 'bg-purple-600 border-purple-600 text-white shadow-sm shadow-purple-200'
                                      : findingsGroupView === 'section'
                                        ? 'bg-purple-50 border-purple-200 text-purple-700 hover:bg-purple-100 hover:border-purple-300'
                                        : 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100 hover:border-blue-300'
                                  }`}
                                >
                                  {findingsGroupView === 'guideline' ? (
                                    <BookOpen className="h-2.5 w-2.5" />
                                  ) : (
                                    <Layers className="h-2.5 w-2.5" />
                                  )}
                                  {chipLabel} ({group.items.length})
                                </button>
                                {hoveredFolder === group.key && (
                                  <div className="absolute left-0 top-full mt-1 z-20 whitespace-nowrap px-2.5 py-1.5 rounded-lg bg-gray-900 text-white text-[11px] font-semibold shadow-lg">
                                    {findingsGroupView === 'guideline' ? group.key : `Section ${group.key}`} · {group.items.length} result{group.items.length !== 1 ? 's' : ''}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-nowrap items-center gap-2 shrink-0">
                      <div className="flex items-center gap-1.5">
                        <div className="flex items-baseline gap-0.5">
                          <span className={`text-2xl font-black tracking-tighter leading-none ${getScoreColor(selectedReport.overallScore)}`}>
                            {selectedReport.overallScore}
                          </span>
                          <span className="text-xs font-bold text-gray-400">/10</span>
                        </div>
                        <div className="h-5 w-px bg-gray-200" />
                        <div>
                          <p className="text-purple-600 text-[9px] font-black uppercase tracking-[0.15em] leading-none">{selectedReport.department}</p>
                          <p className={`text-xs font-black tracking-tight leading-tight ${getScoreColor(selectedReport.overallScore)}`}>
                            {selectedReport.complianceStatus}
                          </p>
                        </div>
                        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                          selectedReport.overallScore >= 7 ? 'bg-emerald-500' :
                          selectedReport.overallScore >= 4 ? 'bg-amber-500' :
                          'bg-rose-500'
                        }`} />
                      </div>
                      <button
                        data-pdf-hide
                        onClick={handleExportPdf}
                        disabled={exportingPdf}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold transition-all shrink-0 bg-rose-600 text-white hover:bg-rose-700 shadow-sm shadow-rose-200 disabled:opacity-60 disabled:cursor-not-allowed"
                        title="Opens print dialog — choose Save as PDF for the same layout with selectable text"
                      >
                        {exportingPdf ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Exporting…
                          </>
                        ) : (
                          <>
                            <FileDown className="h-3.5 w-3.5" />
                            Export PDF
                          </>
                        )}
                      </button>
                      <button
                        data-pdf-hide
                        onClick={() => {
                          if (!selectedReport) return;
                          setRecheckInitialView('run');
                          setRecheckTarget({
                            _id: selectedReport._id,
                            sopIdentifier: selectedReport.sopIdentifier,
                            sopName: selectedReport.sopName,
                          });
                          setRecheckOpen(true);
                        }}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold transition-all shrink-0 bg-purple-600 text-white hover:bg-purple-700 shadow-sm shadow-purple-200"
                        title="Upload a manually revised SOP and re-run the AI compliance check"
                      >
                        <Upload className="h-3.5 w-3.5" />
                        Upload SOP &amp; Re-run
                      </button>
                      <button
                        data-pdf-hide
                        onClick={() => setFinalSopOpen(true)}
                        disabled={actionableFixes.length === 0}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-bold transition-all shrink-0 ${
                          actionableFixes.length > 0
                            ? 'bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm shadow-emerald-200'
                            : 'bg-gray-100 text-gray-400 cursor-not-allowed border border-gray-200'
                        }`}
                        title="Preview all proposed changes and export the final corrected SOP"
                      >
                        <ScrollText className="h-3.5 w-3.5" />
                        View Final SOP
                        {actionableFixes.length > 0 && (
                          <span className="px-1 py-0.5 bg-white/30 rounded text-[9px]">
                            {approvedFixes.length}/{actionableFixes.length} approved
                          </span>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 pt-1 mt-1 border-t border-gray-100">
                    <button
                      data-pdf-hide
                      onClick={toggleSelectAllFindings}
                      className="flex items-center gap-2 text-sm font-semibold text-gray-600 hover:text-gray-900 transition-colors shrink-0"
                    >
                      {allFindingsSelected ? (
                        <CheckSquare className="h-5 w-5 text-purple-600" />
                      ) : someFindingsSelected ? (
                        <div className="h-5 w-5 rounded border-2 border-purple-500 bg-purple-100 flex items-center justify-center">
                          <div className="h-2 w-2 bg-purple-600 rounded-sm" />
                        </div>
                      ) : (
                        <Square className="h-5 w-5 text-gray-400" />
                      )}
                      {allFindingsSelected ? 'Deselect All' : 'Select All Results'}
                      {someFindingsSelected && (
                        <span className="ml-1 px-2 py-0.5 bg-purple-100 text-purple-700 text-xs font-bold rounded-full border border-purple-200">
                          {selectedFindingIds.size} selected
                        </span>
                      )}
                    </button>

                    <div className="flex flex-wrap items-center justify-center gap-1.5 flex-1 min-w-0">
                      <div className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-blue-200 bg-blue-50">
                        <ClipboardList className="h-3.5 w-3.5 text-blue-600 shrink-0" />
                        <span className="text-[9px] font-bold text-blue-600 uppercase">Total</span>
                        <span className="text-sm font-black text-gray-800 tabular-nums">{reportStatusTotals.total}</span>
                      </div>

                      <button
                        type="button"
                        onClick={() => setFilterStatus(filterStatus === 'compliant' ? 'all' : 'compliant')}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded border transition-all ${
                          filterStatus === 'compliant' ? 'bg-emerald-100 border-emerald-400 ring-1 ring-emerald-300' : 'bg-emerald-50 border-emerald-200 hover:border-emerald-400'
                        }`}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
                        <span className="text-[9px] font-bold text-emerald-700 uppercase">Compliant</span>
                        <span className="text-sm font-black text-emerald-700 tabular-nums">{reportStatusTotals.compliant}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setFilterStatus(filterStatus === 'partial' ? 'all' : 'partial')}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded border transition-all ${
                          filterStatus === 'partial' ? 'bg-amber-100 border-amber-400 ring-1 ring-amber-300' : 'bg-amber-50 border-amber-200 hover:border-amber-400'
                        }`}
                      >
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                        <span className="text-[9px] font-bold text-amber-700 uppercase">Partial</span>
                        <span className="text-sm font-black text-amber-700 tabular-nums">
                          {reportStatusTotals.partial}
                          <span className="text-[9px] font-bold text-amber-500 ml-0.5">({statusPct(reportStatusTotals.partial)}%)</span>
                        </span>
                      </button>

                      <button
                        type="button"
                        onClick={() => setFilterStatus(filterStatus === 'non-compliant' ? 'all' : 'non-compliant')}
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded border transition-all ${
                          filterStatus === 'non-compliant' ? 'bg-rose-100 border-rose-400 ring-1 ring-rose-300' : 'bg-rose-50 border-rose-200 hover:border-rose-400'
                        }`}
                      >
                        <XCircle className="h-3.5 w-3.5 text-rose-600 shrink-0" />
                        <span className="text-[9px] font-bold text-rose-700 uppercase">Non-Compliant</span>
                        <span className="text-sm font-black text-rose-700 tabular-nums">
                          {reportStatusTotals.nonCompliant}
                          <span className="text-[9px] font-bold text-rose-400 ml-0.5">({statusPct(reportStatusTotals.nonCompliant)}%)</span>
                        </span>
                      </button>

                      <div className="hidden sm:block h-5 w-px bg-gray-200 mx-0.5" />

                      {([
                        { key: 'critical' as const, label: 'Critical', count: reportSeverityTotals.critical, active: 'bg-red-100 border-red-400 ring-1 ring-red-300', idle: 'bg-red-50 border-red-200 hover:border-red-400', text: 'text-red-700' },
                        { key: 'major' as const, label: 'Major', count: reportSeverityTotals.major, active: 'bg-orange-100 border-orange-400 ring-1 ring-orange-300', idle: 'bg-orange-50 border-orange-200 hover:border-orange-400', text: 'text-orange-700' },
                        { key: 'minor' as const, label: 'Minor', count: reportSeverityTotals.minor, active: 'bg-yellow-100 border-yellow-400 ring-1 ring-yellow-300', idle: 'bg-yellow-50 border-yellow-200 hover:border-yellow-400', text: 'text-yellow-800' },
                      ]).map((opt) => (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setFilterSeverity(filterSeverity === opt.key ? 'all' : opt.key)}
                          className={`flex items-center gap-1 px-1.5 py-0.5 rounded border transition-all ${
                            filterSeverity === opt.key ? opt.active : opt.idle
                          }`}
                          title={`Show ${opt.label.toLowerCase()} severity findings`}
                        >
                          <span className={`text-[9px] font-bold uppercase ${opt.text}`}>{opt.label}</span>
                          <span className={`text-sm font-black tabular-nums ${opt.text}`}>{opt.count}</span>
                        </button>
                      ))}
                    </div>

                    <div data-pdf-hide className="flex flex-wrap items-center gap-1.5 shrink-0">
                      <div className="flex items-center rounded-md border border-gray-200 bg-white overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setFindingsGroupView('guideline')}
                          className={`flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                            findingsGroupView === 'guideline'
                              ? 'bg-blue-600 text-white'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                          title="Group findings by regulatory guideline"
                        >
                          <BookOpen className="h-3 w-3" />
                          Guideline
                        </button>
                        <button
                          type="button"
                          onClick={() => setFindingsGroupView('section')}
                          className={`flex items-center gap-1 px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors border-l border-gray-200 ${
                            findingsGroupView === 'section'
                              ? 'bg-purple-600 text-white'
                              : 'text-gray-600 hover:bg-gray-50'
                          }`}
                          title="Group findings by SOP section"
                        >
                          <Layers className="h-3 w-3" />
                          Section
                        </button>
                      </div>

                      <div className="relative" ref={findingsSortRef}>
                        <button
                          type="button"
                          onClick={() => setFindingsSortOpen((v) => !v)}
                          className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[10px] font-bold uppercase tracking-wide transition-colors ${
                            findingsSortOpen
                              ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                              : 'bg-white border-gray-200 text-gray-600 hover:border-indigo-300 hover:text-indigo-700'
                          }`}
                          title="Sort findings"
                        >
                          <ArrowUpDown className="h-3 w-3" />
                          Sort
                          <span className="text-[9px] font-black text-indigo-500 normal-case">
                            {FINDINGS_SORT_LABELS[findingsSortKey]} {findingsSortDir === 'asc' ? '↑' : '↓'}
                          </span>
                        </button>
                        {findingsSortOpen && (
                          <div className="absolute right-0 top-full mt-1 z-30 min-w-[10.5rem] rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                            {(Object.keys(FINDINGS_SORT_LABELS) as FindingsSortKey[]).map((key) => {
                              const active = findingsSortKey === key;
                              return (
                                <button
                                  key={key}
                                  type="button"
                                  onClick={() => toggleFindingsSort(key)}
                                  className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[11px] font-semibold transition-colors ${
                                    active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'
                                  }`}
                                >
                                  <span>{FINDINGS_SORT_LABELS[key]}</span>
                                  {active && (
                                    <span className="text-[10px] font-black text-indigo-500">
                                      {findingsSortDir === 'asc' ? '↑' : '↓'}
                                    </span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>

                    <button
                      data-pdf-hide
                      onClick={() => setShowConsolidatedSummary(true)}
                      disabled={selectedFindingIds.size === 0}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold transition-all shrink-0 ${
                        selectedFindingIds.size > 0
                          ? 'bg-purple-600 text-white hover:bg-purple-700 shadow-md shadow-purple-200'
                          : 'bg-gray-100 text-gray-400 cursor-not-allowed border border-gray-200'
                      }`}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Generate Consolidated Summary
                      {selectedFindingIds.size > 0 && (
                        <span className="ml-1 px-1.5 py-0.5 bg-white/30 rounded text-[10px]">{selectedFindingIds.size}</span>
                      )}
                    </button>
                  </div>
                </div>

                <div ref={findingsScrollRef} className="flex-1 overflow-y-auto pr-2 space-y-1 pb-6">

                  <div>
                    <div className="space-y-2 min-h-[200px] pl-1">
                      {loadingFullReport || findingsPending ? (
                        <div className="text-center py-20">
                          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600 mx-auto mb-3" />
                          <p className="text-gray-500 text-sm">Loading full report...</p>
                        </div>
                      ) : fullReportLoadError ? (
                        <div className="text-center py-20">
                          <p className="text-rose-600 text-sm mb-3">{fullReportLoadError}</p>
                          <button
                            type="button"
                            onClick={() => selectedReport && handleSelectReport(selectedReport)}
                            className="text-purple-600 font-medium hover:underline text-sm"
                          >
                            Retry
                          </button>
                        </div>
                      ) : selectedReport.findings && selectedReport.findings.length > 0 ? (
                        displayGroupedFindings.map((group) => {
                          const isGroupOpen = !collapsedFindingGroups.has(group.key);
                          return (
                          <div key={group.key} className="space-y-1">
                            <div
                              ref={(el) => { groupRefs.current[group.key] = el; }}
                              data-group-key={group.key}
                              data-group-header
                              className="flex flex-wrap w-fit items-center gap-1 scroll-mt-2"
                            >
                              <button
                                type="button"
                                data-pdf-hide
                                onClick={() => toggleFindingGroup(group.key)}
                                className="p-px rounded border border-gray-200 bg-white text-gray-500 hover:text-blue-700 hover:border-blue-300 transition-colors shrink-0"
                                aria-expanded={isGroupOpen}
                                aria-label={isGroupOpen ? `Collapse ${group.key}` : `Expand ${group.key}`}
                              >
                                {isGroupOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => toggleFindingGroup(group.key)}
                                className={`flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide transition-colors ${
                                  findingsGroupView === 'section'
                                    ? 'text-purple-800 hover:text-purple-600'
                                    : 'text-blue-800 hover:text-blue-600'
                                }`}
                              >
                                {findingsGroupView === 'section' ? (
                                  <>
                                    <Layers className="h-2.5 w-2.5" />
                                    Section {group.key}
                                  </>
                                ) : (
                                  <>
                                    <BookOpen className="h-2.5 w-2.5" />
                                    {shortGuidelineLabel(group.key)}
                                  </>
                                )}
                              </button>
                              <span className="text-[9px] text-gray-400 font-semibold shrink-0">
                                {group.items.length} result{group.items.length !== 1 ? 's' : ''}
                              </span>
                              {isGroupOpen && group.items[0] && (
                                <div
                                  ref={(el) => { sectionRefs.current[`${group.key}::${group.items[0].subLabel}`] = el; }}
                                  className="shrink-0"
                                >
                                <button
                                  type="button"
                                  onClick={() => scrollToFindingSubGroup(group.key, group.items[0].subLabel)}
                                  className={`flex items-center gap-0.5 px-1 py-px rounded text-[9px] font-bold uppercase tracking-wide transition-colors cursor-pointer shrink-0 ${
                                    findingsGroupView === 'section'
                                      ? 'bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 hover:border-blue-300'
                                      : 'bg-purple-50 border border-purple-200 text-purple-700 hover:bg-purple-100 hover:border-purple-300'
                                  }`}
                                  title={findingsGroupView === 'section' ? group.items[0].subLabel : `Go to section ${group.items[0].subLabel}`}
                                >
                                  {findingsGroupView === 'section' ? (
                                    <>
                                      <BookOpen className="h-2 w-2" />
                                      {group.items[0].subLabel}
                                    </>
                                  ) : (
                                    <>Section {group.items[0].subLabel}</>
                                  )}
                                </button>
                                </div>
                              )}
                            </div>

                            {isGroupOpen && group.items.map(({ f, i, serial, subLabel, isNewSubGroup }, idx) => (
                              <div key={f.gapId ?? i}>
                                {isNewSubGroup && idx > 0 && (
                                  <div
                                    ref={(el) => { sectionRefs.current[`${group.key}::${subLabel}`] = el; }}
                                    className="inline-flex w-fit items-center gap-1 scroll-mt-2"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => scrollToFindingSubGroup(group.key, subLabel)}
                                      className={`flex items-center gap-0.5 px-1 py-px rounded text-[9px] font-bold uppercase tracking-wide transition-colors cursor-pointer ${
                                        findingsGroupView === 'section'
                                          ? 'bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 hover:border-blue-300'
                                          : 'bg-purple-50 border border-purple-200 text-purple-700 hover:bg-purple-100 hover:border-purple-300'
                                      }`}
                                      title={findingsGroupView === 'section' ? subLabel : `Go to section ${subLabel}`}
                                    >
                                      {findingsGroupView === 'section' ? (
                                        <>
                                          <BookOpen className="h-2 w-2" />
                                          {subLabel}
                                        </>
                                      ) : (
                                        <>Section {subLabel}</>
                                      )}
                                    </button>
                                  </div>
                                )}
                                <div
                                  className={`transition-all duration-200 rounded-xl ${
                                    selectedFindingIds.has(i) ? 'ring-2 ring-purple-400 ring-offset-1 ring-offset-gray-50' : ''
                                  }`}
                                >
                                <FindingCard
                                  finding={f}
                                  sopId={selectedReport.sopId ?? sops.find(s => s.identifier === selectedReport.sopIdentifier)?._id}
                                  reportContext={{
                                    sopIdentifier: selectedReport.sopIdentifier,
                                    sopName: selectedReport.sopName,
                                    department: selectedReport.department,
                                    overallScore: selectedReport.overallScore,
                                    complianceStatus: selectedReport.complianceStatus,
                                  }}
                                  index={i}
                                  serialNumber={serial}
                                  defaultExpanded={true}
                                  isSelected={selectedFindingIds.has(i)}
                                  onToggleSelect={(idx) => {
                                    const next = new Set(selectedFindingIds);
                                    if (next.has(idx)) next.delete(idx);
                                    else next.add(idx);
                                    setSelectedFindingIds(next);
                                  }}
                                  onToggleApplicable={handleToggleApplicable}
                                  isApplicable={isApprovedFix(f)}
                                  showCheckbox
                                  onReviewStatusChange={f.gapId ? handleReviewStatusChange : undefined}
                                  onApplyFix={f.gapId ? handleApplyFix : undefined}
                                  applyingFix={applyingFixGapId === f.gapId}
                                  onSectionClick={() => scrollToFindingSubGroup(group.key, subLabel)}
                                  traceabilityMatrix={selectedReport.traceabilityMatrix}
                                />
                                </div>
                              </div>
                            ))}
                          </div>
                          );
                        })
                      ) : (
                        <div className="text-center py-20 text-gray-400">
                          <p>No findings found.</p>
                        </div>
                      )}

                      {visibleFindings.length === 0 && selectedReport.findings && selectedReport.findings.length > 0 && (
                        <div className="text-center py-20">
                          <p className="text-gray-400 mb-2">No findings match the current filters</p>
                          <div className="flex gap-2 justify-center mt-3">
                            {filterStatus !== 'all' && (
                              <button
                                onClick={() => setFilterStatus('all')}
                                className="text-purple-600 font-medium hover:underline text-sm"
                              >
                                Clear Status Filter
                              </button>
                            )}
                            {filterSeverity !== 'all' && (
                              <button
                                onClick={() => setFilterSeverity('all')}
                                className="text-purple-600 font-medium hover:underline text-sm"
                              >
                                Clear Severity Filter
                              </button>
                            )}
                            {filterGuideline !== 'all' && (
                              <button
                                onClick={() => setFilterGuideline('all')}
                                className="text-purple-600 font-medium hover:underline text-sm"
                              >
                                Clear Guideline Filter
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Consolidated Summary Modal */}
      {showConsolidatedSummary && (
        <div className={`fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm transition-all duration-300 ${isSummaryFullScreen ? 'p-0' : 'p-4 pt-12'}`}>
          <div className={`bg-white border border-gray-200 shadow-2xl flex flex-col transition-all duration-300 ${
            isSummaryFullScreen
              ? 'fixed inset-0 w-screen h-screen rounded-none'
              : 'w-full max-w-4xl max-h-[85vh] rounded-2xl'
          }`}>
            <div className={`flex flex-shrink-0 items-center justify-between px-6 py-4 border-b border-gray-100 bg-purple-50 ${isSummaryFullScreen ? '' : 'rounded-t-2xl'}`}>
              <div className="flex items-center gap-3">
                <div className="p-2 bg-purple-100 rounded-xl">
                  <Sparkles className="h-5 w-5 text-purple-600" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-gray-800">Consolidated Compliance Summary</h2>
                  <p className="text-xs text-gray-500">
                    {consolidatedSections.length} section{consolidatedSections.length !== 1 ? 's' : ''} • {selectedFindingIds.size} findings merged
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsSummaryFullScreen(!isSummaryFullScreen)}
                  className="p-2 hover:bg-gray-100 rounded-xl text-gray-400 hover:text-gray-700 transition-all mr-2"
                  title={isSummaryFullScreen ? 'Exit Full Screen' : 'Full Screen'}
                >
                  {isSummaryFullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                </button>
                <button
                  onClick={() => {
                    const lines: string[] = [
                      `CONSOLIDATED COMPLIANCE SUMMARY — ${selectedReport?.sopName || ''}`,
                      `Generated: ${new Date().toLocaleString()}`,
                      `Sections: ${consolidatedSections.length} | Findings: ${selectedFindingIds.size}`,
                      '', '═'.repeat(60), '',
                    ];
                    consolidatedSections.forEach((sec, idx) => {
                      lines.push(`SECTION ${sec.sectionKey}${sec.isMulti ? ` (${sec.findings.length} changes combined)` : ''}`);
                      lines.push(`Sources: ${sec.sources.join(', ')}`);
                      if (sec.clauses.length) lines.push(`Clauses: ${sec.clauses.join(', ')}`);
                      lines.push('');
                      lines.push(sec.combinedAction);
                      if (sec.combinedSuggestion) {
                        lines.push('');
                        lines.push('PROPOSED VERBIAGE:');
                        lines.push(sec.combinedSuggestion);
                      }
                      if (idx < consolidatedSections.length - 1) {
                        lines.push('');
                        lines.push('─'.repeat(60));
                        lines.push('');
                      }
                    });
                    navigator.clipboard.writeText(lines.join('\n'));
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-xs font-bold rounded-xl transition-all"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy All
                </button>
                <button
                  onClick={() => setShowConsolidatedSummary(false)}
                  className="p-2 hover:bg-gray-100 rounded-xl text-gray-400 hover:text-gray-700 transition-all"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>
            <div className="p-6 space-y-5 overflow-y-auto flex-1 bg-gray-50">
              {consolidatedSections.map((sec) => (
                <ConsolidatedSectionCard key={sec.sectionKey} sec={sec} />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Final SOP Modal — aggregates all actionable fixes */}
      {finalSopOpen && selectedReport && (() => {
        const resolvedSopId = selectedReport.sopId ?? sops.find(s => s.identifier === selectedReport.sopIdentifier)?._id ?? undefined;
        const finalSopFixes = approvedFixes.map((f) => ({
          originalText: f.sopTextSnippet!,
          replacementText: f.suggestedText?.trim() || f.suggestedAction!,
          section: f.sopSectionAffected ?? '',
          clauseNumber: f.clauseNumber ?? '',
          clauseTitle: f.clauseTitle ?? '',
        }));
        return (
          <FinalSopModal
            isOpen={finalSopOpen}
            onClose={() => setFinalSopOpen(false)}
            sopId={resolvedSopId}
            sopIdentifier={selectedReport.sopIdentifier}
            sopName={selectedReport.sopName}
            department={selectedReport.department}
            fixes={finalSopFixes}
            pendingApprovalCount={pendingApprovalFixCount}
            onApproveAll={handleApproveAllFixes}
            onRerunCompliance={handleRerunComplianceForReport}
            rerunning={rerunningCompliance}
          />
        );
      })()}

      {sopPreviewOpen && selectedReport && (
        <SopSourcePreviewModal
          isOpen={sopPreviewOpen}
          onClose={() => setSopPreviewOpen(false)}
          sopIdentifier={selectedReport.sopIdentifier}
          sopName={selectedReport.sopName}
          language={sops.find((s) => s.identifier === selectedReport.sopIdentifier)?.language ?? 'English'}
        />
      )}

      {recheckOpen && recheckTarget && (
        <RecheckSopModal
          key={`${recheckTarget._id}-${recheckInitialView}`}
          isOpen={recheckOpen}
          onClose={() => {
            setRecheckOpen(false);
            setRecheckTarget(null);
            setRecheckInitialView('run');
          }}
          reportId={recheckTarget._id}
          sopIdentifier={recheckTarget.sopIdentifier}
          sopName={recheckTarget.sopName}
          initialView={recheckInitialView}
          onRechecked={() => {
            void fetchReports();
            if (selectedReport?._id === recheckTarget._id) {
              handleSelectReport(selectedReport);
            }
          }}
        />
      )}
    </div>
  );
}
