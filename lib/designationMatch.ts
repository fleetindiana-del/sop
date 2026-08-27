/** Full name + 2-letter abbr tokens so "Sr Executive" matches "SE" and vice versa. */
export function designationMatchTokens(input: string): string[] {
  const raw = String(input || '').trim();
  if (!raw) return [];
  const tokens = new Set<string>();
  for (const part of raw.split(/[;,/|]/).map((p) => p.trim()).filter(Boolean)) {
    const full = part.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (full) tokens.add(full);
    const cleaned = part.replace(/[^a-zA-Z ]/g, '').trim();
    const words = cleaned.split(/\s+/).filter(Boolean);
    let abbr = '';
    if (words.length === 1) abbr = words[0].slice(0, 2);
    else if (words.length >= 2) abbr = `${words[0][0] || ''}${words[1][0] || ''}`;
    const abbrTok = abbr.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (abbrTok) tokens.add(abbrTok);
  }
  return [...tokens];
}

export function designationSetsOverlap(
  left: string | string[],
  right: string | string[],
): boolean {
  const a = new Set(
    (Array.isArray(left) ? left : [left]).flatMap(designationMatchTokens),
  );
  if (a.size === 0) return false;
  for (const t of (Array.isArray(right) ? right : [right]).flatMap(designationMatchTokens)) {
    if (t && a.has(t)) return true;
  }
  return false;
}
