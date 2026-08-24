'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';

import type { AppRole } from '@/lib/auth';

type Role = AppRole;

interface AuthGuardOptions {
  /** Redirect target when not logged in. Defaults to '/login'. */
  redirectTo?: string;
  /** If provided, redirect when the logged-in user lacks one of these roles. */
  allowedRoles?: Role[];
  /** Redirect target when role is not permitted. Defaults to '/dashboard'. */
  unauthorizedRedirect?: string;
}

/**
 * Redirects to /login if there's no active next-auth session.
 * Optionally checks role and redirects to /dashboard if not allowed.
 *
 * Note: this app uses next-auth (`useSession`) rather than a localStorage-based
 * user. Route protection is also enforced by middleware; this hook keeps the
 * client UI in sync (and handles role gating).
 */
export function useAuthGuard(options: AuthGuardOptions = {}) {
  const router = useRouter();
  const { data: session, status } = useSession();
  const {
    redirectTo = '/login',
    allowedRoles,
    unauthorizedRedirect = '/dashboard',
  } = options;

  useEffect(() => {
    if (status === 'loading') return;
    if (status === 'unauthenticated' || !session?.user) {
      router.replace(redirectTo);
      return;
    }
    if (allowedRoles) {
      const role = (session.user as { role?: Role }).role;
      if (!role || !allowedRoles.includes(role)) {
        router.replace(unauthorizedRedirect);
      }
    }
  }, [router, session, status, redirectTo, allowedRoles, unauthorizedRedirect]);
}
