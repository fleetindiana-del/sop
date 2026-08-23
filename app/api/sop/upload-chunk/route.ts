import { NextRequest, NextResponse } from "next/server";
import { connectDB } from "@/lib/mongodb";
import { processSopUpload } from "@/lib/sop-upload";
import { requireAuth } from "@/lib/withAuth";
import { getContentType } from "@/lib/extractContent";
import SopUploadChunk from "@/models/SopUploadChunk";

export const maxDuration = 300;

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_CHUNKS = 50;

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

    const buffer = Buffer.concat(
      stored.map((row) => (Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data))),
    );
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

    return processSopUpload(complete);
  } catch (error) {
    console.error("upload-chunk error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chunk upload failed" },
      { status: 500 },
    );
  }
}
