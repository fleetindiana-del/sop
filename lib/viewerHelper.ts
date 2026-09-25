import { NextRequest } from 'next/server';
import { connectDB } from '@/lib/mongodb';
import SOP from '@/models/SOP';
import { signViewerToken } from '@/lib/viewerToken';
import { sopIdentifierMatchFilter } from '@/lib/sopIdentifierNormalize';
import { extractBunnyPath, getBunnyCdnUrl, isBunnyPath } from '@/lib/bunnyStorage';
import { fileKindFromStoredPath } from '@/lib/filePathFileKind';

// ---------------------------------------------------------------------------
// Server-side in-memory cache for resolved viewer URLs
// Keyed by "identifier::language::path" → publicUrl
// TTL: 10 minutes. Eliminates repeated DB queries when the same document is
// opened multiple times within a session.
// ---------------------------------------------------------------------------
const VIEWER_CACHE_TTL_MS = 10 * 60 * 1000;
interface ViewerCacheEntry { publicUrl: string; cachedAt: number }
const g = global as typeof global & { __viewerUrlCache?: Map<string, ViewerCacheEntry> };
if (!g.__viewerUrlCache) g.__viewerUrlCache = new Map();
const viewerUrlCache = g.__viewerUrlCache;

/** Bump when resolver-priority semantics change so stale entries from older code paths are bypassed. */
const VIEWER_CACHE_VERSION = 'v2';

function viewerCacheKey(
  identifier: string | null,
  language: string | null,
  pathParam: string | null,
): string {
  return `${VIEWER_CACHE_VERSION}::${identifier ?? ''}::${language ?? ''}::${pathParam ?? ''}`;
}

/**
 * Drop cached viewer URLs whose key contains any of the given substrings
 * (typically a SOP identifier). Called after a re-upload so the next preview
 * resolves the new, cache-busted document URL instead of the stale one.
 */
export function invalidateViewerUrlCache(matches: Array<string | null | undefined>): number {
  const needles = matches.map((m) => (m || '').trim()).filter(Boolean);
  if (!needles.length) return 0;
  let removed = 0;
  for (const key of viewerUrlCache.keys()) {
    if (needles.some((n) => key.includes(n))) {
      viewerUrlCache.delete(key);
      removed++;
    }
  }
  return removed;
}

function getCachedViewerUrl(key: string): string | null {
  const entry = viewerUrlCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > VIEWER_CACHE_TTL_MS) {
    viewerUrlCache.delete(key);
    return null;
  }
  return entry.publicUrl;
}

function setCachedViewerUrl(key: string, publicUrl: string): void {
  viewerUrlCache.set(key, { publicUrl, cachedAt: Date.now() });
  // Evict old entries if cache grows too large
  if (viewerUrlCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of viewerUrlCache) {
      if (now - v.cachedAt > VIEWER_CACHE_TTL_MS) viewerUrlCache.delete(k);
    }
  }
}

export function getOrigin(request: NextRequest): string {
  // Use explicit public URL so Office Online Viewer can reach serve-docx (viewer fetches from internet)
  const explicit = process.env.NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL;
  if (explicit) {
    const base = explicit.startsWith('http') ? explicit : `https://${explicit}`;
    return base.replace(/\/$/, '');
  }
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  const proto = request.headers.get('x-forwarded-proto') || (request.nextUrl?.protocol?.replace(':', '') || 'https');
  return `${proto === 'https' ? 'https' : 'http'}://${host}`;
}

/** True if the document URL would be reachable by Office/Google viewer (public HTTPS, not localhost). */
export function isOriginPublicForViewer(origin: string): boolean {
  if (!origin || !origin.startsWith('https://')) return false;
  const host = origin.replace(/^https:\/\//, '').split('/')[0].toLowerCase();
  return !host.startsWith('localhost') && host !== '127.0.0.1' && !host.endsWith('.local');
}

/** Microsoft Office Online can fetch the document (HTTPS, not pointing at localhost). */
export function canOfficeOnlineFetchDocumentUrl(publicUrl: string): boolean {
  if (!publicUrl || !/^https:\/\//i.test(publicUrl)) return false;
  return !/localhost|127\.0\.0\.1/i.test(publicUrl);
}

function looksGujarati(sop: any): boolean {
  if (sop.language === 'Gujarati') return true;
  const name = (sop.name || '') + (sop.originalFileName || '');
  const url = sop.fileUrl || '';
  const folder = sop.folderPath || '';
  if (/[઀-૿]{4,}/.test(name)) return true;
  if (/(^|[\/\\\s_-])guj([\/\\\s_-]|$)/i.test(url) || /gujarati/i.test(url)) return true;
  if (/(^|[\/\\\s_-])guj([\/\\\s_-]|$)/i.test(folder) || /gujarati/i.test(folder)) return true;
  return false;
}

/** Resolve file URL and build public document URL (Bunny CDN or signed serve-docx). */
export async function resolvePublicDocUrl(
  request: NextRequest,
  identifier: string | null,
  language: string | null,
  pathParam: string | null
): Promise<{ publicUrl: string } | { error: string; status: number }> {
  // Check server-side cache first — avoids DB round-trip for recently opened documents.
  const cacheKey = viewerCacheKey(identifier, language, pathParam);
  const cachedUrl = getCachedViewerUrl(cacheKey);
  if (cachedUrl) {
    /** When pathParam is supplied, the caller has already picked the file for this language slot.
     *  Drop any cached entry that no longer matches that path so wrong-language URLs from the previous
     *  resolver-first behaviour can't linger. */
    const expectedFromPath = pathParam ? pathParam.trim() : '';
    if (!expectedFromPath || cachedUrl === expectedFromPath || cachedUrl.endsWith(expectedFromPath)) {
      return { publicUrl: cachedUrl };
    }
    viewerUrlCache.delete(cacheKey);
  }

  let fileUrl: string | null = null;

  /**
   * Trust an explicit pathParam when the caller passed a directly usable Word URL.
   * The dashboard picks the correct file for each language slot (CDN basenames are
   * often hash/timestamped, so path-text heuristics can't tell ENG vs GUJ). Honour
   * the caller's choice instead of letting the identifier-based resolver swap files.
   * This mirrors the download flow.
   */
  const trimmedPath = pathParam ? pathParam.trim() : '';
  if (trimmedPath) {
    const isHttps = /^https?:\/\//i.test(trimmedPath);
    const isBunny = isBunnyPath(trimmedPath);
    const kind = fileKindFromStoredPath(trimmedPath);
    const isWord = kind === 'docx' || kind === 'doc';
    if (isWord && (isHttps || isBunny)) {
      fileUrl = trimmedPath;
    }
  }

  // Comprehensive resolution: checks SOPLibrary + SOP, verifies reachability (Bunny CDN, local disk, https).
  // This ensures Office Online gets the best available URL rather than a stale SOP.fileUrl.
  if (!fileUrl && (identifier || pathParam)) {
    const { resolveDocxPathForViewer } = await import('@/lib/loadStoredFileBuffer');
    const pathTrim = pathParam ? pathParam.replace(/^\/+/, '') : null;
    const resolved = await resolveDocxPathForViewer(identifier, language || undefined, pathTrim);
    if (resolved) {
      fileUrl = resolved;
    }
  }

  // Fallback: direct SOP query (handles PDFs and cases where resolveDocxPathForViewer finds nothing)
  if (!fileUrl) {
    if (identifier) {
      await connectDB();

      const allSops = await SOP.find(sopIdentifierMatchFilter(identifier))
        .select('fileUrl language name originalFileName folderPath')
        .sort({ uploadedAt: -1 })
        .lean();

      const wantGujarati = language === 'Gujarati';
      const target = wantGujarati
        ? allSops.find(s => looksGujarati(s))
        : allSops.find(s => !looksGujarati(s)) || allSops[0];

      if (target?.fileUrl) {
        fileUrl = (target as any).fileUrl;
      } else if (pathParam) {
        fileUrl = pathParam.replace(/^\/+/, '');
      }
    } else if (pathParam) {
      fileUrl = pathParam.replace(/^\/+/, '');
    }
  }

  if (!fileUrl) {
    return { error: 'Document not found', status: 404 };
  }

  let publicUrl: string;
  if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
    publicUrl = fileUrl;
  } else if (fileUrl.startsWith('bunny://')) {
    /** Word Online can fetch the pull-zone URL directly — better than proxying through serve-docx. */
    const cdn = getBunnyCdnUrl(extractBunnyPath(fileUrl));
    if (cdn) {
      publicUrl = cdn;
    } else {
      const origin = getOrigin(request);
      const token = signViewerToken({ path: fileUrl });
      publicUrl = `${origin}/api/files/serve-docx?t=${encodeURIComponent(token)}`;
    }
  } else {
    const origin = getOrigin(request);
    const token = signViewerToken({ path: fileUrl });
    publicUrl = `${origin}/api/files/serve-docx?t=${encodeURIComponent(token)}`;
  }

  // Cache the resolved URL so future requests for the same doc skip the DB query.
  setCachedViewerUrl(cacheKey, publicUrl);

  return { publicUrl };
}
