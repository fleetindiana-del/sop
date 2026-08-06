/**
 * Print an on-screen HTML subtree via a hidden same-origin iframe.
 * Choosing "Save as PDF" / "Microsoft Print to PDF" in the print dialog yields a
 * real text PDF (selectable + copyable), unlike html2canvas image PDFs.
 *
 * An iframe is used rather than window.open so the export never depends on the
 * pop-up blocker or on still being inside the click's user-gesture window.
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
  document.querySelectorAll("style").forEach((node) => {
    headParts.push(node.outerHTML);
  });

  const safeTitle = documentTitle.replace(/[<>&"]/g, "");

  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "1100px";
  frame.style.height = "800px";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";
  frame.style.zIndex = "-1";
  document.body.appendChild(frame);

  const cleanup = () => {
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
      throw new Error("Could not prepare the print view. Please try again.");
    }

    doc.open();
    doc.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${safeTitle}</title>
${headParts.join("\n")}
<style>
  html, body {
    background: #fff !important;
    margin: 0 !important;
    padding: 12mm !important;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  @media print {
    html, body { padding: 8mm !important; }
    a[href]::after { content: none !important; }
  }
</style>
</head>
<body class="recheck-print-body">
${element.outerHTML}
</body>
</html>`);
    doc.close();

    // Let the copied stylesheets, fonts and images settle before printing —
    // otherwise the PDF can come out unstyled.
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
              el.addEventListener("load", () => resolve(), { once: true });
              el.addEventListener("error", () => resolve(), { once: true });
            }),
        ),
        ...Array.from(doc.images).map(
          (img) =>
            new Promise<void>((resolve) => {
              if (img.complete) {
                resolve();
                return;
              }
              img.addEventListener("load", () => resolve(), { once: true });
              img.addEventListener("error", () => resolve(), { once: true });
            }),
        ),
        doc.fonts?.ready ?? Promise.resolve(),
      ]),
      new Promise<void>((resolve) => window.setTimeout(resolve, 3000)),
    ]);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250));

    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        window.setTimeout(resolve, 200);
      };
      win.addEventListener("afterprint", settle, { once: true });
      try {
        win.focus();
        win.print();
      } catch (err) {
        settle();
        throw err;
      }
      // Some browsers never fire afterprint if the user cancels oddly — don't hang forever.
      window.setTimeout(settle, 120_000);
    });
  } finally {
    cleanup();
  }
}
