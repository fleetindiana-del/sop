'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventClickArg, EventDropArg, EventInput, DatesSetArg } from '@fullcalendar/core';
import {
  AlertCircle, CalendarDays, CheckCircle2, Loader2, Search, Users, X,
} from 'lucide-react';
import { DEPT_COLORS, MONTH_NAMES } from '@/lib/trainingExamScheduleShared';
import type { ExamStatus, MonthlyExamRow } from '@/components/lms/TrainerMonthlyExams';
import { ScheduleExamModal } from '@/components/lms/ScheduleExamModal';

type EmployeeOption = {
  employeeId: string;
  employeeName: string;
  designation: string;
  department: string;
  hasLmsAccess: boolean;
  total: number;
  completed: number;
  remaining: number;
};

function dateToIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

/** Prefer scheduled exam date; otherwise place on the 1st of the planned month. */
function eventStart(row: MonthlyExamRow): string {
  if (row.scheduledDate && /^\d{4}-\d{2}-\d{2}/.test(row.scheduledDate)) {
    return row.scheduledDate.slice(0, 10);
  }
  return `${row.year}-${pad2(row.month)}-01`;
}

function statusColor(status: ExamStatus, isIgnored: boolean, hasDate: boolean): string {
  if (isIgnored) return '#9ca3af';
  if (status === 'completed') return '#008767';
  if (status === 'overdue') return '#D84339';
  if (!hasDate) return '#64748b';
  return '#0ea5e9';
}

/**
 * Trainer Schedule Exam — employee-wise calendar (same pattern as
 * training-matrix/manage-sop calendar). Pick an employee to see their full
 * exam schedule; click an event for complete details / date edit.
 */
export function TrainerExamCalendar({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const calendarRef = useRef<InstanceType<typeof FullCalendar> | null>(null);
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [rows, setRows] = useState<MonthlyExamRow[]>([]);
  const [search, setSearch] = useState('');
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MonthlyExamRow | null>(null);
  const [editDate, setEditDate] = useState('');
  const [allowOutside, setAllowOutside] = useState(false);
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = new URLSearchParams({ year: String(year) });
      const res = await fetch(`/api/lms/trainer/monthly?${qs}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load schedule');
      setRows((json.rows ?? []) as MonthlyExamRow[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const el = document.querySelector('.trainer-exam-calendar-fc');
    if (!el) return;
    const ro = new ResizeObserver(() => {
      calendarRef.current?.getApi()?.updateSize();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const employees = useMemo(() => {
    const map = new Map<string, EmployeeOption>();
    for (const r of rows) {
      if (r.isIgnored) continue;
      let e = map.get(r.employeeId);
      if (!e) {
        e = {
          employeeId: r.employeeId,
          employeeName: r.employeeName,
          designation: r.designation,
          department: r.department,
          hasLmsAccess: r.hasLmsAccess,
          total: 0,
          completed: 0,
          remaining: 0,
        };
        map.set(r.employeeId, e);
      }
      e.total++;
      if (r.status === 'completed') e.completed++;
      else e.remaining++;
    }
    const q = search.trim().toLowerCase();
    return [...map.values()]
      .filter((e) =>
        !q || `${e.employeeName} ${e.designation} ${e.department}`.toLowerCase().includes(q),
      )
      .sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  }, [rows, search]);

  const selectedEmployee = employees.find((e) => e.employeeId === selectedEmployeeId) ?? null;

  const employeeRows = useMemo(() => {
    if (!selectedEmployeeId) return [];
    return rows
      .filter((r) => r.employeeId === selectedEmployeeId && !r.isIgnored)
      .sort((a, b) => {
        if (a.year !== b.year) return a.year - b.year;
        if (a.month !== b.month) return a.month - b.month;
        return a.sopCode.localeCompare(b.sopCode);
      });
  }, [rows, selectedEmployeeId]);

  const events = useMemo<EventInput[]>(() => {
    return employeeRows.map((r) => {
      const hasDate = Boolean(r.scheduledDate);
      const color = statusColor(r.status, r.isIgnored, hasDate);
      const deptColor = DEPT_COLORS[r.department] || color;
      return {
        id: r.key,
        title: `${r.sopCode} — ${r.sopName}`,
        start: eventStart(r),
        allDay: true,
        backgroundColor: hasDate ? deptColor : '#94a3b8',
        borderColor: r.status === 'overdue' ? '#D84339' : deptColor,
        textColor: '#ffffff',
        classNames: hasDate ? [] : ['fc-event-undated'],
        extendedProps: { row: r },
      };
    });
  }, [employeeRows]);

  const handleDatesSet = (arg: DatesSetArg) => {
    const mid = new Date((arg.start.getTime() + arg.end.getTime()) / 2);
    const y = mid.getFullYear();
    setYear((prev) => (prev === y ? prev : y));
  };

  const openDetail = (row: MonthlyExamRow) => {
    setDetail(row);
    setEditDate(row.scheduledDate || eventStart(row));
    setAllowOutside(false);
    setMsg('');
  };

  const handleEventClick = (arg: EventClickArg) => {
    const row = arg.event.extendedProps.row as MonthlyExamRow | undefined;
    if (row) openDetail(row);
  };

  const handleEventDrop = async (arg: EventDropArg) => {
    const row = arg.event.extendedProps.row as MonthlyExamRow | undefined;
    const newDate = arg.event.start ? dateToIso(arg.event.start) : null;
    if (!row || !newDate || row.status === 'completed') {
      arg.revert();
      return;
    }
    const dateMonth = Number(newDate.slice(5, 7));
    const outside = dateMonth !== row.month;
    if (outside && !window.confirm(
      `Move outside planned month (${MONTH_NAMES[row.month]})?`,
    )) {
      arg.revert();
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/lms/trainer/exam-date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: row.employeeId,
          sopCode: row.sopCode,
          department: row.department,
          plannedMonth: row.month,
          year: row.year,
          examDate: newDate,
          allowOutsideMonth: outside,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to update date');
      setMsg('Exam date updated');
      await load();
      onChanged();
    } catch (err) {
      arg.revert();
      setError(err instanceof Error ? err.message : 'Failed to update');
    } finally {
      setSaving(false);
    }
  };

  const saveDetailDate = async () => {
    if (!detail || !editDate) return;
    setSaving(true);
    setError('');
    try {
      const dateMonth = Number(editDate.slice(5, 7));
      const outside = dateMonth !== detail.month || allowOutside;
      const res = await fetch('/api/lms/trainer/exam-date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: detail.employeeId,
          sopCode: detail.sopCode,
          department: detail.department,
          plannedMonth: detail.month,
          year: detail.year,
          examDate: editDate,
          allowOutsideMonth: outside || allowOutside,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Failed to save date');
      setMsg('Exam date saved');
      setDetail(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-2 sm:p-4" onClick={onClose}>
      <div
        className="flex h-[min(94vh,900px)] w-full max-w-[1400px] flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-purple-600" />
            <div>
              <h2 className="text-sm font-bold text-gray-900">Schedule exam — calendar</h2>
              <p className="text-[11px] text-gray-500">
                Employee-wise view · click an employee for their full schedule · click an exam to edit
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {(loading || saving) && <Loader2 className="h-4 w-4 animate-spin text-gray-400" />}
            {msg && <span className="text-[11px] font-medium text-emerald-700">{msg}</span>}
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              className="rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-purple-700"
            >
              Bulk schedule…
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-gray-200 p-1.5 text-gray-400 hover:bg-gray-50 hover:text-gray-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" /> {error}
          </div>
        )}

        <div className="flex min-h-0 flex-1 gap-0">
          {/* Employee list */}
          <aside className="flex w-72 shrink-0 flex-col border-r border-gray-200 bg-gray-50/80">
            <div className="border-b border-gray-200 p-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search employee…"
                  className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-7 pr-2 text-xs focus:border-purple-300 focus:outline-none"
                />
              </div>
              <p className="mt-1.5 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                <Users className="h-3 w-3" /> {employees.length} employees · {year}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading && employees.length === 0 ? (
                <div className="flex justify-center py-10">
                  <Loader2 className="h-5 w-5 animate-spin text-purple-400" />
                </div>
              ) : employees.length === 0 ? (
                <p className="px-3 py-8 text-center text-xs text-gray-400">No employees with exams.</p>
              ) : (
                employees.map((emp) => {
                  const active = selectedEmployeeId === emp.employeeId;
                  return (
                    <button
                      key={emp.employeeId}
                      type="button"
                      onClick={() => setSelectedEmployeeId(emp.employeeId)}
                      className={`flex w-full flex-col gap-0.5 border-b border-gray-100 px-3 py-2.5 text-left transition ${
                        active ? 'bg-purple-50 ring-1 ring-inset ring-purple-300' : 'hover:bg-white'
                      }`}
                    >
                      <span className="truncate text-xs font-bold text-gray-900">{emp.employeeName}</span>
                      <span className="truncate text-[10px] text-gray-500">
                        {emp.designation || '—'} · {emp.department}
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                        <span className="font-semibold text-emerald-700">✓ {emp.completed}</span>
                        <span className="font-semibold text-red-600">✕ {emp.remaining}</span>
                        <span className="text-gray-400">{emp.total} total</span>
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          {/* Calendar + schedule list */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!selectedEmployee ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <Users className="h-8 w-8 text-gray-300" />
                <p className="text-sm font-semibold text-gray-600">Select an employee</p>
                <p className="max-w-sm text-xs text-gray-400">
                  Their complete SOP exam schedule for {year} will appear on the calendar.
                  Click any exam to view details or change the date.
                </p>
              </div>
            ) : (
              <>
                <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-3 py-2">
                  <div>
                    <p className="text-sm font-bold text-gray-900">{selectedEmployee.employeeName}</p>
                    <p className="text-[11px] text-gray-500">
                      {selectedEmployee.designation || '—'} · {selectedEmployee.department}
                      {' · '}
                      {employeeRows.length} exam{employeeRows.length === 1 ? '' : 's'} this year
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[10px] text-gray-500">
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-emerald-600" /> Completed
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-sky-500" /> Scheduled
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-slate-400" /> Month only (no date)
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full bg-red-500" /> Overdue
                    </span>
                  </div>
                </div>

                <div className="flex min-h-0 flex-1 flex-col gap-2 p-2 lg:flex-row">
                  <div className="trainer-exam-calendar-fc min-h-[22rem] flex-1 overflow-hidden rounded-xl border border-gray-200 bg-white p-2 lg:min-h-0">
                    <FullCalendar
                      ref={calendarRef}
                      plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
                      initialView="dayGridMonth"
                      initialDate={`${year}-${pad2(now.getMonth() + 1)}-01`}
                      headerToolbar={{
                        left: 'prev,next today',
                        center: 'title',
                        right: 'dayGridMonth,timeGridWeek',
                      }}
                      height="100%"
                      editable
                      events={events}
                      datesSet={handleDatesSet}
                      eventClick={handleEventClick}
                      eventDrop={(arg) => void handleEventDrop(arg)}
                      dayMaxEvents={4}
                    />
                  </div>

                  {/* Complete schedule list for selected employee */}
                  <div className="flex max-h-64 w-full shrink-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white lg:max-h-none lg:w-80">
                    <div className="border-b border-gray-100 bg-gray-50 px-3 py-2">
                      <p className="text-[10px] font-bold uppercase tracking-wide text-gray-500">
                        Complete schedule ({employeeRows.length})
                      </p>
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto">
                      {employeeRows.length === 0 ? (
                        <p className="px-3 py-8 text-center text-xs text-gray-400">No exams for this employee.</p>
                      ) : (
                        <ul className="divide-y divide-gray-100">
                          {employeeRows.map((r) => (
                            <li key={r.key}>
                              <button
                                type="button"
                                onClick={() => openDetail(r)}
                                className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-purple-50/60"
                              >
                                <span className="font-mono text-[11px] font-bold text-purple-700">{r.sopCode}</span>
                                <span className="line-clamp-2 text-[11px] text-gray-800">{r.sopName}</span>
                                <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-gray-500">
                                  <span>{MONTH_NAMES[r.month]} {r.year}</span>
                                  <span>·</span>
                                  <span>{r.scheduledDate || 'No date set'}</span>
                                  <span
                                    className={`rounded-full px-1.5 py-0.5 font-bold ${
                                      r.status === 'completed'
                                        ? 'bg-green-100 text-green-700'
                                        : r.status === 'overdue'
                                          ? 'bg-red-100 text-red-700'
                                          : 'bg-amber-100 text-amber-800'
                                    }`}
                                  >
                                    {r.status}
                                  </span>
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Event detail / edit */}
      {detail && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
          onClick={() => setDetail(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-gray-900">Exam schedule</h3>
                <p className="mt-0.5 text-[11px] text-gray-500">{detail.employeeName}</p>
              </div>
              <button type="button" onClick={() => setDetail(null)} className="rounded p-1 text-gray-400 hover:bg-gray-100">
                <X className="h-4 w-4" />
              </button>
            </div>

            <dl className="mt-3 space-y-2 text-xs text-gray-700">
              <div>
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">SOP</dt>
                <dd className="font-mono font-bold text-purple-700">{detail.sopCode}</dd>
                <dd className="mt-0.5 text-gray-800">{detail.sopName}</dd>
                {detail.sopNameGujarati && (
                  <dd className="text-indigo-700">{detail.sopNameGujarati}</dd>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Department</dt>
                  <dd>{detail.department}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Designation</dt>
                  <dd>{detail.designation || '—'}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Planned month</dt>
                  <dd>{MONTH_NAMES[detail.month]} {detail.year}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Status</dt>
                  <dd className="capitalize">{detail.status} · {detail.scheduleStatus}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Progress</dt>
                  <dd>{detail.progressPct}%{typeof detail.score === 'number' ? ` · score ${detail.score}%` : ''}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Source</dt>
                  <dd>{detail.source === 'trainer' ? `Scheduled${detail.scheduledBy ? ` by ${detail.scheduledBy}` : ''}` : 'Training matrix'}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">Completed on</dt>
                  <dd>{detail.completedDate || '—'}</dd>
                </div>
                <div>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">LMS login</dt>
                  <dd>{detail.hasLmsAccess ? 'Yes' : 'No'}</dd>
                </div>
              </div>
            </dl>

            {detail.status !== 'completed' && (
              <div className="mt-4 space-y-2 border-t border-gray-100 pt-3">
                <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                  Exam date
                  <input
                    type="date"
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm"
                  />
                </label>
                <label className="inline-flex items-center gap-1.5 text-[11px] text-gray-600">
                  <input
                    type="checkbox"
                    checked={allowOutside}
                    onChange={(e) => setAllowOutside(e.target.checked)}
                    className="h-3.5 w-3.5 rounded border-gray-300"
                  />
                  Allow date outside planned month
                </label>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setDetail(null)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    disabled={saving || !editDate}
                    onClick={() => void saveDetailDate()}
                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50"
                  >
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    Save date
                  </button>
                </div>
              </div>
            )}
            {detail.status === 'completed' && (
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  onClick={() => setDetail(null)}
                  className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-600"
                >
                  Close
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {formOpen && (
        <ScheduleExamModal
          onClose={() => setFormOpen(false)}
          onScheduled={() => {
            setFormOpen(false);
            void load();
            onChanged();
          }}
          presetEmployeeIds={selectedEmployeeId ? [selectedEmployeeId] : undefined}
        />
      )}

      <style>{`
        .trainer-exam-calendar-fc {
          display: flex;
          flex-direction: column;
        }
        .trainer-exam-calendar-fc .fc {
          font-size: 12px;
          flex: 1;
          min-height: 0;
        }
        .trainer-exam-calendar-fc .fc-event {
          cursor: pointer;
          font-size: 10px;
        }
        .trainer-exam-calendar-fc .fc-event-undated {
          border-style: dashed !important;
          opacity: 0.85;
        }
      `}</style>
    </div>
  );
}
