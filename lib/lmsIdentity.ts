import { cookies } from 'next/headers';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import { verifyLmsToken, LMS_COOKIE } from '@/lib/lms-session';
import { escapeRegex } from '@/lib/lms-credentials';
import { isSharedLmsLogin } from '@/lib/lmsSharedLogin';
import { departmentsMatch, parseAssignedDepartments } from '@/lib/access-control';
import Employee from '@/models/Employee';
import User from '@/models/User';

/**
 * Who the LMS is acting as for this request.
 *
 * The LMS accepts two logins:
 *  - the employee learning-module login (`lms_session` cookie), and
 *  - the main application login (NextAuth) — a user already signed in to the
 *    dashboard reaches the LMS with the same password, no second sign-in.
 *
 * `sub` keeps the LMS token field name so route handlers read the same shape
 * either way.
 */
export interface LmsIdentity {
  /** Employee `_id`. */
  sub: string;
  name: string;
  /** Which login produced this identity. */
  source: 'lms' | 'app';
}

/** Why a signed-in app user could not be resolved to a learner. */
export type LmsIdentityProblem =
  | 'no-session'
  | 'no-employee-record'
  | 'ambiguous-employee-record'
  /** The login keeps a separate LMS password, so the bridge is switched off. */
  | 'lms-login-required';

export type LmsIdentityResult =
  | { ok: true; identity: LmsIdentity }
  | { ok: false; problem: LmsIdentityProblem };

type EmployeeLean = {
  _id: unknown;
  name: string;
  department?: string;
};

const LEAN_FIELDS = 'name department';

function ci(value: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}$`, 'i');
}

/**
 * "jane.doe" / "jane_doe" / "jane-doe" all describe the employee "Jane Doe".
 * Usernames are generated from names, so this recovers the link for logins
 * created before an LMS handle was ever assigned.
 */
function usernameAsName(username: string): string {
  return username.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Narrow same-name employees by the department on the login. A trainer or
 * viewer may carry several assigned departments, so any of them counts.
 */
function preferByDepartment(rows: EmployeeLean[], userDepartment: string): EmployeeLean[] {
  if (rows.length < 2) return rows;
  const assigned = parseAssignedDepartments(userDepartment);
  if (!assigned.length) return rows;
  const scoped = rows.filter((row) =>
    assigned.some((d) => departmentsMatch(d, row.department || '')),
  );
  return scoped.length ? scoped : rows;
}

/**
 * The Employee explicitly linked to this login on the User record. This is the
 * mapping an administrator sets in Login & Passwords, so it wins over every
 * heuristic below — including for a Super Admin or SOP Admin, whose display
 * name rarely matches an employee at all.
 */
async function linkedEmployee(userId: string): Promise<EmployeeLean | null> {
  if (!userId) return null;
  const user = await User.findById(userId).select('lmsEmployeeId').lean<{
    lmsEmployeeId?: unknown;
  } | null>();
  if (!user?.lmsEmployeeId) return null;
  return Employee.findOne({ _id: user.lmsEmployeeId, isActive: true })
    .select(LEAN_FIELDS)
    .lean<EmployeeLean | null>();
}

/**
 * Whether this login shares one password across both modules.
 *
 * Unticking "Same password for Dashboard and LMS" marks the person as
 * LMS-only: they hold their own learning-module password, so a dashboard
 * session must not open their training record on its own.
 */
async function sharesLmsLogin(userId: string): Promise<boolean> {
  if (!userId) return true;
  const user = await User.findById(userId).select('sharedLmsLogin').lean<{
    sharedLmsLogin?: boolean;
  } | null>();
  return isSharedLmsLogin(user || {});
}

/**
 * Map a main-app (NextAuth) user onto their Employee record, most explicit
 * link first:
 *   0. the administrator-set link      (User.lmsEmployeeId)
 *   1. the generated LMS handle        (Employee.lmsUsername === username)
 *   2. the employee code               (Employee.employeeId  === username)
 *   3. the display name                (Employee.name        === name)
 *   4. the username read as a name     (Employee.name        === "jane doe")
 *
 * Only active employees are considered. A name that still matches more than one
 * active employee after the department tie-break is reported as ambiguous
 * rather than guessed at — showing one person another person's training record
 * is worse than asking an admin to set the LMS username.
 */
async function employeeForAppUser(
  userId: string,
  username: string,
  name: string,
  department: string,
): Promise<{ employee: EmployeeLean } | { problem: LmsIdentityProblem }> {
  await connectDB();

  if (!(await sharesLmsLogin(userId))) return { problem: 'lms-login-required' };

  const linked = await linkedEmployee(userId);
  if (linked) return { employee: linked };

  if (username) {
    const byHandle = await Employee.findOne({ lmsUsername: ci(username), isActive: true })
      .select(LEAN_FIELDS)
      .lean<EmployeeLean | null>();
    if (byHandle) return { employee: byHandle };

    const byCode = await Employee.findOne({ employeeId: ci(username), isActive: true })
      .select(LEAN_FIELDS)
      .lean<EmployeeLean | null>();
    if (byCode) return { employee: byCode };
  }

  const nameCandidates = [name, usernameAsName(username)].filter(Boolean);
  for (const candidate of nameCandidates) {
    const rows = await Employee.find({ name: ci(candidate), isActive: true })
      .select(LEAN_FIELDS)
      .lean<EmployeeLean[]>();
    if (rows.length === 0) continue;
    const narrowed = preferByDepartment(rows, department);
    if (narrowed.length === 1) return { employee: narrowed[0] };
    return { problem: 'ambiguous-employee-record' };
  }

  return { problem: 'no-employee-record' };
}

/**
 * Resolve the current LMS learner, reporting why when it fails. Use this where
 * the caller shows the reason to a person; everywhere else use
 * {@link resolveLmsIdentity}.
 */
export async function resolveLmsIdentityDetailed(): Promise<LmsIdentityResult> {
  const jar = await cookies();
  const payload = verifyLmsToken(jar.get(LMS_COOKIE)?.value);
  const session = await getServerSession(authOptions);
  const userId = String(session?.user?.id || '').trim();

  // The learner cookie lives 12h and survives an application sign-out, so it is
  // honoured only for the login it was issued under. Without this check the
  // previous person's cookie outranks whoever signs in next on the same
  // browser, and the LMS opens their training record instead.
  //
  // A token minted before this field existed has `uid === undefined`, which
  // matches only when nobody is signed in to the application — so a stale one
  // is discarded rather than trusted.
  if (payload && (payload.uid ?? null) === (userId || null)) {
    return { ok: true, identity: { sub: payload.sub, name: payload.name, source: 'lms' } };
  }

  const username = String(session?.user?.username || '').trim();
  const name = String(session?.user?.name || '').trim();
  const department = String(session?.user?.department || '').trim();
  if (!username && !name) return { ok: false, problem: 'no-session' };

  const found = await employeeForAppUser(userId, username, name, department);
  if ('problem' in found) return { ok: false, problem: found.problem };

  return {
    ok: true,
    identity: { sub: String(found.employee._id), name: found.employee.name, source: 'app' },
  };
}

/** Resolve the current LMS learner from either login, or null when neither applies. */
export async function resolveLmsIdentity(): Promise<LmsIdentity | null> {
  const result = await resolveLmsIdentityDetailed();
  return result.ok ? result.identity : null;
}

/** Message for a person whose main login could not be linked to a learner. */
export function lmsIdentityProblemMessage(problem: LmsIdentityProblem): string {
  if (problem === 'lms-login-required') {
    return 'Your login uses a separate learning-module password. Sign in below with your LMS username and password.';
  }
  if (problem === 'ambiguous-employee-record') {
    return 'Your login matches more than one employee record. Ask a Super Admin to link your login to the correct employee in Login & Passwords.';
  }
  if (problem === 'no-employee-record') {
    return 'No active employee record is linked to your login. Ask a Super Admin to link your login to an employee in Login & Passwords, or to add you to the Employee Master.';
  }
  return 'Not authenticated';
}
