export const PRODUCT_CLASSIFICATIONS = [
  "nutraceutical",
  "health-supplement",
  "fsdu",
  "fsmp",
  "functional-food",
  "novel-food",
  "unknown",
] as const;

export type ProductClassification = (typeof PRODUCT_CLASSIFICATIONS)[number];

export const LABEL_FACES = ["front", "back", "side", "pdf"] as const;
export type LabelFace = (typeof LABEL_FACES)[number];

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type LabelFindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ["fail", "pass", "review"] as const;
export type LabelFindingStatus = (typeof FINDING_STATUSES)[number];

/** Detected → Reviewed → Correction Suggested → Corrected → Re-uploaded → Revalidated → Closed */
export const GAP_LIFECYCLE = [
  "detected",
  "reviewed",
  "correction-suggested",
  "corrected",
  "re-uploaded",
  "revalidated",
  "closed",
] as const;
export type GapLifecycleStatus = (typeof GAP_LIFECYCLE)[number];

export interface LabelDeclarations {
  notForMedicinalUse?: boolean | null;
  notASubstituteForVariedDiet?: boolean | null;
  notToExceedRecommendedUsage?: boolean | null;
  keepOutOfReachOfChildren?: boolean | null;
  notIntendedToDiagnoseTreatCure?: boolean | null;
  foodForSpecialDietaryUse?: boolean | null;
}

export interface ExtractedLabel {
  brandName?: string;
  productName?: string;
  categoryStatement?: string;
  netQuantity?: string;
  vegetarianLogo?: boolean | null;
  fssaiLicenseNumber?: string;
  fssaiLogoPresent?: boolean | null;
  manufacturer?: string;
  packer?: string;
  importer?: string;
  countryOfOrigin?: string;
  batchLotNumber?: string;
  mfgDate?: string;
  expiryDate?: string;
  bestBefore?: string;
  ingredientsList?: string;
  nutritionalInformation?: string;
  servingSize?: string;
  recommendedUsage?: string;
  storageInstructions?: string;
  allergenDeclaration?: string;
  customerCare?: string;
  additiveDeclaration?: string;
  targetGroup?: string;
  /** True when % RDA is shown for vitamins/minerals. */
  rdaPresent?: boolean | null;
  declarations: LabelDeclarations;
  claims: string[];
  warnings: string[];
  ocrTextByFace: Partial<Record<LabelFace, string>>;
}

export interface UnreadableRegion {
  face: LabelFace | "unknown";
  section: string;
  reason: string;
  suggestedAction: string;
}

export interface FaceReadability {
  face: LabelFace;
  quality: "good" | "partial" | "unreadable";
  notes: string;
}

export interface LabelPreview {
  face: LabelFace;
  mimeType: string;
  dataBase64: string;
}

export interface LabelVersionSnapshot {
  version: number;
  score: number;
  complianceStatus: string;
  gapCount: number;
  passed: number;
  analyzedAt: string;
}

export interface LabelVersionComparison {
  fromVersion: number;
  toVersion: number;
  fromScore: number;
  toScore: number;
  resolved: number;
  remaining: number;
  newFindings: number;
  resolvedTitles: string[];
  remainingTitles: string[];
  newTitles: string[];
}

export interface LabelAssetMeta {
  face: LabelFace;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface FssaiRule {
  id: string;
  title: string;
  regulation: string;
  category: "mandatory-declaration" | "identity" | "nutrition" | "claim" | "warning" | "traceability";
  severity: LabelFindingSeverity;
  appliesTo: ProductClassification[] | "all";
  /** Short check the vision model / deterministic engine should apply. */
  check: string;
  recommendation: string;
  /** Optional key on ExtractedLabel used for a deterministic presence check. */
  field?: keyof ExtractedLabel | `declarations.${keyof LabelDeclarations}`;
}

export interface LabelFinding {
  findingId: string;
  ruleId: string;
  title: string;
  regulation: string;
  severity: LabelFindingSeverity;
  status: LabelFindingStatus;
  evidenceFace?: LabelFace | "unknown";
  evidence: string;
  claim?: string;
  recommendation: string;
  lifecycle: GapLifecycleStatus;
  source: "rule-engine" | "vision" | "merged";
}

export interface LabelScoreBreakdown {
  totalRules: number;
  applicableRules: number;
  passed: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  review: number;
  score: number;
  formula: string;
}

export const CLASSIFICATION_LABELS: Record<ProductClassification, string> = {
  nutraceutical: "Nutraceutical",
  "health-supplement": "Health Supplement",
  fsdu: "Food for Special Dietary Use",
  fsmp: "Food for Special Medical Purpose",
  "functional-food": "Functional Food",
  "novel-food": "Novel Food",
  unknown: "Unclassified",
};
