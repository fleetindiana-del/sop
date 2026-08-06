import fs from "fs/promises";
import path from "path";
import { createHash } from "crypto";
import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import SopFilesImportJob from "@/models/SopFilesImportJob";
import SopFilesImportManifest from "@/models/SopFilesImportManifest";
import {
  extractSopContentMetadata,
  isAnnexureFileName,
  shouldSkipImportFileName,
} from "@/lib/sop-content-metadata";
import { extractRefSopNoFromAnnexure } from "@/lib/annexure-parent-extract";
import { findAnnexureParentSop, linkAnnexureToParent } from "@/lib/sop-annexure";
import { processSopFileInput } from "@/lib/sop-upload";
import { reconcileSopVersions } from "@/lib/reconcile-sop-versions";
import { refreshFamilyPriorHeaderDateFlags } from "@/lib/prior-header-dates";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { sopIdentifierMatchFilter, normalizeSopIdentifierKey, parseRevisionFromSopIdentifier } from "@/lib/sopIdentifierNormalize";
import { extractIdentifierFromFilename, pickBestSopIdentifierFromText, sopFamilyIdentifierRegex, sopVersionFields } from "@/lib/sop-utils";
import { detectFileType } from "@/lib/upload";
import { extractTextFromBuffer } from "@/lib/extractContent";
import { resolveUploadLanguage } from "@/lib/sop-filename";

const SKIP_DIRS = new Set(["_archive", "_failed", "_obsolete", "_prior-versions"]);
const SCAN_CACHE_FILE = ".import-scan-cache.json";
const HASH_CONCURRENCY = 12;

export const IMPORT_SCOPES = ["main", "annexure", "prior"] as const;
export type ImportScope = (typeof IMPORT_SCOPES)[number];

type ScanCacheEntry = { size: number; mtimeMs: number; checksum: string };
type ScanCache = Record<string, ScanCacheEntry>;

export function parseImportScopes(input: unknown): ImportScope[] | null {
  if (input === undefined || input === null || input === "") {
    return [...IMPORT_SCOPES];
  }
  const raw = Array.isArray(input)
    ? input.map(String)
    : String(input)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  const valid = raw.filter((s): s is ImportScope =>
    (IMPORT_SCOPES as readonly string[]).includes(s),
  );
  return valid.length ? [...new Set(valid)] : null;
}

export function classifyImportFile(
  file: Pick<ScannedFile, "fileName" | "relativePath">,
): ImportScope {
  if (isAnnexureFileName(file.fileName)) return "annexure";
  if (isPriorVersionPath(file.relativePath)) return "prior";
  return "main";
}

function fileMatchesImportScope(
  file: Pick<ScannedFile, "fileName" | "relativePath">,
  scopes: ImportScope[],
): boolean {
  return scopes.includes(classifyImportFile(file));
}

export function getFilesImportDir(): string {
  // turbopackIgnore: FILES_IMPORT_DIR is runtime-only; do not NFT-trace the repo root.
  return path.resolve(
    /*turbopackIgnore: true*/ process.cwd(),
    process.env.FILES_IMPORT_DIR || "files",
  );
}

export type ScannedFile = {
  absolutePath: string;
  relativePath: string;
  fileName: string;
  size?: number;
  mtimeMs?: number;
};

function isPriorVersionPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, "/").startsWith("versions/");
}

function scanCachePath(rootDir: string): string {
  return path.join(rootDir, SCAN_CACHE_FILE);
}

async function loadScanCache(rootDir: string): Promise<ScanCache> {
  try {
    const raw = await fs.readFile(scanCachePath(rootDir), "utf8");
    const parsed = JSON.parse(raw) as ScanCache;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function saveScanCache(rootDir: string, cache: ScanCache): Promise<void> {
  try {
    await fs.writeFile(scanCachePath(rootDir), JSON.stringify(cache), "utf8");
  } catch (err) {
    console.warn("[files-import] could not save scan cache:", err);
  }
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function hashFile(absolutePath: string): Promise<string> {
  const buffer = await fs.readFile(absolutePath);
  return createHash("sha256").update(buffer).digest("hex");
}

/** Resolve checksums using path+size+mtime cache; only read files that changed. */
async function resolveFileChecksums(
  files: ScannedFile[],
  cache: ScanCache,
): Promise<{ checksums: Map<string, string>; cacheDirty: boolean }> {
  const checksums = new Map<string, string>();
  let cacheDirty = false;
  const misses: ScannedFile[] = [];

  for (const file of files) {
    const hit = cache[file.relativePath];
    if (
      hit &&
      file.size != null &&
      file.mtimeMs != null &&
      hit.size === file.size &&
      hit.mtimeMs === file.mtimeMs &&
      hit.checksum
    ) {
      checksums.set(file.relativePath, hit.checksum);
    } else {
      misses.push(file);
    }
  }

  if (misses.length) {
    await mapPool(misses, HASH_CONCURRENCY, async (file) => {
      const checksum = await hashFile(file.absolutePath);
      checksums.set(file.relativePath, checksum);
      if (file.size != null && file.mtimeMs != null) {
        cache[file.relativePath] = {
          size: file.size,
          mtimeMs: file.mtimeMs,
          checksum,
        };
        cacheDirty = true;
      }
      return checksum;
    });
  }

  return { checksums, cacheDirty };
}

function pruneScanCache(cache: ScanCache, livePaths: Set<string>): boolean {
  let dirty = false;
  for (const key of Object.keys(cache)) {
    if (!livePaths.has(key)) {
      delete cache[key];
      dirty = true;
    }
  }
  return dirty;
}

type KnownImportIndex = {
  checksums: Set<string>;
  /** sopBaseId|versionNum|language|fileType */
  slots: Set<string>;
  /** identifier|language|fileType (normalized identifier) */
  idSlots: Set<string>;
  /** identifier|fileType — language-agnostic fallback */
  idTypeSlots: Set<string>;
  /** lowercase original / annexure file names already stored */
  fileNames: Set<string>;
};

function slotKey(
  sopBaseId: string,
  versionNum: number,
  language: string,
  fileType: string,
): string {
  return `${sopBaseId}|${versionNum}|${language}|${fileType}`.toLowerCase();
}

function idSlotKey(identifier: string, language: string, fileType: string): string {
  return `${normalizeSopIdentifierKey(identifier)}|${language}|${fileType}`.toLowerCase();
}

function idTypeKey(identifier: string, fileType: string): string {
  return `${normalizeSopIdentifierKey(identifier)}|${fileType}`.toLowerCase();
}

function fileTypeFromName(name?: string | null): string | undefined {
  if (!name) return undefined;
  return detectFileType(name) || undefined;
}

function rememberSopSlot(
  known: KnownImportIndex,
  opts: {
    identifier?: string | null;
    sopBaseId?: string | null;
    versionNum?: number | null;
    language?: string | null;
    fileType?: string | null;
    checksum?: string | null;
    originalFileName?: string | null;
  },
) {
  if (opts.checksum) known.checksums.add(opts.checksum);
  if (opts.originalFileName) known.fileNames.add(opts.originalFileName.toLowerCase());

  const language = opts.language || "English";
  const fileType = opts.fileType || fileTypeFromName(opts.originalFileName);
  if (!fileType || !opts.identifier) return;

  const normalized = normalizeSopIdentifierKey(opts.identifier);
  known.idSlots.add(idSlotKey(normalized, language, fileType));
  known.idTypeSlots.add(idTypeKey(normalized, fileType));

  const fields = sopVersionFields(normalized);
  if (fields.sopBaseId && fields.versionNum != null) {
    known.slots.add(slotKey(fields.sopBaseId, fields.versionNum, language, fileType));
  }
  if (opts.sopBaseId != null && opts.versionNum != null) {
    known.slots.add(slotKey(String(opts.sopBaseId), opts.versionNum, language, fileType));
  }
}

async function loadKnownImportIndex(): Promise<KnownImportIndex> {
  const [manifestChecksums, rows] = await Promise.all([
    SopFilesImportManifest.distinct("checksum"),
    // Include obsolete — older files under versions/ are not "new"
    SOP.find(
      {},
      {
        identifier: 1,
        sopBaseId: 1,
        versionNum: 1,
        language: 1,
        fileType: 1,
        checksum: 1,
        originalFileName: 1,
        "sopDocuments.checksum": 1,
        "sopDocuments.fileName": 1,
      },
    ).lean(),
  ]);

  const known: KnownImportIndex = {
    checksums: new Set(),
    slots: new Set(),
    idSlots: new Set(),
    idTypeSlots: new Set(),
    fileNames: new Set(),
  };

  for (const c of manifestChecksums) {
    if (typeof c === "string" && c) known.checksums.add(c);
  }

  for (const row of rows) {
    rememberSopSlot(known, row);
    for (const d of row.sopDocuments ?? []) {
      if (d?.checksum) known.checksums.add(d.checksum);
      if (d?.fileName) known.fileNames.add(d.fileName.toLowerCase());
    }
  }

  return known;
}

/** Prefer a real SOP code in long Bunny-style names (never facility labels like WADHWAN-2). */
function identifierFromImportFileName(fileName: string, relativePath: string): string | undefined {
  const meta = extractSopContentMetadata({ fileName, relativePath });
  if (meta.identifier && /-\d+$/.test(meta.identifier)) {
    // extractSopContentMetadata may still normalize facility labels — re-validate
    const fromMeta = pickBestSopIdentifierFromText(meta.identifier);
    if (fromMeta) return normalizeSopIdentifierKey(fromMeta);
  }

  const fromPath = pickBestSopIdentifierFromText(`${relativePath} ${fileName}`);
  if (fromPath) return normalizeSopIdentifierKey(fromPath);

  const fromName = extractIdentifierFromFilename(fileName);
  if (fromName && /-\d+$/.test(fromName)) return normalizeSopIdentifierKey(fromName);
  return undefined;
}

/** True when this files/ entry is already represented in the registry (not a new import). */
function isFileAlreadyKnown(
  file: ScannedFile,
  checksum: string | undefined,
  known: KnownImportIndex,
): boolean {
  if (checksum && known.checksums.has(checksum)) return true;

  const lowerName = file.fileName.toLowerCase();
  if (known.fileNames.has(lowerName)) return true;

  const fileType = detectFileType(file.fileName);
  if (!fileType) return false;

  if (isAnnexureFileName(file.fileName)) {
    return false;
  }

  const language = resolveUploadLanguage(file.relativePath, "English");
  const identifier = identifierFromImportFileName(file.fileName, file.relativePath);
  if (identifier) {
    if (known.idSlots.has(idSlotKey(identifier, language, fileType))) return true;
    // Same SOP code + file type already in DB (language label may drift after re-export)
    if (known.idTypeSlots.has(idTypeKey(identifier, fileType))) return true;

    const fields = sopVersionFields(identifier);
    if (
      fields.sopBaseId &&
      fields.versionNum != null &&
      known.slots.has(slotKey(fields.sopBaseId, fields.versionNum, language, fileType))
    ) {
      return true;
    }
  }

  // Long Bunny/export names often embed the shorter originalFileName as a suffix
  if (lowerName.length > 40) {
    for (const knownName of known.fileNames) {
      if (knownName.length >= 12 && lowerName.endsWith(knownName)) return true;
    }
  }

  return false;
}

export async function scanFilesFolder(
  rootDir = getFilesImportDir(),
  scopes: ImportScope[] = [...IMPORT_SCOPES],
): Promise<ScannedFile[]> {
  const wantPrior = scopes.includes("prior");
  const results: ScannedFile[] = [];

  async function walk(dir: string, prefix = "", inVersions = false) {
    let entries: import("fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (shouldSkipImportFileName(name)) continue;
      if (name === SCAN_CACHE_FILE) continue;
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        const childInVersions = inVersions || (!prefix && name === "versions");
        if (childInVersions && !wantPrior && !inVersions) continue;
        await walk(abs, rel, childInVersions);
      } else if (entry.isFile() && detectFileType(name)) {
        const file: ScannedFile = {
          absolutePath: abs,
          relativePath: rel.replace(/\\/g, "/"),
          fileName: name,
        };
        if (!fileMatchesImportScope(file, scopes)) continue;
        try {
          const stat = await fs.stat(abs);
          file.size = stat.size;
          file.mtimeMs = Math.trunc(stat.mtimeMs);
        } catch {
          /* hash path will still work without fingerprint */
        }
        results.push(file);
      }
    }
  }

  if (scopes.length === 1 && scopes[0] === "prior") {
    await walk(path.join(rootDir, "versions"), "versions", true);
  } else {
    await walk(rootDir);
  }

  return results;
}

async function isFamilyObsolete(identifier: string): Promise<boolean> {
  const family = await SOP.find({
    ...sopIdentifierMatchFilter(identifier),
  }).lean();
  return family.length > 0 && family.every((r) => r.isObsolete);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

function isWindowsFileLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveFile(src: string, dest: string) {
  await ensureDir(path.dirname(dest));

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fs.rename(src, dest);
      return;
    } catch (renameErr) {
      if (isWindowsFileLockError(renameErr) && attempt < 7) {
        await sleep(250 * (attempt + 1));
        continue;
      }

      try {
        await fs.copyFile(src, dest);
      } catch (copyErr) {
        if (isWindowsFileLockError(copyErr) && attempt < 7) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw copyErr;
      }

      // Copy to _archive succeeded — best-effort remove source (often locked on Windows/Word).
      for (let unlinkAttempt = 0; unlinkAttempt < 5; unlinkAttempt++) {
        try {
          await fs.unlink(src);
          return;
        } catch (unlinkErr) {
          if (isWindowsFileLockError(unlinkErr) && unlinkAttempt < 4) {
            await sleep(300 * (unlinkAttempt + 1));
            continue;
          }
          if (isWindowsFileLockError(unlinkErr)) {
            return;
          }
          throw unlinkErr;
        }
      }
      return;
    }
  }
}

/** Move imported file to _archive; returns path or a warning if the DB import already succeeded. */
async function safeArchiveImportedFile(
  rootDir: string,
  scanned: ScannedFile,
): Promise<{ archivedPath?: string; warning?: string }> {
  try {
    const archivedPath = await archiveImportedFile(rootDir, scanned);
    return { archivedPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      warning: `Imported successfully but could not move file to _archive (${message}). Close the file if it is open in Word, then delete or move it manually.`,
    };
  }
}

export async function archiveImportedFile(
  rootDir: string,
  scanned: ScannedFile,
): Promise<string> {
  const dest = path.join(rootDir, "_archive", scanned.relativePath);
  await moveFile(scanned.absolutePath, dest);
  return dest;
}

/**
 * After a permanent registry delete: drop import-manifest rows and move archived
 * source files back into the files/ import root so Scan can find them again.
 */
export async function clearImportStateAfterPermanentDelete(opts: {
  identifiers: string[];
  checksums: string[];
}): Promise<{ manifestsRemoved: number; restored: string[] }> {
  await connectDB();
  const rootDir = getFilesImportDir();
  const identifiers = [...new Set(opts.identifiers.map((id) => id.trim()).filter(Boolean))];
  const checksums = [...new Set(opts.checksums.map((c) => c.trim()).filter(Boolean))];
  const idKeys = identifiers.map((id) => normalizeSopIdentifierKey(id));

  const orFilters: Record<string, unknown>[] = [];
  if (checksums.length) orFilters.push({ checksum: { $in: checksums } });
  if (idKeys.length) {
    orFilters.push({ identifier: { $in: idKeys } });
    // Family match: TEST01-0 / TEST01-01 share base TEST01
    for (const id of idKeys) {
      const base = id.replace(/-\d+$/, "");
      if (base && base !== id) {
        orFilters.push({ identifier: new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(-\\d+)?$`, "i") });
      }
    }
  }

  const manifests = orFilters.length
    ? await SopFilesImportManifest.find({ $or: orFilters }).lean()
    : [];

  const restored: string[] = [];
  const archiveRoot = path.join(rootDir, "_archive");

  for (const m of manifests) {
    const candidates: string[] = [];
    if (m.archivedPath) candidates.push(m.archivedPath);
    if (m.relativePath) {
      candidates.push(path.join(archiveRoot, m.relativePath));
      candidates.push(path.join(archiveRoot, path.basename(m.relativePath)));
    }

    const destRelative = m.relativePath || (m.archivedPath ? path.basename(m.archivedPath) : "");
    if (!destRelative) continue;
    const dest = path.join(/*turbopackIgnore: true*/ rootDir, destRelative);

    for (const src of candidates) {
      try {
        await fs.access(src);
        // Don't overwrite an existing live file
        try {
          await fs.access(dest);
          break;
        } catch {
          /* dest free */
        }
        await moveFile(src, dest);
        restored.push(dest);
        break;
      } catch {
        /* try next candidate */
      }
    }
  }

  // Fallback: archived files named like TEST01*.docx with no manifest row
  if (identifiers.length) {
    try {
      const archiveEntries = await fs.readdir(archiveRoot, { withFileTypes: true });
      for (const entry of archiveEntries) {
        if (!entry.isFile()) continue;
        const upper = entry.name.toUpperCase();
        const hit = idKeys.some((id) => {
          const base = id.replace(/-\d+$/, "");
          return upper.includes(base.toUpperCase()) || upper.includes(id.toUpperCase());
        });
        if (!hit) continue;
        const src = path.join(/*turbopackIgnore: true*/ archiveRoot, entry.name);
        const dest = path.join(/*turbopackIgnore: true*/ rootDir, entry.name);
        try {
          await fs.access(dest);
          continue;
        } catch {
          /* free */
        }
        try {
          await moveFile(src, dest);
          restored.push(dest);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* no archive dir */
    }
  }

  let manifestsRemoved = 0;
  if (orFilters.length) {
    const del = await SopFilesImportManifest.deleteMany({ $or: orFilters });
    manifestsRemoved = del.deletedCount ?? 0;
  }

  // Bust scan fingerprint cache so restored files are hashed as new
  try {
    await fs.unlink(path.join(rootDir, SCAN_CACHE_FILE));
  } catch {
    /* no cache */
  }

  return { manifestsRemoved, restored };
}

export async function routeToObsoleteFolder(
  rootDir: string,
  scanned: ScannedFile,
  identifier: string,
): Promise<string> {
  const base = identifier.split("-")[0] ?? identifier;
  const dest = path.join(rootDir, "_obsolete", base, identifier, scanned.fileName);
  await moveFile(scanned.absolutePath, dest);
  return dest;
}

export async function relocateSupersededVersion(
  rootDir: string,
  sopBaseId: string,
  identifier: string,
  archivedPaths: string[],
): Promise<string | null> {
  const destDir = path.join(rootDir, "_prior-versions", sopBaseId, identifier);
  let moved: string | null = null;
  for (const archivedPath of archivedPaths) {
    if (!archivedPath) continue;
    try {
      await fs.access(archivedPath);
      const dest = path.join(destDir, path.basename(archivedPath));
      await moveFile(archivedPath, dest);
      moved = destDir;
    } catch {
      // archived file may already have been moved
    }
  }
  return moved;
}

function sortScannedFiles(files: ScannedFile[]): ScannedFile[] {
  return [...files].sort((a, b) => {
    const aAnnex = isAnnexureFileName(a.fileName) ? 1 : 0;
    const bAnnex = isAnnexureFileName(b.fileName) ? 1 : 0;
    if (aAnnex !== bAnnex) return aAnnex - bAnnex;
    return a.relativePath.localeCompare(b.relativePath);
  });
}

export type ImportPreview = {
  importDir: string;
  scopes: ImportScope[];
  parentIdentifier?: string;
  parentFound?: boolean;
  unresolvedAnnexures: number;
  total: number;
  main: number;
  annexure: number;
  prior: number;
  pending: number;
  pendingMain: number;
  pendingAnnexure: number;
  pendingPrior: number;
  duplicate: number;
  obsolete: number;
};

function normalizeParentIdentifier(input?: string | null): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) return undefined;
  return normalizeSopIdentifierKey(trimmed);
}

export function resolveAnnexureParentIdentifier(
  meta: { parentIdentifier?: string },
  parentOverride?: string | null,
): string | undefined {
  return meta.parentIdentifier ?? normalizeParentIdentifier(parentOverride);
}

const ANNEXURE_PARENT_HINT =
  "Could not resolve parent SOP — enter parent code below, or place files in files/PARENT-CODE/";

function identifierFromMainFile(file: ScannedFile): string | undefined {
  const meta = extractSopContentMetadata({
    fileName: file.fileName,
    relativePath: file.relativePath,
  });
  if (meta.identifier && /-\d+$/.test(meta.identifier)) {
    return meta.identifier;
  }
  const fromName = extractIdentifierFromFilename(file.fileName);
  if (fromName && /-\d+$/.test(fromName)) return fromName;
  for (const segment of file.relativePath.split(/[/\\]/)) {
    const code = extractIdentifierFromFilename(segment);
    if (code && /-\d+$/.test(code)) return code;
  }
  return undefined;
}

async function parentSopAvailable(
  parentRef: string,
  rootDir: string,
  mainFiles?: ScannedFile[],
): Promise<boolean> {
  if (await findAnnexureParentSop(parentRef)) return true;

  const familyRegex = sopFamilyIdentifierRegex(parentRef);
  const scanned = mainFiles ?? (await scanFilesFolder(rootDir, ["main"]));
  return scanned.some((file) => {
    if (isAnnexureFileName(file.fileName) || isPriorVersionPath(file.relativePath)) return false;
    const id = identifierFromMainFile(file);
    return Boolean(id && familyRegex.test(id) && /-\d+$/.test(id));
  });
}

/** Import the current main SOP for a Ref. SOP family (e.g. QAGE01) from files/ when missing in DB. */
async function tryImportParentSopFromFiles(
  parentRef: string,
  rootDir: string,
  mainFiles?: ScannedFile[],
): Promise<boolean> {
  if (await findAnnexureParentSop(parentRef)) return true;

  const familyRegex = sopFamilyIdentifierRegex(parentRef);
  const scanned = mainFiles ?? (await scanFilesFolder(rootDir, ["main"]));

  const candidates = scanned
    .filter(
      (file) =>
        !isAnnexureFileName(file.fileName) &&
        detectFileType(file.fileName) === "docx" &&
        !isPriorVersionPath(file.relativePath),
    )
    .map((file) => ({ file, identifier: identifierFromMainFile(file) }))
    .filter((c): c is { file: ScannedFile; identifier: string } => {
      if (!c.identifier || !familyRegex.test(c.identifier)) return false;
      return /-\d+$/.test(c.identifier);
    })
    .sort((a, b) => {
      const va = parseRevisionFromSopIdentifier(a.identifier) ?? 0;
      const vb = parseRevisionFromSopIdentifier(b.identifier) ?? 0;
      return vb - va;
    });

  for (const { file } of candidates) {
    const buffer = await fs.readFile(file.absolutePath);
    const result = await processSopFileInput({
      buffer,
      fileName: file.fileName,
      relativePath: file.relativePath,
      skipIfChecksumMatches: true,
    });
    if (result.success || result.skipped) {
      return Boolean(await findAnnexureParentSop(parentRef));
    }
  }

  return false;
}

export async function previewFilesImport(
  rootDir = getFilesImportDir(),
  scopes: ImportScope[] = [...IMPORT_SCOPES],
  parentOverride?: string | null,
): Promise<ImportPreview> {
  await connectDB();
  const parentIdentifier = normalizeParentIdentifier(parentOverride);
  const scanned = sortScannedFiles(await scanFilesFolder(rootDir, scopes));

  const cache = await loadScanCache(rootDir);
  const [{ checksums, cacheDirty }, known] = await Promise.all([
    resolveFileChecksums(scanned, cache),
    loadKnownImportIndex(),
  ]);
  let dirty = cacheDirty;
  if (scopes.length === IMPORT_SCOPES.length) {
    dirty =
      pruneScanCache(cache, new Set(scanned.map((f) => f.relativePath))) || dirty;
  }
  if (dirty) await saveScanCache(rootDir, cache);

  let main = 0;
  let annexure = 0;
  let prior = 0;
  let duplicate = 0;
  let obsolete = 0;
  let pendingMain = 0;
  let pendingAnnexure = 0;
  let pendingPrior = 0;
  let unresolvedAnnexures = 0;
  const annexParentRefs = new Set<string>();
  const pendingAnnexFiles: ScannedFile[] = [];
  const pendingMainIds: string[] = [];

  let parentFound: boolean | undefined;
  const mainFilesForParent =
    scopes.includes("annexure") ? await scanFilesFolder(rootDir, ["main"]) : undefined;

  for (const file of scanned) {
    const isAnnex = isAnnexureFileName(file.fileName);
    const isPrior = isPriorVersionPath(file.relativePath);
    if (isAnnex) annexure++;
    else if (isPrior) prior++;
    else main++;

    const checksum = checksums.get(file.relativePath);
    if (isFileAlreadyKnown(file, checksum, known)) {
      duplicate++;
      continue;
    }

    if (isAnnex) {
      pendingAnnexure++;
      pendingAnnexFiles.push(file);
      // Cheap path/filename parent first — only open DOCX if still unresolved
      const cheapMeta = extractSopContentMetadata({
        fileName: file.fileName,
        relativePath: file.relativePath,
      });
      const cheapParent = resolveAnnexureParentIdentifier(
        { parentIdentifier: cheapMeta.parentIdentifier },
        parentIdentifier,
      );
      if (cheapParent) annexParentRefs.add(cheapParent);
    } else if (isPrior) {
      pendingPrior++;
    } else {
      pendingMain++;
      const meta = extractSopContentMetadata({
        fileName: file.fileName,
        relativePath: file.relativePath,
      });
      if (meta.identifier) pendingMainIds.push(meta.identifier);
    }
  }

  // Only open pending annexure DOCX files that still lack a parent code
  await mapPool(pendingAnnexFiles, 6, async (file) => {
    const cheapMeta = extractSopContentMetadata({
      fileName: file.fileName,
      relativePath: file.relativePath,
    });
    const cheapParent = resolveAnnexureParentIdentifier(
      { parentIdentifier: cheapMeta.parentIdentifier },
      parentIdentifier,
    );
    if (cheapParent) return;

    const fileType = detectFileType(file.fileName);
    if (fileType !== "docx") {
      unresolvedAnnexures++;
      return;
    }
    try {
      const buffer = await fs.readFile(file.absolutePath);
      const annexContent = await extractTextFromBuffer(buffer, fileType);
      const refParent = await extractRefSopNoFromAnnexure({ content: annexContent, buffer });
      const meta = extractSopContentMetadata({
        content: annexContent,
        fileName: file.fileName,
        relativePath: file.relativePath,
      });
      const resolved = resolveAnnexureParentIdentifier(
        { parentIdentifier: refParent ?? meta.parentIdentifier },
        parentIdentifier,
      );
      if (!resolved) unresolvedAnnexures++;
      else annexParentRefs.add(resolved);
    } catch {
      unresolvedAnnexures++;
    }
  });

  if (pendingMainIds.length) {
    const uniqueIds = [...new Set(pendingMainIds)];
    const obsoleteFlags = await mapPool(uniqueIds, 8, (id) => isFamilyObsolete(id));
    obsolete = obsoleteFlags.filter(Boolean).length;
  }

  const pending = pendingMain + pendingAnnexure + pendingPrior;

  if (scopes.includes("annexure") && mainFilesForParent && annexParentRefs.size) {
    parentFound = (
      await Promise.all(
        [...annexParentRefs].map((ref) => parentSopAvailable(ref, rootDir, mainFilesForParent)),
      )
    ).every(Boolean);
  }

  return {
    importDir: rootDir,
    scopes,
    parentIdentifier,
    parentFound,
    unresolvedAnnexures,
    total: scanned.length,
    main,
    annexure,
    prior,
    pending,
    pendingMain,
    pendingAnnexure,
    pendingPrior,
    duplicate,
    obsolete,
  };
}

export async function runFilesFolderImport(jobId: string): Promise<void> {
  const rootDir = getFilesImportDir();
  await connectDB();

  const job = await SopFilesImportJob.findById(jobId);
  if (!job) return;

  const scopes: ImportScope[] =
    job.scopes?.length ? (job.scopes as ImportScope[]) : [...IMPORT_SCOPES];
  const parentOverride = job.parentIdentifier;

  job.status = "running";
  job.phase = "Detecting new files…";
  job.percent = 0;
  await job.save();

  const scanned = sortScannedFiles(await scanFilesFolder(rootDir, scopes));
  const cache = await loadScanCache(rootDir);
  const [{ checksums, cacheDirty }, known] = await Promise.all([
    resolveFileChecksums(scanned, cache),
    loadKnownImportIndex(),
  ]);
  let dirty = cacheDirty;
  if (scopes.length === IMPORT_SCOPES.length) {
    dirty =
      pruneScanCache(cache, new Set(scanned.map((f) => f.relativePath))) || dirty;
  }
  let cacheNeedsSave = dirty;
  if (cacheNeedsSave) await saveScanCache(rootDir, cache);

  const seenChecksums = new Set<string>();
  const pendingFiles: Array<{ file: ScannedFile; checksum: string }> = [];
  let skippedKnown = 0;

  for (const file of scanned) {
    const checksum = checksums.get(file.relativePath);
    if (isFileAlreadyKnown(file, checksum, known)) {
      skippedKnown++;
      continue;
    }
    if (!checksum) continue;
    if (seenChecksums.has(checksum)) {
      skippedKnown++;
      continue;
    }
    seenChecksums.add(checksum);
    pendingFiles.push({ file, checksum });
  }

  job.totals.scanned = scanned.length;
  job.totals.skipped = skippedKnown;
  job.phase =
    pendingFiles.length === 0
      ? "No new files to import"
      : `Importing ${pendingFiles.length} new file(s)…`;
  await job.save();

  const mainFilesForParent = scopes.includes("annexure")
    ? await scanFilesFolder(rootDir, ["main"])
    : undefined;
  const ensuredParentRefs = new Set<string>();

  const touchedFamilies = new Set<string>();
  const familyMaxVersion = new Map<string, number>();
  const archivedByIdentifier = new Map<string, string[]>();

  for (let i = 0; i < pendingFiles.length; i++) {
    const { file, checksum } = pendingFiles[i];
    job.phase = `Processing ${i + 1}/${pendingFiles.length}: ${file.fileName}`;
    job.percent = Math.round(((i + 1) / Math.max(pendingFiles.length, 1)) * 100);

    try {
      const buffer = await fs.readFile(file.absolutePath);
      // Re-hash to confirm cache (file may have changed between scan and import)
      const liveChecksum = createHash("sha256").update(buffer).digest("hex");
      if (liveChecksum !== checksum) {
        cache[file.relativePath] = {
          size: buffer.length,
          mtimeMs: Date.now(),
          checksum: liveChecksum,
        };
        cacheNeedsSave = true;
      }
      const finalChecksum = liveChecksum;

      if (known.checksums.has(finalChecksum) || isFileAlreadyKnown(file, finalChecksum, known)) {
        job.files.push({
          relativePath: file.relativePath,
          fileName: file.fileName,
          status: "duplicate",
          checksum: finalChecksum,
          message: "Already in database",
        });
        job.totals.skipped++;
        await job.save();
        continue;
      }
      known.checksums.add(finalChecksum);

      if (isAnnexureFileName(file.fileName)) {
        try {
          const fileType = detectFileType(file.fileName);
          const annexContent =
            fileType === "docx" ? await extractTextFromBuffer(buffer, fileType) : "";
          const refParent =
            fileType === "docx"
              ? await extractRefSopNoFromAnnexure({ content: annexContent, buffer })
              : undefined;
          const meta = extractSopContentMetadata({
            content: annexContent,
            fileName: file.fileName,
            relativePath: file.relativePath,
          });
          const parentIdentifier = resolveAnnexureParentIdentifier(
            { parentIdentifier: refParent ?? meta.parentIdentifier },
            parentOverride,
          );
          if (!parentIdentifier) {
            job.files.push({
              relativePath: file.relativePath,
              fileName: file.fileName,
              status: "failed",
              message: ANNEXURE_PARENT_HINT,
            });
            job.totals.failed++;
            await job.save();
            continue;
          }

          const parentHasRevision = /-\d+$/.test(parentIdentifier);

          if (!ensuredParentRefs.has(parentIdentifier)) {
            await tryImportParentSopFromFiles(
              parentIdentifier,
              rootDir,
              mainFilesForParent,
            );
            ensuredParentRefs.add(parentIdentifier);
          }

          const linkResult = await linkAnnexureToParent({
            buffer,
            fileName: file.fileName,
            relativePath: file.relativePath,
            parentIdentifier,
            annexureLabel: meta.annexureLabel,
            versionNum: parentHasRevision ? meta.versionNum : undefined,
            checksum: finalChecksum,
            skipIfChecksumMatches: true,
          });

          if (linkResult.skipped) {
            const { warning: archiveWarning } = await safeArchiveImportedFile(rootDir, file);
            job.files.push({
              relativePath: file.relativePath,
              fileName: file.fileName,
              status: "duplicate",
              identifier: linkResult.parentIdentifier ?? parentIdentifier,
              checksum: finalChecksum,
              message: archiveWarning,
            });
            job.totals.skipped++;
          } else if (linkResult.success) {
            const { archivedPath, warning } = await safeArchiveImportedFile(rootDir, file);
            if (archivedPath) {
              await SopFilesImportManifest.create({
                relativePath: file.relativePath,
                checksum: finalChecksum,
                identifier: linkResult.parentIdentifier ?? parentIdentifier,
                documentKind: "annexure",
                jobId: job._id,
                archivedPath,
              });
            }
            job.files.push({
              relativePath: file.relativePath,
              fileName: file.fileName,
              status: "imported",
              identifier: linkResult.parentIdentifier ?? parentIdentifier,
              checksum: finalChecksum,
              message: warning ?? meta.annexureLabel,
            });
            job.totals.annexures++;
            job.totals.imported++;
          } else {
            job.files.push({
              relativePath: file.relativePath,
              fileName: file.fileName,
              status: "failed",
              identifier: parentIdentifier,
              message: linkResult.error,
            });
            job.totals.failed++;
          }
        } catch (err) {
          job.files.push({
            relativePath: file.relativePath,
            fileName: file.fileName,
            status: "failed",
            message: err instanceof Error ? err.message : "Annexure import failed",
          });
          job.totals.failed++;
        }
        await job.save();
        continue;
      }

      const isPrior = isPriorVersionPath(file.relativePath);

      const contentMeta = extractSopContentMetadata({
        fileName: file.fileName,
        relativePath: file.relativePath,
      });

      if (!isPrior && contentMeta.identifier && (await isFamilyObsolete(contentMeta.identifier))) {
        const dest = await routeToObsoleteFolder(rootDir, file, contentMeta.identifier);
        job.files.push({
          relativePath: file.relativePath,
          fileName: file.fileName,
          status: "obsolete_routed",
          identifier: contentMeta.identifier,
          checksum: finalChecksum,
          message: dest,
        });
        job.totals.obsoleteRouted++;
        await job.save();
        continue;
      }

      const result = await processSopFileInput({
        buffer,
        fileName: file.fileName,
        relativePath: file.relativePath,
        skipIfChecksumMatches: true,
      });

      if (result.skipped) {
        job.files.push({
          relativePath: file.relativePath,
          fileName: file.fileName,
          status: "duplicate",
          identifier: result.identifier,
          checksum: result.checksum,
        });
        job.totals.skipped++;
        await job.save();
        continue;
      }

      if (!result.success) {
        job.files.push({
          relativePath: file.relativePath,
          fileName: file.fileName,
          status: "failed",
          identifier: result.identifier,
          message: result.error,
        });
        job.totals.failed++;
        await job.save();
        continue;
      }

      const { archivedPath, warning } = await safeArchiveImportedFile(rootDir, file);
      if (archivedPath) {
        await SopFilesImportManifest.create({
          relativePath: file.relativePath,
          checksum: result.checksum!,
          identifier: result.identifier,
          documentKind: "main",
          jobId: job._id,
          archivedPath,
        });
      }

      if (result.sopBaseId) {
        touchedFamilies.add(result.sopBaseId);
        const prevMax = familyMaxVersion.get(result.sopBaseId) ?? -1;
        const newVer = result.versionNum ?? 0;
        if (newVer > prevMax) {
          if (prevMax >= 0) {
            const prevIdentifier = `${result.sopBaseId}-${prevMax}`;
            const paths = archivedByIdentifier.get(prevIdentifier) ?? [];
            const relocated = await relocateSupersededVersion(
              rootDir,
              result.sopBaseId,
              prevIdentifier,
              paths,
            );
            if (relocated) {
              job.files.push({
                relativePath: prevIdentifier,
                fileName: prevIdentifier,
                status: "prior_relocated",
                identifier: prevIdentifier,
                message: relocated,
              });
              job.totals.priorRelocated++;
            }
          }
          familyMaxVersion.set(result.sopBaseId, newVer);
        }
        if (result.identifier && archivedPath) {
          const list = archivedByIdentifier.get(result.identifier) ?? [];
          list.push(archivedPath);
          archivedByIdentifier.set(result.identifier, list);
        }
      }

      job.files.push({
        relativePath: file.relativePath,
        fileName: file.fileName,
        status: "imported",
        identifier: result.identifier,
        checksum: result.checksum,
        message: warning,
      });
      job.totals.imported++;
      await job.save();
    } catch (err) {
      job.files.push({
        relativePath: file.relativePath,
        fileName: file.fileName,
        status: "failed",
        message: err instanceof Error ? err.message : "Import failed",
      });
      job.totals.failed++;
      await job.save();
    }
  }

  if (cacheNeedsSave) await saveScanCache(rootDir, cache);

  job.phase = "Reconciling versions…";
  await job.save();

  try {
    await reconcileSopVersions();
    invalidateDashboardSopsCache();
    for (const sopBaseId of touchedFamilies) {
      const family = await SOP.find({ sopBaseId, isObsolete: { $ne: true } });
      if (family.length) await refreshFamilyPriorHeaderDateFlags(family);
    }
  } catch (e) {
    console.error("[files-import] post-import reconcile error:", e);
  }

  job.status = "completed";
  job.phase = "Done";
  job.percent = 100;
  job.finishedAt = new Date();
  await job.save();
}

export function startFilesImportJob(jobId: string): void {
  runFilesFolderImport(jobId).catch(async (err) => {
    console.error("[files-import] job failed:", err);
    await connectDB();
    await SopFilesImportJob.findByIdAndUpdate(jobId, {
      status: "failed",
      error: err instanceof Error ? err.message : "Import failed",
      finishedAt: new Date(),
    });
  });
}
