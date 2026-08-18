import * as XLSX from "xlsx";
import type { RegistrySOP, SOPFilters } from "@/lib/types";
import { describeFilters } from "@/lib/filter-breadcrumb";

/**
 * Excel export for SOP registry records.
 *
 * The dashboard filters the full registry client-side (capsule/pill/card clicks
 * set the active filter, e.g. "DOCX Missing"). This takes whatever set the user
 * is currently viewing — already filtered and searched — and writes a formatted
 * .xlsx file so missing-data records can be reviewed and completed offline.
 *
 * The per-row "Missing Items" column is computed from each record (not just the
 * active filter) so a single export still shows everything that needs filling
 * in for each SOP.
 */

/** Which languages a record is expected to have files/dates for. */
function expectedLangs(language: RegistrySOP["language"]): { en: boolean; gu: boolean } {
  return {
    en: language === "ENG" || language === "ENG-GUJ",
    gu: language === "GUJ" || language === "ENG-GUJ",
  };
}

/** "Present" / "Missing" / "N/A" for a file slot, given language applicability. */
function fileState(applicable: boolean, path: string | undefined): string {
  if (!applicable) return "N/A";
  return path ? "Present" : "Missing";
}

/** Human-readable expiry status, e.g. "Expired (42 days ago)" or "318 days left". */
function expiryStatus(expiryDate: string | undefined): string {
  if (!expiryDate) return "No Date";
  const diffDays = Math.floor((new Date(expiryDate).getTime() - Date.now()) / 86400000);
  if (Number.isNaN(diffDays)) return "No Date";
  if (diffDays < 0) return `Expired (${Math.abs(diffDays)} days ago)`;
  if (diffDays === 0) return "Expires today";
  return `${diffDays} days left`;
}

function formatDate(value: string | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/** The list of things actually missing for one SOP, as a readable string. */
function missingItems(sop: RegistrySOP): string {
  const need = expectedLangs(sop.language);
  const missing: string[] = [];

  if (need.en && !sop.files.docx.en) missing.push("DOCX (ENG)");
  if (need.gu && !sop.files.docx.gu) missing.push("DOCX (GUJ)");
  if (need.en && !sop.files.pdf.en) missing.push("PDF (ENG)");
  if (need.gu && !sop.files.pdf.gu) missing.push("PDF (GUJ)");
  if (!sop.hasVersion) missing.push("Version No.");
  if (need.en && !sop.hasVersionDateEn) missing.push("Prior Header Dates (ENG)");
  if (need.gu && !sop.hasVersionDateGu) missing.push("Prior Header Dates (GUJ)");
  if (sop.media.videos.en + sop.media.videos.gu === 0) missing.push("Training Video");
  if (sop.media.slides.en + sop.media.slides.gu === 0) missing.push("Slides");
  if (!sop.expiryDate) missing.push("Expiry Date");

  return missing.join(", ") || "—";
}

/** Short summary of prior versions for one SOP. */
function priorVersionsSummary(sop: RegistrySOP): string {
  if (sop.priorVersions.length === 0) return "—";
  return sop.priorVersions
    .map((pv) => {
      if (pv.missing) return `V${pv.version} (not uploaded)`;
      const parts: string[] = [];
      if (pv.docx) parts.push("DOCX");
      if (pv.pdf) parts.push("PDF");
      const tag = pv.language ? `${pv.language} ` : "";
      return `${tag}V${pv.version}${parts.length ? ` [${parts.join("/")}]` : ""}`;
    })
    .join("; ");
}

const HEADERS = [
  "SR",
  "SOP Code",
  "SOP Name",
  "SOP Name (Gujarati)",
  "Department",
  "Location",
  "Language",
  "Current Version",
  "Missing Items",
  "DOCX (ENG)",
  "DOCX (GUJ)",
  "PDF (ENG)",
  "PDF (GUJ)",
  "Version No.",
  "Version Date",
  "Videos",
  "Slides",
  "Expiry Date",
  "Expiry Status",
  "Effective Date",
  "Guideline Ref.",
  "Uploaded",
  "Compliance Done",
  "Score",
  "Bypassed",
  "Prior Versions",
] as const;

/** Column widths (in characters) matched to the headers above. */
const COL_WIDTHS = [
  4, 14, 36, 30, 16, 18, 10, 9, 28, 11, 11, 11, 11, 11, 22, 7, 7, 14, 18, 14, 16, 14, 16, 8, 10, 30,
];

function buildRow(sop: RegistrySOP, sr: number): (string | number)[] {
  const need = expectedLangs(sop.language);
  const langLabel =
    sop.language === "ENG-GUJ" ? "English & Gujarati" : sop.language === "GUJ" ? "Gujarati" : "English";
  const videoCount = sop.media.videos.en + sop.media.videos.gu;
  const slideCount = sop.media.slides.en + sop.media.slides.gu;

  return [
    sr,
    sop.identifier,
    sop.name,
    sop.nameGujarati ?? "",
    sop.department,
    sop.location ?? "",
    langLabel,
    sop.version || "",
    missingItems(sop),
    fileState(need.en, sop.files.docx.en),
    fileState(need.gu, sop.files.docx.gu),
    fileState(need.en, sop.files.pdf.en),
    fileState(need.gu, sop.files.pdf.gu),
    sop.hasVersion ? "Present" : "Missing",
    sop.hasVersionDate ? "Present" : "Missing",
    videoCount,
    slideCount,
    formatDate(sop.expiryDate),
    expiryStatus(sop.expiryDate),
    formatDate(sop.effectiveDate),
    sop.guidelineReference ?? "",
    formatDate(sop.uploadedAt),
    sop.complianceDone ? "Yes" : "No",
    sop.complianceAnalyzed ? `${Math.round(sop.complianceScore * 10)}%` : "—",
    sop.complianceBypassed ? "Yes" : "No",
    priorVersionsSummary(sop),
  ];
}

/** Sanitize a string into a safe sheet name / filename slug. */
function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "All-SOPs";
}

/**
 * Build and download an .xlsx export of the given (already-filtered) SOP records.
 * The active filters are used only to label the file, sheet, and title row — the
 * `sops` array is the source of truth for what gets exported.
 */
export function exportSopsToExcel(sops: RegistrySOP[], filters: SOPFilters): void {
  const breadcrumb = describeFilters(filters);
  const contextLabel = breadcrumb.segments.length > 0 ? breadcrumb.segments.join(" · ") : "All SOPs";
  const today = new Date().toISOString().slice(0, 10);

  // A title row gives the exported sheet context at a glance.
  const titleRow = [`SOP Export — ${breadcrumb.department} → ${contextLabel} (${sops.length} records, ${today})`];

  const dataRows = sops.map((sop, i) => buildRow(sop, i + 1));
  const ws = XLSX.utils.aoa_to_sheet([titleRow, [...HEADERS], ...dataRows]);

  ws["!cols"] = COL_WIDTHS.map((wch) => ({ wch }));
  // Merge the title row across all columns.
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: HEADERS.length - 1 } }];

  const wb = XLSX.utils.book_new();
  const sheetName = slug(contextLabel).slice(0, 31) || "SOP Export";
  XLSX.utils.book_append_sheet(wb, ws, sheetName);

  const deptPart = filters.department ? `_${slug(filters.department)}` : "";
  const filename = `SOP-Export_${slug(contextLabel)}${deptPart}_${today}.xlsx`;
  XLSX.writeFile(wb, filename);
}
