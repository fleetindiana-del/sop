import mongoose from "mongoose";
import { z } from "zod";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { getPublicOrigin } from "mcp-handler";
import { connectDB } from "@/lib/mongodb";
import {
  actorFromApiKey,
  hasScope,
  type ApiKeyPrincipal,
  type ApiKeyScope,
} from "@/lib/api-keys";
import { runWithAuditActor } from "@/lib/audit-log";
import { canAccessDepartment, isDeptScopedRole } from "@/lib/roles";
import { isComplianceOperator } from "@/lib/page-access";
import { sopIdentifierMatchFilter } from "@/lib/sopIdentifierNormalize";
import { processSopUpload } from "@/lib/sop-upload";
import { processMediaUpload } from "@/lib/media-upload";
import { detectFileType, detectLanguageFromFilename, detectMediaKind } from "@/lib/upload";
import { getContentType } from "@/lib/extractContent";
import { findMcqGenJob } from "@/lib/mcq-gen-job-store";
import { runWithAgentBackend } from "@/lib/agent-backend";
import {
  findComplianceOperators,
  notifyUsers,
  toRequestDto,
} from "@/lib/complianceRunRequests";
import {
  BOT_CHUNK_BYTES,
  BOT_MAX_CHUNKS,
  BOT_MAX_FILE_BYTES,
  assembleBotUpload,
  botUploadBelongsToKey,
  botUploadProgress,
  downloadFromUrl,
  newBotUploadId,
  safeFileName,
} from "@/lib/bot-uploads";
import SOP from "@/models/SOP";
import ComplianceRunRequest from "@/models/ComplianceRunRequest";
import ComplianceReport from "@/models/ComplianceReport";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function principalFrom(ctx: ServerContext): ApiKeyPrincipal {
  const principal = ctx.http?.authInfo?.extra?.principal as ApiKeyPrincipal | undefined;
  if (!principal) throw new Error("Unauthorized");
  return principal;
}

function json(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function registerScopedTool<S extends z.ZodObject>(
  server: McpServer,
  name: string,
  config: { title: string; description: string; inputSchema: S; readOnly?: boolean },
  scope: ApiKeyScope,
  run: (args: z.infer<S>, principal: ApiKeyPrincipal, ctx: ServerContext) => Promise<unknown>,
) {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema as z.ZodObject,
      annotations: config.readOnly ? { readOnlyHint: true } : undefined,
    },
    async (args: unknown, ctx: ServerContext): Promise<ToolResult> => {
      try {
        const principal = principalFrom(ctx);
        if (!hasScope(principal, scope)) {
          return { content: [{ type: "text", text: `This API key lacks the "${scope}" scope.` }], isError: true };
        }
        const result = await runWithAuditActor(actorFromApiKey(principal), () =>
          run(args as z.infer<S>, principal, ctx),
        );
        return json(result);
      } catch (error) {
        return {
          content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed" }],
          isError: true,
        };
      }
    },
  );
}

function assertDepartmentAccess(principal: ApiKeyPrincipal, department: string | undefined) {
  if (!canAccessDepartment(principal.user.role, principal.user.department, department)) {
    throw new Error(`This API key cannot access department "${department ?? ""}"`);
  }
}

async function findSopRecords(identifier: string) {
  await connectDB();
  return SOP.find(sopIdentifierMatchFilter(identifier.trim()))
    .select(
      "identifier name department version versionNum language status isObsolete complianceStatus complianceScore mcqCount mediaLinks effectiveDate reviewDate expiryDate updatedAt",
    )
    .sort({ isObsolete: 1, versionNum: -1 })
    .lean();
}

function toFile(buffer: Buffer, fileName: string): File {
  return new File([new Uint8Array(buffer)], fileName, { type: getContentType(fileName) });
}

const sopMetadataShape = {
  department: z.string().optional().describe("Department name. Inferred from the file when omitted."),
  language: z.enum(["English", "Gujarati"]).optional().describe("Defaults to English."),
  identifier: z.string().optional().describe("SOP number, e.g. QA-SOP-001. Inferred from the file when omitted."),
  name: z.string().optional().describe("SOP title. Inferred from the file when omitted."),
  version: z.string().optional(),
  location: z.string().optional(),
  generateMcq: z.boolean().optional().describe("Queue MCQ bank generation after upload."),
};

type SopMetadata = {
  department?: string;
  language?: "English" | "Gujarati";
  identifier?: string;
  name?: string;
  version?: string;
  location?: string;
  generateMcq?: boolean;
};

async function uploadSopBuffer(buffer: Buffer, rawFileName: string, meta: SopMetadata) {
  const fileName = safeFileName(rawFileName);
  if (!detectFileType(fileName)) throw new Error(`"${fileName}" must be a .docx or .pdf file`);

  const form = new FormData();
  form.append("files", toFile(buffer, fileName));
  form.append("paths", fileName);
  form.set("language", meta.language ?? "English");
  if (meta.department) form.set("department", meta.department);
  if (meta.identifier) form.set("identifier", meta.identifier);
  if (meta.name) form.set("name", meta.name);
  if (meta.version) form.set("version", meta.version);
  if (meta.location) form.set("location", meta.location);
  if (meta.generateMcq) form.set("generateMcq", "true");

  // GrokBot is the AI for anything it uploads, including the auto-queued MCQ bank.
  const res = await runWithAgentBackend("grokbot", () => processSopUpload(form));
  return res.json();
}

const MEDIA_KINDS = ["video", "slide", "thumbnail"] as const;
type MediaKind = (typeof MEDIA_KINDS)[number];

/** Media language comes from the filename (a "GUJ" token marks Gujarati). */
function mediaFileName(rawFileName: string, language: "English" | "Gujarati" | undefined) {
  const fileName = safeFileName(rawFileName);
  if (language === "Gujarati" && detectLanguageFromFilename(fileName) !== "Gujarati") {
    const dot = fileName.lastIndexOf(".");
    return dot > 0 ? `${fileName.slice(0, dot)}_GUJ${fileName.slice(dot)}` : `${fileName}_GUJ`;
  }
  return fileName;
}

async function attachMediaBuffer(
  principal: ApiKeyPrincipal,
  buffer: Buffer,
  rawFileName: string,
  identifier: string,
  kind: MediaKind,
  language?: "English" | "Gujarati",
) {
  const fileName = mediaFileName(rawFileName, language);
  const detected = detectMediaKind(fileName);
  if (detected !== kind) {
    const allowed = { video: ".mp4, .mov, .webm", slide: ".pdf", thumbnail: ".jpg, .png, .webp, .gif" }[kind];
    throw new Error(`"${fileName}" is not a valid ${kind} file (${allowed})`);
  }

  const [sop] = await findSopRecords(identifier);
  if (!sop) throw new Error(`SOP not found: ${identifier}`);
  assertDepartmentAccess(principal, sop.department);

  const form = new FormData();
  form.set("identifier", sop.identifier);
  const field = kind === "video" ? "videos" : kind === "slide" ? "slides" : "thumbnail";
  form.append(field, toFile(buffer, fileName));
  return processMediaUpload(form);
}

export function registerSopTools(server: McpServer) {
  registerScopedTool(
    server,
    "list_sops",
    {
      title: "List SOPs",
      description:
        "Search the SOP registry by identifier or title. Returns current (non-obsolete) SOPs with compliance status, MCQ count and whether training media exists.",
      inputSchema: z.object({
        search: z.string().optional().describe("Matches identifier or title (case-insensitive)."),
        department: z.string().optional(),
        includeObsolete: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
      }),
      readOnly: true,
    },
    "sops:read",
    async ({ search, department, includeObsolete, limit }, principal) => {
      await connectDB();
      const filter: Record<string, unknown> = {};
      if (!includeObsolete) filter.isObsolete = { $ne: true };
      if (search?.trim()) {
        const pattern = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [{ identifier: pattern }, { name: pattern }];
      }
      if (department?.trim()) {
        filter.department = new RegExp(`^${department.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      }

      const rows = await SOP.find(filter)
        .select("identifier name department version language isObsolete complianceStatus complianceScore mcqCount mediaLinks")
        .sort({ identifier: 1 })
        .limit(isDeptScopedRole(principal.user.role) ? 1000 : (limit ?? 25))
        .lean();

      return rows
        .filter((row) => canAccessDepartment(principal.user.role, principal.user.department, row.department))
        .slice(0, limit ?? 25)
        .map((row) => ({
          sopId: String(row._id),
          identifier: row.identifier,
          name: row.name,
          department: row.department,
          version: row.version,
          language: row.language,
          obsolete: Boolean(row.isObsolete),
          complianceStatus: row.complianceStatus ?? "pending",
          complianceScore: row.complianceScore ?? null,
          mcqCount: row.mcqCount ?? 0,
          hasVideo: Boolean(row.mediaLinks?.videos?.en?.length || row.mediaLinks?.videos?.gu?.length),
        }));
    },
  );

  registerScopedTool(
    server,
    "get_sop",
    {
      title: "Get SOP details",
      description:
        "Get every record for one SOP identifier (each language and version), including media links and compliance status. Use the returned sopId for compliance tools.",
      inputSchema: z.object({ identifier: z.string().min(1) }),
      readOnly: true,
    },
    "sops:read",
    async ({ identifier }, principal) => {
      const rows = await findSopRecords(identifier);
      if (!rows.length) throw new Error(`SOP not found: ${identifier}`);
      assertDepartmentAccess(principal, rows[0].department);
      return rows.map((row) => ({ sopId: String(row._id), ...row, _id: undefined }));
    },
  );

  registerScopedTool(
    server,
    "upload_sop_from_url",
    {
      title: "Upload SOP from URL",
      description: `Upload an SOP document (.docx or .pdf) that the server downloads from a public https URL (max ${BOT_MAX_FILE_BYTES / 1048576} MB). A new version of an existing identifier supersedes the old one.`,
      inputSchema: z.object({
        url: z.string().url(),
        fileName: z.string().optional().describe("Override the file name, including extension."),
        ...sopMetadataShape,
      }),
    },
    "sops:write",
    async ({ url, fileName, ...meta }) => {
      const download = await downloadFromUrl(url);
      return uploadSopBuffer(download.buffer, fileName || download.fileName, meta);
    },
  );

  registerScopedTool(
    server,
    "upload_media_from_url",
    {
      title: "Attach training media from URL",
      description: `Attach a training video (.mp4/.mov/.webm), slide deck (.pdf) or thumbnail image to an existing SOP. The server downloads it from a public https URL (max ${BOT_MAX_FILE_BYTES / 1048576} MB).`,
      inputSchema: z.object({
        identifier: z.string().min(1),
        kind: z.enum(MEDIA_KINDS),
        url: z.string().url(),
        fileName: z.string().optional().describe("Override the file name, including extension."),
        language: z.enum(["English", "Gujarati"]).optional().describe("Defaults to English."),
      }),
    },
    "media:write",
    async ({ identifier, kind, url, fileName, language }, principal) => {
      const download = await downloadFromUrl(url);
      return attachMediaBuffer(principal, download.buffer, fileName || download.fileName, identifier, kind, language);
    },
  );

  registerScopedTool(
    server,
    "begin_file_upload",
    {
      title: "Begin chunked file upload",
      description:
        "Start uploading a local file (SOP document or training media) in chunks. Returns an uploadId and the HTTP endpoint to POST each chunk to with the same Bearer key. When every chunk is sent, call finish_sop_upload or finish_media_upload. Uploads expire after 1 hour.",
      inputSchema: z.object({
        fileName: z.string().min(1).describe("Original file name including extension."),
        sizeBytes: z.number().int().positive(),
      }),
    },
    "sops:read",
    async ({ fileName, sizeBytes }, principal, ctx) => {
      if (!hasScope(principal, "sops:write") && !hasScope(principal, "media:write")) {
        throw new Error('This API key needs the "sops:write" or "media:write" scope to upload files.');
      }
      if (sizeBytes > BOT_MAX_FILE_BYTES) {
        throw new Error(`File is ${Math.round(sizeBytes / 1048576)} MB; the limit is ${BOT_MAX_FILE_BYTES / 1048576} MB`);
      }
      const chunkCount = Math.ceil(sizeBytes / BOT_CHUNK_BYTES);
      const uploadId = newBotUploadId(principal.keyId);
      const origin = ctx.http?.req ? getPublicOrigin(ctx.http.req) : "";
      const chunkUrl = `${origin}/api/bot/upload-chunk`;
      return {
        uploadId,
        fileName: safeFileName(fileName),
        chunkSizeBytes: BOT_CHUNK_BYTES,
        chunkCount,
        maxChunks: BOT_MAX_CHUNKS,
        chunkUrl,
        instructions: [
          `Split the file into ${chunkCount} chunk(s) of at most ${BOT_CHUNK_BYTES} bytes, in order (e.g. split -b ${BOT_CHUNK_BYTES} -d -a 3 <file> part_).`,
          `For each chunk i (0-based): POST multipart/form-data to ${chunkUrl} with header "Authorization: Bearer <key>" and fields uploadId, fileName, chunkIndex=i, chunkCount=${chunkCount}, chunk=@<part file>.`,
          "Example: curl -sf -H \"Authorization: Bearer $SOP_API_KEY\" " +
            `-F uploadId=${uploadId} -F fileName=${safeFileName(fileName)} -F chunkIndex=0 -F chunkCount=${chunkCount} -F chunk=@part_000 ${chunkUrl}`,
          "Then call finish_sop_upload (documents) or finish_media_upload (video/slide/thumbnail) with this uploadId.",
        ],
      };
    },
  );

  registerScopedTool(
    server,
    "check_file_upload",
    {
      title: "Check chunked upload progress",
      description: "Report how many chunks of an upload have arrived and which indexes are missing.",
      inputSchema: z.object({ uploadId: z.string().min(1) }),
      readOnly: true,
    },
    "sops:read",
    async ({ uploadId }, principal) => {
      if (!botUploadBelongsToKey(uploadId, principal.keyId)) throw new Error("Unknown uploadId");
      return botUploadProgress(uploadId);
    },
  );

  registerScopedTool(
    server,
    "finish_sop_upload",
    {
      title: "Finish SOP document upload",
      description: "Assemble a chunked upload started with begin_file_upload and import it as an SOP document (.docx or .pdf).",
      inputSchema: z.object({ uploadId: z.string().min(1), ...sopMetadataShape }),
    },
    "sops:write",
    async ({ uploadId, ...meta }, principal) => {
      if (!botUploadBelongsToKey(uploadId, principal.keyId)) throw new Error("Unknown uploadId");
      const { buffer, fileName } = await assembleBotUpload(uploadId);
      return uploadSopBuffer(buffer, fileName, meta);
    },
  );

  registerScopedTool(
    server,
    "finish_media_upload",
    {
      title: "Finish training media upload",
      description: "Assemble a chunked upload started with begin_file_upload and attach it to an SOP as a video, slide deck or thumbnail.",
      inputSchema: z.object({
        uploadId: z.string().min(1),
        identifier: z.string().min(1),
        kind: z.enum(MEDIA_KINDS),
        language: z.enum(["English", "Gujarati"]).optional().describe("Defaults to English."),
      }),
    },
    "media:write",
    async ({ uploadId, identifier, kind, language }, principal) => {
      if (!botUploadBelongsToKey(uploadId, principal.keyId)) throw new Error("Unknown uploadId");
      const { buffer, fileName } = await assembleBotUpload(uploadId);
      return attachMediaBuffer(principal, buffer, fileName, identifier, kind, language);
    },
  );

  registerScopedTool(
    server,
    "request_compliance_run",
    {
      title: "Start a compliance run",
      description:
        "Start a V3 regulatory compliance audit of an SOP against all guidelines. The local SOP worker picks it up and YOU write the findings: work the AI task queue (claim_ai_tasks → submit_ai_task_result) until it is empty — one task per guideline clause. Returns a requestId; poll get_compliance_request for the saved report.",
      inputSchema: z.object({
        identifier: z.string().min(1),
        note: z.string().max(500).optional(),
      }),
    },
    "compliance:run",
    async ({ identifier, note }, principal) => {
      const [sop] = await findSopRecords(identifier);
      if (!sop) throw new Error(`SOP not found: ${identifier}`);
      if (sop.isObsolete) throw new Error("Cannot request a run for an obsolete SOP");
      assertDepartmentAccess(principal, sop.department);

      const requesterId = new mongoose.Types.ObjectId(principal.user.id);
      const existing = await ComplianceRunRequest.findOne({
        requesterId,
        sopId: sop._id,
        status: { $in: ["pending", "in_progress"] },
      });
      if (existing) return { alreadyOpen: true, request: toRequestDto(existing) };

      const operators = await findComplianceOperators(principal.user.id);
      const notifiedUserIds = operators.map((u) => u._id as mongoose.Types.ObjectId);
      const requesterName = `${principal.user.name} (via ${principal.keyName})`;

      const created = await ComplianceRunRequest.create({
        sopId: sop._id,
        sopIdentifier: sop.identifier,
        sopName: sop.name,
        department: sop.department,
        requesterId,
        requesterName,
        requesterUsername: principal.user.username,
        status: "pending",
        note: note?.trim() ?? "",
        notifiedUserIds,
        autoRun: true,
        agentBackend: "grokbot",
      });

      await notifyUsers(notifiedUserIds, {
        type: "compliance_run_requested",
        title: `Compliance run started by GrokBot: ${sop.identifier}`,
        body: `${requesterName} started a compliance check for ${sop.name} (${sop.department}). The local worker runs it automatically with GrokBot — no action needed.`,
        href: `/compliance?requestId=${created._id.toString()}&sopId=${String(sop._id)}`,
        requestId: created._id,
        sopIdentifier: sop.identifier,
        department: sop.department,
      });

      return {
        request: toRequestDto(created),
        notifiedCount: notifiedUserIds.length,
        next: "Call claim_ai_tasks and answer every task until the queue is empty; then poll get_compliance_request.",
      };
    },
  );

  registerScopedTool(
    server,
    "start_mcq_generation",
    {
      title: "Start MCQ bank generation",
      description:
        "Generate (or top up) the training MCQ bank for an SOP. The local SOP worker runs the pipeline and YOU write the questions: work the AI task queue (claim_ai_tasks → submit_ai_task_result) until it is empty. Poll get_mcq_status for progress.",
      inputSchema: z.object({
        identifier: z.string().min(1),
        language: z.enum(["English", "Gujarati"]).optional().describe("Only this language. Default: both."),
        mode: z.enum(["generate", "continue"]).optional().describe("continue = keep the existing bank and add more."),
      }),
    },
    "ai:work",
    async ({ identifier, language, mode }, principal) => {
      const [sop] = await findSopRecords(identifier);
      if (!sop) throw new Error(`SOP not found: ${identifier}`);
      if (sop.isObsolete) throw new Error("Cannot generate MCQs for an obsolete SOP");
      assertDepartmentAccess(principal, sop.department);

      const { enqueueMcqGeneration, parseMcqLanguage } = await import("@/lib/mcq-generation");
      const job = await enqueueMcqGeneration(
        sop.identifier,
        "codex",
        mode === "continue" ? "continue" : undefined,
        language ? parseMcqLanguage(language) : undefined,
        { startWorker: !process.env.VERCEL, agentBackend: "grokbot" },
      );
      return {
        identifier: job.identifier,
        status: job.status,
        alreadyRunning: Boolean(job.alreadyRunning),
        awaitingLocalWorker: Boolean(job.awaitingLocalWorker),
        next: "Call claim_ai_tasks and answer every task until the queue is empty; then poll get_mcq_status.",
      };
    },
  );

  registerScopedTool(
    server,
    "get_compliance_request",
    {
      title: "Get compliance request status",
      description:
        "Status of a compliance run request (pending, in_progress, completed, cancelled). When completed, includes the score summary and up to 20 partial/non-compliant findings.",
      inputSchema: z.object({ requestId: z.string().min(1) }),
      readOnly: true,
    },
    "compliance:read",
    async ({ requestId }, principal) => {
      if (!mongoose.Types.ObjectId.isValid(requestId)) throw new Error("Invalid requestId");
      await connectDB();
      const doc = await ComplianceRunRequest.findById(requestId).lean();
      if (!doc) throw new Error("Request not found");
      if (
        String(doc.requesterId) !== principal.user.id &&
        !isComplianceOperator(principal.user.role, principal.user.pageAccess)
      ) {
        throw new Error("This API key cannot view that request");
      }

      let findings: unknown[] = [];
      if (doc.reportId) {
        const report = await ComplianceReport.findById(doc.reportId).select("findings").lean();
        findings = (report?.findings ?? [])
          .filter((f) => f.complianceLevel === "partial" || f.complianceLevel === "non-compliant")
          .slice(0, 20)
          .map((f) => ({
            clauseNumber: f.clauseNumber,
            clauseTitle: f.clauseTitle,
            complianceLevel: f.complianceLevel,
            issueSeverity: f.issueSeverity,
            mismatchExplanation: f.mismatchExplanation,
            suggestedAction: f.suggestedAction,
          }));
      }
      return { request: toRequestDto(doc), findings };
    },
  );

  registerScopedTool(
    server,
    "get_mcq_status",
    {
      title: "Get MCQ generation status",
      description: "Progress of MCQ bank generation for an SOP identifier (queued, running, completed, failed, cancelled).",
      inputSchema: z.object({ identifier: z.string().min(1) }),
      readOnly: true,
    },
    "mcq:read",
    async ({ identifier }) => {
      await connectDB();
      const job = await findMcqGenJob(identifier.trim());
      if (!job) return { identifier, status: "idle" };
      return {
        identifier: job.identifier,
        status: job.status,
        phase: job.phase,
        percent: job.percent,
        awaitingLocalWorker: Boolean(job.awaitingLocalWorker),
        totalInserted: job.totalInserted,
        error: job.error ?? null,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt ?? null,
      };
    },
  );
}
