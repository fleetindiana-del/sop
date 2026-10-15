'use client';

import React, { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import { MONTH_NAMES } from '@/lib/trainingExamScheduleShared';
import { displaySopCode } from '@/lib/sop-display';

export type CalendarEventDetail = {
  id: string;
  sopCode: string;
  sopName: string;
  department: string;
  year: number;
  plannedMonth: number;
  examDate: string;
  scope: 'department' | 'employee';
  employeeName?: string;
  inherited?: boolean;
  isOverride?: boolean;
  departmentScheduleId?: string;
};

type Props = {
  open: boolean;
  event: CalendarEventDetail | null;
  /** When creating from an empty day click */
  createDefaults?: {
    examDate: string;
    unassignedOptions: Array<{
      sopCode: string;
      sopName: string;
      department: string;
      plannedMonth: number;
      year: number;
      key: string;
    }>;
  } | null;
  employeeMode: boolean;
  selectedEmployee?: string;
  saving?: boolean;
  onClose: () => void;
  onSave: (payload: {
    examDate: string;
    sopCode?: string;
    sopName?: string;
    department?: string;
    plannedMonth?: number;
    year?: number;
    allowOutsideMonth?: boolean;
  }) => Promise<void> | void;
  onRemove?: () => Promise<void> | void;
  onResetOverride?: () => Promise<void> | void;
};

export default function CalendarEventModal({
  open,
  event,
  createDefaults,
  employeeMode,
  selectedEmployee,
  saving,
  onClose,
  onSave,
  onRemove,
  onResetOverride,
}: Props) {
  const isCreate = !event && !!createDefaults;
  const [examDate, setExamDate] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [allowOutside, setAllowOutside] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setAllowOutside(false);
    if (event) {
      setExamDate(event.examDate);
      setSelectedKey('');
    } else if (createDefaults) {
      setExamDate(createDefaults.examDate);
      setSelectedKey(createDefaults.unassignedOptions[0]?.key || '');
    }
  }, [open, event, createDefaults]);

  if (!open) return null;

  const plannedMonth = event?.plannedMonth;
  const year = event?.year;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (isCreate && createDefaults) {
        const opt = createDefaults.unassignedOptions.find((o) => o.key === selectedKey);
        if (!opt) {
          setError('Select an SOP to schedule');
          return;
        }
        await onSave({
          examDate,
          sopCode: opt.sopCode,
          sopName: opt.sopName,
          department: opt.department,
          plannedMonth: opt.plannedMonth,
          year: opt.year,
          allowOutsideMonth: allowOutside,
        });
      } else {
        await onSave({ examDate, allowOutsideMonth: allowOutside });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md border border-gray-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
          <h3 className="text-sm font-semibold text-gray-900">
            {isCreate ? 'Assign exam date' : 'Edit exam date'}
          </h3>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-700">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-4 py-3 space-y-3">
          {event && (
            <div className="text-xs text-gray-600 space-y-1">
              <div>
                <span className="font-semibold text-gray-900">{displaySopCode(event.sopCode)}</span>
                {event.sopName ? ` — ${event.sopName}` : ''}
              </div>
              <div>
                Department: <span className="font-medium">{event.department}</span>
                {event.employeeName ? (
                  <>
                    {' '}
                    · Employee: <span className="font-medium">{event.employeeName}</span>
                  </>
                ) : null}
              </div>
              <div>
                Planned month:{' '}
                <span className="font-medium">
                  {MONTH_NAMES[event.plannedMonth]} {event.year}
                </span>
              </div>
              {event.inherited && (
                <div className="text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  Inherited department date. Saving creates a personal override
                  {selectedEmployee ? ` for ${selectedEmployee}` : ''}.
                </div>
              )}
              {event.isOverride && (
                <div className="text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-2 py-1">
                  Personal override — peers keep the department date.
                </div>
              )}
            </div>
          )}

          {isCreate && createDefaults && (
            <label className="block text-xs">
              <span className="font-medium text-gray-700">SOP / department</span>
              <select
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.target.value)}
                className="mt-1 w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm text-gray-900"
                required
              >
                {createDefaults.unassignedOptions.length === 0 ? (
                  <option value="">No unassigned SOPs for this day&apos;s month</option>
                ) : (
                  createDefaults.unassignedOptions.map((o) => (
                    <option key={o.key} value={o.key}>
                      {displaySopCode(o.sopCode)} — {o.department} ({MONTH_NAMES[o.plannedMonth]})
                    </option>
                  ))
                )}
              </select>
            </label>
          )}

          <label className="block text-xs">
            <span className="font-medium text-gray-700">Exam date</span>
            <input
              type="date"
              value={examDate}
              onChange={(e) => setExamDate(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm text-gray-900"
              required
            />
            {plannedMonth != null && year != null && (
              <span className="text-[11px] text-gray-500 mt-0.5 block">
                Prefer a day in {MONTH_NAMES[plannedMonth]} {year}
              </span>
            )}
          </label>

          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={allowOutside}
              onChange={(e) => setAllowOutside(e.target.checked)}
              className="accent-blue-600"
            />
            Allow date outside planned month
          </label>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="submit"
              disabled={saving || (isCreate && !selectedKey)}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {event && !event.inherited && onRemove && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void onRemove()}
                className="px-3 py-1.5 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-60"
              >
                Remove
              </button>
            )}
            {employeeMode && event?.isOverride && onResetOverride && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void onResetOverride()}
                className="px-3 py-1.5 border border-gray-300 text-gray-700 text-sm rounded hover:bg-gray-50 disabled:opacity-60"
              >
                Reset to department date
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="ml-auto px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
