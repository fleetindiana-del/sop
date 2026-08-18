import { extractLabelIntelligence, type LabelImageInput } from "./extract-label";
import { evaluateLabelCompliance, overallStatus, compareLabelRuns } from "./evaluate-label";
import { geminiApplyFssaiRules } from "./gemini-score";
import { LABEL_FACES } from "./types";
import type {
  ExtractedLabel,
  FaceReadability,
  GapLifecycleStatus,
  LabelAssetMeta,
  LabelFinding,
  LabelPreview,
  LabelScoreBreakdown,
  LabelVersionComparison,
  LabelVersionSnapshot,
  ProductClassification,
  UnreadableRegion,
} from "./types";

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
  "application/pdf",
]);

const PREVIEW_MAX_BYTES = 400_000;

export function isAllowedLabelMime(mime: string): boolean {
  return ALLOWED_MIME.has(mime.toLowerCase());
}

export async function parseLabelUploads(form: FormData): Promise<LabelImageInput[]> {
  const images: LabelImageInput[] = [];
  for (const face of LABEL_FACES) {
    const file = form.get(face);
    if (!file || !(file instanceof File) || file.size === 0) continue;
    const name = file.name.toLowerCase();
    const mimeType =
      file.type ||
      (name.endsWith(".pdf")
        ? "application/pdf"
        : name.endsWith(".heic") || name.endsWith(".heif")
          ? "image/heic"
          : name.endsWith(".png")
            ? "image/png"
            : name.endsWith(".webp")
              ? "image/webp"
              : "image/jpeg");
    if (!isAllowedLabelMime(mimeType)) {
      throw new Error(`Unsupported file type for ${face}: ${mimeType || file.name}`);
    }
    if (file.size > 18 * 1024 * 1024) {
      throw new Error(`${file.name} exceeds 18 MB`);
    }
    images.push({
      face,
      fileName: file.name,
      mimeType,
      buffer: Buffer.from(await file.arrayBuffer()),
    });
  }
  return images;
}

function toPreviews(images: LabelImageInput[]): LabelPreview[] {
  return images
    .filter((img) => img.mimeType.startsWith("image/") && img.buffer.length <= PREVIEW_MAX_BYTES)
    .map((img) => ({
      face: img.face,
      mimeType: img.mimeType,
      dataBase64: img.buffer.toString("base64"),
    }));
}

function assetMeta(images: LabelImageInput[]): LabelAssetMeta[] {
  return images.map((img) => ({
    face: img.face,
    fileName: img.fileName,
    mimeType: img.mimeType,
    sizeBytes: img.buffer.length,
  }));
}

export interface LabelDraftResult {
  productName: string;
  brandName?: string;
  productClassification: ProductClassification;
  classificationConfidence: number;
  classificationReason: string;
  classificationConfirmed: boolean;
  assets: LabelAssetMeta[];
  previews: LabelPreview[];
  extractedLabel: ExtractedLabel;
  unreadableRegions: UnreadableRegion[];
  readability: FaceReadability[];
  findings: LabelFinding[];
  score: LabelScoreBreakdown;
  complianceStatus: "Fully Compliant" | "Partially Compliant" | "Non-Compliant" | "Analysis Failed";
  analysisStatus: "extracted" | "completed";
  analysisEngineVersion: string;
  modelNotes?: string;
  analyzedAt: Date;
  versionNumber: number;
}

const EMPTY_SCORE: LabelScoreBreakdown = {
  totalRules: 0,
  applicableRules: 0,
  passed: 0,
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  review: 0,
  score: 0,
  formula: "",
};

export async function extractLabelDraft(opts: {
  images: LabelImageInput[];
  productNameHint?: string;
  brandHint?: string;
}): Promise<LabelDraftResult> {
  const extraction = await extractLabelIntelligence(opts.images);

  const productName =
    opts.productNameHint ||
    extraction.extracted.productName ||
    extraction.extracted.brandName ||
    opts.images[0]?.fileName.replace(/\.[^.]+$/, "") ||
    "Untitled label";

  if (opts.brandHint && !extraction.extracted.brandName) {
    extraction.extracted.brandName = opts.brandHint;
  }
  if (opts.productNameHint && !extraction.extracted.productName) {
    extraction.extracted.productName = opts.productNameHint;
  }

  return {
    productName,
    brandName: extraction.extracted.brandName || opts.brandHint,
    productClassification: extraction.productClassification,
    classificationConfidence: extraction.classificationConfidence,
    classificationReason: extraction.classificationReason,
    classificationConfirmed: false,
    assets: assetMeta(opts.images),
    previews: toPreviews(opts.images),
    extractedLabel: extraction.extracted,
    unreadableRegions: extraction.unreadableRegions,
    readability: extraction.readability,
    findings: [],
    score: EMPTY_SCORE,
    complianceStatus: "Non-Compliant",
    analysisStatus: "extracted",
    analysisEngineVersion: "label-v1",
    modelNotes: extraction.modelNotes,
    analyzedAt: new Date(),
    versionNumber: 1,
  };
}

export async function scoreLabelDraft(opts: {
  classification: ProductClassification;
  extracted: ExtractedLabel;
  unreadableRegions: UnreadableRegion[];
  previousFindings?: LabelFinding[];
}): Promise<{
  findings: LabelFinding[];
  score: LabelScoreBreakdown;
  complianceStatus: "Fully Compliant" | "Partially Compliant" | "Non-Compliant";
}> {
  const visionFindings = await geminiApplyFssaiRules({
    classification: opts.classification,
    extracted: opts.extracted,
    unreadableRegions: opts.unreadableRegions,
  });

  const { findings, score } = evaluateLabelCompliance({
    classification: opts.classification,
    extracted: opts.extracted,
    visionFindings,
    previousFindings: opts.previousFindings,
    unreadableRegions: opts.unreadableRegions,
  });

  return { findings, score, complianceStatus: overallStatus(score) };
}

export function snapshotFromReport(report: {
  versionNumber?: number;
  score?: { score?: number; passed?: number; critical?: number; high?: number; medium?: number };
  complianceStatus?: string;
  findings?: LabelFinding[];
  analyzedAt?: Date | string;
}): LabelVersionSnapshot {
  const gaps = (report.findings ?? []).filter((f) => f.status !== "pass").length;
  const analyzedAt =
    report.analyzedAt instanceof Date
      ? report.analyzedAt.toISOString()
      : String(report.analyzedAt ?? new Date().toISOString());
  return {
    version: report.versionNumber ?? 1,
    score: report.score?.score ?? 0,
    complianceStatus: report.complianceStatus ?? "",
    gapCount: gaps,
    passed: report.score?.passed ?? 0,
    analyzedAt,
  };
}

export function buildVersionComparison(
  previous: { versionNumber?: number; score?: { score?: number }; findings?: LabelFinding[] },
  next: { versionNumber: number; score: LabelScoreBreakdown; findings: LabelFinding[] },
): LabelVersionComparison {
  return compareLabelRuns(
    previous.findings ?? [],
    next.findings,
    previous.versionNumber ?? 1,
    next.versionNumber,
    previous.score?.score ?? 0,
    next.score.score,
  );
}

const LIFECYCLE_ORDER: GapLifecycleStatus[] = [
  "detected",
  "reviewed",
  "correction-suggested",
  "corrected",
  "re-uploaded",
  "revalidated",
  "closed",
];

export function isGapLifecycle(value: unknown): value is GapLifecycleStatus {
  return typeof value === "string" && (LIFECYCLE_ORDER as string[]).includes(value);
}
