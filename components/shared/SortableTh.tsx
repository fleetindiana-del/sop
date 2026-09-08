'use client';

import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

export type SortDir = 'asc' | 'desc';

export interface SortState<K extends string> {
  key: K;
  dir: SortDir;
}

/** Clicking the active column flips direction; a new column starts ascending. */
export function toggleSortDir<K extends string>(current: SortState<K>, key: K): SortState<K> {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: 'asc' };
}

/** Blank values sort last in both directions, so "—" never tops the list. */
export function compareText(a: string, b: string): number {
  const left = a.trim();
  const right = b.trim();
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return left.localeCompare(right, undefined, { sensitivity: 'base' });
}

interface SortableThProps {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

/** One clickable, sort-indicating `<th>` — drop into any table's `<thead>` row. */
export function SortableTh({ label, active, dir, onClick, align = 'left', className = '' }: SortableThProps) {
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : '';
  const textAlign = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return (
    <th
      className={`px-4 py-2.5 font-semibold ${textAlign} ${className}`}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={onClick}
        title={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex w-full items-center gap-1 uppercase tracking-wide transition hover:text-gray-800 ${justify} ${
          active ? 'font-bold text-violet-700' : 'font-semibold'
        }`}
      >
        {label}
        {active ? (
          dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
        ) : (
          <ChevronsUpDown className="h-3 w-3 text-gray-300" />
        )}
      </button>
    </th>
  );
}
