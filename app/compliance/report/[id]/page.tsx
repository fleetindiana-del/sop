'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { RefreshCw, ShieldCheck, Paperclip } from 'lucide-react';
import FindingCard from '../../components/FindingCard';
import { getScoreColorClass } from '@/lib/complianceFormatter';
import {
  annexureStatusBadgeClass,
  annexureStatusLabel,
  annexureStatusTitle,
  resolveAnnexureStatus,
} from '@/lib/annexureAuditDisplay';
import { displaySopCode } from '@/lib/sop-display';

const RecheckSopModal = dynamic(() => import('@/components/compliance/RecheckSopModal'), { ssr: false });

interface ComplianceFinding {
  _id?: string;
  guidelineId?: string;
  guidelineName: string;
  folderName?: string;
  clauseNumber: string;
  clauseTitle: string;
  complianceLevel: 'compliant' | 'partial' | 'non-compliant' | 'not-applicable' | 'analysis-failed';
  matchConfidence: number;
  issueSeverity?: 'critical' | 'major' | 'minor' | 'informational';
  sopSectionAffected?: string;
  mismatchExplanation?: string;
  impactAnalysis?: string;
  sopTextSnippet?: string;
  guidelineRequirement?: string;
  suggestedAction?: string;
  suggestedText?: string;
  reviewStatus?: 'pending' | 'accepted' | 'disputed' | 'implemented';
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
  auditCompleteness?: AuditCompleteness;
  findings: ComplianceFinding[];
  traceabilityMatrix?: Array<{
    clauseNumber: string;
    clauseTitle: string;
    clauseText: string;
    guidelineName: string;
    folderName: string;
  }>;
  analyzedAt: string;
  annexuresChecked?: boolean;
  annexureStatus?: 'none' | 'checked' | 'not-checked' | 'linked-unread';
  linkedAnnexureCount?: number;
  liveLinkedAnnexureCount?: number;
  annexureChars?: number;
  annexuresIncluded?: { label: string; fileName: string; chars: number }[];
  annexuresSkipped?: { label: string; fileName: string; reason: string }[];
}

export default function ComplianceReportDetailPage() {
  const router = useRouter();
  const params = useParams();
  const id = params?.id as string;

  const [report, setReport] = useState<ComplianceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filterStatus, setFilterStatus] = useState<'all' | 'compliant' | 'partial' | 'non-compliant' | 'not-applicable'>('all');
  const [filterGuideline, setFilterGuideline] = useState('all');
  const [hideNotApplicable, setHideNotApplicable] = useState(true);
  const [hideFailedFindings, setHideFailedFindings] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [recheckOpen, setRecheckOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerationError, setRegenerationError] = useState('');

  const loadReport = useCallback((fresh = false) => {
    if (!id) return;
    setLoading(true);
    fetch(`/api/compliance/analyze?reportId=${id}${fresh ? '&refresh=1' : ''}`)
      .then(r => r.json())
      .then(data => {
        if (data.success) setReport(data.report);
        else setError(data.error || 'Report not found');
      })
      .catch(() => setError('Failed to load report'))
      .finally(() => setLoading(false));
  }, [id]);

  const regenerateWithAnnexures = useCallback(async () => {
    if (!report?.sopId || regenerating) return;
    if (!window.confirm('Regenerate this compliance report using the main SOP and all linked annexures?')) return;

    setRegenerating(true);
    setRegenerationError('');
    try {
      const guidelineIds = [
        ...new Set(
          report.findings
            .map((finding) => finding.guidelineId)
            .filter((guidelineId): guidelineId is string => Boolean(guidelineId)),
        ),
      ];
      const response = await fetch('/api/compliance/analyze-v3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sopId: report.sopId,
          guidelineIds,
          includeAnnexures: true,
          requireAnnexures: true,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.userMessage || data.error || 'Failed to regenerate the report');
      }
      await loadReport(true);
    } catch (regenerateError) {
      setRegenerationError(
        regenerateError instanceof Error ? regenerateError.message : 'Failed to regenerate the report',
      );
    } finally {
      setRegenerating(false);
    }
  }, [loadReport, regenerating, report]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize the page with the report API on route changes
    loadReport();
  }, [loadReport]);

  const guidelineFolders = useMemo(() => {
    if (!report?.findings) return [];
    return [...new Set(report.findings.map(f => f.folderName).filter(Boolean))] as string[];
  }, [report]);

  const visibleFindings = useMemo(() => {
    if (!report?.findings) return [];
    return report.findings.filter(f => {
      if (filterStatus !== 'all' && f.complianceLevel !== filterStatus) return false;
      if (filterGuideline !== 'all' && f.folderName !== filterGuideline) return false;
      if (hideNotApplicable && f.complianceLevel === 'not-applicable') return false;
      if (hideFailedFindings && f.complianceLevel === 'analysis-failed') return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return f.clauseTitle?.toLowerCase().includes(q)
          || f.clauseNumber?.toLowerCase().includes(q)
          || f.mismatchExplanation?.toLowerCase().includes(q)
          || false;
      }
      return true;
    });
  }, [report, filterStatus, filterGuideline, hideNotApplicable, hideFailedFindings, searchQuery]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Fully Compliant': return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      case 'Partially Compliant': return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'Non-Compliant': return 'bg-rose-100 text-rose-700 border-rose-200';
      default: return 'bg-gray-100 text-gray-600 border-gray-200';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#f8f9fa] flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-purple-600 mx-auto mb-4" />
          <p className="text-gray-500">Loading compliance report...</p>
        </div>
      </div>
    );
  }

  if (error || !report) {
    return (
      <div className="min-h-screen bg-[#f8f9fa] flex items-center justify-center">
        <div className="bg-white rounded-2xl border border-gray-200 p-12 text-center max-w-md">
          <p className="text-4xl mb-4">❌</p>
          <p className="text-lg font-medium text-gray-700">{error || 'Report not found'}</p>
          <button onClick={() => router.push('/compliance')} className="mt-6 px-6 py-2.5 bg-purple-600 text-white rounded-xl font-semibold hover:bg-purple-700">
            Back to Compliance
          </button>
        </div>
      </div>
    );
  }

  const compliantPct = report.totalGuidelinesChecked > 0
    ? Math.round((report.compliantCount / report.totalGuidelinesChecked) * 100) : 0;

  return (
    <div className="min-h-screen bg-[#f8f9fa]">
      <header className="bg-white border-b border-gray-200 sticky top-0 z-50 shadow-sm">
        <div className="max-w-5xl mx-auto px-2 py-1 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-bold text-gray-800">Compliance Report</h1>
            <p className="text-sm text-gray-500">{displaySopCode(report.sopIdentifier)} — {report.sopName}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={regenerateWithAnnexures}
              disabled={regenerating || !report.sopId}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-50 text-blue-700 rounded-lg border border-blue-200 font-medium text-sm hover:bg-blue-100 transition-all disabled:cursor-not-allowed disabled:opacity-60"
              title={!report.sopId ? 'This report is not linked to an SOP record' : undefined}
            >
              <RefreshCw className={`h-4 w-4 ${regenerating ? 'animate-spin' : ''}`} />
              {regenerating ? 'Regenerating…' : 'Regenerate with Annexures'}
            </button>
            <button
              onClick={() => setRecheckOpen(true)}
              className="flex items-center gap-1.5 px-4 py-2 bg-emerald-50 text-emerald-700 rounded-lg border border-emerald-200 font-medium text-sm hover:bg-emerald-100 transition-all"
            >
              <ShieldCheck className="h-4 w-4" />
              Re-check Revised SOP
            </button>
            <button
              onClick={() => router.push(`/compliance/applicable?reportId=${id}`)}
              className="px-4 py-2 bg-purple-50 text-purple-700 rounded-lg border border-purple-200 font-medium text-sm hover:bg-purple-100 transition-all"
            >
              View Applicable
            </button>
            <button
              onClick={() => router.push('/compliance')}
              className="flex items-center gap-1.5 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-all text-sm font-semibold"
            >
              ← Back
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {regenerationError && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {regenerationError}
          </div>
        )}

        {/* Report header */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          <div className="flex items-start justify-between mb-6">
            <div>
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <span className="text-purple-700 font-bold bg-purple-50 px-3 py-1 rounded-lg border border-purple-100 text-sm">{displaySopCode(report.sopIdentifier)}</span>
                <span className={`px-3 py-1 rounded-lg border text-sm font-bold ${getStatusColor(report.complianceStatus)}`}>{report.complianceStatus}</span>
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border text-xs font-bold ${annexureStatusBadgeClass(resolveAnnexureStatus(report))}`}
                  title={annexureStatusTitle(report)}
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  {annexureStatusLabel(resolveAnnexureStatus(report))}
                </span>
              </div>
              <h2 className="text-2xl font-bold text-gray-800">{report.sopName}</h2>
              <p className="text-gray-500 mt-1">{report.department}</p>
              <p className="text-xs text-gray-400 mt-1">Analyzed {new Date(report.analyzedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
              {resolveAnnexureStatus(report) === 'none' && (
                <p className="text-xs text-slate-600 mt-2 max-w-xl">
                  No annexure is connected to this SOP. Link Annexure forms/logs on the SOP, then re-run compliance.
                </p>
              )}
              {resolveAnnexureStatus(report) === 'not-checked' && (
                <p className="text-xs text-amber-700 mt-2 max-w-xl">
                  Annexures are connected to this SOP, but this compliance run did not check them against guidelines.
                  Use <span className="font-semibold">Regenerate with Annexures</span> to include them.
                </p>
              )}
              {resolveAnnexureStatus(report) === 'linked-unread' && (
                <p className="text-xs text-amber-700 mt-2 max-w-xl">
                  Annexures are connected but could not be read for the guideline audit.
                  Prefer DOCX/PDF, then use <span className="font-semibold">Regenerate with Annexures</span>.
                </p>
              )}
              {resolveAnnexureStatus(report) === 'checked' && (
                <p className="text-xs text-emerald-700 mt-2 max-w-xl">
                  Annexures were connected and checked with the guidelines for this run
                  {report.annexuresIncluded?.length
                    ? `: ${report.annexuresIncluded.map((a) => a.label).join(', ')}`
                    : '.'}
                </p>
              )}
            </div>
            <div className="text-center">
              <div className={`inline-flex flex-col items-center justify-center w-24 h-24 rounded-full border-4 ${
                report.overallScore >= 8
                  ? 'border-emerald-200 bg-emerald-50'
                  : report.overallScore >= 5
                    ? 'border-amber-200 bg-amber-50'
                    : 'border-rose-200 bg-rose-50'
              }`}>
                <p className={`text-3xl font-black leading-none ${getScoreColorClass(report.overallScore)}`}>
                  {report.overallScore?.toFixed(1)}
                </p>
                <p className="text-[10px] text-gray-400 font-semibold mt-0.5">/ 10</p>
              </div>
            </div>
          </div>

          {/* Score bar */}
          <div className="mb-6">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
              <span>{compliantPct}% compliant</span>
              <span>{report.totalGuidelinesChecked} total checks</span>
            </div>
            <div className="h-3 bg-gray-100 rounded-full overflow-hidden flex">
              <div className="bg-emerald-500 h-full transition-all" style={{ width: `${compliantPct}%` }} />
              <div className="bg-amber-400 h-full transition-all" style={{ width: `${report.totalGuidelinesChecked > 0 ? Math.round((report.partialCount / report.totalGuidelinesChecked) * 100) : 0}%` }} />
            </div>
          </div>

          {/* Breakdown */}
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: 'Compliant', value: report.compliantCount, color: 'bg-emerald-50 border-emerald-200 text-emerald-700' },
              { label: 'Partial', value: report.partialCount, color: 'bg-amber-50 border-amber-200 text-amber-700' },
              { label: 'Non-Compliant', value: report.nonCompliantCount, color: 'bg-rose-50 border-rose-200 text-rose-700' },
            ].map(b => (
              <div key={b.label} className={`p-4 rounded-xl border ${b.color} text-center`}>
                <p className="text-2xl font-black">{b.value}</p>
                <p className="text-xs font-semibold mt-1">{b.label}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Audit completeness report — proves the entire guideline library was reviewed */}
        {report.auditCompleteness && (() => {
          const ac = report.auditCompleteness!;
          const coverage = [
            { label: 'Guidelines Reviewed', value: ac.totalGuidelinesReviewed, tone: 'text-indigo-700' },
            { label: 'Chapters Reviewed', value: ac.totalChaptersReviewed, tone: 'text-indigo-700' },
            { label: 'Clauses Reviewed', value: ac.totalClausesReviewed, tone: 'text-indigo-700' },
            { label: 'Applicable', value: ac.applicableClauses, tone: 'text-blue-700' },
            { label: 'Not Applicable', value: ac.notApplicableClauses, tone: 'text-slate-500' },
          ];
          const outcomes = [
            { label: 'Compliant', value: ac.compliantCount, tone: 'text-emerald-600' },
            { label: 'Partial', value: ac.partialCount, tone: 'text-amber-600' },
            { label: 'Non-Compliant', value: ac.nonCompliantCount, tone: 'text-rose-600' },
            { label: 'Critical', value: ac.criticalFindings, tone: 'text-red-600' },
            { label: 'Major', value: ac.majorFindings, tone: 'text-orange-600' },
            { label: 'Minor', value: ac.minorFindings, tone: 'text-yellow-600' },
            { label: 'Improvements', value: ac.improvementOpportunities, tone: 'text-sky-600' },
          ];
          return (
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50/40 overflow-hidden">
              <div className="px-5 py-3 bg-indigo-100/60 border-b border-indigo-200 flex items-center justify-between flex-wrap gap-2">
                <span className="text-sm font-black text-indigo-800">🛡️ Audit Completeness Report</span>
                <span className="text-[11px] font-bold text-indigo-600">
                  {ac.totalClausesReviewed} clauses across {ac.totalGuidelinesReviewed} guidelines · {ac.clauseCoveragePct}% clause coverage · {ac.sopCoveragePct}% SOP coverage
                </span>
              </div>
              <div className="p-5 space-y-4">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                  {coverage.map(m => (
                    <div key={m.label} className="p-3 rounded-xl border border-indigo-100 bg-white text-center">
                      <p className={`text-xl font-black leading-none ${m.tone}`}>{m.value}</p>
                      <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mt-1.5 leading-tight">{m.label}</p>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-3 md:grid-cols-7 gap-2">
                  {outcomes.map(m => (
                    <div key={m.label} className="p-3 rounded-xl border border-gray-200 bg-white text-center">
                      <p className={`text-xl font-black leading-none ${m.tone}`}>{m.value}</p>
                      <p className="text-[9px] font-bold text-gray-500 uppercase tracking-wider mt-1.5 leading-tight">{m.label}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Findings */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-6">
          <div className="flex items-center justify-between mb-5">
            <h3 className="font-bold text-gray-800">Findings</h3>
            <span className="text-sm text-gray-500">{visibleFindings.length} shown</span>
          </div>

          <div className="flex flex-wrap gap-3 mb-5">
            <input
              type="text"
              placeholder="Search findings..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-purple-500/20 w-48"
            />
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value as never)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none">
              <option value="all">All Status</option>
              <option value="non-compliant">Non-Compliant</option>
              <option value="partial">Partial</option>
              <option value="compliant">Compliant</option>
              <option value="not-applicable">N/A</option>
            </select>
            {guidelineFolders.length > 0 && (
              <select value={filterGuideline} onChange={e => setFilterGuideline(e.target.value)} className="px-3 py-2 border border-gray-200 rounded-lg text-sm text-gray-700 focus:outline-none">
                <option value="all">All Guidelines</option>
                {guidelineFolders.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            )}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={hideNotApplicable} onChange={e => setHideNotApplicable(e.target.checked)} className="rounded" />
              <span className="text-sm text-gray-600">Hide N/A</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input type="checkbox" checked={hideFailedFindings} onChange={e => setHideFailedFindings(e.target.checked)} className="rounded" />
              <span className="text-sm text-gray-600">Hide Failed</span>
            </label>
          </div>

          <div className="space-y-3">
            {visibleFindings.map((f, i) => (
              <FindingCard
                key={i}
                finding={f}
                traceabilityMatrix={report.traceabilityMatrix}
                reportContext={{
                  sopIdentifier: report.sopIdentifier,
                  sopName: report.sopName,
                  department: report.department,
                  overallScore: report.overallScore,
                  complianceStatus: report.complianceStatus,
                }}
                index={i}
                defaultExpanded={true}
                showCheckbox={false}
              />
            ))}
            {visibleFindings.length === 0 && (
              <div className="text-center py-12 bg-gray-50 rounded-xl border border-dashed border-gray-200">
                <p className="text-gray-500">No findings match the current filters.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      <RecheckSopModal
        isOpen={recheckOpen}
        onClose={() => setRecheckOpen(false)}
        reportId={id}
        sopIdentifier={report.sopIdentifier}
        sopName={report.sopName}
        onRechecked={() => loadReport(true)}
      />
    </div>
  );
}
