import { NextRequest, NextResponse } from "next/server";
import { bearerToken, hasScope, verifyApiKey } from "@/lib/api-keys";
import {
  BOT_CHUNK_BYTES,
  BOT_MAX_CHUNKS,
  botUploadBelongsToKey,
  safeFileName,
  storeBotChunk,
} from "@/lib/bot-uploads";

export const maxDuration = 60;

/** Receives one chunk of a file started with the MCP `begin_file_upload` tool. */
export async function POST(request: NextRequest) {
  const principal = await verifyApiKey(bearerToken(request));
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasScope(principal, "sops:write") && !hasScope(principal, "media:write")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const formData = await request.formData();
    const uploadId = String(formData.get("uploadId") ?? "").trim();
    const fileName = safeFileName(String(formData.get("fileName") ?? ""));
    const chunkIndex = Number(formData.get("chunkIndex"));
    const chunkCount = Number(formData.get("chunkCount"));
    const chunk = formData.get("chunk");

    if (!uploadId || !botUploadBelongsToKey(uploadId, principal.keyId)) {
      return NextResponse.json({ error: "Unknown uploadId — call begin_file_upload first" }, { status: 400 });
    }
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(chunkCount)) {
      return NextResponse.json({ error: "chunkIndex and chunkCount must be integers" }, { status: 400 });
    }
    if (chunkCount < 1 || chunkCount > BOT_MAX_CHUNKS || chunkIndex < 0 || chunkIndex >= chunkCount) {
      return NextResponse.json({ error: "Invalid chunk index" }, { status: 400 });
    }
    if (!(chunk instanceof Blob) || !chunk.size) {
      return NextResponse.json({ error: "Missing chunk data" }, { status: 400 });
    }
    if (chunk.size > BOT_CHUNK_BYTES) {
      return NextResponse.json({ error: `Chunk exceeds ${BOT_CHUNK_BYTES} bytes` }, { status: 413 });
    }

    await storeBotChunk({
      uploadId,
      chunkIndex,
      chunkCount,
      fileName,
      data: Buffer.from(await chunk.arrayBuffer()),
    });
    return NextResponse.json({ received: true, chunkIndex, chunkCount });
  } catch (error) {
    console.error("bot upload-chunk error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Chunk upload failed" },
      { status: 500 },
    );
  }
}
