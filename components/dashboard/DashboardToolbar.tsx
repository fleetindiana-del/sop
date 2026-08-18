"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  BarChart3,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  Cloud,
  CloudUpload,
  FileUp,
  FolderUp,
  GraduationCap,
  Languages,
  MapPin,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Upload,
  UserCog,
  Video,
  Wrench,
} from "lucide-react";
import type { DashboardStats } from "@/lib/types";
import { useDashboardStore } from "@/lib/store/dashboard-store";
import { Btn } from "./ui";
import { FilesFolderImportButton } from "./FilesFolderImportButton";

interface DashboardToolbarProps {
  stats: DashboardStats | null;
  onRefresh: () => void;
  onHardRefresh: () => void;
  onExport: () => void;
  canMutate: boolean;
  isAdmin: boolean;
  onOpenGuidelinesWizard?: () => void;
  onFilesImportComplete?: () => void;
}

export function DashboardToolbar({
  stats,
  onRefresh,
  onHardRefresh,
  canMutate,
  isAdmin,
  onOpenGuidelinesWizard,
  onFilesImportComplete,
}: DashboardToolbarProps) {
  const router = useRouter();
  const {
    toggleGuidelines,
    setUploadModalOpen,
    setPdfUploadOpen,
    setFolderUploadOpen,
    setGujaratiUploadOpen,
    setLocationUploadOpen,
    setBunnyMigrateOpen,
    setVideoUploadOpen,
    setBulkAllUploadOpen,
    setAdminOpen,
    setFilter,
    filters,
    showToast,
  } = useDashboardStore();

  const archiveActive = Boolean(filters.archiveView);

  // Open the Prior Version Archive view: a read-only historical listing of superseded
  // SOP revisions. This is purely a view toggle — it never deletes or moves any files.
  const toggleArchiveView = () => {
    setFilter({ archiveView: !archiveActive, obsoleteOnly: false });
    if (!archiveActive) {
      document.getElementById("sop-registry")?.scrollIntoView({ behavior: "smooth" });
    }
  };

  // Trainer / Viewer: Request Compliance Run + MCQ Bank + LMS.
  if (!isAdmin) {
    return (
      <div className="border-b border-slate-200 bg-white shadow-sm">
        <div className="mx-auto flex max-w-[1920px] flex-wrap items-center gap-1.5 px-4 py-2">
          <Btn
            size="sm"
            className="border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
            onClick={() => router.push("/compliance/request")}
          >
            <ClipboardCheck className="h-3 w-3" /> Request Compliance Run
          </Btn>
          <Btn
            size="sm"
            className="border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100"
            onClick={() => router.push("/mcq-bank")}
          >
            <BarChart3 className="h-3 w-3" /> MCQ Bank
          </Btn>
          <Btn
            size="sm"
            className="border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
            onClick={() => router.push("/lms/admin")}
          >
            <GraduationCap className="h-3 w-3" /> LMS
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-slate-200 bg-white shadow-sm">
      <div className="mx-auto flex max-w-[1920px] flex-wrap items-center gap-1.5 px-4 py-2">

        {/* Show charts */}
        <Btn size="sm">
          <BarChart3 className="h-3 w-3" /> Show charts
        </Btn>

        {/* Prior Ver. Archive – amber outlined; opens the historical archive view (read-only) */}
        <Btn
          size="sm"
          className={
            archiveActive
              ? "border-amber-500 bg-amber-100 text-amber-900 ring-1 ring-amber-400"
              : "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100"
          }
          onClick={toggleArchiveView}
          title={
            archiveActive
              ? "Showing the Prior Version Archive — click to return to the SOP Registry"
              : "View superseded SOP revisions (older than the two kept versions). No files are deleted."
          }
        >
          <Archive className="h-3 w-3" />
          Prior Ver. Archive
          <span className="ml-0.5 rounded border border-amber-200 bg-white px-1.5 py-px text-[10px] font-bold leading-none text-amber-800">
            {stats?.archivedVersionCount ?? 0}
          </span>
        </Btn>

        {canMutate && (
          <>
            <FilesFolderImportButton onComplete={onFilesImportComplete} />
            <Btn size="sm" className="border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100" onClick={() => setFolderUploadOpen(true)}>
              <Upload className="h-3 w-3" /> Version Fetch Upload
            </Btn>
            <Btn size="sm" className="border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100" onClick={() => setVideoUploadOpen(true)}>
              <Video className="h-3 w-3" /> Upload Videos &amp; Slides
            </Btn>

            {/* BULK separator */}
            <span className="px-0.5 text-[9px] font-bold uppercase tracking-wide text-gray-400">
              BULK
            </span>

            {/* Bulk Uploads dropdown */}
            <div className="group relative">
              <Btn size="sm">
                <FolderUp className="h-3 w-3" /> Bulk Uploads{" "}
                <ChevronDown className="h-3 w-3" />
              </Btn>

              <div className="absolute left-0 top-full z-30 hidden w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-xl group-hover:block">
                {/* Upload All — SOPs + annexures + PDFs */}
                <DropdownItem
                  icon={<FolderUp className="h-3.5 w-3.5 text-emerald-600" />}
                  label="Upload All (SOP + Annexures)"
                  onClick={() => setBulkAllUploadOpen(true)}
                />
                <div className="my-1 border-t border-slate-100" />
                {/* Upload SOPs */}
                <DropdownItem
                  icon={<FileUp className="h-3.5 w-3.5 text-orange-500" />}
                  label="Upload SOPs"
                  onClick={() => setFolderUploadOpen(true)}
                />
                <DropdownItem
                  icon={<Languages className="h-3.5 w-3.5 text-orange-500" />}
                  label="Gujarati folders"
                  onClick={() => setGujaratiUploadOpen(true)}
                />
                <DropdownItem
                  icon={<Upload className="h-3.5 w-3.5 text-orange-500" />}
                  label="Upload PDFs"
                  onClick={() => setPdfUploadOpen(true)}
                />
                <DropdownItem
                  icon={<Video className="h-3.5 w-3.5 text-orange-500" />}
                  label="Upload Videos & Slides"
                  onClick={() => setVideoUploadOpen(true)}
                />
                <DropdownItem
                  icon={<MapPin className="h-3.5 w-3.5 text-orange-500" />}
                  label="Upload locations"
                  onClick={() => setLocationUploadOpen(true)}
                />
                <DropdownItem
                  icon={<CloudUpload className="h-3.5 w-3.5 text-orange-500" />}
                  label="Migrate to Bunny"
                  onClick={() => setBunnyMigrateOpen(true)}
                />
              </div>
            </div>
          </>
        )}

        {/* Training Matrix – teal outlined */}
        <Btn
          size="sm"
          className="border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100"
          onClick={() => router.push("/training-matrix")}
        >
          <BarChart3 className="h-3 w-3" /> Training Matrix
        </Btn>

        {canMutate && (
          <>
            {/* SINGLE separator */}
            <span className="px-0.5 text-[9px] font-bold uppercase tracking-wide text-gray-400">
              SINGLE
            </span>

            {/* Obsolete SOPs – rose outlined */}
            <Btn
              size="sm"
              className="border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
              onClick={() => setFilter({ obsoleteOnly: !filters.obsoleteOnly, archiveView: false })}
            >
              Obsolete SOPs
            </Btn>
          </>
        )}

        {/* Compliance Engine – purple outlined */}
        <Btn
          size="sm"
          className="border-purple-200 bg-purple-50 text-purple-700 hover:bg-purple-100"
          onClick={() => router.push("/compliance")}
        >
          <Shield className="h-3 w-3" /> Compliance Engine
        </Btn>

        <Btn
          size="sm"
          className="border-teal-200 bg-teal-50 text-teal-800 hover:bg-teal-100"
          onClick={() => router.push("/compliance/label")}
        >
          <ShieldCheck className="h-3 w-3" /> Nutra Labels
        </Btn>

        <Btn
          size="sm"
          className="border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
          onClick={() => router.push("/compliance/request")}
        >
          <ClipboardCheck className="h-3 w-3" /> Request Compliance Run
        </Btn>

        {onOpenGuidelinesWizard && (
          <Btn
            size="sm"
            className="border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
            onClick={onOpenGuidelinesWizard}
          >
            <BookOpen className="h-3 w-3" /> Guideline Review
          </Btn>
        )}

        {/* MCQ Bank – slate outlined */}
        <Btn
          size="sm"
          className="border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100"
          onClick={() => router.push("/mcq-bank")}
        >
          <BarChart3 className="h-3 w-3" /> MCQ Bank
        </Btn>

        {/* LMS */}
        <Btn
          size="sm"
          className="border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
          onClick={() => router.push("/lms/admin")}
        >
          <GraduationCap className="h-3 w-3" /> LMS
        </Btn>

        {/* Developer Tools – consolidates developer-only buttons into one menu */}
        <div className="group relative ml-auto">
          <Btn
            size="sm"
            className="border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100"
            title="Developer-only tools"
          >
            <Wrench className="h-3 w-3" /> Developer Tools{" "}
            <ChevronDown className="h-3 w-3" />
          </Btn>

          <div className="absolute right-0 top-full z-30 hidden w-56 rounded-lg border border-slate-200 bg-white py-1 shadow-xl group-hover:block">
            {/* Hard Refresh — cold reload with console timing */}
            <DropdownItem
              icon={<RefreshCw className="h-3.5 w-3.5 text-indigo-500" />}
              label="Hard Refresh (cold)"
              onClick={onHardRefresh}
            />
            <div className="my-1 border-t border-slate-100" />

            {/* Guidelines */}
            <DropdownItem
              icon={<BookOpen className="h-3.5 w-3.5 text-indigo-600" />}
              label="Guidelines"
              onClick={toggleGuidelines}
            />

            {/* SOP Scheduler */}
            <DropdownItem
              icon={<CalendarDays className="h-3.5 w-3.5 text-violet-600" />}
              label="SOP Scheduler"
            />

            {/* SOP Upload */}
            {canMutate && (
              <DropdownItem
                icon={<Plus className="h-3.5 w-3.5 text-emerald-600" />}
                label="SOP Upload"
                onClick={() => setUploadModalOpen(true)}
              />
            )}

            {/* Admin-only tools */}
            {isAdmin && (
              <>
                <DropdownItem
                  icon={<UserCog className="h-3.5 w-3.5 text-violet-600" />}
                  label="Login & Passwords"
                  onClick={() => router.push("/admin/users")}
                />
                <DropdownItem
                  icon={<ShieldCheck className="h-3.5 w-3.5 text-violet-600" />}
                  label="Access Management"
                  onClick={() => router.push("/admin/access")}
                />
                <DropdownItem
                  icon={<Cloud className="h-3.5 w-3.5 text-orange-500" />}
                  label="Bunny Files"
                  onClick={() => router.push("/bunny-files")}
                />
                <DropdownItem
                  icon={<Wrench className="h-3.5 w-3.5 text-sky-600" />}
                  label="Admin Tools"
                  onClick={() => setAdminOpen(true)}
                />
                <div className="my-1 border-t border-slate-100" />
                {/* Prefix box + Fix Language */}
                <RetagLanguageBtn onSuccess={onRefresh} showToast={showToast} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Re-tag language button ── */
function RetagLanguageBtn({
  onSuccess,
  showToast,
}: {
  onSuccess: () => void;
  showToast: (msg: string) => void;
}) {
  const [running, setRunning] = useState(false);
  const [prefix, setPrefix] = useState("");

  const run = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/admin/retag-language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Retag failed");
      showToast(`Scanned ${data.scanned} record(s), re-tagged ${data.retagged} with correct language.`);
      if (data.retagged > 0) onSuccess();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Retag failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <input
        className="w-full rounded border border-slate-200 px-2 py-1 text-[10px] text-slate-600 placeholder:text-slate-400 focus:border-sky-400 focus:outline-none"
        placeholder="prefix e.g. MAGE"
        value={prefix}
        onChange={(e) => setPrefix(e.target.value.toUpperCase())}
        disabled={running}
        title="SOP code prefix to re-tag (leave blank for all)"
      />
      <Btn
        size="sm"
        className="w-full justify-center border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100"
        onClick={run}
        disabled={running}
        title="Re-detect language from file content and fix mislabelled records"
      >
        <Languages className="h-3 w-3" />
        {running ? "Re-tagging…" : "Fix Language"}
      </Btn>
    </div>
  );
}

/* ── Dropdown item ── */
function DropdownItem({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs text-slate-700 hover:bg-sky-50"
    >
      {icon}
      {label}
    </button>
  );
}
