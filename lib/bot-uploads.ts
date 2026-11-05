import { randomUUID } from "crypto";
import { isIP } from "net";
import path from "path";
import { connectDB } from "@/lib/mongodb";
import SopUploadChunk from "@/models/SopUploadChunk";
import { deleteFromBunny, fetchBunnyStorageFile, uploadToBunny } from "@/lib/bunnyStorage";

/** Vercel caps request bodies at ~4.5 MB, so each chunk request stays under 4 MB. */
export const BOT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Assembled files are held in memory before going to Bunny, so cap them at 200 MB. */
export const BOT_MAX_CHUNKS = 50;
export const BOT_MAX_FILE_BYTES = BOT_CHUNK_BYTES * BOT_MAX_CHUNKS;

export function newBotUploadId(keyId: string): string {
  return `bot-${keyId}-${randomUUID()}`;
}

export function botUploadBelongsToKey(uploadId: string, keyId: string): boolean {
  return uploadId.startsWith(`bot-${keyId}-`);
}

export function safeFileName(name: string): string {
  return path.basename(name).replace(/[^\w.\- ]+/g, "_").trim() || "upload";
}

/** Chunk bytes live in Bunny (Mongo only tracks receipt); same layout as /api/sop/upload-chunk. */
function bunnyChunkPath(uploadId: string, chunkIndex: number): string {
  return `tmp-uploads/${uploadId}/${chunkIndex}`;
}

async function inBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

export async function storeBotChunk(input: {
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  fileName: string;
  data: Buffer;
}) {
  const stored = await uploadToBunny(input.data, bunnyChunkPath(input.uploadId, input.chunkIndex));
  if (!stored) throw new Error("Failed to store chunk — please retry");
  await connectDB();
  await SopUploadChunk.findOneAndUpdate(
    { uploadId: input.uploadId, chunkIndex: input.chunkIndex },
    {
      uploadId: input.uploadId,
      chunkIndex: input.chunkIndex,
      chunkCount: input.chunkCount,
      fileName: input.fileName,
      relativePath: input.fileName,
      createdAt: new Date(),
    },
    { upsert: true },
  );
}

export async function botUploadProgress(uploadId: string) {
  await connectDB();
  const rows = await SopUploadChunk.find({ uploadId }).select("chunkIndex chunkCount").lean();
  const chunkCount = rows[0]?.chunkCount ?? 0;
  const received = new Set(rows.map((row) => row.chunkIndex));
  const missing: number[] = [];
  for (let i = 0; i < chunkCount; i++) if (!received.has(i)) missing.push(i);
  return { chunkCount, received: received.size, missing };
}

/** Joins the stored chunks and deletes them; throws if any chunk is missing. */
export async function assembleBotUpload(uploadId: string): Promise<{ buffer: Buffer; fileName: string }> {
  await connectDB();
  const stored = await SopUploadChunk.find({ uploadId }).sort({ chunkIndex: 1 }).lean();
  if (!stored.length) throw new Error(`No chunks found for upload ${uploadId} (uploads expire after 1 hour)`);

  const chunkCount = stored[0].chunkCount;
  if (stored.length !== chunkCount) {
    const have = new Set(stored.map((row) => row.chunkIndex));
    const missing = Array.from({ length: chunkCount }, (_, i) => i).filter((i) => !have.has(i));
    throw new Error(`Upload incomplete: missing chunk(s) ${missing.join(", ")} of ${chunkCount}`);
  }

  const parts = await inBatches(stored, 8, (row) => fetchBunnyStorageFile(bunnyChunkPath(uploadId, row.chunkIndex)));
  const missingIndex = parts.findIndex((part) => !part || !part.length);
  if (missingIndex !== -1) {
    throw new Error(`Failed to retrieve chunk ${stored[missingIndex].chunkIndex} — please retry`);
  }
  const buffer = Buffer.concat(parts as Buffer[]);
  await SopUploadChunk.deleteMany({ uploadId });
  await inBatches(stored, 8, (row) => deleteFromBunny(bunnyChunkPath(uploadId, row.chunkIndex)));
  if (!buffer.length) throw new Error("Assembled upload was empty — please retry");
  return { buffer, fileName: stored[0].fileName };
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) return true;
  const version = isIP(host);
  if (version === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (version === 6) {
    return host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80");
  }
  return false;
}

function fileNameFromResponse(url: URL, res: Response): string {
  const disposition = res.headers.get("content-disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (match?.[1]) return decodeURIComponent(match[1]);
  return decodeURIComponent(url.pathname.split("/").pop() || "");
}

/** Downloads a public HTTPS file into memory, enforcing the bot upload size cap. */
export async function downloadFromUrl(
  rawUrl: string,
): Promise<{ buffer: Buffer; fileName: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid URL");
  }
  if (url.protocol !== "https:") throw new Error("Only https:// URLs are allowed");
  if (isPrivateHost(url.hostname)) throw new Error("URL host is not allowed");

  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(240_000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  if (isPrivateHost(new URL(res.url).hostname)) throw new Error("URL redirected to a disallowed host");

  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > BOT_MAX_FILE_BYTES) {
    throw new Error(`File is ${Math.round(declared / 1048576)} MB; the limit is ${BOT_MAX_FILE_BYTES / 1048576} MB`);
  }

  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BOT_MAX_FILE_BYTES) {
      await reader.cancel();
      throw new Error(`File exceeds the ${BOT_MAX_FILE_BYTES / 1048576} MB limit`);
    }
    parts.push(value);
  }
  if (!total) throw new Error("Downloaded file is empty");

  return { buffer: Buffer.concat(parts), fileName: fileNameFromResponse(url, res) };
}
