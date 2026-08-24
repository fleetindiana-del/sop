'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import {
  EmployeeTrainingGrid,
  buildMonthlyBreakdown,
  type EmployeeGridRow,
  type MonthBreakdown,
  type SopBreakdown,
} from '@/components/employees/EmployeeTrainingGrid';
import {
  ArrowLeft, Plus, Search, Pencil, Trash2, X, Check,
  UserRound, RefreshCw, AlertTriangle, GraduationCap, KeyRound, Copy,
  UserX, UserCheck, Loader2, CalendarDays, ShieldCheck, Award,
} from 'lucide-react';
import {
  isWithinInductionWindow,
  resolveInductionTrainingRequired,
  formatDateOfJoiningInput,
  INDUCTION_WINDOW_MONTHS,
} from '@/lib/employeeInduction';
import { parseTrainerDepartments } from '@/lib/employeeTrainer';
import { bustEmployeeClientCaches } from '@/lib/employeeClientCache';

const DEPARTMENTS = ['QA', 'QC', 'Microbiology', 'Production', 'Store', 'Engineering', 'Personnel'] as const;
type Dept = (typeof DEPARTMENTS)[number];

interface Employee {
  _id: string;
  name: string;
  designation: string;
  /** Designation held before the most recent change, if there has been one. */
  previousDesignation?: string;
  /** ISO timestamp of the most recent designation change. */
  designationUpdatedAt?: string;
  department: string;
  employeeId?: string;
  dateOfJoining?: string;
  inductionTrainingRequired?: boolean;
  isTrainer?: boolean;
  trainerDepartments?: string[];
  isActive: boolean;
  lmsUsername?: string;
  hasLmsPassword?: boolean;
}

interface TrainingRecord {
  employeeId: string;
  employeeName: string;
  designation: string;
  department: string;
  isActive: boolean;
  totalSops: number;
  completedSops: number;
  notCompletedSops: number;
  overallPct: number;
  monthlyBreakdown: MonthBreakdown[];
  sops: SopBreakdown[];
}

const EMPTY_MONTHLY_BREAKDOWN: MonthBreakdown[] = Array.from({ length: 12 }, () => ({
  completed: 0,
  notCompleted: 0,
}));

// ─── Add / Edit modal ─────────────────────────────────────────────────────────

function EmployeeModal({
  initial,
  defaultDept,
  onClose,
  onSaved,
}: {
  initial?: Employee;
  defaultDept?: string;
  onClose: () => void;
  onSaved: (emp: Employee) => void;
}) {
  const [name,        setName]        = useState(initial?.name        || '');
  const [designation, setDesignation] = useState(initial?.designation || '');
  // Designation is picked from the Designation Master rather than typed, so
  // near-duplicate titles cannot fragment the matrix filters.
  const [masterDesignations, setMasterDesignations] = useState<string[]>([]);
  const [designationsLoaded, setDesignationsLoaded] = useState(false);
  const [department,  setDepartment]  = useState(initial?.department  || defaultDept || 'QA');
  const [employeeId,  setEmployeeId]  = useState(initial?.employeeId  || '');
  const [dateOfJoining, setDateOfJoining] = useState(formatDateOfJoiningInput(initial?.dateOfJoining));
  const [inductionTrainingRequired, setInductionTrainingRequired] = useState(
    initial?.inductionTrainingRequired ?? false,
  );
  const [isTrainer,   setIsTrainer]   = useState(initial?.isTrainer ?? false);
  const [trainerDepartments, setTrainerDepartments] = useState<string[]>(() => {
    if (initial?.isTrainer) {
      return parseTrainerDepartments(
        initial.trainerDepartments,
        initial.department || defaultDept || 'QA',
      );
    }
    return [initial?.department || defaultDept || 'QA'];
  });
  const [password,    setPassword]    = useState('');
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');

  const hasPassword = !!initial?.hasLmsPassword;
  const tenureRequiresInduction = isWithinInductionWindow(dateOfJoining || undefined);
  const effectiveInductionRequired = resolveInductionTrainingRequired(
    dateOfJoining || undefined,
    inductionTrainingRequired,
  );

  useEffect(() => {
    if (tenureRequiresInduction) setInductionTrainingRequired(true);
  }, [tenureRequiresInduction]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/designations');
        const json = await res.json();
        if (cancelled) return;
        if (res.ok && Array.isArray(json.designations)) {
          setMasterDesignations(
            json.designations
              .map((d: { name: string }) => String(d.name || '').trim())
              .filter(Boolean),
          );
        }
      } catch {
        /* fall back to the current value only */
      } finally {
        if (!cancelled) setDesignationsLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // A legacy title that predates the master must stay selectable, otherwise
  // opening the form would silently clear it.
  const designationOptions = useMemo(() => {
    const current = (initial?.designation || '').trim();
    const all = [...masterDesignations];
    if (current && !all.some((d) => d.toLowerCase() === current.toLowerCase())) {
      all.push(current);
    }
    return [...new Set(all)].sort((a, b) => a.localeCompare(b));
  }, [masterDesignations, initial?.designation]);

  const designationNotInMaster =
    designationsLoaded &&
    designation.trim() !== '' &&
    !masterDesignations.some((d) => d.toLowerCase() === designation.trim().toLowerCase());

  // Keep trainer multi-select in sync when home department changes while trainer is on.
  useEffect(() => {
    if (!isTrainer) return;
    setTrainerDepartments((prev) => {
      if (prev.includes(department)) return prev;
      return parseTrainerDepartments([...prev, department], department);
    });
  }, [department, isTrainer]);

  const toggleTrainerDept = (dept: string) => {
    setTrainerDepartments((prev) => {
      if (prev.includes(dept)) {
        // Don't allow clearing the last department.
        if (prev.length <= 1) return prev;
        return prev.filter((d) => d !== dept);
      }
      return parseTrainerDepartments([...prev, dept], department);
    });
  };

  const handleTrainerToggle = (checked: boolean) => {
    setIsTrainer(checked);
    if (checked) {
      setTrainerDepartments((prev) =>
        prev.length > 0 ? parseTrainerDepartments(prev, department) : [department],
      );
    }
  };

  const handleSave = async () => {
    if (!name.trim() || !designation.trim()) { setError('Name and designation are required.'); return; }
    if (password && password.length < 4) { setError('Password must be at least 4 characters.'); return; }
    if (isTrainer && trainerDepartments.length === 0) {
      setError('Select at least one department for a trainer.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const isEdit = !!initial?._id;
      const payload = {
        name,
        designation,
        department,
        employeeId,
        dateOfJoining: dateOfJoining || null,
        inductionTrainingRequired: effectiveInductionRequired,
        isTrainer,
        trainerDepartments: isTrainer ? trainerDepartments : [],
        ...(password ? { password } : {}),
      };
      const res = await fetch(isEdit ? `/api/employees/${initial._id}` : '/api/employees', {
        method:  isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || 'Save failed'); return; }
      onSaved(json.employee);
    } finally {
      setLoading(false);
    }
  };

  const inputCls = 'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-purple-400 focus:outline-none focus:ring-2 focus:ring-purple-100';
  const labelCls = 'mb-1 block text-xs font-medium text-gray-600';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
          <h2 className="text-base font-bold text-gray-900">{initial ? 'Edit Employee' : 'Add Employee'}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
            </div>
          )}

          <div>
            <label className={labelCls}>Full Name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rahul Sharma" className={inputCls} autoFocus />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className={labelCls}>Designation *</label>
              <select
                value={designation}
                onChange={(e) => setDesignation(e.target.value)}
                className={inputCls}
              >
                <option value="">
                  {designationsLoaded ? 'Select a designation…' : 'Loading designations…'}
                </option>
                {designationOptions.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              {designationNotInMaster && (
                <p className="mt-1 text-[11px] text-amber-700">
                  &ldquo;{designation}&rdquo; is not in the Designation Master.
                </p>
              )}
              {designationsLoaded && masterDesignations.length === 0 && (
                <p className="mt-1 text-[11px] text-amber-700">
                  The Designation Master is empty — a Super Admin or SOP Admin can populate it from
                  the Designation Master page.
                </p>
              )}
            </div>
            <div>
              <label className={labelCls}>Employee ID</label>
              <input value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} placeholder="Optional" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Department *</label>
              <select value={department} onChange={(e) => setDepartment(e.target.value)} className={inputCls}>
                {DEPARTMENTS.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Date of Joining</label>
              <div className="relative">
                <CalendarDays className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                <input
                  type="date"
                  value={dateOfJoining}
                  onChange={(e) => setDateOfJoining(e.target.value)}
                  className={`${inputCls} pl-9`}
                />
              </div>
            </div>
            <label
              className={`flex cursor-pointer items-center gap-3 self-end rounded-lg border px-3 py-2 transition ${
                tenureRequiresInduction
                  ? 'border-amber-200 bg-amber-50'
                  : effectiveInductionRequired
                    ? 'border-purple-200 bg-purple-50/60'
                    : 'border-gray-200 bg-gray-50/60 hover:border-gray-300'
              } ${tenureRequiresInduction ? 'cursor-default' : ''}`}
            >
              <input
                type="checkbox"
                checked={effectiveInductionRequired}
                disabled={tenureRequiresInduction}
                onChange={(e) => setInductionTrainingRequired(e.target.checked)}
                className="h-4 w-4 shrink-0 rounded border-gray-300 text-purple-600 focus:ring-purple-500 disabled:opacity-80"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                  <ShieldCheck className={`h-3.5 w-3.5 shrink-0 ${tenureRequiresInduction ? 'text-amber-600' : 'text-purple-600'}`} />
                  Induction training required
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-gray-500">
                  {tenureRequiresInduction
                    ? `Auto-required — joined within ${INDUCTION_WINDOW_MONTHS} months.`
                    : 'Assigns induction SOPs from the induction matrix.'}
                </span>
              </span>
            </label>
          </div>

          <label
            className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 transition ${
              isTrainer
                ? 'border-purple-200 bg-purple-50/60'
                : 'border-gray-200 bg-gray-50/60 hover:border-gray-300'
            }`}
          >
            <input
              type="checkbox"
              checked={isTrainer}
              onChange={(e) => handleTrainerToggle(e.target.checked)}
              className="h-4 w-4 shrink-0 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
            />
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                <Award className="h-3.5 w-3.5 shrink-0 text-purple-600" />
                Trainer
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-gray-500">
                Mark this employee as a trainer. Trainers can manage SOPs across selected departments.
              </span>
            </span>
          </label>

          {isTrainer && (
            <div className="rounded-lg border border-purple-200 bg-purple-50/40 p-3">
              <div className="mb-2 text-xs font-semibold text-gray-700">
                Trainer departments *
              </div>
              <p className="mb-2 text-[11px] leading-snug text-gray-500">
                Select every department this trainer is eligible to manage. Home department is listed above.
              </p>
              <div className="flex flex-wrap gap-2">
                {DEPARTMENTS.map((d) => {
                  const checked = trainerDepartments.includes(d);
                  return (
                    <label
                      key={d}
                      className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                        checked
                          ? 'border-purple-400 bg-purple-100 text-purple-800'
                          : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTrainerDept(d)}
                        className="h-3.5 w-3.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500"
                      />
                      {d}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <div className="rounded-lg border border-gray-200 bg-gray-50/50 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-gray-700">
              <GraduationCap className="h-3.5 w-3.5 text-purple-600" />
              Learning Module Login
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Username</label>
                <input
                  value={initial?.lmsUsername || ''}
                  readOnly
                  disabled
                  placeholder="Auto-generated on save"
                  className={`${inputCls} cursor-not-allowed bg-gray-100 font-mono text-xs text-gray-500`}
                />
              </div>
              <div>
                <label className={labelCls}>
                  Password {initial ? (hasPassword ? '(keep if blank)' : '(not set)') : '(optional)'}
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder={hasPassword ? 'New password to reset' : 'Min. 4 characters'}
                  className={inputCls}
                />
              </div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button onClick={onClose} className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-purple-700 disabled:opacity-50"
          >
            <Check className="h-4 w-4" /> {loading ? 'Saving…' : (initial ? 'Save Changes' : 'Add Employee')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete confirmation ───────────────────────────────────────────────────────

function DeleteConfirm({ employee, onClose, onDeleted }: { employee: Employee; onClose: () => void; onDeleted: () => void }) {
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const handleDelete = async () => {
    setLoading(true);
    const res  = await fetch(`/api/employees/${employee._id}`, { method: 'DELETE' });
    const json = await res.json();
    if (!res.ok) { setError(json.error || 'Delete failed'); setLoading(false); return; }
    bustEmployeeClientCaches();
    onDeleted();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="font-bold text-gray-800">Remove Employee</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-gray-100"><X className="h-4 w-4" /></button>
        </div>
        <div className="p-5">
          <div className="mb-4 rounded-xl bg-red-50 p-4 text-sm text-red-800">
            <p>Remove <strong>{employee.name}</strong> ({employee.designation}) from <strong>{employee.department}</strong>?</p>
            <p className="mt-1 text-xs text-red-600">They will no longer appear in the assign-SOP employee list.</p>
          </div>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50">Cancel</button>
          <button
            onClick={handleDelete}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> {loading ? 'Removing…' : 'Yes, Remove'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Generated-credentials modal ───────────────────────────────────────────────

interface GeneratedCredential {
  name: string;
  username: string;
  password: string;
}

function CredentialsModal({
  credentials,
  onClose,
}: {
  credentials: GeneratedCredential[];
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied((c) => (c === tag ? null : c)), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const copyAll = () => {
    const text = credentials
      .map((c) => `${c.name}\t${c.username}\t${c.password}`)
      .join('\n');
    copy(`Name\tUsername\tPassword\n${text}`, '__all__');
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-green-50 text-green-600">
              <KeyRound className="h-4.5 w-4.5" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-gray-800">Logins generated</h2>
              <p className="text-xs text-gray-400">
                {credentials.length} credential{credentials.length !== 1 ? 's' : ''} · copy now, passwords aren’t shown again
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between border-b border-amber-100 bg-amber-50 px-5 py-2.5 text-[11px] text-amber-700">
          <span className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Passwords are stored encrypted and can’t be retrieved later — share them now.
          </span>
          <button
            onClick={copyAll}
            className="flex items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-700 hover:bg-amber-100"
          >
            {copied === '__all__' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied === '__all__' ? 'Copied' : 'Copy all'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-gray-50 text-xs font-semibold uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-5 py-2.5">Name</th>
                <th className="px-3 py-2.5">Username</th>
                <th className="px-3 py-2.5">Password</th>
                <th className="px-3 py-2.5 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {credentials.map((c) => (
                <tr key={c.username} className="hover:bg-gray-50">
                  <td className="px-5 py-2.5 font-medium text-gray-800">{c.name}</td>
                  <td className="px-3 py-2.5 font-mono text-gray-700">{c.username}</td>
                  <td className="px-3 py-2.5 font-mono text-gray-700">{c.password}</td>
                  <td className="px-3 py-2.5">
                    <button
                      onClick={() => copy(`${c.username}\t${c.password}`, c.username)}
                      title="Copy username & password"
                      className="rounded p-1.5 text-gray-400 hover:bg-purple-50 hover:text-purple-600"
                    >
                      {copied === c.username ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-gray-100 px-5 py-3 text-right">
          <button onClick={onClose} className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function EmployeesPage() {
  useAuthGuard();
  const [employees,  setEmployees]  = useState<Employee[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [activeDept, setActiveDept] = useState<Dept | 'All'>('All');
  const [selectedDesignations, setSelectedDesignations] = useState<string[]>([]);
  const [search,     setSearch]     = useState('');
  const [showAdd,    setShowAdd]    = useState(false);
  const [editing,    setEditing]    = useState<Employee | null>(null);
  const [deleting,   setDeleting]   = useState<Employee | null>(null);
  const [togglingId,     setTogglingId]     = useState<string | null>(null);
  const [trainingMap,    setTrainingMap]    = useState<Map<string, TrainingRecord>>(new Map());
  const [trainingLoading, setTrainingLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [generatedCreds, setGeneratedCreds] = useState<GeneratedCredential[] | null>(null);

  const loadTraining = useCallback(async (department?: string) => {
    setTrainingLoading(true);
    try {
      const params = new URLSearchParams();
      if (department && department !== 'All') params.set('department', department);
      const res  = await fetch(`/api/lms/admin/employee-training?${params}`, { cache: 'no-store' });
      const json = await res.json();
      const map = new Map<string, TrainingRecord>();
      for (const r of (json.records ?? []) as TrainingRecord[]) {
        map.set(r.employeeId, r);
      }
      setTrainingMap(map);
    } finally {
      setTrainingLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch('/api/employees?includeInactive=1&skipSync=1');
      const json = await res.json();
      setEmployees(json.employees || []);
    } finally {
      setLoading(false);
    }
    void loadTraining(activeDept !== 'All' ? activeDept : undefined);
  }, [loadTraining, activeDept]);

  useEffect(() => { load(); }, [load]);

  const countsByDept = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of employees) {
      if (e.isActive) m[e.department] = (m[e.department] || 0) + 1;
    }
    return m;
  }, [employees]);

  const designations = useMemo(() => {
    const pool = activeDept === 'All'
      ? employees
      : employees.filter((e) => e.department === activeDept);
    return [...new Set(pool.map((e) => e.designation).filter(Boolean))].sort((a, b) =>
      a.localeCompare(b),
    );
  }, [employees, activeDept]);

  const countsByDesignation = useMemo(() => {
    const pool = activeDept === 'All'
      ? employees
      : employees.filter((e) => e.department === activeDept);
    const m: Record<string, number> = {};
    for (const e of pool) {
      if (e.designation) m[e.designation] = (m[e.designation] || 0) + 1;
    }
    return m;
  }, [employees, activeDept]);

  useEffect(() => {
    setSelectedDesignations((prev) => prev.filter((d) => designations.includes(d)));
  }, [activeDept, designations]);

  const hasActiveFilters =
    activeDept !== 'All' || selectedDesignations.length > 0 || search.trim() !== '';

  const clearFilters = () => {
    setActiveDept('All');
    setSelectedDesignations([]);
    setSearch('');
  };

  const toggleDesignation = (designation: string) => {
    setSelectedDesignations((prev) =>
      prev.includes(designation)
        ? prev.filter((d) => d !== designation)
        : [...prev, designation],
    );
  };

  const gridRows = useMemo((): EmployeeGridRow[] => {
    const term = search.trim().toLowerCase();
    return employees
      .filter((e) => {
        if (activeDept !== 'All' && e.department !== activeDept) return false;
        if (selectedDesignations.length > 0 && !selectedDesignations.includes(e.designation)) return false;
        if (term) {
          const inCore =
            e.name.toLowerCase().includes(term) ||
            e.designation.toLowerCase().includes(term) ||
            (e.employeeId || '').toLowerCase().includes(term);
          if (!inCore) return false;
        }
        return true;
      })
      .map((emp) => {
        const t = trainingMap.get(emp._id);
        if (t) {
          return {
            employeeId:       emp._id,
            employeeName:     emp.name,
            designation:      emp.designation,
            previousDesignation:  emp.previousDesignation,
            designationUpdatedAt: emp.designationUpdatedAt,
            department:       emp.department,
            isActive:         emp.isActive,
            totalSops:        t.totalSops,
            completedSops:    t.completedSops,
            notCompletedSops: t.notCompletedSops,
            overallPct:       t.overallPct,
            monthlyBreakdown: buildMonthlyBreakdown(t.sops),
            sops:             t.sops,
            trainingLoaded:   true,
          };
        }
        return {
          employeeId:       emp._id,
          employeeName:     emp.name,
          designation:      emp.designation,
          previousDesignation:  emp.previousDesignation,
          designationUpdatedAt: emp.designationUpdatedAt,
          department:       emp.department,
          isActive:         emp.isActive,
          totalSops:        0,
          completedSops:    0,
          notCompletedSops: 0,
          overallPct:       0,
          monthlyBreakdown: EMPTY_MONTHLY_BREAKDOWN,
          sops:             [],
          trainingLoaded:   false,
        };
      });
  }, [employees, activeDept, selectedDesignations, search, trainingMap]);

  const handleGenerateLogins = useCallback(async () => {
    setGenerating(true);
    setSyncResult(null);
    try {
      const res  = await fetch('/api/lms/admin/credentials/generate', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) { setSyncResult(`Error: ${json.error || 'Failed to generate logins'}`); return; }
      if (json.generated > 0) {
        setGeneratedCreds(json.credentials || []);
        setSyncResult(`Generated logins for ${json.generated} employee(s).`);
      } else {
        setSyncResult('All employees already have a login and password.');
      }
      await load();
    } finally {
      setGenerating(false);
    }
  }, [load]);

  const toggleActive = async (emp: Employee) => {
    setTogglingId(emp._id);
    try {
      const res  = await fetch(`/api/employees/${emp._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !emp.isActive }),
      });
      const json = await res.json();
      if (json.employee) {
        bustEmployeeClientCaches();
        setEmployees((prev) => prev.map((e) => e._id === emp._id ? { ...e, isActive: json.employee.isActive } : e));
      }
    } finally {
      setTogglingId(null);
    }
  };

  const handleSaved = (emp: Employee) => {
    // Name / designation / department are denormalised into the matrix and LMS
    // views the browser has cached; drop those so they re-fetch the new value.
    bustEmployeeClientCaches();
    setEmployees((prev) => {
      const normalized: Employee = {
        ...emp,
        trainerDepartments: Array.isArray(emp.trainerDepartments)
          ? emp.trainerDepartments
          : [],
      };
      const idx = prev.findIndex((e) => e._id === normalized._id);
      if (idx >= 0) return prev.map((e) => (e._id === normalized._id ? { ...e, ...normalized } : e));
      return [normalized, ...prev];
    });
    setShowAdd(false);
    setEditing(null);
    void loadTraining(activeDept !== 'All' ? activeDept : undefined);
  };

  const findEmployee = (id: string) => employees.find((e) => e._id === id);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-gray-50 text-gray-900">
      {/* Header */}
      <header className="shrink-0 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="flex items-center justify-between px-4 py-2.5 sm:px-5">
          <div className="flex items-center gap-3">
            <Link href="/training-matrix" className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800">
              <ArrowLeft className="h-3.5 w-3.5" /> Training Matrix
            </Link>
            <div className="h-4 w-px bg-gray-200" />
            <div className="flex items-center gap-2">
              <UserRound className="h-4 w-4 text-purple-600" />
              <h1 className="text-sm font-bold tracking-tight">Employee Master</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button suppressHydrationWarning onClick={load} disabled={loading} className="flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50">
              <RefreshCw className={`h-3.5 w-3.5 ${loading || trainingLoading ? 'animate-spin' : ''}`} />
            </button>
            <button
              suppressHydrationWarning
              onClick={handleGenerateLogins}
              disabled={generating}
              title="Create a First.Last username and an auto password for any employee that doesn't have a login yet"
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            >
              <KeyRound className={`h-3.5 w-3.5 ${generating ? 'animate-pulse' : ''}`} /> Generate Logins
            </button>
            <button
              suppressHydrationWarning
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-1.5 text-xs font-medium text-white shadow hover:bg-purple-700"
            >
              <Plus className="h-3.5 w-3.5" /> Add Employee
            </button>
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col px-4 py-3 sm:px-5">
        {syncResult && (
          <div className={`mb-3 flex shrink-0 items-center justify-between rounded-lg px-4 py-2 text-sm ${syncResult.startsWith('Error') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'}`}>
            <span>{syncResult}</span>
            <button suppressHydrationWarning onClick={() => setSyncResult(null)} className="ml-3 rounded p-0.5 hover:bg-black/10"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        {/* Department pills */}
        <div className="mb-2 flex shrink-0 flex-wrap gap-1.5">
          <button
            suppressHydrationWarning
            onClick={() => setActiveDept('All')}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${activeDept === 'All' ? 'bg-purple-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
          >
            All
            <span className="ml-1 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-bold text-purple-700">
              {employees.filter(e => e.isActive).length}
            </span>
          </button>
          {DEPARTMENTS.map((d) => (
            <button
              suppressHydrationWarning
              key={d}
              onClick={() => setActiveDept(d)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${activeDept === d ? 'bg-purple-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}
            >
              {d}
              {(countsByDept[d] || 0) > 0 && (
                <span className="ml-1 rounded-full bg-purple-100 px-1.5 py-0.5 text-[10px] font-bold text-purple-700">
                  {countsByDept[d]}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Search + clear */}
        <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2">
          <div className="relative min-w-52 flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              suppressHydrationWarning
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, designation, or ID…"
              className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-8 text-sm focus:border-purple-300 focus:outline-none"
            />
            {search && (
              <button
                suppressHydrationWarning
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {hasActiveFilters && (
            <button
              suppressHydrationWarning
              onClick={clearFilters}
              className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-500 transition hover:bg-gray-50 hover:text-gray-800"
            >
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
          )}

          <span className="ml-auto text-xs text-gray-400">
            {gridRows.length} employee{gridRows.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Designation pills — multi-select */}
        {designations.length > 0 && (
          <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5">
            <span className="mr-0.5 text-[11px] font-semibold uppercase tracking-wide text-gray-900">
              Designation
            </span>
            {designations.map((d) => {
              const selected = selectedDesignations.includes(d);
              return (
                <button
                  suppressHydrationWarning
                  key={d}
                  onClick={() => toggleDesignation(d)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                    selected
                      ? 'bg-sky-600 text-white shadow-sm'
                      : 'border border-gray-200 bg-white text-gray-900 hover:border-sky-200 hover:bg-sky-50'
                  }`}
                >
                  {d}
                  <span
                    className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                      selected ? 'bg-sky-500 text-white' : 'bg-sky-100 text-sky-700'
                    }`}
                  >
                    {countsByDesignation[d] || 0}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Training grid — fills remaining viewport */}
        {!loading && gridRows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-gray-200 bg-white py-16">
            <UserRound className="mb-3 h-10 w-10 text-gray-200" />
            <p className="text-sm font-medium text-gray-500">No employees found</p>
            {hasActiveFilters && (
              <p className="mt-1 text-xs text-gray-400">Try adjusting your filters or search.</p>
            )}
            {hasActiveFilters && (
              <button
                suppressHydrationWarning
                onClick={clearFilters}
                className="mt-3 flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
              >
                <X className="h-3.5 w-3.5" /> Clear filters
              </button>
            )}
            {!hasActiveFilters && (
              <button
                suppressHydrationWarning
                onClick={() => setShowAdd(true)}
                className="mt-4 flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700"
              >
                <Plus className="h-3.5 w-3.5" /> Add first employee
              </button>
            )}
          </div>
        ) : (
          <EmployeeTrainingGrid
            rows={gridRows}
            rosterLoading={loading}
            trainingLoading={trainingLoading}
            renderActions={(row) => {
              const emp = findEmployee(row.employeeId);
              if (!emp) return null;
              return (
                <>
                  <button
                    suppressHydrationWarning
                    onClick={() => setEditing(emp)}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-purple-50 hover:text-purple-600"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    suppressHydrationWarning
                    onClick={() => toggleActive(emp)}
                    disabled={togglingId === emp._id}
                    className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 ${emp.isActive ? 'hover:bg-red-50 hover:text-red-600' : 'hover:bg-green-50 hover:text-green-600'}`}
                    title={emp.isActive ? 'Mark as Left' : 'Reactivate'}
                  >
                    {togglingId === emp._id
                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      : emp.isActive ? <UserX className="h-3.5 w-3.5" /> : <UserCheck className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    suppressHydrationWarning
                    onClick={() => setDeleting(emp)}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-600"
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              );
            }}
          />
        )}
      </main>

      {showAdd && (
        <EmployeeModal
          defaultDept={activeDept !== 'All' ? activeDept : 'QA'}
          onClose={() => setShowAdd(false)}
          onSaved={handleSaved}
        />
      )}
      {editing && (
        <EmployeeModal
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
      {deleting && (
        <DeleteConfirm
          employee={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => { setEmployees((p) => p.filter((e) => e._id !== deleting._id)); setDeleting(null); }}
        />
      )}
      {generatedCreds && (
        <CredentialsModal
          credentials={generatedCreds}
          onClose={() => setGeneratedCreds(null)}
        />
      )}
    </div>
  );
}
