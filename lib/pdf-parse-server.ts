import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensurePdfNodePolyfills } from "@/lib/pdf-node-polyfill";

export type ExtractedPdfText = {
  text: string;
  pages: string[];
  pageCount: number;
};

type PdfParser = {
  getText: (params?: { pageJoiner?: string }) => Promise<{
    text?: string;
    total?: number;
    pages?: Array<{ text?: string }>;
  }>;
  destroy: () => Promise<void>;
};

type PdfParseCtor = (new (options: { data: Buffer | Uint8Array }) => PdfParser) & {
  setWorker: (workerSrc?: string) => string;
};

let pdfParseLoad: Promise<{ PDFParse: PdfParseCtor }> | null = null;
let workerSrcReady: Promise<string> | null = null;

/**
 * pdfjs Node uses a "fake worker" that `import()`s workerSrc. On Vercel, NFT
 * omits `pdfjs-dist/legacy/build/pdf.worker.mjs`, so never import that path.
 * Materialize pdf-parse's inlined worker to /tmp and point workerSrc there.
 */
async function resolvePdfjsWorkerSrc(): Promise<string> {
  workerSrcReady ??= (async () => {
    const { getData } = await import("pdf-parse/worker");
    const dataUrl = getData();
    const comma = dataUrl.indexOf(",");
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : "";
    const dest = join(tmpdir(), "sop-pdf.worker.mjs");
    if (b64) writeFileSync(dest, Buffer.from(b64, "base64"));
    return pathToFileURL(dest).href;
  })();

  try {
    return await workerSrcReady;
  } catch (err) {
    workerSrcReady = null;
    throw err;
  }
}

async function loadPdfParse(): Promise<{ PDFParse: PdfParseCtor }> {
  await ensurePdfNodePolyfills();
  const workerSrc = await resolvePdfjsWorkerSrc();
  pdfParseLoad ??= (async () => {
    const pdfParse = (await import("pdf-parse")) as { PDFParse: PdfParseCtor };
    pdfParse.PDFParse.setWorker(workerSrc);
    return pdfParse;
  })();
  try {
    return await pdfParseLoad;
  } catch (err) {
    pdfParseLoad = null;
    throw err;
  }
}

/** Server-only PDF text extraction. Safe to call from Node / Next.js route handlers. */
export async function extractPdfText(buffer: Buffer): Promise<ExtractedPdfText> {
  const { PDFParse } = await loadPdfParse();
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText({ pageJoiner: "" });
    return {
      text: result?.text ?? "",
      pages: (result?.pages ?? []).map((p) => p.text ?? ""),
      pageCount: result?.total ?? 1,
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
