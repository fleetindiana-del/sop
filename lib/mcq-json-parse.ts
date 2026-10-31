import {
  extractCompleteObjects,
  repairTruncatedJson,
  stripMarkdownFences,
} from "@/lib/llm-utils";
import { isMetadataOnlyMcq } from "@/lib/mcq-generation-prompts";
import { normalizeQuestionCategory, normalizeKnowledgeFactId, readFactIdFromMcq } from "@/lib/mcq-facts";

export interface ParsedMcq {
  question: string;
  optionA: string;
  optionB: string;
  optionC: string;
  optionD: string;
  correctAnswer: "A" | "B" | "C" | "D";
  explanation?: string;
  difficulty: "easy" | "medium" | "hard";
  topic?: string;
  sopReference: string;
  factId?: string;
  learningObjective?: string;
  questionCategory?: "recall" | "scenario" | "application";
}

type RawMcq = Record<string, unknown>;

/** Fix common LLM JSON mistakes before parse. */
function sanitizeJsonCandidate(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/,\s*([}\]])/g, "$1");
}

function letterFromCorrectAnswer(raw: unknown, options: [string, string, string, string]): "A" | "B" | "C" | "D" | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const upper = s.toUpperCase();
  if (/^[ABCD]$/.test(upper)) return upper as "A" | "B" | "C" | "D";
  // Option text must win over letter heuristics — "A deviation must be raised"
  // is option text, not the letter A (the old `\b[ABCD]\b` scan mis-keyed these).
  const norm = (t: string) => t.toLowerCase().replace(/[\s.,;:!?"'`()]+/g, " ").trim();
  const idx = options.findIndex((o) => o && norm(s) === norm(o));
  if (idx >= 0) return (["A", "B", "C", "D"] as const)[idx];
  // Letter-only forms: "Option B", "Answer: C", "(D)", "B)", "B.", "B: text", "B - text".
  const m = s.match(/^(?:(?:correct\s+)?(?:answer|option)\s*(?:is)?\s*[:\-]?\s*)?\(?([ABCD])(?:\)|\.|:|\s+-|\s*$)/i);
  if (m) return m[1].toUpperCase() as "A" | "B" | "C" | "D";
  return null;
}

function normalizeDifficulty(raw: unknown): "easy" | "medium" | "hard" {
  const d = String(raw ?? "medium").toLowerCase();
  if (d.includes("easy")) return "easy";
  if (d.includes("hard")) return "hard";
  return "medium";
}

function readOptions(raw: RawMcq): [string, string, string, string] {
  if (Array.isArray(raw.options) && raw.options.length >= 4) {
    return [
      String(raw.options[0] ?? "").trim(),
      String(raw.options[1] ?? "").trim(),
      String(raw.options[2] ?? "").trim(),
      String(raw.options[3] ?? "").trim(),
    ];
  }
  return [
    String(raw.optionA ?? raw.a ?? "").trim(),
    String(raw.optionB ?? raw.b ?? "").trim(),
    String(raw.optionC ?? raw.c ?? "").trim(),
    String(raw.optionD ?? raw.d ?? "").trim(),
  ];
}

function readOption(raw: RawMcq, letter: "A" | "B" | "C" | "D", idx: number): string {
  const lower = letter.toLowerCase();
  const upper = letter;
  const nested = raw.options && typeof raw.options === "object" && !Array.isArray(raw.options)
    ? (raw.options as Record<string, unknown>)
    : null;
  return String(
    raw[`option${upper}`] ??
      raw[`option_${lower}`] ??
      raw[lower] ??
      raw[upper] ??
      nested?.[upper] ??
      nested?.[lower] ??
      nested?.[`option${upper}`] ??
      "",
  ).trim();
}

/** Map one raw object from the model into a generated MCQ, or null if unusable. */
export function normalizeRawMcq(raw: RawMcq): ParsedMcq | null {
  const question = String(raw.question ?? raw.q ?? raw.stem ?? "").trim();
    if (question.length < 5) return null;
  if (isMetadataOnlyMcq(question)) return null;

  let options = readOptions(raw);
  if (options.some((o) => !o)) {
    options = [
      readOption(raw, "A", 0),
      readOption(raw, "B", 1),
      readOption(raw, "C", 2),
      readOption(raw, "D", 3),
    ];
  }
  if (options.some((o) => !o)) return null;

  const correctAnswer = letterFromCorrectAnswer(raw.correctAnswer ?? raw.correct ?? raw.answer, options);
  if (!correctAnswer) return null;

  const sopReference = String(
    raw.sopReference ??
      raw.sop_reference ??
      raw.sopExcerpt ??
      raw.sop_excerpt ??
      raw.sopQuote ??
      raw.sourceText ??
      raw.clauseId ??
      raw.clause_id ??
      raw.clause ??
      raw.ref ??
      raw.section ??
      "",
  ).trim();

  const explanation = String(
    raw.explanation ??
      raw.rationale ??
      raw.pedagogicalRationale ??
      raw.pedagogical_rationale ??
      raw.why ??
      "",
  ).trim();

  const learningObjective = String(
    raw.learning_objective ?? raw.learningObjective ?? raw.objective ?? "",
  ).trim();

  const factIdRaw = readFactIdFromMcq(raw);
  const factId =
    factIdRaw ||
    (sopReference && /^F\d{3,}$/i.test(sopReference) ? normalizeKnowledgeFactId(sopReference) : undefined);
  const questionCategory = normalizeQuestionCategory(raw.questionCategory ?? raw.question_category ?? raw.category);

  const sopRefClean =
    sopReference && factId && normalizeKnowledgeFactId(sopReference) === factId ? "" : sopReference;

  return {
    question,
    optionA: options[0],
    optionB: options[1],
    optionC: options[2],
    optionD: options[3],
    correctAnswer,
    explanation: explanation || undefined,
    learningObjective: learningObjective || undefined,
    difficulty: normalizeDifficulty(raw.difficulty),
    topic: String(raw.topic ?? "").trim() || learningObjective || undefined,
    sopReference: sopRefClean || "unknown",
    factId: factId || undefined,
    questionCategory,
  };
}

function collectRawQuestions(parsed: unknown): RawMcq[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.filter((x) => x && typeof x === "object") as RawMcq[];
  if (typeof parsed !== "object") return [];
  const obj = parsed as Record<string, unknown>;
  const q = obj.questions ?? obj.mcqs ?? obj.items ?? obj.data;
  if (Array.isArray(q)) return q.filter((x) => x && typeof x === "object") as RawMcq[];
  return [];
}

/** Parse Claude/Gemini MCQ batch JSON — salvages valid questions even when JSON is partial. */
export function parseMcqBatchJson(text: string, logPrefix = "mcq-json"): ParsedMcq[] {
  const cleaned = stripMarkdownFences(text.trim());
  const candidates = [cleaned, sanitizeJsonCandidate(cleaned)];

  for (const candidate of candidates) {
    for (const attempt of [candidate, repairTruncatedJson(candidate)]) {
      try {
        const parsed = JSON.parse(attempt);
        const raw = collectRawQuestions(parsed);
        if (raw.length === 0 && typeof parsed === "object" && parsed !== null) {
          throw new SyntaxError("Model returned empty questions array");
        }
        const questions = raw.map(normalizeRawMcq).filter((q): q is ParsedMcq => q !== null);
        if (questions.length > 0) return questions;
        if (raw.length > 0) {
          throw new SyntaxError("Model returned questions but none passed validation");
        }
      } catch (err) {
        if (err instanceof SyntaxError && err.message.includes("empty")) throw err;
        /* try next */
      }
    }

    const jsonMatch = candidate.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      for (const slice of [jsonMatch[0], repairTruncatedJson(jsonMatch[0]), sanitizeJsonCandidate(jsonMatch[0])]) {
        try {
          const parsed = JSON.parse(slice);
          const raw = collectRawQuestions(parsed);
          const questions = raw.map(normalizeRawMcq).filter((q): q is ParsedMcq => q !== null);
          if (questions.length > 0) return questions;
        } catch {
          /* try next */
        }
      }
    }
  }

  const salvaged = extractCompleteObjects(cleaned);
  const fromObjects = salvaged
    .filter((o) => o && typeof o === "object" && "question" in (o as object))
    .map((o) => normalizeRawMcq(o as RawMcq))
    .filter((q): q is ParsedMcq => q !== null);

  if (fromObjects.length > 0) {
    console.warn(`[${logPrefix}] salvaged ${fromObjects.length} MCQ(s) from malformed JSON`);
    return fromObjects;
  }

  throw new SyntaxError(`MCQ response was not valid JSON: ${cleaned.slice(0, 280)}`);
}

export function parseMcqBatchJsonLenient(text: string, logPrefix = "mcq-json"): ParsedMcq[] {
  try {
    return parseMcqBatchJson(text, logPrefix);
  } catch {
    return [];
  }
}
