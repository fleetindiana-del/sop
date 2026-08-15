import mongoose from "mongoose";
import User from "@/models/User";
import Notification from "@/models/Notification";
import ComplianceRunRequest, {
  type IComplianceRunRequest,
  type ComplianceRunRequestStatus,
} from "@/models/ComplianceRunRequest";
import { isComplianceOperator } from "@/lib/page-access";
import { sopIdentifierMatchFilter } from "@/lib/sopIdentifierNormalize";

export type ComplianceRunRequestDto = {
  id: string;
  sopId: string;
  sopIdentifier: string;
  sopName: string;
  department: string;
  requesterId: string;
  requesterName: string;
  requesterUsername: string;
  status: ComplianceRunRequestStatus;
  note: string;
  reportId: string | null;
  resultSummary: {
    overallScore: number;
    complianceStatus: string;
    analyzedAt?: string;
    compliantCount: number;
    partialCount: number;
    nonCompliantCount: number;
  } | null;
  notifiedCount: number;
  completedAt: string | null;
  completedByName: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CompactFinding = {
  clauseNumber: string;
  clauseTitle: string;
  complianceLevel: string;
  issueSeverity?: string;
  mismatchExplanation?: string;
  suggestedAction?: string;
};

function oid(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return String(value);
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function toRequestDto(
  doc: IComplianceRunRequest | Record<string, unknown>,
): ComplianceRunRequestDto {
  const row = doc as Record<string, unknown>;
  const summary = row.resultSummary as
    | {
        overallScore?: number;
        complianceStatus?: string;
        analyzedAt?: Date;
        compliantCount?: number;
        partialCount?: number;
        nonCompliantCount?: number;
      }
    | undefined;
  const notified = Array.isArray(row.notifiedUserIds) ? row.notifiedUserIds : [];
  return {
    id: oid(row._id ?? row.id),
    sopId: oid(row.sopId),
    sopIdentifier: String(row.sopIdentifier ?? ""),
    sopName: String(row.sopName ?? ""),
    department: String(row.department ?? ""),
    requesterId: oid(row.requesterId),
    requesterName: String(row.requesterName ?? ""),
    requesterUsername: String(row.requesterUsername ?? ""),
    status: (row.status as ComplianceRunRequestStatus) || "pending",
    note: String(row.note ?? ""),
    reportId: row.reportId ? oid(row.reportId) : null,
    resultSummary: summary
      ? {
          overallScore: Number(summary.overallScore ?? 0),
          complianceStatus: String(summary.complianceStatus ?? ""),
          analyzedAt: iso(summary.analyzedAt) ?? undefined,
          compliantCount: Number(summary.compliantCount ?? 0),
          partialCount: Number(summary.partialCount ?? 0),
          nonCompliantCount: Number(summary.nonCompliantCount ?? 0),
        }
      : null,
    notifiedCount: notified.length,
    completedAt: iso(row.completedAt),
    completedByName: row.completedByName ? String(row.completedByName) : null,
    cancelledAt: iso(row.cancelledAt),
    createdAt: iso(row.createdAt) ?? new Date().toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date().toISOString(),
  };
}

export async function findComplianceOperators(excludeUserId?: string) {
  const users = await User.find({})
    .select("_id name username role pageAccess")
    .lean();
  return users.filter((u) => {
    if (excludeUserId && String(u._id) === excludeUserId) return false;
    return isComplianceOperator(u.role, u.pageAccess);
  });
}

export async function notifyUsers(
  userIds: mongoose.Types.ObjectId[],
  payload: {
    type: "compliance_run_requested" | "compliance_run_completed";
    title: string;
    body: string;
    href: string;
    requestId: mongoose.Types.ObjectId;
    sopIdentifier: string;
    department: string;
  },
) {
  if (!userIds.length) return;
  await Notification.insertMany(
    userIds.map((userId) => ({
      userId,
      type: payload.type,
      title: payload.title,
      body: payload.body,
      href: payload.href,
      read: false,
      requestId: payload.requestId,
      sopIdentifier: payload.sopIdentifier,
      department: payload.department,
    })),
  );
}

const OPEN_STATUSES: ComplianceRunRequestStatus[] = ["pending", "in_progress"];

function openRequestFilter(
  sopId: mongoose.Types.ObjectId,
  sopIdentifier: string,
) {
  const idFilter = sopIdentifierMatchFilter(sopIdentifier, "sopIdentifier");
  const identifierClauses = Array.isArray((idFilter as { $or?: unknown[] }).$or)
    ? ((idFilter as { $or: Record<string, unknown>[] }).$or)
    : [idFilter];
  return {
    status: { $in: OPEN_STATUSES },
    $or: [{ sopId }, ...identifierClauses],
  };
}

export async function markMatchingRequestsInProgress(params: {
  sopIds: string[];
  identifiers: string[];
}) {
  const sopObjectIds = params.sopIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  const identifiers = params.identifiers.map((s) => s.trim()).filter(Boolean);
  if (!sopObjectIds.length && !identifiers.length) return 0;

  const or: Record<string, unknown>[] = [];
  if (sopObjectIds.length) or.push({ sopId: { $in: sopObjectIds } });
  for (const identifier of identifiers) {
    const idFilter = sopIdentifierMatchFilter(identifier, "sopIdentifier");
    if (Array.isArray((idFilter as { $or?: unknown[] }).$or)) {
      or.push(...((idFilter as { $or: Record<string, unknown>[] }).$or));
    } else {
      or.push(idFilter);
    }
  }

  const result = await ComplianceRunRequest.updateMany(
    { status: "pending", $or: or },
    { $set: { status: "in_progress" } },
  );
  return result.modifiedCount ?? 0;
}

export async function completeMatchingComplianceRunRequests(report: {
  _id?: unknown;
  sopId?: unknown;
  sopIdentifier?: string;
  sopName?: string;
  department?: string;
  overallScore?: number;
  complianceStatus?: string;
  analyzedAt?: Date;
  compliantCount?: number;
  partialCount?: number;
  nonCompliantCount?: number;
}) {
  const sopIdRaw = report.sopId;
  const sopIdentifier = String(report.sopIdentifier ?? "").trim();
  if (!sopIdRaw && !sopIdentifier) return 0;

  const sopId =
    sopIdRaw && mongoose.Types.ObjectId.isValid(String(sopIdRaw))
      ? new mongoose.Types.ObjectId(String(sopIdRaw))
      : null;
  if (!sopId) return 0;

  const filter = openRequestFilter(sopId, sopIdentifier || String(sopId));
  const open = await ComplianceRunRequest.find(filter);
  if (!open.length) return 0;

  const reportId = report._id
    ? new mongoose.Types.ObjectId(String(report._id))
    : undefined;
  const analyzedAt =
    report.analyzedAt instanceof Date ? report.analyzedAt : new Date();
  const summary = {
    overallScore: Number(report.overallScore ?? 0),
    complianceStatus: String(report.complianceStatus ?? ""),
    analyzedAt,
    compliantCount: Number(report.compliantCount ?? 0),
    partialCount: Number(report.partialCount ?? 0),
    nonCompliantCount: Number(report.nonCompliantCount ?? 0),
  };

  const scoreLabel = Number.isFinite(summary.overallScore)
    ? summary.overallScore.toFixed(1)
    : "—";

  for (const req of open) {
    req.status = "completed";
    req.reportId = reportId;
    req.resultSummary = summary;
    req.completedAt = analyzedAt;
    await req.save();

    await notifyUsers([req.requesterId], {
      type: "compliance_run_completed",
      title: `Compliance run completed: ${req.sopIdentifier}`,
      body: `${req.sopName} (${req.department}) finished with ${summary.complianceStatus || "results"} — score ${scoreLabel}.`,
      href: `/compliance/request/${req._id.toString()}`,
      requestId: req._id,
      sopIdentifier: req.sopIdentifier,
      department: req.department,
    });
  }

  return open.length;
}
