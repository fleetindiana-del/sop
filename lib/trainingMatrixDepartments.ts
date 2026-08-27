/** Canonical department labels used by Training Matrix / Manage SOP (historical). */
export const TRAINING_MATRIX_CORE_DEPARTMENTS = [
  "QA",
  "QC",
  "Microbiology",
  "Production",
  "Store",
  "Engineering",
  "Personnel",
] as const;

/** Junk buckets that must never appear as Training Matrix departments. */
const EXCLUDED = new Set(["other", "unknown", "general", "total", ""]);

export function isTrainingMatrixDepartmentName(name: string): boolean {
  const t = String(name || "").trim();
  if (!t) return false;
  return !EXCLUDED.has(t.toLowerCase());
}

/**
 * Map any stored department string onto the Training Matrix naming convention.
 * Core aliases collapse to the 7 historical names; custom depts keep their exact text.
 */
export function canonTrainingMatrixDepartment(raw: string | null | undefined): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  const t = trimmed.toLowerCase();
  if (/micro/.test(t)) return "Microbiology";
  if (/engineer|maint/.test(t)) return "Engineering";
  if (/person|\bhr\b/.test(t)) return "Personnel";
  if (/^\s*qa\b/.test(t) || /quality.?assur/.test(t)) return "QA";
  if (/^\s*qc\b/.test(t) || /quality.?cont/.test(t)) return "QC";
  if (/\bstore/.test(t) || t === "stor" || t === "bs") return "Store";
  if (/prod/.test(t)) return "Production";
  return trimmed;
}

/**
 * Resolve a raw department onto the live Training Matrix department list.
 * Returns null only for empty / junk buckets (General, Unknown, …).
 */
export function resolveTrainingMatrixDepartment(
  raw: string | null | undefined,
  knownDepartments: readonly string[],
): string | null {
  if (!raw?.trim()) return null;
  if (!isTrainingMatrixDepartmentName(raw)) return null;

  const canon = canonTrainingMatrixDepartment(raw);
  if (!canon || !isTrainingMatrixDepartmentName(canon)) return null;

  const hit = knownDepartments.find((d) => d.toLowerCase() === canon.toLowerCase());
  if (hit) return hit;

  // Custom department not yet in the list — keep exact casing from input/canon.
  return canon;
}

/** Common spellings that collapse to the same training-matrix department. */
const DEPARTMENT_ALIAS_SPELLINGS = [
  "QA",
  "Quality Assurance",
  "QC",
  "Quality Control",
  "Microbiology",
  "Micro",
  "Micro Biology",
  "Production",
  "Prod",
  "Manufacturing",
  "Store",
  "Stores",
  "Warehouse",
  "BS",
  "Engineering",
  "Engg",
  "Maintenance",
  "Personnel",
  "HR",
  "Human Resources",
];

/**
 * Every stored spelling that should match the given department filter.
 * QA is usually stored as "QA" everywhere; Production/Store/QC often are not.
 */
export function departmentAliasStrings(departments: string[]): string[] {
  const wanted = new Set<string>();
  const wantedCanons = new Set<string>();
  for (const raw of departments) {
    const trimmed = String(raw || "").trim();
    if (!trimmed) continue;
    wanted.add(trimmed);
    const canon = canonTrainingMatrixDepartment(trimmed);
    if (canon) {
      wanted.add(canon);
      wantedCanons.add(canon.toLowerCase());
    }
  }
  for (const spelling of DEPARTMENT_ALIAS_SPELLINGS) {
    const canon = canonTrainingMatrixDepartment(spelling);
    if (canon && wantedCanons.has(canon.toLowerCase())) wanted.add(spelling);
  }
  return [...wanted];
}

export function departmentsEquivalent(a: string, b: string): boolean {
  const ca = canonTrainingMatrixDepartment(a);
  const cb = canonTrainingMatrixDepartment(b);
  if (ca && cb) return ca.toLowerCase() === cb.toLowerCase();
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}
