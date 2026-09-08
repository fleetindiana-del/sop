'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';

import { NAV_GROUPS } from '@/components/GlobalSidebar';
import { canAccessPath, isLearnerOnly } from '@/lib/page-access';

/**
 * Warms the route chunks for every section the signed-in user can reach.
 *
 * Next only prefetches a `<Link>` once it enters the viewport. Every nav link
 * in this app lives inside the collapsed, off-screen `GlobalSidebar`, so in
 * practice nothing was ever prefetched: each navigation paid for a cold
 * chunk download (the heaviest pages are ~700KB of route-specific JS) before
 * the page could even mount and start fetching its data.
 *
 * Prefetching here happens after the current page has finished loading and
 * only while the browser is idle, so it never competes with the visible
 * page's own requests. Chunks are cached by the browser, so this costs one
 * background download per route per deploy.
 */

/** Routes already handed to `router.prefetch` in this browsing session. */
const warmed = new Set<string>();

/** Skip background downloads on metered / very slow connections. */
function shouldPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false;
  const conn = (navigator as Navigator & {
    connection?: { saveData?: boolean; effectiveType?: string };
  }).connection;
  if (!conn) return true;
  if (conn.saveData) return false;
  return !/(^|-)2g$/.test(conn.effectiveType ?? '');
}

function onIdle(fn: () => void): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };
  if (typeof w.requestIdleCallback === 'function') {
    const handle = w.requestIdleCallback(fn, { timeout: 2_000 });
    return () => w.cancelIdleCallback?.(handle);
  }
  const timer = window.setTimeout(fn, 200);
  return () => window.clearTimeout(timer);
}

export function RoutePrefetcher() {
  const router = useRouter();
  const pathname = usePathname() || '';
  const { data: session, status } = useSession();
  const role = session?.user?.role;
  const pageAccess = session?.user?.pageAccess;

  useEffect(() => {
    if (status !== 'authenticated' || pathname === '/login') return;
    if (!shouldPrefetch()) return;

    const learner = isLearnerOnly(role);
    const targets = NAV_GROUPS.flatMap((group) => group.items)
      .map((item) => item.href)
      .filter((href) =>
        learner ? href.startsWith('/lms') || href === '/test' : canAccessPath(role, pageAccess, href),
      )
      .filter((href) => href !== pathname && !warmed.has(href));

    if (targets.length === 0) return;

    let cancelled = false;
    let cancelIdle: (() => void) | null = null;

    // One route per idle slice: a burst of parallel chunk downloads would
    // contend with the data requests the page the user is actually looking at
    // has in flight.
    const step = () => {
      if (cancelled) return;
      const next = targets.shift();
      if (!next) return;
      warmed.add(next);
      router.prefetch(next);
      cancelIdle = onIdle(step);
    };

    const start = () => {
      if (!cancelled) cancelIdle = onIdle(step);
    };

    if (document.readyState === 'complete') {
      start();
    } else {
      window.addEventListener('load', start, { once: true });
    }

    return () => {
      cancelled = true;
      cancelIdle?.();
      window.removeEventListener('load', start);
    };
  }, [router, pathname, role, pageAccess, status]);

  return null;
}
