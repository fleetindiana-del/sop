import { connectDB } from "@/lib/mongodb";
import mongoose from "mongoose";
import { guTranslatedProjection } from "@/lib/mcq-bank-utils";

/**
 * Shared, cached MCQ-bank aggregate rows — one unfiltered aggregation over
 * `mcqbanks` (the `$filter`-over-`mcqs` projection below is the expensive part,
 * run once here instead of separately, per-request, in both the MCQ Bank
 * registry and stats endpoints).
 *
 * Invariant: rows here are UNFILTERED and UNSCOPED by department — callers
 * apply their own `isObsolete` split and department scoping on top of these
 * rows. Never bake either into this module; both endpoints already do their
 * own scoping downstream and must keep doing so.
 */
export type RawMcqBankRow = {
  _id: unknown;
  sopIdentifier: string;
  sopName?: string;
  department?: string;
  language: string;
  isObsolete?: boolean;
  updatedAt?: Date;
  totalQuestions: number;
  checkedCount: number;
  reviewedCount: number;
  similarCount: number;
  easyCount: number;
  mediumCount: number;
  hardCount: number;
  /** Questions on this (English) bank that carry a Gujarati translation. */
  guTranslatedCount: number;
  guTranslatedChecked: number;
  guTranslatedReviewed: number;
  guTranslatedSimilar: number;
  guTranslatedEasy: number;
  guTranslatedMedium: number;
  guTranslatedHard: number;
  annexureUsage?: {
    linkedCount?: number;
    includedCount?: number;
    skippedCount?: number;
    includedLabels?: string[];
  };
};

const bankProject = {
  sopIdentifier: 1,
  sopName: 1,
  department: 1,
  language: 1,
  isObsolete: 1,
  updatedAt: 1,
  totalQuestions: { $size: { $ifNull: ["$mcqs", []] } },
  checkedCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isChecked", true] } } },
  },
  reviewedCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isReviewed", true] } } },
  },
  similarCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.isSimilar", true] } } },
  },
  easyCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.difficulty", "Easy"] } } },
  },
  mediumCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.difficulty", "Medium"] } } },
  },
  hardCount: {
    $size: { $filter: { input: { $ifNull: ["$mcqs", []] }, as: "q", cond: { $eq: ["$$q.difficulty", "Hard"] } } },
  },
  ...guTranslatedProjection,
  annexureUsage: 1,
};

let cache: { rows: RawMcqBankRow[]; expiresAt: number } | null = null;
let inFlight: Promise<RawMcqBankRow[]> | null = null;
const TTL_MS = 60 * 1000;

async function buildRows(): Promise<RawMcqBankRow[]> {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database not connected");
  return db
    .collection("mcqbanks")
    .aggregate([{ $project: bankProject }])
    .toArray() as Promise<RawMcqBankRow[]>;
}

/** All MCQ-bank rows (active + obsolete), cached ~60s with stale-while-revalidate. */
export async function getMcqBankAggregateRows(): Promise<RawMcqBankRow[]> {
  if (cache && cache.expiresAt >= Date.now()) return cache.rows;

  if (cache?.rows.length) {
    if (!inFlight) {
      inFlight = (async () => {
        try {
          const rows = await buildRows();
          cache = { rows, expiresAt: Date.now() + TTL_MS };
          return rows;
        } finally {
          inFlight = null;
        }
      })();
      inFlight.catch((e) => console.error("[mcq-bank-cache] Background rebuild failed:", e));
    }
    return cache.rows;
  }

  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const rows = await buildRows();
      cache = { rows, expiresAt: Date.now() + TTL_MS };
      return rows;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export function invalidateMcqBankAggregateCache() {
  cache = null;
  inFlight = null;
}
