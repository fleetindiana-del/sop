'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle, CalendarCheck, CheckCircle2, ChevronDown, ClipboardList, FileText,
  Loader2, RefreshCw, Save, Search, Trash2, UserCheck, UserX, Users,
} from 'lucide-react';

type Status = 'present' | 'absent';

interface TrainableSop {
  sopCode: string;
  sopName: string;
  department: string;
  hasExam: boolean;
  assignedCount: number;
}

interface EligibleEmployee {
  employeeId: string;
  name: string;
  designation: string;
  department: string;
  employeeCode?: string;
  isTrainer: boolean;
  hasLmsAccess: boolean;
  assignedThisSop: boolean;
}

interface SheetRecord {
  employeeId: string;
  employeeName: string;
  designation: string;
  department: string;
  employeeCode?: string;
  status: Status;
  remark?: string;
}

interface AttendanceSheet {
  id: string;
  sopCode: string;
  sopName: string;
  department: string;
  trainerName: string;
  trainingDate: string;
  presentCount: number;
  absentCount: number;
  totalCount: number;
  attendancePct: number;
  notes?: string;
  recordedAt?: string;
  records: SheetRecord[];
}

interface ReportPayload {
  departments: string[];
  sheets: AttendanceSheet[];
  byEmployee: Array<{
    employeeId: string;
    employeeName: string;
    department: string;
    designation: string;
    sessions: number;
    present: number;
    absent: number;
    attendancePct: number;
  }>;
  totals: { sessions: number; present: number; absent: number; marked: number; attendancePct: number };
}

function todayIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * Attendance for SOP training sessions.
 *
 * Flow: pick the SOP/training and date → the department's employees load with
 * everyone marked Present → the trainer unmarks whoever did not attend → save.
 * Filed sheets stay available under "Records" as the permanent report.
 */
export function TrainerAttendancePanel({ onUnauthorized }: { onUnauthorized?: () => void }) {
  const [tab, setTab] = useState<'record' | 'records'>('record');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // ── Record a session ───────────────────────────────────────────────────────
  const [catalog, setCatalog] = useState<TrainableSop[]>([]);
  const [departments, setDepartments] = useState<string[]>([]);
  const [dept, setDept] = useState('');
  const [sopCode, setSopCode] = useState('');
  const [trainingDate, setTrainingDate] = useState(todayIso());
  const [sopSearch, setSopSearch] = useState('');
  const [notes, setNotes] = useState('');

  const [employees, setEmployees] = useState<EligibleEmployee[] | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  /** Only the absentees are tracked — everyone else is present by definition. */
  const [absent, setAbsent] = useState<Set<string>>(new Set());
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const [empSearch, setEmpSearch] = useState('');
  const [editingSheetId, setEditingSheetId] = useState<string | null>(null);
  const [saved, setSaved] = useState<AttendanceSheet | null>(null);

  // ── Records / report ───────────────────────────────────────────────────────
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [loadingReport, setLoadingReport] = useState(false);
  const [reportSop, setReportSop] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/lms/trainer/attendance/sop-catalog', { cache: 'no-store' });
      const json = await res.json();
      if (res.status === 401) { onUnauthorized?.(); return; }
      if (!res.ok) throw new Error(json.error || 'Failed to load SOP list');
      setCatalog(json.sops ?? []);
      setDepartments(json.departments ?? []);
      setDept((prev) => prev || json.departments?.[0] || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void (async () => {
      await loadCatalog();
    })();
  }, [loadCatalog]);

  const loadEmployees = useCallback(async () => {
    if (!sopCode || !dept) { setEmployees(null); return; }
    setLoadingList(true);
    setError('');
    setSaved(null);
    try {
      const qs = new URLSearchParams({ sopCode, department: dept, date: trainingDate });
      const res = await fetch(`/api/lms/trainer/attendance/eligible?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (res.status === 401) { onUnauthorized?.(); return; }
      if (!res.ok) throw new Error(json.error || 'Failed to load employees');

      setEmployees(json.employees ?? []);
      // Editing an already-filed session must start from what was filed, not
      // from a fresh all-present sheet that would silently erase absences.
      if (json.existing) {
        const existing = json.existing as AttendanceSheet;
        setEditingSheetId(existing.id);
        setAbsent(new Set(existing.records.filter((r) => r.status === 'absent').map((r) => r.employeeId)));
        setRemarks(Object.fromEntries(
          existing.records.filter((r) => r.remark).map((r) => [r.employeeId, r.remark as string]),
        ));
        setNotes(existing.notes ?? '');
      } else {
        setEditingSheetId(null);
        setAbsent(new Set());
        setRemarks({});
        setNotes('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
      setEmployees(null);
    } finally {
      setLoadingList(false);
    }
  }, [sopCode, dept, trainingDate, onUnauthorized]);

  useEffect(() => {
    void (async () => {
      await loadEmployees();
    })();
  }, [loadEmployees]);

  const loadReport = useCallback(async () => {
    setLoadingReport(true);
    setError('');
    try {
      const qs = new URLSearchParams();
      if (reportSop) qs.set('sopCode', reportSop);
      const res = await fetch(`/api/lms/trainer/attendance?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (res.status === 401) { onUnauthorized?.(); return; }
      if (!res.ok) throw new Error(json.error || 'Failed to load attendance records');
      setReport(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoadingReport(false);
    }
  }, [reportSop, onUnauthorized]);

  useEffect(() => {
    if (tab !== 'records') return;
    void (async () => {
      await loadReport();
    })();
  }, [tab, loadReport]);

  const filteredSops = useMemo(() => {
    const q = sopSearch.trim().toLowerCase();
    return catalog.filter((s) => !q || `${s.sopCode} ${s.sopName}`.toLowerCase().includes(q));
  }, [catalog, sopSearch]);

  const filteredEmployees = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    return (employees ?? []).filter(
      (e) => !q || `${e.name} ${e.designation} ${e.employeeCode ?? ''}`.toLowerCase().includes(q),
    );
  }, [employees, empSearch]);

  const presentCount = (employees?.length ?? 0) - absent.size;
  const selectedSop = catalog.find((s) => s.sopCode === sopCode);

  const toggleAbsent = (employeeId: string) =>
    setAbsent((prev) => {
      const next = new Set(prev);
      if (next.has(employeeId)) next.delete(employeeId);
      else next.add(employeeId);
      return next;
    });

  const saveAttendance = async () => {
    if (!employees?.length || !sopCode || !dept || !trainingDate) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/lms/trainer/attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sopCode,
          department: dept,
          trainingDate,
          employeeIds: employees.map((e) => e.employeeId),
          absentEmployeeIds: [...absent],
          remarks: Object.fromEntries(
            Object.entries(remarks).filter(([id, v]) => absent.has(id) && v.trim()),
          ),
          notes: notes.trim() || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to save attendance');
      setSaved(json.sheet);
      setEditingSheetId(json.sheet?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save attendance');
    } finally {
      setBusy(false);
    }
  };

  const deleteSheet = async (sheet: AttendanceSheet) => {
    if (!window.confirm(
      `Delete the attendance sheet for ${sheet.sopCode} on ${sheet.trainingDate}? This removes the record permanently.`,
    )) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/lms/trainer/attendance?id=${encodeURIComponent(sheet.id)}`, {
        method: 'DELETE',
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to delete');
      await loadReport();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
          {([
            { id: 'record', label: 'Record Attendance', Icon: UserCheck },
            { id: 'records', label: 'Attendance Records', Icon: FileText },
          ] as const).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                tab === t.id ? 'bg-purple-600 text-white' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <t.Icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void (tab === 'record' ? loadEmployees() : loadReport())}
          disabled={loadingList || loadingReport}
          className="rounded-lg border border-gray-200 p-2 text-gray-400 hover:bg-gray-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loadingList || loadingReport ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {tab === 'record' ? (
        <>
          {/* Step 1 — pick the session */}
          <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
            <p className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-gray-500">
              <ClipboardList className="h-3.5 w-3.5 text-purple-600" /> Select training session
            </p>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">Department</label>
                <div className="relative">
                  <select
                    value={dept}
                    onChange={(e) => setDept(e.target.value)}
                    className="w-full appearance-none rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-7 text-xs font-medium text-gray-700"
                  >
                    {departments.length === 0 && <option value="">No departments</option>}
                    {departments.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                </div>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">SOP / Training</label>
                <div className="relative">
                  <select
                    value={sopCode}
                    onChange={(e) => setSopCode(e.target.value)}
                    className="w-full appearance-none rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-7 text-xs font-medium text-gray-700"
                  >
                    <option value="">Select a SOP…</option>
                    {filteredSops.map((s) => (
                      <option key={s.sopCode} value={s.sopCode}>
                        {s.sopCode} — {s.sopName}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                </div>
                {catalog.length > 12 && (
                  <input
                    value={sopSearch}
                    onChange={(e) => setSopSearch(e.target.value)}
                    placeholder="Filter SOP list…"
                    className="mt-1.5 w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11px] focus:border-purple-300 focus:outline-none"
                  />
                )}
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-semibold text-gray-500">Training date</label>
                <input
                  type="date"
                  value={trainingDate}
                  max={todayIso()}
                  onChange={(e) => setTrainingDate(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700"
                />
              </div>
            </div>
            {selectedSop && (
              <p className="mt-2 text-[11px] text-gray-500">
                {selectedSop.sopCode} · {selectedSop.sopName}
                {' · '}{selectedSop.assignedCount} employee{selectedSop.assignedCount === 1 ? '' : 's'} assigned in the matrix
                {!selectedSop.hasExam && ' · no online exam yet'}
              </p>
            )}
          </div>

          {/* Step 2 — the sheet */}
          {!sopCode ? (
            <div className="rounded-2xl border border-dashed border-gray-200 bg-white py-16 text-center">
              <Users className="mx-auto h-8 w-8 text-gray-300" />
              <p className="mt-2 text-sm text-gray-400">
                Select a SOP and date to load your department&apos;s employees.
              </p>
            </div>
          ) : loadingList ? (
            <div className="flex justify-center rounded-2xl border border-gray-200 bg-white py-16">
              <Loader2 className="h-7 w-7 animate-spin text-purple-400" />
            </div>
          ) : !employees?.length ? (
            <div className="rounded-2xl border border-gray-200 bg-white py-16 text-center">
              <p className="text-sm text-gray-400">No active employees in {dept || 'your department'}.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {editingSheetId && !saved && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Attendance was already recorded for this SOP on {trainingDate}. The marks below are
                    the saved ones — saving will update that record rather than create a second sheet.
                  </span>
                </div>
              )}

              {saved && (
                <div className="flex items-start gap-2 rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-xs text-green-800">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Attendance saved — <strong>{saved.presentCount} present</strong> and{' '}
                    <strong>{saved.absentCount} absent</strong> of {saved.totalCount} for {saved.sopCode}{' '}
                    on {saved.trainingDate}. It is now in Attendance Records.
                  </span>
                </div>
              )}

              {/* Summary + actions */}
              <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-green-50 px-2.5 py-1 text-xs font-bold text-green-700">
                  <UserCheck className="h-3.5 w-3.5" /> {presentCount} Present
                </span>
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-2.5 py-1 text-xs font-bold text-red-700">
                  <UserX className="h-3.5 w-3.5" /> {absent.size} Absent
                </span>
                <span className="text-[11px] text-gray-400">
                  of {employees.length} · everyone is Present by default — untick whoever did not attend
                </span>

                <div className="relative ml-auto min-w-44">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                  <input
                    value={empSearch}
                    onChange={(e) => setEmpSearch(e.target.value)}
                    placeholder="Search employee…"
                    className="w-full rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-xs focus:border-purple-300 focus:outline-none"
                  />
                </div>
                {absent.size > 0 && (
                  <button
                    type="button"
                    onClick={() => setAbsent(new Set())}
                    className="rounded-lg border border-gray-200 px-2.5 py-1.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
                  >
                    Mark all present
                  </button>
                )}
              </div>

              {/* Employee list */}
              <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                <div className="max-h-[calc(100vh-30rem)] overflow-auto">
                  <table className="w-full min-w-[720px] text-left text-xs">
                    <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50">
                      <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                        <th className="w-24 px-3 py-2.5">Attendance</th>
                        <th className="px-3 py-2.5">Employee</th>
                        <th className="px-3 py-2.5">Designation</th>
                        <th className="px-3 py-2.5">Matrix</th>
                        <th className="px-3 py-2.5">Remark (if absent)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {filteredEmployees.map((e) => {
                        const isAbsent = absent.has(e.employeeId);
                        return (
                          <tr key={e.employeeId} className={isAbsent ? 'bg-red-50/50' : 'hover:bg-gray-50'}>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                onClick={() => toggleAbsent(e.employeeId)}
                                aria-pressed={!isAbsent}
                                className={`inline-flex w-full items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold transition ${
                                  isAbsent
                                    ? 'bg-red-100 text-red-700 hover:bg-red-200'
                                    : 'bg-green-100 text-green-700 hover:bg-green-200'
                                }`}
                              >
                                {isAbsent ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                                {isAbsent ? 'Absent' : 'Present'}
                              </button>
                            </td>
                            <td className="px-3 py-2 font-semibold text-gray-900">
                              {e.name}
                              {e.employeeCode && (
                                <span className="ml-1.5 text-[10px] font-normal text-gray-400">{e.employeeCode}</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-gray-600">{e.designation || '—'}</td>
                            <td className="px-3 py-2">
                              {e.assignedThisSop ? (
                                <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">
                                  Assigned
                                </span>
                              ) : (
                                <span className="text-[10px] text-gray-400">Not assigned</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <input
                                value={remarks[e.employeeId] ?? ''}
                                onChange={(ev) =>
                                  setRemarks((prev) => ({ ...prev, [e.employeeId]: ev.target.value }))
                                }
                                disabled={!isAbsent}
                                placeholder={isAbsent ? 'Reason…' : ''}
                                className="w-full rounded-lg border border-gray-200 px-2 py-1 text-[11px] focus:border-purple-300 focus:outline-none disabled:cursor-not-allowed disabled:border-transparent disabled:bg-transparent"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Save */}
              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
                <input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Session notes (optional) — venue, duration, trainer remarks…"
                  className="min-w-52 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-xs focus:border-purple-300 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void saveAttendance()}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-xs font-bold text-white hover:bg-purple-700 disabled:opacity-50"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {editingSheetId ? 'Update Attendance' : 'Save Attendance'}
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        /* ── Attendance records / report ─────────────────────────────────── */
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <select
                value={reportSop}
                onChange={(e) => setReportSop(e.target.value)}
                className="appearance-none rounded-lg border border-gray-200 bg-white py-2 pl-3 pr-7 text-xs font-medium text-gray-600"
              >
                <option value="">All SOPs</option>
                {catalog.map((s) => (
                  <option key={s.sopCode} value={s.sopCode}>{s.sopCode}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            </div>
            {report && (
              <p className="text-[11px] text-gray-500">
                {report.totals.sessions} session{report.totals.sessions === 1 ? '' : 's'} ·{' '}
                <span className="font-semibold text-green-700">{report.totals.present} present</span> ·{' '}
                <span className="font-semibold text-red-600">{report.totals.absent} absent</span> ·{' '}
                {report.totals.attendancePct}% attendance
              </p>
            )}
          </div>

          {loadingReport && !report ? (
            <div className="flex justify-center rounded-2xl border border-gray-200 bg-white py-16">
              <Loader2 className="h-7 w-7 animate-spin text-purple-400" />
            </div>
          ) : !report?.sheets.length ? (
            <div className="rounded-2xl border border-gray-200 bg-white py-16 text-center">
              <CalendarCheck className="mx-auto h-8 w-8 text-gray-300" />
              <p className="mt-2 text-sm text-gray-400">
                No attendance recorded yet. Use <strong>Record Attendance</strong> to file your first session.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {report.sheets.map((sheet) => (
                  <div key={sheet.id} className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => (prev === sheet.id ? null : sheet.id))}
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      >
                        <ChevronDown
                          className={`h-4 w-4 shrink-0 text-gray-400 transition ${expanded === sheet.id ? 'rotate-180' : ''}`}
                        />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-bold text-gray-900">
                            {sheet.sopCode} — {sheet.sopName}
                          </p>
                          <p className="text-[11px] text-gray-500">
                            {sheet.trainingDate} · {sheet.department} · Trainer: {sheet.trainerName}
                          </p>
                        </div>
                      </button>
                      <span className="rounded-lg bg-green-50 px-2.5 py-1 text-xs font-bold text-green-700">
                        {sheet.presentCount} Present
                      </span>
                      <span className="rounded-lg bg-red-50 px-2.5 py-1 text-xs font-bold text-red-700">
                        {sheet.absentCount} Absent
                      </span>
                      <span className="text-[11px] font-semibold text-gray-500">{sheet.attendancePct}%</span>
                      <button
                        type="button"
                        title="Delete this attendance sheet"
                        disabled={busy}
                        onClick={() => void deleteSheet(sheet)}
                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {expanded === sheet.id && (
                      <div className="border-t border-gray-100 bg-gray-50/60 px-4 py-3">
                        {sheet.notes && (
                          <p className="mb-2 text-[11px] text-gray-600">
                            <span className="font-semibold">Notes:</span> {sheet.notes}
                          </p>
                        )}
                        <table className="w-full min-w-[560px] text-left text-xs">
                          <thead>
                            <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                              <th className="py-1.5 pr-3 w-24">Status</th>
                              <th className="py-1.5 pr-3">Employee</th>
                              <th className="py-1.5 pr-3">Designation</th>
                              <th className="py-1.5">Remark</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-200">
                            {sheet.records.map((r) => (
                              <tr key={r.employeeId}>
                                <td className="py-1.5 pr-3">
                                  <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                    r.status === 'present'
                                      ? 'bg-green-100 text-green-700'
                                      : 'bg-red-100 text-red-700'
                                  }`}>
                                    {r.status === 'present' ? 'Present' : 'Absent'}
                                  </span>
                                </td>
                                <td className="py-1.5 pr-3 font-semibold text-gray-800">{r.employeeName}</td>
                                <td className="py-1.5 pr-3 text-gray-600">{r.designation || '—'}</td>
                                <td className="py-1.5 text-gray-500">{r.remark || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Per-employee roll-up across the filtered sessions */}
              {report.byEmployee.length > 0 && (
                <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
                  <p className="border-b border-gray-100 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-gray-500">
                    Attendance by employee
                  </p>
                  <div className="max-h-96 overflow-auto">
                    <table className="w-full min-w-[560px] text-left text-xs">
                      <thead className="sticky top-0 border-b border-gray-200 bg-gray-50">
                        <tr className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                          <th className="px-3 py-2">Employee</th>
                          <th className="px-3 py-2">Designation</th>
                          <th className="px-3 py-2">Sessions</th>
                          <th className="px-3 py-2">Present</th>
                          <th className="px-3 py-2">Absent</th>
                          <th className="px-3 py-2">Attendance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {report.byEmployee.map((row) => (
                          <tr key={row.employeeId} className="hover:bg-gray-50">
                            <td className="px-3 py-2 font-semibold text-gray-900">{row.employeeName}</td>
                            <td className="px-3 py-2 text-gray-600">{row.designation || '—'}</td>
                            <td className="px-3 py-2 tabular-nums text-gray-700">{row.sessions}</td>
                            <td className="px-3 py-2 tabular-nums font-semibold text-green-700">{row.present}</td>
                            <td className="px-3 py-2 tabular-nums font-semibold text-red-600">{row.absent}</td>
                            <td className="px-3 py-2">
                              <div className="flex items-center gap-2">
                                <div className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-200">
                                  <div
                                    className={`h-full rounded-full ${row.attendancePct >= 80 ? 'bg-green-500' : 'bg-amber-500'}`}
                                    style={{ width: `${row.attendancePct}%` }}
                                  />
                                </div>
                                <span className="tabular-nums text-[11px] font-semibold text-gray-600">
                                  {row.attendancePct}%
                                </span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
