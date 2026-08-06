export type ExpiryTier = "expired" | "high" | "medium" | "low" | "none";

export type LanguageCode = "ENG" | "GUJ" | "ENG-GUJ";

export interface FileLinks {
  en?: string;
  gu?: string;
}

export interface MediaFileLinks {
  en?: string[];
  gu?: string[];
}

export interface RegistrySOP {
  id: string;
  recordIds: string[];
  identifier: string;
  name: string;
  nameGujarati?: string;
  version: string;
  department: string;
  location?: string;
  language: LanguageCode;
  guidelineReference?: string;
  expiryDate?: string;
  effectiveDate?: string;
  uploadedAt: string;
  complianceStatus: string;
  complianceScore: number;
  pipelineStatus: string;
  isObsolete: boolean;
  isNew: boolean;
  files: {
    docx: FileLinks;
    pdf: FileLinks;
    docxDateError?: { en?: boolean; gu?: boolean };
  };
  annexures: { label: string; filePath: string; fileName?: string }[];
  /** Roman annexure labels required in the SOP ANNEXURES section (e.g. I, II, III). */
  requiredAnnexures?: string[];
  /** Which docx/pdf record slots exist on the current version (not whether fileUrl is set). */
  fileSlots: {
    docx: { en: boolean; gu: boolean };
    pdf: { en: boolean; gu: boolean };
  };
  media: {
    videos: { en: number; gu: number };
    slides: { en: number; gu: number };
  };
  mediaUrls: {
    videos: MediaFileLinks;
    slides: MediaFileLinks;
  };
  videoFileNames: string[];
  /** The two revisions immediately preceding the current one — kept in the active registry. */
  priorVersions: PriorVersion[];
  /** Superseded revisions older than the kept window — surfaced in the Prior Version Archive,
   *  never deleted. Files and metadata are preserved on these records. */
  archivedVersions: PriorVersion[];
  hasVersion: boolean;
  /** All required prior-version DOCX header dates in the registry window are valid. */
  hasVersionDate: boolean;
  hasVersionDateEn: boolean;
  hasVersionDateGu: boolean;
  expiryTier: ExpiryTier;
  mcqCount: number;
}

export interface PriorVersion {
  version: string;
  language: string;
  docx?: string;
  pdf?: string;
  /** True when this version is expected (below the current version) but was never uploaded. */
  missing?: boolean;
  /** DOCX header dates (EFF. DATE / REVIEW DT.) are missing, empty, invalid, or illogical. */
  docxDateError?: boolean;
}

export interface EditSOPFormData {
  identifier: string;
  recordIds: string[];
  name: string;
  nameGujarati?: string;
  department: string;
  location?: string;
  version: string;
  language: LanguageCode;
  owner?: string;
  effectiveDate?: string;
  expiryDate?: string;
  reviewDate?: string;
  processArea?: string;
  guidelineReference?: string;
  remarks?: string;
  files: {
    docx: FileLinks;
    pdf: FileLinks;
  };
  videos: MediaFileLinks;
  slides: MediaFileLinks;
  thumbnail?: string;
}

export interface EditSOPPayload {
  name: string;
  nameGujarati?: string;
  department: string;
  location?: string;
  identifier: string;
  version: string;
  owner?: string;
  effectiveDate?: string | null;
  expiryDate?: string | null;
  reviewDate?: string | null;
  processArea?: string;
  guidelineReference?: string;
  remarks?: string;
  files: {
    docx: FileLinks;
    pdf: FileLinks;
  };
  videos: MediaFileLinks;
  slides: MediaFileLinks;
  thumbnail?: string;
}

export interface DepartmentCapsule {
  department: string;
  total: number;
  dualLanguage: number;
  withEn: number;
  withGu: number;
  expired: number;
  nearExpiry: number;
  active: number;
  noDate: number;
  docx: { found: number; missing: number; en: { found: number; missing: number }; gu: { found: number; missing: number } };
  pdf: { found: number; missing: number; en: { found: number; missing: number }; gu: { found: number; missing: number } };
  version: {
    found: number;
    missing: number;
    docx: { en: { found: number; missing: number }; gu: { found: number; missing: number } };
    pdf: { en: { found: number; missing: number }; gu: { found: number; missing: number } };
  };
  versionDate: {
    found: number;
    missing: number;
    en: { found: number; missing: number };
    gu: { found: number; missing: number };
  };
  annexures: { found: number; missing: number };
  videos: {
    available: number;
    required: number;
    missing: number;
    en: { available: number; missing: number };
    gu: { available: number; missing: number };
  };
  explainerVideos: { found: number; missing: number };
  briefVideos: { found: number; missing: number };
  slides: {
    available: number;
    required: number;
    missing: number;
    en: { available: number; missing: number };
    gu: { available: number; missing: number };
  };
}

export interface DashboardStats {
  totalSops: number;
  expired: number;
  nearExpiry: number;
  mediumExpiry: number;
  lowExpiry: number;
  noDate: number;
  videosUploaded: number;
  slidesUploaded: number;
  guidelinesTotal: number;
  guidelinesAnalyzed: number;
  departments: DepartmentCapsule[];
  priorVersionCount: number;
  /** Number of active SOP families with superseded revisions in the Prior Version Archive. */
  archivedVersionCount: number;
}

export interface SOPFilters {
  search?: string;
  searchField?: string;
  department?: string;
  language?: string;
  fileType?: string;
  media?: string;
  videoType?: string;
  expiry?: string;
  versionStatus?: string;
  versionDate?: string;
  annexureStatus?: string;
  dualLanguage?: boolean;
  absoluteSop?: boolean;
  obsoleteOnly?: boolean;
  /** Show the Prior Version Archive view: families with superseded (older than the kept window) revisions. */
  archiveView?: boolean;
  dateFrom?: string;
  dateTo?: string;
  locations?: string[];
  versions?: string[];
  sortBy?: string;
  sortDir?: "asc" | "desc";
  page?: number;
  limit?: number;
}

export interface PipelineJob {
  id: string;
  identifier: string;
  language: string;
  stage: "mcq_generating" | "similarity_checking" | "compliance_fixing" | "updating_platform";
  status: "pending" | "running" | "done" | "failed";
  progress: number;
  error?: string;
  startedAt: number;
}
