import AdmZip from "adm-zip";

/**
 * Convert a DOCX buffer into HTML for the main document body.
 * Preserves paragraphs and tables (including SOP header tables in the body)
 * better than a plain text dump; callers may fall back to mammoth on failure.
 */
export async function extractDocumentBodyHtmlFromDocx(
  buffer: Buffer,
): Promise<string> {
  const zip = new AdmZip(buffer);
  const documentXml = zip.readAsText("word/document.xml");
  if (!documentXml?.trim()) return "";

  const bodyMatch = documentXml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/i);
  if (!bodyMatch?.[1]) return "";

  return bodyXmlToHtml(bodyMatch[1]).trim();
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Collect visible text from a Word paragraph or table cell fragment. */
function extractText(xmlFragment: string): string {
  const runs = [
    ...xmlFragment.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g),
  ].map((m) => m[1]);
  return decodeXmlEntities(runs.join("")).replace(/\s+/g, " ").trim();
}

function paragraphToHtml(paraXml: string): string {
  const text = extractText(paraXml);
  if (!text) return "";
  return `<p>${escapeHtml(text)}</p>`;
}

function tableToHtml(tableXml: string): string {
  const rows = [...tableXml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map(
    (m) => m[0],
  );
  if (!rows.length) return "";

  const rowHtml = rows
    .map((rowXml) => {
      const cells = [...rowXml.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map(
        (m) => m[0],
      );
      if (!cells.length) return "";
      const cellHtml = cells
        .map((cellXml) => {
          const paras = [...cellXml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map(
            (m) => m[0],
          );
          const text = paras
            .map((p) => extractText(p))
            .filter(Boolean)
            .join(" ");
          return `<td>${escapeHtml(text)}</td>`;
        })
        .join("");
      return cellHtml ? `<tr>${cellHtml}</tr>` : "";
    })
    .filter(Boolean)
    .join("");

  return rowHtml ? `<table>${rowHtml}</table>` : "";
}

/**
 * Walk top-level body children in document order.
 * Nested w:p inside tables are handled by tableToHtml, not the paragraph pass.
 */
function bodyXmlToHtml(bodyXml: string): string {
  const parts: string[] = [];
  const tokenRe = /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[\s\S]*?<\/w:p>/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(bodyXml)) !== null) {
    const token = match[0];
    if (token.startsWith("<w:tbl")) {
      const html = tableToHtml(token);
      if (html) parts.push(html);
    } else {
      // Skip paragraphs that are nested inside a table we already emitted.
      // tokenRe finds nested w:p after the table's closing tag only when they
      // appear as siblings; nested matches inside tbl are consumed by the tbl match.
      const html = paragraphToHtml(token);
      if (html) parts.push(html);
    }
  }
  return parts.join("\n");
}
