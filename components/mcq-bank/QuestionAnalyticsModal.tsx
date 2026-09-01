"use client";

import { useState } from "react";
import {
  BookOpen,
  CheckCircle2,
  Edit2,
  Languages,
  Loader2,
  MessageSquare,
  Paperclip,
  RotateCcw,
  Save,
  Sparkles,
  Star,
  X,
} from "lucide-react";

interface McqTranslation {
  question: string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
  sopReference?: string;
  isStale?: boolean;
}

interface MCQ {
  question: string;
  difficulty?: "Easy" | "Medium" | "Hard" | string;
  options: string[];
  correctAnswer: string;
  explanation?: string;
  sopReference?: string;
  isChecked?: boolean;
  isReviewed?: boolean;
  isSimilar?: boolean;
  fromAnnexure?: boolean;
  isCreative?: boolean;
  translations?: Record<string, McqTranslation | undefined>;
}

function isAnnexureMcq(mcq: Pick<MCQ, "fromAnnexure" | "question">): boolean {
  if (mcq.fromAnnexure) return true;
  return /\bAnnexure[-–—\s]*([IVXLC]+|\d+)\b/i.test(mcq.question ?? "");
}

function isCreativeMcq(mcq: Pick<MCQ, "isCreative">): boolean {
  return Boolean(mcq.isCreative);
}

function displayDifficulty(raw: unknown): "Easy" | "Medium" | "Hard" {
  const s = String(raw ?? "").toLowerCase();
  if (s === "easy") return "Easy";
  if (s === "hard") return "Hard";
  if (raw === "Easy" || raw === "Medium" || raw === "Hard") return raw;
  return "Medium";
}

interface QuestionAnalyticsModalProps {
  mcq: MCQ;
  index: number;
  bankId: string;
  sopIdentifier: string;
  /** Language the viewer is showing. "GU" renders this question's Gujarati
   *  translation — the same question, not a different one. */
  lang?: "EN" | "GU";
  onClose: () => void;
  onUpdated: (idx: number, patch: Partial<MCQ>) => void;
}

const DIFF_BADGE: Record<string, string> = {
  Easy:   "bg-blue-50 text-blue-600 border-blue-200",
  Medium: "bg-amber-50 text-amber-600 border-amber-200",
  Hard:   "bg-rose-50 text-rose-600 border-rose-200",
};

export function QuestionAnalyticsModal({
  mcq, index, bankId, sopIdentifier, lang = "EN", onClose, onUpdated,
}: QuestionAnalyticsModalProps) {
  // What the reader sees. Editing always targets the English master (that is what
  // /api/mcq-bank/edit-question writes), so edit mode drops back to `mcq`.
  const gu = mcq.translations?.gu;
  const showGu = lang === "GU" && !!gu;
  const view = showGu
    ? {
        question: gu!.question,
        options: gu!.options,
        correctAnswer: gu!.correctAnswer,
        // A translation made before sopReference was captured has none — the
        // master's English clause reference is better than an empty panel.
        explanation: gu!.explanation || mcq.explanation,
        sopReference: gu!.sopReference || mcq.sopReference,
      }
    : mcq;

  const [editMode, setEditMode] = useState(false);
  const [editDraft, setEditDraft] = useState<{
    question: string; options: string[]; correctAnswer: string; explanation: string;
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const difficulty = displayDifficulty(mcq.difficulty);
  const diffLabel = difficulty === "Easy" ? "E" : difficulty === "Medium" ? "M" : "H";

  function enterEdit() {
    setEditDraft({
      question: mcq.question,
      options: [...mcq.options],
      correctAnswer: mcq.correctAnswer,
      explanation: mcq.explanation ?? "",
    });
    setEditMode(true);
  }

  function cancelEdit() {
    setEditMode(false);
    setEditDraft(null);
  }

  async function saveEdit() {
    if (!editDraft) return;
    setEditSaving(true);
    try {
      const res = await fetch("/api/mcq-bank/edit-question", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bankId,
          questionIndex: index,
          question: editDraft.question,
          options: editDraft.options,
          correctAnswer: editDraft.correctAnswer,
          explanation: editDraft.explanation,
        }),
      });
      const data = await res.json();
      if (data.success) {
        onUpdated(index, {
          question: editDraft.question,
          options: editDraft.options,
          correctAnswer: editDraft.correctAnswer,
          explanation: editDraft.explanation,
        });
        setEditMode(false);
        setEditDraft(null);
      } else {
        alert("Failed to save: " + (data.error ?? "Unknown error"));
      }
    } catch {
      alert("Network error while saving.");
    } finally {
      setEditSaving(false);
    }
  }

  const options = editMode && editDraft ? editDraft.options : view.options;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-[28px] w-full max-w-3xl max-h-[92vh] flex flex-col border border-gray-200 shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Purple Header ── */}
        <div className="bg-purple-600 px-6 py-4 shrink-0 relative overflow-hidden">
          {/* subtle radial glow */}
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.08),transparent_70%)] pointer-events-none" />
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/20 backdrop-blur-md flex items-center justify-center border border-white/20 text-white font-mono font-bold shadow-lg text-sm">
                {String(index + 1).padStart(2, "0")}
              </div>
              <div>
                <h2 className="text-lg font-bold text-white tracking-tight leading-none mb-1">
                  Question Analytics
                </h2>
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-widest">
                  SOP: {sopIdentifier}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-white/20 text-white hover:bg-white/30 transition-all border border-white/20 shadow-inner"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto p-6 bg-white space-y-6">

          {/* Difficulty + Edit button row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span
                className={`w-8 h-8 flex items-center justify-center rounded-xl text-sm font-black border ${DIFF_BADGE[difficulty] ?? DIFF_BADGE.Medium}`}
                title={difficulty}
              >
                {diffLabel}
              </span>
              {isAnnexureMcq(mcq) && (
                <span
                  className="inline-flex items-center gap-1 rounded-lg border border-teal-200 bg-teal-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-teal-700"
                  title="Generated from linked annexure content"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  Annexure
                </span>
              )}
              {showGu && (
                <span
                  className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-indigo-700"
                  title="Showing this question's Gujarati translation"
                >
                  <Languages className="h-3.5 w-3.5" />
                  ગુજરાતી
                </span>
              )}
              {isCreativeMcq(mcq) && (
                <span
                  className="inline-flex items-center gap-1 rounded-lg border border-violet-200 bg-violet-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-violet-700"
                  title="Creative scenario fill near bank cap"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Creative
                </span>
              )}
            </div>
            {!editMode ? (
              <button
                onClick={enterEdit}
                className="flex items-center gap-2 px-4 py-2 bg-purple-50 hover:bg-purple-100 text-purple-700 border border-purple-200 hover:border-purple-300 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all"
              >
                <Edit2 className="h-3.5 w-3.5" />
                Edit Question
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={cancelEdit}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-50 hover:bg-gray-100 text-gray-500 border border-gray-200 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={editSaving}
                  className="flex items-center gap-2 px-4 py-2 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-xl text-[10px] font-bold uppercase tracking-widest transition-all disabled:opacity-50"
                >
                  {editSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {editSaving ? "Saving…" : "Save Changes"}
                </button>
              </div>
            )}
          </div>

          {showGu && editMode && (
            <p className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-2.5 text-[11px] font-medium text-indigo-700">
              Editing the English master. The Gujarati translation is re-made from it — regenerate the
              Gujarati translations after saving so the two stay in step.
            </p>
          )}

          {/* Question text */}
          <div className="space-y-2">
            <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em] ml-1">Question</h4>
            {editMode && editDraft ? (
              <textarea
                value={editDraft.question}
                onChange={(e) => setEditDraft((d) => d ? { ...d, question: e.target.value } : d)}
                rows={3}
                className="w-full bg-white border border-purple-200 rounded-2xl p-4 text-gray-800 text-base font-medium leading-relaxed focus:outline-none focus:ring-2 focus:ring-purple-300 resize-none transition-all"
                placeholder="Enter the question text…"
              />
            ) : (
              <h3 className="text-2xl font-bold text-gray-800 leading-tight tracking-tight flex items-start gap-2">
                <Star className="h-6 w-6 text-amber-400 fill-amber-400 shrink-0 mt-0.5" />
                {view.question}
              </h3>
            )}
          </div>

          {/* Options */}
          <div className="space-y-3">
            <h4 className="text-[10px] font-bold text-gray-400 uppercase tracking-[0.2em] ml-1">
              {editMode ? "Edit Options & Select Correct Answer" : "Proposed Options"}
            </h4>
            <div className="space-y-2.5">
              {options.map((option, oi) => {
                const label = String.fromCharCode(65 + oi);
                const isCorrect = editMode && editDraft
                  ? editDraft.correctAnswer === option || editDraft.correctAnswer === label
                  : option === view.correctAnswer;

                return (
                  <div
                    key={oi}
                    className={`group p-3 rounded-2xl flex items-center gap-3 transition-all border ${
                      isCorrect
                        ? "bg-emerald-50 border-emerald-200"
                        : "bg-gray-50 border-gray-100 hover:border-gray-200"
                    }`}
                  >
                    {editMode && editDraft ? (
                      <button
                        onClick={() => setEditDraft((d) => d ? { ...d, correctAnswer: option } : d)}
                        title={`Set option ${label} as correct answer`}
                        className={`w-8 h-8 shrink-0 rounded-xl flex items-center justify-center text-xs font-bold border transition-all ${
                          isCorrect
                            ? "bg-emerald-500 text-white border-emerald-400 shadow-lg shadow-emerald-500/20"
                            : "bg-white text-gray-500 border-gray-200 hover:border-emerald-300 hover:text-emerald-600"
                        }`}
                      >
                        {label}
                      </button>
                    ) : (
                      <div className={`w-8 h-8 shrink-0 rounded-xl flex items-center justify-center text-xs font-bold border ${
                        isCorrect
                          ? "bg-purple-600 text-white border-purple-500 shadow-sm"
                          : "bg-white text-gray-500 border-gray-200"
                      }`}>
                        {label}
                      </div>
                    )}

                    {editMode && editDraft ? (
                      <input
                        type="text"
                        value={option}
                        onChange={(e) => {
                          const newOptions = [...editDraft.options];
                          const oldVal = newOptions[oi];
                          newOptions[oi] = e.target.value;
                          const newCorrect = editDraft.correctAnswer === oldVal ? e.target.value : editDraft.correctAnswer;
                          setEditDraft((d) => d ? { ...d, options: newOptions, correctAnswer: newCorrect } : d);
                        }}
                        className={`flex-1 bg-transparent border-0 text-sm font-medium focus:outline-none placeholder-gray-400 ${isCorrect ? "text-emerald-700" : "text-gray-600"}`}
                        placeholder={`Option ${label}…`}
                      />
                    ) : (
                      <span className={`flex-1 text-base ${isCorrect ? "text-purple-700 font-semibold" : "text-gray-600"}`}>
                        {option}
                      </span>
                    )}

                    {isCorrect && (
                      <div className="ml-auto flex items-center gap-2 px-3 py-1 rounded-lg text-[10px] font-bold uppercase tracking-wider bg-purple-50 text-purple-700">
                        <CheckCircle2 className="h-3 w-3" />
                        Correct Answer
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            {editMode && (
              <p className="text-[10px] text-gray-500 ml-1">
                💡 Click a letter badge to mark it as the correct answer. Edit text directly in each row.
              </p>
            )}
          </div>

          {/* Insights: Rationale + SOP Context */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-3">
              <h4 className="text-[10px] font-bold text-purple-600 uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
                <MessageSquare className="h-3 w-3" /> Pedagogical Rationale
              </h4>
              <div className="bg-gray-50 p-4 rounded-[24px] border border-gray-100 shadow-inner min-h-[80px]">
                {editMode && editDraft ? (
                  <textarea
                    value={editDraft.explanation}
                    onChange={(e) => setEditDraft((d) => d ? { ...d, explanation: e.target.value } : d)}
                    rows={4}
                    className="w-full bg-transparent border-0 text-sm text-gray-600 leading-relaxed focus:outline-none resize-none placeholder-gray-400"
                    placeholder="Explanation / rationale for this question…"
                  />
                ) : (
                  <p className="text-sm text-gray-600 leading-relaxed">
                    {view.explanation ?? "No explanation provided for this question unit."}
                  </p>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <h4 className="text-[10px] font-bold text-blue-500 uppercase tracking-[0.2em] flex items-center gap-2 ml-1">
                <BookOpen className="h-3 w-3" /> Technical SOP Context
              </h4>
              <div className="bg-blue-50 p-4 rounded-[24px] border border-blue-100 shadow-inner italic min-h-[80px]">
                <p className="text-sm text-blue-600 leading-relaxed">
                  &quot;{view.sopReference ?? "Direct reference content is being indexed…"}&quot;
                </p>
              </div>
            </div>
          </div>

          {/* Status badges */}
          <div className="pt-4 border-t border-gray-100 flex flex-wrap gap-4">
            <div className="flex-1 min-w-[180px] flex items-center gap-3 p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div className={`p-3 rounded-xl ${mcq.isChecked ? "bg-emerald-50 text-emerald-600" : "bg-gray-100 text-gray-400"}`}>
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Quality Check</p>
                <p className={`text-sm font-bold ${mcq.isChecked ? "text-emerald-600" : "text-gray-500"}`}>
                  {mcq.isChecked ? "Successfully Approved" : "Pending Verification"}
                </p>
              </div>
            </div>
            <div className="flex-1 min-w-[180px] flex items-center gap-3 p-4 bg-gray-50 rounded-2xl border border-gray-100">
              <div className={`p-3 rounded-xl ${mcq.isReviewed ? "bg-amber-50 text-amber-600" : "bg-gray-100 text-gray-400"}`}>
                <Star className={`h-5 w-5 ${mcq.isReviewed ? "fill-current" : ""}`} />
              </div>
              <div>
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Priority Review</p>
                <p className={`text-sm font-bold ${mcq.isReviewed ? "text-amber-600" : "text-gray-500"}`}>
                  {mcq.isReviewed ? "Review Completed" : "Standard Priority"}
                </p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
