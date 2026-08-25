"use client";

import {
  LogOut,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import type { DashboardStats } from "@/lib/types";
import type { AppRole } from "@/lib/auth";
import { clearLmsClientCache } from "@/lib/lmsCache";
import { NotificationBell } from "./NotificationBell";

interface DashboardHeaderProps {
  stats: DashboardStats | null;
  onExpiryFilter: (tier: string) => void;
}

export function DashboardHeader({ stats, onExpiryFilter }: DashboardHeaderProps) {
  const { data: session } = useSession();
  const username = session?.user?.name ?? "User";
  const role = (session?.user?.role ?? "viewer") as AppRole;
  const expired = stats?.expired ?? 0;
  const nearExpiry = stats?.nearExpiry ?? 0;
  const total = stats?.totalSops ?? 0;

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-gray-100 shadow-sm">
      <div className="mx-auto flex max-w-[1920px] items-center justify-between px-4 py-2.5">

        {/* ── Left: Logo + Title ── */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-600">
            <Sparkles className="h-4 w-4 text-white" />
          </div>

          <div>
            <h1 className="text-base font-bold tracking-tight text-gray-900">
              SOP Control — Master Dashboard
            </h1>
            <p className="text-[10px] text-gray-600">
              Welcome,{" "}
              <span className="font-semibold text-gray-800">{username}</span>
              {total > 0 && (
                <span className="ml-3 rounded bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700">
                  {total} SOPs
                </span>
              )}
            </p>
          </div>
        </div>

        {/* ── Right: alerts + user controls ── */}
        <div className="flex items-center gap-2">
          {/* Expiry alerts */}
          <div className="hidden items-center gap-2 md:flex">
            {expired > 0 ? (
              <button
                type="button"
                onClick={() => onExpiryFilter("Expired")}
                className="rounded border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-100"
              >
                {expired} SOPs Expired
              </button>
            ) : nearExpiry > 0 ? (
              <button
                type="button"
                onClick={() => onExpiryFilter("Near")}
                className="rounded border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-100"
              >
                {nearExpiry} near expiry
              </button>
            ) : total > 0 ? (
              <span className="rounded border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                All within review cycle
              </span>
            ) : null}
          </div>

          {/* User info chip */}
          <div className="flex items-center gap-1.5 border-l border-gray-200/60 pl-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-purple-100">
              <User className="h-3.5 w-3.5 text-purple-600" />
            </div>
            <div className="flex flex-col leading-none">
              <span className="text-[11px] font-semibold text-gray-800">{username}</span>
              <span className="text-[9px] font-bold uppercase tracking-wide text-gray-500">{role}</span>
            </div>
          </div>

          {/* Icon buttons */}
          <NotificationBell />
          <button
            type="button"
            className="rounded p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
            aria-label="Deleted items"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="rounded p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
            aria-label="Logout"
            onClick={async () => {
              // The learner cookie and the cached LMS dashboard outlive the app
              // session, so drop both here — otherwise the next person to sign
              // in on this browser opens this user's training record.
              await fetch("/api/lms/auth/logout", { method: "POST" }).catch(() => {});
              clearLmsClientCache();
              void signOut({ callbackUrl: "/login" });
            }}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </header>
  );
}

export function SummaryCards({
  stats,
  onFilter,
}: {
  stats: DashboardStats | null;
  onFilter: (patch: Record<string, string | boolean>) => void;
}) {
  if (!stats) return null;
  return null; // Hidden from layout — kept for potential future use
}
