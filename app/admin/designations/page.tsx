'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import { bustEmployeeClientCaches } from '@/lib/employeeClientCache';
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  History,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react';

interface Designation {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  employeeCount: number;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface DesignationEmployee {
  id: string;
  name: string;
  employeeCode: string;
  department: string;
  designation?: string;
  isActive: boolean;
  isTrainer: boolean;
  previousDesignation: string;
  designationUpdatedAt?: string;
}

interface AuditRow {
  id: string;
  timestamp: string;
  userName: string;
  userRole: string;
  action: string;
  entityType: string;
  entityLabel: string;
  fieldsChanged: string[];
  previousValues: Record<string, unknown>;
  updatedValues: Record<string, unknown>;
  summary: string;
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'Super Admin',
  sop_admin: 'SOP Admin',
  trainer: 'Trainer',
  viewer: 'Viewer',
  system: 'System',
};

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function DesignationMasterPage() {
  // Super Admin and SOP Admin only. The API enforces this independently.
  useAuthGuard({ allowedRoles: ['admin', 'sop_admin'] });

  const [designations, setDesignations] = useState<Designation[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Designation | null>(null);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [employeeCandidates, setEmployeeCandidates] = useState<DesignationEmployee[]>([]);
  const [employeeCandidatesLoading, setEmployeeCandidatesLoading] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState('');
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]);

  const [deleting, setDeleting] = useState<Designation | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Drill-down behind the headcount chip: who actually holds this designation.
  const [employeeListFor, setEmployeeListFor] = useState<Designation | null>(null);
  const [employeeList, setEmployeeList] = useState<DesignationEmployee[]>([]);
  const [employeeListLoading, setEmployeeListLoading] = useState(false);
  const [employeeListError, setEmployeeListError] = useState('');
  const [employeeListSearch, setEmployeeListSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/designations?withCounts=1&includeInactive=1');
      const json = await res.json();
      if (!res.ok) {
        setError(json.error || 'Failed to load designations');
        return;
      }
      setDesignations(json.designations || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load designations');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      // Both entity types matter: changes to the master itself, and changes to
      // an individual employee's designation.
      const [masterRes, employeeRes] = await Promise.all([
        fetch('/api/audit-logs?entityType=designation&limit=50'),
        fetch('/api/audit-logs?entityType=employee&limit=50'),
      ]);
      const [masterJson, employeeJson] = await Promise.all([
        masterRes.json().catch(() => ({})),
        employeeRes.json().catch(() => ({})),
      ]);
      const rows: AuditRow[] = [
        ...(masterRes.ok ? masterJson.items || [] : []),
        ...(employeeRes.ok ? employeeJson.items || [] : []),
      ]
        // Employee audit rows cover more than designation; keep only the ones
        // whose changed fields actually include it.
        .filter(
          (r: AuditRow) =>
            r.entityType === 'designation' || (r.fieldsChanged || []).includes('designation'),
        )
        .sort((a: AuditRow, b: AuditRow) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, 60);
      setAudit(rows);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadAudit();
  }, [load, loadAudit]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return designations;
    return designations.filter(
      (d) => d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q),
    );
  }, [designations, search]);

  const openEmployeeList = useCallback(async (d: Designation) => {
    if (d.employeeCount === 0) return;
    setEmployeeListFor(d);
    setEmployeeList([]);
    setEmployeeListSearch('');
    setEmployeeListError('');
    setEmployeeListLoading(true);
    try {
      const res = await fetch(
        `/api/designations/employees?name=${encodeURIComponent(d.name)}`,
      );
      const json = await res.json();
      if (!res.ok) {
        setEmployeeListError(json.error || 'Failed to load employees');
        return;
      }
      setEmployeeList(json.employees || []);
    } catch (err) {
      setEmployeeListError(err instanceof Error ? err.message : 'Failed to load employees');
    } finally {
      setEmployeeListLoading(false);
    }
  }, []);

  const visibleEmployeeList = useMemo(() => {
    const q = employeeListSearch.trim().toLowerCase();
    if (!q) return employeeList;
    return employeeList.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.department.toLowerCase().includes(q) ||
        e.employeeCode.toLowerCase().includes(q),
    );
  }, [employeeList, employeeListSearch]);

  const openCreate = () => {
    setEditing(null);
    setFormName('');
    setFormDescription('');
    setFormError('');
    setShowForm(true);
  };

  const openEdit = async (d: Designation) => {
    setEditing(d);
    setFormName(d.name);
    setFormDescription(d.description || '');
    setFormError('');
    setEmployeeSearch('');
    setSelectedEmployeeIds([]);
    setEmployeeCandidates([]);
    setShowForm(true);
    setEmployeeCandidatesLoading(true);
    try {
      const res = await fetch('/api/designations/employees?all=1');
      const json = await res.json();
      if (!res.ok) {
        setFormError(json.error || 'Failed to load employees');
        return;
      }
      const employees = (json.employees || []) as DesignationEmployee[];
      setEmployeeCandidates(employees);
      setSelectedEmployeeIds(
        employees
          .filter(
            (employee) =>
              (employee.designation || '').trim().toLowerCase() === d.name.trim().toLowerCase(),
          )
          .map((employee) => employee.id),
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to load employees');
    } finally {
      setEmployeeCandidatesLoading(false);
    }
  };

  const visibleEmployeeCandidates = useMemo(() => {
    const q = employeeSearch.trim().toLowerCase();
    if (!q) return employeeCandidates;
    return employeeCandidates.filter((employee) =>
      `${employee.name} ${employee.employeeCode} ${employee.department} ${employee.designation || ''}`
        .toLowerCase()
        .includes(q),
    );
  }, [employeeCandidates, employeeSearch]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const name = formName.trim();
    if (!name) {
      setFormError('Designation name is required.');
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      const res = await fetch('/api/designations', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          editing
            ? {
                id: editing.id,
                name,
                description: formDescription.trim(),
                selectedEmployeeIds,
              }
            : { name, description: formDescription.trim() },
        ),
      });
      const json = await res.json();
      if (!res.ok) {
        setFormError(json.error || 'Save failed');
        return;
      }
      setShowForm(false);
      if (json.employeesUpdated || json.employeesAssigned || json.employeesUnassigned) {
        bustEmployeeClientCaches();
      }
      setNotice(
        editing
          ? `Designation updated${
              json.employeesUpdated ? ` — ${json.employeesUpdated} employee record(s) re-pointed` : ''
            }${json.employeesAssigned ? ` — ${json.employeesAssigned} employee(s) added` : ''}${json.employeesUnassigned ? ` — ${json.employeesUnassigned} employee(s) removed` : ''}.`
          : `Designation "${name}" created.`,
      );
      await Promise.all([load(), loadAudit()]);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (d: Designation) => {
    setNotice('');
    const res = await fetch('/api/designations', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: d.id, isActive: !d.isActive }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || 'Failed to update designation');
      return;
    }
    setNotice(`"${d.name}" ${d.isActive ? 'deactivated' : 'reactivated'}.`);
    await Promise.all([load(), loadAudit()]);
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      const res = await fetch(`/api/designations?id=${encodeURIComponent(deleting.id)}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!res.ok) {
        setDeleteError(json.error || 'Delete failed');
        return;
      }
      setNotice(`Designation "${deleting.name}" deleted.`);
      setDeleting(null);
      await Promise.all([load(), loadAudit()]);
    } finally {
      setDeleteBusy(false);
    }
  };

  const inputCls =
    'w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-violet-400 focus:outline-none focus:ring-2 focus:ring-violet-100';

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-200 bg-white px-5 py-4">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="rounded-lg border border-gray-200 p-1.5 text-gray-600 transition hover:bg-gray-50"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div>
              <h1 className="flex items-center gap-2 text-lg font-bold text-gray-900">
                <BadgeCheck className="h-5 w-5 text-violet-600" />
                Designation Master
              </h1>
              <p className="mt-0.5 text-xs text-gray-600">
                The controlled list of job titles. Employee Master decides who holds which title;
                this decides which titles exist. Restricted to Super Admin and SOP Admin.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load()}
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-900 transition hover:bg-gray-50"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            <button
              onClick={openCreate}
              className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-violet-700"
            >
              <Plus className="h-3.5 w-3.5" /> New Designation
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-5">
        {error && (
          <div className="mb-3 flex items-center justify-between rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" /> {error}
            </span>
            <button onClick={() => setError('')} className="rounded p-0.5 hover:bg-black/10">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
        {notice && (
          <div className="mb-3 flex items-center justify-between rounded-lg bg-green-50 px-4 py-2 text-sm text-green-800">
            <span className="flex items-center gap-2">
              <BadgeCheck className="h-4 w-4" /> {notice}
            </span>
            <button onClick={() => setNotice('')} className="rounded p-0.5 hover:bg-black/10">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <div className="mb-3 flex items-center gap-3">
          <div className="relative min-w-52 max-w-sm flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search designations…"
              className="w-full rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-3 text-sm text-gray-900 focus:border-violet-300 focus:outline-none"
            />
          </div>
          <span className="ml-auto text-xs font-medium text-gray-900">
            {filtered.length} designation{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50">
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-gray-700">
                <th className="px-4 py-2.5">Designation</th>
                <th className="px-4 py-2.5">Description</th>
                <th className="px-4 py-2.5 text-center">Employees</th>
                <th className="px-4 py-2.5 text-center">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-gray-600">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </td>
                </tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center">
                    <p className="text-sm font-medium text-gray-900">No designations found</p>
                    <p className="mt-1 text-xs text-gray-600">
                      Run <code className="rounded bg-gray-100 px-1">npm run seed:designations</code>{' '}
                      to import the titles already used across the system.
                    </p>
                  </td>
                </tr>
              )}
              {!loading &&
                filtered.map((d) => (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2.5 font-semibold text-gray-900">{d.name}</td>
                    <td className="px-4 py-2.5 text-gray-900">{d.description || '—'}</td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={() => void openEmployeeList(d)}
                        disabled={d.employeeCount === 0}
                        title={
                          d.employeeCount === 0
                            ? `No employees currently hold "${d.name}"`
                            : `View the ${d.employeeCount} employee(s) holding "${d.name}"`
                        }
                        className="inline-flex items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold text-sky-800 transition hover:bg-sky-100 disabled:cursor-default disabled:bg-gray-50 disabled:text-gray-500 disabled:hover:bg-gray-50"
                      >
                        <Users className="h-3 w-3" /> {d.employeeCount}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={() => void toggleActive(d)}
                        className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold transition ${
                          d.isActive
                            ? 'border-green-200 bg-green-50 text-green-800 hover:bg-green-100'
                            : 'border-gray-200 bg-gray-50 text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        {d.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => void openEdit(d)}
                          title="Edit"
                          className="rounded-lg border border-gray-200 p-1.5 text-gray-700 transition hover:bg-gray-100"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => {
                            setDeleting(d);
                            setDeleteError('');
                          }}
                          title="Delete"
                          className="rounded-lg border border-red-200 p-1.5 text-red-600 transition hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>

        {/* Audit trail */}
        <section className="mt-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-gray-900">
            <History className="h-4 w-4 text-violet-600" />
            Designation Audit Trail
            <span className="font-normal text-gray-600">— who changed what, and when</span>
          </h2>
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-gray-700">
                  <th className="px-4 py-2.5">When</th>
                  <th className="px-4 py-2.5">Who</th>
                  <th className="px-4 py-2.5">Action</th>
                  <th className="px-4 py-2.5">What changed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {auditLoading && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-gray-600">
                      <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                    </td>
                  </tr>
                )}
                {!auditLoading && audit.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-sm text-gray-900">
                      No designation changes recorded yet.
                    </td>
                  </tr>
                )}
                {!auditLoading &&
                  audit.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-4 py-2.5 text-gray-900">
                        {formatWhen(row.timestamp)}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="font-medium text-gray-900">{row.userName}</span>
                        <span className="ml-1.5 rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-700">
                          {ROLE_LABEL[row.userRole] ?? row.userRole}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-semibold capitalize text-violet-800">
                          {row.entityType === 'employee' ? 'employee' : row.action}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-gray-900">
                        {row.summary}
                        {row.previousValues?.designation != null &&
                        row.updatedValues?.designation != null ? (
                          <span className="ml-1 text-xs text-gray-700">
                            ({String(row.previousValues.designation) || '(none)'} →{' '}
                            {String(row.updatedValues.designation) || '(none)'})
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {/* Create / edit modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            onSubmit={handleSubmit}
            className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3.5">
              <h2 className="text-base font-bold text-gray-900">
                {editing ? 'Edit Designation' : 'New Designation'}
              </h2>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 overflow-y-auto px-5 py-4">
              {formError && (
                <div className="flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> {formError}
                </div>
              )}
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-900">Name *</label>
                <input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Senior Officer"
                  className={inputCls}
                  autoFocus
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-900">Description</label>
                <input
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Optional"
                  className={inputCls}
                />
              </div>
              {editing && editing.employeeCount > 0 && formName.trim() !== editing.name && (
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Renaming updates the {editing.employeeCount} employee(s) who currently hold this
                  title. Past training, attendance, assessment and certificate records keep the
                  original designation.
                </p>
              )}
              {editing && (
                <div>
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <label className="block text-xs font-medium text-gray-900">
                      Employees assigned to this designation
                    </label>
                    {selectedEmployeeIds.length > 0 && (
                      <span className="text-xs font-semibold text-violet-700">
                        {selectedEmployeeIds.length} selected
                      </span>
                    )}
                  </div>
                  <input
                    value={employeeSearch}
                    onChange={(event) => setEmployeeSearch(event.target.value)}
                    placeholder="Search by name, ID, department or current designation…"
                    className={inputCls}
                  />
                  <div className="mt-2 max-h-52 overflow-y-auto rounded-lg border border-gray-200">
                    {employeeCandidatesLoading ? (
                      <div className="py-8 text-center text-gray-500">
                        <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                      </div>
                    ) : visibleEmployeeCandidates.length === 0 ? (
                      <p className="px-3 py-6 text-center text-xs text-gray-600">
                        No active employees found.
                      </p>
                    ) : (
                      visibleEmployeeCandidates.map((employee) => {
                        const checked = selectedEmployeeIds.includes(employee.id);
                        const alreadyAssigned =
                          (employee.designation || '').trim().toLowerCase() ===
                          editing.name.trim().toLowerCase();
                        return (
                          <label
                            key={employee.id}
                            className="flex cursor-pointer items-center gap-3 border-b border-gray-100 px-3 py-2 last:border-0 hover:bg-gray-50"
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setSelectedEmployeeIds((current) =>
                                  checked
                                    ? current.filter((id) => id !== employee.id)
                                    : [...current, employee.id],
                                )
                              }
                              className="h-4 w-4 rounded border-gray-300 text-violet-600"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-gray-900">
                                {employee.name}
                                {employee.employeeCode ? ` (${employee.employeeCode})` : ''}
                                {alreadyAssigned && checked && (
                                  <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700">
                                    Current
                                  </span>
                                )}
                                {alreadyAssigned && !checked && (
                                  <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold text-amber-800">
                                    Will be removed
                                  </span>
                                )}
                              </span>
                              <span className="block truncate text-xs text-gray-600">
                                {employee.designation || 'Unassigned'} · {employee.department || '—'}
                              </span>
                            </span>
                          </label>
                        );
                      })
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-gray-600">
                    Checked employees will hold this designation. Unchecked current employees become Unassigned in Employee Master and LMS. Historical training records remain unchanged.
                  </p>
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:opacity-60"
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editing ? 'Save changes' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Employees holding this designation */}
      {employeeListFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl">
            <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-100 px-5 py-3.5">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-base font-bold text-gray-900">
                  <Users className="h-4 w-4 text-sky-600" />
                  {employeeListFor.name}
                </h2>
                <p className="mt-0.5 text-xs text-gray-700">
                  {employeeListLoading
                    ? 'Loading employees…'
                    : `${employeeList.length} active employee${
                        employeeList.length === 1 ? '' : 's'
                      } currently hold this designation`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEmployeeListFor(null)}
                className="shrink-0 rounded-lg p-1.5 text-gray-500 transition hover:bg-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {employeeList.length > 8 && (
              <div className="shrink-0 border-b border-gray-100 px-5 py-2.5">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-500" />
                  <input
                    value={employeeListSearch}
                    onChange={(e) => setEmployeeListSearch(e.target.value)}
                    placeholder="Search name, department or ID…"
                    className="w-full rounded-lg border border-gray-200 bg-white py-1.5 pl-8 pr-3 text-sm text-gray-900 focus:border-sky-300 focus:outline-none"
                  />
                </div>
              </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto">
              {employeeListError && (
                <div className="m-4 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> {employeeListError}
                </div>
              )}
              {employeeListLoading && (
                <div className="py-10 text-center text-gray-600">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                </div>
              )}
              {!employeeListLoading && !employeeListError && visibleEmployeeList.length === 0 && (
                <p className="py-10 text-center text-sm text-gray-900">
                  {employeeList.length === 0
                    ? 'No active employees hold this designation.'
                    : 'No employees match that search.'}
                </p>
              )}
              {!employeeListLoading && visibleEmployeeList.length > 0 && (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 border-b border-gray-200 bg-gray-50">
                    <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-gray-700">
                      <th className="px-5 py-2">Employee</th>
                      <th className="px-4 py-2">ID</th>
                      <th className="px-4 py-2">Department</th>
                      <th className="px-4 py-2">Designation set</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visibleEmployeeList.map((e) => (
                      <tr key={e.id} className="hover:bg-gray-50">
                        <td className="px-5 py-2 font-medium text-gray-900">
                          {e.name}
                          {e.isTrainer && (
                            <span className="ml-1.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-800">
                              Trainer
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-gray-900">{e.employeeCode || '—'}</td>
                        <td className="px-4 py-2 text-gray-900">{e.department || '—'}</td>
                        <td className="px-4 py-2 text-gray-900">
                          {e.designationUpdatedAt ? (
                            <span title={
                              e.previousDesignation
                                ? `Changed from ${e.previousDesignation}`
                                : undefined
                            }>
                              {formatWhen(e.designationUpdatedAt)}
                              {e.previousDesignation && (
                                <span className="ml-1 text-xs text-gray-700">
                                  (was {e.previousDesignation})
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-gray-700">Unchanged</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex shrink-0 items-center justify-between gap-2 border-t border-gray-100 px-5 py-3">
              <p className="text-xs text-gray-700">
                Employee Master decides who holds this title. Past training records keep the
                designation captured at the time.
              </p>
              <button
                type="button"
                onClick={() => setEmployeeListFor(null)}
                className="shrink-0 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b px-5 py-4">
              <h2 className="font-bold text-gray-900">Delete Designation</h2>
              <button
                onClick={() => setDeleting(null)}
                className="rounded-lg p-1.5 hover:bg-gray-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-5">
              {deleteError && (
                <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
                  {deleteError}
                </div>
              )}
              <p className="text-sm text-gray-900">
                Delete <strong>{deleting.name}</strong> from the Designation Master?
              </p>
              <p className="mt-2 text-xs text-gray-700">
                Historical training, attendance, assessment and certificate records that reference
                this title are not affected.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 px-5 py-3">
              <button
                onClick={() => setDeleting(null)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-900 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDelete()}
                disabled={deleteBusy}
                className="flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-700 disabled:opacity-60"
              >
                {deleteBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
