import mongoose from "mongoose";
import Employee from "@/models/Employee";
import User from "@/models/User";

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
