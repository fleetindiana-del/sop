'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { LayoutDashboard } from 'lucide-react';

/**
 * Always-available way back to the dashboard.
 *
 * Mounted once in the root layout so every page — including deep sub-pages and
 * dynamic routes that own their own header — has a route home, without each
 * screen having to add its own link.
 *
 * Hidden where it would be wrong rather than merely redundant:
 *  - signed-out visitors (the link would bounce them to /login),
 *  - the dashboard itself and the login/landing pages,
 *  - the public compliance label view, which is deliberately unauthenticated.
 *
 * Pages that already carry an inline "Dashboard" button keep it; this sits in
 * the corner and does not collide with page chrome.
 */
const HIDDEN_EXACT = new Set(['/', '/login', '/dashboard']);

function isHidden(pathname: string): boolean {
  if (HIDDEN_EXACT.has(pathname)) return true;
  if (pathname.startsWith('/dashboard/')) return true;
  if (pathname === '/compliance/label' || pathname.startsWith('/compliance/label/')) return true;
  return false;
}

export function DashboardShortcut() {
  const pathname = usePathname() || '';
  const { status } = useSession();

  if (status !== 'authenticated') return null;
  if (isHidden(pathname)) return null;

  return (
    <Link
      href="/dashboard"
      title="Back to dashboard"
      className="fixed bottom-4 left-4 z-40 inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3 py-2 text-xs font-semibold text-slate-700 shadow-lg backdrop-blur transition hover:border-violet-300 hover:text-violet-700 print:hidden"
    >
      <LayoutDashboard className="h-3.5 w-3.5" />
      Dashboard
    </Link>
  );
}
