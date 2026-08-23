import { ensurePdfNodePolyfills } from "@/lib/pdf-node-polyfill";

export type ExtractedPdfText = {
  text: string;
  pages: string[];
  pageCount: number;
};

type PdfParseCtor = new (options: { data: Buffer | Uint8Array }) => {
  getText: () => Promise<{
    text?: string;
    total?: number;
    pages?: Array<{ text?: string }>;
  }>;
  destroy: () => Promise<void>;
};

let pdfParseLoad: Promise<{ PDFParse: PdfParseCtor }> | null = null;

async function loadPdfParse(): Promise<{ PDFParse: PdfParseCtor }> {
  await ensurePdfNodePolyfills();
  pdfParseLoad ??= import("pdf-parse") as Promise<{ PDFParse: PdfParseCtor }>;
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
