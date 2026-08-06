/** Canonical training-matrix department names used across the app. */
export const EMPLOYEE_DEPARTMENTS = [
  'QA',
  'QC',
  'Microbiology',
  'Production',
  'Store',
  'Engineering',
  'Personnel',
] as const;

export type EmployeeDepartment = (typeof EMPLOYEE_DEPARTMENTS)[number];

const DEPT_SET = new Set<string>(EMPLOYEE_DEPARTMENTS);

/** Normalize a free-form department string to a known name when possible. */
export function normalizeEmployeeDepartment(raw: unknown): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  for (const d of EMPLOYEE_DEPARTMENTS) {
    if (d.toLowerCase() === value.toLowerCase()) return d;
  }
  return value;
}

/**
 * Parse trainer department selections from API/UI payloads.
 * Returns unique, trimmed, known-order departments (unknown names kept, appended).
 */
export function parseTrainerDepartments(
  raw: unknown,
  homeDepartment?: string,
): string[] {
  const list: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) list.push(normalizeEmployeeDepartment(item));
  } else if (typeof raw === 'string' && raw.trim()) {
    for (const part of raw.split(',')) list.push(normalizeEmployeeDepartment(part));
  }

  const home = normalizeEmployeeDepartment(homeDepartment);
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (d: string) => {
    if (!d || seen.has(d.toLowerCase())) return;
    seen.add(d.toLowerCase());
    out.push(d);
  };

  // Prefer canonical order for known departments, then any extras.
  for (const d of EMPLOYEE_DEPARTMENTS) {
    if (list.some((x) => x.toLowerCase() === d.toLowerCase())) push(d);
  }
  for (const d of list) {
    if (!DEPT_SET.has(d)) push(d);
  }

  // Always keep home department when provided and list ended up empty.
  if (out.length === 0 && home) push(home);
  return out;
}

/**
 * Departments a trainer is eligible to manage.
 * Non-trainers → [home department] only.
 * Trainers → trainerDepartments when set, otherwise [home].
 */
export function resolveTrainerDepartments(emp: {
  department?: string;
  trainerDepartments?: string[] | null;
  isTrainer?: boolean;
}): string[] {
  const home = normalizeEmployeeDepartment(emp.department);
  if (!emp.isTrainer) return home ? [home] : [];
  const selected = parseTrainerDepartments(emp.trainerDepartments, home);
  return selected.length > 0 ? selected : home ? [home] : [];
}
