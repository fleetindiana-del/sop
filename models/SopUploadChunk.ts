import mongoose, { Schema, type Model } from "mongoose";

/**
 * Tracks receipt of chunked-upload parts. The chunk bytes themselves live in
 * Bunny Storage (see `bunnyChunkPath` in app/api/sop/upload-chunk/route.ts) —
 * this doc used to also carry a `data: Buffer` field, but storing raw file
 * bytes here filled the MongoDB cluster's storage quota (a single large
 * annexure could buffer 100s of MB of chunks in Mongo before assembly).
 */
export interface ISopUploadChunk {
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  fileName: string;
  relativePath: string;
  createdAt: Date;
}

const SopUploadChunkSchema = new Schema<ISopUploadChunk>({
  uploadId: { type: String, required: true, index: true },
  chunkIndex: { type: Number, required: true },
  chunkCount: { type: Number, required: true },
  fileName: { type: String, required: true },
  relativePath: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 },
});

SopUploadChunkSchema.index({ uploadId: 1, chunkIndex: 1 }, { unique: true });

const SopUploadChunk: Model<ISopUploadChunk> =
  mongoose.models.SopUploadChunk ||
  mongoose.model<ISopUploadChunk>("SopUploadChunk", SopUploadChunkSchema);

export default SopUploadChunk;
