/** Roman annexure labels declared in the SOP ANNEXURES section (e.g. I, II, III). */

const ROMAN_ORDER = [
  "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X",
  "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX",
];

const DIGIT_TO_ROMAN: Record<string, string> = {
  "1": "I", "2": "II", "3": "III", "4": "IV", "5": "V",
  "6": "VI", "7": "VII", "8": "VIII", "9": "IX", "10": "X",
  "11": "XI", "12": "XII", "13": "XIII", "14": "XIV", "15": "XV",
};

const ANNEXURES_SECTION =
  /\d+\.?\d*\s*ANNEXURES?\s*:?-?\s*([\s\S]*?)(?=\n\s*\d+\.0\s+(?!Annexure|Appendix)[A-Z]|\n\s*DISTRIBUTION\s+LIST|\n\s*APPROVAL\s+MATRIX|\n\s*REFERENCE\s+SOP|$)/i;

const ANNEXURE_IN_SECTION = /(?:annex(?:ure)?s?|appendix(?:es)?)\s*[-–]?\s*([IVXLC]+|\d+)/gi;

export function normalizeAnnexureRoman(token: string): string {
  const t = token.trim().toUpperCase();
  if (DIGIT_TO_ROMAN[t]) return DIGIT_TO_ROMAN[t];
  return t;
}

export function annexureRomanFromLabel(label: string): string | undefined {
  if (!label?.trim()) return undefined;
  const match = label.match(/(?:annex(?:ure)?s?|appendix(?:es)?)\s*[-–]?\s*([IVXLC]+|\d+)/i);
  if (!match?.[1]) return undefined;
  return normalizeAnnexureRoman(match[1]);
}

export function sortAnnexureRomans(labels: string[]): string[] {
  return [...new Set(labels)].sort(
    (a, b) => ROMAN_ORDER.indexOf(a) - ROMAN_ORDER.indexOf(b) || a.localeCompare(b),
  );
}

/**
 * Parse annexure roman numerals listed under the SOP's ANNEXURES section.
 * Example lines: "5.1 Annexure-I : Air Curtain Cleaning Record"
 */
export function parseRequiredAnnexuresFromContent(content: string): string[] {
  if (!content?.trim()) return [];

  const normalized = content.replace(/\r\n/g, "\n");
  const sectionMatch = normalized.match(ANNEXURES_SECTION);
  const section = sectionMatch?.[1] ?? "";

  if (!section.trim() || !/(?:annex(?:ure)?|appendix)/i.test(section)) {
    return [];
  }

  const found: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(ANNEXURE_IN_SECTION.source, "gi");
  while ((match = re.exec(section)) !== null) {
    if (match[1]) found.push(normalizeAnnexureRoman(match[1]));
  }

  return sortAnnexureRomans(found);
}

export function collectPresentAnnexureRomans(
  annexures: { label: string; fileName?: string }[],
): Set<string> {
  const present = new Set<string>();
  for (const a of annexures) {
    const fromLabel = annexureRomanFromLabel(a.label);
    if (fromLabel) present.add(fromLabel);
    if (a.fileName) {
      const fromFile = annexureRomanFromLabel(a.fileName);
      if (fromFile) present.add(fromFile);
    }
  }
  return present;
}
