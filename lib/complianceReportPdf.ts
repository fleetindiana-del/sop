// Client-side "Export to PDF" for a compliance report.
//
// Clones the live Compliance Result DOM (same cards, badges, colors, sections)
// into a print document. Choosing "Save as PDF" / "Microsoft Print to PDF"
// produces a real text PDF — selectable, searchable, and copyable — that
// matches the on-screen layout.

import { printElementAsSelectablePdf } from '@/lib/printElementAsPdf';

type UnclipTarget = HTMLElement | null | undefined;

interface ExportOptions {
  /** Element whose full content (including overflow) should be captured. */
  element: HTMLElement;
  /** Suggested file name (used as the print document title; `.pdf` is stripped). */
  fileName: string;
  /**
   * Scroll containers whose height/overflow constraints must be removed while
   * printing so the full content is laid out instead of clipped to a viewport.
   */
  unclip?: UnclipTarget[];
}

interface SavedStyle {
  el: HTMLElement;
  cssText: string;
}

function unclipElements(targets: UnclipTarget[]): SavedStyle[] {
  const saved: SavedStyle[] = [];
  for (const el of targets) {
    if (!el) continue;
    saved.push({ el, cssText: el.style.cssText });
    el.style.height = 'auto';
    el.style.maxHeight = 'none';
    el.style.overflow = 'visible';
    el.style.overflowY = 'visible';
    el.style.overflowX = 'visible';
  }
  return saved;
}

function restoreElements(saved: SavedStyle[]): void {
  for (const { el, cssText } of saved) el.style.cssText = cssText;
}

export async function exportComplianceReportToPdf({
  element,
  fileName,
  unclip = [],
}: ExportOptions): Promise<void> {
  const saved = unclipElements([element, ...unclip]);
  // Let the browser reflow with constraints removed before we clone.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  // One more tick so expanded finding cards finish painting.
  await new Promise((r) => window.setTimeout(r, 150));

  try {
    const documentTitle = fileName.replace(/\.pdf$/i, '').trim() || 'compliance-report';
    await printElementAsSelectablePdf({
      element,
      documentTitle,
    });
  } finally {
    restoreElements(saved);
  }
}
