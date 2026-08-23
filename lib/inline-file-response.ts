/** True when the buffer is a PDF (magic `%PDF`, allowing a short leading BOM/junk). */
export function looksLikePdf(buffer: Buffer): boolean {
  if (!buffer?.length) return false;
  const head = buffer.subarray(0, Math.min(buffer.length, 1024)).toString("latin1");
  return head.includes("%PDF");
}

/** Serve bytes for an iframe / Chrome PDF viewer. Content-Length is required — chunked PDFs render as 0 of 0. */
export function inlineBinaryResponse(
  buffer: Buffer,
  contentType: string,
  filename: string,
): Response {
  const safeName = (filename || "document").replace(/[\r\n"]/g, "_");
  return new Response(new Uint8Array(buffer), {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.length),
      "Content-Disposition": `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    },
  });
}
