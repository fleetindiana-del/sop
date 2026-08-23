import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import Department from "@/models/Department";
import {
  resolveSopDatesFromContent,
  sopDatesToDbFields,
  formatSopHeaderDateErrors,
  validateSopHeaderDates,
} from "@/lib/sop-dates";
import {
  defaultExpiryDate,
  deriveSopRecordName,
  extractIdentifierFromFilename,
  parseUploadPathMetadata,
  resolveDepartmentFromUpload,
  preferNewestSopIdentifier,
  sopVersionFields,
  versionFromIdentifier,
} from "@/lib/sop-utils";
import { normalizeSopIdentifierKey, sopIdentifierMatchFilter } from "@/lib/sopIdentifierNormalize";
import { reconcileSopVersions } from "@/lib/reconcile-sop-versions";
import { resolveUploadLanguage } from "@/lib/sop-filename";
import {
  contentScriptMismatch,
  languageFromContentScript,
} from "@/lib/sop-name-resolution";
import {
  detectFileType,
  resetBunnyUploadCircuit,
  saveUploadedBuffer,
} from "@/lib/upload";
import { extractTextFromBuffer } from "@/lib/extractContent";
import {
  extractSopContentMetadata,
  isAnnexureFileName,
  shouldSkipImportFileName,
} from "@/lib/sop-content-metadata";
import { parseRequiredAnnexuresFromContent } from "@/lib/sop-annexure-requirements";
import { extractRefSopNoFromAnnexure } from "@/lib/annexure-parent-extract";
import { linkAnnexureToParent } from "@/lib/sop-annexure";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { invalidateViewerUrlCache } from "@/lib/viewerHelper";
import { invalidateDocxHtmlCache } from "@/lib/docxHtmlCache";
import { refreshFamilyPriorHeaderDateFlags } from "@/lib/prior-header-dates";
import { requireAuth } from "@/lib/withAuth";

export type SopFileInput = {
  buffer: Buffer;
  fileName: string;
  relativePath: string;
  department?: string;
  language?: string;
  identifier?: string;
  name?: string;
  version?: string;
  location?: string;
  generateMcq?: boolean;
  skipIfChecksumMatches?: boolean;
};

export type SopFileResult = {
  file: string;
  success: boolean;
  skipped?: boolean;
  skipReason?: "duplicate" | "checksum_unchanged";
  error?: string;
  id?: string;
  identifier?: string;
  checksum?: string;
  sopBaseId?: string;
  versionNum?: number;
  headerDateError?: boolean;
  headerDateErrors?: string[];
  kind?: "main" | "annexure";
};

export async function checkImportDuplicate(opts: {
  checksum: string;
  sopBaseId: string;
  versionNum: number;
  language: string;
  fileType: string;
}): Promise<{ duplicate: boolean; reason?: "duplicate" | "checksum_unchanged" }> {
  const byChecksum = await SOP.findOne({ checksum: opts.checksum }).lean();
  if (byChecksum) return { duplicate: true, reason: "duplicate" };

  const bySlot = await SOP.findOne({
    sopBaseId: opts.sopBaseId,
    versionNum: opts.versionNum,
    language: opts.language,
    fileType: opts.fileType,
    isObsolete: { $ne: true },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mongoose FilterQuery omits optional indexed fields under Document
  } as any).lean();

  if (bySlot) {
    // Already in the registry for this SOP/version/language/type — not a new import.
    // (Checksum may differ after re-export; still not "new".)
    return {
      duplicate: true,
      reason:
        !bySlot.checksum || bySlot.checksum === opts.checksum
          ? "checksum_unchanged"
          : "duplicate",
    };
  }

  return { duplicate: false };
}

export async function processSopFileInput(input: SopFileInput): Promise<SopFileResult> {
  await connectDB();
  const {
    buffer,
    fileName,
    relativePath,
    department: batchDepartment,
    language: defaultLanguage = "English",
    identifier: identifierInput,
    name: nameInput,
    version: versionInput,
    location,
    generateMcq = false,
    skipIfChecksumMatches = false,
  } = input;

  const fileType = detectFileType(fileName);
  if (!fileType) {
    return { file: fileName, success: false, error: "Unsupported file type" };
  }
  if (fileName.startsWith(".") || fileName.startsWith("~$")) {
    return { file: fileName, success: false, error: "System file skipped" };
  }

  const checksum = createHash("sha256").update(buffer).digest("hex");
  const pathMeta = parseUploadPathMetadata(relativePath);
  const content = await extractTextFromBuffer(buffer, fileType);
  const contentMeta = extractSopContentMetadata({ content, fileName, relativePath });

  const rawIdentifier =
    identifierInput ||
    preferNewestSopIdentifier(
      contentMeta.identifier,
      pathMeta.identifierFromPath,
      extractIdentifierFromFilename(pathMeta.fileName || fileName),
    );
  const identifier = normalizeSopIdentifierKey(rawIdentifier ?? "");

  const version =
    versionInput ||
    pathMeta.versionFromPath ||
    versionFromIdentifier(identifier) ||
    contentMeta.version ||
    "1.0";
  const { sopBaseId, versionNum, version: resolvedVersion } = sopVersionFields(
    identifier,
    version,
    pathMeta.versionFromPath,
  );
  const knownDepartments = (await Department.distinct("name")) as string[];
  const department = resolveDepartmentFromUpload({
    batchOverride: batchDepartment,
    contentDepartment: contentMeta.department,
    relativePath,
    identifier,
    knownDepartments,
  });
  const deptManualOverride = Boolean(batchDepartment?.trim());

  // Persist custom / document departments so capsules and dropdowns include them.
  if (department && department !== "General") {
    const alreadyKnown = knownDepartments.some(
      (d) => d.trim().toLowerCase() === department.toLowerCase(),
    );
    if (!alreadyKnown) {
      await Department.updateOne(
        { name: department },
        { $setOnInsert: { name: department } },
        { upsert: true },
      );
    }
  }

  const lang = languageFromContentScript(
    content,
    resolveUploadLanguage(relativePath, defaultLanguage),
  );

  if (skipIfChecksumMatches) {
    const dup = await checkImportDuplicate({
      checksum,
      sopBaseId,
      versionNum,
      language: lang,
      fileType,
    });
    if (dup.duplicate) {
      return {
        file: fileName,
        success: true,
        skipped: true,
        skipReason: dup.reason,
        identifier,
        checksum,
        sopBaseId,
        versionNum,
      };
    }
  }

  if (fileType === "docx") {
    const headerDateValidation = validateSopHeaderDates(content, lang);
    if (!headerDateValidation.valid) {
      const message = formatSopHeaderDateErrors(headerDateValidation.errors);
      return {
        file: fileName,
        success: false,
        error: message,
        identifier,
        headerDateError: true,
        headerDateErrors: headerDateValidation.errors,
      };
    }
  }

  const name = deriveSopRecordName({
    identifier,
    language: lang,
    fileType,
    content,
    originalFileName: pathMeta.fileName || fileName,
    titleFromPath: contentMeta.title ?? pathMeta.titleFromPath,
    explicitName: nameInput,
  });

  const { fileUrl, fileSize } = await saveUploadedBuffer(
    buffer,
    fileName,
    department,
    identifier,
    lang,
  );

  const docEntry = {
    fileName,
    filePath: fileUrl,
    fileType,
    language: lang,
    documentKind: "main" as const,
    checksum,
  };

  let existing = await SOP.findOne({
    sopBaseId,
    versionNum,
    language: lang,
    fileType,
    isObsolete: { $ne: true },
  });

  if (!existing) {
    existing = await SOP.findOne({
      ...sopIdentifierMatchFilter(identifier),
      language: lang,
      fileType,
      isObsolete: { $ne: true },
    });
  }

  if (existing && fileType === "docx" && contentScriptMismatch(existing.content, lang)) {
    const actualLang = lang === "English" ? "Gujarati" : "English";
    await existing.updateOne({ language: actualLang });
    existing = null;
  }

  const dateFields =
    fileType === "docx" ? sopDatesToDbFields(resolveSopDatesFromContent(content)) : {};

  const sharedFields = {
    name,
    identifier,
    department,
    ...(deptManualOverride ? { deptManualOverride: true } : {}),
    language: lang,
    fileUrl,
    fileType,
    content,
    checksum,
    version: resolvedVersion,
    sopBaseId,
    versionNum,
    location,
    folderPath: pathMeta.folderPath,
    parentFolder: pathMeta.parentFolder,
    subfolderLevel: pathMeta.folderPath ? pathMeta.folderPath.split("/").length : 0,
    originalFileName: fileName,
    metadata: { fileSize },
    sopDocuments: [docEntry],
    ...(fileType === "docx" && lang === "English"
      ? { requiredAnnexures: parseRequiredAnnexuresFromContent(content) }
      : {}),
    ...dateFields,
    ...(fileType === "docx" ? { headerDatesValid: true } : {}),
  };

  let sop = existing;
  if (existing) {
    sop = await SOP.findByIdAndUpdate(
      existing._id,
      {
        ...sharedFields,
        uploadedAt: new Date(),
        pipelineStatus: generateMcq ? "mcq_generating" : existing.pipelineStatus,
      },
      { returnDocument: 'after' },
    );
  } else {
    sop = await SOP.create({
      ...sharedFields,
      expiryDate: dateFields.expiryDate ?? defaultExpiryDate(24),
      status: "uploaded",
      pipelineStatus: generateMcq ? "mcq_generating" : "idle",
    });
  }

  if (fileType === "docx" && dateFields.expiryDate) {
    await SOP.updateMany(
      { sopBaseId, versionNum, isObsolete: { $ne: true } },
      { $set: dateFields },
    );
  }

  if (!sop) {
    return { file: fileName, success: false, error: "Failed to save SOP record" };
  }

  return {
    file: fileName,
    success: true,
    id: sop._id.toString(),
    identifier,
    checksum,
    sopBaseId,
    versionNum,
    kind: "main",
  };
}

async function processAnnexureFileInput(input: SopFileInput): Promise<SopFileResult> {
  const { buffer, fileName, relativePath } = input;
  const fileType = detectFileType(fileName);
  if (!fileType) {
    return { file: fileName, success: false, error: "Unsupported file type", kind: "annexure" };
  }

  const content =
    fileType === "docx" || fileType === "pdf"
      ? await extractTextFromBuffer(buffer, fileType)
      : "";
  const refParent =
    fileType === "docx"
      ? await extractRefSopNoFromAnnexure({ content, buffer })
      : undefined;
  const meta = extractSopContentMetadata({ content, fileName, relativePath });
  const parentIdentifier = refParent ?? meta.parentIdentifier;
  if (!parentIdentifier) {
    return {
      file: fileName,
      success: false,
      kind: "annexure",
      error:
        "Could not resolve parent SOP — put the annexure in the SOP folder or include the parent code in the filename",
    };
  }

  const parentHasRevision = /-\d+$/.test(parentIdentifier);
  const linkResult = await linkAnnexureToParent({
    buffer,
    fileName,
    relativePath,
    parentIdentifier,
    annexureLabel: meta.annexureLabel,
    versionNum: parentHasRevision ? meta.versionNum : undefined,
  });

  if (linkResult.skipped) {
    return {
      file: fileName,
      success: true,
      skipped: true,
      skipReason: "duplicate",
      identifier: linkResult.parentIdentifier ?? parentIdentifier,
      checksum: linkResult.checksum,
      kind: "annexure",
    };
  }
  if (!linkResult.success) {
    return {
      file: fileName,
      success: false,
      error: linkResult.error,
      identifier: parentIdentifier,
      kind: "annexure",
    };
  }

  const parent = await SOP.findOne({
    ...sopIdentifierMatchFilter(linkResult.parentIdentifier ?? parentIdentifier),
    isObsolete: { $ne: true },
  })
    .select("_id identifier sopBaseId versionNum")
    .lean();

  return {
    file: fileName,
    success: true,
    id: parent?._id ? String(parent._id) : undefined,
    identifier: linkResult.parentIdentifier ?? parentIdentifier,
    checksum: linkResult.checksum,
    sopBaseId: parent?.sopBaseId,
    versionNum: parent?.versionNum,
    kind: "annexure",
  };
}

export async function processSopUpload(formData: FormData) {
  resetBunnyUploadCircuit();
  await connectDB();

  const batchDepartment = (formData.get("department") as string)?.trim() || undefined;
  const language = (formData.get("language") as string) || "English";
  const identifierInput = (formData.get("identifier") as string)?.trim();
  const nameInput = (formData.get("name") as string)?.trim();
  const versionInput = (formData.get("version") as string)?.trim();
  const location = (formData.get("location") as string)?.trim();
  const generateMcq = formData.get("generateMcq") === "true";
  const deferReconcile = formData.get("deferReconcile") === "true";
  const files = formData.getAll("files") as File[];
  const paths = formData.getAll("paths").map((value) => String(value));

  if (!files.length) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const startedAt = Date.now();
  console.log(
    `[sop-upload] received ${files.length} file(s) — lang=${language}` +
      `${batchDepartment ? `, dept=${batchDepartment}` : ""}${generateMcq ? ", mcq=on" : ""}` +
      `${deferReconcile ? ", reconcile=deferred" : ""}`,
  );

  const results: SopFileResult[] = [];
  const mcqIdentifiers = new Set<string>();
  const touchedFamilies = new Set<string>();
  const touchedIdentifiers = new Set<string>();

  const pairs = files.map((file, index) => ({
    file,
    relativePath: paths[index] || file.name,
    annexure: isAnnexureFileName(file.name),
  }));
  // Main SOP/PDF records first so annexures in the same batch can link to them.
  const ordered = [...pairs.filter((p) => !p.annexure), ...pairs.filter((p) => p.annexure)];

  for (const [index, { file, relativePath, annexure }] of ordered.entries()) {
    try {
      if (shouldSkipImportFileName(file.name)) {
        results.push({
          file: file.name,
          success: true,
          skipped: true,
          kind: annexure ? "annexure" : "main",
        });
        continue;
      }

      const buffer = Buffer.from(await file.arrayBuffer());
      const result = annexure
        ? await processAnnexureFileInput({
            buffer,
            fileName: file.name,
            relativePath,
            department: batchDepartment,
            language,
          })
        : await processSopFileInput({
            buffer,
            fileName: file.name,
            relativePath,
            department: batchDepartment,
            language,
            identifier: identifierInput,
            name: nameInput,
            version: versionInput,
            location,
            generateMcq,
          });
      results.push(result);

      if (result.success && !result.skipped && result.identifier) {
        if (result.kind !== "annexure") mcqIdentifiers.add(result.identifier);
        if (result.sopBaseId) touchedFamilies.add(result.sopBaseId);
        touchedIdentifiers.add(result.identifier);
        console.log(
          `[sop-upload] ✓ (${index + 1}/${ordered.length}) ${result.identifier} → ok` +
            (result.kind === "annexure" ? " (annexure)" : ""),
        );
      } else if (!result.success) {
        console.error(
          `[sop-upload] ✗ (${index + 1}/${ordered.length}) ${file.name}: ${result.error}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      console.error(`[sop-upload] ✗ (${index + 1}/${ordered.length}) ${file.name}: ${message}`);
      results.push({
        file: file.name,
        success: false,
        error: message,
        kind: annexure ? "annexure" : "main",
      });
    }
  }

  if (mcqIdentifiers.size > 0) {
    const { enqueueMcqGenerationForNewSop } = await import("@/lib/mcq-generation");
    for (const identifier of mcqIdentifiers) {
      try {
        const queued = await enqueueMcqGenerationForNewSop(identifier);
        if (queued?.skipped) {
          console.log(`[sop-upload] MCQ not queued for ${identifier} (${queued.reason})`);
        } else if (queued?.awaitingLocalWorker) {
          console.log(`[sop-upload] MCQ queued for local Codex worker: ${identifier}`);
        }
      } catch (err) {
        console.error(`MCQ generation failed to queue for ${identifier}:`, err);
      }
    }
  }

  invalidateDashboardSopsCache();

  if (touchedIdentifiers.size > 0) {
    const ids = [...touchedIdentifiers];
    invalidateViewerUrlCache(ids);
    invalidateDocxHtmlCache(ids);
  }

  const successCount = results.filter((r) => r.success && !r.skipped).length;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[sop-upload] batch done: ${successCount} ok, ${results.length - successCount} failed in ${elapsed}s` +
      `${deferReconcile && successCount > 0 ? " (reconcile deferred to caller)" : ""}`,
  );

  if (successCount > 0 && !deferReconcile) {
    try {
      await reconcileSopVersions();
    } catch (e) {
      console.error("[sop-upload] post-upload reconcile error:", e);
    }
  }

  let headerFlagsChanged = false;
  for (const sopBaseId of touchedFamilies) {
    try {
      const family = await SOP.find({ sopBaseId, isObsolete: { $ne: true } });
      if (family.length) {
        const n = await refreshFamilyPriorHeaderDateFlags(family);
        if (n > 0) headerFlagsChanged = true;
      }
    } catch (e) {
      console.error(`[sop-upload] prior header date refresh error for ${sopBaseId}:`, e);
    }
  }
  if (headerFlagsChanged) invalidateDashboardSopsCache();

  return NextResponse.json({ results });
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const formData = await request.formData();
    return processSopUpload(formData);
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 },
    );
  }
}
