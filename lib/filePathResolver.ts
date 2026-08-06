import path from 'path';
import fs from 'fs/promises';

export const FILE_SEARCH_ROOTS = [
  '',
  'uploads/sops',
  'uploads/sop-pdfs',
  'uploads/sop_pdfs',
  'files',
  'uploads/sop-library',
  'public',
  'uploads',
  'ils',
  'Fils',
];

/** Normalize path: decode URI, use forward slashes, strip leading slash. */
export function normalizePath(raw: string): string {
  let p = raw;
  try {
    p = decodeURIComponent(p);
  } catch {
    // keep as-is
  }
  p = p.replace(/\\/g, '/').replace(/^\/+/, '');
  return p;
}

/**
 * Resolve a stored file path (from DB or URL param) to an absolute path on disk.
 * Used by both /api/files/download and /api/files/view-docx so they find files the same way.
 */
export async function resolveFilePath(filePath: string): Promise<string | null> {
  // turbopackIgnore: keep file resolution runtime-only so NFT does not bundle the whole repo.
  const cwd = /*turbopackIgnore: true*/ process.cwd();
  const normalized = normalizePath(filePath);
  const basename = path.basename(normalized);

  // 1. Try as absolute path
  if (path.isAbsolute(normalized)) {
    try {
      await fs.access(normalized);
      return normalized;
    } catch {}
  }

  // 2. Try path relative to cwd
  const direct = path.join(/*turbopackIgnore: true*/ cwd, normalized);
  try {
    await fs.access(direct);
    return direct;
  } catch {}

  // 3. Try each known root + full path, then root + basename only
  for (const root of FILE_SEARCH_ROOTS) {
    if (!root) {
      const candidate = path.join(/*turbopackIgnore: true*/ cwd, basename);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {}
      continue;
    }
    const candidate = path.join(/*turbopackIgnore: true*/ cwd, root, normalized);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
    const candidateBasename = path.join(/*turbopackIgnore: true*/ cwd, root, basename);
    try {
      await fs.access(candidateBasename);
      return candidateBasename;
    } catch {}
  }

  // 4. Try path segments under cwd (e.g. "ils/MAGE01/file.docx" -> cwd/ils/MAGE01/file.docx)
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length > 1) {
    const fromCwd = path.join(/*turbopackIgnore: true*/ cwd, ...segments);
    try {
      await fs.access(fromCwd);
      return fromCwd;
    } catch {}
  }

  return null;
}
