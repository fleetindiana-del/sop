import AdmZip from "adm-zip";
import { normalizeSopIdentifierKey } from "@/lib/sopIdentifierNormalize";
import { extractTablesFromDOCX } from "@/lib/docxTableParser";

/** SOP family / base code from Ref. SOP No., Format No., etc. (may lack revision suffix). */
const REF_SOP_CODE = /([A-Z]{2,}(?:-[A-Z]{2,})?\d+)/i;

const REF_SOP_NO_TEXT =
  /Ref\.?\s*SOP\s*No\.?\s*[:.]?\s*([A-Z]{2,}(?:-[A-Z]{2,})?\d*)/i;

const FORMAT_NO_TEXT =
  /Format\s*No\.?\s*[:.]?\s*([A-Z]{2,}(?:-[A-Z]{2,})?\d*)\s*\/\s*F\d+/i;

function normalizeRefCode(raw: string): string | undefined {
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed || trimmed === "SOP" || trimmed === "NO") return undefined;
  const match = trimmed.match(REF_SOP_CODE);
  if (!match?.[1]) return undefined;
  return normalizeSopIdentifierKey(match[1]);
}

export function extractRefSopNoFromText(content: string): string | undefined {
  if (!content?.trim()) return undefined;

  const ref = content.match(REF_SOP_NO_TEXT);
  if (ref?.[1]) {
    const code = normalizeRefCode(ref[1]);
    if (code) return code;
  }

  const format = content.match(FORMAT_NO_TEXT);
  if (format?.[1]) {
    const code = normalizeRefCode(format[1]);
    if (code) return code;
  }

  return undefined;
}

/**
 * Word routinely splits a single visible token across adjacent runs with no
 * actual space between them (e.g. spell-check or a tracked edit leaves
 * "QAGE0" and "2" as separate <w:t> runs that render as "QAGE02"). Blanket
 * tag→space replacement would glue in a fake space and truncate codes like
 * that mid-number, so only insert whitespace at real word boundaries
 * (paragraph/cell ends, explicit breaks and tabs); every other tag is
 * dropped with no separator, matching what a reader actually sees.
 */
function stripXmlToText(xml: string): string {
  return xml
    .replace(/<\/w:p>|<\/w:tc>|<w:br\b[^>]*\/?>|<w:tab\b[^>]*\/?>/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolve the parent SOP code from the DOCX header Word actually displays.
 *
 * Annexure forms are routinely cloned from another SOP's form: the original
 * parent code lingers in the "default" header while the live parent is set in
 * the "first-page" header (with w:titlePg enabled, only the first-page header is
 * shown). Flattened text extraction emits the header parts up front and returns
 * the stale default-header code first, so we read the header parts directly and
 * prefer the first-page header when titlePg is set — matching what a reader sees.
 */
export function extractRefSopNoFromDocxHeaders(buffer: Buffer): string | undefined {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    return undefined;
  }

  const documentXml = zip.readAsText("word/document.xml");
  if (!documentXml) return undefined;

  const rels = zip.readAsText("word/_rels/document.xml.rels") || "";
  const headerTargetById = new Map<string, string>();
  for (const rel of rels.matchAll(/<Relationship\b[^>]*?\/?>/g)) {
    const tag = rel[0];
    const id = tag.match(/Id="([^"]+)"/)?.[1];
    const target = tag.match(/Target="([^"]+)"/)?.[1];
    if (id && target && /header/i.test(target)) {
      headerTargetById.set(id, target.replace(/^\/?word\//, ""));
    }
  }

  const targetByType: Record<string, string> = {};
  for (const ref of documentXml.matchAll(/<w:headerReference\b[^>]*?\/?>/g)) {
    const tag = ref[0];
    const type = tag.match(/w:type="([^"]+)"/)?.[1];
    const id = tag.match(/r:id="([^"]+)"/)?.[1];
    const target = id ? headerTargetById.get(id) : undefined;
    if (type && target) targetByType[type] = target;
  }

  const hasTitlePg = /<w:titlePg\b[^>]*\/?>/.test(documentXml);
  const preferred = hasTitlePg
    ? ["first", "default", "even"]
    : ["default", "first", "even"];

  const targets: string[] = [];
  for (const type of preferred) {
    const target = targetByType[type];
    if (target && !targets.includes(target)) targets.push(target);
  }
  for (const target of Object.values(targetByType)) {
    if (!targets.includes(target)) targets.push(target);
  }

  for (const target of targets) {
    const headerXml = zip.readAsText(`word/${target}`);
    if (!headerXml) continue;
    const code = extractRefSopNoFromText(stripXmlToText(headerXml));
    if (code) return code;
  }

  return undefined;
}

async function extractRefSopNoFromTables(buffer: Buffer): Promise<string | undefined> {
  const tables = await extractTablesFromDOCX(buffer);
  for (const table of tables) {
    for (const row of table.rows) {
      for (let i = 0; i < row.cells.length; i++) {
        const cell = row.cells[i] ?? "";
        if (!/ref\.?\s*sop\s*no\.?/i.test(cell)) continue;

        for (let j = i + 1; j < row.cells.length; j++) {
          const code = normalizeRefCode(row.cells[j] ?? "");
          if (code) return code;
        }
      }
    }
  }
  return undefined;
}

/** Extract parent SOP reference from annexure body text and DOCX tables. */
export async function extractRefSopNoFromAnnexure(opts: {
  content?: string;
  buffer?: Buffer;
}): Promise<string | undefined> {
  // Prefer the displayed (first-page) header over flattened text: cloned annexure
  // forms leave a stale parent code in the hidden default header that flattened
  // text would otherwise return first.
  if (opts.buffer) {
    const fromHeader = extractRefSopNoFromDocxHeaders(opts.buffer);
    if (fromHeader) return fromHeader;
  }

  const fromText = extractRefSopNoFromText(opts.content ?? "");
  if (fromText) return fromText;

  if (opts.buffer) {
    const fromTables = await extractRefSopNoFromTables(opts.buffer);
    if (fromTables) return fromTables;
  }

  return undefined;
}
