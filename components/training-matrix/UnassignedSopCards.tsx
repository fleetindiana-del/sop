'use client';

import React from 'react';
import { DEPT_COLORS } from '@/lib/trainingExamScheduleShared';
import { displaySopCode } from '@/lib/sop-display';

export type UnassignedCard = {
  sopCode: string;
  sopName: string;
  department: string;
  plannedMonth: number;
  year: number;
  key: string;
};

const MONTH_SHORT = ['', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

type Props = {
  cards: UnassignedCard[];
  monthLabel?: string | null;
  disabled?: boolean;
};

export default function UnassignedSopCards({ cards, monthLabel, disabled }: Props) {
  return (
    <div className="flex flex-col h-full min-h-0 border border-gray-200 rounded-lg bg-white shadow-sm overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 shrink-0">
        <div className="text-sm font-semibold text-gray-900">Needs a date</div>
        <div className="text-[11px] text-gray-500">
          {cards.length} unassigned{monthLabel ? ` · ${monthLabel}` : ''}
          {!disabled && cards.length > 0 ? ' — drag onto a day' : ''}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
        {cards.length === 0 ? (
          <div className="text-xs text-gray-400 italic px-1 py-4 text-center">
            All trainings in this month have exam dates.
          </div>
        ) : (
          cards.map((card) => {
            const color = DEPT_COLORS[card.department] || '#6366f1';
            return (
              <div
                key={card.key}
                className={`unassigned-sop-card rounded-md border border-l-4 px-2.5 py-2 bg-white shadow-sm select-none ${
                  disabled ? 'opacity-60 cursor-default' : 'cursor-grab active:cursor-grabbing hover:shadow'
                }`}
                style={{ borderLeftColor: color }}
                data-sop-code={card.sopCode}
                data-sop-name={card.sopName}
                data-department={card.department}
                data-planned-month={card.plannedMonth}
                data-year={card.year}
                title={disabled ? undefined : 'Drag onto a calendar day'}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-gray-900 truncate">{displaySopCode(card.sopCode)}</span>
                  <span
                    className="text-[10px] font-medium px-1.5 py-0.5 rounded text-white shrink-0"
                    style={{ background: color }}
                  >
                    {card.department}
                  </span>
                </div>
                <div className="text-[11px] text-gray-600 mt-0.5 line-clamp-2 leading-snug">
                  {card.sopName}
                </div>
                <div className="text-[10px] text-gray-400 mt-1">
                  Due {MONTH_SHORT[card.plannedMonth] || card.plannedMonth} {card.year}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
