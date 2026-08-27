import mongoose from "mongoose";
import { isSharedLmsLogin } from "@/lib/lmsSharedLogin";
import { findEmployeeForTrainerUser } from "@/lib/userTrainerSync";
import Employee from "@/models/Employee";
import User, { type IUser } from "@/models/User";

/**
 * The administrator-set link between an application login (`User`) and the
 * learner it *is* in the LMS (`Employee`). Read by `lib/lmsIdentity.ts`.
 *
 * The link is one-to-one on purpose: two logins pointing at the same employee
 * would let both write to one training record, and the second person's progress
 * would silently overwrite the first's.
 */
export type LmsEmployeeLinkResult =
  | { ok: true; employeeId: mongoose.Types.ObjectId | undefined }
  | { ok: false; error: string };

/**
 * Validate a submitted `lmsEmployeeId`.
 *
 * Empty string / null clears the link, so the identity resolver falls back to
 * matching on username and display name.
 *
 * `currentUserId` is the login being edited — excluded from the uniqueness
 * check so re-saving a user without changing the link does not report a clash
 * with itself.
 */
export async function resolveLmsEmployeeLink(
  raw: unknown,
  currentUserId?: string,
): Promise<LmsEmployeeLinkResult> {
  const value = String(raw ?? "").trim();
  if (!value) return { ok: true, employeeId: undefined };

  if (!mongoose.Types.ObjectId.isValid(value)) {
    return { ok: false, error: "Invalid employee selected" };
  }

  const employee = await Employee.findById(value)
    .select("name isActive")
    .lean<{ name: string; isActive: boolean } | null>();
  if (!employee) {
    return { ok: false, error: "Selected employee no longer exists" };
  }
  if (!employee.isActive) {
    return { ok: false, error: `${employee.name} is not an active employee` };
  }

  const clash = await User.findOne({
    lmsEmployeeId: value,
    ...(currentUserId ? { _id: { $ne: currentUserId } } : {}),
  })
    .select("username")
    .lean<{ username: string } | null>();
  if (clash) {
    return {
      ok: false,
      error: `${employee.name} is already linked to the login "${clash.username}"`,
    };
  }

  return { ok: true, employeeId: new mongoose.Types.ObjectId(value) };
}

/**
 * When Login & Passwords did not pick an employee, recover the unique active
 * match (same rules as the LMS identity bridge) and store it. Historical LMS
 * rows stay on that Employee `_id`; this only points the dashboard login at it.
 */
export async function autoLinkSharedUserToEmployee(
  user: IUser,
): Promise<{ linked: boolean; employeeName?: string }> {
  if (user.lmsEmployeeId) {
    const existing = await Employee.findOne({
      _id: user.lmsEmployeeId,
      isActive: true,
    })
      .select("name")
      .lean<{ name: string } | null>();
    if (existing) return { linked: false, employeeName: existing.name };
  }

  if (!isSharedLmsLogin(user)) return { linked: false };

  const employee = await findEmployeeForTrainerUser(user);
  if (!employee) return { linked: false };

  const employeeId = new mongoose.Types.ObjectId(String(employee._id));
  const clash = await User.findOne({
    lmsEmployeeId: employeeId,
    _id: { $ne: user._id },
  })
    .select("username")
    .lean<{ username: string } | null>();
  if (clash) return { linked: false };

  user.lmsEmployeeId = employeeId;
  return { linked: true, employeeName: employee.name };
}
