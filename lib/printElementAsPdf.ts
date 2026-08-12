/**
 * Print an on-screen HTML subtree via a same-origin iframe.
 *
 * Choosing "Save as PDF" / "Microsoft Print to PDF" yields a real text PDF
 * (selectable + copyable) that matches the live Compliance Result layout.
 *
 * Reliability notes (Windows / Chrome):
 * - Keep the iframe opaque and off-screen (opacity:0 / z-index:-1 often yields
 *   blank or corrupt PDFs).
 * - Do not tear down the iframe until well after `afterprint` — removing it
 *   while the spooler still reads the document corrupts the file.
 * - Strip `[data-pdf-hide]` from the clone so interactive chrome is omitted.
 */
export async function printElementAsSelectablePdf(options: {
  element: HTMLElement;
  documentTitle: string;
}): Promise<void> {
  const { element, documentTitle } = options;

  const headParts: string[] = [];
  document.querySelectorAll('link[rel="stylesheet"]').forEach((node) => {
    headParts.push((node as HTMLLinkElement).outerHTML);
  });
  document.querySelectorAll('style').forEach((node) => {
    headParts.push(node.outerHTML);
  });

  const safeTitle = documentTitle.replace(/[<>&"]/g, '') || 'compliance-report';

  // Clone and strip interactive chrome before writing into the print frame.
  const clone = element.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('[data-pdf-hide]').forEach((n) => n.remove());
  clone.querySelectorAll('[role="dialog"], [data-radix-portal]').forEach((n) => n.remove());
  // Ensure scroll regions expand fully in the print document.
  clone.querySelectorAll('.overflow-hidden, .overflow-y-auto, .overflow-x-auto, .overflow-auto').forEach((n) => {
    const el = n as HTMLElement;
    el.style.overflow = 'visible';
    el.style.maxHeight = 'none';
    el.style.height = 'auto';
  });
  clone.style.overflow = 'visible';
  clone.style.maxHeight = 'none';
  clone.style.height = 'auto';
  clone.style.width = '100%';

  const frame = document.createElement('iframe');
  frame.setAttribute('title', 'PDF export');
  // Off-screen but fully painted — required for a valid print PDF on Chromium.
  frame.style.position = 'fixed';
  frame.style.left = '-10000px';
  frame.style.top = '0';
  frame.style.width = '820px';
  frame.style.height = '1100px';
  frame.style.border = '0';
  frame.style.opacity = '1';
  frame.style.background = '#fff';
  frame.style.pointerEvents = 'none';
  frame.style.zIndex = '0';
  document.body.appendChild(frame);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      frame.remove();
    } catch {
      /* ignore */
    }
  };

  try {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) {
      throw new Error('Could not prepare the print view. Please try again.');
    }

    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
${headParts.join('\n')}
<style>
  @page {
    size: A4;
    margin: 10mm;
  }
  html, body {
    background: #fff !important;
    margin: 0 !important;
    padding: 0 !important;
    width: 100% !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
    color-adjust: exact !important;
  }
  body {
    padding: 4mm !important;
  }
  [data-pdf-hide] { display: none !important; }
  [data-pdf-show] { display: inline-flex !important; }
  .overflow-hidden,
  .overflow-y-auto,
  .overflow-x-auto,
  .overflow-auto {
    overflow: visible !important;
    max-height: none !important;
    height: auto !important;
  }
  /* Keep finding cards readable across pages without forcing huge blank gaps. */
  [data-finding-card] {
    break-inside: auto;
    page-break-inside: auto;
  }
  [data-group-header] {
    break-after: avoid;
    page-break-after: avoid;
  }
  @media print {
    html, body { padding: 0 !important; }
    a[href]::after { content: none !important; }
  }
</style>
</head>
<body class="compliance-print-body bg-white">
${clone.outerHTML}
</body>
</html>`);
    doc.close();

    // Wait for stylesheets / fonts / images so the PDF keeps the live UI look.
    await Promise.race([
      Promise.all([
        ...Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).map(
          (link) =>
            new Promise<void>((resolve) => {
              const el = link as HTMLLinkElement;
              if (el.sheet) {
                resolve();
                return;
              }
              el.addEventListener('load', () => resolve(), { once: true });
              el.addEventListener('error', () => resolve(), { once: true });
            }),
        ),
        ...Array.from(doc.images).map(
          (img) =>
            new Promise<void>((resolve) => {
              if (img.complete) {
                resolve();
                return;
              }
              img.addEventListener('load', () => resolve(), { once: true });
              img.addEventListener('error', () => resolve(), { once: true });
            }),
        ),
        doc.fonts?.ready ?? Promise.resolve(),
      ]),
      new Promise<void>((resolve) => window.setTimeout(resolve, 4000)),
    ]);

    // Extra settle time for Tailwind / layout reflow inside the iframe.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 400));

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        // Keep the iframe alive long enough for the print spooler to finish
        // reading HTML — removing it too early produces unreadable PDFs.
        window.setTimeout(resolve, 1500);
      };

      win.addEventListener('afterprint', settle, { once: true });
      // Fallback if afterprint never fires (some Windows print drivers).
      window.setTimeout(settle, 180_000);

      try {
        win.focus();
        // Defer one frame so the iframe document is fully painted.
        window.requestAnimationFrame(() => {
          try {
            win.print();
          } catch (err) {
            settle();
            reject(err);
          }
        });
      } catch (err) {
        settle();
        reject(err);
      }
    });
  } finally {
    cleanup();
  }
}
