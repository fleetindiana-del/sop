import bcrypt from "bcryptjs";
import { escapeRegex } from "@/lib/lms-credentials";
import { isSharedLmsLogin } from "@/lib/lmsSharedLogin";
import { findEmployeeForTrainerUser } from "@/lib/userTrainerSync";
import Employee, { type IEmployee } from "@/models/Employee";
import User, { type IUser } from "@/models/User";

function ci(value: string): RegExp {
  return new RegExp(`^${escapeRegex(value)}$`, "i");
}

async function userLinkedToEmployee(employeeId: unknown): Promise<IUser | null> {
  if (!employeeId) return null;
  return User.findOne({ lmsEmployeeId: employeeId });
}

/**
 * Dashboard login: the User.username first, then the LMS handle of a shared
 * employee (so `Sanjay.Chauhan` and `sanjay` both reach the same trainer).
 */
export async function findDashboardUserForLogin(rawUsername: string): Promise<IUser | null> {
  const handle = String(rawUsername || "").trim();
  if (!handle) return null;

  const byUsername = await User.findOne({ username: handle.toLowerCase() });
  if (byUsername) return byUsername;

  const employee = await Employee.findOne({
    lmsUsername: ci(handle),
    isActive: true,
  })
    .select("_id name")
    .lean<{ _id: unknown; name: string } | null>();
  if (!employee) return null;

  const linked = await userLinkedToEmployee(employee._id);
  if (linked && isSharedLmsLogin(linked)) return linked;

  const named = await User.find({
    name: ci(employee.name),
    $or: [{ isTrainer: true }, { role: "trainer" }, { sharedLmsLogin: { $ne: false } }],
  });
  const shared = named.filter((u) => isSharedLmsLogin(u));
  return shared.length === 1 ? shared[0] : null;
}

export async function passwordMatchesDashboardUser(
  user: IUser,
  password: string,
): Promise<boolean> {
  if (user.passwordHash && (await bcrypt.compare(password, user.passwordHash))) {
    return true;
  }
  if (!isSharedLmsLogin(user)) return false;

  const match = await findEmployeeForTrainerUser(user);
  if (!match) return false;
  const employee = await Employee.findById(match._id).select("+lmsPasswordHash");
  if (!employee?.lmsPasswordHash) return false;
  return bcrypt.compare(password, employee.lmsPasswordHash);
}

export type LmsLoginIdentity = {
  employee: IEmployee;
  user: IUser | null;
};

/**
 * LMS login: the employee handle first, then a shared dashboard username.
 */
export async function findEmployeeForLmsLogin(
  rawUsername: string,
): Promise<LmsLoginIdentity | null> {
  const handle = String(rawUsername || "").trim();
  if (!handle) return null;

  const byHandle = await Employee.findOne({ lmsUsername: ci(handle) }).select(
    "+lmsPasswordHash",
  );
  if (byHandle) {
    const user = await userLinkedToEmployee(byHandle._id);
    return { employee: byHandle, user };
  }

  const user = await User.findOne({ username: handle.toLowerCase() });
  if (!user || !isSharedLmsLogin(user)) return null;

  const match = await findEmployeeForTrainerUser(user);
  if (!match) return null;
  const employee = await Employee.findById(match._id).select("+lmsPasswordHash");
  if (!employee) return null;
  return { employee, user };
}

export async function passwordMatchesLmsLogin(
  identity: LmsLoginIdentity,
  password: string,
): Promise<boolean> {
  const { employee, user } = identity;
  if (employee.lmsPasswordHash && (await bcrypt.compare(password, employee.lmsPasswordHash))) {
    return true;
  }
  if (user && isSharedLmsLogin(user) && user.passwordHash) {
    return bcrypt.compare(password, user.passwordHash);
  }
  return false;
}
