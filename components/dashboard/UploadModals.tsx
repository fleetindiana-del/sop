"use client";

import { useCallback, useState } from "react";
import { useDropzone } from "react-dropzone";
import { Upload } from "lucide-react";
import { useDashboardStore } from "@/lib/store/dashboard-store";
import { uploadSopFiles } from "@/lib/client-sop-upload";
import { BulkUploadProgressBar, BulkUploadResults, sopUploadToastMessage, summarizeSopUploadResults, type SopUploadResult, type UploadProgress } from "./BulkUploadShell";
import { Btn, Modal } from "./ui";
import { PostUploadPipelineModal } from "./PostUploadPipelineModal";


const DEPARTMENTS = [
  "QA",
  "QC",
  "Microbiology",
  "Production",
  "Store",
  "Engineering and Maintenance",
  "Personnel",
];

interface UploadSOPModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  departmentList: string[];
}

export function UploadSOPModal({
  open,
  onClose,
  onSuccess,
  departmentList,
}: UploadSOPModalProps) {
  const [language, setLanguage] = useState<"English" | "Gujarati">("English");
  const [department, setDepartment] = useState("QA");
  const [identifier, setIdentifier] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("1.0");
  const [location, setLocation] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [results, setResults] = useState<SopUploadResult[]>([]);
  const [pipelineIds, setPipelineIds] = useState<string[]>([]);
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const { showToast } = useDashboardStore();

  const allDepts = [...new Set([...DEPARTMENTS, ...departmentList])];

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!acceptedFiles.length) return;
      setUploading(true);
      setUploadProgress({ completed: 0, total: acceptedFiles.length });
      setResults([]);

      try {
        const allResults = await uploadSopFiles(acceptedFiles, {
          language,
          department,
          version,
          identifier: identifier || undefined,
          name: name || undefined,
          location: location || undefined,
          generateMcq: false,
          endpoint: "/api/sop/upload-batch",
          onProgress: (completed, total) => setUploadProgress({ completed, total }),
        });

        setResults(allResults);

        const summary = summarizeSopUploadResults(allResults);
        if (summary.success > 0) {
          showToast(sopUploadToastMessage(summary));
          onSuccess();
          const ids = [
            ...new Set(
              allResults
                .filter((r) => r.success && r.identifier)
                .map((r) => r.identifier as string),
            ),
          ];
          if (ids.length) {
            setPipelineIds(ids);
            setPipelineOpen(true);
          }
        } else if (allResults.length > 0) {
          showToast(sopUploadToastMessage(summary));
        }
      } catch (err) {
        setResults([
          {
            file: "Upload",
            success: false,
            error: err instanceof Error ? err.message : "Network error",
          },
        ]);
      } finally {
        setUploading(false);
        setUploadProgress(null);
      }
    },
    [department, language, identifier, name, version, location, showToast, onSuccess],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "application/pdf": [".pdf"],
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    },
    disabled: uploading,
  });

  return (
    <>
    <Modal open={open} onClose={onClose} title="Upload SOP" wide>
      <div className="mb-3 flex gap-1">
        {(["English", "Gujarati"] as const).map((lang) => (
          <button
            key={lang}
            type="button"
            onClick={() => setLanguage(lang)}
            className={`rounded px-3 py-1 text-xs font-medium ${
              language === lang
                ? "bg-sky-600 text-white"
                : "bg-slate-100 text-slate-600 hover:bg-slate-200"
            }`}
          >
            {lang}
          </button>
        ))}
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="text-[10px]">
          Department
          <select
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            value={department}
            onChange={(e) => setDepartment(e.target.value)}
          >
            {allDepts.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[10px]">
          Version
          <input
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
          />
        </label>
        <label className="text-[10px]">
          SOP No (optional)
          <input
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="Auto-detect from filename"
          />
        </label>
        <label className="text-[10px]">
          Location
          <input
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </label>
        <label className="col-span-2 text-[10px]">
          SOP Name (optional)
          <input
            className="mt-0.5 w-full rounded border border-slate-300 px-2 py-1 text-xs"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>

      <label className="mb-3 block text-[10px] text-slate-500">
        After a successful upload, you will be asked to start Codex MCQ generation and full
        compliance (only if Codex is logged in on this machine).
      </label>

      <div
        {...getRootProps()}
        className={`cursor-pointer rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          isDragActive
            ? "border-sky-400 bg-sky-50"
            : "border-slate-300 bg-slate-50 hover:border-sky-300"
        } ${uploading ? "pointer-events-none opacity-60" : ""}`}
      >
        <input {...getInputProps()} />
        <Upload className="mx-auto mb-2 h-8 w-8 text-slate-400" />
        <p className="text-sm text-slate-600">
          Drag &amp; drop DOCX or PDF files here, or click to browse
        </p>
      </div>

      {uploading ? (
        <div className="mt-3">
          <BulkUploadProgressBar accent="sky" progress={uploadProgress} />
        </div>
      ) : null}

      {results.length > 0 ? <BulkUploadResults results={results} /> : null}

      <div className="mt-4 flex justify-end">
        <Btn onClick={onClose}>Close</Btn>
      </div>
    </Modal>
    <PostUploadPipelineModal
      open={pipelineOpen}
      identifiers={pipelineIds}
      onClose={() => setPipelineOpen(false)}
    />
    </>
  );
}
