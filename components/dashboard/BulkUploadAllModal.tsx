"use client";

import { useState } from "react";
import { FolderUp } from "lucide-react";
import { useDashboardStore } from "@/lib/store/dashboard-store";
import { appendFilesWithPaths } from "@/lib/upload-form";
import {
  BulkUploadDropZone,
  BulkUploadResults,
  BulkUploadShell,
  HiddenBulkInputs,
  HowItWorksBox,
  sopUploadToastMessage,
  summarizeSopUploadResults,
  useBulkFileSelection,
  type SopUploadResult,
  type UploadProgress,
} from "./BulkUploadShell";
import { PostUploadPipelineModal } from "./PostUploadPipelineModal";

type UploadResult = SopUploadResult;

const BATCH_SIZE = 4;

function isSystemFile(f: File) {
  return f.name.startsWith(".") || f.name.startsWith("~$");
}

function filterAllSopFiles(files: File[]) {
  return files.filter(
    (f) => /\.(pdf|docx)$/i.test(f.name) && !isSystemFile(f),
  );
}

function initialProgress(total: number): UploadProgress {
  return { completed: 0, total };
}

function isNetworkError(error: string | undefined): boolean {
  if (!error) return false;
  const lower = error.toLowerCase();
  return lower.includes("failed to fetch") || lower.includes("network") || lower.includes("load failed");
}

async function uploadBatchOnce(files: File[], language: string, department: string): Promise<UploadResult[]> {
  const formData = new FormData();
  formData.append("language", language);
  if (department.trim()) formData.append("department", department.trim());
  formData.append("generateMcq", "false");
  appendFilesWithPaths(formData, files);

  let res: Response;
  try {
    res = await fetch("/api/sop/bulk-folder-upload", { method: "POST", body: formData });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    return files.map((f) => ({ file: f.name, success: false, error: msg }));
  }

  let data: { results?: UploadResult[]; error?: string };
  try {
    data = await res.json();
  } catch {
    return files.map((f) => ({ file: f.name, success: false, error: `HTTP ${res.status}` }));
  }

  if (!res.ok) {
    return [{ file: "Server", success: false, error: data.error ?? `HTTP ${res.status}` }];
  }
  return data.results ?? [];
}

async function uploadBatchWithRetry(files: File[], language: string, department: string): Promise<UploadResult[]> {
  if (files.length === 1) {
    const [first] = await uploadBatchOnce(files, language, department);
    if (first.success || !isNetworkError(first.error)) return [first];
    return uploadBatchOnce(files, language, department);
  }

  const results = await uploadBatchOnce(files, language, department);
  const allNetworkFailed = results.every((r) => !r.success && isNetworkError(r.error));
  if (!allNetworkFailed) return results;

  const retried: UploadResult[] = [];
  for (const file of files) {
    const [result] = await uploadBatchOnce([file], language, department);
    if (!result.success && isNetworkError(result.error)) {
      const [retry] = await uploadBatchOnce([file], language, department);
      retried.push(retry);
    } else {
      retried.push(result);
    }
  }
  return retried;
}

async function uploadAll(
  files: File[],
  language: string,
  department: string,
  onProgress?: (completed: number, total: number) => void,
): Promise<UploadResult[]> {
  const allResults: UploadResult[] = [];
  const total = files.length;

  for (let start = 0; start < total; start += BATCH_SIZE) {
    const batch = files.slice(start, start + BATCH_SIZE);
    const batchResults = await uploadBatchWithRetry(batch, language, department);
    allResults.push(...batchResults);
    const done = Math.min(start + batch.length, total);
    onProgress?.(done, total);
  }

  return allResults;
}

export function BulkUploadAllModal({
  open,
  onClose,
  onSuccess,
  departmentList = [],
}: {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  departmentList?: string[];
}) {
  const { showToast } = useDashboardStore();
  const { files, addFiles, clearFiles, fileInputRef, folderInputRef, handleFileChange } =
    useBulkFileSelection(filterAllSopFiles);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [results, setResults] = useState<UploadResult[]>([]);
  const [department, setDepartment] = useState("");
  const [uploadLang, setUploadLang] = useState<"English" | "Gujarati">("English");
  const [pipelineIds, setPipelineIds] = useState<string[]>([]);
  const [pipelineOpen, setPipelineOpen] = useState(false);

  const annexureCount = files.filter((f) => /annex(ure)?|appendix/i.test(f.name)).length;
  const mainCount = files.length - annexureCount;

  const reset = () => {
    clearFiles();
    setResults([]);
    setUploadProgress(null);
    setDepartment("");
    setUploadLang("English");
  };

  const handleClose = () => {
    if (uploading) return;
    reset();
    onClose();
  };

  const handleUpload = async () => {
    if (!files.length || uploading) return;
    setUploading(true);
    setResults([]);
    setUploadProgress(initialProgress(files.length));
    try {
      const uploadResults = await uploadAll(
        files,
        uploadLang,
        department,
        (completed, total) => setUploadProgress({ completed, total }),
      );
      setResults(uploadResults);
      const summary = summarizeSopUploadResults(uploadResults);
      if (summary.success > 0) {
        clearFiles();
        showToast(sopUploadToastMessage(summary));
        fetch("/api/admin/reconcile-sop-versions", { method: "POST" }).catch(() => undefined);
        onSuccess();
        const ids = [
          ...new Set(
            uploadResults
              .filter((r) => r.success && r.identifier)
              .map((r) => r.identifier as string),
          ),
        ];
        if (ids.length) {
          setPipelineIds(ids);
          setPipelineOpen(true);
        }
      } else {
        showToast(sopUploadToastMessage(summary));
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  };

  return (
    <BulkUploadShell
      open={open}
      title="Upload All — SOPs + Annexures + PDFs"
      icon={<FolderUp className="h-4 w-4 text-emerald-600" />}
      accent="violet"
      wide
      uploading={uploading}
      uploadProgress={uploadProgress}
      fileCount={files.length}
      uploadLabel="Upload All"
      onClose={handleClose}
      onUpload={handleUpload}
    >
      <HowItWorksBox>
        <p>
          Drop <strong>everything at once</strong> — SOPs (.docx/.pdf), annexures, and PDFs. The
          system processes main SOPs first, then links annexures to their parent automatically.
        </p>
        <p>
          Annexures are detected by filename (containing "Annexure" or "Appendix"). Their parent
          SOP is resolved from the file&apos;s <strong>Ref. SOP No.</strong> header or from the
          folder structure.
        </p>
        <p>
          After upload, you&apos;ll be prompted to start MCQ generation and compliance.
        </p>
      </HowItWorksBox>
      <BulkUploadDropZone
        accent="violet"
        files={files}
        uploading={uploading}
        accept={{
          "application/pdf": [".pdf"],
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
        }}
        primaryLabel="Select files"
        secondaryLabel="Select folder"
        hint="Drag your complete SOP folder here — SOPs, annexures, and PDFs all together"
        tip="Department folders (QA, QC, Store…) are auto-detected. Annexures are linked to their parent SOP automatically."
        fileInputRef={fileInputRef}
        folderInputRef={folderInputRef}
        onFilesAdded={addFiles}
      />
      <HiddenBulkInputs
        accept=".pdf,.docx"
        fileInputRef={fileInputRef}
        folderInputRef={folderInputRef}
        onChange={handleFileChange}
        uploading={uploading}
      />
      {files.length > 0 && (
        <div className="flex items-center gap-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[10px] text-slate-700">
          <span><strong>{mainCount}</strong> SOP/PDF file{mainCount !== 1 ? "s" : ""}</span>
          <span className="text-slate-300">|</span>
          <span><strong>{annexureCount}</strong> annexure{annexureCount !== 1 ? "s" : ""}</span>
          <span className="text-slate-300">|</span>
          <span><strong>{files.length}</strong> total</span>
        </div>
      )}
      <div className="flex gap-3">
        <label className="flex-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Language
          <select
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700 focus:border-violet-400 focus:outline-none"
            value={uploadLang}
            onChange={(e) => setUploadLang(e.target.value as "English" | "Gujarati")}
          >
            <option value="English">English</option>
            <option value="Gujarati">Gujarati</option>
          </select>
        </label>
        <label className="flex-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">
          Department override (optional)
          <select
            className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700 focus:border-violet-400 focus:outline-none"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
          >
            <option value="">Auto-detect from folder / SOP code</option>
            {departmentList.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
      </div>
      <BulkUploadResults results={results} />
      <PostUploadPipelineModal
        open={pipelineOpen}
        identifiers={pipelineIds}
        onClose={() => setPipelineOpen(false)}
      />
    </BulkUploadShell>
  );
}
