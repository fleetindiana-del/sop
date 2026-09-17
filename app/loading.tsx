import { Loader2 } from "lucide-react";

/**
 * App Router route-segment fallback — shown the instant a navigation starts,
 * while the destination page's chunk downloads/mounts. Without this, every
 * top-level section (dashboard, training-matrix, compliance, mcq-bank, …)
 * left the screen looking frozen between the click and the page's own
 * internal spinner mounting. `{children}` is the only thing this Suspense
 * boundary replaces — GlobalSidebar/RoutePrefetcher in the root layout stay
 * mounted, so the shell never flashes away.
 */
export default function RootLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <Loader2 className="h-8 w-8 animate-spin text-purple-400" />
    </div>
  );
}
