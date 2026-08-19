import type { Aggregate, PipelineStage } from "mongoose";

export type LatestMatrixUpload = {
  department: string;
  year?: number;
  uploadedAt?: Date;
  fileUrl?: string;
  fileName?: string;
  snapshot?: unknown;
};

type UploadModel = {
  aggregate: <T>(pipeline: PipelineStage[]) => Aggregate<T[]>;
  find: (filter: object) => {
    select: (fields: string) => {
      lean: () => Promise<LatestMatrixUpload[]>;
    };
  };
};

/**
 * Newest upload per department, without sorting/grouping the Excel snapshot
 * blobs. A $sort+$group on full snapshots exceeded Atlas M0's 32MB sort limit
 * and hit the 45s socket timeout (500 on /api/lms/auth/me and trainer/monthly).
 *
 * Step 1: match + tiny projection (department, uploadedAt) then pick latest ids.
 * Step 2: fetch only those few documents with their snapshots.
 */
export async function findLatestUploadsByDepartment(
  model: UploadModel,
  match: Record<string, unknown>,
): Promise<LatestMatrixUpload[]> {
  const latestIds = await model.aggregate<{ id: unknown }>([
    { $match: match },
    { $project: { department: 1, uploadedAt: 1 } },
    { $sort: { uploadedAt: -1 } },
    {
      $group: {
        _id: "$department",
        id: { $first: "$_id" },
      },
    },
  ]);

  const ids = latestIds.map((row) => row.id).filter(Boolean);
  if (ids.length === 0) return [];

  return model
    .find({ _id: { $in: ids } })
    .select("department year uploadedAt fileUrl fileName snapshot")
    .lean();
}
