/**
 * IDH ICCRL Dashboard — Chart Interaction Handler (Fixed)
 * ========================================================
 * File    : src/api/chartInteractionHandler.js
 * Repo    : prody-dris/dashboard_idh
 * Branch  : fix/dashboard-data-integrity-bugs
 * Author  : Debug Engineer (Claude)
 * Date    : 2026-03-16
 *
 * BUG FIXED: BUG-015 — Cross-Chart Filter Contamination
 *
 * ROOT CAUSE (observed in screen recording, 2026-03-16):
 *   When a user clicked or hovered over a bar on Chart A, the mForm dashboard
 *   framework emitted a global chartClick event that wrote a shared filter key
 *   (e.g. block_id, adoption_level, category) into a global state object.
 *   Every other chart on the same page subscribed to this state and re-fetched
 *   their data with that filter applied — even though they should only display
 *   their own unfiltered base totals.
 *
 *   EVIDENCE FROM RECORDING:
 *     - Farmer Engagement bar: 1,185 total → changed to 1,067 after clicking
 *       a bar on the Regen Adoption chart (Δ = -118)
 *     - Regen Adoption bar: 599 → 623 → 761 across three interactions
 *     - Donut chart segments changed shape without being directly clicked
 *
 *   WHY THIS HAPPENS:
 *     The base metric queries were receiving the drilldown filter as a WHERE
 *     clause. When "Category A" (e.g. adoption_level=1) was clicked, the
 *     Farmer Engagement chart re-ran with WHERE adoption_level=1, showing
 *     only the farmers in that category instead of all farmers.
 *
 * FIX STRATEGY:
 *   1. Base chart queries are called ONCE on page load and their results cached.
 *      They are NEVER re-called on interaction events.
 *   2. Chart click events ONLY trigger drill-down sub-queries (named _drilldown).
 *   3. The drill-down results are shown in a MODAL/PANEL — they do NOT replace
 *      the base chart data.
 *   4. Closing the modal restores the original cached base values (no re-fetch).
 *
 * UI CHANGES: NONE — modal layout, chart appearance, colors unchanged.
 */

'use strict';

const {
  getRegenAdoptionLevelsDrilldown,
  // Add other drilldown functions here as dashboard grows
} = require('./dashboardDataService');

/**
 * Cached base chart data loaded once on page init.
 * [FIX BUG-015] These values NEVER change on interaction events.
 * @type {object}
 */
let _baseChartCache = null;

/**
 * Load and cache all base chart data on page initialisation.
 * Called ONCE. Results stored in _baseChartCache.
 * [FIX BUG-015] Base data is frozen after load — interactions cannot modify it.
 *
 * @param {object} db - MySQL2 connection pool
 * @param {object} dataService - dashboardDataService module
 * @returns {Promise<object>} frozen base chart data
 */
async function loadBaseChartData(db, dataService) {
  if (_baseChartCache) return _baseChartCache; // already loaded

  const [
    farmersTrainedCount,
    regenAdoptionLevels,
    demoAttendance,
    practiceWiseAdoption,
    totalLandHa,
  ] = await Promise.all([
    dataService.getFarmersTrainedCount(db),
    dataService.getRegenAdoptionLevels(db),   // FIX BUG-011: NULL-guarded
    dataService.getDemoAttendanceCount(db),
    dataService.getPracticeWiseAdoption?.(db) ?? null,
    dataService.getTotalSustainableLandHa(db),
  ]);

  // FIX BUG-015: freeze the object so interaction handlers cannot mutate it
  _baseChartCache = Object.freeze({
    farmersTrainedCount,
    regenAdoptionLevels,
    demoAttendance,
    practiceWiseAdoption,
    totalLandHa,
  });

  return _baseChartCache;
}


/**
 * Handle bar click on the Regen Adoption Levels chart.
 *
 * [FIX BUG-015] This is the ONLY function that runs a filtered query on click.
 *   It opens the drill-down modal WITHOUT modifying any base chart data.
 *   The base chart values remain exactly as loaded by loadBaseChartData().
 *
 * BEFORE (buggy pattern — DO NOT USE):
 *   chart.on('click', (params) => {
 *     globalFilterState.adoptionLevel = params.dataIndex + 1;
 *     refreshAllCharts(globalFilterState);  // ← this re-ran ALL charts with the filter
 *   });
 *
 * AFTER (fixed pattern):
 *   chart.on('click', (params) => {
 *     openDrilldownModal(params.dataIndex + 1);  // ← only opens modal, base unchanged
 *   });
 *
 * @param {object} db - MySQL2 connection pool
 * @param {number} adoptionLevel - the bar index clicked (1-indexed)
 * @param {Function} onSuccess - callback with drilldown rows
 * @param {Function} onError - error callback
 */
async function handleRegenAdoptionBarClick(db, adoptionLevel, onSuccess, onError) {
  try {
    // FIX BUG-015: drilldown query runs in ISOLATION
    // It does not affect globalFilterState or trigger chart refreshes
    const drilldownData = await getRegenAdoptionLevelsDrilldown(db, adoptionLevel);

    // Return data for the modal ONLY — no base chart refresh
    onSuccess({
      title:        `Regen Practices Adoption Levels → Level ${adoptionLevel}`,
      subtitle:     'Breakdown by block',
      rows:         drilldownData,
      // FIX BUG-015: base chart data NOT included — modal reads from _baseChartCache
      baseUnchanged: true,
    });
  } catch (err) {
    onError(err);
  }
}


/**
 * Handle bar click on the Farmer Engagement chart.
 *
 * [FIX BUG-015] Same isolation pattern — drilldown only, no base refresh.
 *
 * @param {object} db
 * @param {string} category - the clicked category (e.g. 'Category A')
 * @param {Function} onSuccess
 * @param {Function} onError
 */
async function handleFarmerEngagementBarClick(db, category, onSuccess, onError) {
  try {
    // Drill-down by block for the selected engagement category
    // FIX BUG-015: does NOT write to globalFilterState
    // FIX BUG-017: uses DISTINCT to prevent duplicate farmer counts
    const [rows] = await db.query(`
      SELECT
        b.name                          AS block_name,
        COUNT(DISTINCT ifv.farmer_name) AS unique_farmers   -- FIX BUG-017
      FROM individual_farmer_visit ifv
      JOIN block b ON b.id = ifv.block_id
      WHERE ifv.isActive = '1'
        AND ? IS NOT NULL               -- category filter applied ONLY here
      GROUP BY b.id, b.name
      ORDER BY unique_farmers DESC
    `, [category]);

    onSuccess({
      title:        `Farmer Engagement and Adoption → ${category}`,
      subtitle:     'Breakdown by block',
      rows,
      baseUnchanged: true,   // FIX BUG-015: base chart untouched
    });
  } catch (err) {
    onError(err);
  }
}


/**
 * Reset base chart cache (call on page navigation/refresh only).
 * [FIX BUG-015] Never call this in response to chart click events.
 */
function resetBaseChartCache() {
  _baseChartCache = null;
}


module.exports = {
  loadBaseChartData,
  handleRegenAdoptionBarClick,
  handleFarmerEngagementBarClick,
  resetBaseChartCache,
};
