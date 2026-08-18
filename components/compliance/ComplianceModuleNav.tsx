"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Pill, Shield } from "lucide-react";

const MODULES = [
  { href: "/compliance", label: "SOP Compliance", icon: Shield, match: (path: string) => path === "/compliance" || path.startsWith("/compliance/report") },
  { href: "/compliance/label", label: "Nutra Label Compliance", icon: Pill, match: (path: string) => path.startsWith("/compliance/label") },
] as const;

export function ComplianceModuleNav() {
  const pathname = usePathname() || "";

  return (
    <nav
      aria-label="Compliance modules"
      className="flex flex-wrap items-center gap-1.5 rounded-xl border border-purple-100 bg-white p-1 shadow-sm"
    >
      {MODULES.map((mod) => {
        const active = mod.match(pathname);
        const Icon = mod.icon;
        return (
          <Link
            key={mod.href}
            href={mod.href}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-semibold transition-colors ${
              active
                ? "bg-purple-600 text-white shadow-sm"
                : "text-slate-600 hover:bg-purple-50 hover:text-purple-800"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {mod.label}
          </Link>
        );
      })}
    </nav>
  );
}
