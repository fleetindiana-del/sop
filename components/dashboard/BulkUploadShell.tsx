"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useDropzone } from "react-dropzone";
import { Files, Folder, Loader2, Upload, X } from "lucide-react";

export type BulkAccent = "violet" | "red" | "sky" | "orange";

export type UploadProgress = {
  completed: number;
  total: number;
};

const accentStyles: Record<
  BulkAccent,
  {
    iconBg: string;
    iconText: string;
    dropActive: string;
    dropHover: string;
    primaryBtn: string;
    countText: string;
    uploadBtn: string;
    progressBar: string;
  }
> = {
  violet: {
    iconBg: "bg-violet-100",
    iconText: "text-violet-600",
    dropActive: "border-violet-400 bg-violet-50",
    dropHover: "hover:border-violet-300",
    primaryBtn: "bg-violet-600 text-white hover:bg-violet-700",
    countText: "text-violet-600",
    uploadBtn: "bg-violet-600 hover:bg-violet-700",
    progressBar: "bg-violet-600",
  },
  red: {
    iconBg: "bg-red-100",
    iconText: "text-red-600",
    dropActive: "border-red-400 bg-red-50",
    dropHover: "hover:border-red-300",
    primaryBtn: "bg-red-600 text-white hover:bg-red-700",
    countText: "text-red-600",
    uploadBtn: "bg-red-500 hover:bg-red-600",
    progressBar: "bg-red-500",
  },
  sky: {
    iconBg: "bg-sky-100",
    iconText: "text-sky-600",
    dropActive: "border-sky-400 bg-sky-50",
    dropHover: "hover:border-sky-300",
    primaryBtn: "bg-sky-600 text-white hover:bg-sky-700",
    countText: "text-sky-600",
    uploadBtn: "bg-sky-600 hover:bg-sky-700",
    progressBar: "bg-sky-600",
  },
  orange: {
    iconBg: "bg-orange-100",
    iconText: "text-orange-600",
    dropActive: "border-orange-400 bg-orange-50",
    dropHover: "hover:border-orange-300",
    primaryBtn: "bg-orange-500 text-white hover:bg-orange-600",
    countText: "text-orange-600",
    uploadBtn: "bg-orange-500 hover:bg-orange-600",
    progressBar: "bg-orange-500",
  },
};

export function BulkUploadProgressBar({
  accent,
  progress,
  indeterminate,
  label,
}: {
  accent: BulkAccent;
  progress?: UploadProgress | null;
  indeterminate?: boolean;
  label?: string;
}) {
  const styles = accentStyles[accent];
  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
      : 0;
  const statusLabel =
    label ??
    (indeterminate
      ? "Processing…"
      : progress
        ? `${progress.completed} of ${progress.total} files (${pct}%)`
        : "Uploading…");

  return (
    <div className="space-y-1.5" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-2 text-[10px] font-medium text-slate-600">
        <span>{statusLabel}</span>
        {!indeterminate && progress ? (
          <span className="tabular-nums text-slate-500">{pct}%</span>
        ) : null}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-200">
        {indeterminate ? (
          <div
            className={`h-full w-1/3 rounded-full ${styles.progressBar} animate-[upload-indeterminate_1.4s_ease-in-out_infinite]`}
          />
        ) : (
          <div
            className={`h-full rounded-full transition-all duration-300 ease-out ${styles.progressBar}`}
            style={{ width: `${Math.max(pct, progress ? 2 : 0)}%` }}
          />
        )}
      </div>
    </div>
  );
}

export function HowItWorksBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2.5 text-[11px] leading-relaxed text-sky-900">
      <p className="mb-1.5 font-bold text-sky-800">How it works:</p>
      <div className="space-y-1 text-sky-900/90">{children}</div>
    </div>
  );
}

export function ExpectedStructureBox() {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      <p className="mb-2 text-[11px] font-bold text-slate-700">Expected structure</p>
      <div className="space-y-2 font-mono text-[9px] leading-relaxed text-slate-600">
        <pre className="whitespace-pre-wrap">{`DeptFolder/QA/                    ← department keyword
  QAGE01-10 - Title/              ← SOP number + name
    V8/  V9/  V10/                ← version subfolders
      *.docx  *.pdf`}</pre>
        <pre className="whitespace-pre-wrap">{`QAGE01-08/  QAGE01-09/            ← version-as-folder`}</pre>
        <pre className="whitespace-pre-wrap">{`QC/QCGE - General/
  QCGE04 - Title/
    Annexure-I.docx  Reference/*.pdf`}</pre>
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
        The first path segment is used for department keywords (QA, QC, Microbiology, Store,
        etc.). SOP number, title, and version (e.g. V8) are detected from folder names. Prior
        revisions are kept by default. Files are stored in Bunny and processed in batches.
        Annexures are linked to their parent SOP. Only <strong>.docx</strong> is checked for EFF. DATE /
        REVIEW DT.; invalid DOCX files are skipped in red and do not block other files in the batch.
        After upload, prior versions are re-scanned and dashboard counts refresh.
      </p>
    </div>
  );
}

export type SopUploadResult = {
  file: string;
  success: boolean;
  error?: string;
  identifier?: string;
  id?: string;
  headerDateError?: boolean;
  headerDateErrors?: string[];
};

export function summarizeSopUploadResults(results: SopUploadResult[]) {
  const success = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success);
  const headerDateFailed = failed.filter((r) => r.headerDateError);
  return {
    total: results.length,
    success,
    failed: failed.length,
    headerDateFailed: headerDateFailed.length,
  };
}

export function sopUploadToastMessage(summary: ReturnType<typeof summarizeSopUploadResults>) {
  if (summary.success === 0) {
    if (summary.headerDateFailed > 0) {
      return `All ${summary.total} file(s) rejected — fix EFF. DATE / REVIEW DT. in the page header`;
    }
    return `All ${summary.total} file(s) failed — see details below`;
  }
  if (summary.failed === 0) {
    return `Uploaded ${summary.success} file(s) — dashboard updated`;
  }
  if (summary.headerDateFailed > 0) {
    return `Uploaded ${summary.success} of ${summary.total} — ${summary.headerDateFailed} DOCX rejected (header dates invalid). Others saved.`;
  }
  return `Uploaded ${summary.success} of ${summary.total} — ${summary.failed} failed. See red items below.`;
}

export function BulkUploadResults({
  results,
}: {
  results: SopUploadResult[];
}) {
  if (!results.length) return null;
  const summary = summarizeSopUploadResults(results);
  return (
    <div className="space-y-2">
      {summary.failed > 0 ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[10px] font-medium leading-snug text-red-800">
          {summary.success} file{summary.success === 1 ? "" : "s"} uploaded,{" "}
          <span className="font-bold">{summary.failed} skipped</span>
          {summary.headerDateFailed > 0
            ? ` (${summary.headerDateFailed} with invalid EFF. DATE / REVIEW DT.)`
            : null}
          . Valid files were not blocked.
        </p>
      ) : null}
      <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-slate-200 p-2">
        {results.map((r, i) => (
          <div
            key={`${r.file}-${i}`}
            className={`rounded px-2 py-1.5 text-[10px] ${
              r.success ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"
            }`}
          >
            <div className="flex min-w-0 items-start gap-1.5">
              <span className="shrink-0 font-bold">{r.success ? "✓" : "✗"}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className={`font-semibold ${r.success ? "" : "text-red-700"}`}>
                    {r.file}
                  </span>
                  {!r.success && r.headerDateError ? (
                    <span className="rounded bg-red-200/80 px-1 py-px text-[8px] font-bold uppercase tracking-wide text-red-900">
                      Header dates
                    </span>
                  ) : null}
                </div>
                {!r.success && r.error ? (
                  <p className="mt-0.5 text-[9px] font-medium leading-snug text-red-600">
                    {r.error}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function useBulkFileSelection(filterFiles: (files: File[]) => File[]) {
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (incoming: File[]) => {
      const filtered = filterFiles(incoming);
      if (filtered.length) setFiles((prev) => [...prev, ...filtered]);
    },
    [filterFiles],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(e.target.files ?? []));
      e.target.value = "";
    },
    [addFiles],
  );

  const clearFiles = useCallback(() => setFiles([]), []);

  return { files, setFiles, addFiles, clearFiles, fileInputRef, folderInputRef, handleFileChange };
}

export function BulkUploadDropZone({
  accent,
  files,
  uploading,
  accept,
  primaryLabel,
  secondaryLabel,
  hint,
  tip,
  fileInputRef,
  folderInputRef,
  onFilesAdded,
  showFolderButton = true,
}: {
  accent: BulkAccent;
  files: File[];
  uploading: boolean;
  accept: Record<string, string[]>;
  primaryLabel: string;
  secondaryLabel?: string;
  hint: string;
  tip?: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  onFilesAdded: (files: File[]) => void;
  showFolderButton?: boolean;
}) {
  const styles = accentStyles[accent];

  const onDrop = useCallback(
    (accepted: File[]) => onFilesAdded(accepted),
    [onFilesAdded],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    multiple: true,
    noClick: true,
    disabled: uploading,
    accept,
  });

  return (
    <div
      {...getRootProps()}
      className={`rounded-xl border-2 border-dashed py-8 text-center transition-colors ${
        isDragActive ? styles.dropActive : `border-slate-200 bg-slate-50 ${styles.dropHover}`
      } ${uploading ? "pointer-events-none opacity-60" : ""}`}
    >
      <input {...getInputProps()} />
      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white shadow-sm">
        <Upload className={`h-5 w-5 ${styles.iconText}`} />
      </div>
      <p className="mb-3 px-4 text-xs text-slate-500">{hint}</p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-semibold ${styles.primaryBtn}`}
        >
          <Files className="h-3.5 w-3.5" /> {primaryLabel}
        </button>
        {showFolderButton && secondaryLabel ? (
          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-1.5 text-xs font-semibold text-slate-600 hover:border-slate-400"
          >
            <Folder className="h-3.5 w-3.5" /> {secondaryLabel}
          </button>
        ) : null}
      </div>
      {files.length > 0 ? (
        <p className={`mt-2.5 text-[11px] font-semibold ${styles.countText}`}>
          {files.length} file(s) ready
        </p>
      ) : null}
      {tip ? (
        <p className="mt-3 px-8 text-[10px] italic text-slate-400">{tip}</p>
      ) : null}
    </div>
  );
}

export function BulkUploadShell({
  open,
  title,
  icon,
  accent = "violet",
  wide,
  uploading,
  uploadProgress,
  progressIndeterminate,
  progressLabel,
  fileCount,
  uploadLabel,
  disableUpload,
  hideCount,
  onClose,
  onUpload,
  footerLeft,
  children,
}: {
  open: boolean;
  title: string;
  icon: ReactNode;
  accent?: BulkAccent;
  wide?: boolean;
  uploading: boolean;
  uploadProgress?: UploadProgress | null;
  progressIndeterminate?: boolean;
  progressLabel?: string;
  fileCount: number;
  uploadLabel: string;
  disableUpload?: boolean;
  hideCount?: boolean;
  onClose: () => void;
  onUpload: () => void;
  footerLeft?: ReactNode;
  children: ReactNode;
}) {
  const styles = accentStyles[accent];
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-xl bg-white shadow-2xl ${
          wide ? "max-w-2xl" : "max-w-lg"
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-lg ${styles.iconBg}`}
            >
              {icon}
            </div>
            <h2 className="text-sm font-bold text-slate-800">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={uploading}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">{children}</div>

        {uploading ? (
          <div className="shrink-0 border-t border-slate-100 px-5 py-3">
            <BulkUploadProgressBar
              accent={accent}
              progress={uploadProgress}
              indeterminate={progressIndeterminate}
              label={progressLabel}
            />
          </div>
        ) : null}

        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-slate-100 px-5 py-3">
          <div>{footerLeft}</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={uploading}
              className="rounded-lg border border-slate-300 px-4 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onUpload}
              disabled={disableUpload ?? (!fileCount || uploading)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-1.5 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${styles.uploadBtn}`}
            >
              {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {uploading
                ? "Uploading…"
                : hideCount
                  ? uploadLabel
                  : `${uploadLabel} (${fileCount})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function HiddenBulkInputs({
  accept,
  fileInputRef,
  folderInputRef,
  onChange,
  uploading,
  showFolder = true,
}: {
  accept: string;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  folderInputRef: React.RefObject<HTMLInputElement | null>;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  uploading: boolean;
  showFolder?: boolean;
}) {
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        onChange={onChange}
        disabled={uploading}
      />
      {showFolder ? (
        <input
          ref={folderInputRef}
          type="file"
          // @ts-expect-error webkitdirectory not in React type defs
          webkitdirectory=""
          multiple
          className="hidden"
          onChange={onChange}
          disabled={uploading}
        />
      ) : null}
    </>
  );
}
