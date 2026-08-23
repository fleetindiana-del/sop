import { connectDB } from "@/lib/mongodb";
import SOP from "@/models/SOP";
import { asMediaArray, extractIdentifierFromFilename } from "@/lib/sop-utils";
import { detectLanguageFromFilename, saveMediaFile } from "@/lib/upload";
import { invalidateDashboardSopsCache } from "@/lib/server-cache";
import { logSopAudit, snapshotSop } from "@/lib/audit-log";

type MediaResult = {
  file: string;
  success: boolean;
  identifier?: string;
  error?: string;
};

function identifierRegex(identifier: string) {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(`^${escaped}$`, "i");
}

async function findSopGroup(identifier: string) {
  return SOP.find({ identifier: identifierRegex(identifier) });
}

function langKey(language: string): "en" | "gu" {
  return language === "Gujarati" ? "gu" : "en";
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

async function attachMedia(
  identifier: string,
  language: "English" | "Gujarati",
  mediaKind: "video" | "slide",
  fileUrl: string,
  fileName: string,
) {
  const group = await findSopGroup(identifier);
  if (!group.length) return false;

  const auditPrevious = snapshotSop(group[0]);
  const key = langKey(language);
  const mediaField = mediaKind === "video" ? "videos" : "slides";

  for (const record of group) {
    const existingDocs = record.sopDocuments ?? [];
    const sopDocuments = [
      ...existingDocs.filter(
        (doc) => !(doc.fileType === mediaKind && doc.fileName === fileName),
      ),
      {
        fileName,
        filePath: fileUrl,
        fileType: mediaKind,
        language,
      },
    ];

    const mediaLinks = record.mediaLinks ?? {};
    const currentUrls = asMediaArray(mediaLinks[mediaField]?.[key]);
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

  return true;
}

async function attachThumbnail(identifier: string, fileUrl: string) {
  const group = await findSopGroup(identifier);
  if (!group.length) return false;

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

  return true;
}

export async function processMediaUpload(formData: FormData) {
  await connectDB();

  const videos = formData.getAll("videos") as File[];
  const slides = formData.getAll("slides") as File[];
  const thumbnail = formData.get("thumbnail") as File | null;
  const explicitIdentifier = (formData.get("identifier") as string | null)?.trim();

  const results: MediaResult[] = [];
  const touchedIdentifiers = new Set<string>();

  for (const file of videos) {
    if (!file?.size) continue;
    try {
      const identifier = explicitIdentifier || extractIdentifierFromFilename(file.name);
      const language = detectLanguageFromFilename(file.name);
      const group = await findSopGroup(identifier);
      if (!group.length) {
        results.push({ file: file.name, success: false, error: `SOP not found: ${identifier}` });
        continue;
      }

      const { fileUrl } = await saveMediaFile(
        file,
        group[0].department,
        identifier,
        language,
        "video",
      );
      const attached = await attachMedia(identifier, language, "video", fileUrl, file.name);
      if (!attached) {
        results.push({ file: file.name, success: false, error: `Failed to attach to ${identifier}` });
        continue;
      }

      touchedIdentifiers.add(identifier);
      results.push({ file: file.name, success: true, identifier });
    } catch (err) {
      results.push({
        file: file.name,
        success: false,
        error: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  for (const file of slides) {
    if (!file?.size) continue;
    try {
      const identifier = explicitIdentifier || extractIdentifierFromFilename(file.name);
      const language = detectLanguageFromFilename(file.name);
      const group = await findSopGroup(identifier);
      if (!group.length) {
        results.push({ file: file.name, success: false, error: `SOP not found: ${identifier}` });
        continue;
      }

      const { fileUrl } = await saveMediaFile(
        file,
        group[0].department,
        identifier,
        language,
        "slide",
      );
      const attached = await attachMedia(identifier, language, "slide", fileUrl, file.name);
      if (!attached) {
        results.push({ file: file.name, success: false, error: `Failed to attach to ${identifier}` });
        continue;
      }

      touchedIdentifiers.add(identifier);
      results.push({ file: file.name, success: true, identifier });
    } catch (err) {
      results.push({
        file: file.name,
        success: false,
        error: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  if (thumbnail?.size) {
    try {
      const identifier =
        explicitIdentifier ||
        results.find((r) => r.success && r.identifier)?.identifier ||
        (touchedIdentifiers.size === 1 ? [...touchedIdentifiers][0] : "");

      if (!identifier) {
        results.push({
          file: thumbnail.name,
          success: false,
          error: "Upload videos or slides first so the thumbnail can be matched to an SOP",
        });
      } else {
        const group = await findSopGroup(identifier);
        if (!group.length) {
          results.push({ file: thumbnail.name, success: false, error: `SOP not found: ${identifier}` });
        } else {
          const language = detectLanguageFromFilename(thumbnail.name);
          const { fileUrl } = await saveMediaFile(
            thumbnail,
            group[0].department,
            identifier,
            language,
            "thumbnail",
          );
          await attachThumbnail(identifier, fileUrl);
          results.push({ file: thumbnail.name, success: true, identifier });
        }
      }
    } catch (err) {
      results.push({
        file: thumbnail.name,
        success: false,
        error: err instanceof Error ? err.message : "Thumbnail upload failed",
      });
    }
  }

  if (results.some((r) => r.success)) {
    invalidateDashboardSopsCache();
  }

  return { results };
}
