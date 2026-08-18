import type { SOPFilters } from "@/lib/types";

/**
 * Human-readable description of the currently active dashboard filters.
 *
 * Capsule/card clicks on the dashboard set filters in the store and scroll the
 * user down to the SOP Registry. This turns that filter state back into a
 * breadcrumb so the user can see exactly which capsule they clicked and which
 * dataset is being shown — e.g. department "QA" + filter "DOCX Found" renders
 * as `QA → DOCX Found Results`.
 */
export interface FilterBreadcrumb {
  /** Department label, or "All Departments" when none is selected. */
  department: string;
  /** Selected-dataset labels (usually one, e.g. "Near Expiry"). */
  segments: string[];
  /** Full breadcrumb string, e.g. `QA → DOCX Found Results`. */
  label: string;
}

const FILE_TYPE_LABELS: Record<string, string> = {
  DOCX: "DOCX Found",
  "No DOCX": "DOCX Missing",
  PDF: "PDF Found",
  "No PDF": "PDF Missing",
  "EN DOCX": "English DOCX Found",
  "No EN DOCX": "English DOCX Missing",
  "GJ DOCX": "Gujarati DOCX Found",
  "No GJ DOCX": "Gujarati DOCX Missing",
  "EN PDF": "English PDF Found",
  "No EN PDF": "English PDF Missing",
  "GJ PDF": "Gujarati PDF Found",
  "No GJ PDF": "Gujarati PDF Missing",
  "Needs EN": "Needs English",
  "Needs GJ": "Needs Gujarati",
};

const LANGUAGE_LABELS: Record<string, string> = {
  ENG: "English",
  GUJ: "Gujarati",
  "ENG-GUJ": "Dual Language",
};

const EXPIRY_LABELS: Record<string, string> = {
  Expired: "Expired",
  Near: "Near Expiry",
  Medium: "Medium Expiry",
  Low: "Low Expiry",
  "No Date": "No Expiry Date",
};

const MEDIA_LABELS: Record<string, string> = {
  Video: "Has Video",
  "No Video": "Video Missing",
  Slides: "Has Slides",
  "No Slides": "Slides Missing",
  "No Media": "No Media",
};

const VIDEO_TYPE_LABELS: Record<string, string> = {
  Explainer: "Explainer Video",
  "No Explainer": "Explainer Missing",
  Brief: "Brief Video",
  "No Brief": "Brief Missing",
};

const STATUS_LABELS: Record<string, string> = {
  found: "Found",
  missing: "Missing",
};

function lookup(map: Record<string, string>, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return map[value] ?? value;
}

/** Build the breadcrumb describing what the active filters are showing. */
export function describeFilters(filters: SOPFilters): FilterBreadcrumb {
  const department = filters.department?.trim() || "All Departments";

  const segments: string[] = [];
  const push = (s: string | undefined) => {
    if (s) segments.push(s);
  };

  push(lookup(LANGUAGE_LABELS, filters.language));
  push(lookup(FILE_TYPE_LABELS, filters.fileType));
  push(lookup(EXPIRY_LABELS, filters.expiry));
  if (filters.complianceDone === "Yes") push("Compliance Done");
  if (filters.complianceDone === "No") push("Compliance Not Done");
  if (filters.complianceBypassed === "Yes") push("Bypassed");
  if (filters.complianceBypassed === "No") push("Not Bypassed");
  push(lookup(MEDIA_LABELS, filters.media));
  push(lookup(VIDEO_TYPE_LABELS, filters.videoType));

  if (filters.versionStatus) push(`Versions ${STATUS_LABELS[filters.versionStatus] ?? filters.versionStatus}`);
  if (filters.versionDate) push(`Version Dates ${STATUS_LABELS[filters.versionDate] ?? filters.versionDate}`);
  if (filters.annexureStatus) push(`Annexures ${STATUS_LABELS[filters.annexureStatus] ?? filters.annexureStatus}`);

  if (filters.dualLanguage) push("Dual Language");
  if (filters.absoluteSop) push("Absolute SOP");
  if (filters.obsoleteOnly) push("Obsolete");
  if (filters.archiveView) push("Prior Version Archive");

  if (filters.locations && filters.locations.length > 0) {
    push(filters.locations.length === 1 ? filters.locations[0] : `${filters.locations.length} Locations`);
  }
  if (filters.versions && filters.versions.length > 0) {
    push(filters.versions.length === 1 ? `Version ${filters.versions[0]}` : `${filters.versions.length} Versions`);
  }
  if (filters.dateFrom || filters.dateTo) {
    push(`Date ${filters.dateFrom ?? "…"} – ${filters.dateTo ?? "…"}`);
  }

  const search = filters.search?.trim();
  if (search) push(`Search “${search}”`);

  const detail = segments.length > 0 ? segments.join(" · ") : "All SOPs";
  const label = `${department} → ${detail} Results`;

  return { department, segments, label };
}
