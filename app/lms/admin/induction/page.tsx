'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft, Award, CheckCircle2, ChevronDown, ChevronRight, Clock, Loader2,
  RefreshCw, Search, ShieldCheck, UserX,
} from 'lucide-react';
import { InductionRecordTable } from '@/components/lms/InductionRecordTable';
import { formatAttemptDate } from '@/components/lms/ExamAttemptsModal';
import type { AdminInductionRow } from '@/app/api/lms/admin/induction/route';
import type { InductionStatus } from '@/lib/lmsInduction';

type StatusFilter = 'all' | InductionStatus;

const STATUS_LABEL: Record<InductionStatus, string> = {
  completed: 'Completed',
  in_progress: 'In Progress',
  not_assigned: 'No SOPs Assigned',
};

function StatusBadge({ status }: { status: InductionStatus }) {
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-0.5 text-[10px] font-semibold text-green-700">
        <CheckCircle2 className="h-3 w-3" /> Completed
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
        <Clock className="h-3 w-3" /> In Progress
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600"
      title="Flagged for induction, but no induction SOP matches this department and designation. Set them in Manage SOP (induction ticks) or upload the induction training list."
    >
      <UserX className="h-3 w-3" /> No SOPs Assigned
    </span>
  );
}

export default function AdminInductionPage() {
  const { status: authStatus } = useSession();
  const router = useRouter();
  const [rows, setRows] = useState<AdminInductionRow[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (authStatus === 'unauthenticated') router.push('/login');
  }, [authStatus, router]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/lms/admin/induction', { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setError(json.error || 'Could not load induction training.'); return; }
      setRows(json.employees || []);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [authStatus, load]);

  const departments = useMemo(
    () => [...new Set((rows || []).map((r) => r.department).filter(Boolean))].sort(),
    [rows],
  );

  const deptRows = useMemo(
    () => (rows || []).filter((r) => department === 'all' || r.department === department),
    [rows, department],
  );

  const counts = useMemo(() => ({
    all: deptRows.length,
    completed: deptRows.filter((r) => r.status === 'completed').length,
    in_progress: deptRows.filter((r) => r.status === 'in_progress').length,
    not_assigned: deptRows.filter((r) => r.status === 'not_assigned').length,
  }), [deptRows]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return deptRows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (!term) return true;
      return [r.name, r.employeeCode, r.designation, r.department].some((v) => v.toLowerCase().includes(term));
    });
  }, [deptRows, statusFilter, search]);

  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link href="/lms" className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800">
              <ArrowLeft className="h-3.5 w-3.5" /> LMS
            </Link>
            <div className="h-4 w-px bg-gray-200" />
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-orange-600" />
              <h1 className="text-sm font-bold tracking-tight">Induction Training</h1>
            </div>
          </div>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-screen-2xl space-y-3 px-4 py-5 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center gap-2">
          {(['all', 'in_progress', 'completed', 'not_assigned'] as StatusFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-medium transition ${
                statusFilter === s
                  ? 'bg-orange-600 text-white'
                  : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {s === 'all' ? 'All Employees' : STATUS_LABEL[s]}
              <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-bold ${
                statusFilter === s ? 'bg-white/20' : 'bg-gray-100 text-gray-500'
              }`}>
                {counts[s]}
              </span>
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <select
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-xs focus:border-orange-300 focus:outline-none"
            >
              <option value="all">All departments</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <div className="relative w-56">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, code, designation…"
                className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-xs focus:border-orange-300 focus:outline-none"
              />
            </div>
          </div>
        </div>

        {error ? (
          <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">{error}</p>
        ) : rows === null ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-orange-400" />
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white py-16 text-center text-sm text-gray-500">
            No employees match.
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2 text-left">Employee</th>
                  <th className="px-3 py-2 text-left">Designation</th>
                  <th className="px-3 py-2 text-left">Department</th>
                  <th className="px-3 py-2 text-left">Joined</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-center">SOPs Completed</th>
                  <th className="px-3 py-2 text-center">Total Attempts</th>
                  <th className="px-3 py-2 text-left">Completed On</th>
                  <th className="px-3 py-2 text-left">Certificate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {visible.map((r) => {
                  const open = expanded.has(r.id);
                  const attempts = r.sops.reduce((n, s) => n + (s.attempts || 0), 0);
                  return (
                    <Fragment key={r.id}>
                      <tr className="cursor-pointer hover:bg-orange-50/40" onClick={() => toggle(r.id)}>
                        <td className="px-3 py-2 text-gray-400">
                          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-semibold text-gray-800">{r.name}</p>
                          {(r.employeeCode || !r.isActive) && (
                            <p className="text-[10px] text-gray-400">
                              {r.employeeCode}{!r.isActive ? `${r.employeeCode ? ' · ' : ''}Left` : ''}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-700">{r.designation || '—'}</td>
                        <td className="px-3 py-2 text-gray-700">{r.department || '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-700">{formatAttemptDate(r.dateOfJoining)}</td>
                        <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                        <td className="px-3 py-2 text-center font-semibold tabular-nums text-gray-700">
                          {r.total > 0 ? `${r.completedCount} / ${r.total}` : '—'}
                        </td>
                        <td className="px-3 py-2 text-center tabular-nums text-gray-700">{attempts || '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-gray-700">{formatAttemptDate(r.completedAt)}</td>
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          {r.certificate ? (
                            <Link
                              href={`/lms/induction/certificate?employeeId=${encodeURIComponent(r.id)}`}
                              className="inline-flex items-center gap-1 rounded-md border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700 hover:bg-orange-100"
                              title={r.certificate.certificateNumber}
                            >
                              <Award className="h-3 w-3" /> View
                            </Link>
                          ) : (
                            <span className="text-[11px] text-gray-300">—</span>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-gray-50/60">
                          <td />
                          <td colSpan={9} className="px-3 py-2.5">
                            <InductionRecordTable sops={r.sops} employeeId={r.id} compact />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
