import mongoose, { Schema, type Model } from "mongoose";

export interface ISopUploadChunk {
  uploadId: string;
  chunkIndex: number;
  chunkCount: number;
  fileName: string;
  relativePath: string;
  data: Buffer;
  createdAt: Date;
}

const SopUploadChunkSchema = new Schema<ISopUploadChunk>({
  uploadId: { type: String, required: true, index: true },
  chunkIndex: { type: Number, required: true },
  chunkCount: { type: Number, required: true },
  fileName: { type: String, required: true },
  relativePath: { type: String, required: true },
  data: { type: Buffer, required: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 },
});

SopUploadChunkSchema.index({ uploadId: 1, chunkIndex: 1 }, { unique: true });

const SopUploadChunk: Model<ISopUploadChunk> =
  mongoose.models.SopUploadChunk ||
  mongoose.model<ISopUploadChunk>("SopUploadChunk", SopUploadChunkSchema);

export default SopUploadChunk;
