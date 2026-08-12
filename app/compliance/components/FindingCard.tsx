'use client';

import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
const SopDraftModal = dynamic(() => import('@/components/compliance/SopDraftModal'), { ssr: false });
const GuidelinePdfModal = dynamic(() => import('@/components/compliance/GuidelinePdfModal'), { ssr: false });
const DraggablePopup = dynamic(() => import('@/components/compliance/DraggablePopup'), { ssr: false });
import {
  ChevronDown,
  ChevronUp,
  Copy,
  CheckCircle,
  BookOpen,
  FileText,
  AlertTriangle,
  Target,
  CheckCircle2,
  ExternalLink,
  ShieldAlert,
  Search,
  XCircle,
  MapPin,
  FileSearch,
  Pencil,
  Check,
  X as XIcon,
  ScrollText,
  Loader2,
  History,
} from 'lucide-react';
import {
  formatConfidence,
  getComplianceLevelBadge,
  getComplianceLevelBorder,
  getComplianceStatusColor,
  getScoreColorClass,
  getSeverityBadge,
  buildImpactAnalysis,
  buildImpactSummary,
  buildComplianceSummary,
  buildComplianceRationale,
} from '@/lib/complianceFormatter';
import { cleanFindingText, buildProposedVerbiage } from '@/lib/ComplianceFindingValidator';
import { extractGuidelineClauseDisplay } from '@/lib/guidelineClauseDisplay';
import { isGuidelineBoilerplate } from '@/lib/guidelineBoilerplate';
import type { PdfSearchResolution } from '@/lib/guidelineDocSearch';
import { resolveGuidelinePdfSearch } from '@/lib/guidelinePdfResolveClient';
import { enqueuePdfResolve } from '@/lib/guidelinePdfResolveQueue';
import {
  getCachedPdfResolution,
  pdfResolutionCacheKey,
  setCachedPdfResolution,
} from '@/lib/guidelinePdfResolutionCache';
import { acceptPdfResolution } from '@/lib/guidelinePdfResolutionValidate';

export interface FindingCardProps {
  finding: {
    _id?: string;
    guidelineName: string;
    folderName?: string;
    pdfName?: string;
    clauseNumber: string;
    clauseTitle: string;
    clauseText?: string;
    complianceLevel: 'compliant' | 'partial' | 'non-compliant' | 'not-applicable' | 'analysis-failed';
    matchConfidence: number;
    issueSeverity?: 'critical' | 'major' | 'minor' | 'informational';
    issueType?: string;
    sopSectionAffected?: string;
    mismatchExplanation?: string;
    highlightedIssue?: string;
    impactAnalysis?: string;
    sopTextSnippet?: string;
    guidelineRequirement?: string;
    suggestedAction?: string;
    suggestedText?: string;
    estimatedEffort?: 'low' | 'medium' | 'high';
    priority?: number;
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
    guidelineSearchPhrase?: string;
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
  };
  sopId?: string;
  reportContext?: {
    sopIdentifier: string;
    sopName: string;
    department: string;
    overallScore: number;
    complianceStatus: string;
  };
  index?: number;
  serialNumber?: number;
  isSelected?: boolean;
  onToggleSelect?: (idx: number) => void;
  onToggleApplicable?: (id: string, checked: boolean) => void;
  isApplicable?: boolean;
  onReviewStatusChange?: (id: string, status: 'pending' | 'accepted' | 'disputed' | 'implemented') => void;
  onApplyFix?: (gapId: string, finding: FindingCardProps['finding']) => Promise<void>;
  applyingFix?: boolean;
  showCheckbox?: boolean;
  defaultExpanded?: boolean;
  onSectionClick?: () => void;
  traceabilityMatrix?: TraceabilityMatrixEntry[];
  /** Re-check mode: shows the revised-SOP text as "Current SOP" and adds a box for the newly-found gap. */
  recheckOverride?: {
    currentSopText?: string;
    /** Gap the re-check newly identified in the revised SOP (shown in addition to the original gap). */
    newGap?: string;
  };
}

export interface TraceabilityMatrixEntry {
  clauseNumber: string;
  clauseTitle: string;
  clauseText: string;
  guidelineName: string;
  folderName: string;
}

function resolveGuidelineSectionText(
  finding: FindingCardProps['finding'],
  matrix?: TraceabilityMatrixEntry[],
): string {
  const direct = finding.clauseText?.trim();
  if (direct) return direct;

  if (matrix?.length) {
    const folderKey = (finding.folderName || finding.guidelineName || '').toLowerCase();
    const match = matrix.find((m) => {
      if (m.clauseNumber !== finding.clauseNumber) return false;
      const mKey = (m.folderName || m.guidelineName || '').toLowerCase();
      return !folderKey || mKey === folderKey || m.guidelineName === finding.guidelineName;
    });
    if (match?.clauseText?.trim()) return match.clauseText.trim();
  }

  return finding.guidelineRequirement?.trim() || '';
}

function findingId(finding: FindingCardProps['finding'], index?: number): string {
  return finding.gapId ?? finding._id ?? `finding-${index ?? finding.clauseNumber}`;
}

function extractSectionNumber(section?: string): string {
  if (!section?.trim()) return '';
  const m = section.match(/(\d+(?:\.\d+)*)/);
  return m ? m[1] : section.trim();
}

function categoryBadge(category?: string): { label: string; className: string } | null {
  switch (category) {
    case 'Critical Non-Compliance':
      return { label: 'Critical Non-Compliance', className: 'bg-red-100 text-red-800 border-red-300' };
    case 'Major Gap':
      return { label: 'Major Gap', className: 'bg-orange-100 text-orange-800 border-orange-300' };
    case 'Minor Gap':
      return { label: 'Minor Gap', className: 'bg-yellow-100 text-yellow-800 border-yellow-300' };
    case 'Improvement Opportunity':
      return { label: 'Improvement Opportunity', className: 'bg-sky-100 text-sky-800 border-sky-300' };
    case 'Best Practice Recommendation':
      return { label: 'Best Practice', className: 'bg-slate-100 text-slate-700 border-slate-300' };
    default:
      return null;
  }
}

function riskBadge(risk?: string): { label: string; className: string } | null {
  switch (risk) {
    case 'Critical':
      return { label: 'Critical Risk', className: 'bg-red-600 text-white border-red-700' };
    case 'Major':
      return { label: 'Major Risk', className: 'bg-orange-500 text-white border-orange-600' };
    case 'Minor':
      return { label: 'Minor Risk', className: 'bg-yellow-500 text-white border-yellow-600' };
    case 'Improvement':
      return { label: 'Advisory', className: 'bg-sky-500 text-white border-sky-600' };
    default:
      return null;
  }
}

function evidenceStrengthBadge(strength?: string): { label: string; className: string } | null {
  switch (strength) {
    case 'strong':
      return { label: 'Strong evidence', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
    case 'moderate':
      return { label: 'Moderate evidence', className: 'bg-amber-50 text-amber-700 border-amber-200' };
    case 'weak':
      return { label: 'Weak evidence', className: 'bg-orange-50 text-orange-700 border-orange-200' };
    case 'none':
      return { label: 'No evidence', className: 'bg-rose-50 text-rose-700 border-rose-200' };
    default:
      return null;
  }
}

function isMeaningful(text?: string): boolean {
  if (!text?.trim()) return false;
  return !/^(none|n\/a|na|not\s+found|not\s+applicable|-)$/i.test(text.trim());
}

/**
 * Split prose text into bullet-ready strings.
 * Priority: explicit \n separators → sentence boundaries → single item.
 */
function toBullets(text: string): string[] {
  if (!text.trim()) return [];

  // Already newline-separated (from buildImpactAnalysis)
  if (text.includes('\n')) {
    return text.split('\n').map(s => s.trim()).filter(Boolean);
  }

  // Split on sentence boundaries: ". " followed by a capital letter or known label
  const sentences = text
    .split(/(?<=[\.\!\?])\s+(?=[A-Z"'(])/)
    .map(s => s.trim())
    .filter(Boolean);

  return sentences.length > 1 ? sentences : [text.trim()];
}

function BulletList({ text, className }: { text: string; className?: string }) {
  const items = toBullets(text);
  if (items.length <= 1) {
    return <p className={`text-xs text-gray-900 leading-snug ${className ?? ''}`}>{text}</p>;
  }
  return (
    <ul className={`space-y-1 ${className ?? ''}`}>
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-1.5 text-xs text-gray-900 leading-snug">
          <span className="mt-1.5 h-1 w-1 rounded-full bg-current shrink-0 opacity-50" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

function applicabilityBadge(applicability?: string): { label: string; className: string } | null {
  switch (applicability) {
    case 'applicable':
      return { label: 'Applicable', className: 'bg-blue-50 text-blue-700 border-blue-200' };
    case 'partially-applicable':
      return { label: 'Partially Applicable', className: 'bg-amber-50 text-amber-700 border-amber-200' };
    case 'not-applicable':
      return { label: 'N/A', className: 'bg-slate-100 text-slate-600 border-slate-200' };
    default:
      return null;
  }
}

function levelOutlineBadge(level: string): { label: string; className: string } {
  switch (level) {
    case 'compliant':
      return { label: 'Compliant', className: 'border-emerald-300 text-emerald-700 bg-white' };
    case 'partial':
      return { label: 'Partially Compliant', className: 'border-amber-300 text-amber-700 bg-white' };
    case 'non-compliant':
      return { label: 'Non-Compliant', className: 'border-rose-300 text-rose-700 bg-white' };
    case 'not-applicable':
      return { label: 'N/A', className: 'border-slate-300 text-slate-600 bg-white' };
    default:
      return { label: 'Analysis Failed', className: 'border-gray-300 text-gray-600 bg-white' };
  }
}

function severityOutlineBadge(severity: string): { label: string; className: string } {
  switch (severity) {
    case 'critical':
      return { label: 'Critical', className: 'border-red-400 text-red-700 bg-white' };
    case 'major':
      return { label: 'Major', className: 'border-orange-400 text-orange-700 bg-white' };
    case 'minor':
      return { label: 'Minor', className: 'border-yellow-400 text-yellow-700 bg-white' };
    default:
      return { label: 'Info', className: 'border-blue-300 text-blue-700 bg-white' };
  }
}

function confidenceColor(pct: number): string {
  if (pct >= 85) return 'text-emerald-600';
  if (pct >= 60) return 'text-amber-600';
  return 'text-rose-600';
}

function scopeOwnerLabel(owner?: string): string {
  switch (owner) {
    case 'referenced-sop': return 'Owned by a referenced SOP';
    case 'department-procedure': return 'Owned by a department procedure';
    case 'quality-system': return 'Owned by a quality-system procedure';
    case 'current-sop': return 'Owned by this SOP';
    default: return '';
  }
}

export default function FindingCard({
  finding,
  sopId,
  reportContext,
  index,
  serialNumber,
  isSelected,
  onToggleSelect,
  onToggleApplicable,
  isApplicable,
  onReviewStatusChange,
  onApplyFix,
  applyingFix = false,
  showCheckbox = false,
  defaultExpanded = false,
  onSectionClick,
  traceabilityMatrix,
  recheckOverride,
}: FindingCardProps) {
  const isActionable =
    finding.complianceLevel === 'partial' || finding.complianceLevel === 'non-compliant';
  const isCompliant = finding.complianceLevel === 'compliant';

  const [expanded, setExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const [copiedSearch, setCopiedSearch] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [guidelinePdfOpen, setGuidelinePdfOpen] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [rewriteText, setRewriteText] = useState('');
  const [previousSopOpen, setPreviousSopOpen] = useState(false);

  const levelBadge = getComplianceLevelBadge(finding.complianceLevel);
  const severityBadge = getSeverityBadge(finding.issueSeverity ?? 'informational');
  const levelBorder = getComplianceLevelBorder(finding.complianceLevel);
  const confidence = formatConfidence(finding.matchConfidence);
  const id = findingId(finding, index);

  const catBadge = categoryBadge(finding.findingCategory);
  const rBadge = riskBadge(finding.riskLevel);
  const evBadge = evidenceStrengthBadge(finding.evidenceStrength);
  const evidenceFound = finding.evidenceFound?.trim();
  const evidenceMissing = finding.evidenceMissing?.trim();
  const guidelineRef = finding.guidelineReference?.trim();
  const isGmp = finding.findingType === 'gmp-expectation';
  const isCrossSop = finding.findingType === 'cross-sop-dependency';
  const appBadge = applicabilityBadge(finding.applicability);
  const scopeLabel = scopeOwnerLabel(finding.scopeOwner);
  const whyApplies = finding.whyApplies?.trim();
  const whyEvidence = finding.whyEvidenceInsufficient?.trim();
  const whyScore = finding.whyScoreReduced?.trim();
  const hasReasoning = !!(whyApplies || whyEvidence || whyScore);

  const guidelineTag = finding.folderName || finding.guidelineName;
  const gapText =
    finding.mismatchExplanation?.trim() || finding.highlightedIssue?.trim() || '';
  const recheckNewGap = recheckOverride?.newGap?.trim() || '';
  const sectionRaw = finding.sopSectionAffected?.trim() || '';
  const sectionNum = extractSectionNumber(sectionRaw);
  const originalSopSnippet =
    cleanFindingText(finding.sopTextSnippet) ||
    (reportContext ? `${reportContext.sopIdentifier}_${reportContext.sopName}` : '');
  const sopSnippet = recheckOverride?.currentSopText?.trim() || originalSopSnippet;
  const previousSopText =
    recheckOverride?.currentSopText?.trim() && originalSopSnippet ? originalSopSnippet : '';
  const displaySectionNum = sectionNum || (reportContext ? '1' : '');

  const guidelineSectionText = resolveGuidelineSectionText(finding, traceabilityMatrix);
  const clauseDisplay = extractGuidelineClauseDisplay({
    clauseNumber: finding.clauseNumber,
    clauseTitle: finding.clauseTitle,
    clauseText: finding.clauseText?.trim() || guidelineSectionText,
    guidelineRequirement: finding.guidelineRequirement,
    guidelineReference: guidelineRef,
    guidelineSourceLine: finding.guidelineSourceLine,
    guidelineLineNumber: finding.guidelineLineNumber,
    guidelineSearchPhrase: finding.guidelineSearchPhrase,
    sopTextSnippet: sopSnippet || finding.sopTextSnippet,
    evidenceFound: evidenceFound,
    complianceLevel: finding.complianceLevel,
    impactGap: gapText,
    mismatchExplanation: finding.mismatchExplanation,
    highlightedIssue: finding.highlightedIssue,
  });
  const displayRequirement =
    clauseDisplay.fullPoint?.trim() ||
    finding.guidelineRequirement?.trim() ||
    finding.clauseText?.trim() ||
    '';

  const impactText =
    finding.impactAnalysis?.trim() ||
    (isActionable && displayRequirement
      ? buildImpactAnalysis(finding, displayRequirement)
      : '');
  const impactSummaryText =
    isActionable && (gapText || displayRequirement)
      ? buildImpactSummary({ ...finding, mismatchExplanation: gapText || finding.mismatchExplanation }, displayRequirement)
      : '';
  const proposedVerbiage =
    cleanFindingText(finding.suggestedText) ||
    (isActionable
      ? buildProposedVerbiage({
          suggestedAction: cleanFindingText(finding.suggestedAction) || finding.suggestedAction || '',
          sopTextSnippet: sopSnippet,
          sopSectionAffected: sectionRaw,
          gap: gapText,
          clauseTitle: finding.clauseTitle,
          clauseNumber: finding.clauseNumber,
          guidelineName: finding.guidelineName,
        })
      : '');

  const complianceSummaryText =
    isCompliant && displayRequirement
      ? buildComplianceSummary({ ...finding, sopTextSnippet: sopSnippet || finding.sopTextSnippet }, displayRequirement)
      : '';
  const complianceRationaleText =
    isCompliant && displayRequirement
      ? buildComplianceRationale({ ...finding, sopTextSnippet: sopSnippet || finding.sopTextSnippet }, displayRequirement)
      : '';
  const guidelineSourceName = finding.pdfName || finding.folderName || finding.guidelineName;

  const pdfCacheKey = useMemo(
    () =>
      finding.guidelineId
        ? pdfResolutionCacheKey({
            guidelineId: finding.guidelineId,
            gapId: finding.gapId,
            _id: finding._id,
            clauseNumber: finding.clauseNumber,
            index,
          })
        : '',
    [finding.guidelineId, finding.gapId, finding._id, finding.clauseNumber, index],
  );

  const pdfSearchAnchors = useMemo(
    () => [gapText, sopSnippet, displayRequirement, clauseDisplay.fullPoint].filter(Boolean),
    [gapText, sopSnippet, displayRequirement, clauseDisplay.fullPoint],
  );

  const clauseFallbackPoint = (() => {
    const candidate = clauseDisplay.fullPoint?.trim() || displayRequirement.trim();
    return candidate && !isGuidelineBoilerplate(candidate) ? candidate : '';
  })();

  const requirementFallback = clauseFallbackPoint || displayRequirement;

  const [pdfResolved, setPdfResolved] = useState<PdfSearchResolution | null>(() =>
    pdfCacheKey ? getCachedPdfResolution(pdfCacheKey, requirementFallback) : null,
  );
  const [pdfResolveState, setPdfResolveState] = useState<'idle' | 'loading' | 'ready'>(() =>
    pdfCacheKey && getCachedPdfResolution(pdfCacheKey, requirementFallback) ? 'ready' : 'idle',
  );
  const pdfPrefetchRef = useRef(0);
  const pdfAbortRef = useRef<AbortController | null>(null);

  const clauseTextBody = finding.clauseText?.trim() || guidelineSectionText.trim();
  // Only skip PDF resolution when we already have a verified result cached.
  // A stored clause point is NOT sufficient — it can diverge from the actual
  // PDF, which is exactly what made the card show wrong content until the modal
  // (which does resolve against the PDF) was opened.
  const canSkipPdfPrefetch =
    !!pdfCacheKey && !!getCachedPdfResolution(pdfCacheKey, requirementFallback);

  const guidelineSectionPending =
    !!finding.guidelineId && expanded && !canSkipPdfPrefetch && pdfResolveState !== 'ready';

  const effectivePdf = acceptPdfResolution(pdfResolved, requirementFallback);

  const displaySearchPhrase = guidelineSectionPending
    ? ''
    : effectivePdf?.searchPhrase || clauseDisplay.searchPhrase;
  const displayGuidelinePoint = guidelineSectionPending
    ? ''
    : effectivePdf?.fullPoint || clauseFallbackPoint;
  const showSmartSearchTag = guidelineSectionPending
    ? false
    : (effectivePdf?.isSmartSearch ?? clauseDisplay.isSmartSearch ?? false);

  useEffect(() => {
    const cached = pdfCacheKey ? getCachedPdfResolution(pdfCacheKey, requirementFallback) : null;
    setPdfResolved(cached);
    setPdfResolveState(cached ? 'ready' : 'idle');
  }, [pdfCacheKey, requirementFallback]);

  useEffect(() => {
    if (guidelinePdfOpen) {
      pdfAbortRef.current?.abort();
    }
  }, [guidelinePdfOpen]);

  useEffect(() => {
    if (!expanded || !finding.guidelineId || !pdfCacheKey) return;
    if (guidelinePdfOpen) return;

    const cached = getCachedPdfResolution(pdfCacheKey, requirementFallback);
    if (cached) {
      setPdfResolved(cached);
      setPdfResolveState('ready');
      return;
    }

    if (canSkipPdfPrefetch) {
      setPdfResolveState('ready');
      return;
    }

    const timer = window.setTimeout(() => {
      pdfAbortRef.current?.abort();
      const ac = new AbortController();
      pdfAbortRef.current = ac;
      setPdfResolveState('loading');
      const runId = ++pdfPrefetchRef.current;

      enqueuePdfResolve(() =>
        resolveGuidelinePdfSearch({
          guidelineId: finding.guidelineId!,
          searchPhrase: clauseDisplay.searchPhrase,
          searchAnchors: pdfSearchAnchors,
          clauseNumber: finding.clauseNumber,
          requirementText: clauseFallbackPoint || displayRequirement,
          clauseText: clauseTextBody,
          mode: 'prefetch',
          signal: ac.signal,
        }),
      )
        .then((result) => {
          if (runId !== pdfPrefetchRef.current || ac.signal.aborted) return;
          const accepted = acceptPdfResolution(result, requirementFallback);
          if (accepted) {
            setCachedPdfResolution(pdfCacheKey, accepted, requirementFallback);
            setPdfResolved(accepted);
          }
        })
        .catch(() => {
          /* timeout / network — fall back to clause display */
        })
        .finally(() => {
          if (runId === pdfPrefetchRef.current) {
            setPdfResolveState('ready');
          }
        });
    }, 450);

    return () => {
      window.clearTimeout(timer);
      pdfAbortRef.current?.abort();
      pdfPrefetchRef.current++;
    };
  }, [
    expanded,
    finding.guidelineId,
    pdfCacheKey,
    guidelinePdfOpen,
    finding.clauseNumber,
    clauseDisplay.searchPhrase,
    clauseFallbackPoint,
    displayRequirement,
    pdfSearchAnchors,
    canSkipPdfPrefetch,
    clauseTextBody,
    requirementFallback,
  ]);

  const handlePdfSearchResolved = useCallback(
    (resolution: PdfSearchResolution) => {
      const accepted = acceptPdfResolution(resolution, requirementFallback);
      if (!accepted) {
        setPdfResolveState('ready');
        return;
      }
      if (pdfCacheKey) setCachedPdfResolution(pdfCacheKey, accepted, requirementFallback);
      setPdfResolved((prev) => {
        if (
          prev?.searchPhrase === accepted.searchPhrase &&
          (prev?.fullPoint || '') === (accepted.fullPoint || '')
        ) {
          return prev;
        }
        return accepted;
      });
      setPdfResolveState('ready');
    },
    [pdfCacheKey, requirementFallback],
  );

  const handleCopySearchPhrase = () => {
    const text = displaySearchPhrase;
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedSearch(true);
    setTimeout(() => setCopiedSearch(false), 2000);
  };

  const openGuidelineInNewTab = () => {
    if (!finding.guidelineId) return;
    const params = new URLSearchParams({ guidelineId: finding.guidelineId });
    const q = displaySearchPhrase;
    if (q) params.set('search', q);
    const name = guidelineSourceName?.trim();
    if (name) params.set('title', name);
    window.open(`/compliance/guideline-view?${params.toString()}`, '_blank', 'noopener,noreferrer');
  };

  const handleCopyVerbiage = () => {
    const text = proposedVerbiage || cleanFindingText(finding.suggestedAction) || '';
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const scoreColor = reportContext ? getScoreColorClass(reportContext.overallScore) : '';
  const statusColor = reportContext ? getComplianceStatusColor(reportContext.complianceStatus) : '';

  return (
    <div
      data-finding-card
      className={`rounded-2xl border-l-4 overflow-hidden bg-white shadow-sm transition-all ${levelBorder} ${
        isSelected ? 'ring-2 ring-purple-400 border-purple-200' : 'border border-gray-200'
      }`}
    >
      {/* Collapsed summary row — click anywhere to expand/collapse */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          // Allow highlighting/copying text in the summary without toggling.
          if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
          setExpanded((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        className="px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:bg-gray-50/80 transition-colors select-text"
        aria-expanded={expanded}
      >
        {showCheckbox && index !== undefined && onToggleSelect && (
          <input
            data-pdf-hide
            type="checkbox"
            checked={isSelected ?? false}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(index)}
            className="h-4 w-4 text-purple-600 rounded cursor-pointer shrink-0"
          />
        )}

        {serialNumber !== undefined && (
          <span className="shrink-0 flex items-center justify-center min-w-[2.25rem] h-9 px-2 rounded-lg bg-purple-600 border border-purple-700 text-base font-black text-white font-mono shadow-sm">
            #{serialNumber}
          </span>
        )}

        <div className="flex-1 min-w-0 select-text">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {catBadge ? (
              <span className={`px-2 py-0.5 text-[10px] font-bold rounded border shrink-0 ${catBadge.className}`}>
                {catBadge.label}
              </span>
            ) : (
              <span className={`px-2 py-0.5 text-[10px] font-bold rounded border shrink-0 ${levelBadge.className}`}>
                {levelBadge.label}
              </span>
            )}
            {rBadge ? (
              <span className={`px-2 py-0.5 text-[10px] font-bold rounded border shrink-0 ${rBadge.className}`}>
                {rBadge.label}
              </span>
            ) : (
              <span className={`px-2 py-0.5 text-[10px] font-bold rounded border shrink-0 ${severityBadge.className}`}>
                {severityBadge.label}
              </span>
            )}
            {isGmp && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-indigo-50 border border-indigo-200 rounded text-[10px] font-bold text-indigo-700 shrink-0">
                <ShieldAlert className="h-2.5 w-2.5" />
                GMP Intelligence
              </span>
            )}
            {isCrossSop && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-fuchsia-50 border border-fuchsia-200 rounded text-[10px] font-bold text-fuchsia-700 shrink-0">
                <ExternalLink className="h-2.5 w-2.5" />
                Cross-SOP
              </span>
            )}
            {guidelineTag && !isGmp && !isCrossSop && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded text-[10px] font-bold text-blue-700 shrink-0">
                <BookOpen className="h-2.5 w-2.5" />
                {guidelineTag}
              </span>
            )}
            {finding.clauseTitle && (
              <span className="text-sm font-semibold text-gray-800 leading-tight truncate max-w-[min(100%,28rem)]" title={finding.clauseTitle}>
                {finding.clauseTitle}
              </span>
            )}
            {sectionRaw && sectionRaw !== 'Not Found' && (
              onSectionClick ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSectionClick();
                  }}
                  className="pointer-events-auto text-xs text-purple-600 flex items-center gap-1 font-medium shrink-0 hover:text-purple-800 hover:underline cursor-pointer"
                  title={`Go to section ${displaySectionNum || sectionRaw}`}
                >
                  <FileText className="h-3 w-3 shrink-0" />
                  {sectionRaw}
                </button>
              ) : (
                <span className="text-xs text-purple-600 flex items-center gap-1 font-medium shrink-0" title={sectionRaw}>
                  <FileText className="h-3 w-3 shrink-0" />
                  {sectionRaw}
                </span>
              )
            )}
            {appBadge && (
              <span className={`px-2 py-0.5 text-[10px] font-bold rounded border shrink-0 ${appBadge.className}`}>
                {appBadge.label}
              </span>
            )}
            {finding.requiresManualReview && (
              <span className="flex items-center gap-1 px-2 py-0.5 bg-rose-50 border border-rose-300 rounded text-[10px] font-bold text-rose-700 shrink-0">
                <Search className="h-2.5 w-2.5" />
                Manual review
              </span>
            )}
            <span className="text-[10px] text-gray-400 font-medium shrink-0">
              {guidelineRef || `Clause ${finding.clauseNumber}`}
              {confidence > 0 && ` · ${confidence}% confidence`}
            </span>
          </div>

          {!expanded && gapText && isActionable && (
            <p className="text-xs text-gray-600 mt-1.5 leading-relaxed line-clamp-2">{gapText}</p>
          )}
        </div>

        <div data-pdf-hide className="flex items-center gap-1.5 shrink-0">
          {isActionable && onToggleApplicable && (
            <label
              className="flex items-center gap-1 cursor-pointer select-none pointer-events-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={isApplicable ?? false}
                onChange={(e) => onToggleApplicable(id, e.target.checked)}
                className="h-3.5 w-3.5 text-purple-600 rounded"
              />
              <span className="text-[10px] text-gray-500 font-medium">Applicable</span>
            </label>
          )}
          <span className="p-1.5 text-gray-400 pointer-events-none" aria-hidden>
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </span>
        </div>
      </div>

      {/* Expanded — 6-column single-view: SOP | gap | impact analysis | impact | suggested action | guideline section */}
      {expanded && (
        <div
          className="border-t border-gray-100 bg-gray-50/50 px-2 py-1.5 space-y-1 select-text"
          onClick={(e) => e.stopPropagation()}
        >
          {displayRequirement && (
            <div className="rounded border border-gray-200 bg-white px-2 py-1">
              <div className="flex items-start gap-1.5 min-w-0">
                <BookOpen className="h-3 w-3 text-gray-500 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="text-[9px] font-black text-gray-600 uppercase tracking-wide">Guideline Requirement</span>
                    {guidelineRef && <span className="text-[10px] font-bold text-blue-700">{guidelineRef}</span>}
                    {confidence > 0 && (
                      <span className={`text-[10px] font-bold ${confidenceColor(confidence)}`}>{confidence}%</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-900 leading-snug mt-0.5">{displayRequirement}</p>
                  {(isMeaningful(evidenceFound) || isMeaningful(evidenceMissing)) && (
                    <p className="text-[10px] text-gray-700 leading-snug mt-0.5">
                      {isMeaningful(evidenceFound) && <span className="text-emerald-700 font-medium">+ {evidenceFound}</span>}
                      {isMeaningful(evidenceFound) && isMeaningful(evidenceMissing) && ' · '}
                      {isMeaningful(evidenceMissing) && <span className="text-rose-700 font-medium">− {evidenceMissing}</span>}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="overflow-x-auto -mx-0.5 px-0.5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 items-stretch">
            {previousSopText && (
              <div className="rounded border border-gray-300 bg-gray-50 px-2 py-1 flex flex-col min-h-0 sm:col-span-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h4 className="text-[9px] font-black text-gray-600 uppercase tracking-wide flex items-center gap-1 shrink-0">
                    <History className="h-3 w-3" />
                    Previous SOP Text
                  </h4>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPreviousSopOpen(true);
                    }}
                    className="text-[10px] font-bold text-gray-600 border border-gray-300 rounded px-1.5 py-0.5 hover:bg-gray-100 shrink-0"
                  >
                    View in popup
                  </button>
                </div>
                <p className="text-xs text-gray-600 leading-snug italic mt-0.5 line-clamp-2">&ldquo;{previousSopText}&rdquo;</p>
              </div>
            )}

            {(sopSnippet || displaySectionNum) && (
              <div className="rounded border border-purple-200 bg-purple-50/50 px-2 py-1 flex flex-col min-h-0">
                <h4 className="text-[9px] font-black text-purple-800 uppercase tracking-wide mb-0.5 flex items-center gap-1 flex-wrap shrink-0">
                  <FileText className="h-3 w-3" />
                  {recheckOverride ? 'Current SOP (Revised)' : 'Current SOP'}
                  {displaySectionNum && (
                    onSectionClick ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onSectionClick();
                        }}
                        className="pointer-events-auto text-[10px] font-semibold normal-case text-purple-700 hover:underline"
                        title={`Go to section ${displaySectionNum}`}
                      >
                        §{displaySectionNum}
                      </button>
                    ) : (
                      <span className="text-[10px] font-semibold normal-case text-purple-700">§{displaySectionNum}</span>
                    )
                  )}
                </h4>
                {sopSnippet ? (
                  <p className="text-xs text-gray-900 leading-snug italic flex-1">&ldquo;{sopSnippet}&rdquo;</p>
                ) : (
                  <p className="text-xs text-gray-500 italic">No SOP text.</p>
                )}
              </div>
            )}

            {isCompliant && complianceSummaryText && (
              <div className="rounded border border-emerald-200 bg-emerald-50/70 px-2 py-1 flex flex-col min-h-0">
                <h4 className="text-[9px] font-black text-emerald-800 uppercase tracking-wide mb-0.5 flex items-center gap-1 shrink-0">
                  <CheckCircle2 className="h-3 w-3" />
                  Compliance Analysis
                </h4>
                <p className="text-xs text-gray-900 leading-snug flex-1">{complianceSummaryText}</p>
              </div>
            )}

            {isCompliant && complianceRationaleText && (
              <div className="rounded border border-teal-200 bg-teal-50/80 px-2 py-1 flex flex-col self-start">
                <h4 className="text-[9px] font-black text-teal-800 uppercase tracking-wide mb-0.5 flex items-center gap-1 shrink-0">
                  <CheckCircle className="h-3 w-3" />
                  Why Compliant
                </h4>
                <BulletList text={complianceRationaleText} />
              </div>
            )}

            {isActionable && gapText && (
              <div className="rounded border border-amber-200 bg-amber-50/80 px-2 py-1 flex flex-col min-h-0">
                <h4 className="text-[9px] font-black text-amber-800 uppercase tracking-wide mb-0.5 flex items-center gap-1 shrink-0">
                  <AlertTriangle className="h-3 w-3" />
                  {recheckOverride ? 'Original Gap' : 'Gap'}
                </h4>
                <div className="flex-1 min-h-0">
                  <BulletList text={gapText} />
                </div>
              </div>
            )}

            {recheckNewGap && (
              <div className="rounded border border-orange-300 bg-orange-50 px-2 py-1 flex flex-col min-h-0">
                <h4 className="text-[9px] font-black text-orange-800 uppercase tracking-wide mb-0.5 flex items-center gap-1 shrink-0">
                  <AlertTriangle className="h-3 w-3" />
                  New Gap Identified (Re-check)
                </h4>
                <div className="flex-1 min-h-0">
                  <BulletList text={recheckNewGap} />
                </div>
              </div>
            )}

            {isActionable && impactSummaryText && (
              <div className="rounded border border-rose-200 bg-rose-50/70 px-2 py-1 flex flex-col min-h-0">
                <h4 className="text-[9px] font-black text-rose-800 uppercase tracking-wide mb-0.5 flex items-center gap-1 shrink-0">
                  <ShieldAlert className="h-3 w-3" />
                  Impact Analysis
                </h4>
                <p className="text-xs text-gray-900 leading-snug flex-1">{impactSummaryText}</p>
              </div>
            )}

            {isActionable && impactText && (
              <div className="rounded border border-orange-200 bg-orange-50/80 px-2 py-1 flex flex-col self-start">
                <h4 className="text-[9px] font-black text-orange-800 uppercase tracking-wide mb-0.5 flex items-center gap-1 shrink-0">
                  <Target className="h-3 w-3" />
                  Impact
                </h4>
                <BulletList text={impactText} />
                {finding.guidelineId && (() => {
                  const pageFragment = finding.pageNumber?.trim() ? `#page=${finding.pageNumber.trim()}` : '';
                  const href = `/api/guidelines/upload?serve=${finding.guidelineId}${pageFragment}`;
                  const label = [
                    finding.pdfName || finding.folderName || finding.guidelineName,
                    finding.clauseNumber ? `§${finding.clauseNumber}` : '',
                  ].filter(Boolean).join(' · ');
                  return (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-orange-300 bg-white text-[10px] font-bold text-orange-800 hover:bg-orange-50 shrink-0"
                    >
                      <ExternalLink className="h-3 w-3 shrink-0" />
                      {label || 'Source'}
                    </a>
                  );
                })()}
              </div>
            )}

            {isActionable && finding.suggestedAction && (
              <div className="rounded border border-emerald-200 bg-emerald-50/60 px-2 py-1 flex flex-col min-h-0">
                <h4 className="text-[9px] font-black text-emerald-800 uppercase tracking-wide mb-0.5 flex items-center gap-1 shrink-0">
                  <CheckCircle2 className="h-3 w-3" />
                  Suggested Action
                </h4>
                <p className="text-xs font-semibold text-gray-900 leading-snug shrink-0">{finding.suggestedAction}</p>
                {proposedVerbiage && (() => {
                  const activeVerbiage = rewriting ? rewriteText : (finding as any).__rewrittenVerbiage ?? proposedVerbiage;
                  return (
                    <div className="mt-0.5 rounded border border-emerald-300 bg-white px-1.5 py-1 flex flex-col flex-1 min-h-0">
                      <div className="flex flex-wrap items-center justify-between gap-0.5 mb-0.5 shrink-0">
                        <p className="text-[9px] font-black text-emerald-800 uppercase">Proposed</p>
                        <div data-pdf-hide className="flex flex-wrap items-center gap-1">
                          {rewriting ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  (finding as any).__rewrittenVerbiage = rewriteText;
                                  setRewriting(false);
                                }}
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-600 text-white"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setRewriting(false)}
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-gray-200 text-gray-700"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  setRewriteText((finding as any).__rewrittenVerbiage ?? proposedVerbiage);
                                  setRewriting(true);
                                }}
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500 text-white"
                              >
                                Rewrite
                              </button>
                              <button
                                type="button"
                                disabled={!sopId || !sopSnippet}
                                onClick={() => setDraftOpen(true)}
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-blue-600 text-white disabled:opacity-50"
                              >
                                Preview
                              </button>
                              {onApplyFix && finding.gapId && !finding.resolved && (
                                <button
                                  type="button"
                                  disabled={applyingFix}
                                  onClick={() => onApplyFix(finding.gapId!, finding)}
                                  className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-600 text-white disabled:opacity-50"
                                >
                                  {applyingFix ? '…' : 'Apply'}
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={handleCopyVerbiage}
                                className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase text-emerald-800 border border-emerald-300"
                              >
                                Copy
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {rewriting ? (
                        <textarea
                          autoFocus
                          value={rewriteText}
                          onChange={(e) => setRewriteText(e.target.value)}
                          rows={2}
                          className="w-full text-xs text-gray-900 leading-snug border border-emerald-300 rounded p-1.5 resize-y focus:outline-none bg-emerald-50/40 flex-1"
                          placeholder="Rewrite…"
                        />
                      ) : (
                        <p className="text-xs text-gray-900 leading-snug whitespace-pre-wrap flex-1">
                          {activeVerbiage}
                          {(finding as any).__rewrittenVerbiage && (finding as any).__rewrittenVerbiage !== proposedVerbiage && (
                            <span className="ml-1 text-[9px] text-amber-600 font-bold">(edited)</span>
                          )}
                        </p>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {(clauseDisplay.fullPoint || clauseDisplay.searchPhrase || displayRequirement || guidelineSectionPending) && (
              <div className="rounded border border-indigo-200 bg-indigo-50/50 px-2 py-1 flex flex-col min-h-0">
                <h4 className="text-[9px] font-black text-indigo-800 uppercase tracking-wide mb-1 flex items-center gap-1 shrink-0">
                  <ScrollText className="h-3 w-3" />
                  Guideline Section
                </h4>
                {guidelineSourceName && (
                  <p className="text-[9px] font-medium text-indigo-700 shrink-0 mb-1">{guidelineSourceName}</p>
                )}
                {guidelineSectionPending ? (
                  <div className="rounded border border-indigo-200 bg-white px-1.5 py-2 shrink-0 flex items-center gap-1.5 text-[10px] text-indigo-600">
                    <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                    Locating requirement in PDF…
                  </div>
                ) : displaySearchPhrase ? (
                  <div className="rounded border border-indigo-200 bg-white px-1.5 py-1 mb-1 shrink-0">
                    <p className="text-[8px] font-black text-indigo-500 uppercase flex items-center gap-1 flex-wrap">
                      <Search className="h-2.5 w-2.5" />
                      PDF search term
                      {showSmartSearchTag && (
                        <span className="normal-case font-bold text-[7px] px-1 py-px rounded bg-amber-100 text-amber-800 border border-amber-200">
                          Smart search term
                        </span>
                      )}
                    </p>
                    <p className="text-[11px] font-semibold text-indigo-900 leading-snug mt-0.5">
                      &ldquo;{displaySearchPhrase}&rdquo;
                      {effectivePdf?.matchFound && effectivePdf.matchPage != null && (
                        <span className="ml-1 text-[9px] font-medium text-emerald-700">
                          — page {effectivePdf.matchPage}
                        </span>
                      )}
                    </p>
                  </div>
                ) : null}
                {displayGuidelinePoint ? (
                  <>
                    <p className="text-[9px] text-indigo-600 font-semibold shrink-0">
                      {clauseDisplay.isVerbatim && !showSmartSearchTag
                        ? 'Guideline requirement'
                        : 'Assessed requirement'}
                    </p>
                    <p className="text-xs font-medium text-gray-900 leading-snug mt-0.5 flex-1 border-l-2 border-indigo-400 pl-1.5 bg-white/60 rounded-r whitespace-pre-wrap">
                      {displayGuidelinePoint}
                    </p>
                    <div data-pdf-hide className="flex flex-wrap items-center gap-1 mt-1 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCopySearchPhrase();
                        }}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-indigo-300 bg-white text-[10px] font-bold text-indigo-800 hover:bg-indigo-50"
                      >
                        <Copy className="h-3 w-3" />
                        {copiedSearch ? 'Copied!' : 'Copy for PDF search'}
                      </button>
                      {finding.guidelineId && (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setGuidelinePdfOpen(true);
                            }}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-indigo-300 bg-white text-[10px] font-bold text-indigo-800 hover:bg-indigo-50"
                          >
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            Open guideline
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openGuidelineInNewTab();
                            }}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-indigo-300 bg-white text-[10px] font-bold text-indigo-800 hover:bg-indigo-50"
                          >
                            <BookOpen className="h-3 w-3 shrink-0" />
                            Open in new tab
                          </button>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-gray-500 italic mt-1">
                    No requirement text available. Open the PDF to browse.
                  </p>
                )}
              </div>
            )}
          </div>
          </div>

          {(hasReasoning || (finding.mergedClauseRefs && finding.mergedClauseRefs.length > 0)) && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[10px] text-gray-700 leading-snug">
              {hasReasoning && whyApplies && <span><span className="font-semibold text-slate-500">Applies:</span> {whyApplies}</span>}
              {finding.mergedClauseRefs?.map((ref, i) => (
                <span key={i} className="px-1 py-px bg-purple-50 border border-purple-200 rounded text-purple-700 font-semibold">{ref}</span>
              ))}
            </div>
          )}

          <SopDraftModal
            isOpen={draftOpen}
            onClose={() => setDraftOpen(false)}
            sopId={sopId}
            sopIdentifier={reportContext?.sopIdentifier}
            sopName={reportContext?.sopName}
            sectionAffected={sectionRaw}
            suggestedAction={finding.suggestedAction}
            currentText={sopSnippet}
            proposedText={(finding as any).__rewrittenVerbiage ?? proposedVerbiage}
          />

          {previousSopText && (
            <DraggablePopup
              isOpen={previousSopOpen}
              onClose={() => setPreviousSopOpen(false)}
              title="Previous SOP Text"
            >
              <p className="text-sm text-gray-800 whitespace-pre-wrap leading-relaxed">{previousSopText}</p>
            </DraggablePopup>
          )}

          {finding.guidelineId && (
            <GuidelinePdfModal
              isOpen={guidelinePdfOpen}
              onClose={() => setGuidelinePdfOpen(false)}
              guidelineId={finding.guidelineId}
              searchPhrase={clauseDisplay.searchPhrase}
              searchAnchors={pdfSearchAnchors}
              clauseNumber={finding.clauseNumber}
              requirementText={displayGuidelinePoint || clauseFallbackPoint}
              prefetchedResolution={effectivePdf}
              onSearchResolved={handlePdfSearchResolved}
              title={guidelineSourceName}
            />
          )}

          {finding.complianceLevel === 'compliant' && complianceSummaryText && !expanded && (
            <p className="text-xs text-gray-600 bg-emerald-50/50 border border-emerald-100 rounded-lg px-2 py-1.5">
              {complianceSummaryText}
            </p>
          )}

          {onReviewStatusChange && (
            <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-gray-100">
              <span className="text-[9px] text-gray-500 font-semibold uppercase">Review:</span>
              {finding.resolved && (
                <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-100 text-green-800 border border-green-200">
                  Resolved
                </span>
              )}
              {finding.lastReviewedAt && (
                <span className="text-[9px] text-gray-400">
                  {new Date(finding.lastReviewedAt).toLocaleDateString()}
                </span>
              )}
              {(['pending', 'accepted', 'disputed', 'implemented'] as const).map((s) => (
                <button
                  key={s}
                  data-pdf-hide
                  type="button"
                  onClick={() => onReviewStatusChange(id, s)}
                  className={`px-2 py-0.5 rounded text-[9px] font-bold border transition-all capitalize ${
                    finding.reviewStatus === s
                      ? 'bg-purple-600 text-white border-purple-500'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-purple-300 hover:text-purple-600'
                  }`}
                >
                  {s}
                </button>
              ))}
              {finding.reviewStatus && (
                <span
                  data-pdf-show
                  className="hidden px-2 py-0.5 rounded text-[9px] font-bold border bg-purple-600 text-white border-purple-500 capitalize"
                >
                  {finding.reviewStatus}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
