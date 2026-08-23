import { AsyncLocalStorage } from "node:async_hooks";
import { getServerSession } from "next-auth";
import type { NextRequest } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { authOptions } from "@/lib/auth";
import AuditLog, {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditEntityType,
} from "@/models/AuditLog";

export { AUDIT_ACTIONS };
export type { AuditAction, AuditEntityType };

export type AuditActor = {
  userId: string;
  userName: string;
  userRole: string;
  userDepartment?: string;
  ipAddress?: string;
  userAgent?: string;
  systemGenerated?: boolean;
};

const SYSTEM_ACTOR: AuditActor = {
  userId: "system",
  userName: "System",
  userRole: "system",
  systemGenerated: true,
};

const actorStore = new AsyncLocalStorage<AuditActor>();

export function runWithAuditActor<T>(actor: AuditActor, fn: () => T): T {
  return actorStore.run(actor, fn);
}

export function getAuditActor(): AuditActor {
  return actorStore.getStore() ?? SYSTEM_ACTOR;
}

export function clientIp(req?: NextRequest | null): string | undefined {
  if (!req) return undefined;
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || undefined;
  return req.headers.get("x-real-ip") ?? undefined;
}

export function actorFromSession(
  session: {
    user: {
      id: string;
      name?: string | null;
      username?: string;
      role: string;
      department?: string;
    };
  },
  req?: NextRequest | null,
): AuditActor {
  return {
    userId: session.user.id,
    userName: session.user.name?.trim() || session.user.username || "Unknown",
    userRole: session.user.role,
    userDepartment: session.user.department,
    ipAddress: clientIp(req),
    userAgent: req?.headers.get("user-agent") ?? undefined,
  };
}

export async function resolveAuditActor(req?: NextRequest | null): Promise<AuditActor> {
  const stored = actorStore.getStore();
  if (stored) {
    if (req && !stored.ipAddress) {
      return {
        ...stored,
        ipAddress: clientIp(req) ?? stored.ipAddress,
        userAgent: stored.userAgent ?? req.headers.get("user-agent") ?? undefined,
      };
    }
    return stored;
  }
  try {
    const session = await getServerSession(authOptions);
    if (session?.user) return actorFromSession(session, req);
  } catch {
    /* no request session (background worker) */
  }
  return SYSTEM_ACTOR;
}

const SNAPSHOT_FIELDS = [
  "name",
  "identifier",
  "department",
  "owner",
  "version",
  "language",
  "location",
  "processArea",
  "guidelineReference",
  "remarks",
  "status",
  "isObsolete",
  "obsoleteReason",
  "effectiveDate",
  "reviewDate",
  "expiryDate",
] as const;

function fileLabel(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  try {
    const path = decodeURIComponent(url.split("?")[0]);
    return path.split("/").filter(Boolean).pop() ?? url;
  } catch {
    return url;
  }
}

function mediaCount(value: unknown): number {
  if (Array.isArray(value)) return value.filter(Boolean).length;
  if (typeof value === "string" && value.trim()) return 1;
  return 0;
}

export function serializeAuditValue(value: unknown): unknown {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return trimmed;
  }
  if (typeof value === "object") {
    const maybeDate = value as { toISOString?: () => string };
    if (typeof maybeDate.toISOString === "function" && Object.prototype.toString.call(value) === "[object Date]") {
      return maybeDate.toISOString();
    }
  }
  return value;
}

function asPlain(source: unknown): Record<string, unknown> {
  if (!source || typeof source !== "object") return {};
  const doc = source as { toObject?: () => Record<string, unknown> };
  if (typeof doc.toObject === "function") return doc.toObject();
  return { ...(source as Record<string, unknown>) };
}

export function snapshotSop(source: unknown): Record<string, unknown> {
  const sop = asPlain(source);
  const media = (sop.mediaLinks ?? {}) as {
    videos?: { en?: unknown; gu?: unknown };
    slides?: { en?: unknown; gu?: unknown };
    thumbnail?: unknown;
  };
  const out: Record<string, unknown> = {};
  for (const field of SNAPSHOT_FIELDS) {
    out[field] = serializeAuditValue(sop[field]);
  }
  out.file = fileLabel(sop.fileUrl);
  out.videosEn = mediaCount(media.videos?.en);
  out.videosGu = mediaCount(media.videos?.gu);
  out.slidesEn = mediaCount(media.slides?.en);
  out.slidesGu = mediaCount(media.slides?.gu);
  out.thumbnail = media.thumbnail ? "yes" : null;
  return out;
}

export function diffAuditValues(
  previous?: Record<string, unknown> | null,
  updated?: Record<string, unknown> | null,
): {
  fieldsChanged: string[];
  previousValues: Record<string, unknown>;
  updatedValues: Record<string, unknown>;
} {
  const before = previous ?? {};
  const after = updated ?? {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const fieldsChanged: string[] = [];
  const previousValues: Record<string, unknown> = {};
  const updatedValues: Record<string, unknown> = {};

  for (const key of keys) {
    const left = serializeAuditValue(before[key]);
    const right = serializeAuditValue(after[key]);
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    fieldsChanged.push(key);
    previousValues[key] = left;
    updatedValues[key] = right;
  }

  return { fieldsChanged, previousValues, updatedValues };
}

function defaultSummary(params: {
  action: AuditAction;
  entityType: AuditEntityType;
  entityLabel: string;
  fieldsChanged: string[];
}): string {
  const label = params.entityLabel || (params.entityType === "department" ? "department" : "SOP");
  switch (params.action) {
    case "created":
      return params.entityType === "department" ? `Created department ${label}` : `Created SOP ${label}`;
    case "uploaded":
      return `Uploaded file for ${label}`;
    case "updated":
      return params.fieldsChanged.length
        ? `Updated ${params.fieldsChanged.join(", ")} on ${label}`
        : `Updated ${label}`;
    case "obsoleted":
      return `Moved ${label} to Obsolete SOPs`;
    case "restored":
      return `Restored ${label} to the SOP registry`;
    case "deleted":
      return params.entityType === "department"
        ? `Deleted department ${label}`
        : `Permanently deleted ${label}`;
    case "renamed":
      return `Renamed ${label}`;
    default:
      return `${params.action} ${label}`;
  }
}

export function toAuditDate(value: unknown): Date | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return undefined;
}

export function sopEventTimestamp(
  action: AuditAction,
  sop: Record<string, unknown>,
  fallback = new Date(),
): Date {
  switch (action) {
    case "created":
    case "uploaded":
      return toAuditDate(sop.uploadedAt) ?? toAuditDate(sop.createdAt) ?? fallback;
    case "obsoleted":
      return toAuditDate(sop.obsoleteAt) ?? toAuditDate(sop.updatedAt) ?? fallback;
    case "updated":
    case "restored":
      return toAuditDate(sop.updatedAt) ?? fallback;
    default:
      return fallback;
  }
}

export function auditDedupeKey(params: {
  entityType: AuditEntityType;
  entityId: string;
  action: AuditAction;
  timestamp: Date;
}): string {
  return `${params.entityType}|${params.entityId}|${params.action}|${params.timestamp.getTime()}`;
}

export type LogAuditParams = {
  actor?: AuditActor;
  entityType: AuditEntityType;
  entityId: string;
  entityLabel: string;
  sopName?: string;
  department?: string;
  action: AuditAction;
  fieldsChanged?: string[];
  previousValues?: Record<string, unknown>;
  updatedValues?: Record<string, unknown>;
  summary?: string;
  comments?: string;
  timestamp?: Date;
  source?: "live" | "historical";
};

export async function logAuditEvent(params: LogAuditParams): Promise<void> {
  try {
    await connectDB();
    const actor = params.actor ?? getAuditActor();
    const fieldsChanged = params.fieldsChanged ?? [];
    const timestamp = toAuditDate(params.timestamp) ?? new Date();
    await AuditLog.create({
      timestamp,
      entityType: params.entityType,
      entityId: params.entityId,
      entityLabel: params.entityLabel,
      sopName: params.sopName,
      department: params.department,
      userId: actor.userId,
      userName: actor.userName,
      userRole: actor.userRole,
      userDepartment: actor.userDepartment,
      action: params.action,
      fieldsChanged,
      previousValues: params.previousValues,
      updatedValues: params.updatedValues,
      summary:
        params.summary ??
        defaultSummary({
          action: params.action,
          entityType: params.entityType,
          entityLabel: params.entityLabel,
          fieldsChanged,
        }),
      comments: params.comments,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      systemGenerated: Boolean(actor.systemGenerated),
      source: params.source ?? "live",
      dedupeKey: auditDedupeKey({
        entityType: params.entityType,
        entityId: params.entityId,
        action: params.action,
        timestamp,
      }),
    });
  } catch (error) {
    const code = (error as { code?: number }).code;
    if (code === 11000) return;
    console.error("[audit-log] failed to write event:", error);
  }
}

export async function logSopAudit(params: {
  actor?: AuditActor;
  action: AuditAction;
  sop: unknown;
  previous?: Record<string, unknown> | null;
  updated?: Record<string, unknown> | null;
  comments?: string;
  summary?: string;
}): Promise<void> {
  const sop = asPlain(params.sop);
  const previous = params.previous ?? undefined;
  const updated = params.updated ?? snapshotSop(sop);
  const diff = diffAuditValues(previous, updated);

  const id = sop._id != null ? String(sop._id) : String(sop.identifier ?? "");
  await logAuditEvent({
    actor: params.actor,
    entityType: "sop",
    entityId: id,
    entityLabel: String(sop.identifier ?? ""),
    sopName: String(sop.name ?? ""),
    department: sop.department ? String(sop.department) : undefined,
    action: params.action,
    fieldsChanged: diff.fieldsChanged,
    previousValues: diff.previousValues,
    updatedValues: diff.updatedValues,
    comments: params.comments,
    summary: params.summary,
    timestamp: sopEventTimestamp(params.action, sop),
  });
}
