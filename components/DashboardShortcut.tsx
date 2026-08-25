'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { GraduationCap, LayoutDashboard } from 'lucide-react';
import { isLearnerOnly, landingPathForRole } from '@/lib/page-access';

/**
 * Always-available way back to the home screen.
 *
 * Mounted once in the root layout so every page — including deep sub-pages and
 * dynamic routes that own their own header — has a route home, without each
 * screen having to add its own link. It is pinned to the top centre, clear of
 * the left-hand titles and right-hand action buttons page headers use.
 *
 * "Home" depends on the role: privileged logins go to the dashboard, learner
 * logins to the LMS, which is the only module they can reach.
 *
 * Hidden where it would be wrong rather than merely redundant:
 *  - signed-out visitors (the link would bounce them to /login),
 *  - the target page itself and the login/landing pages,
 *  - the public compliance label view, which is deliberately unauthenticated.
 */
const HIDDEN_EXACT = new Set(['/', '/login']);

/**
 * `hideSubPaths` is false for the LMS home: its sub-pages (journey,
 * certificate, my-record) are separate screens that still need a way back.
 */
function isHidden(pathname: string, home: string, hideSubPaths: boolean): boolean {
  if (HIDDEN_EXACT.has(pathname)) return true;
  if (pathname === home) return true;
  if (hideSubPaths && pathname.startsWith(`${home}/`)) return true;
  if (pathname === '/compliance/label' || pathname.startsWith('/compliance/label/')) return true;
  return false;
}

export function DashboardShortcut() {
  const pathname = usePathname() || '';
  const { data: session, status } = useSession();

  if (status !== 'authenticated') return null;

  const role = session?.user?.role;
  const home = landingPathForRole(role);
  const learner = isLearnerOnly(role);

  if (isHidden(pathname, home, !learner)) return null;

  const Icon = learner ? GraduationCap : LayoutDashboard;

  return (
    <Link
      href={home}
      title={learner ? 'Back to my training' : 'Back to dashboard'}
      className="fixed left-1/2 top-2 z-50 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-lg backdrop-blur transition hover:border-violet-300 hover:text-violet-700 print:hidden"
    >
      <Icon className="h-3.5 w-3.5" />
      {learner ? 'My Training' : 'Dashboard'}
    </Link>
  );
}
