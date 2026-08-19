/**
 * SOP collection scans for registry / matrix / LMS list views.
 *
 * Never include these fields: they dwarf the rest of the document and are not
 * used by grouping. On Atlas M0, transferring them with SOP.find({}) gets
 * throttled to minutes.
 *
 * - content: extracted SOP text (~30KB avg, up to ~77KB)
 * - mcqClauseCache: per-clause full text (same order of magnitude as content)
 * - complianceStructureCache: parsed section payloads
 *
 * `select('-content')` alone is not enough once MCQ/compliance caches exist.
 */
export const SOP_LIST_EXCLUDE =
  "-content -mcqClauseCache -complianceStructureCache";
