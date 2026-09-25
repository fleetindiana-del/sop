import fs from 'fs/promises';
import path from 'path';
import { normalizePath, resolveFilePath } from '@/lib/filePathResolver';
import { fetchBunnyFile, isBunnyPath, searchBunnyStorageForDocx } from '@/lib/bunnyStorage';
import { connectDB } from '@/lib/mongodb';
import SOP from '@/models/SOP';
import SOPLibrary from '@/models/SOPLibrary';
import SOPVersionArtifacts from '@/models/SOPVersionArtifacts';
import { sopIdentifierMatchFilter } from '@/lib/sopIdentifierNormalize';
import { fileKindFromStoredPath } from '@/lib/filePathFileKind';
import { pathSuggestsGujarati } from '@/lib/pathLanguageDetection';
import {
  collectSopIdentifierCandidates,
  extractRawHyphenatedSopCodesFromPath,
} from '@/lib/inferSopIdentifierFromStoredPath';

/** Never serve an annexure file when resolving a main SOP document. */
function isAnnexurePath(p: string): boolean {
  const name = path.posix.basename((p || '').replace(/\\/g, '/').split('?')[0]).toLowerCase();
  return /annex(ure)?/i.test(name);
}

/** Avoid returning a Mongo path that no longer exists on disk (stale uploads path) so fallbacks can run. */
async function isLocalStoredPathReachable(p: string): Promise<boolean> {
  const t = (p || '').trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (isBunnyPath(t)) return true;
  const abs = await resolveFilePath(normalizePath(t.split(/[?#]/)[0]));
  if (!abs) return false;
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

function looksGujarati(sop: {
  language?: string;
  name?: string;
  originalFileName?: string;
  fileUrl?: string;
  folderPath?: string;
}): boolean {
  if (sop.language === 'Gujarati') return true;
  const name = (sop.name || '') + (sop.originalFileName || '');
  const url = sop.fileUrl || '';
  const folder = sop.folderPath || '';
  if (/[઀-૿]{4,}/.test(name)) return true;
  if (/(^|[/\\\s_-])guj([/\\\s_-]|$)/i.test(url) || /gujarati/i.test(url)) return true;
  if (/(^|[/\\\s_-])guj([/\\\s_-]|$)/i.test(folder) || /gujarati/i.test(folder)) return true;
  return false;
}

export async function resolveFileUrlFromSopIdentifier(
  identifier: string,
  language: string | undefined,
): Promise<string | null> {
  await connectDB();
  const wantGuj = language === 'Gujarati';
  const all = await SOP.find(sopIdentifierMatchFilter(identifier))
    .select('fileUrl language name originalFileName folderPath')
    .sort({ uploadedAt: -1 })
    .lean();
  const target = wantGuj
    ? all.find((s) => looksGujarati(s))
    : all.find((s) => !looksGujarati(s)) || all[0];
  return (target as { fileUrl?: string } | undefined)?.fileUrl?.trim() || null;
}

function pickLibraryRow<T extends { language?: string }>(rows: T[], wantGuj: boolean): T | null {
  if (!rows.length) return null;
  if (wantGuj) {
    return rows.find((r) => (r.language || 'English') === 'Gujarati') || rows[0];
  }
  return rows.find((r) => (r.language || 'English') !== 'Gujarati') || rows[0];
}

function orderLibraryRowsByLanguage<T extends { language?: string }>(
  libs: T[],
  wantGuj: boolean,
): T[] {
  if (!libs.length) return libs;
  if (wantGuj) {
    const g = libs.filter((r) => (r.language || 'English') === 'Gujarati');
    const e = libs.filter((r) => (r.language || 'English') !== 'Gujarati');
    /** Prefer Gujarati row, but still scan English row for DOCX when GUJ has no Word file (common library shape). */
    return g.length ? [...g, ...e] : libs;
  }
  const e = libs.filter((r) => (r.language || 'English') !== 'Gujarati');
  const g = libs.filter((r) => (r.language || 'English') === 'Gujarati');
  return e.length ? [...e, ...g] : libs;
}

async function resolveLibraryDocumentPath(
  identifier: string,
  language: string | undefined,
  wantKind: 'pdf' | 'docx' | 'doc',
): Promise<string | null> {
  await connectDB();
  const wantGuj = language === 'Gujarati';
  const libs = await SOPLibrary.find(sopIdentifierMatchFilter(identifier, 'identifier'))
    .select('sopDocuments language')
    .lean();
  // Aggregate sopDocuments across every matching row (ordered by language preference).
  // The master records live in the `sops` collection where each row carries only its own
  // file in sopDocuments, so the requested DOCX/PDF may sit in a sibling row, not the first.
  const allDocs = orderLibraryRowsByLanguage(libs, wantGuj).flatMap((r) => r.sopDocuments || []);
  if (!allDocs.length) return null;

  // CRITICAL FIX: Filter documents by language BEFORE scanning
  // This prevents English requests from getting Gujarati files when both are in the same library row
  const langFilteredDocs = allDocs.filter((d: any) => {
    const docLang = String(d.language || '').trim().toLowerCase();
    const docPath = String(d.filePath || '');

    if (wantGuj) {
      // Request is for Gujarati: accept if explicitly marked OR path suggests Gujarati
      return docLang === 'gujarati' || docLang === 'guj' || pathSuggestsGujarati(docPath);
    }

    // Request is for English: accept if NOT marked Gujarati AND path doesn't suggest Gujarati
    return docLang !== 'gujarati' && docLang !== 'guj' && !pathSuggestsGujarati(docPath);
  });

  // Use language-filtered documents if available, otherwise warn and use all
  const docs = langFilteredDocs.length > 0 ? langFilteredDocs : allDocs;
  if (langFilteredDocs.length === 0 && allDocs.length > 0) {
    console.warn(
      `[FILE_LANG] No ${wantGuj ? 'Gujarati' : 'English'} document found in library ` +
      `for "${identifier}" (${wantKind}). Using any available document. ` +
      `This may cause language mismatch.`
    );
  }

  // Scan documents for matching type
  for (const d of docs) {
    const p = (d as { filePath?: string; fileType?: string }).filePath?.trim();
    if (!p || isAnnexurePath(p)) continue;
    if (fileKindFromStoredPath(p, (d as { fileType?: string }).fileType) === wantKind) return p;
  }

  return null;
}

async function resolveLibraryPathByBasename(
  identifier: string,
  language: string | undefined,
  targetBasename: string,
): Promise<string | null> {
  await connectDB();
  const wantGuj = language === 'Gujarati';
  const tb = targetBasename.trim().toLowerCase();
  if (!tb) return null;
  const libs = await SOPLibrary.find(sopIdentifierMatchFilter(identifier, 'identifier'))
    .select('sopDocuments language')
    .lean();
  const row = pickLibraryRow(libs, wantGuj);
  const docs = row?.sopDocuments;
  if (!docs?.length) return null;
  for (const d of docs) {
    const p = (d as { filePath?: string }).filePath?.trim();
    if (!p) continue;
    const base = path.posix.basename(p.split(/[?#]/)[0]).toLowerCase();
    if (base === tb) return p;
  }
  return null;
}

async function resolveSopFileUrlMatchingKind(
  identifier: string,
  language: string | undefined,
  wantKind: 'pdf' | 'docx' | 'doc',
): Promise<string | null> {
  await connectDB();
  const wantGuj = language === 'Gujarati';
  const all = await SOP.find(sopIdentifierMatchFilter(identifier))
    .select('fileUrl language name originalFileName folderPath fileType')
    .lean();
  const target = wantGuj
    ? all.find((s) => looksGujarati(s))
    : all.find((s) => !looksGujarati(s)) || all[0];
  const url = (target as { fileUrl?: string; fileType?: string } | undefined)?.fileUrl?.trim();
  if (!url) return null;
  return fileKindFromStoredPath(url, (target as { fileType?: string }).fileType) === wantKind ? url : null;
}

/** When sopIdentifier in Mongo does not match inferred codes, still find the row by exact filename (any path/URL). */
async function resolveLibraryDocumentByFilenameGlobally(
  targetBasename: string,
  wantKind: 'pdf' | 'docx' | 'doc',
  language: string | undefined,
): Promise<string | null> {
  const tb = targetBasename.trim().toLowerCase();
  if (!tb) return null;
  await connectDB();
  const wantGuj = language === 'Gujarati';
  const esc = tb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const libs = await SOPLibrary.find({
    sopDocuments: {
      $elemMatch: {
        filePath: { $regex: `${esc}$`, $options: 'i' },
      },
    },
  })
    .select('sopDocuments language')
    .limit(25)
    .lean();

  for (const row of orderLibraryRowsByLanguage(libs, wantGuj)) {
    for (const d of row.sopDocuments || []) {
      const p = (d as { filePath?: string; fileType?: string }).filePath?.trim();
      if (!p || isAnnexurePath(p)) continue;
      const base = path.posix.basename(p.split(/[?#]/)[0]).toLowerCase();
      if (base !== tb) continue;
      if (fileKindFromStoredPath(p, (d as { fileType?: string }).fileType) === wantKind) return p;
    }
  }
  return null;
}

/** sopIdentifier may not match the code in the stored path/URL; search filePath for PEGE13-05 etc. */
async function resolveLibraryDocumentByPathContainingCode(
  codeSubstring: string,
  wantKind: 'pdf' | 'docx' | 'doc',
  language: string | undefined,
): Promise<string | null> {
  const sub = (codeSubstring || '').trim();
  if (sub.length < 4) return null;
  await connectDB();
  const wantGuj = language === 'Gujarati';
  const esc = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pathRe = new RegExp(esc, 'i');

  const libs = await SOPLibrary.find({
    sopDocuments: {
      $elemMatch: {
        filePath: pathRe,
      },
    },
  })
    .select('sopDocuments language')
    .limit(25)
    .lean();

  for (const row of orderLibraryRowsByLanguage(libs, wantGuj)) {
    for (const d of row.sopDocuments || []) {
      const p = (d as { filePath?: string; fileType?: string }).filePath?.trim();
      if (!p || isAnnexurePath(p) || !pathRe.test(p)) continue;
      if (fileKindFromStoredPath(p, (d as { fileType?: string }).fileType) === wantKind) return p;
    }
  }
  return null;
}

async function resolveSopFileUrlByPathContainingCode(
  codeSubstring: string,
  wantKind: 'pdf' | 'docx' | 'doc',
  language: string | undefined,
): Promise<string | null> {
  const sub = (codeSubstring || '').trim();
  if (sub.length < 4) return null;
  await connectDB();
  const wantGuj = language === 'Gujarati';
  const esc = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const urlRe = new RegExp(esc, 'i');

  const all = await SOP.find({ fileUrl: urlRe })
    .select('fileUrl fileType language name originalFileName folderPath')
    .limit(30)
    .lean();

  const nonAnnexure = all.filter((s) => !isAnnexurePath((s as any).fileUrl || ''));
  const pool = nonAnnexure.length ? nonAnnexure : all;
  const target = wantGuj
    ? pool.find((s) => looksGujarati(s))
    : pool.find((s) => !looksGujarati(s)) || pool[0];
  const url = (target as { fileUrl?: string; fileType?: string } | undefined)?.fileUrl?.trim();
  if (!url || !urlRe.test(url)) return null;
  if (fileKindFromStoredPath(url, (target as { fileType?: string }).fileType) !== wantKind) return null;
  return url;
}

async function tryResolveLibraryOrSopByPathCodes(
  trimmedPath: string,
  wantKind: 'pdf' | 'docx' | 'doc',
  language: string | undefined,
): Promise<string | null> {
  const rawCodes = extractRawHyphenatedSopCodesFromPath(trimmedPath);
  rawCodes.sort((a, b) => b.length - a.length);
  for (const code of rawCodes) {
    const lib = await resolveLibraryDocumentByPathContainingCode(code, wantKind, language);
    if (lib && (await isLocalStoredPathReachable(lib))) return lib;
    const sop = await resolveSopFileUrlByPathContainingCode(code, wantKind, language);
    if (sop && (await isLocalStoredPathReachable(sop))) return sop;
  }
  return null;
}

/** Scan all library + SOP rows for identifier variants; return first path of `wantKind` that exists on disk (or https). */
async function findFirstReachablePathForIdentifiers(
  ids: string[],
  language: string | undefined,
  wantKind: 'pdf' | 'docx' | 'doc',
): Promise<string | null> {
  const wantGuj = language === 'Gujarati';
  /** A single library row often holds both ENG and GUJ docs in sopDocuments — filter per-doc so we don't return the English file when Gujarati was requested. */
  const docMatchesLanguage = (d: any): boolean => {
    const docLang = String(d?.language || '').trim().toLowerCase();
    const docPath = String(d?.filePath || '');
    if (wantGuj) {
      return docLang === 'gujarati' || docLang === 'guj' || pathSuggestsGujarati(docPath);
    }
    return docLang !== 'gujarati' && docLang !== 'guj' && !pathSuggestsGujarati(docPath);
  };
  for (const id of ids) {
    const libs = await SOPLibrary.find(sopIdentifierMatchFilter(id, 'identifier'))
      .select('sopDocuments language fileUrl fileType')
      .sort({ uploadedAt: -1 })
      .lean();
    /** Pass 1: only docs whose own language matches. Pass 2: any doc (legacy rows with no per-doc language). */
    for (const strictLang of [true, false]) {
      for (const row of orderLibraryRowsByLanguage(libs, wantGuj)) {
        const rowFileUrl = (row as { fileUrl?: string }).fileUrl?.trim();
        const rowKind = rowFileUrl
          ? fileKindFromStoredPath(rowFileUrl, (row as { fileType?: string }).fileType)
          : null;
        for (const d of row.sopDocuments || []) {
          const entry = d as { filePath?: string; fileType?: string; documentKind?: string };
          /** The row's fileUrl is the file of record (re-uploads and rechecks rewrite it); its
           *  main-document entry can lag behind and still point at the previous upload. */
          const isMainEntry = entry.documentKind !== 'annexure' && entry.documentKind !== 'media';
          const entryKind = entry.filePath ? fileKindFromStoredPath(entry.filePath, entry.fileType) : null;
          const p = (isMainEntry && rowFileUrl && rowKind === entryKind ? rowFileUrl : entry.filePath)?.trim();
          if (!p || isAnnexurePath(p)) continue;
          if (fileKindFromStoredPath(p, (d as { fileType?: string }).fileType) !== wantKind) continue;
          if (strictLang && !docMatchesLanguage(d)) continue;
          if (await isLocalStoredPathReachable(p)) {
            if (!strictLang) {
              console.warn(
                `[FILE_LANG] findFirstReachablePathForIdentifiers: no ${wantGuj ? 'Gujarati' : 'English'} ${wantKind} ` +
                `tagged for "${id}" — falling back to untagged doc: ${p}`,
              );
            }
            return p;
          }
        }
      }
    }

    const sops = await SOP.find(sopIdentifierMatchFilter(id))
      .select('fileUrl fileType language name originalFileName folderPath')
      .sort({ uploadedAt: -1 })
      .lean();
    const nonAnnexureSops = sops.filter((s) => {
      const n = ((s as any).name || '') + ((s as any).originalFileName || '');
      return !/annex(ure)?/i.test(n) && !isAnnexurePath((s as any).fileUrl || '');
    });
    const sopPool = nonAnnexureSops.length ? nonAnnexureSops : sops;
    const engFirst = sopPool.filter((s) => !looksGujarati(s));
    const gujFirst = sopPool.filter((s) => looksGujarati(s));
    const ordered = wantGuj ? [...gujFirst, ...engFirst] : [...engFirst, ...gujFirst];
    const list = ordered.length ? ordered : sopPool;
    for (const s of list) {
      const url = (s as { fileUrl?: string; fileType?: string }).fileUrl?.trim();
      if (!url || isAnnexurePath(url)) continue;
      if (fileKindFromStoredPath(url, (s as { fileType?: string }).fileType) !== wantKind) continue;
      if (await isLocalStoredPathReachable(url)) return url;
    }
  }
  return null;
}

/**
 * Resolve a Word file for /dashboard/view-doc: SOPLibrary sopDocuments first (where DOCX usually lives), then SOP.
 * Prefer paths that can actually be loaded (disk, https, bunny://) so preview tokens are not minted for stale /uploads/… only.
 */
export async function resolveDocxPathForViewer(
  identifier: string | null,
  language: string | undefined,
  pathHint: string | null,
): Promise<string | null> {
  const pathTrim = (pathHint || '').trim();
  const ids = collectSopIdentifierCandidates(identifier, pathTrim);

  const reachable =
    (await findFirstReachablePathForIdentifiers(ids, language, 'docx')) ||
    (await findFirstReachablePathForIdentifiers(ids, language, 'doc'));
  if (reachable) return reachable;

  if (pathTrim) {
    const bn = path.posix.basename(normalizePath(pathTrim.split(/[?#]/)[0])).replace(/\\/g, '/');
    if (bn) {
      const g =
        (await resolveLibraryDocumentByFilenameGlobally(bn, 'docx', language)) ||
        (await resolveLibraryDocumentByFilenameGlobally(bn, 'doc', language));
      if (g && (await isLocalStoredPathReachable(g))) return g;
    }
    const byPathCode =
      (await tryResolveLibraryOrSopByPathCodes(pathTrim, 'docx', language)) ||
      (await tryResolveLibraryOrSopByPathCodes(pathTrim, 'doc', language));
    if (byPathCode) return byPathCode;

    // Last resort: if the path hint is a relative local path (uploads/…), try to map it to Bunny CDN.
    // Many older SOP records have a stale local path but the file was migrated to Bunny.
    if (!/^https?:\/\//i.test(pathTrim) && !isBunnyPath(pathTrim)) {
      const { getBunnyCdnUrl } = await import('@/lib/bunnyStorage');
      const tryHead = async (cdnRelPath: string): Promise<string | null> => {
        const url = getBunnyCdnUrl(cdnRelPath);
        if (!url) return null;
        try {
          const res = await fetch(url, { method: 'HEAD' });
          return res.ok ? url : null;
        } catch { return null; }
      };
      const normalForMap = pathTrim.replace(/^\/+/, '').replace(/\\/g, '/');
      const direct = await tryHead(normalForMap);
      if (direct) return direct;
      // Remap uploads/sop-pdfs/<Dept>/<file> or uploads/sop-library/<Dept>/.../<file> → sop-documents/<Dept>/<file>
      const sopPdfsMatch = normalForMap.match(/^uploads\/sop-pdfs\/([^/]+)\/(.+)$/i);
      if (sopPdfsMatch) {
        const remapped = await tryHead(`sop-documents/${sopPdfsMatch[1]}/${sopPdfsMatch[2]}`);
        if (remapped) return remapped;
      }
      const sopLibMatch = normalForMap.match(/^uploads\/sop-library\/([^/]+)\/.+\/([^/]+)$/i);
      if (sopLibMatch) {
        const remapped = await tryHead(`sop-documents/${sopLibMatch[1]}/${sopLibMatch[2]}`);
        if (remapped) return remapped;
      }
    }
  }

  const ex = (identifier || '').trim();
  if (ex) {
    const fb = await resolveFileUrlFromSopIdentifier(ex, language);
    if (fb) {
      const k = fileKindFromStoredPath(fb);
      if ((k === 'docx' || k === 'doc') && (await isLocalStoredPathReachable(fb))) return fb;
      // If the stored URL is a Bunny CDN URL, return it directly
      if ((k === 'docx' || k === 'doc') && isBunnyPath(fb)) return fb;
    }
  }
  return null;
}

/**
 * Search SOPVersionArtifacts (folder-upload collection) for a reachable file path.
 * These records store actual Bunny CDN URLs and are the most reliable source after migration.
 */
async function resolveFromVersionArtifacts(
  identifier: string,
  language: string | undefined,
  wantKind: 'pdf' | 'docx' | 'doc',
): Promise<string | null> {
  const wantGuj = language === 'Gujarati';
  const lang = wantGuj ? 'Gujarati' : 'English';
  const fallbackLang = wantGuj ? 'English' : 'Gujarati';
  let usedFallback = false;

  // Try exact language first, then the other as fallback (with logging)
  for (const [langIndex, langTry] of [[0, lang], [1, fallbackLang]].map(([idx, l]) => [idx as number, l as string])) {
    const vaFilter: Record<string, unknown> = {
      ...sopIdentifierMatchFilter(identifier, 'identifier'),
      language: langTry,
    };
    const docs = await SOPVersionArtifacts.find(vaFilter)
      .select('entries')
      .lean();

    // Only announce a language fallback when artifacts for the requested language are genuinely
    // absent — never when the collection simply has no rows for this identifier at all.
    if (langIndex === 1 && docs.length > 0) {
      console.warn(
        `[FILE_LANG_FALLBACK] Requested ${lang} ${wantKind} for "${identifier}" not found in ` +
        `SOPVersionArtifacts. Falling back to ${fallbackLang}.`
      );
      usedFallback = true;
    }

    for (const doc of docs) {
      const sorted = [...(doc.entries || [])].sort((a, b) => b.version - a.version);
      for (const e of sorted) {
        const candidates =
          wantKind === 'pdf'
            ? [e.pdfPath, e.docxPath]
            : [e.docxPath, e.pdfPath];
        for (const p of candidates) {
          const s = (p || '').trim();
          if (!s) continue;
          const k = fileKindFromStoredPath(s);
          if (k !== wantKind && !(wantKind !== 'pdf' && (k === 'docx' || k === 'doc'))) continue;
          if (await isLocalStoredPathReachable(s)) {
            if (usedFallback) {
              console.warn(
                `[FILE_LANG_FALLBACK] Serving ${fallbackLang} ${wantKind} (request was ${lang}): ${s}`
              );
            }
            return s;
          }
        }
      }
    }
  }
  return null;
}

/**
 * When the stored path no longer exists on disk (moved to Bunny, etc.), find the current URL/path
 * from SOPLibrary / SOP using explicit identifier and/or SOP code inferred from the filename.
 */
export type ResolveAlternateStoredLocationOptions = {
  /**
   * When the caller needs a Word file (DOCX preview), ignore a .pdf path hint so we resolve
   * library/SOP DOCX entries instead of only PDF alternates for the same identifier.
   */
  preferWordDocument?: boolean;
};

export async function resolveAlternateStoredLocation(
  filePath: string,
  identifier: string | null,
  language: string | undefined,
  opts?: ResolveAlternateStoredLocationOptions,
): Promise<string | null> {
  const trimmedPath = (filePath || '').trim();
  const hadConcretePath = Boolean(trimmedPath);
  let wantKind: 'pdf' | 'docx' | 'doc' = hadConcretePath ? fileKindFromStoredPath(trimmedPath) : 'docx';
  if (opts?.preferWordDocument && wantKind !== 'docx' && wantKind !== 'doc') {
    wantKind = 'docx';
  }

  const basenameForGlobal = hadConcretePath
    ? path.posix.basename(normalizePath(trimmedPath.split(/[?#]/)[0])).replace(/\\/g, '/')
    : '';

  const ids = collectSopIdentifierCandidates(identifier, trimmedPath);
  if (ids.length === 0) {
    if (basenameForGlobal) {
      const g = await resolveLibraryDocumentByFilenameGlobally(basenameForGlobal, wantKind, language);
      if (g) return g;
    }
    const byCode = await tryResolveLibraryOrSopByPathCodes(trimmedPath, wantKind, language);
    if (byCode) return byCode;
    return null;
  }

  // Check SOPVersionArtifacts first — these store actual Bunny CDN URLs from folder uploads.
  const ex0 = (identifier || '').trim();
  if (ex0) {
    const va = await resolveFromVersionArtifacts(ex0, language, wantKind);
    if (va) return va;
  }
  for (const id of ids) {
    const va = await resolveFromVersionArtifacts(id, language, wantKind);
    if (va) return va;
  }

  for (const id of ids) {
    const lib = await resolveLibraryDocumentPath(id, language, wantKind);
    if (lib && (await isLocalStoredPathReachable(lib))) return lib;
    const sop = await resolveSopFileUrlMatchingKind(id, language, wantKind);
    if (sop && (await isLocalStoredPathReachable(sop))) return sop;
  }

  if (hadConcretePath) {
    const bn = basenameForGlobal;
    if (bn) {
      for (const id of ids) {
        const hit = await resolveLibraryPathByBasename(id, language, bn);
        if (hit && (await isLocalStoredPathReachable(hit))) return hit;
      }
      const globalHit = await resolveLibraryDocumentByFilenameGlobally(bn, wantKind, language);
      if (globalHit && (await isLocalStoredPathReachable(globalHit))) return globalHit;
    }
  }

  const byPathCodes = await tryResolveLibraryOrSopByPathCodes(trimmedPath, wantKind, language);
  if (byPathCodes) return byPathCodes;

  if (!hadConcretePath) {
    for (const id of ids) {
      const lib =
        (await resolveLibraryDocumentPath(id, language, 'docx')) ||
        (await resolveLibraryDocumentPath(id, language, 'doc'));
      if (lib && (await isLocalStoredPathReachable(lib))) return lib;
      const sop =
        (await resolveSopFileUrlMatchingKind(id, language, 'docx')) ||
        (await resolveSopFileUrlMatchingKind(id, language, 'doc'));
      if (sop && (await isLocalStoredPathReachable(sop))) return sop;
    }
  }

  const allowKindAgnosticFallback =
    !hadConcretePath || wantKind === 'docx' || wantKind === 'doc' || wantKind === 'pdf';
  if (allowKindAgnosticFallback) {
    const ex = (identifier || '').trim();
    if (ex) {
      const fb = await resolveFileUrlFromSopIdentifier(ex, language);
      if (fb && fileKindFromStoredPath(fb) === wantKind && (await isLocalStoredPathReachable(fb))) return fb;
    }
    for (const id of ids) {
      const fb = await resolveFileUrlFromSopIdentifier(id, language);
      if (fb && fileKindFromStoredPath(fb) === wantKind && (await isLocalStoredPathReachable(fb))) return fb;
    }
  }

  const reachable = await findFirstReachablePathForIdentifiers(ids, language, wantKind);
  if (reachable) return reachable;

  // Last resort: construct a Bunny CDN URL from the stale local path and verify it's reachable.
  // Handles the common case where the file was migrated to Bunny but Mongo still has /uploads/… path.
  if (hadConcretePath && !/^https?:\/\//i.test(trimmedPath) && !isBunnyPath(trimmedPath)) {
    const { getBunnyCdnUrl } = await import('@/lib/bunnyStorage');

    const tryHead = async (cdnPath: string): Promise<string | null> => {
      const url = getBunnyCdnUrl(cdnPath);
      if (!url) return null;
      try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(8_000) });
        return res.ok ? url : null;
      } catch { return null; }
    };

    // Try 1: direct mapping (same relative path on CDN as local)
    const direct = await tryHead(trimmedPath.replace(/^\/+/, ''));
    if (direct) return direct;

    // Try 2: remap uploads/sop-pdfs/<Dept>/<file> → sop-documents/<Dept>/<file>
    // and uploads/sop-library/<Dept>/.../<file> → sop-documents/<Dept>/<file>
    const normalForMap = trimmedPath.replace(/^\/+/, '').replace(/\\/g, '/');
    const sopPdfsMatch = normalForMap.match(/^uploads\/sop-pdfs\/([^/]+)\/(.+)$/i);
    if (sopPdfsMatch) {
      const remapped = await tryHead(`sop-documents/${sopPdfsMatch[1]}/${sopPdfsMatch[2]}`);
      if (remapped) return remapped;
    }
    const sopLibMatch = normalForMap.match(/^uploads\/sop-library\/([^/]+)\/.+\/([^/]+)$/i);
    if (sopLibMatch) {
      const remapped = await tryHead(`sop-documents/${sopLibMatch[1]}/${sopLibMatch[2]}`);
      if (remapped) return remapped;
    }
    // Try 3: basename only under sop-documents/<Dept>/ (dept inferred from any segment of the path)
    const basename = path.posix.basename(normalForMap.split('?')[0]);
    if (basename) {
      const deptFromPath = normalForMap.split('/').find(
        (seg, i, arr) => i > 0 && i < arr.length - 1 && seg.length > 2 && !/^(uploads|sop-pdfs|sop-library|sop-docs|sop-docx|documents|files|public)$/i.test(seg),
      );
      if (deptFromPath) {
        const remapped = await tryHead(`sop-documents/${deptFromPath}/${basename}`);
        if (remapped) return remapped;
      }
    }
  }

  // Final fallback: search Bunny Storage API directly by identifier.
  if ((wantKind === 'docx' || wantKind === 'doc') && (identifier || '').trim()) {
    const bunnyMatch = await searchBunnyStorageForDocx((identifier || '').trim(), language);
    if (bunnyMatch) return bunnyMatch;
  }

  return null;
}

export type LoadStoredFileOptions = {
  /** When true, fetch any http(s) URL (used only for paths resolved from Mongo, not raw user ?path=). */
  trustedRemote?: boolean;
};

/**
 * Load DOCX/DOC bytes for preview: same fallbacks as PDF download (alternate paths + CDN),
 * plus Word-focused resolution when the query path points at a PDF or a stale local path.
 * When `identifier` is set, resolves from DB/CDN first so a bad `path` in the viewer token does not block preview.
 */
export async function loadWordDocumentBuffer(
  pathHint: string,
  identifier: string | null,
  language: string | undefined,
): Promise<Buffer | null> {
  const trusted: LoadStoredFileOptions = { trustedRemote: true };
  const raw = (pathHint || '').trim();
  const normalizedHint = /^https?:\/\//i.test(raw) ? raw : raw.replace(/^\/+/, '');

  const tryLoad = async (relOrUrl: string | null | undefined): Promise<Buffer | null> => {
    const s = (relOrUrl || '').trim();
    if (!s) return null;
    const p =
      /^https?:\/\//i.test(s) || s.startsWith('bunny://') ? s : s.replace(/^\/+/, '');
    return loadStoredFileBuffer(p, trusted);
  };

  /**
   * When the caller passed a Word pathHint, load it directly first.
   */
  if (normalizedHint) {
    const kind = fileKindFromStoredPath(normalizedHint);
    if (kind === 'docx' || kind === 'doc') {
      const direct = await tryLoad(normalizedHint);
      if (direct) return direct;
    }
  }

  const id = (identifier || '').trim();
  if (id) {
    const resolved = await resolveDocxPathForViewer(id, language, normalizedHint || null);
    if (resolved) {
      let buf = await tryLoad(resolved);
      if (buf) return buf;
      const alt = await resolveAlternateStoredLocation(
        resolved.replace(/^\/+/, ''),
        id,
        language,
        { preferWordDocument: true },
      );
      if (alt) {
        buf = await tryLoad(alt);
        if (buf) return buf;
      }
    }
  }

  let buf = await tryLoad(normalizedHint);
  if (buf) return buf;

  const alt2 = await resolveAlternateStoredLocation(normalizedHint, id || null, language, {
    preferWordDocument: true,
  });
  if (alt2) {
    buf = await tryLoad(alt2);
    if (buf) return buf;
  }

  return null;
}

const REMOTE_FETCH_TIMEOUT_MS = 120_000;

async function fetchRemoteFileBuffer(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      console.error('[loadStoredFileBuffer] remote fetch timed out:', url.slice(0, 120));
    } else {
      console.error('[loadStoredFileBuffer] remote fetch failed:', err);
    }
    return null;
  }
}

/**
 * Load file bytes from a stored path: local (uploads/…), bunny://, or CDN URL.
 * Raw user-supplied URLs only load when they match Bunny heuristics unless `trustedRemote` is set.
 */
export async function loadStoredFileBuffer(
  raw: string,
  opts?: LoadStoredFileOptions,
): Promise<Buffer | null> {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    if (isBunnyPath(trimmed)) {
      return fetchBunnyFile(trimmed);
    }
    if (opts?.trustedRemote) {
      return fetchRemoteFileBuffer(trimmed);
    }
    return null;
  }

  const normalized = normalizePath(trimmed);
  const cwd = process.cwd();

  const tryDisk = async (absCandidate: string): Promise<Buffer | null> => {
    try {
      await fs.access(absCandidate);
      return await fs.readFile(absCandidate);
    } catch {
      return null;
    }
  };

  let abs = await resolveFilePath(normalized);
  if (abs) {
    try {
      return await fs.readFile(abs);
    } catch {
      /* continue */
    }
  }

  const publicUnder = path.join(cwd, 'public', normalized);
  const buf = await tryDisk(publicUnder);
  if (buf) return buf;

  return null;
}
