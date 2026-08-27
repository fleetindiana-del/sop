"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ClipboardList,
  Loader2,
  Settings2,
  Users,
} from "lucide-react";
import { SopExamSettingsPanel } from "@/components/lms/SopExamSettingsPanel";
import { isAdmin } from "@/lib/roles";

export default function LmsAdminPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const showOverview = Boolean(session?.user?.role && isAdmin(session.user.role));

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
  }, [status, router]);

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-screen-2xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Link
              href="/employees"
              className="flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
            >
              <ArrowLeft className="h-3.5 w-3.5" /> Employee Master
            </Link>
            <div className="h-4 w-px bg-gray-200" />
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4 text-purple-600" />
              <h1 className="text-sm font-bold tracking-tight">SOP Exam Settings</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {showOverview && (
              <Link
                href="/lms/admin/trainer-overview"
                className="flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100"
              >
                <Users className="h-3.5 w-3.5" /> Trainer Overview
              </Link>
            )}
            <Link
              href="/lms/admin/global"
              className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              <ClipboardList className="h-3.5 w-3.5" /> Global Defaults
            </Link>
            <Link
              href="/employees"
              className="flex items-center gap-1.5 rounded-lg border border-purple-200 bg-purple-50 px-3 py-1.5 text-xs font-semibold text-purple-700 transition hover:bg-purple-100"
            >
              <Users className="h-3.5 w-3.5" /> Employees Page
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6 lg:px-8">
        <SopExamSettingsPanel />
      </main>
    </div>
  );
}
