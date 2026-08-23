import mammoth from "mammoth";
import JSZip from "jszip";

/**
 * Pull visible text from the DOCX page headers (word/header*.xml).
 *
 * mammoth.extractRawText only reads the main document body, but these SOPs keep
 * the authoritative title ("SUBJECT :") and dates ("EFF. DATE", "REVIEW DT.") in
 * the repeating page-header table. We read just the <w:t> runs so drawing-anchor
 * coordinates and field codes (PAGE / NUMPAGES) don't leak into the text.
 */
async function extractDocxHeaderText(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const headerFiles = Object.keys(zip.files)
      .filter((name) => /^word\/header\d*\.xml$/i.test(name))
      .sort();

    const decode = (s: string) =>
      s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");

    const blocks: string[] = [];
    for (const name of headerFiles) {
      const xml = await zip.file(name)!.async("string");
      // Reconstruct per paragraph: runs within a <w:p> are joined with no
      // separator (Word stores real spaces inside the runs, and a single value
      // like a date is often split across runs), then paragraphs/cells join with
      // a space. Match <w:t> / <w:t ...> runs only — not <w:tbl>, <w:tcPr>, etc.
      const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((p) => p[0]);
      const parts: string[] = [];
      for (const para of paragraphs) {
        const runs = [...para.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
        if (runs.length) parts.push(runs.join(""));
      }
      const text = decode(parts.join(" ")).replace(/\s+/g, " ").trim();
      if (text) blocks.push(text);
    }
    return blocks.join("\n");
  } catch {
    return "";
  }
}

export async function extractTextFromBuffer(
  buffer: Buffer,
  fileType: "pdf" | "docx",
): Promise<string> {
  if (fileType === "docx") {
    const [body, header] = await Promise.all([
      mammoth.extractRawText({ buffer }).then((r) => r.value.trim()),
      extractDocxHeaderText(buffer),
    ]);
    // Header first so the title/date extractors see SUBJECT / EFF. DATE up front.
    const combined = [header, body].filter(Boolean).join("\n\n");
    return combined || "[Empty DOCX content]";
  }

  try {
    const { extractPdfText } = await import("@/lib/pdf-parse-server");
    const extracted = await extractPdfText(buffer);
    const text = extracted.text.trim();
    if (text.length > 20) return text.slice(0, 50000);
  } catch (err) {
    console.warn("[extractContent] PDF parse failed; storing file without extracted text", err);
  }

  const asText = buffer.toString("utf8");
  const readable = asText.replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ").trim();
  if (readable.length > 200) return readable.slice(0, 50000);
  return "";
}

export function getContentType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "docx")
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === "mp4") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  return "application/octet-stream";
}
