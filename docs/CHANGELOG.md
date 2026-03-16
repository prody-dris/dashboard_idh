# Dashboard Data Integrity Fix — Change Log

**Branch:** `fix/dashboard-data-integrity-bugs`  
**Date:** 2026-03-16  
**Author:** Debug Engineer  
**Reviewed against:** `localhost__1_.sql` (idh_prod_sync_driver), `Dashboard_design_V2_7th_Feb.xlsx`, screen recording `Screen_Recording_2026-03-16_at_4_28_50_PM.mov`

---

## What Was Observed (Screen Recording Analysis)

The 22-second recording showed the dashboard at `dashboard.idh.mform.in`.  
**Confirmed fluctuations across 12 extracted frames:**

| Chart | Baseline Total | After Interaction | Δ |
|-------|---------------|-------------------|---|
| Farmer Engagement & Adoption | **1,185** | **1,067** | −118 |
| Regen Practices Adoption | **599** | **623** → **761** | +24, +162 |

Bar chart totals changed every time the user hovered or clicked a bar on a **different** chart. This is the primary production-visible bug.

---

## Bugs Fixed (17 total)

### 🔴 P0 — Critical (numbers wildly wrong)

| ID | Indicator | Root Cause | Fix |
|----|-----------|------------|-----|
| BUG-001 | Farmers Trained | `COUNT(*)` = sessions (15), not farmers (217) | `SUM(nosfarmers)` |
| BUG-002 | Demo Attendance | `COUNT(*)` = visit records (45), not farmers (735) | `SUM(nos_farmers)` |
| BUG-003 | Total Land (ha) | Missing `/2.471` — showed acres as hectares (266 instead of 107.7) | Divide by 2.471 |
| BUG-004 | All practice area bars | Same missing conversion on 12 columns | `/2.471` on each |
| BUG-005 | Soil Health Demo card | No `activity_type` filter — all 20 demos counted, not just 7 Soil Health | `WHERE activity_type LIKE '%Soil Health%'` |
| BUG-015 | **ALL charts** | **Cross-chart filter contamination — drill-down filter bled into base queries, causing all chart totals to change on every bar click** | Base queries isolated; drill-down uses separate `_drilldown` functions |
| BUG-016 | Farmers Trained | JOIN to `daily_activity_ffs_select_farmer` caused massive duplication (n×n) | Remove JOIN; aggregate parent table only |

### 🟠 P1 — High (wrong values, not always zero)

| ID | Indicator | Root Cause | Fix |
|----|-----------|------------|-----|
| BUG-006 | 4× Overview cards | No `isActive='1'` — soft-deleted records counted | `WHERE isActive = '1'` |
| BUG-007 | Rainwater Harvesting | `= 1` (int) fails on VARCHAR column in MySQL strict mode → always 0 | `= '1'` (string) |
| BUG-008 | Water Conservation | `demonstrated_practices LIKE '%Water%'` — column stores numeric codes, not labels → always 0 | Use `water_adopted_processes` column |
| BUG-009 | ICCRL Beneficiaries | Same int/VARCHAR issue as BUG-007 | `= '1'` (string) |
| BUG-017 | All farmer counts | No `DISTINCT` on `farmer_name` — farmers with multiple visit records counted N times | `COUNT(DISTINCT farmer_name)` |

### 🟡 P2 — Medium

| ID | Indicator | Root Cause | Fix |
|----|-----------|------------|-----|
| BUG-010 | Avg Training Duration | AVG included zero-duration rows | Exclude `training_duration = 0` |
| BUG-011 | Regen Adoption Levels | NULL/empty strings counted as 1 practice | CASE guard before comma count |
| BUG-012 | Soil Test After Aug 2024 | No date boundary | `if_yes_test_date >= '2024-08-01'` |
| BUG-013 | Intercrops pie | Column name typo `intercrops_grown` (doesn't exist) | `intercops_grown` (correct DB column) |
| BUG-014 | CKT Messages | Queried `baseline.messages_from_ckt` (wrong form) | `individual_farmer_visit.msg_from_ckt` |

---

## Files Changed

```
src/
  queries/
    dashboard_queries.sql          ← All corrected SQL (new file)
  api/
    dashboardDataService.js        ← All data service functions (new file)
    chartInteractionHandler.js     ← BUG-015 interaction isolation (new file)
tests/
  dataIntegrityChecks.js           ← Full test suite (new file)
docs/
  CHANGELOG.md                     ← This file
```

**UI changes: NONE.** No frontend components, charts, layout, or styling were touched.

---

## Safety Checklist

- [x] No UI/layout/styling modifications
- [x] No chart component changes
- [x] No dashboard structure changes
- [x] All queries include `isActive = '1'`
- [x] All area values divided by 2.471 for hectares
- [x] Base metric queries isolated from interaction filters (BUG-015)
- [x] Test suite covers all 17 bugs
- [x] All queries parameterised (no SQL injection risk)
- [x] Backward compatible (no schema changes, no column renames)

---

## How to Verify After Deploy

```bash
# Run data integrity checks against production DB
DB_HOST=<prod_host> DB_USER=<user> DB_PASS=<pass> DB_NAME=idh_prod_sync_driver \
  node tests/dataIntegrityChecks.js
```

Expected output: `✅ ALL CHECKS PASSED — safe to deploy`

---

## Key Rule: Base Queries vs Drill-Down (BUG-015)

```
Base query  (loaded once, never re-run on click) → shown in chart
                    │
              user clicks bar
                    │
                    ▼
Drill-down query (receives clicked filter) → shown in MODAL only
                    │
              user closes modal
                    │
                    ▼
Chart shows original cached base values — unchanged
```

Apply this pattern to every new chart added to the dashboard.
