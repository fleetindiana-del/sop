import type { PdfSearchResolution } from '@/lib/guidelineDocSearch';
import { acceptPdfResolution } from '@/lib/guidelinePdfResolutionValidate';
const cache = new Map<string, PdfSearchResolution>();

export function pdfResolutionCacheKey(input: {
  guidelineId?: string;
  gapId?: string;
  _id?: string;
  clauseNumber?: string;
  index?: number;
}): string {
  const id = input.gapId || input._id || String(input.index ?? '');
  return [input.guidelineId, id, input.clauseNumber?.trim(), 'v2'].filter(Boolean).join(':');
}

export function getCachedPdfResolution(
  key: string,
  requirementFallback = '',
): PdfSearchResolution | null {
  const hit = cache.get(key);
  if (!hit) return null;
  const accepted = acceptPdfResolution(hit, requirementFallback);
  if (!accepted) {
    cache.delete(key);
    return null;
  }
  return accepted;
}

export function setCachedPdfResolution(
  key: string,
  resolution: PdfSearchResolution,
  requirementFallback = '',
): void {
  const accepted = acceptPdfResolution(resolution, requirementFallback);
  if (accepted) cache.set(key, accepted);
}

export function clearCachedPdfResolution(key: string): void {
  cache.delete(key);
}
