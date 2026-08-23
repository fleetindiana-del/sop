import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { processSopUpload } from "@/lib/sop-upload";
import { requireAuth } from "@/lib/withAuth";
import { getContentType } from "@/lib/extractContent";
import SopUploadChunk from "@/models/SopUploadChunk";

export const maxDuration = 300;

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 50;

/**
 * `.lean()` returns the raw BSON `Binary`, not a Buffer. `Buffer.from(binary)`
 * must NOT be used: `Binary.length` is a method, so Node reads it as an
 * array-like of length 0 and silently returns an empty buffer — which is how
 * every chunked (>3.2 MB) upload ended up stored as a 0-byte file.
 */
function chunkToBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  const inner = (data as { buffer?: Uint8Array } | null | undefined)?.buffer;
  if (inner) return Buffer.from(inner);
  return Buffer.from(data as Uint8Array);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(["admin"]);
  if (auth.error) return auth.error;

  try {
    const formData = await request.formData();
    const uploadId = String(formData.get("uploadId") ?? "").trim();
    const fileName = String(formData.get("fileName") ?? "").trim();
    const relativePath = String(formData.get("relativePath") ?? fileName).trim();
    const chunkIndex = Number(formData.get("chunkIndex"));
    const chunkCount = Number(formData.get("chunkCount"));
    const chunk = formData.get("chunk");

    if (!uploadId || !fileName || !Number.isInteger(chunkIndex) || !Number.isInteger(chunkCount)) {
      return NextResponse.json({ error: "Invalid chunk metadata" }, { status: 400 });
    }
    if (chunkCount < 1 || chunkCount > MAX_CHUNKS || chunkIndex < 0 || chunkIndex >= chunkCount) {
      return NextResponse.json({ error: "Invalid chunk index" }, { status: 400 });
    }
    if (!(chunk instanceof Blob)) {
      return NextResponse.json({ error: "Missing chunk data" }, { status: 400 });
    }
    if (chunk.size > MAX_CHUNK_BYTES) {
      return NextResponse.json({ error: "Chunk exceeds size limit" }, { status: 413 });
    }

    await connectDB();
    const data = Buffer.from(await chunk.arrayBuffer());
    await SopUploadChunk.findOneAndUpdate(
      { uploadId, chunkIndex },
      { uploadId, chunkIndex, chunkCount, fileName, relativePath, data, createdAt: new Date() },
      { upsert: true },
    );

    if (chunkIndex !== chunkCount - 1) {
      return NextResponse.json({ received: true, chunkIndex, chunkCount });
    }

    const stored = await SopUploadChunk.find({ uploadId }).sort({ chunkIndex: 1 }).lean();
    if (stored.length !== chunkCount) {
      return NextResponse.json(
        { error: `Incomplete upload: got ${stored.length}/${chunkCount} chunks` },
        { status: 400 },
      );
    }

    const buffer = Buffer.concat(stored.map((row) => chunkToBuffer(row.data)));
    if (!buffer.length) {
      await SopUploadChunk.deleteMany({ uploadId });
      return NextResponse.json(
        { error: "Assembled upload was empty — please retry" },
        { status: 500 },
      );
    }
    await SopUploadChunk.deleteMany({ uploadId });

    const assembled = new File([new Uint8Array(buffer)], fileName, {
      type: getContentType(fileName),
    });
    const complete = new FormData();
    for (const key of [
      "language",
      "department",
      "generateMcq",
      "identifier",
      "name",
      "version",
      "location",
    ] as const) {
      const value = formData.get(key);
      if (typeof value === "string" && value.length) complete.append(key, value);
    }
    complete.append("files", assembled);
    complete.append("paths", relativePath);
    complete.set("deferReconcile", "true");

    return processSopUpload(complete, request);
  } catch (error) {
    console.error("upload-chunk error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chunk upload failed" },
      { status: 500 },
    );
  }
}
