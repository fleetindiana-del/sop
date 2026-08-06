/**
 * Deterministic verification that a suggested remediation is present in a revised SOP.
 *
 * The model is non-deterministic and tends to anchor on the section a gap was first
 * observed in (e.g. "Annexure-I"), so it can report a point as still open even when the
 * suggested clause was pasted verbatim into another part of the SOP (e.g. section 5.13.7).
 * This check scans the WHOLE revised document — main procedure and annexures — and
 * overrides the model when the suggested text is genuinely there.
 */

/** Fraction of the suggestion's word-sequence that must appear in the revised SOP. */
export const SUGGESTION_MATCH_THRESHOLD = 0.6;

/** Word-sequence length compared at a time — long enough that generic phrasing cannot match. */
const SHINGLE_SIZE = 5;

/** Below this the suggestion is too short for a sequence match to be meaningful. */
const MIN_SUGGESTION_WORDS = 12;

const EXCERPT_CHARS = 420;

type Word = { text: string; offset: number };

function wordsWithOffsets(text: string): Word[] {
  const out: Word[] = [];
  const re = /[a-z0-9]+/g;
  const lower = text.toLowerCase();
  let match: RegExpExecArray | null;
  while ((match = re.exec(lower)) !== null) {
    out.push({ text: match[0], offset: match.index });
  }
  return out;
}

function shingleKeys(words: Word[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i + SHINGLE_SIZE <= words.length; i++) {
    keys.push(
      words
        .slice(i, i + SHINGLE_SIZE)
        .map((w) => w.text)
        .join(" "),
    );
  }
  return keys;
}

export interface SuggestionMatch {
  /** True when the suggested text is present in the revised SOP beyond the threshold. */
  matched: boolean;
  /** 0–1 share of the suggestion's word sequences found in the revised document. */
  coverage: number;
  /** Sentence-ish snippet of the revised SOP where the match starts (audit evidence). */
  excerpt: string;
}

/**
 * Look for `suggestion` anywhere in `revised` (order-independent across the document,
 * tolerant of reformatting, numbering, and small wording edits).
 */
export function findSuggestedTextInRevised(
  suggestion: string,
  revised: string,
): SuggestionMatch {
  const empty: SuggestionMatch = { matched: false, coverage: 0, excerpt: "" };
  if (!suggestion?.trim() || !revised?.trim()) return empty;

  const suggestionWords = wordsWithOffsets(suggestion);
  if (suggestionWords.length < MIN_SUGGESTION_WORDS) return empty;

  const revisedWords = wordsWithOffsets(revised);
  const revisedShingles = new Map<string, number>();
  for (let i = 0; i + SHINGLE_SIZE <= revisedWords.length; i++) {
    const key = revisedWords
      .slice(i, i + SHINGLE_SIZE)
      .map((w) => w.text)
      .join(" ");
    if (!revisedShingles.has(key)) revisedShingles.set(key, revisedWords[i].offset);
  }

  const keys = shingleKeys(suggestionWords);
  if (!keys.length) return empty;

  let hits = 0;
  let firstOffset = -1;
  for (const key of keys) {
    const offset = revisedShingles.get(key);
    if (offset === undefined) continue;
    hits++;
    if (firstOffset < 0) firstOffset = offset;
  }

  const coverage = hits / keys.length;
  if (coverage < SUGGESTION_MATCH_THRESHOLD || firstOffset < 0) {
    return { matched: false, coverage, excerpt: "" };
  }

  // Back up to the start of the sentence/line the match landed in, then take a snippet.
  const windowStart = Math.max(0, firstOffset - 160);
  const boundary = revised.slice(windowStart, firstOffset).search(/[.\n][^.\n]*$/);
  const start = boundary >= 0 ? windowStart + boundary + 1 : firstOffset;
  const excerpt = revised.slice(start, start + EXCERPT_CHARS).trim();

  return { matched: true, coverage, excerpt };
}
