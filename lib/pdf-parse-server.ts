import { ensurePdfNodePolyfills } from "@/lib/pdf-node-polyfill";

export type ExtractedPdfText = {
  text: string;
  pages: string[];
  pageCount: number;
};

type PdfParser = {
  getText: () => Promise<{
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

async function loadPdfParse(): Promise<{ PDFParse: PdfParseCtor }> {
  await ensurePdfNodePolyfills();
  pdfParseLoad ??= (async () => {
    // pdfjs Node path uses a "fake worker" that dynamically imports
    // pdf.worker.mjs. Vercel NFT does not include that sibling file, so
    // import the worker first (registers globalThis.pdfjsWorker) and also
    // point workerSrc at pdf-parse's inlined data: URL.
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    const { getData } = await import("pdf-parse/worker");
    const pdfParse = (await import("pdf-parse")) as { PDFParse: PdfParseCtor };
    pdfParse.PDFParse.setWorker(getData());
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
    const result = await parser.getText();
    return {
      text: result?.text ?? "",
      pages: (result?.pages ?? []).map((p) => p.text ?? ""),
      pageCount: result?.total ?? 1,
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
