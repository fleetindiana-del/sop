'use client';

import { useCallback, useContext, useEffect, useMemo, useState, createContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle, ArrowDown, ArrowUp, ArrowUpDown, Check, ClipboardList, Eye, Hash,
  Loader2, Plus, RotateCcw, Save, Search, Settings2, ShieldCheck, Shuffle, Timer, Trash2, X,
  type LucideIcon,
} from 'lucide-react';
import {
  lmsClientFields,
  LMS_CLIENT_FRESH_MS,
  readLmsClientCache,
  writeLmsClientCache,
  invalidateLmsClientFields,
} from '@/lib/lmsCache';
import { getDeptLabelClasses } from '@/lib/department-colors';

/** How questions/options are presented for a SOP exam. */
export type ShuffleMode = 'options' | 'questions' | 'both' | 'none';

export interface SopEmployeeExamRule {
  employeeId: string;
  employeeName: string;
  department?: string;
  designation?: string;
  /** When true, Pass % is locked at 100. */
  isTrainer?: boolean;
  trialQuestionCount: number;
  examQuestionCount: number;
  passingScore: number;
  maxAttempts: number;
  timeLimitMinutes: number;
  shuffleMode: ShuffleMode;
  showAnswersAfterTrial: boolean;
  allowRetakeAfterPass: boolean;
}

export interface SopExamSettingsValues {
  trialQuestionCount: number;
  examQuestionCount: number;
  passingScore: number;
  maxAttempts: number;
  timeLimitMinutes: number;
  shuffleMode: ShuffleMode;
  showAnswersAfterTrial: boolean;
  allowRetakeAfterPass: boolean;
  lmsApproved: boolean;
  employeeRules: SopEmployeeExamRule[];
}

export interface SopExamRow {
  sopCode: string;
  sopName: string;
  department: string;
  bankQuestionCount: number;
  hasOverride: boolean;
  employeeRuleCount?: number;
  settings: SopExamSettingsValues | null;
  effective: SopExamSettingsValues;
}

interface EmployeeMeta {
  id: string;
  name: string;
  department: string;
  designation: string;
  isTrainer?: boolean;
}

interface ListPayload {
  globalDefaults: SopExamSettingsValues;
  sops: SopExamRow[];
  departments?: string[];
}

export type SopExamSettingsApiPaths = {
  /** GET/PATCH settings list endpoint */
  settings: string;
  /** GET employee meta for a SOP: receive sopCode, return full URL */
  metaForSop: (sopCode: string) => string;
};

const DEFAULT_API_PATHS: SopExamSettingsApiPaths = {
  settings: '/api/lms/admin/sop-exam-settings',
  metaForSop: (sopCode) => `/api/lms/admin/meta?sopCode=${encodeURIComponent(sopCode)}`,
};

const SopExamApiContext = createContext<SopExamSettingsApiPaths>(DEFAULT_API_PATHS);

type SortKey =
  | 'sopCode'
  | 'sopName'
  | 'department'
  | 'trialQuestionCount'
  | 'examQuestionCount'
  | 'passingScore'
  | 'maxAttempts'
  | 'timeLimitMinutes'
  | 'shuffleMode'
  | 'source';

type SortDir = 'asc' | 'desc';

const SHUFFLE_OPTIONS: {
  value: ShuffleMode;
  title: string;
  description: string;
}[] = [
  {
    value: 'options',
    title: '1 — Shuffle options',
    description: 'Same questions for every employee; A/B/C/D order is randomised.',
  },
  {
    value: 'questions',
    title: '2 — Shuffle questions',
    description: 'Different questions are drawn for different employees from the bank.',
  },
  {
    value: 'both',
    title: '3 — Shuffle both',
    description: 'Different questions per employee, and options are randomised.',
  },
  {
    value: 'none',
    title: '4 — No shuffle',
    description: 'Same questions and same option order for every employee.',
  },
];

function shuffleLabel(mode: ShuffleMode): string {
  switch (mode) {
    case 'options': return 'Options only';
    case 'questions': return 'Questions';
    case 'both': return 'Both';
    case 'none': return 'None';
  }
}

function normalizeSettings(
  s: Partial<SopExamSettingsValues> | null | undefined,
  fallback?: Partial<SopExamSettingsValues>,
): SopExamSettingsValues {
  return {
    trialQuestionCount: s?.trialQuestionCount ?? fallback?.trialQuestionCount ?? 5,
    examQuestionCount: s?.examQuestionCount ?? fallback?.examQuestionCount ?? 20,
    passingScore: s?.passingScore ?? fallback?.passingScore ?? 80,
    maxAttempts: s?.maxAttempts ?? fallback?.maxAttempts ?? 0,
    timeLimitMinutes: s?.timeLimitMinutes ?? fallback?.timeLimitMinutes ?? 0,
    shuffleMode: s?.shuffleMode ?? fallback?.shuffleMode ?? 'questions',
    showAnswersAfterTrial: s?.showAnswersAfterTrial ?? fallback?.showAnswersAfterTrial ?? true,
    allowRetakeAfterPass: s?.allowRetakeAfterPass ?? fallback?.allowRetakeAfterPass ?? true,
    lmsApproved: s?.lmsApproved ?? fallback?.lmsApproved ?? false,
    employeeRules: Array.isArray(s?.employeeRules)
      ? s!.employeeRules!
      : (fallback?.employeeRules ?? []),
  };
}

function sortValue(row: SopExamRow, key: SortKey): string | number {
  const e = row.effective;
  switch (key) {
    case 'sopCode': return row.sopCode.toLowerCase();
    case 'sopName': return row.sopName.toLowerCase();
    case 'department': return row.department.toLowerCase();
    case 'trialQuestionCount': return e.trialQuestionCount;
    case 'examQuestionCount': return e.examQuestionCount;
    case 'passingScore': return e.passingScore;
    case 'maxAttempts': return e.maxAttempts === 0 ? Number.POSITIVE_INFINITY : e.maxAttempts;
    case 'timeLimitMinutes': return e.timeLimitMinutes;
    case 'shuffleMode': return e.shuffleMode;
    case 'source': return row.hasOverride ? 1 : 0;
  }
}

function SettingsCard({
  icon: Icon, title, subtitle, children,
}: {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
      <div className="flex items-center gap-3 border-b border-gray-100 px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-50 text-purple-600">
          <Icon className="h-4.5 w-4.5" />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-gray-900">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-gray-600">{subtitle}</p>}
        </div>
      </div>
      <div className="divide-y divide-gray-100">{children}</div>
    </section>
  );
}

function NumberInput({
  label, description, value, onChange, min, max, unit,
}: {
  label: string; description: string; value: number;
  onChange: (v: number) => void; min: number; max?: number; unit?: string;
}) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const n = Number(raw);
    let next = Number.isFinite(n) ? Math.round(n) : min;
    if (next < min) next = min;
    if (max != null && next > max) next = max;
    setText(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-gray-600">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          type="text"
          inputMode="numeric"
          value={text}
          onChange={(e) => {
            const raw = e.target.value.trim();
            if (raw === '' || /^\d+$/.test(raw)) setText(raw);
          }}
          onBlur={() => commit(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            }
          }}
          className="w-16 rounded-lg border border-gray-300 bg-white px-2 py-2 text-center text-sm font-bold text-gray-900 shadow-sm transition focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-100"
        />
        {unit && <span className="text-xs font-semibold text-gray-700">{unit}</span>}
      </div>
    </div>
  );
}

function Toggle({
  label, description, checked, onChange,
}: {
  label: string; description: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-gray-900">{label}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-gray-600">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-300 ${
          checked ? 'bg-purple-600' : 'bg-gray-300'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </button>
    </div>
  );
}

function SopEmployeeRulesModal({
  open,
  onClose,
  sopCode,
  sopName,
  rules,
  defaults,
  onChange,
}: {
  open: boolean;
  onClose: () => void;
  sopCode: string;
  sopName: string;
  rules: SopEmployeeExamRule[];
  defaults: SopExamSettingsValues;
  onChange: (rules: SopEmployeeExamRule[]) => void;
}) {
  const api = useContext(SopExamApiContext);
  const [employees, setEmployees] = useState<EmployeeMeta[]>([]);
  const [metaLoading, setMetaLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [empSearch, setEmpSearch] = useState('');
  const [draft, setDraft] = useState({
    trialQuestionCount: defaults.trialQuestionCount,
    examQuestionCount: defaults.examQuestionCount,
    passingScore: defaults.passingScore,
    maxAttempts: defaults.maxAttempts,
    timeLimitMinutes: defaults.timeLimitMinutes,
    shuffleMode: defaults.shuffleMode as ShuffleMode,
    showAnswersAfterTrial: defaults.showAnswersAfterTrial,
    allowRetakeAfterPass: defaults.allowRetakeAfterPass,
    isTrainer: false,
  });
  const [addErr, setAddErr] = useState('');

  useEffect(() => {
    if (!open) return;
    setMetaLoading(true);
    setEmployees([]);
    const cacheField = lmsClientFields.adminMetaForSop(sopCode);
    const cached = readLmsClientCache<{ employees: EmployeeMeta[] }>(cacheField);
    if (cached?.value?.employees) {
      setEmployees(cached.value.employees);
      setMetaLoading(false);
      if (Date.now() - cached.cachedAt <= LMS_CLIENT_FRESH_MS) return;
    }
    fetch(api.metaForSop(sopCode), { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        setEmployees(d.employees ?? []);
        writeLmsClientCache(cacheField, d);
      })
      .finally(() => setMetaLoading(false));
  }, [open, sopCode, api]);

  useEffect(() => {
    if (!open) return;
    setDraft({
      trialQuestionCount: defaults.trialQuestionCount,
      examQuestionCount: defaults.examQuestionCount,
      passingScore: defaults.passingScore,
      maxAttempts: defaults.maxAttempts,
      timeLimitMinutes: defaults.timeLimitMinutes,
      shuffleMode: defaults.shuffleMode,
      showAnswersAfterTrial: defaults.showAnswersAfterTrial,
      allowRetakeAfterPass: defaults.allowRetakeAfterPass,
      isTrainer: false,
    });
    setSelectedIds(new Set());
    setAddErr('');
    setEmpSearch('');
  }, [open, defaults]);

  const filteredEmps = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.department.toLowerCase().includes(q) ||
        e.designation.toLowerCase().includes(q),
    );
  }, [employees, empSearch]);

  const toggleEmp = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);

      // If any selected employee is a trainer from Employee Master, default
      // the draft to Trainer mode (Pass % = 100).
      const selected = employees.filter((e) => next.has(e.id));
      const anyTrainer = selected.some((e) => e.isTrainer);
      if (anyTrainer) {
        setDraft((d) => ({ ...d, isTrainer: true, passingScore: 100 }));
      }
      return next;
    });
    setAddErr('');
  };

  const setDraftTrainer = (checked: boolean) => {
    setDraft((d) => ({
      ...d,
      isTrainer: checked,
      passingScore: checked ? 100 : defaults.passingScore,
    }));
  };

  const addRules = () => {
    setAddErr('');
    if (selectedIds.size === 0) {
      setAddErr('Select at least one employee.');
      return;
    }
    const existing = new Set(rules.map((r) => r.employeeId));
    const toAdd: SopEmployeeExamRule[] = [];
    for (const id of selectedIds) {
      if (existing.has(id)) continue;
      const emp = employees.find((e) => e.id === id);
      if (!emp) continue;
      const isTrainer = draft.isTrainer || emp.isTrainer === true;
      toAdd.push({
        employeeId: emp.id,
        employeeName: emp.name,
        department: emp.department,
        designation: emp.designation,
        isTrainer,
        trialQuestionCount: draft.trialQuestionCount,
        examQuestionCount: draft.examQuestionCount,
        passingScore: isTrainer ? 100 : draft.passingScore,
        maxAttempts: draft.maxAttempts,
        timeLimitMinutes: draft.timeLimitMinutes,
        shuffleMode: draft.shuffleMode,
        showAnswersAfterTrial: draft.showAnswersAfterTrial,
        allowRetakeAfterPass: draft.allowRetakeAfterPass,
      });
    }
    if (toAdd.length === 0) {
      setAddErr('Selected employees already have a rule. Edit their row below to change values.');
      return;
    }
    onChange([...rules, ...toAdd]);
    setSelectedIds(new Set());
  };

  const removeRule = (employeeId: string) => {
    onChange(rules.filter((r) => r.employeeId !== employeeId));
  };

  const updateRule = (employeeId: string, patch: Partial<SopEmployeeExamRule>) => {
    onChange(rules.map((r) => (r.employeeId === employeeId ? { ...r, ...patch } : r)));
  };

  if (!open) return null;

  const inputCls = 'w-14 rounded border border-gray-300 px-1.5 py-1.5 text-center text-sm font-bold text-gray-900';

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto bg-black/40 px-4 py-8 sm:py-12"
      onClick={onClose}
    >
      <div
        className="my-auto flex max-h-[min(90vh,calc(100vh-4rem))] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-200 px-5 py-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-indigo-800">
              <Settings2 className="h-4 w-4" /> Advanced employee rules
            </p>
            <h2 className="mt-2 truncate text-base font-bold text-gray-900">
              <span className="font-mono text-purple-800">{sopCode}</span>
              <span className="mx-1.5 text-gray-900">·</span>
              {sopName}
            </h2>
            <p className="mt-2 text-sm font-medium leading-relaxed text-gray-900">
              Each employee can have different values. Add one (or several with the same settings), then edit each row to customize.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-900 transition hover:bg-gray-100"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <section>
            <p className="mb-2 text-sm font-bold uppercase tracking-wider text-gray-900">
              Current rules ({rules.length})
            </p>
            {rules.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-4 py-8 text-center text-sm font-semibold text-gray-900">
                No employee rules yet — SOP settings apply to everyone.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-200 bg-gray-50">
                    <tr>
                      <th className="px-3 py-2.5 text-left font-bold text-gray-900">Employee</th>
                      <th className="px-2 py-2.5 text-center font-bold text-gray-900">Trainer</th>
                      <th className="px-2 py-2.5 text-center font-bold text-gray-900">Demo</th>
                      <th className="px-2 py-2.5 text-center font-bold text-gray-900">Exam</th>
                      <th className="px-2 py-2.5 text-center font-bold text-gray-900">Pass %</th>
                      <th className="px-2 py-2.5 text-center font-bold text-gray-900">Attempts</th>
                      <th className="px-2 py-2.5 text-center font-bold text-gray-900">Time</th>
                      <th className="px-2 py-2.5 text-left font-bold text-gray-900">Shuffle</th>
                      <th className="px-3 py-2.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {rules.map((r) => (
                      <tr key={r.employeeId} className="hover:bg-gray-50">
                        <td className="px-3 py-2.5">
                          <p className="font-bold text-gray-900">{r.employeeName}</p>
                          <p className="text-sm font-medium text-gray-900">
                            {[r.department, r.designation].filter(Boolean).join(' · ') || '—'}
                          </p>
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          <input
                            type="checkbox"
                            checked={!!r.isTrainer}
                            onChange={(e) => {
                              const checked = e.target.checked;
                              updateRule(r.employeeId, {
                                isTrainer: checked,
                                ...(checked ? { passingScore: 100 } : {}),
                              });
                            }}
                            className="h-4 w-4 rounded border-gray-400 text-indigo-600 focus:ring-indigo-400"
                            title="Trainer — requires 100% to pass"
                          />
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={r.trialQuestionCount}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (e.target.value === '' || (!isNaN(n) && n >= 0 && n <= 50)) {
                                updateRule(r.employeeId, { trialQuestionCount: e.target.value === '' ? 0 : n });
                              }
                            }}
                            className={inputCls}
                          />
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={r.examQuestionCount}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (!isNaN(n) && n >= 1 && n <= 200) {
                                updateRule(r.employeeId, { examQuestionCount: n });
                              }
                            }}
                            className={inputCls}
                          />
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={r.isTrainer ? 100 : r.passingScore}
                            disabled={!!r.isTrainer}
                            onChange={(e) => {
                              if (r.isTrainer) return;
                              const n = Number(e.target.value);
                              if (!isNaN(n) && n >= 1 && n <= 100) {
                                updateRule(r.employeeId, { passingScore: n });
                              }
                            }}
                            className={`${inputCls} ${r.isTrainer ? 'cursor-not-allowed bg-indigo-50 text-indigo-900' : ''}`}
                            title={r.isTrainer ? 'Trainers must achieve 100%' : undefined}
                          />
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={r.maxAttempts}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (e.target.value === '' || (!isNaN(n) && n >= 0)) {
                                updateRule(r.employeeId, { maxAttempts: e.target.value === '' ? 0 : n });
                              }
                            }}
                            className={inputCls}
                          />
                        </td>
                        <td className="px-2 py-2.5 text-center">
                          <input
                            type="text"
                            inputMode="numeric"
                            value={r.timeLimitMinutes}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              if (e.target.value === '' || (!isNaN(n) && n >= 0)) {
                                updateRule(r.employeeId, { timeLimitMinutes: e.target.value === '' ? 0 : n });
                              }
                            }}
                            className={inputCls}
                          />
                        </td>
                        <td className="px-2 py-2.5">
                          <select
                            value={r.shuffleMode}
                            onChange={(e) => updateRule(r.employeeId, { shuffleMode: e.target.value as ShuffleMode })}
                            className="rounded border border-gray-300 bg-white px-2 py-1.5 text-sm font-semibold text-gray-900"
                          >
                            <option value="options">Options</option>
                            <option value="questions">Questions</option>
                            <option value="both">Both</option>
                            <option value="none">None</option>
                          </select>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => removeRule(r.employeeId)}
                            className="rounded p-1.5 text-red-700 transition hover:bg-red-50 hover:text-red-800"
                            title="Remove rule"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-4">
            <p className="mb-1 text-sm font-bold uppercase tracking-wider text-indigo-900">Add new rule</p>
            <p className="mb-3 text-sm font-medium leading-relaxed text-gray-900">
              Only employees assigned to this SOP are listed. For different settings per person, add them one at a time (or add all then edit each row above).
            </p>
            {metaLoading ? (
              <p className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading employees…
              </p>
            ) : (
              <>
                <div className="relative mb-2">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-900" />
                  <input
                    type="search"
                    value={empSearch}
                    onChange={(e) => setEmpSearch(e.target.value)}
                    placeholder="Search employees…"
                    className="w-full rounded-lg border border-gray-300 bg-white py-2.5 pl-9 pr-3 text-sm font-semibold text-gray-900 placeholder:text-gray-900"
                  />
                </div>
                <div className="mb-3 max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-white">
                  {filteredEmps.length === 0 ? (
                    <p className="px-3 py-4 text-center text-sm font-semibold text-gray-900">
                      {empSearch.trim()
                        ? 'No assigned employees match your search.'
                        : 'No employees are assigned to this SOP in the training matrix.'}
                    </p>
                  ) : (
                    filteredEmps.map((e) => {
                      const checked = selectedIds.has(e.id);
                      const already = rules.some((r) => r.employeeId === e.id);
                      return (
                        <label
                          key={e.id}
                          className={`flex cursor-pointer items-center gap-2.5 border-b border-gray-100 px-3 py-2.5 last:border-0 ${
                            already ? 'opacity-50' : 'hover:bg-gray-50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={already}
                            onChange={() => toggleEmp(e.id)}
                            className="rounded border-gray-400 text-indigo-600 focus:ring-indigo-400"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-bold text-gray-900">
                              {e.name}
                              {e.isTrainer && (
                                <span className="ml-1.5 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-indigo-800">
                                  Trainer
                                </span>
                              )}
                            </span>
                            <span className="block truncate text-sm font-medium text-gray-900">
                              {e.department} · {e.designation}
                            </span>
                          </span>
                          {already && <span className="text-sm font-bold text-indigo-800">Has rule</span>}
                        </label>
                      );
                    })
                  )}
                </div>

                <label className="mb-3 flex cursor-pointer items-center gap-2.5 rounded-lg border border-indigo-200 bg-white px-3 py-2.5">
                  <input
                    type="checkbox"
                    checked={draft.isTrainer}
                    onChange={(e) => setDraftTrainer(e.target.checked)}
                    className="h-4 w-4 rounded border-gray-400 text-indigo-600 focus:ring-indigo-400"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-gray-900">Trainer</span>
                    <span className="block text-xs font-medium text-gray-600">
                      Requires 100% Pass on this exam (locked when checked).
                    </span>
                  </span>
                </label>

                <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  {(
                    [
                      ['trialQuestionCount', 'Demo Q', 0, 50],
                      ['examQuestionCount', 'Exam Q', 1, 200],
                      ['passingScore', 'Pass %', 1, 100],
                      ['maxAttempts', 'Attempts', 0, 999],
                      ['timeLimitMinutes', 'Time (min)', 0, 600],
                    ] as const
                  ).map(([key, label, min, max]) => (
                    <label key={key} className="text-sm font-bold text-gray-900">
                      {label}
                      <input
                        type="text"
                        inputMode="numeric"
                        value={key === 'passingScore' && draft.isTrainer ? 100 : draft[key]}
                        disabled={key === 'passingScore' && draft.isTrainer}
                        onChange={(e) => {
                          if (key === 'passingScore' && draft.isTrainer) return;
                          const raw = e.target.value.trim();
                          if (raw === '') {
                            if (min === 0) setDraft((d) => ({ ...d, [key]: 0 }));
                            return;
                          }
                          const n = Number(raw);
                          if (!isNaN(n) && n >= min && n <= max) {
                            setDraft((d) => ({ ...d, [key]: n }));
                          }
                        }}
                        className={`mt-1 w-full rounded border border-gray-300 px-2 py-2 text-sm font-bold text-gray-900 ${
                          key === 'passingScore' && draft.isTrainer
                            ? 'cursor-not-allowed bg-indigo-50 text-indigo-900'
                            : ''
                        }`}
                      />
                    </label>
                  ))}
                  <label className="text-sm font-bold text-gray-900">
                    Shuffle
                    <select
                      value={draft.shuffleMode}
                      onChange={(e) => setDraft((d) => ({ ...d, shuffleMode: e.target.value as ShuffleMode }))}
                      className="mt-1 w-full rounded border border-gray-300 bg-white px-2 py-2 text-sm font-bold text-gray-900"
                    >
                      <option value="options">Options</option>
                      <option value="questions">Questions</option>
                      <option value="both">Both</option>
                      <option value="none">None</option>
                    </select>
                  </label>
                </div>

                <button
                  type="button"
                  onClick={addRules}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
                >
                  <Plus className="h-4 w-4" />
                  Add rule for {selectedIds.size || 0} selected employee{selectedIds.size === 1 ? '' : 's'}
                </button>
                {addErr && (
                  <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold text-red-700">
                    <AlertCircle className="h-4 w-4" /> {addErr}
                  </p>
                )}
              </>
            )}
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <p className="text-sm font-medium text-gray-900">
            Priority: Employee rule &gt; SOP settings &gt; Global. Remember to save SOP settings after closing.
          </p>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-gray-800"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(modal, document.body);
}

function EditPanel({
  row,
  globalDefaults,
  onClose,
  onSaved,
}: {
  row: SopExamRow;
  globalDefaults: SopExamSettingsValues;
  onClose: () => void;
  onSaved: (updated: SopExamRow) => void;
}) {
  const api = useContext(SopExamApiContext);
  const defaults = normalizeSettings(globalDefaults);
  const initial = normalizeSettings(row.settings ?? row.effective, defaults);
  const [form, setForm] = useState<SopExamSettingsValues>(initial);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [rulesOpen, setRulesOpen] = useState(false);

  useEffect(() => {
    setForm(normalizeSettings(row.settings ?? row.effective, defaults));
    setSaved(false);
    setError('');
    setRulesOpen(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sync when selected SOP changes
  }, [row.sopCode]);

  const set = <K extends keyof SopExamSettingsValues>(key: K, value: SopExamSettingsValues[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(api.settings, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sopCode: row.sopCode, ...form }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || 'Failed to save'); return; }
      const settings = normalizeSettings(json.settings as SopExamSettingsValues, defaults);
      onSaved({
        ...row,
        hasOverride: true,
        employeeRuleCount: settings.employeeRules.length,
        settings,
        effective: settings,
      });
      setForm(settings);
      invalidateLmsClientFields(lmsClientFields.adminSopExamSettings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    setError('');
    try {
      const res = await fetch(api.settings, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sopCode: row.sopCode, reset: true }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || 'Failed to reset'); return; }
      onSaved({
        ...row,
        hasOverride: false,
        employeeRuleCount: 0,
        settings: null,
        effective: defaults,
      });
      setForm(defaults);
      invalidateLmsClientFields(lmsClientFields.adminSopExamSettings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
        <div className="min-w-0">
          <p className="font-mono text-xs font-bold text-purple-700">{row.sopCode}</p>
          <h2 className="mt-0.5 truncate text-sm font-bold text-gray-900">{row.sopName}</h2>
          <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-800">
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${getDeptLabelClasses(row.department)}`}>
              {row.department}
            </span>
            <span className="font-semibold">{row.bankQuestionCount} MCQs in bank</span>
            {row.hasOverride
              ? <span className="rounded-md bg-purple-100 px-1.5 py-0.5 text-[10px] font-bold text-purple-800">Custom</span>
              : <span className="rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-800">Using global</span>}
            {form.employeeRules.length > 0 && (
              <span className="rounded-md bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-800">
                {form.employeeRules.length} emp rule{form.employeeRules.length === 1 ? '' : 's'}
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg p-1.5 text-gray-700 transition hover:bg-gray-100 hover:text-gray-900"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        <button
          type="button"
          onClick={() => setRulesOpen(true)}
          className="flex w-full items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-3 text-left transition hover:border-indigo-300 hover:bg-indigo-100/70"
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <Settings2 className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-bold text-indigo-950">Advanced employee rules</p>
              <p className="mt-0.5 text-xs text-indigo-800/80">
                Different settings per employee on this SOP
                {form.employeeRules.length > 0
                  ? ` · ${form.employeeRules.length} rule${form.employeeRules.length === 1 ? '' : 's'}`
                  : ''}
              </p>
            </div>
          </div>
          <span className="shrink-0 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-bold text-white">
            Open
          </span>
        </button>

        <div className="overflow-hidden rounded-2xl border border-purple-200 bg-linear-to-br from-purple-50 to-white p-4 shadow-sm">
          <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-purple-700">
            <ClipboardList className="h-3.5 w-3.5" /> How the quiz works
          </p>
          <div className="mt-3 grid gap-2">
            <div className="flex items-start gap-2.5 rounded-xl border border-purple-100 bg-white/80 p-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-purple-600 text-[10px] font-bold text-white">1</span>
              <p className="text-xs leading-relaxed text-gray-800">
                <span className="font-bold text-gray-900">Demo</span> — {form.trialQuestionCount === 0 ? 'skipped' : `${form.trialQuestionCount} questions, no pass/fail${form.showAnswersAfterTrial ? ', answers shown after' : ''}`}.
              </p>
            </div>
            <div className="flex items-start gap-2.5 rounded-xl border border-purple-100 bg-white/80 p-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-purple-600 text-[10px] font-bold text-white">2</span>
              <p className="text-xs leading-relaxed text-gray-800">
                <span className="font-bold text-gray-900">Exam</span> — {form.examQuestionCount} questions, ≥{form.passingScore}%
                {form.timeLimitMinutes > 0 ? `, ${form.timeLimitMinutes} min` : ', no time limit'}.
              </p>
            </div>
          </div>
        </div>

        <SettingsCard icon={ShieldCheck} title="SOP Approval Status" subtitle="Shows MCQ Bank approval status in LMS (does not lock the exam).">
          <div className={`rounded-xl border px-3.5 py-3 ${
            form.lmsApproved
              ? 'border-emerald-200 bg-emerald-50'
              : 'border-amber-200 bg-amber-50'
          }`}>
            <p className={`text-sm font-semibold ${form.lmsApproved ? 'text-emerald-800' : 'text-amber-900'}`}>
              {form.lmsApproved ? 'Approved (MCQ Bank)' : 'Not Approved (MCQ Bank)'}
            </p>
            <p className={`mt-1 text-xs leading-relaxed ${form.lmsApproved ? 'text-emerald-700' : 'text-amber-800'}`}>
              {form.lmsApproved
                ? 'All questions for this SOP are checked in the MCQ Bank — LMS shows ✔.'
                : 'Some questions are still unchecked in MCQ Bank — LMS shows ✖. Learners can still take the exam.'}
            </p>
          </div>
        </SettingsCard>

        <SettingsCard icon={Hash} title="Question Count" subtitle="How many questions appear in each stage.">
          <NumberInput
            label="Demo Assessment Questions"
            description="Questions on the first attempt (demo — no pass/fail). Set to 0 to skip the demo."
            value={form.trialQuestionCount}
            onChange={(v) => set('trialQuestionCount', v)}
            min={0}
            max={50}
          />
          <NumberInput
            label="Exam Questions"
            description={`Formal exam count. Bank has ${row.bankQuestionCount} MCQs.`}
            value={form.examQuestionCount}
            onChange={(v) => set('examQuestionCount', v)}
            min={1}
            max={200}
          />
        </SettingsCard>

        <SettingsCard icon={ClipboardList} title="Pass Criteria" subtitle="Score and attempts for this SOP.">
          <NumberInput
            label="Passing Mark"
            description="Minimum score (%) required to pass."
            value={form.passingScore}
            onChange={(v) => set('passingScore', v)}
            min={1}
            max={100}
            unit="%"
          />
          <NumberInput
            label="Maximum Attempts"
            description="Max exam attempts (0 = unlimited)."
            value={form.maxAttempts}
            onChange={(v) => set('maxAttempts', v)}
            min={0}
            unit="attempts"
          />
        </SettingsCard>

        <SettingsCard icon={Timer} title="Time Limit" subtitle="Cap how long learners have for this SOP exam.">
          <NumberInput
            label="Exam Time Limit"
            description="Minutes allowed. Set to 0 for no limit."
            value={form.timeLimitMinutes}
            onChange={(v) => set('timeLimitMinutes', v)}
            min={0}
            unit="minutes"
          />
        </SettingsCard>

        <SettingsCard icon={Shuffle} title="Shuffle Mode" subtitle="Four ways to present questions to employees.">
          <div className="space-y-2 px-5 py-4">
            {SHUFFLE_OPTIONS.map((opt) => {
              const active = form.shuffleMode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => set('shuffleMode', opt.value)}
                  className={`flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition ${
                    active
                      ? 'border-purple-300 bg-purple-50 ring-2 ring-purple-100'
                      : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                      active ? 'border-purple-600' : 'border-gray-400'
                    }`}
                  >
                    {active && <span className="h-2 w-2 rounded-full bg-purple-600" />}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-sm font-bold ${active ? 'text-purple-900' : 'text-gray-900'}`}>
                      {opt.title}
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-gray-700">
                      {opt.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsCard>

        <SettingsCard icon={Eye} title="Demo & Retake" subtitle="Answer visibility and post-pass retakes.">
          <Toggle
            label="Show Answers After Demo"
            description="Display correct answers after the demo assessment."
            checked={form.showAnswersAfterTrial}
            onChange={(v) => set('showAnswersAfterTrial', v)}
          />
          <Toggle
            label="Allow Retake After Passing"
            description="Let employees retake even after they have already passed."
            checked={form.allowRetakeAfterPass}
            onChange={(v) => set('allowRetakeAfterPass', v)}
          />
        </SettingsCard>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-gray-100 bg-gray-50/80 px-5 py-3">
        <button
          type="button"
          onClick={reset}
          disabled={resetting || saving || !row.hasOverride}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-gray-800 transition hover:bg-white hover:text-gray-900 disabled:opacity-40"
          title={!row.hasOverride ? 'Already using global defaults' : 'Revert to global LMS settings'}
        >
          {resetting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          Use global
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saving || resetting}
          className={`flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-semibold text-white shadow transition disabled:opacity-50 ${
            saved ? 'bg-green-600' : 'bg-purple-600 hover:bg-purple-700'
          }`}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {saving ? 'Saving…' : saved ? 'Saved!' : 'Save SOP settings'}
        </button>
      </div>

      <SopEmployeeRulesModal
        open={rulesOpen}
        onClose={() => setRulesOpen(false)}
        sopCode={row.sopCode}
        sopName={row.sopName}
        rules={form.employeeRules}
        defaults={form}
        onChange={(rules) => set('employeeRules', rules)}
      />
    </div>
  );
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <ArrowUpDown className="ml-0.5 inline h-3 w-3 text-gray-500 opacity-70" />;
  return dir === 'asc'
    ? <ArrowUp className="ml-0.5 inline h-3 w-3 text-purple-700" />
    : <ArrowDown className="ml-0.5 inline h-3 w-3 text-purple-700" />;
}

export function SopExamSettingsPanel({
  apiPaths = DEFAULT_API_PATHS,
}: {
  apiPaths?: SopExamSettingsApiPaths;
} = {}) {
  const [globalDefaults, setGlobalDefaults] = useState<SopExamSettingsValues | null>(null);
  const [sops, setSops] = useState<SopExamRow[]>([]);
  const [dashboardDepartments, setDashboardDepartments] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [deptFilters, setDeptFilters] = useState<string[]>([]);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('sopCode');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const load = useCallback(async (force = false) => {
    if (!force) {
      const cached = readLmsClientCache<ListPayload>(lmsClientFields.adminSopExamSettings);
      if (cached?.value?.sops) {
        setGlobalDefaults(normalizeSettings(cached.value.globalDefaults));
        setDashboardDepartments(cached.value.departments ?? []);
        setSops(
          (cached.value.sops ?? []).map((s) => ({
            ...s,
            settings: s.settings ? normalizeSettings(s.settings) : null,
            effective: normalizeSettings(s.effective ?? s.settings, cached.value.globalDefaults),
            employeeRuleCount: s.settings?.employeeRules?.length ?? s.employeeRuleCount ?? 0,
          })),
        );
        setLoading(false);
        if (Date.now() - cached.cachedAt <= LMS_CLIENT_FRESH_MS) return;
      }
    }
    try {
      const res = await fetch(apiPaths.settings, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) { setError(json.error || 'Failed to load'); return; }
      setGlobalDefaults(normalizeSettings(json.globalDefaults));
      setDashboardDepartments(Array.isArray(json.departments) ? json.departments : []);
      setSops(
        (json.sops ?? []).map((s: SopExamRow) => ({
          ...s,
          settings: s.settings ? normalizeSettings(s.settings) : null,
          effective: normalizeSettings(s.effective ?? s.settings, json.globalDefaults),
          employeeRuleCount: s.settings?.employeeRules?.length ?? s.employeeRuleCount ?? 0,
        })),
      );
      writeLmsClientCache(lmsClientFields.adminSopExamSettings, {
        globalDefaults: normalizeSettings(json.globalDefaults),
        departments: Array.isArray(json.departments) ? json.departments : [],
        sops: (json.sops ?? []).map((s: SopExamRow) => ({
          ...s,
          settings: s.settings ? normalizeSettings(s.settings) : null,
          effective: normalizeSettings(s.effective ?? s.settings, json.globalDefaults),
          employeeRuleCount: s.settings?.employeeRules?.length ?? s.employeeRuleCount ?? 0,
        })),
      });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [apiPaths.settings]);

  useEffect(() => { void load(true); }, [load]);

  // When returning from Global Defaults, always re-fetch so Global-sourced rows update.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const departments = useMemo(() => {
    if (dashboardDepartments.length > 0) return dashboardDepartments;
    const set = new Set(sops.map((s) => s.department).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [dashboardDepartments, sops]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const toggleDeptFilter = (dept: string) => {
    setDeptFilters((prev) =>
      prev.includes(dept) ? prev.filter((d) => d !== dept) : [...prev, dept],
    );
  };

  const clearDeptFilters = () => setDeptFilters([]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const deptSet = new Set(deptFilters);
    const rows = sops.filter((s) => {
      if (deptSet.size > 0 && !deptSet.has(s.department)) return false;
      if (!q) return true;
      return (
        s.sopCode.toLowerCase().includes(q) ||
        s.sopName.toLowerCase().includes(q) ||
        s.department.toLowerCase().includes(q)
      );
    });

    rows.sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      let cmp = 0;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true });
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return rows;
  }, [sops, search, deptFilters, sortKey, sortDir]);

  // Drop the side panel selection if that SOP is no longer in the filtered list.
  useEffect(() => {
    if (!selectedCode) return;
    if (!filtered.some((s) => s.sopCode === selectedCode)) {
      setSelectedCode(null);
    }
  }, [filtered, selectedCode]);

  const selected = selectedCode
    ? sops.find((s) => s.sopCode === selectedCode) ?? null
    : null;

  const handleSaved = (updated: SopExamRow) => {
    setSops((prev) => prev.map((s) => (s.sopCode === updated.sopCode ? updated : s)));
  };

  const sortBtn =
    'inline-flex items-center gap-0.5 rounded px-0.5 py-0.5 font-bold uppercase tracking-wide text-gray-800 hover:bg-purple-50 hover:text-purple-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400';

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
      </div>
    );
  }

  return (
    <SopExamApiContext.Provider value={apiPaths}>
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error}
        </div>
      )}

      <div className={`grid gap-4 ${selected ? 'lg:grid-cols-[1fr_440px]' : ''}`}>
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
          <div className="flex flex-col gap-2.5 border-b border-gray-200 bg-gray-50 px-4 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-600" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search SOP code, name, department…"
                  className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-xs font-medium text-gray-900 transition focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-100"
                />
              </div>
              <p className="shrink-0 text-[11px] font-semibold text-gray-800">
                {filtered.length} of {sops.length} SOPs
                {deptFilters.length > 0 && (
                  <span className="ml-1 font-medium text-purple-700">
                    · {deptFilters.length} dept{deptFilters.length === 1 ? '' : 's'}
                  </span>
                )}
                {globalDefaults && (
                  <span className="ml-2 font-medium text-gray-700">
                    · defaults {globalDefaults.examQuestionCount}Q / {globalDefaults.passingScore}%
                  </span>
                )}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[10px] font-bold uppercase tracking-wide text-gray-500">
                Departments
              </span>
              <button
                type="button"
                onClick={clearDeptFilters}
                className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                  deptFilters.length === 0
                    ? 'bg-purple-600 text-white shadow-sm'
                    : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
                }`}
              >
                All
              </button>
              {departments.map((d) => {
                const selected = deptFilters.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => toggleDeptFilter(d)}
                    className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition ${
                      selected
                        ? 'bg-purple-600 text-white shadow-sm'
                        : 'border border-gray-200 bg-white text-gray-600 hover:border-purple-200 hover:bg-purple-50'
                    }`}
                    title={selected ? `Remove ${d}` : `Add ${d}`}
                  >
                    {d}
                  </button>
                );
              })}
              {deptFilters.length > 0 && (
                <button
                  type="button"
                  onClick={clearDeptFilters}
                  className="ml-1 inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-50"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              )}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="px-5 py-12 text-center text-xs font-semibold text-gray-700">
              {sops.length === 0
                ? 'No SOPs with an MCQ bank yet. Generate MCQs first.'
                : deptFilters.length > 0
                  ? `No SOPs match the selected department${deptFilters.length === 1 ? '' : 's'} (${deptFilters.join(', ')}).`
                  : 'No SOPs match your search.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="border-b border-gray-200 bg-gray-100">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10px]">
                      <button type="button" className={sortBtn} onClick={() => toggleSort('sopCode')}>
                        SOP <SortIcon active={sortKey === 'sopCode'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-3 py-2 text-left text-[10px]">
                      <button type="button" className={sortBtn} onClick={() => toggleSort('department')}>
                        Dept <SortIcon active={sortKey === 'department'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-2 py-2 text-center text-[10px]">
                      <button type="button" className={`${sortBtn} mx-auto`} onClick={() => toggleSort('trialQuestionCount')}>
                        Demo <SortIcon active={sortKey === 'trialQuestionCount'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-2 py-2 text-center text-[10px]">
                      <button type="button" className={`${sortBtn} mx-auto`} onClick={() => toggleSort('examQuestionCount')}>
                        Exam <SortIcon active={sortKey === 'examQuestionCount'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-2 py-2 text-center text-[10px]">
                      <button type="button" className={`${sortBtn} mx-auto`} onClick={() => toggleSort('passingScore')}>
                        Pass % <SortIcon active={sortKey === 'passingScore'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-2 py-2 text-center text-[10px]">
                      <button type="button" className={`${sortBtn} mx-auto`} onClick={() => toggleSort('maxAttempts')}>
                        Attempts <SortIcon active={sortKey === 'maxAttempts'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-2 py-2 text-center text-[10px]">
                      <button type="button" className={`${sortBtn} mx-auto`} onClick={() => toggleSort('timeLimitMinutes')}>
                        Time <SortIcon active={sortKey === 'timeLimitMinutes'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-3 py-2 text-left text-[10px]">
                      <button type="button" className={sortBtn} onClick={() => toggleSort('shuffleMode')}>
                        Shuffle <SortIcon active={sortKey === 'shuffleMode'} dir={sortDir} />
                      </button>
                    </th>
                    <th className="px-4 py-2 text-right text-[10px]">
                      <button type="button" className={`${sortBtn} ml-auto`} onClick={() => toggleSort('source')}>
                        Source <SortIcon active={sortKey === 'source'} dir={sortDir} />
                      </button>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((s) => {
                    const active = selectedCode === s.sopCode;
                    const e = s.effective;
                    return (
                      <tr
                        key={s.sopCode}
                        onClick={() => setSelectedCode(s.sopCode)}
                        className={`cursor-pointer transition ${
                          active ? 'bg-purple-50' : 'odd:bg-white even:bg-slate-50/60 hover:bg-purple-50/50'
                        }`}
                      >
                        <td className="max-w-[260px] px-4 py-2.5">
                          <p className="font-mono text-[11px] font-bold text-purple-700">{s.sopCode}</p>
                          <p className="truncate text-[12px] font-bold text-gray-900" title={s.sopName}>
                            {s.sopName}
                          </p>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">
                          <span
                            className={`inline-block max-w-[140px] truncate rounded px-1.5 py-0.5 text-[10px] font-bold ${getDeptLabelClasses(s.department)}`}
                            title={s.department}
                          >
                            {s.department}
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-center text-[12px] font-bold text-gray-900">
                          {e.trialQuestionCount}
                        </td>
                        <td className="px-2 py-2.5 text-center text-[12px] font-bold text-gray-900">
                          {e.examQuestionCount}
                        </td>
                        <td className="px-2 py-2.5 text-center text-[12px] font-bold text-gray-900">
                          {e.passingScore}%
                        </td>
                        <td className="px-2 py-2.5 text-center text-[12px] font-bold text-gray-900">
                          {e.maxAttempts === 0 ? '∞' : e.maxAttempts}
                        </td>
                        <td className="px-2 py-2.5 text-center text-[12px] font-bold text-gray-900">
                          {e.timeLimitMinutes === 0 ? '—' : `${e.timeLimitMinutes}m`}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-[12px] font-bold text-gray-900">
                          {shuffleLabel(e.shuffleMode)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex flex-col items-end gap-1">
                            {s.hasOverride ? (
                              <span className="inline-flex rounded-md bg-purple-100 px-1.5 py-0.5 text-[10px] font-bold text-purple-800">
                                Custom
                              </span>
                            ) : (
                              <span className="inline-flex rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-800">
                                Global
                              </span>
                            )}
                            {(s.employeeRuleCount ?? s.settings?.employeeRules?.length ?? 0) > 0 && (
                              <span className="inline-flex rounded-md bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold text-indigo-800">
                                {s.employeeRuleCount ?? s.settings?.employeeRules?.length} emp
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selected && globalDefaults && (
          <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]">
            <EditPanel
              row={selected}
              globalDefaults={globalDefaults}
              onClose={() => setSelectedCode(null)}
              onSaved={handleSaved}
            />
          </div>
        )}
      </div>
    </div>
    </SopExamApiContext.Provider>
  );
}
