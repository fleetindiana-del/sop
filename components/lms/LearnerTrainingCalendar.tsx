'use client';

import { useMemo } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import type { EventClickArg, EventInput } from '@fullcalendar/core';
import { Calendar, X } from 'lucide-react';

import { isOverdueInCycle } from '@/lib/lmsTrainingCycle';

export interface LearnerCalendarAssignment {
  sopCode: string;
  sopName?: string;
  month: number;
  monthName: string;
  year: number;
  examDate?: string;
  trainingType?: string;
}

export interface LearnerCalendarProgress {
  status: 'not_started' | 'in_progress' | 'completed';
  overallPercentage: number;
}

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

/** Prefer scheduled exam date; otherwise place on the 1st of the planned month. */
function eventDate(a: LearnerCalendarAssignment): string {
  if (a.examDate && /^\d{4}-\d{2}-\d{2}/.test(a.examDate)) {
    return a.examDate.slice(0, 10);
  }
  return `${a.year}-${pad2(a.month)}-01`;
}

function eventColors(
  progress: LearnerCalendarProgress | undefined,
  overdue: boolean,
): { bg: string; border: string; text: string } {
  if (progress?.status === 'completed' && (progress.overallPercentage ?? 0) >= 100) {
    return { bg: '#16a34a', border: '#15803d', text: '#ffffff' };
  }
  if (progress?.status === 'in_progress') {
    return { bg: '#9333ea', border: '#7e22ce', text: '#ffffff' };
  }
  if (overdue) {
    return { bg: '#dc2626', border: '#b91c1c', text: '#ffffff' };
  }
  return { bg: '#0ea5e9', border: '#0284c7', text: '#ffffff' };
}

function isMonthOverdue(a: LearnerCalendarAssignment): boolean {
  return isOverdueInCycle(a);
}

export default function LearnerTrainingCalendar({
  assignments,
  progressMap,
  onOpen,
  onClose,
}: {
  assignments: LearnerCalendarAssignment[];
  progressMap: Map<string, LearnerCalendarProgress>;
  onOpen: (sopCode: string) => void;
  onClose: () => void;
}) {
  const events = useMemo<EventInput[]>(() => {
    return assignments.map((a) => {
      const progress = progressMap.get(a.sopCode);
      const overdue =
        progress?.status !== 'completed' && isMonthOverdue(a);
      const colors = eventColors(progress, overdue);
      const hasExactDate = Boolean(a.examDate);
      const title = hasExactDate
        ? `${a.sopCode} — ${a.sopName || 'Training'}`
        : `${a.sopCode} — due ${a.monthName.slice(0, 3)} ${a.year}`;
      return {
        id: `${a.sopCode}-${a.year}-${a.month}`,
        title,
        start: eventDate(a),
        allDay: true,
        backgroundColor: colors.bg,
        borderColor: colors.border,
        textColor: colors.text,
        extendedProps: { sopCode: a.sopCode, hasExactDate },
      };
    });
  }, [assignments, progressMap]);

  const handleEventClick = (info: EventClickArg) => {
    const sopCode = info.event.extendedProps?.sopCode as string | undefined;
    if (sopCode) {
      onClose();
      onOpen(sopCode);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-purple-600" />
            <div>
              <h2 className="text-sm font-bold text-gray-800">Training Calendar</h2>
              <p className="text-[11px] text-gray-500">
                Exam dates from the training schedule · click an item to open training
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            aria-label="Close calendar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap gap-3 border-b border-gray-100 px-4 py-2 text-[10px] text-gray-500">
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-600" /> Completed</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-purple-600" /> In progress</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-600" /> Overdue</span>
          <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-sky-500" /> Upcoming / due</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3 [&_.fc]:text-xs [&_.fc-toolbar-title]:text-sm [&_.fc-button]:text-[11px] [&_.fc-daygrid-event]:cursor-pointer">
          <FullCalendar
            plugins={[dayGridPlugin]}
            initialView="dayGridMonth"
            headerToolbar={{ left: 'prev,next today', center: 'title', right: '' }}
            height="auto"
            events={events}
            eventClick={handleEventClick}
            dayMaxEvents={3}
          />
        </div>
      </div>
    </div>
  );
}
