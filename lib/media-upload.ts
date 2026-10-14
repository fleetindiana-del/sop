import { createHash } from "crypto";
import { connectDB } from "@/lib/mongodb";
import SOP, { type ISOP } from "@/models/SOP";
import { asMediaArray } from "@/lib/sop-utils";
import { detectLanguageFromFilename, saveMediaFile } from "@/lib/upload";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { logSopAudit, snapshotSop } from "@/lib/audit-log";
import { resolveSopUploadTarget, type SopMatchCandidate } from "@/lib/sop-upload-match";

type MediaKind = "video" | "slide" | "thumbnail";

type MediaResult = {
  file: string;
  success: boolean;
  identifier?: string;
  error?: string;
  kind?: MediaKind;
  /** Informational message for a successful upload (version remap, already attached…). */
  note?: string;
  /** Same file already attached to this SOP version — nothing uploaded, counts unchanged. */
  skipped?: boolean;
  /** The SOP / version could not be determined confidently — the user must pick one. */
  needsConfirmation?: boolean;
  candidates?: SopMatchCandidate[];
};

function langKey(language: string): "en" | "gu" {
  return language === "Gujarati" ? "gu" : "en";
}

function sameLanguage(a: string | undefined, language: string) {
  return langKey(a ?? "English") === langKey(language);
}

/** One audit entry per SOP for a media change — the registry shows one row per SOP. */
async function logMediaChange(
  recordId: unknown,
  previous: Record<string, unknown>,
  comments: string,
) {
  const after = await SOP.findById(recordId).lean();
  if (!after) return;
  await logSopAudit({ action: "updated", sop: after, previous, comments });
}

/** True when this exact file (by content) is already attached to the given version. */
function alreadyAttached(
  group: ISOP[],
  mediaKind: "video" | "slide",
  language: string,
  checksum: string,
) {
  return group.some((record) =>
    (record.sopDocuments ?? []).some(
      (doc) =>
        doc.fileType === mediaKind &&
        doc.checksum === checksum &&
        sameLanguage(doc.language, language) &&
        Boolean(doc.filePath),
    ),
  );
}

async function attachMedia(
  group: ISOP[],
  language: "English" | "Gujarati",
  mediaKind: "video" | "slide",
  fileUrl: string,
  fileName: string,
  checksum: string,
) {
  const auditPrevious = snapshotSop(group[0]);
  const key = langKey(language);
  const mediaField = mediaKind === "video" ? "videos" : "slides";

  for (const record of group) {
    const existingDocs = record.sopDocuments ?? [];
    // A re-upload of the same file (same name, or same content under another name)
    // replaces the earlier entry so it is counted once.
    const replaces = (doc: (typeof existingDocs)[number]) =>
      doc.fileType === mediaKind &&
      (doc.fileName === fileName ||
        (doc.checksum === checksum && sameLanguage(doc.language, language)));
    const staleUrls = new Set(
      existingDocs
        .filter(replaces)
        .map((doc) => doc.filePath)
        .filter((url): url is string => Boolean(url) && url !== fileUrl),
    );
    const sopDocuments = [
      ...existingDocs.filter((doc) => !replaces(doc)),
      {
        fileName,
        filePath: fileUrl,
        fileType: mediaKind,
        language,
        documentKind: "media" as const,
        checksum,
      },
    ];

    const mediaLinks = record.mediaLinks ?? {};
    const currentUrls = asMediaArray(mediaLinks[mediaField]?.[key]).filter(
      (url) => !staleUrls.has(url),
    );
    const nextUrls = currentUrls.includes(fileUrl) ? currentUrls : [...currentUrls, fileUrl];

    await record.updateOne({
      sopDocuments,
      mediaLinks: {
        ...mediaLinks,
        [mediaField]: {
          ...mediaLinks[mediaField],
          [key]: nextUrls,
        },
      },
    });
  }

  await logMediaChange(
    group[0]._id,
    auditPrevious,
    `Attached ${mediaKind === "video" ? "video" : "slide"} (${language}): ${fileName}`,
  );
}

async function attachThumbnail(group: ISOP[], fileUrl: string) {
  const auditPrevious = snapshotSop(group[0]);
  await Promise.all(
    group.map((record) =>
      record.updateOne({
        mediaLinks: {
          ...record.mediaLinks,
          thumbnail: fileUrl,
        },
      }),
    ),
  );

  await logMediaChange(group[0]._id, auditPrevious, "Updated thumbnail");
}

/**
 * Resolve the SOP a media file belongs to and the version it attaches to.
 *
 * Media always attaches to the family's CURRENT version — the one the registry,
 * dashboard and LMS read. A file named for an older revision (QAGE02-08-Brief.mp4
 * while the registry is on QAGE02-09) still attaches to the current version. A file
 * named for a revision NEWER than any uploaded SOP document needs confirmation:
 * that revision has no registry record yet, so it cannot become the primary version
 * from a video/slide alone.
 */
async function resolveMediaTarget(
  fileName: string,
  explicitIdentifier: string | undefined,
  kind: MediaKind,
) {
  const match = await resolveSopUploadTarget(explicitIdentifier || fileName, {
    explicit: Boolean(explicitIdentifier),
  });

  if (match.status !== "matched") {
    return {
      ok: false as const,
      result: {
        file: fileName,
        success: false,
        kind,
        identifier: match.requestedIdentifier,
        error: match.reason,
        needsConfirmation: match.candidates.length > 0,
        candidates: match.candidates,
      } satisfies MediaResult,
    };
  }

  if (match.relation === "newer" && !explicitIdentifier) {
    return {
      ok: false as const,
      result: {
        file: fileName,
        success: false,
        kind,
        identifier: match.requestedIdentifier,
        error:
          `${match.requestedIdentifier} is newer than the registry's current version ` +
          `(${match.identifier}). Upload the v${match.requestedVersion} SOP document first so it ` +
          `becomes the primary version, or confirm to attach this file to ${match.identifier}.`,
        needsConfirmation: true,
        candidates: [
          {
            identifier: match.identifier,
            name: match.current[0]?.name ?? "",
            version: match.currentVersion,
            department: match.current[0]?.department ?? "",
          },
        ],
      } satisfies MediaResult,
    };
  }

  const note =
    match.relation === "older"
      ? `Named for v${match.requestedVersion}; attached to current version ${match.identifier}`
      : match.requestedIdentifier.toUpperCase() !== match.identifier.toUpperCase() &&
          match.relation !== "unspecified"
        ? `Matched to registry SOP ${match.identifier}`
        : undefined;

  return { ok: true as const, match, note };
}

async function processMediaFile(
  file: File,
  mediaKind: "video" | "slide",
  explicitIdentifier: string | undefined,
): Promise<MediaResult> {
  try {
    const resolved = await resolveMediaTarget(file.name, explicitIdentifier, mediaKind);
    if (!resolved.ok) return resolved.result;
    const { match, note } = resolved;

    const language = detectLanguageFromFilename(file.name);
    const checksum = createHash("sha256")
      .update(Buffer.from(await file.arrayBuffer()))
      .digest("hex");

    if (alreadyAttached(match.current, mediaKind, language, checksum)) {
      return {
        file: file.name,
        success: true,
        skipped: true,
        kind: mediaKind,
        identifier: match.identifier,
        note: `Already attached to ${match.identifier} — not counted twice`,
      };
    }

    // Store under the registry's own identifier so naming variants share one path.
    const { fileUrl } = await saveMediaFile(
      file,
      match.current[0].department,
      match.identifier,
      language,
      mediaKind,
    );
    await attachMedia(match.current, language, mediaKind, fileUrl, file.name, checksum);

    return { file: file.name, success: true, kind: mediaKind, identifier: match.identifier, note };
  } catch (err) {
    return {
      file: file.name,
      success: false,
      kind: mediaKind,
      error: err instanceof Error ? err.message : "Upload failed",
    };
  }
}

export async function processMediaUpload(formData: FormData) {
  await connectDB();

  const videos = formData.getAll("videos") as File[];
  const slides = formData.getAll("slides") as File[];
  const thumbnail = formData.get("thumbnail") as File | null;
  const explicitIdentifier = (formData.get("identifier") as string | null)?.trim() || undefined;

  const results: MediaResult[] = [];

  for (const file of videos) {
    if (!file?.size) continue;
    results.push(await processMediaFile(file, "video", explicitIdentifier));
  }

  for (const file of slides) {
    if (!file?.size) continue;
    results.push(await processMediaFile(file, "slide", explicitIdentifier));
  }

  if (thumbnail?.size) {
    try {
      const matchedIdentifiers = [
        ...new Set(results.filter((r) => r.success && r.identifier).map((r) => r.identifier!)),
      ];
      const identifier =
        explicitIdentifier || (matchedIdentifiers.length === 1 ? matchedIdentifiers[0] : "");

      if (!identifier) {
        results.push({
          file: thumbnail.name,
          success: false,
          kind: "thumbnail",
          error:
            matchedIdentifiers.length > 1
              ? "This batch matched several SOPs — upload the thumbnail with one SOP's videos"
              : "Upload videos or slides first so the thumbnail can be matched to an SOP",
        });
      } else {
        const resolved = await resolveMediaTarget(thumbnail.name, identifier, "thumbnail");
        if (!resolved.ok) {
          results.push(resolved.result);
        } else {
          const { match } = resolved;
          const language = detectLanguageFromFilename(thumbnail.name);
          const { fileUrl } = await saveMediaFile(
            thumbnail,
            match.current[0].department,
            match.identifier,
            language,
            "thumbnail",
          );
          await attachThumbnail(match.current, fileUrl);
          results.push({
            file: thumbnail.name,
            success: true,
            kind: "thumbnail",
            identifier: match.identifier,
          });
        }
      }
    } catch (err) {
      results.push({
        file: thumbnail.name,
        success: false,
        kind: "thumbnail",
        error: err instanceof Error ? err.message : "Thumbnail upload failed",
      });
    }
  }

  if (results.some((r) => r.success && !r.skipped)) {
    invalidateDashboardSopsCache();
  }

  return { results };
}
