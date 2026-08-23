import path from "path";
import { createHash } from "crypto";

import {
  isBunnyConfigured,
  uploadFileToBunny,
} from "@/lib/bunny";
import { appendCdnCacheBuster } from "@/lib/file-urls";
import { getContentType } from "@/lib/extractContent";

/** No-op kept for call-site compatibility; circuit breaker has been removed. */
export function resetBunnyUploadCircuit() {}

export async function saveUploadedBuffer(
  buffer: Buffer,
  fileName: string,
  department: string,
  identifier: string,
  language = "English",
): Promise<{ fileUrl: string; checksum: string; fileSize: number }> {
  // Never persist an empty upload: it would push 0 bytes to Bunny and overwrite a
  // good record (findByIdAndUpdate skips validators), leaving an unopenable file.
  if (!buffer?.length) {
    throw new Error(`${fileName} is empty (0 bytes) — check the source file and re-upload`);
  }

  const checksum = createHash("sha256").update(buffer).digest("hex");
  const filename = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileType = detectFileType(fileName) ?? "docx";

  if (!isBunnyConfigured()) {
    throw new Error(
      "Bunny CDN is not configured. Set BUNNY_STORAGE_PASSWORD, BUNNY_STORAGE_ZONE, BUNNY_STORAGE_HOSTNAME, and BUNNY_PULL_ZONE_URL in .env.local",
    );
  }

  const fileUrl = await uploadFileToBunny({
    buffer,
    department,
    identifier,
    language,
    fileType,
    filename,
    contentType: getContentType(fileName),
  });
  return {
    fileUrl: appendCdnCacheBuster(fileUrl, checksum),
    checksum,
    fileSize: buffer.length,
  };
}

export async function saveUploadedFile(
  file: File,
  department: string,
  identifier: string,
  language = "English",
): Promise<{ fileUrl: string; checksum: string; fileSize: number }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  return saveUploadedBuffer(buffer, file.name, department, identifier, language);
}

export function detectFileType(filename: string): "pdf" | "docx" | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  return null;
}

export function detectMediaKind(filename: string): "video" | "slide" | "thumbnail" | null {
  const ext = path.extname(filename).toLowerCase();
  if ([".mp4", ".mov", ".webm"].includes(ext)) return "video";
  if (ext === ".pdf") return "slide";
  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return "thumbnail";
  return null;
}

export {
  detectLanguageFromFilename,
  nameFromFilename,
  resolveUploadLanguage,
} from "@/lib/sop-filename";

export async function saveMediaFile(
  file: File,
  department: string,
  identifier: string,
  language: string,
  mediaKind: "video" | "slide" | "thumbnail",
): Promise<{ fileUrl: string; fileSize: number }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  if (!buffer.length) {
    throw new Error(`${file.name} is empty (0 bytes) — check the source file and re-upload`);
  }
  const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileType = mediaKind === "thumbnail" ? "thumbnail" : mediaKind;

  if (!isBunnyConfigured()) {
    throw new Error(
      "Bunny CDN is not configured. Set BUNNY_STORAGE_PASSWORD, BUNNY_STORAGE_ZONE, BUNNY_STORAGE_HOSTNAME, and BUNNY_PULL_ZONE_URL in .env.local",
    );
  }

  const fileUrl = await uploadFileToBunny({
    buffer,
    department,
    identifier,
    language,
    fileType,
    filename,
    contentType: getContentType(file.name),
  });
  return { fileUrl, fileSize: buffer.length };
}
