import { generateGeminiVisionJson } from "@/lib/gemini-client";
import { processGuidelinePDF } from "@/lib/ocrProcessor";
import {
  CLASSIFICATION_LABELS,
  PRODUCT_CLASSIFICATIONS,
  type ExtractedLabel,
  type FaceReadability,
  type LabelFace,
  type ProductClassification,
  type UnreadableRegion,
} from "./types";

export interface LabelImageInput {
  face: LabelFace;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

export interface LabelExtractionResult {
  productClassification: ProductClassification;
  classificationConfidence: number;
  classificationReason: string;
  extracted: ExtractedLabel;
  unreadableRegions: UnreadableRegion[];
  readability: FaceReadability[];
  modelNotes?: string;
}

function isClassification(value: unknown): value is ProductClassification {
  return typeof value === "string" && (PRODUCT_CLASSIFICATIONS as readonly string[]).includes(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length ? t : undefined;
}

function asBool(value: unknown): boolean | null | undefined {
  if (value === true || value === false) return value;
  if (value === null) return null;
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter(Boolean);
}

function normalizeExtracted(raw: Partial<ExtractedLabel> | undefined): ExtractedLabel {
  const d = raw?.declarations ?? {};
  return {
    brandName: asString(raw?.brandName),
    productName: asString(raw?.productName),
    categoryStatement: asString(raw?.categoryStatement),
    netQuantity: asString(raw?.netQuantity),
    vegetarianLogo: asBool(raw?.vegetarianLogo),
    fssaiLicenseNumber: asString(raw?.fssaiLicenseNumber),
    fssaiLogoPresent: asBool(raw?.fssaiLogoPresent),
    manufacturer: asString(raw?.manufacturer),
    packer: asString(raw?.packer),
    importer: asString(raw?.importer),
    countryOfOrigin: asString(raw?.countryOfOrigin),
    batchLotNumber: asString(raw?.batchLotNumber),
    mfgDate: asString(raw?.mfgDate),
    expiryDate: asString(raw?.expiryDate),
    bestBefore: asString(raw?.bestBefore),
    ingredientsList: asString(raw?.ingredientsList),
    nutritionalInformation: asString(raw?.nutritionalInformation),
    servingSize: asString(raw?.servingSize),
    recommendedUsage: asString(raw?.recommendedUsage),
    storageInstructions: asString(raw?.storageInstructions),
    allergenDeclaration: asString(raw?.allergenDeclaration),
    customerCare: asString(raw?.customerCare),
    additiveDeclaration: asString(raw?.additiveDeclaration),
    targetGroup: asString(raw?.targetGroup),
    rdaPresent: asBool(raw?.rdaPresent),
    declarations: {
      notForMedicinalUse: asBool(d.notForMedicinalUse),
      notASubstituteForVariedDiet: asBool(d.notASubstituteForVariedDiet),
      notToExceedRecommendedUsage: asBool(d.notToExceedRecommendedUsage),
      keepOutOfReachOfChildren: asBool(d.keepOutOfReachOfChildren),
      notIntendedToDiagnoseTreatCure: asBool(d.notIntendedToDiagnoseTreatCure),
      foodForSpecialDietaryUse: asBool(d.foodForSpecialDietaryUse),
    },
    claims: asStringArray(raw?.claims),
    warnings: asStringArray(raw?.warnings),
    ocrTextByFace: raw?.ocrTextByFace ?? {},
  };
}

function inferClassification(extracted: ExtractedLabel, hint?: string): ProductClassification {
  const blob = `${hint ?? ""} ${extracted.categoryStatement ?? ""} ${extracted.productName ?? ""}`.toLowerCase();
  if (/\bfsmp\b|special medical/.test(blob)) return "fsmp";
  if (/\bfsdu\b|special dietary/.test(blob)) return "fsdu";
  if (/functional food/.test(blob)) return "functional-food";
  if (/novel food/.test(blob)) return "novel-food";
  if (/nutraceutical/.test(blob)) return "nutraceutical";
  if (/health supplement/.test(blob)) return "health-supplement";
  return "unknown";
}

function normalizeUnreadable(raw: unknown): UnreadableRegion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const row = item as UnreadableRegion;
      const face = row.face;
      return {
        face:
          face === "front" || face === "back" || face === "side" || face === "pdf" || face === "unknown"
            ? face
            : "unknown",
        section: String(row.section ?? "").trim() || "Unspecified section",
        reason: String(row.reason ?? "").trim() || "Not readable with confidence",
        suggestedAction:
          String(row.suggestedAction ?? "").trim() || "Upload a clearer, closer photo of this panel.",
      };
    })
    .filter((row) => row.section.length > 0);
}

function normalizeReadability(raw: unknown, faces: LabelFace[]): FaceReadability[] {
  const byFace = new Map<string, FaceReadability>();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const row = item as FaceReadability;
      if (!faces.includes(row.face as LabelFace)) continue;
      const quality = row.quality === "good" || row.quality === "partial" || row.quality === "unreadable"
        ? row.quality
        : "partial";
      byFace.set(row.face, {
        face: row.face as LabelFace,
        quality,
        notes: String(row.notes ?? "").trim(),
      });
    }
  }
  return faces.map((face) => byFace.get(face) ?? { face, quality: "partial", notes: "" });
}

function buildExtractionPrompt(faces: LabelFace[]): string {
  return `You are Gemini acting as a label-intelligence agent for FSSAI nutraceutical / health-supplement artwork in India.

The uploads are real product photos or a PDF. They may be:
- tilted or rotated
- unevenly lit, glossy, or shadowed
- shot on a curved bottle or blister
- slightly blurry, with small print
- multiple panels in one frame, or partially overlapping

How to read:
1. Mentally rotate/upright each panel before reading.
2. Read every panel (faces: ${faces.join(", ")}). Combine information across front + back + side.
3. Prefer text you can see clearly. If a word is guesswork, treat it as unreadable.
4. NEVER invent a license number, date, batch, ingredient, or claim that is not clearly visible.
5. If a section cannot be read with high confidence, add it to unreadableRegions and leave the corresponding extracted field empty/null.

Return JSON only:
{
  "productClassification": "nutraceutical" | "health-supplement" | "fsdu" | "fsmp" | "functional-food" | "novel-food" | "unknown",
  "classificationConfidence": 0-100,
  "classificationReason": "one or two sentences citing visible wording (e.g. HEALTH SUPPLEMENT on front panel)",
  "readability": [{ "face": "front"|"back"|"side"|"pdf", "quality": "good"|"partial"|"unreadable", "notes": "string" }],
  "unreadableRegions": [{ "face": "front"|"back"|"side"|"pdf"|"unknown", "section": "ingredients|warnings|dates|license|nutrition|claims|other", "reason": "blurry|glare|cropped|curved|too small|rotated beyond recovery", "suggestedAction": "what photo to take" }],
  "extracted": {
    "brandName": string,
    "productName": string,
    "categoryStatement": string,
    "netQuantity": string,
    "vegetarianLogo": true | false | null,
    "fssaiLicenseNumber": string,
    "fssaiLogoPresent": true | false | null,
    "manufacturer": string,
    "packer": string,
    "importer": string,
    "countryOfOrigin": string,
    "batchLotNumber": string,
    "mfgDate": string,
    "expiryDate": string,
    "bestBefore": string,
    "ingredientsList": string,
    "nutritionalInformation": string,
    "servingSize": string,
    "recommendedUsage": string,
    "storageInstructions": string,
    "allergenDeclaration": string,
    "customerCare": string,
    "additiveDeclaration": string,
    "targetGroup": string,
    "rdaPresent": true | false | null,
    "declarations": {
      "notForMedicinalUse": true | false | null,
      "notASubstituteForVariedDiet": true | false | null,
      "notToExceedRecommendedUsage": true | false | null,
      "keepOutOfReachOfChildren": true | false | null,
      "notIntendedToDiagnoseTreatCure": true | false | null,
      "foodForSpecialDietaryUse": true | false | null
    },
    "claims": string[],
    "warnings": string[],
    "ocrTextByFace": { "front"?: string, "back"?: string, "side"?: string, "pdf"?: string }
  },
  "modelNotes": string
}

Classification: use the category printed on the pack. If none is printed, infer only from dosage form + claims + composition, and lower confidence. vegetarianLogo: true = green veg mark, false = brown non-veg mark, null = not visible.
rdaPresent: true only if % RDA / % NRV is actually printed.
Put full readable transcription into ocrTextByFace.`;
}

const SYSTEM = `You are Gemini, a careful FSSAI label OCR/vision agent.
Read real-world product photos. Do not guess unreadable text. JSON only.`;

export async function extractLabelIntelligence(
  images: LabelImageInput[],
  classificationHint?: ProductClassification,
): Promise<LabelExtractionResult> {
  if (!images.length) {
    throw new Error("Upload at least one label image or PDF");
  }

  const pdfOcrByFace: Partial<Record<LabelFace, string>> = {};
  for (const img of images) {
    if (img.mimeType === "application/pdf") {
      try {
        const ocr = await processGuidelinePDF(img.buffer);
        if (ocr.text) pdfOcrByFace[img.face] = ocr.text.slice(0, 12_000);
      } catch {
        /* scanned PDFs go through vision */
      }
    }
  }

  const visionImages = images
    .filter((img) => img.buffer.length > 0 && img.buffer.length <= 18 * 1024 * 1024)
    .map((img) => ({
      mimeType:
        img.mimeType.startsWith("image/") || img.mimeType === "application/pdf"
          ? img.mimeType
          : "image/jpeg",
      data: img.buffer.toString("base64"),
    }));

  if (!visionImages.length) {
    throw new Error("Label files are empty or exceed the 18 MB per-file limit");
  }

  const hintLine =
    classificationHint && classificationHint !== "unknown"
      ? `\nUser optional hint (do not trust over printed text): ${CLASSIFICATION_LABELS[classificationHint]}.`
      : "";

  const userText = [
    buildExtractionPrompt(images.map((i) => i.face)),
    hintLine,
    Object.keys(pdfOcrByFace).length
      ? `\nMachine-extracted PDF text (may be incomplete for scanned files):\n${JSON.stringify(pdfOcrByFace)}`
      : "",
  ].join("\n");

  type VisionPayload = {
    productClassification?: string;
    classificationConfidence?: number;
    classificationReason?: string;
    extracted?: Partial<ExtractedLabel>;
    unreadableRegions?: UnreadableRegion[];
    readability?: FaceReadability[];
    modelNotes?: string;
  };

  const payload = await generateGeminiVisionJson<VisionPayload>(SYSTEM, userText, visionImages);
  const extracted = normalizeExtracted(payload.extracted);
  for (const [face, text] of Object.entries(pdfOcrByFace) as [LabelFace, string][]) {
    if (!extracted.ocrTextByFace[face] && text) extracted.ocrTextByFace[face] = text;
  }

  const productClassification = isClassification(payload.productClassification)
    ? payload.productClassification
    : inferClassification(extracted, classificationHint);

  return {
    productClassification,
    classificationConfidence: Math.max(0, Math.min(100, Number(payload.classificationConfidence) || 60)),
    classificationReason:
      asString(payload.classificationReason) ||
      (extracted.categoryStatement
        ? `Printed category: ${extracted.categoryStatement}`
        : "No category statement was clearly readable."),
    extracted,
    unreadableRegions: normalizeUnreadable(payload.unreadableRegions),
    readability: normalizeReadability(payload.readability, images.map((i) => i.face)),
    modelNotes: asString(payload.modelNotes),
  };
}

export interface VisionFinding {
  ruleId?: string;
  status?: string;
  severity?: string;
  evidenceFace?: string;
  evidence?: string;
  claim?: string;
  recommendation?: string;
}
