/**
 * Canonical registry of user-facing pages used by Access Management.
 *
 * `key` is what gets stored on the user record (`User.pageAccess`).
 * `prefix` is matched against the request path by `lib/page-access.ts`
 * (exact match or `${prefix}/...`).
 *
 * Order matters: `matchPage` picks the longest matching prefix, so nested
 * pages (e.g. `/lms/admin`) win over their parent (`/lms`).
 */

export interface AppPage {
  key: string;
  label: string;
  prefix: string;
  group: string;
  description: string;
  /** Super Admin + SOP Admin only — cannot be granted to trainer/viewer. */
  adminOnly?: boolean;
  /**
   * The `admin` role alone — SOP Admin cannot reach it, however its allowlist
   * is configured. No page carries this today.
   */
  superAdminOnly?: boolean;
  /**
   * Cannot be revoked from a role that reaches it at all.
   *
   * Only user administration carries this. An admin allowlist that dropped
   * Access Management would leave nobody able to restore anyone's access
   * without a direct database edit, so those two pages stay granted however
   * the allowlist is saved.
   */
  neverRestricted?: boolean;
  /** Everyone signed in gets this page; it cannot be revoked. */
  alwaysAllowed?: boolean;
  /**
   * Denied to trainer/viewer until explicitly granted. Mirrors the pre-Access-
   * Management middleware allowlist so existing users keep the same access.
   */
  restrictedByDefault?: boolean;
}

export const APP_PAGES: AppPage[] = [
  {
    key: "dashboard",
    label: "Dashboard",
    prefix: "/dashboard",
    group: "Core",
    description: "SOP registry, search and document viewer",
    alwaysAllowed: true,
  },
  {
    key: "mcq-bank",
    label: "MCQ Bank",
    prefix: "/mcq-bank",
    group: "Training",
    description: "Generated question banks per SOP",
  },
  {
    key: "lms-admin",
    label: "LMS Admin",
    prefix: "/lms/admin",
    group: "Training",
    description: "Employee training administration",
  },
  {
    key: "lms-trainer-overview",
    label: "Trainer Overview",
    prefix: "/lms/admin/trainer-overview",
    group: "Training",
    description: "Admin hierarchy of trainers, departments, employees and exam completion",
    adminOnly: true,
  },
  {
    key: "training-matrix",
    label: "Training Matrix",
    prefix: "/training-matrix",
    group: "Training",
    description: "Role-wise SOP training matrix",
  },
  {
    key: "induction-training-matrix",
    label: "Induction Matrix",
    prefix: "/induction-training-matrix",
    group: "Training",
    description: "Induction training matrix and SOP assignment",
    restrictedByDefault: true,
  },
  {
    key: "employees",
    label: "Employees",
    prefix: "/employees",
    group: "People",
    description: "Employee master data",
    restrictedByDefault: true,
  },
  {
    key: "compliance-request",
    label: "Request Compliance Run",
    prefix: "/compliance/request",
    group: "Compliance",
    description: "Request a compliance check and view run status",
    alwaysAllowed: true,
  },
  {
    key: "nutra-label",
    label: "Nutra Label Compliance",
    prefix: "/compliance/label",
    group: "Compliance",
    description: "Public FSSAI nutraceutical label checker (no login)",
    alwaysAllowed: true,
  },
  {
    key: "compliance",
    label: "Compliance",
    prefix: "/compliance",
    group: "Compliance",
    description: "Guideline gap analysis and findings",
    restrictedByDefault: true,
  },
  {
    key: "sop-compliance-sync",
    label: "Compliance Sync",
    prefix: "/sop-compliance-sync",
    group: "Compliance",
    description: "Upload and sync regulatory guidelines",
    restrictedByDefault: true,
  },
  {
    key: "sop-scheduler",
    label: "SOP Scheduler",
    prefix: "/sop-scheduler",
    group: "Compliance",
    description: "SOP review / revision scheduling",
    restrictedByDefault: true,
  },
  {
    key: "training-content",
    label: "Training Content",
    prefix: "/training-content",
    group: "Training",
    description: "Training material library",
    restrictedByDefault: true,
  },
  {
    key: "bunny-files",
    label: "Bunny Files",
    prefix: "/bunny-files",
    group: "Administration",
    description: "CDN storage browser",
    adminOnly: true,
  },
  {
    key: "admin-users",
    label: "Login & Passwords",
    prefix: "/admin/users",
    group: "Administration",
    description: "Create logins and reset passwords",
    adminOnly: true,
    neverRestricted: true,
  },
  {
    key: "admin-access",
    label: "Access Management",
    prefix: "/admin/access",
    group: "Administration",
    description: "Page and department permissions",
    adminOnly: true,
    neverRestricted: true,
  },
  {
    key: "admin-designations",
    label: "Designation Master",
    prefix: "/admin/designations",
    group: "Administration",
    description: "Manage the designation list used across employees and training",
    adminOnly: true,
  },
];

/** Page keys that trainer/viewer roles may be granted. */
export const GRANTABLE_PAGES = APP_PAGES.filter((p) => !p.adminOnly && !p.alwaysAllowed);

/** Keys always available to any signed-in user. */
export const ALWAYS_ALLOWED_KEYS = APP_PAGES.filter((p) => p.alwaysAllowed).map((p) => p.key);

const PAGES_BY_KEY = new Map(APP_PAGES.map((p) => [p.key, p]));

/** Longest-prefix first so `/lms/admin` beats `/lms`. */
const PAGES_BY_SPECIFICITY = [...APP_PAGES].sort((a, b) => b.prefix.length - a.prefix.length);

export function getPage(key: string): AppPage | undefined {
  return PAGES_BY_KEY.get(key);
}

/** The registry entry governing a request path, or undefined if unmanaged. */
export function matchPage(pathname: string): AppPage | undefined {
  return PAGES_BY_SPECIFICITY.find(
    (page) => pathname === page.prefix || pathname.startsWith(`${page.prefix}/`),
  );
}

export function isValidPageKey(key: string): boolean {
  return PAGES_BY_KEY.has(key);
}

/** Drop unknown keys, always-allowed keys and (for non-admins) admin-only keys. */
export function sanitizePageAccess(keys: unknown, role: string): string[] {
  if (!Array.isArray(keys)) return [];
  const seen = new Set<string>();
  for (const raw of keys) {
    const key = String(raw || "").trim();
    const page = PAGES_BY_KEY.get(key);
    if (!page || page.alwaysAllowed) continue;
    if (page.superAdminOnly && role !== "admin") continue;
    if (page.adminOnly && role !== "admin" && role !== "sop_admin") continue;
    seen.add(key);
  }
  return [...seen];
}
