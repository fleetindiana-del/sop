import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { processSopUpload } from "@/lib/sop-upload";
import { requireAuth } from "@/lib/withAuth";
import { getContentType } from "@/lib/extractContent";
import { uploadToBunny, fetchBunnyStorageFile, deleteFromBunny } from "@/lib/bunnyStorage";
import SopUploadChunk from "@/models/SopUploadChunk";

export const maxDuration = 300;

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
// 3MB chunks (see CHUNK_BYTES in lib/client-sop-upload.ts) × 200 = ~600MB per file —
// large enough for annexures with embedded scans/drawings that used to hit the old
// 50-chunk (~150MB) ceiling and fail with "Invalid chunk index" before a single byte
// was stored.
const MAX_CHUNKS = 200;

/** Bunny Storage path for one in-flight chunk. Objects here are temporary: deleted once
 *  the file is assembled, or left to be cleaned up manually if an upload is abandoned. */
function bunnyChunkPath(uploadId: string, chunkIndex: number): string {
  return `tmp-uploads/${uploadId}/${chunkIndex}`;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
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

    const data = Buffer.from(await chunk.arrayBuffer());
    const uploadedPath = await uploadToBunny(data, bunnyChunkPath(uploadId, chunkIndex));
    if (!uploadedPath) {
      return NextResponse.json({ error: "Failed to store chunk" }, { status: 502 });
    }

    await connectDB();
    await SopUploadChunk.findOneAndUpdate(
      { uploadId, chunkIndex },
      { uploadId, chunkIndex, chunkCount, fileName, relativePath, createdAt: new Date() },
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

    const parts = await mapPool(stored, 8, (row) =>
      fetchBunnyStorageFile(bunnyChunkPath(uploadId, row.chunkIndex)),
    );
    const missingIndex = parts.findIndex((part) => !part || !part.length);
    if (missingIndex !== -1) {
      return NextResponse.json(
        { error: `Failed to retrieve chunk ${stored[missingIndex].chunkIndex} — please retry` },
        { status: 502 },
      );
    }

    const buffer = Buffer.concat(parts as Buffer[]);

    await SopUploadChunk.deleteMany({ uploadId });
    await mapPool(stored, 8, (row) => deleteFromBunny(bunnyChunkPath(uploadId, row.chunkIndex)));

    if (!buffer.length) {
      return NextResponse.json(
        { error: "Assembled upload was empty — please retry" },
        { status: 500 },
      );
    }

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

    return processSopUpload(complete, request);
  } catch (error) {
    console.error("upload-chunk error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chunk upload failed" },
      { status: 500 },
    );
  }
}
