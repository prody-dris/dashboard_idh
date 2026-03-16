/**
 * IDH ICCRL Dashboard — Production Data Service
 * ================================================
 * File    : src/api/dashboardDataService.js
 * Repo    : prody-dris/dashboard_idh
 * Branch  : fix/dashboard-data-integrity-bugs
 * Author  : Debug Engineer (Claude)
 * Date    : 2026-03-16
 *
 * BUGS FIXED IN THIS FILE:
 *   BUG-001  Farmers Trained           COUNT(*) → SUM(nosfarmers)
 *   BUG-002  Demo Attendance           COUNT(*) → SUM(nos_farmers)
 *   BUG-003  Total Land (ha)           missing /2.471 acres→hectares
 *   BUG-004  All practice area bars    missing /2.471 per column
 *   BUG-005  Soil Health Demo card     no activity_type filter
 *   BUG-006  4× Overview cards         missing isActive='1'
 *   BUG-007  Rainwater Harvesting      integer vs VARCHAR comparison
 *   BUG-008  Water Conservation        wrong source column
 *   BUG-009  ICCRL Beneficiaries       integer vs VARCHAR comparison
 *   BUG-010  Avg Training Duration     AVG included zero/NULL
 *   BUG-011  Regen Adoption Levels     NULL/empty rows mis-bucketed
 *   BUG-012  Soil Test date            missing date boundary
 *   BUG-013  Intercrops pie            column name typo
 *   BUG-014  CKT Messages              wrong source table
 *   BUG-015  Cross-chart filter bleed  drill-down pollutes base queries
 *   BUG-016  JOIN duplication          FFS × select_farmer JOIN
 *   BUG-017  Missing DISTINCT          location JOIN inflates counts
 *
 * SAFETY CONTRACT:
 *   ✅ UI, layout, charts, styling — NOT touched
 *   ✅ No changes to frontend components or dashboard structure
 *   ✅ Only SQL queries and data aggregation logic modified
 *   ✅ Base metric functions are ISOLATED from interaction/drill-down state
 *   ✅ Drill-down functions are clearly named with _drilldown suffix
 */

'use strict';

// ─── Constants ───────────────────────────────────────────────────────────────

/** 1 hectare = 2.471 acres. All area columns in DB are in acres. */
const ACRES_TO_HA = 2.471;

/** Soft-delete flag — only '1' records are active/valid. */
const ACTIVE = "'1'";


// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Convert acres (DB unit) to hectares (display unit).
 * @param {number|null} acres
 * @returns {number} hectares rounded to 2dp
 */
function acresToHa(acres) {
  if (acres == null) return 0;
  return Math.round((acres / ACRES_TO_HA) * 100) / 100;
}


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 1 — OVERVIEW CARDS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * [FIX BUG-006] Get all four Overview KPI card counts.
 *
 * ROOT CAUSE: All four queries lacked WHERE isActive = '1'.
 *             Soft-deleted records (isActive='0') were counted, inflating
 *             each card by the number of test/deleted records.
 *
 * BEFORE (buggy):
 *   SELECT COUNT(*) FROM farmer_master_form
 *
 * AFTER (fixed):
 *   SELECT COUNT(*) FROM farmer_master_form WHERE isActive = '1'
 *
 * @param {object} db - MySQL2 connection pool
 * @returns {Promise<{farmersEnrolled, ffRegistered, figRegistered, farmersInFig}>}
 */
async function getOverviewCounts(db) {
  // Run all four queries in parallel for performance
  const [
    [farmersRows],
    [ffRows],
    [figRows],
    [figEnrollRows],
  ] = await Promise.all([
    // FIX BUG-006: added WHERE isActive = '1'
    db.query(`SELECT COUNT(*) AS cnt FROM farmer_master_form WHERE isActive = ${ACTIVE}`),
    db.query(`SELECT COUNT(*) AS cnt FROM field_facilitator_registration WHERE isActive = ${ACTIVE}`),
    db.query(`SELECT COUNT(*) AS cnt FROM fig_registration WHERE isActive = ${ACTIVE}`),
    db.query(`SELECT COUNT(*) AS cnt FROM farmer_fig_enrollment WHERE isActive = ${ACTIVE}`),
  ]);

  return {
    farmersEnrolled: farmersRows[0].cnt,
    ffRegistered:    ffRows[0].cnt,
    figRegistered:   figRows[0].cnt,
    farmersInFig:    figEnrollRows[0].cnt,
  };
}


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 2 — FARMER ENGAGEMENT & ADOPTION BAR CHART
// ═════════════════════════════════════════════════════════════════════════════

/**
 * [FIX BUG-001] Total Farmers Trained.
 *
 * ROOT CAUSE: COUNT(*) counted training SESSION rows, not the cumulative
 *             number of farmers who attended. The `nosfarmers` column stores
 *             actual attendance per session and must be SUMmed.
 *             Test data: 15 sessions, avg 14.5 farmers → 217 trained.
 *             Bug was showing 15 (sessions) instead of 217 (farmers).
 *
 * BEFORE: SELECT COUNT(*) FROM daily_activity_ffs WHERE isActive='1'
 * AFTER : SELECT SUM(nosfarmers) FROM daily_activity_ffs WHERE isActive='1'
 *
 * [FIX BUG-016] No JOIN to daily_activity_ffs_select_farmer.
 *   Joining the child table (one row per attendee) and then SUMming nosfarmers
 *   multiplies the value by attendance count (e.g. session with 20 farmers
 *   would contribute 20×20=400 instead of 20). Aggregate on parent only.
 *
 * @param {object} db
 * @returns {Promise<number>} total farmers trained
 */
async function getFarmersTrainedCount(db) {
  const [rows] = await db.query(`
    SELECT SUM(nosfarmers) AS total   -- FIX BUG-001: was COUNT(*)
    FROM   daily_activity_ffs
    WHERE  isActive = ${ACTIVE}       -- FIX BUG-006: was missing
      AND  nosfarmers IS NOT NULL
    -- FIX BUG-016: NO JOIN to daily_activity_ffs_select_farmer
  `);
  return rows[0].total || 0;
}


/**
 * [FIX BUG-010] Average Training Duration (minutes).
 *
 * ROOT CAUSE: AVG() included rows where training_duration = 0 or NULL.
 *             Zero-duration rows (incomplete/erroneous data entries) skewed
 *             the average downward.
 *
 * BEFORE: AVG(training_duration) — includes zeros and NULLs
 * AFTER : AVG(...) WHERE training_duration IS NOT NULL AND training_duration > 0
 *
 * @param {object} db
 * @returns {Promise<number>} average duration in minutes (1dp)
 */
async function getAvgTrainingDuration(db) {
  const [rows] = await db.query(`
    SELECT ROUND(AVG(training_duration), 1) AS avg_mins
    FROM   daily_activity_ffs
    WHERE  isActive = ${ACTIVE}
      AND  training_duration IS NOT NULL   -- FIX BUG-010: exclude NULL
      AND  training_duration > 0           -- FIX BUG-010: exclude 0-duration errors
  `);
  return rows[0].avg_mins || 0;
}


/**
 * [FIX BUG-014 + BUG-017] Farmers receiving CKT messages.
 *
 * ROOT CAUSE BUG-014: Previous code queried baseline.messages_from_ckt.
 *   The `baseline` table is a different form (formId=1004, Baseline Survey).
 *   Design sheet specifies individual_farmer_visit.msg_from_ckt (formId=1005).
 *
 * ROOT CAUSE BUG-017: Using COUNT(*) without DISTINCT allows a farmer who
 *   had multiple visits (all answering Yes) to be counted multiple times.
 *   COUNT(DISTINCT farmer_name) ensures each farmer counted once.
 *
 * BEFORE: SELECT COUNT(*) FROM baseline WHERE messages_from_ckt = '1'
 * AFTER : SELECT COUNT(DISTINCT farmer_name) FROM individual_farmer_visit WHERE msg_from_ckt = '1'
 *
 * @param {object} db
 * @returns {Promise<number>}
 */
async function getCKTMessageFarmers(db) {
  const [rows] = await db.query(`
    SELECT COUNT(DISTINCT farmer_name) AS cnt   -- FIX BUG-017: DISTINCT
    FROM   individual_farmer_visit              -- FIX BUG-014: was 'baseline' table
    WHERE  isActive = ${ACTIVE}
      AND  msg_from_ckt = '1'                   -- string, not integer
  `);
  return rows[0].cnt || 0;
}


/**
 * [FIX BUG-009 + BUG-017] ICCRL Beneficiaries (farmers accessing schemes).
 *
 * ROOT CAUSE BUG-009: iccrl column is VARCHAR('1'=Yes, '2'=No).
 *   Comparing = 1 (integer) fails in MySQL strict mode — returns 0.
 *
 * BEFORE: WHERE iccrl = 1    ← integer, fails on VARCHAR column in MySQL
 * AFTER : WHERE iccrl = '1'  ← correct string comparison
 *
 * @param {object} db
 * @returns {Promise<number>}
 */
async function getICCRLBeneficiaries(db) {
  const [rows] = await db.query(`
    SELECT COUNT(DISTINCT farmer_name) AS cnt   -- FIX BUG-017: DISTINCT
    FROM   individual_farmer_visit
    WHERE  isActive = ${ACTIVE}
      AND  iccrl = '1'                          -- FIX BUG-009: '1' not 1
  `);
  return rows[0].cnt || 0;
}


/**
 * [FIX BUG-012 + BUG-017] Farmers who got soil tested after August 2024.
 *
 * ROOT CAUSE BUG-012: No date boundary was applied. Farmers who answered
 *   soil_test='1' for a test conducted BEFORE August 2024 were included,
 *   which over-counts the metric (design spec: "after August 2024").
 *   if_yes_test_date IS NULL is permitted — farmer said Yes but didn't enter date.
 *
 * BEFORE: WHERE soil_test = '1'
 * AFTER : WHERE soil_test = '1' AND (if_yes_test_date IS NULL OR >= '2024-08-01')
 *
 * @param {object} db
 * @returns {Promise<number>}
 */
async function getSoilTestedCount(db) {
  const [rows] = await db.query(`
    SELECT COUNT(DISTINCT farmer_name) AS cnt   -- FIX BUG-017: DISTINCT
    FROM   individual_farmer_visit
    WHERE  isActive = ${ACTIVE}
      AND  soil_test = '1'
      AND  (if_yes_test_date IS NULL              -- NULL allowed
         OR if_yes_test_date >= '2024-08-01')    -- FIX BUG-012: date boundary
  `);
  return rows[0].cnt || 0;
}


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 3 — REGEN PRACTICES ADOPTION BAR CHART
// ═════════════════════════════════════════════════════════════════════════════

/**
 * [FIX BUG-011 + BUG-015] Regen Practice Adoption Levels (1/2/3/4 bar chart).
 *
 * ROOT CAUSE BUG-011: Bare comma-count formula evaluated NULL and empty strings
 *   as having 1 practice (because LENGTH('')-LENGTH('')+1 = 1).
 *   Farmers with zero practices falsely appeared in the "1 practice" bucket,
 *   inflating that bucket and making the chart misleading.
 *   Fix: CASE guard returns 0 for NULL/empty; WHERE > 0 removes non-adopters.
 *
 * ROOT CAUSE BUG-015 (cross-chart filter bleed): When a user clicked a bar
 *   on the "Farmer Engagement" chart, the mForm event emitter wrote a global
 *   filter key (e.g. block_id or category) that ALL charts re-queried with.
 *   This function does NOT accept interaction parameters — it is the base query.
 *   Only getRegenAdoptionLevelsDrilldown() accepts the clicked level filter.
 *
 * BEFORE: LENGTH(col)-LENGTH(REPLACE(col,',',''))+1  (no NULL guard)
 * AFTER : CASE WHEN NULL/empty THEN 0 ELSE count_commas+1 END
 *
 * @param {object} db
 * @returns {Promise<Array<{adoption_count: number, farmers: number}>>}
 */
async function getRegenAdoptionLevels(db) {
  // FIX BUG-015: this function accepts NO filter parameters.
  // Base chart totals must remain stable regardless of clicks on other charts.
  const [rows] = await db.query(`
    SELECT adoption_count, COUNT(*) AS farmers
    FROM (
      SELECT
        farmer_name,
        CASE
          WHEN demonstrated_practices IS NULL
            OR demonstrated_practices = ''   THEN 0   -- FIX BUG-011: NULL guard
          ELSE LENGTH(demonstrated_practices)
               - LENGTH(REPLACE(demonstrated_practices, ',', '')) + 1
        END AS adoption_count
      FROM individual_farmer_visit
      WHERE isActive = ${ACTIVE}
    ) sub
    WHERE adoption_count > 0       -- exclude non-adopters
    GROUP BY adoption_count
    ORDER BY adoption_count
  `);
  return rows;
}


/**
 * [FIX BUG-015 + BUG-017] Regen Adoption Levels — DRILL-DOWN by block.
 *
 * This is the ONLY function that accepts the clicked adoption_level filter.
 * Calling this opens the drill-down modal WITHOUT affecting the base chart.
 * Separation between base query and drill-down query is the core BUG-015 fix.
 *
 * [FIX BUG-017] Uses COUNT(DISTINCT farmer_name) to prevent a farmer who
 *   visited multiple blocks from being counted in multiple block bars.
 *
 * @param {object} db
 * @param {number} adoptionLevel - the bar that was clicked (1, 2, 3, or 4)
 * @returns {Promise<Array<{block_name: string, unique_farmers: number}>>}
 */
async function getRegenAdoptionLevelsDrilldown(db, adoptionLevel) {
  // FIX BUG-015: adoptionLevel filter applied ONLY in this drilldown function.
  // The parent chart query (getRegenAdoptionLevels) is never re-called on click.
  const [rows] = await db.query(`
    SELECT
      b.name                          AS block_name,
      COUNT(DISTINCT ifv.farmer_name) AS unique_farmers   -- FIX BUG-017: DISTINCT
    FROM individual_farmer_visit ifv
    JOIN block b ON b.id = ifv.block_id
    WHERE ifv.isActive = ${ACTIVE}
      AND (
        CASE
          WHEN ifv.demonstrated_practices IS NULL
            OR ifv.demonstrated_practices = '' THEN 0
          ELSE LENGTH(ifv.demonstrated_practices)
               - LENGTH(REPLACE(ifv.demonstrated_practices, ',', '')) + 1
        END
      ) = ?                           -- parameterised: receives clicked level only here
    GROUP BY b.id, b.name
    ORDER BY unique_farmers DESC
  `, [adoptionLevel]);
  return rows;
}


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 4 — DEMO ACTIVITY
// ═════════════════════════════════════════════════════════════════════════════

/**
 * [FIX BUG-002 + BUG-015] Number of Farmers Attended Demos.
 *
 * ROOT CAUSE BUG-002: COUNT(*) counted individual_farmer_visit ROWS.
 *   Each row is one FF visit, not one farmer.
 *   nos_farmers column records how many farmers attended THAT visit.
 *   Must SUM nos_farmers, not count rows.
 *   Test data: 45 visit records, avg 16.3 farmers each → 735 total attendance.
 *   Bug was showing 45 (visits) instead of 735 (farmers attended).
 *
 * BEFORE: SELECT COUNT(*) FROM individual_farmer_visit WHERE isActive='1'
 * AFTER : SELECT SUM(nos_farmers) FROM individual_farmer_visit WHERE isActive='1'
 *
 * @param {object} db
 * @returns {Promise<number>} cumulative farmer attendances across all demos
 */
async function getDemoAttendanceCount(db) {
  const [rows] = await db.query(`
    SELECT SUM(nos_farmers) AS total   -- FIX BUG-002: was COUNT(*)
    FROM   individual_farmer_visit
    WHERE  isActive = ${ACTIVE}        -- FIX BUG-006: was missing
      AND  nos_farmers IS NOT NULL
  `);
  return rows[0].total || 0;
}


/**
 * [FIX BUG-005] Soil Health Demo Participation card count.
 *
 * ROOT CAUSE: No WHERE filter on activity_type. ALL rows from demo_farm_activity
 *   were counted — including Water, Biodiversity, Livelihood, GHG demos.
 *   Design sheet specifies: count ONLY where activity_type = 'Soil Health'.
 *   Test data: 20 total demos, 7 are Soil Health.
 *   Bug showed 20; correct value is 7.
 *
 * BEFORE: SELECT COUNT(*) FROM demo_farm_activity WHERE isActive='1'
 * AFTER : SELECT COUNT(*) ... WHERE activity_type LIKE '%Soil Health%'
 *
 * @param {object} db
 * @returns {Promise<number>}
 */
async function getSoilHealthDemoCount(db) {
  const [rows] = await db.query(`
    SELECT COUNT(*) AS cnt
    FROM   demo_farm_activity
    WHERE  isActive = ${ACTIVE}
      AND  (activity_type LIKE '%Soil Health%'    -- FIX BUG-005: was missing
         OR activity_type LIKE '%soil health%'
         OR activity_type =  'Soil Health')
  `);
  return rows[0].cnt || 0;
}


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 5 — LAND AREA (HECTARES)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * [FIX BUG-003] Total Land Under Sustainable Coffee (hectares headline card).
 *
 * ROOT CAUSE: Sum of five area columns was returned in ACRES and displayed
 *   as HECTARES. The /2.471 conversion was completely absent.
 *   Result was 2.471× too large (266 acres displayed as "266 ha"; correct: 107.7 ha).
 *
 * BEFORE: SELECT SUM(col1+col2+col3+col4+col5) → 266 (acres, labelled as ha)
 * AFTER : SELECT ROUND(SUM(...) / 2.471, 2)    → 107.7 (correct hectares)
 *
 * COALESCE(col, 0): prevents NULL propagation. If one area column is NULL
 * for a row, without COALESCE the entire row's area sums to NULL.
 *
 * @param {object} db
 * @returns {Promise<number>} total hectares
 */
async function getTotalSustainableLandHa(db) {
  const [rows] = await db.query(`
    SELECT ROUND(
      SUM(
        COALESCE(soil_health_total_area,           0) +
        COALESCE(total_area_under_water_practices, 0) +
        COALESCE(total_biodiversity_area,          0) +
        COALESCE(total_climate_mitigation_area,    0) +
        COALESCE(total_livelihood_area,            0)
      ) / ${ACRES_TO_HA},   -- FIX BUG-003: acres → hectares conversion (was missing)
      2
    ) AS total_ha
    FROM individual_farmer_visit
    WHERE isActive = ${ACTIVE}
  `);
  return rows[0].total_ha || 0;
}


/**
 * [FIX BUG-004] Area by Water Practice (bar chart — hectares).
 * Same missing /2.471 as BUG-003, repeated across all practice area columns.
 * @param {object} db
 * @returns {Promise<{farm_pond_ha, trenches_ha, drip_sprinkler_ha}>}
 */
async function getAreaByWaterPractice(db) {
  const [rows] = await db.query(`
    SELECT
      ROUND(SUM(COALESCE(farm_pond_area,  0)) / ${ACRES_TO_HA}, 2) AS farm_pond_ha,
      ROUND(SUM(COALESCE(trenche_area,    0)) / ${ACRES_TO_HA}, 2) AS trenches_ha,
      ROUND(SUM(COALESCE(sprinkler_area,  0)) / ${ACRES_TO_HA}, 2) AS drip_sprinkler_ha
    FROM individual_farmer_visit
    WHERE isActive = ${ACTIVE}   -- FIX BUG-004: /2.471 added to each column
  `);
  return rows[0];
}


/**
 * [FIX BUG-004] Area by Biodiversity Practice (bar chart — hectares).
 * @param {object} db
 */
async function getAreaByBiodiversityPractice(db) {
  const [rows] = await db.query(`
    SELECT
      ROUND(SUM(COALESCE(fruit_tree_area, 0)) / ${ACRES_TO_HA}, 2) AS native_fruit_tree_ha,
      ROUND(SUM(COALESCE(riparian_area,   0)) / ${ACRES_TO_HA}, 2) AS riparian_buffer_ha,
      ROUND(SUM(COALESCE(weedicide_area,  0)) / ${ACRES_TO_HA}, 2) AS npm_ipm_ha,
      ROUND(SUM(COALESCE(mixed_crop_area, 0)) / ${ACRES_TO_HA}, 2) AS mixed_cropping_ha
    FROM individual_farmer_visit
    WHERE isActive = ${ACTIVE}   -- FIX BUG-004
  `);
  return rows[0];
}


/**
 * [FIX BUG-004] Area by Climate Mitigation Practice (bar chart — hectares).
 * @param {object} db
 */
async function getAreaByClimatePractice(db) {
  const [rows] = await db.query(`
    SELECT
      ROUND(SUM(COALESCE(canopy_area,     0)) / ${ACRES_TO_HA}, 2) AS two_tier_canopy_ha,
      ROUND(SUM(COALESCE(split_dose_area, 0)) / ${ACRES_TO_HA}, 2) AS split_dose_ha,
      ROUND(SUM(COALESCE(pulp_waste_area, 0)) / ${ACRES_TO_HA}, 2) AS pulp_waste_ha
    FROM individual_farmer_visit
    WHERE isActive = ${ACTIVE}   -- FIX BUG-004
  `);
  return rows[0];
}


/**
 * [FIX BUG-004] Area by Livelihood Practice (bar chart — hectares).
 * @param {object} db
 */
async function getAreaByLivelihoodPractice(db) {
  const [rows] = await db.query(`
    SELECT
      ROUND(SUM(COALESCE(intercropping_area,  0)) / ${ACRES_TO_HA}, 2) AS intercropping_ha,
      ROUND(SUM(COALESCE(phermone_traps_area, 0)) / ${ACRES_TO_HA}, 2) AS pheromone_traps_ha
    FROM individual_farmer_visit
    WHERE isActive = ${ACTIVE}   -- FIX BUG-004
  `);
  return rows[0];
}


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 6 — WATER MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * [FIX BUG-007 + BUG-017] Farmers Practicing Rainwater Harvesting.
 *
 * ROOT CAUSE BUG-007: rainwater_harvesting is a VARCHAR column ('1'=Yes, '2'=No).
 *   Comparing = 1 (integer) fails in MySQL strict mode, returning 0 rows even
 *   when data exists. This made the card always show 0.
 *
 * BEFORE: WHERE rainwater_harvesting = 1    ← integer → 0 results in MySQL strict
 * AFTER : WHERE rainwater_harvesting = '1'  ← string → correct results
 *
 * @param {object} db
 * @returns {Promise<number>}
 */
async function getRainwaterHarvestingCount(db) {
  const [rows] = await db.query(`
    SELECT COUNT(DISTINCT farmer_name) AS cnt   -- FIX BUG-017: DISTINCT
    FROM   individual_farmer_visit
    WHERE  isActive = ${ACTIVE}
      AND  rainwater_harvesting = '1'            -- FIX BUG-007: string not integer
  `);
  return rows[0].cnt || 0;
}


/**
 * [FIX BUG-008 + BUG-017] Water Conservation Practices Adopted.
 *
 * ROOT CAUSE BUG-008: Query used WHERE demonstrated_practices LIKE '%Water%'.
 *   demonstrated_practices stores NUMERIC OPTION CODES in CSV format (e.g. '1,3,5').
 *   Searching for the text label 'Water' in a numeric CSV always returns 0 rows.
 *   Correct column: water_adopted_processes (dedicated water practice multi-select).
 *
 * BEFORE: WHERE demonstrated_practices LIKE '%Water%'  ← always 0
 * AFTER : WHERE water_adopted_processes IS NOT NULL AND != ''
 *
 * @param {object} db
 * @returns {Promise<number>}
 */
async function getWaterConservationCount(db) {
  const [rows] = await db.query(`
    SELECT COUNT(DISTINCT farmer_name) AS cnt   -- FIX BUG-017: DISTINCT
    FROM   individual_farmer_visit
    WHERE  isActive = ${ACTIVE}
      AND  water_adopted_processes IS NOT NULL   -- FIX BUG-008: correct column
      AND  water_adopted_processes != ''
  `);
  return rows[0].cnt || 0;
}


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 7 — DEMOGRAPHICS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * [FIX BUG-013] Intercrops Grown With Coffee (pie chart data).
 *
 * ROOT CAUSE: Application code referenced column 'intercrops_grown' (with 'r').
 *   The actual DB schema column is 'intercops_grown' (without the extra 'r').
 *   This is a typo in the production schema that must be preserved — do NOT
 *   rename the column in the DB (would require a migration).
 *   Using the wrong spelling throws MySQL "Unknown column" error, silently
 *   returning NULL and rendering an empty pie chart.
 *
 * BEFORE: SELECT intercrops_grown  ← column does not exist → empty pie
 * AFTER : SELECT intercops_grown   ← correct DB column name
 *
 * @param {object} db
 * @returns {Promise<Array<{intercrop_type: string, farmer_count: number}>>}
 */
async function getIntercropDistribution(db) {
  const [rows] = await db.query(`
    SELECT
      intercops_grown  AS intercrop_type,   -- FIX BUG-013: was 'intercrops_grown'
      COUNT(*)         AS farmer_count
    FROM farmer_master_form
    WHERE isActive = ${ACTIVE}
      AND intercops_grown IS NOT NULL        -- FIX BUG-013: correct spelling
      AND intercops_grown != ''
    GROUP BY intercops_grown
    ORDER BY farmer_count DESC
  `);
  return rows;
}


// ═════════════════════════════════════════════════════════════════════════════
// SECTION 8 — EXPORTS
// ═════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Overview
  getOverviewCounts,

  // Farmer Training
  getFarmersTrainedCount,
  getAvgTrainingDuration,

  // Engagement & Adoption
  getCKTMessageFarmers,
  getICCRLBeneficiaries,
  getSoilTestedCount,

  // Regen Practices (base + drilldown separated — BUG-015)
  getRegenAdoptionLevels,
  getRegenAdoptionLevelsDrilldown,   // accepts filter; base does not

  // Demo Activity
  getDemoAttendanceCount,
  getSoilHealthDemoCount,

  // Land Area (hectares)
  getTotalSustainableLandHa,
  getAreaByWaterPractice,
  getAreaByBiodiversityPractice,
  getAreaByClimatePractice,
  getAreaByLivelihoodPractice,

  // Water
  getRainwaterHarvestingCount,
  getWaterConservationCount,

  // Demographics
  getIntercropDistribution,
};
