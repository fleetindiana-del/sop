import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { requireAuth } from "@/lib/withAuth";
import { isDeptScopedRole, parseAssignedDepartments } from "@/lib/access-control";
import { ensureAuditHistoryBackfill } from "@/lib/audit-history";
import AuditLog, {
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  type AuditAction,
  type AuditEntityType,
} from "@/models/AuditLog";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SORT_FIELDS = [
  "timestamp",
  "userName",
  "userRole",
  "action",
  "entityType",
  "entityLabel",
  "sopName",
  "department",
] as const;
type SortField = (typeof SORT_FIELDS)[number];

function isSortField(value: string): value is SortField {
  return (SORT_FIELDS as readonly string[]).includes(value);
}

function isAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

function isEntityType(value: string): value is AuditEntityType {
  return (AUDIT_ENTITY_TYPES as readonly string[]).includes(value);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toDto(row: {
  _id: unknown;
  timestamp: Date;
  entityType: AuditEntityType;
  entityId: string;
  entityLabel: string;
  sopName?: string;
  department?: string;
  userId: string;
  userName: string;
  userRole: string;
  userDepartment?: string;
  action: AuditAction;
  fieldsChanged?: string[];
  previousValues?: Record<string, unknown>;
  updatedValues?: Record<string, unknown>;
  summary: string;
  comments?: string;
  ipAddress?: string;
  userAgent?: string;
  systemGenerated?: boolean;
}) {
  return {
    id: String(row._id),
    timestamp: new Date(row.timestamp).toISOString(),
    entityType: row.entityType,
    entityId: row.entityId,
    entityLabel: row.entityLabel,
    sopName: row.sopName ?? "",
    department: row.department ?? "",
    userId: row.userId,
    userName: row.userName,
    userRole: row.userRole,
    userDepartment: row.userDepartment ?? "",
    action: row.action,
    fieldsChanged: row.fieldsChanged ?? [],
    previousValues: row.previousValues ?? {},
    updatedValues: row.updatedValues ?? {},
    summary: row.summary,
    comments: row.comments ?? "",
    ipAddress: row.ipAddress ?? "",
    userAgent: row.userAgent ?? "",
    systemGenerated: Boolean(row.systemGenerated),
  };
}

function csvCell(value: unknown): string {
  const text =
    value == null
      ? ""
      : Array.isArray(value)
        ? value.join("; ")
        : typeof value === "object"
          ? JSON.stringify(value)
          : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export async function GET(request: NextRequest) {
  // Admins only — the change history exposes every department's activity.
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    await connectDB();
    await ensureAuditHistoryBackfill();
    const params = request.nextUrl.searchParams;
    const q = params.get("q")?.trim() ?? "";
    const actionRaw = params.get("action")?.trim() ?? "";
    const entityTypeRaw = params.get("entityType")?.trim() ?? "";
    const department = params.get("department")?.trim() ?? "";
    const userName = params.get("userName")?.trim() ?? "";
    const from = params.get("from")?.trim() ?? "";
    const to = params.get("to")?.trim() ?? "";
    const sortByRaw = params.get("sortBy")?.trim() || "timestamp";
    const sortDirRaw = params.get("sortDir")?.trim() === "asc" ? "asc" : "desc";
    const format = params.get("format")?.trim() ?? "";
    const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
    const limit = Math.min(200, Math.max(1, Number(params.get("limit") ?? 50) || 50));
    const sortBy: SortField = isSortField(sortByRaw) ? sortByRaw : "timestamp";

    const filter: Record<string, unknown> = {};
    const and: Record<string, unknown>[] = [];

    if (isAction(actionRaw)) filter.action = actionRaw;
    if (isEntityType(entityTypeRaw)) filter.entityType = entityTypeRaw;
    if (userName) filter.userName = new RegExp(`^${escapeRegex(userName)}$`, "i");

    if (from || to) {
      const range: { $gte?: Date; $lte?: Date } = {};
      if (from) {
        const start = new Date(`${from}T00:00:00.000`);
        if (!Number.isNaN(start.getTime())) range.$gte = start;
      }
      if (to) {
        const end = new Date(`${to}T23:59:59.999`);
        if (!Number.isNaN(end.getTime())) range.$lte = end;
      }
      if (range.$gte || range.$lte) filter.timestamp = range;
    }

    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      and.push({
        $or: [
          { entityLabel: rx },
          { sopName: rx },
          { userName: rx },
          { department: rx },
          { summary: rx },
          { comments: rx },
          { fieldsChanged: rx },
        ],
      });
    }

    const role = auth.session.user.role;
    const scopeAnd: Record<string, unknown>[] = [];
    if (isDeptScopedRole(role)) {
      const assigned = parseAssignedDepartments(auth.session.user.department);
      if (!assigned.length) {
        return NextResponse.json({
          success: true,
          items: [],
          total: 0,
          page: 1,
          limit,
          sortBy,
          sortDir: sortDirRaw,
          facets: { actions: AUDIT_ACTIONS, entityTypes: AUDIT_ENTITY_TYPES, departments: [], users: [] },
        });
      }
      const deptRx = assigned.map((d) => new RegExp(`^${escapeRegex(d)}$`, "i"));
      scopeAnd.push({ department: { $in: deptRx } });
      and.push({ department: { $in: deptRx } });
    }

    if (department) {
      and.push({ department: new RegExp(`^${escapeRegex(department)}$`, "i") });
    }

    if (and.length) filter.$and = and;
    const facetFilter = scopeAnd.length ? { $and: scopeAnd } : {};

    const sort: Record<string, 1 | -1> = { [sortBy]: sortDirRaw === "asc" ? 1 : -1 };
    if (sortBy !== "timestamp") sort.timestamp = -1;

    if (format === "csv") {
      const rows = await AuditLog.find(filter).sort(sort).limit(5000).lean();
      const header = [
        "Timestamp",
        "User",
        "Role",
        "Action",
        "Entity Type",
        "SOP / Department",
        "SOP Name",
        "Department",
        "Fields Changed",
        "Summary",
        "Previous Values",
        "Updated Values",
        "Comments",
        "IP Address",
      ];
      const lines = [
        header.join(","),
        ...rows.map((row) =>
          [
            new Date(row.timestamp).toISOString(),
            row.userName,
            row.userRole,
            row.action,
            row.entityType,
            row.entityLabel,
            row.sopName ?? "",
            row.department ?? "",
            (row.fieldsChanged ?? []).join("; "),
            row.summary,
            JSON.stringify(row.previousValues ?? {}),
            JSON.stringify(row.updatedValues ?? {}),
            row.comments ?? "",
            row.ipAddress ?? "",
          ]
            .map(csvCell)
            .join(","),
        ),
      ];
      return new NextResponse(lines.join("\n"), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="audit-logs.csv"`,
          "Cache-Control": "no-store",
        },
      });
    }

    const skip = (page - 1) * limit;
    const [items, total, departments, users] = await Promise.all([
      AuditLog.find(filter).sort(sort).skip(skip).limit(limit).lean(),
      AuditLog.countDocuments(filter),
      AuditLog.distinct("department", facetFilter),
      AuditLog.distinct("userName", facetFilter),
    ]);

    return NextResponse.json(
      {
        success: true,
        items: items.map((row) => toDto(row)),
        total,
        page,
        limit,
        sortBy,
        sortDir: sortDirRaw,
        facets: {
          actions: AUDIT_ACTIONS,
          entityTypes: AUDIT_ENTITY_TYPES,
          departments: (departments as string[]).filter(Boolean).sort((a, b) => a.localeCompare(b)),
          users: (users as string[]).filter(Boolean).sort((a, b) => a.localeCompare(b)),
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("GET /api/audit-logs error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load audit logs" },
      { status: 500 },
    );
  }
}
