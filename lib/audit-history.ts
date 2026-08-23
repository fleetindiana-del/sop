import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import Department from "@/models/Department";
import AuditLog, { type AuditAction } from "@/models/AuditLog";
import SystemCache from "@/models/SystemCache";
import {
  auditDedupeKey,
  snapshotSop,
  sopEventTimestamp,
  toAuditDate,
} from "@/lib/audit-log";

const BACKFILL_KEY = "audit-history-backfill-v1";

const HISTORICAL = {
  userId: "historical",
  userName: "Historical",
  userRole: "system",
  systemGenerated: true,
  source: "historical" as const,
};

type HistoryDoc = {
  timestamp: Date;
  entityType: "sop" | "department";
  entityId: string;
  entityLabel: string;
  sopName?: string;
  department?: string;
  userId: string;
  userName: string;
  userRole: string;
  action: AuditAction;
  fieldsChanged: string[];
  previousValues?: Record<string, unknown>;
  updatedValues?: Record<string, unknown>;
  summary: string;
  comments?: string;
  systemGenerated: boolean;
  source: "historical";
  dedupeKey: string;
};

type LeanSop = {
  _id: unknown;
  name?: string;
  identifier?: string;
  department?: string;
  version?: string;
  language?: string;
  fileType?: string;
  originalFileName?: string;
  uploadedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  isObsolete?: boolean;
  obsoleteAt?: Date;
  obsoleteReason?: string;
  fileUrl?: string;
  owner?: string;
  location?: string;
  effectiveDate?: Date;
  reviewDate?: Date;
  expiryDate?: Date;
  mediaLinks?: unknown;
};

function ms(value: Date | undefined, fallback: number) {
  return value?.getTime() ?? fallback;
}

function historyDoc(params: Omit<HistoryDoc, keyof typeof HISTORICAL | "dedupeKey"> & { timestamp: Date }): HistoryDoc {
  return {
    ...HISTORICAL,
    ...params,
    dedupeKey: auditDedupeKey({
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      timestamp: params.timestamp,
    }),
  };
}

function buildSopHistory(records: LeanSop[]): HistoryDoc[] {
  const groups = new Map<string, LeanSop[]>();
  for (const row of records) {
    const key = String(row.identifier ?? "").trim().toUpperCase();
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  const docs: HistoryDoc[] = [];

  for (const [, group] of groups) {
    const sorted = [...group].sort((a, b) => {
      const ta = ms(toAuditDate(a.uploadedAt) ?? toAuditDate(a.createdAt), Number.MAX_SAFE_INTEGER);
      const tb = ms(toAuditDate(b.uploadedAt) ?? toAuditDate(b.createdAt), Number.MAX_SAFE_INTEGER);
      return ta - tb;
    });
    const first = sorted[0];
    if (!first) continue;

    const createdAt = sopEventTimestamp("created", first as Record<string, unknown>);
    const createdSnap = snapshotSop(first);
    const identifier = String(first.identifier ?? "");
    const name = String(first.name ?? "");
    const department = first.department ? String(first.department) : undefined;
    const entityId = String(first._id);

    docs.push(
      historyDoc({
        timestamp: createdAt,
        entityType: "sop",
        entityId,
        entityLabel: identifier,
        sopName: name,
        department,
        action: "created",
        fieldsChanged: ["identifier", "name", "department", "version", "language"],
        updatedValues: createdSnap,
        summary: `Created SOP ${identifier}`,
        comments: first.originalFileName
          ? `Reconstructed from SOP uploadedAt · file ${first.originalFileName}`
          : "Reconstructed from SOP uploadedAt / createdAt",
      }),
    );

    for (const extra of sorted.slice(1)) {
      const uploadedAt = sopEventTimestamp("uploaded", extra as Record<string, unknown>);
      if (Math.abs(uploadedAt.getTime() - createdAt.getTime()) < 2000) continue;
      const lang = extra.language ?? "";
      const fileType = extra.fileType ?? "";
      docs.push(
        historyDoc({
          timestamp: uploadedAt,
          entityType: "sop",
          entityId: String(extra._id),
          entityLabel: String(extra.identifier ?? identifier),
          sopName: String(extra.name ?? name),
          department: extra.department ? String(extra.department) : department,
          action: "uploaded",
          fieldsChanged: ["file", "language", "fileType"],
          updatedValues: snapshotSop(extra),
          summary: `Uploaded ${[lang, fileType.toUpperCase()].filter(Boolean).join(" ")} file for ${extra.identifier ?? identifier}`,
          comments: extra.originalFileName
            ? `Reconstructed from SOP uploadedAt · file ${extra.originalFileName}`
            : "Reconstructed from SOP uploadedAt",
        }),
      );
    }

    const obsoleteRow = sorted.find((row) => row.isObsolete);
    if (obsoleteRow) {
      const obsoleteAt = sopEventTimestamp("obsoleted", obsoleteRow as Record<string, unknown>);
      docs.push(
        historyDoc({
          timestamp: obsoleteAt,
          entityType: "sop",
          entityId,
          entityLabel: identifier,
          sopName: name,
          department,
          action: "obsoleted",
          fieldsChanged: ["isObsolete", "obsoleteReason"],
          previousValues: { isObsolete: false, obsoleteReason: null },
          updatedValues: {
            isObsolete: true,
            obsoleteReason: obsoleteRow.obsoleteReason ?? "Moved to Obsolete SOPs",
          },
          summary: `Moved ${identifier} to Obsolete SOPs`,
          comments: "Reconstructed from SOP obsoleteAt",
        }),
      );
    }
  }

  return docs;
}

async function insertHistory(docs: HistoryDoc[]) {
  const BATCH = 500;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    try {
      await AuditLog.insertMany(batch, { ordered: false });
    } catch (error) {
      const code = (error as { code?: number }).code;
      const name = (error as { name?: string }).name;
      if (code === 11000 || name === "MongoBulkWriteError") continue;
      throw error;
    }
  }
}

let inFlight: Promise<void> | null = null;

/**
 * Rebuild historical audit rows from SOP / department documents using each
 * record's own uploadedAt / createdAt / obsoleteAt timestamps. Safe to call
 * on every audit-log read — duplicates are ignored via dedupeKey.
 */
export async function ensureAuditHistoryBackfill(): Promise<void> {
  if (inFlight) {
    await inFlight;
    return;
  }

  inFlight = (async () => {
    await connectDB();
    await AuditLog.collection
      .createIndex({ dedupeKey: 1 }, { unique: true, sparse: true, background: true })
      .catch(() => undefined);

    const [sopCount, deptCount] = await Promise.all([
      SOP.estimatedDocumentCount(),
      Department.estimatedDocumentCount(),
    ]);
    const flag = await SystemCache.findOne({ key: BACKFILL_KEY }).lean();
    const prev = flag?.payload as { sopCount?: number; deptCount?: number } | undefined;
    if (prev && prev.sopCount === sopCount && prev.deptCount === deptCount) return;

    const started = Date.now();
    const [sops, departments] = await Promise.all([
      SOP.find({})
        .select(
          "name identifier department version language fileType originalFileName uploadedAt createdAt updatedAt isObsolete obsoleteAt obsoleteReason fileUrl owner location effectiveDate reviewDate expiryDate mediaLinks",
        )
        .lean(),
      Department.find({}).select("name createdAt").lean(),
    ]);

    const docs = buildSopHistory(sops as LeanSop[]);
    for (const dept of departments as { name?: string; createdAt?: Date }[]) {
      const name = String(dept.name ?? "").trim();
      if (!name) continue;
      const timestamp = toAuditDate(dept.createdAt) ?? new Date(0);
      docs.push(
        historyDoc({
          timestamp,
          entityType: "department",
          entityId: name,
          entityLabel: name,
          department: name,
          action: "created",
          fieldsChanged: ["name"],
          updatedValues: { name },
          summary: `Created department ${name}`,
          comments: "Reconstructed from department createdAt",
        }),
      );
    }

    await insertHistory(docs);
    await SystemCache.updateOne(
      { key: BACKFILL_KEY },
      { $set: { payload: { sopCount, deptCount, events: docs.length }, computedAt: Date.now() } },
      { upsert: true },
    );
    console.log(
      `[audit-history] backfilled ${docs.length} event(s) from ${sops.length} SOP record(s) in ${Date.now() - started}ms`,
    );
  })().finally(() => {
    inFlight = null;
  });

  await inFlight;
}
