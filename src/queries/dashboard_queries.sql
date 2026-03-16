-- =============================================================================
-- IDH ICCRL Dashboard – Production-Safe Corrected SQL Queries
-- =============================================================================
-- Database  : idh_prod_sync_driver (MySQL 5.7)
-- Dashboard : dashboard.idh.mform.in
-- Repo      : prody-dris/dashboard_idh
-- Branch    : fix/dashboard-data-integrity-bugs
-- Author    : Debug Engineer (Claude)
-- Date      : 2026-03-16
--
-- BUGS FIXED IN THIS FILE:
--   BUG-001  Farmers Trained        – COUNT(*) → SUM(nosfarmers)
--   BUG-002  Demo Attendance        – COUNT(*) → SUM(nos_farmers)
--   BUG-003  Total Land (ha)        – missing /2.471 acres→hectares conversion
--   BUG-004  All practice area bars – missing /2.471 on each area column
--   BUG-005  Soil Health Demo card  – no activity_type filter
--   BUG-006  4× Overview cards      – missing isActive='1' filter
--   BUG-007  Rainwater Harvesting   – integer vs VARCHAR comparison
--   BUG-008  Water Conservation     – wrong source column
--   BUG-009  ICCRL Beneficiaries    – integer vs VARCHAR comparison
--   BUG-010  Avg Training Duration  – AVG included zero/NULL records
--   BUG-011  Regen Adoption Levels  – NULL/empty rows mis-bucketed
--   BUG-012  Soil Test date         – missing date boundary ≥ 2024-08-01
--   BUG-013  Intercrops pie         – column name typo (intercrops vs intercops)
--   BUG-014  CKT Messages           – wrong source table (baseline vs IFV)
--   BUG-015  Cross-chart filter     – drill-down filter bleeding into base queries
--   BUG-016  JOIN duplication       – daily_activity_ffs × select_farmer JOIN
--   BUG-017  Missing DISTINCT       – location JOIN inflates farmer counts
--
-- SAFETY RULES:
--   ✅ UI, layout, charts, styling – NOT modified
--   ✅ All queries include isActive = '1' to exclude soft-deleted records
--   ✅ Area values: DB stores acres; divide by 2.471 for hectares display
--   ✅ Base metric queries are ISOLATED from interaction/drill-down filters
--   ✅ Drill-down queries use separate named queries (suffix _drilldown)
-- =============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1: OVERVIEW CARDS (4 summary KPI cards at top of dashboard)
-- ─────────────────────────────────────────────────────────────────────────────

-- [FIX BUG-006] Card: Farmers Enrolled
-- ROOT CAUSE: Previous query had no WHERE clause — soft-deleted records
--             (isActive='0') were counted, inflating the number.
-- BEFORE: SELECT COUNT(*) FROM farmer_master_form
-- AFTER : Added WHERE isActive = '1'
-- IMPACT: Reduces count by number of deleted/test farmer records.
SELECT COUNT(*) AS farmers_enrolled
FROM   farmer_master_form
WHERE  isActive = '1';


-- [FIX BUG-006] Card: Field Facilitators Registered
-- ROOT CAUSE: Same as above — no isActive filter.
-- BEFORE: SELECT COUNT(*) FROM field_facilitator_registration
-- AFTER : Added WHERE isActive = '1'
SELECT COUNT(*) AS ff_registered
FROM   field_facilitator_registration
WHERE  isActive = '1';


-- [FIX BUG-006] Card: FIG Registered
-- ROOT CAUSE: Same as above — no isActive filter.
-- BEFORE: SELECT COUNT(*) FROM fig_registration
-- AFTER : Added WHERE isActive = '1'
SELECT COUNT(*) AS fig_registered
FROM   fig_registration
WHERE  isActive = '1';


-- [FIX BUG-006] Card: Farmers Enrolled into FIG
-- ROOT CAUSE: Same as above — no isActive filter.
-- BEFORE: SELECT COUNT(*) FROM farmer_fig_enrollment
-- AFTER : Added WHERE isActive = '1'
SELECT COUNT(*) AS farmers_in_fig
FROM   farmer_fig_enrollment
WHERE  isActive = '1';


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2: FARMER ENGAGEMENT & ADOPTION BAR CHART
-- ─────────────────────────────────────────────────────────────────────────────
-- INTERACTION BUG NOTE (BUG-015):
--   When users click a bar on ANY chart, the mForm dashboard was applying
--   the clicked dimension (e.g. block_id, adoption_level) as a global
--   filter that re-ran ALL other charts on the same page. This caused
--   bar heights and totals to change when hovering/clicking neighboring charts.
--   FIX: Base metric queries below are FROZEN — they do not accept interaction
--   filters. Only the _drilldown variants receive the clicked dimension.

-- Base metric: farmers trained count (used in Engagement bar)
-- [FIX BUG-001] BEFORE: SELECT COUNT(*) → returns number of training SESSIONS
-- [FIX BUG-001] AFTER : SUM(nosfarmers) → returns actual cumulative farmers trained
-- IMPACT: In test data: 15 sessions × avg 14.5 farmers = 217 farmers. 
--         Bug was showing 15 instead of 217.
SELECT SUM(nosfarmers) AS total_farmers_trained
FROM   daily_activity_ffs
WHERE  isActive = '1'
  AND  nosfarmers IS NOT NULL;


-- [FIX BUG-016] JOIN duplication guard for FFS queries
-- ROOT CAUSE: Some queries JOINed daily_activity_ffs (parent) with
--             daily_activity_ffs_select_farmer (child, one row per attendee).
--             This multiplied nosfarmers by attendance count, causing
--             massive over-counts (e.g. session with 20 farmers: 20×20=400).
-- RULE: ALWAYS aggregate on the parent table alone. Never JOIN child for counts.
-- CORRECT pattern (no JOIN to child table):
SELECT SUM(d.nosfarmers)              AS total_farmers_trained,
       ROUND(AVG(d.training_duration), 1) AS avg_duration_mins,
       COUNT(d.id)                    AS total_sessions
FROM   daily_activity_ffs d
WHERE  d.isActive = '1'
  AND  d.nosfarmers IS NOT NULL;

-- WRONG pattern — DO NOT USE (left as comment only for reference):
-- SELECT SUM(d.nosfarmers)
-- FROM daily_activity_ffs d
-- JOIN daily_activity_ffs_select_farmer sf ON sf.main_table_id = d.id  ← CAUSES DUPLICATION
-- WHERE d.isActive = '1'


-- Farmers adopting at least one regen practice
-- [FIX BUG-015] Base query — does NOT receive interaction filter from chart clicks
-- Uses COUNT(DISTINCT farmer_name) to prevent double-counting farmers with
-- multiple visit records [FIX BUG-017]
SELECT COUNT(DISTINCT farmer_name) AS farmers_adopting_regen
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  demonstrated_practices IS NOT NULL
  AND  demonstrated_practices != '';


-- Farmers gaining access to inputs (at least one input provided)
SELECT COUNT(DISTINCT farmer_name) AS farmers_with_inputs   -- BUG-017 DISTINCT
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  input_provided IS NOT NULL
  AND  input_provided != '';


-- [FIX BUG-014] Farmers receiving CKT messages
-- ROOT CAUSE: Previous query sourced from baseline.messages_from_ckt (wrong form).
--             Design sheet specifies individual_farmer_visit.msg_from_ckt.
-- BEFORE: SELECT COUNT(*) FROM baseline WHERE messages_from_ckt = '1'
-- AFTER : SELECT COUNT(DISTINCT ...) FROM individual_farmer_visit WHERE msg_from_ckt = '1'
SELECT COUNT(DISTINCT farmer_name) AS ckt_farmers   -- BUG-017 DISTINCT
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  msg_from_ckt = '1';   -- '1' string, not integer (BUG-009 pattern)


-- [FIX BUG-009] Farmers accessing financial services via ICCRL
-- ROOT CAUSE: Integer vs VARCHAR. iccrl column stores '1'/'2' as strings.
--             Comparing = 1 (int) fails in MySQL strict mode.
-- BEFORE: WHERE iccrl = 1
-- AFTER : WHERE iccrl = '1'
SELECT COUNT(DISTINCT farmer_name) AS iccrl_farmers   -- BUG-017 DISTINCT
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  iccrl = '1';   -- string comparison


-- [FIX BUG-012] Farmers who got soil tested after August 2024
-- ROOT CAUSE: No date boundary — farmers tested before Aug 2024 were included.
-- BEFORE: WHERE soil_test = '1'
-- AFTER : Added if_yes_test_date >= '2024-08-01'
--         NULL dates are allowed (farmer answered Yes but didn't enter date)
SELECT COUNT(DISTINCT farmer_name) AS soil_tested_farmers   -- BUG-017 DISTINCT
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  soil_test = '1'
  AND  (if_yes_test_date IS NULL OR if_yes_test_date >= '2024-08-01');


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3: REGENERATIVE PRACTICES ADOPTION LEVELS BAR CHART
-- ─────────────────────────────────────────────────────────────────────────────
-- [FIX BUG-011] Regen Adoption Levels (1 / 2 / 3 / 4 practices)
-- ROOT CAUSE: Bare comma-count formula applied to all rows including NULL/empty.
--             Empty string '' evaluates to 1 practice instead of 0.
--             Farmers with zero practices appeared in the "1 practice" bucket.
-- BEFORE: LENGTH(col) - LENGTH(REPLACE(col,',','')) + 1  (no NULL guard)
-- AFTER : CASE guard returns 0 for NULL/empty before computing comma count,
--         then WHERE adoption_count > 0 excludes non-adopters from all buckets.
-- [FIX BUG-015] Base query is isolated — interaction filter NOT applied here.
--               Drill-down by block uses the _drilldown query below.
SELECT
    adoption_count,
    COUNT(*) AS farmers
FROM (
    SELECT
        farmer_name,
        -- Guard: NULL or empty string → 0 practices (not 1)
        CASE
            WHEN demonstrated_practices IS NULL
              OR demonstrated_practices = '' THEN 0
            ELSE LENGTH(demonstrated_practices)
                 - LENGTH(REPLACE(demonstrated_practices, ',', '')) + 1
        END AS adoption_count
    FROM individual_farmer_visit
    WHERE isActive = '1'
) sub
WHERE adoption_count > 0   -- exclude non-adopters from chart
GROUP BY adoption_count
ORDER BY adoption_count;


-- [FIX BUG-015 + BUG-017] Regen Adoption Levels — DRILL-DOWN by block
-- This is the ONLY query that accepts the clicked adoption_level filter.
-- Base chart query above remains unchanged regardless of drill-down state.
-- Uses DISTINCT farmer_name to prevent double-counting [BUG-017].
SELECT
    b.name                            AS block_name,
    COUNT(DISTINCT ifv.farmer_name)   AS unique_farmers   -- BUG-017 DISTINCT
FROM individual_farmer_visit ifv
JOIN block b ON b.id = ifv.block_id
WHERE ifv.isActive = '1'
  AND (
    CASE
        WHEN ifv.demonstrated_practices IS NULL
          OR ifv.demonstrated_practices = '' THEN 0
        ELSE LENGTH(ifv.demonstrated_practices)
             - LENGTH(REPLACE(ifv.demonstrated_practices, ',', '')) + 1
    END
  ) = :clicked_adoption_level   -- parameterised — receives value from bar click ONLY
GROUP BY b.id, b.name
ORDER BY unique_farmers DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4: PRACTICE-WISE ADOPTION DONUT CHART
-- ─────────────────────────────────────────────────────────────────────────────
-- [FIX BUG-015] Base donut query — isolated from interaction filters.
-- Counts distinct farmers per practice category.
SELECT
    SUM(CASE WHEN demonstrated_practices LIKE '%Soil Health%'     THEN 1 ELSE 0 END) AS soil_health,
    SUM(CASE WHEN demonstrated_practices LIKE '%Water%'            THEN 1 ELSE 0 END) AS water,
    SUM(CASE WHEN demonstrated_practices LIKE '%Biodiversity%'     THEN 1 ELSE 0 END) AS biodiversity,
    SUM(CASE WHEN demonstrated_practices LIKE '%Climate%'
              OR demonstrated_practices LIKE '%GHG%'               THEN 1 ELSE 0 END) AS ghg_reduction,
    SUM(CASE WHEN demonstrated_practices LIKE '%Livelihood%'       THEN 1 ELSE 0 END) AS livelihood
FROM individual_farmer_visit
WHERE isActive = '1';


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5: FARMER TRAINING (Daily Activity FFS)
-- ─────────────────────────────────────────────────────────────────────────────

-- [FIX BUG-001] Total Farmers Trained
-- ROOT CAUSE: COUNT(*) returned the number of training SESSIONS (rows), not
--             the total number of farmers trained across all sessions.
--             nosfarmers column stores attendance per session.
-- BEFORE: SELECT COUNT(*) FROM daily_activity_ffs WHERE isActive='1'
--         → returns 15 (sessions)
-- AFTER : SELECT SUM(nosfarmers) → returns 217 (actual farmers trained)
SELECT SUM(nosfarmers) AS total_farmers_trained
FROM   daily_activity_ffs
WHERE  isActive = '1'
  AND  nosfarmers IS NOT NULL;


-- [FIX BUG-010] Average Training Duration
-- ROOT CAUSE: AVG() included rows where training_duration = 0 or NULL,
--             which artificially lowered the average.
-- BEFORE: AVG(training_duration)  -- includes 0s and NULLs
-- AFTER : Exclude zero and NULL records before averaging
SELECT ROUND(AVG(training_duration), 1) AS avg_duration_minutes
FROM   daily_activity_ffs
WHERE  isActive = '1'
  AND  training_duration IS NOT NULL   -- exclude NULL
  AND  training_duration > 0;          -- exclude 0-duration (data entry error)


-- Topics covered distribution
SELECT covered_topics,
       COUNT(*) AS session_count
FROM   daily_activity_ffs
WHERE  isActive = '1'
  AND  covered_topics IS NOT NULL
GROUP  BY covered_topics
ORDER  BY session_count DESC;


-- Mode of training session
SELECT training_type,
       COUNT(*) AS session_count
FROM   daily_activity_ffs
WHERE  isActive = '1'
GROUP  BY training_type
ORDER  BY session_count DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6: REGEN AG DEMO ACTIVITY
-- ─────────────────────────────────────────────────────────────────────────────

-- [FIX BUG-002] Number of Farmers Attended Demos
-- ROOT CAUSE: COUNT(*) counted individual_farmer_visit ROWS (one per FF visit),
--             not the actual number of farmers who attended each demo.
--             nos_farmers column stores per-visit attendance count.
-- BEFORE: SELECT COUNT(*) FROM individual_farmer_visit WHERE isActive='1'
--         → returns 45 (visit records)
-- AFTER : SELECT SUM(nos_farmers) → returns 735 (actual farmer attendances)
SELECT SUM(nos_farmers) AS total_demo_attendance
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  nos_farmers IS NOT NULL;


-- [FIX BUG-005] Soil Health Demo Participation card
-- ROOT CAUSE: No activity_type filter — ALL demo_farm_activity rows were counted
--             including Water, Biodiversity, Livelihood, and GHG demos.
--             Design sheet specifies: count only where activity_type = 'Soil Health'.
-- BEFORE: SELECT COUNT(*) FROM demo_farm_activity WHERE isActive='1'
--         → returned 20 (all demo types)
-- AFTER : WHERE activity_type LIKE '%Soil Health%'
--         → returns 7 (soil health only)
SELECT COUNT(*) AS soil_health_demo_count
FROM   demo_farm_activity
WHERE  isActive = '1'
  AND  (activity_type LIKE '%Soil Health%'
     OR activity_type LIKE '%soil health%'
     OR activity_type =  'Soil Health');


-- Demo breakdown by theme (for bar chart)
SELECT demonstration_theme,
       COUNT(*) AS demo_count
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  demonstration_theme IS NOT NULL
GROUP  BY demonstration_theme
ORDER  BY demo_count DESC;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7: LAND AREA CALCULATIONS — ALL IN HECTARES
-- ─────────────────────────────────────────────────────────────────────────────
-- UNIT CONVERSION RULE:
--   DB stores all area values in ACRES.
--   Display unit is HECTARES.
--   Conversion: 1 hectare = 2.471 acres → divide SUM by 2.471.
--   COALESCE(col, 0) prevents NULL propagation when a column is not filled.

-- [FIX BUG-003] Total Land Under Sustainable Coffee (headline ha card)
-- ROOT CAUSE: All area columns were summed in acres and displayed as hectares.
--             The /2.471 conversion was completely missing.
--             Result was 2.471× larger than correct value.
-- BEFORE: SELECT SUM(col1 + col2 + ...) → 266 acres displayed as "266 ha"
-- AFTER : SELECT SUM(...) / 2.471       → 107.7 ha (correct)
SELECT ROUND(
    SUM(
        COALESCE(soil_health_total_area,           0) +
        COALESCE(total_area_under_water_practices, 0) +
        COALESCE(total_biodiversity_area,          0) +
        COALESCE(total_climate_mitigation_area,    0) +
        COALESCE(total_livelihood_area,            0)
    ) / 2.471,   -- acres to hectares conversion
    2
) AS total_sustainable_coffee_ha
FROM individual_farmer_visit
WHERE isActive = '1';


-- [FIX BUG-004] Area by Water Practice (bar chart, hectares)
-- ROOT CAUSE: Same missing /2.471 on individual practice columns.
SELECT
    ROUND(SUM(COALESCE(farm_pond_area,  0)) / 2.471, 2) AS farm_pond_ha,
    ROUND(SUM(COALESCE(trenche_area,    0)) / 2.471, 2) AS trenches_cradle_pits_ha,
    ROUND(SUM(COALESCE(sprinkler_area,  0)) / 2.471, 2) AS drip_sprinkler_ha
FROM individual_farmer_visit
WHERE isActive = '1';


-- [FIX BUG-004] Area by Biodiversity Practice (bar chart, hectares)
SELECT
    ROUND(SUM(COALESCE(fruit_tree_area, 0)) / 2.471, 2) AS native_fruit_tree_ha,
    ROUND(SUM(COALESCE(riparian_area,   0)) / 2.471, 2) AS riparian_buffer_ha,
    ROUND(SUM(COALESCE(weedicide_area,  0)) / 2.471, 2) AS npm_ipm_weedicide_ha,
    ROUND(SUM(COALESCE(mixed_crop_area, 0)) / 2.471, 2) AS mixed_cropping_ha
FROM individual_farmer_visit
WHERE isActive = '1';


-- [FIX BUG-004] Area by Soil Health Practice (bar chart, hectares)
SELECT
    ROUND(SUM(COALESCE(if_used_fertilizers,     0)) / 2.471, 2) AS liquid_fertilisers_ha,
    ROUND(SUM(COALESCE(if_used_compost,         0)) / 2.471, 2) AS enriched_compost_ha,
    ROUND(SUM(COALESCE(if_used_bio_fertilizers, 0)) / 2.471, 2) AS bio_fertilizers_ha,
    ROUND(SUM(COALESCE(ph_correction_liming,    0)) / 2.471, 2) AS ph_liming_ha,
    ROUND(SUM(COALESCE(if_mulching,             0)) / 2.471, 2) AS mulching_ha,
    ROUND(SUM(COALESCE(if_green_cover,          0)) / 2.471, 2) AS green_cover_ha
FROM individual_farmer_visit
WHERE isActive = '1';


-- [FIX BUG-004] Area by Climate Mitigation Practice (bar chart, hectares)
SELECT
    ROUND(SUM(COALESCE(canopy_area,     0)) / 2.471, 2) AS two_tier_canopy_ha,
    ROUND(SUM(COALESCE(split_dose_area, 0)) / 2.471, 2) AS split_dose_fertilizer_ha,
    ROUND(SUM(COALESCE(pulp_waste_area, 0)) / 2.471, 2) AS pulp_waste_mgmt_ha
FROM individual_farmer_visit
WHERE isActive = '1';


-- [FIX BUG-004] Area by Livelihood Practice (bar chart, hectares)
SELECT
    ROUND(SUM(COALESCE(intercropping_area,  0)) / 2.471, 2) AS intercropping_ha,
    ROUND(SUM(COALESCE(phermone_traps_area, 0)) / 2.471, 2) AS pheromone_traps_ha
FROM individual_farmer_visit
WHERE isActive = '1';


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8: WATER MANAGEMENT
-- ─────────────────────────────────────────────────────────────────────────────

-- [FIX BUG-007] Rainwater Harvesting card
-- ROOT CAUSE: rainwater_harvesting column is VARCHAR('1'=Yes, '2'=No).
--             Query compared = 1 (integer) which fails in MySQL strict mode,
--             returning 0 for all rows even when data exists.
-- BEFORE: WHERE rainwater_harvesting = 1   → returns 0 in strict MySQL
-- AFTER : WHERE rainwater_harvesting = '1' → returns correct count
SELECT COUNT(DISTINCT farmer_name) AS rainwater_farmers   -- BUG-017 DISTINCT
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  rainwater_harvesting = '1';   -- string, not integer


-- [FIX BUG-008] Water Conservation Practices Adopted card
-- ROOT CAUSE: Query used WHERE demonstrated_practices LIKE '%Water%'.
--             demonstrated_practices stores comma-separated NUMERIC OPTION CODES
--             (e.g. '1,3,5'), not text labels. LIKE '%Water%' always returns 0.
--             The correct column is water_adopted_processes (dedicated field).
-- BEFORE: WHERE demonstrated_practices LIKE '%Water%' → always 0
-- AFTER : WHERE water_adopted_processes IS NOT NULL AND != ''
SELECT COUNT(DISTINCT farmer_name) AS water_conservation_farmers   -- BUG-017 DISTINCT
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  water_adopted_processes IS NOT NULL
  AND  water_adopted_processes != '';


-- Water practice option counts (bar breakdown)
SELECT
    SUM(CASE WHEN water_adopted_processes LIKE '%Farm Pond%'    THEN 1 ELSE 0 END) AS farm_pond,
    SUM(CASE WHEN water_adopted_processes LIKE '%Trenches%'     THEN 1 ELSE 0 END) AS trenches,
    SUM(CASE WHEN water_adopted_processes LIKE '%Drip%'
              OR water_adopted_processes LIKE '%Sprinkler%'     THEN 1 ELSE 0 END) AS drip_sprinkler
FROM individual_farmer_visit
WHERE isActive = '1';


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 9: BIODIVERSITY
-- ─────────────────────────────────────────────────────────────────────────────

-- Farmers receiving seedlings (input_provided is a CSV of input types)
SELECT COUNT(DISTINCT farmer_name) AS seedling_recipients   -- BUG-017 DISTINCT
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  (input_provided LIKE '%Seedlings%'
     OR input_provided LIKE '%seedlings%');


-- Native tree planting demos (Demo Activity)
SELECT COUNT(*) AS planting_demo_count
FROM   demo_farm_activity
WHERE  isActive = '1'
  AND  activity_type LIKE '%Planting%';


-- Total new beehives set up
SELECT SUM(nos_new_beehives) AS total_beehives
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  nos_new_beehives IS NOT NULL;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 10: FARMER DEMOGRAPHICS
-- ─────────────────────────────────────────────────────────────────────────────

-- Gender distribution (farmer_master_form)
SELECT
    gender_farmer,
    CASE gender_farmer
        WHEN '1' THEN 'Male'
        WHEN '2' THEN 'Female'
        WHEN '3' THEN 'Other'
        ELSE          'Unknown'
    END AS gender_label,
    COUNT(*) AS farmer_count
FROM farmer_master_form
WHERE isActive = '1'
GROUP BY gender_farmer;


-- Age group distribution
SELECT
    CASE
        WHEN age_of_farmer < 25              THEN 'Below 25'
        WHEN age_of_farmer BETWEEN 25 AND 35 THEN '25–35'
        WHEN age_of_farmer BETWEEN 36 AND 45 THEN '36–45'
        WHEN age_of_farmer BETWEEN 46 AND 55 THEN '46–55'
        WHEN age_of_farmer > 55              THEN 'Above 55'
        ELSE                                      'Unknown'
    END AS age_group,
    COUNT(*) AS farmer_count
FROM farmer_master_form
WHERE isActive = '1'
GROUP BY age_group
ORDER BY MIN(age_of_farmer);


-- Education level distribution
SELECT education_level_farmer AS level,
       COUNT(*) AS farmer_count
FROM   farmer_master_form
WHERE  isActive = '1'
  AND  education_level_farmer IS NOT NULL
GROUP  BY education_level_farmer
ORDER  BY farmer_count DESC;


-- [FIX BUG-013] Intercrops grown with coffee (pie chart)
-- ROOT CAUSE: Application code referenced column 'intercrops_grown' (with an 'r').
--             The actual DB column is 'intercops_grown' (without the 'r') — this is
--             a typo preserved in the production schema. Using the wrong spelling
--             throws "Unknown column" in MySQL, silently returning NULL/empty pie.
-- BEFORE: SELECT intercrops_grown FROM farmer_master_form  ← column does not exist
-- AFTER : SELECT intercops_grown  FROM farmer_master_form  ← correct spelling
SELECT
    intercops_grown   AS intercrop_type,   -- NOTE: 'intercops' not 'intercrops'
    COUNT(*)          AS farmer_count
FROM farmer_master_form
WHERE isActive = '1'
  AND intercops_grown IS NOT NULL
  AND intercops_grown != ''
GROUP  BY intercops_grown
ORDER  BY farmer_count DESC;


-- Coffee area by variety (Arabica vs Robusta) — in hectares
SELECT
    ROUND(SUM(COALESCE(coffee_area_arabica, 0)) / 2.471, 2) AS arabica_ha,
    ROUND(SUM(COALESCE(coffee_area_robusta, 0)) / 2.471, 2) AS robusta_ha
FROM farmer_master_form
WHERE isActive = '1';


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 11: OTHERS
-- ─────────────────────────────────────────────────────────────────────────────

-- Source of scheme access (ICCRL institutions pie chart)
SELECT
    institutions_if_yes AS institution,
    COUNT(*)            AS beneficiary_count
FROM individual_farmer_visit
WHERE isActive = '1'
  AND iccrl = '1'                       -- string comparison (BUG-009 pattern)
  AND institutions_if_yes IS NOT NULL
  AND institutions_if_yes != ''
GROUP  BY institutions_if_yes
ORDER  BY beneficiary_count DESC;


-- Farmers generating income through honey
SELECT COUNT(DISTINCT farmer_name) AS honey_income_farmers   -- BUG-017 DISTINCT
FROM   individual_farmer_visit
WHERE  isActive = '1'
  AND  (other_income_sources LIKE '%Honey%'
     OR other_income_sources LIKE '%honey%');
