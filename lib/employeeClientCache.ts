/**
 * Browser-side cache busting for employee identity changes.
 *
 * The matrix and Manage SOP pages keep their last payload in localStorage so
 * they paint instantly, and the LMS portal keeps a sessionStorage copy. Both
 * embed employee name / designation / department, so an edit made on the
 * Employees page has to drop them — otherwise the designation the admin just
 * changed keeps rendering from the browser's own cache even though the server
 * is already returning the new value.
 *
 * Mirrors what the Manage SOP page does after a save.
 */

import { LMS_CACHE_KEY } from '@/lib/lmsCache';

const MANAGE_SOP_VIEW_LOCAL_CACHE_KEY = 'manage_sop_view_cache_v10';
const TRAINING_MATRIX_OVERVIEW_CACHE_KEY = 'training_matrix_overview_cache_v6';
const INDUCTION_MATRIX_OVERVIEW_CACHE_KEY = 'induction_training_matrix_overview_cache_v5';
const TRAINING_MATRIX_NEEDS_REFRESH_KEY = 'training_matrix_needs_refresh_v1';

/** Drop every browser-held view that embeds employee identity. */
export function bustEmployeeClientCaches(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(MANAGE_SOP_VIEW_LOCAL_CACHE_KEY);
    localStorage.removeItem(TRAINING_MATRIX_OVERVIEW_CACHE_KEY);
    localStorage.removeItem(INDUCTION_MATRIX_OVERVIEW_CACHE_KEY);
    // Tells the matrix page to force a refresh rather than paint its stale copy.
    localStorage.setItem(TRAINING_MATRIX_NEEDS_REFRESH_KEY, String(Date.now()));
    sessionStorage.removeItem(LMS_CACHE_KEY);
  } catch {
    /* storage unavailable — non-fatal */
  }
}
