import SOP, { type ISOP } from "@/models/SOP";
import {
  extractIdentifierFromFilename,
  extractSopIdentifierCandidates,
  maxVersionInGroup,
  recordsForVersion,
  sopFamilyGroupKey,
  sopFamilyIdentifierRegex,
  versionFromIdentifier,
  versionNumber,
} from "@/lib/sop-utils";
import {
  expandSopIdentifierVariants,
  normalizeUnicodeHyphens,
} from "@/lib/sopIdentifierNormalize";

export type SopMatchCandidate = {
  identifier: string;
  name: string;
  version: string;
  department: string;
};

/** How the version named by the upload compares with the family's current version. */
export type SopVersionRelation = "current" | "older" | "newer" | "unspecified";

export type SopUploadMatch =
  | {
      status: "matched";
      /** Current-version, non-obsolete records of the matched SOP family. */
      current: ISOP[];
      /** Registry identifier of the current version (e.g. QAGE08-07). */
      identifier: string;
      currentVersion: string;
      requestedIdentifier: string;
      requestedVersion: string | null;
      relation: SopVersionRelation;
    }
  | {
      status: "ambiguous" | "not_found";
      requestedIdentifier?: string;
      candidates: SopMatchCandidate[];
      reason: string;
    };

/** Active records of the SOP family a code belongs to (QAGE08-07 ≡ QAGE8-7 ≡ QAGE8-8). */
async function findActiveFamily(code: string): Promise<ISOP[]> {
  const familyKey = sopFamilyGroupKey({ identifier: code });
  const rows = await SOP.find({
    identifier: { $regex: sopFamilyIdentifierRegex(code) },
    isObsolete: { $ne: true },
  });
  return rows.filter((r) => sopFamilyGroupKey(r) === familyKey);
}

function currentOf(family: ISOP[]) {
  const currentVersion = maxVersionInGroup(family);
  const current = recordsForVersion(family, currentVersion);
  // Same display rule as the registry row: the record whose code carries the current revision.
  const identifier =
    current.find((r) => {
      const fromId = versionFromIdentifier(r.identifier);
      return fromId != null && versionNumber(fromId) === versionNumber(currentVersion);
    })?.identifier ??
    current[0]?.identifier ??
    family[0].identifier;
  return { current: current.length ? current : family, currentVersion, identifier };
}

function toCandidate(family: ISOP[]): SopMatchCandidate {
  const { current, currentVersion, identifier } = currentOf(family);
  const english = current.find((r) => r.language !== "Gujarati") ?? current[0];
  return {
    identifier,
    name: english?.name ?? "",
    version: currentVersion,
    department: english?.department ?? "",
  };
}

/** Distinct SOP codes (one per family) named in a filename or explicit identifier. */
function codesFromText(text: string, explicit: boolean): string[] {
  const raw = explicit
    ? [text.trim()]
    : [
        extractIdentifierFromFilename(text),
        ...extractSopIdentifierCandidates(normalizeUnicodeHyphens(text.replace(/\.[^.]+$/, ""))),
      ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of raw) {
    if (!code) continue;
    const key = sopFamilyGroupKey({ identifier: code });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalizeUnicodeHyphens(code.trim().toUpperCase()));
  }
  return out;
}

/**
 * Resolve which registry SOP (and version) an uploaded file belongs to.
 * Shared by every media/file upload so naming variants (QAGE08-07, QAGE8-07, QAGE8-7)
 * always land on the one existing registry entry instead of creating or missing one.
 *
 * Returns `ambiguous` / `not_found` with candidates instead of guessing whenever the
 * file names several SOPs or only a near-miss (prefix typo) exists.
 */
export async function resolveSopUploadTarget(
  text: string,
  opts: { explicit?: boolean } = {},
): Promise<SopUploadMatch> {
  const codes = codesFromText(text, Boolean(opts.explicit));
  if (!codes.length) {
    return {
      status: "not_found",
      candidates: [],
      reason: "No SOP code found in the filename (e.g. QAGE08-07-Brief.mp4)",
    };
  }

  const matched: { code: string; family: ISOP[] }[] = [];
  for (const code of codes) {
    const family = await findActiveFamily(code);
    if (family.length) matched.push({ code, family });
  }

  if (matched.length > 1) {
    return {
      status: "ambiguous",
      requestedIdentifier: codes[0],
      candidates: matched.map((m) => toCandidate(m.family)),
      reason: `Filename matches ${matched.length} SOPs (${matched
        .map((m) => m.code)
        .join(", ")}) — choose the correct one`,
    };
  }

  if (matched.length === 1) {
    const { code, family } = matched[0];
    const { current, currentVersion, identifier } = currentOf(family);
    const requestedVersion = versionFromIdentifier(code);
    let relation: SopVersionRelation = "unspecified";
    if (requestedVersion != null) {
      const diff = versionNumber(requestedVersion) - versionNumber(currentVersion);
      relation = diff === 0 ? "current" : diff < 0 ? "older" : "newer";
    }
    return {
      status: "matched",
      current,
      identifier,
      currentVersion,
      requestedIdentifier: code,
      requestedVersion: requestedVersion != null ? String(parseInt(requestedVersion, 10)) : null,
      relation,
    };
  }

  // No exact family — offer near misses (e.g. MAGF ↔ MAGE prefix typos) for confirmation.
  const requested = codes[0];
  const seenFamilies = new Set<string>();
  const candidates: SopMatchCandidate[] = [];
  for (const variant of expandSopIdentifierVariants(requested)) {
    const key = sopFamilyGroupKey({ identifier: variant });
    if (seenFamilies.has(key)) continue;
    seenFamilies.add(key);
    const family = await findActiveFamily(variant);
    if (family.length) candidates.push(toCandidate(family));
  }

  return {
    status: "not_found",
    requestedIdentifier: requested,
    candidates,
    reason: candidates.length
      ? `SOP ${requested} not found — did you mean ${candidates.map((c) => c.identifier).join(" or ")}?`
      : `SOP not found: ${requested}`,
  };
}
