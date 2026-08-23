import { appendFilesWithPaths, getFileRelativePath } from "@/lib/upload-form";
import type { SopUploadResult } from "@/components/dashboard/BulkUploadShell";

/** Stay under Vercel's classic 4.5 MB function payload, including multipart overhead. */
const MAX_REQUEST_BYTES = 3.2 * 1024 * 1024;
const CHUNK_BYTES = 3 * 1024 * 1024;

export type SopClientUploadOptions = {
  language: string;
  department?: string;
  generateMcq?: boolean;
  identifier?: string;
  name?: string;
  version?: string;
  location?: string;
  endpoint?: string;
  onProgress?: (completed: number, total: number) => void;
};

function isAnnexureName(name: string): boolean {
  return /annex(ure)?|appendix/i.test(name);
}

function isPayloadTooLarge(status: number, error?: string): boolean {
  if (status === 413) return true;
  const text = (error ?? "").toLowerCase();
  return (
    text.includes("payload") ||
    text.includes("too large") ||
    text.includes("request entity") ||
    text.includes("function_payload_too_large")
  );
}

function isRetryableTransport(error?: string): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return (
    lower.includes("failed to fetch") ||
    lower.includes("network") ||
    lower.includes("load failed") ||
    isPayloadTooLarge(0, error)
  );
}

function mainsFirst(files: File[]): File[] {
  return [...files.filter((f) => !isAnnexureName(f.name)), ...files.filter((f) => isAnnexureName(f.name))];
}

function packBySize(files: File[]): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let bytes = 0;

  for (const file of files) {
    if (file.size > MAX_REQUEST_BYTES) {
      if (current.length) {
        batches.push(current);
        current = [];
        bytes = 0;
      }
      batches.push([file]);
      continue;
    }
    if (current.length && bytes + file.size > MAX_REQUEST_BYTES) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(file);
    bytes += file.size;
  }
  if (current.length) batches.push(current);
  return batches;
}

function appendMeta(formData: FormData, opts: SopClientUploadOptions) {
  formData.append("language", opts.language);
  if (opts.department?.trim()) formData.append("department", opts.department.trim());
  formData.append("generateMcq", String(Boolean(opts.generateMcq)));
  if (opts.identifier) formData.append("identifier", opts.identifier);
  if (opts.name) formData.append("name", opts.name);
  if (opts.version) formData.append("version", opts.version);
  if (opts.location) formData.append("location", opts.location);
}

async function parseUploadResponse(
  res: Response,
  files: File[],
): Promise<{ status: number; results: SopUploadResult[] }> {
  let data: { results?: SopUploadResult[]; error?: string } = {};
  try {
    data = await res.json();
  } catch {
    const error = `HTTP ${res.status}`;
    return {
      status: res.status,
      results: files.map((f) => ({ file: f.name, success: false, error })),
    };
  }

  if (!res.ok) {
    const error = data.error ?? `HTTP ${res.status}`;
    return {
      status: res.status,
      results: files.map((f) => ({ file: f.name, success: false, error })),
    };
  }

  return { status: res.status, results: data.results ?? [] };
}

async function postFileBatch(
  files: File[],
  opts: SopClientUploadOptions,
): Promise<{ status: number; results: SopUploadResult[] }> {
  const formData = new FormData();
  appendMeta(formData, opts);
  appendFilesWithPaths(formData, files);

  let res: Response;
  try {
    res = await fetch(opts.endpoint ?? "/api/sop/bulk-folder-upload", {
      method: "POST",
      body: formData,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Network error";
    return {
      status: 0,
      results: files.map((f) => ({ file: f.name, success: false, error })),
    };
  }

  return parseUploadResponse(res, files);
}

async function postChunkedFile(file: File, opts: SopClientUploadOptions): Promise<SopUploadResult> {
  const uploadId = crypto.randomUUID();
  const chunkCount = Math.max(1, Math.ceil(file.size / CHUNK_BYTES));
  const relativePath = getFileRelativePath(file);

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex++) {
    const blob = file.slice(chunkIndex * CHUNK_BYTES, (chunkIndex + 1) * CHUNK_BYTES);
    const formData = new FormData();
    appendMeta(formData, opts);
    formData.append("uploadId", uploadId);
    formData.append("fileName", file.name);
    formData.append("relativePath", relativePath);
    formData.append("chunkIndex", String(chunkIndex));
    formData.append("chunkCount", String(chunkCount));
    formData.append("chunk", blob, file.name);

    let res: Response;
    try {
      res = await fetch("/api/sop/upload-chunk", { method: "POST", body: formData });
    } catch (err) {
      return {
        file: file.name,
        success: false,
        error: err instanceof Error ? err.message : "Network error",
      };
    }

    if (chunkIndex < chunkCount - 1) {
      if (!res.ok) {
        const { results } = await parseUploadResponse(res, [file]);
        return results[0] ?? { file: file.name, success: false, error: `HTTP ${res.status}` };
      }
      continue;
    }

    const { results } = await parseUploadResponse(res, [file]);
    return results[0] ?? { file: file.name, success: false, error: "Empty chunked upload response" };
  }

  return { file: file.name, success: false, error: "Upload produced no chunks" };
}

async function uploadOneFile(file: File, opts: SopClientUploadOptions): Promise<SopUploadResult> {
  if (file.size > MAX_REQUEST_BYTES) {
    return postChunkedFile(file, opts);
  }

  const { status, results } = await postFileBatch([file], opts);
  const result = results[0] ?? { file: file.name, success: false, error: `HTTP ${status}` };
  if (!result.success && isPayloadTooLarge(status, result.error)) {
    return postChunkedFile(file, opts);
  }
  return result;
}

async function uploadPackedBatch(files: File[], opts: SopClientUploadOptions): Promise<SopUploadResult[]> {
  if (files.length === 1) {
    const first = await uploadOneFile(files[0], opts);
    if (first.success || !isRetryableTransport(first.error)) return [first];
    return [await uploadOneFile(files[0], opts)];
  }

  const { status, results } = await postFileBatch(files, opts);
  const payloadFailed =
    isPayloadTooLarge(status, results[0]?.error) ||
    results.every((r) => !r.success && isPayloadTooLarge(status, r.error));
  const transportFailed = results.every((r) => !r.success && isRetryableTransport(r.error));

  if (!payloadFailed && !transportFailed) return results;

  const retried: SopUploadResult[] = [];
  for (const file of files) {
    retried.push(await uploadOneFile(file, opts));
  }
  return retried;
}

/** Upload SOP/annexure files without exceeding Vercel function payload limits. */
export async function uploadSopFiles(
  files: File[],
  opts: SopClientUploadOptions,
): Promise<SopUploadResult[]> {
  const ordered = mainsFirst(files);
  const batches = packBySize(ordered);
  const all: SopUploadResult[] = [];
  let completed = 0;

  for (const batch of batches) {
    all.push(...(await uploadPackedBatch(batch, opts)));
    completed += batch.length;
    opts.onProgress?.(completed, ordered.length);
  }

  return all;
}
