# Centricity MF Screener Dashboard — Project Memory

**Purpose:** A static-site, partner-facing, password-gated mutual fund dashboard that auto-refreshes every fortnight from a validated Excel pipeline.

This file is the permanent project memory for any future Claude Code session opened against this repo. Read it first.

---

## 1. Architecture (locked for v1)

| Concern | Decision |
|---|---|
| Frontend | Vanilla HTML + Tailwind CSS (CDN) + lightweight JS, single-page-per-screen static site. No framework unless state complexity demands. |
| Hosting | **Public** GitHub repo + GitHub Pages (free tier). Repo description kept generic. |
| Access control | **Cloudflare Access** (free up to 50 users) — email magic-link or M365 SSO. The real auth barrier; the public repo carries non-sensitive fund metrics already shared with partners. |
| Build pipeline | GitHub Action with **file-name-pattern routing**: each Excel push triggers the matching converter (`scripts/excel_to_json_<source>.py`), validates against that source's contract, emits its JSON, commits, redeploys Pages. **Four sources, four converters, four contracts** — see §4.1. |
| Data sources | **Four independent pipelines**: MF Screener (bi-monthly), MF Analytics (monthly month-end), MF Monitor (as-on-date), Debt Screener (future). Each has its own contract + converter + JSON output. The dashboard **merges by AMFI scheme code at load time**; missing source data degrades gracefully, never breaks rendering. |
| Persistence | Browser `localStorage` only (Pattern A — personal customisation, no shared edits). |
| Permitted CDN libraries | Chart.js, TanStack Table or Grid.js (virtualisation), Mermaid, html2pdf.js, pptxgenjs. |
| Out of scope for v1 | Backend, mobile layout, shared editing, SSO beyond Cloudflare Access, live API feed, AIF / PMS modules. |

**v2 revisit (compliance permitting):** move to private GitHub repo + GitHub Pro, OR migrate hosting to Cloudflare Pages. Decision logged in `Skills/mf-dashboard-build/SKILL.md` §7.

---

## 2. Brand standards (non-negotiable)

Mirror of `Dashboard/Claude Design Dashboard Data/02_Centricity_Brand_Standards.md`.

| Element | Spec |
|---|---|
| Font | **Cambria** for 95% of all text. Fallback stack: `'Cambria', Georgia, 'Times New Roman', serif`. No sans-serif anywhere. |
| Background | `#FFFFFF` always. No dark mode. |
| Header | `#000000` bar, height 64px, sticky. White ALL-CAPS Cambria title left, logo top-right. |
| Footer | `#000000` bar, height 32px. White text — left: org line; right: "Last updated: DD MMM YYYY". |
| Primary | `#BD9568` Warm Gold — buttons, focus rings, primary chips, brand strokes |
| Secondary | `#DBC8B2` Light Tan — card fills, info pills |
| Decorative | `#BFBFBF` Medium Grey — concentric-circle motif (paired with gold ring, brand signature) |
| Dividers | `#D9D9D9` Light Grey — hairline rules, table row alternates (30–40% opacity) |
| Negative-only | `#931621` Dark Red — negative returns, drawdowns, alert High. Never a brand colour. |
| Optional positive | `#0F5132` Deep Green — sparingly, for positive returns to differentiate from default black |
| Caption / footnote | `#666666` Mid grey, 11–12px |
| Numerics | Tabular figures (`font-feature-settings: "tnum"; font-variant-numeric: tabular-nums;`). 2dp for %, ₹ Cr always for AUM (Indian comma grouping), DD MMM YYYY for dates. Missing values render as em dash "—" — never "0", "N/A", "null", or empty. |
| Cards | 4px corner radius, `0 1px 2px rgba(0,0,0,0.06)` shadow. Generous whitespace. |
| Motion | 200ms ease-out hover. No bouncy springs, no parallax, no animated illustrations. |
| Forbidden | Emojis in user-facing UI, stock photography, Lottie animations, gradients outside the palette, any logo other than the org's, any font other than Cambria + fallback. |

Status pills (BUY / HOLD / REVIEW / AVOID) and alert severities map to the palette per `02_Centricity_Brand_Standards.md` §7. Implement these as utility classes in `css/centricity.css`.

---

## 3. Design brief summary (8 screens — 6 wired + 2 placeholders for v1)

Canonical mapping in `Skills/mf-dashboard-build/SKILL.md` §3.1. Quick reference:

| # | Screen | Deployed page | v1 status |
|---|---|---|---|
| 1 | Home / Overview | `index.html` | Wired. Hero strip, "what changed" cards, Top 10 funds, alerts preview, quick-action tiles. |
| 2 | Interactive Screener | `screener.html` | Wired. Virtualised table, filters left rail, editable weights right drawer, multi-sort, compare-tick. |
| 3 | Fund Detail | `fund-detail.html` | Wired (Holdings + Movement marked `analytics_pending` for v1). |
| 4 | Custom Portfolio Builder | `portfolio-builder.html` | Wired. Mode A (manual) + Mode B (rule-based generator with constraint coverage report). |
| 5 | Comparison Mode | `compare.html` | Wired. Multi-fund × multi-cycle heatmaps + tabbed (Returns/Risk/Holdings/Sectors/M-cap/Manager/Expense/Rank). |
| 6 | Flags / Alerts | `alerts.html` | **Placeholder shell only.** Design pending — coming in v1.1. |
| 7 | Historical Archive | `archive.html` | Wired. Calendar grid of cycles; click → loads that snapshot. |
| 8 | Watchlist | `watchlist.html` | **Placeholder shell only.** Design pending — coming in v1.1. |

Tone of voice across every screen: institutional, sophisticated, insight-led. Lead with implication, not raw number.

---

## 4. Data contracts (one per source)

The dashboard reads from **four independent contracts**, each governing one upstream source. Each contract is the single source of truth for "what the dashboard expects from this source." Schema-check Action validates each push against its matching contract.

| Contract | Governs | Created in |
|---|---|---|
| `data-contract/screener-v1.json` | MF Screener Excel — rankings, scores, returns, risk, AUM, TER, manager | Step 2 (this session) |
| `data-contract/analytics-v1.json` | MF Analytics Excels — holdings, sectors, m-cap split, full stocks | Follow-up session (v1.x) |
| `data-contract/monitor-v1.json` | MF Monitor Excel — point-to-point trailing returns | Follow-up session (v1.x) |
| `data-contract/debt-v1.json` | Debt Screener Excel | Future (post-v1) |

**Primary key across all sources:** AMFI scheme code. Never fund name (names change, codes don't — see `Skills/mf-whitelisting/SKILL.md` §1.0.0). The dashboard merges sources at load time on this key.

**Universe:** dynamic, read from `cycle_meta.total_funds` + `cycle_meta.category_count` in the Screener JSON. Apr-15-2026 baseline = 530 equity + 117 hybrid = 647 funds across 26 sheets. **Never hardcode counts in UI** (see §9 rule 1).

**Derived fields in `screener-v1.json`** (computed by `scripts/excel_to_json_screener.py`, not present as Excel columns):
- `return_1y` / `return_3y` / `return_5y` / `return_si` — trailing point-to-point CAGR from `📈 Fund NAV`
- `benchmark_return_1y` / `_3y` / `_5y` — same from `📈 Benchmark NAV`
- `alpha_3y` / `alpha_5y` — fund minus benchmark over the trailing window
- `nav_latest_value` / `nav_latest_date` — last non-null NAV row for the fund (Fund Detail Fix-List 1 §A.1, additive)
- `rolling_3y_stats` — daily-roll 3Y CAGR statistics (avg / median / best / worst window-start dates / pct_positive / pct_above_12 / pct_beat_benchmark / observation_count). Null when fewer than 252 daily NAV observations (sub-1Y data — can't form a 3Y window). Powers Fund Detail's 6-card Rolling Returns grid. (Fund Detail Fix-List 1 §A.2, additive)
- `monitor_returns` / `exit_load` / `monitor_ter_pct` — overlay from the MF Monitor file. `monitor_returns` carries point-to-point YTD / 1M / 1Y / 3Y / 5Y / 10Y. `exit_load` is the free-text rule from the Monitor's `[Exit Load]` (equity sheets) or `Remark` (hybrid sheets) column. `monitor_ter_pct` is the regular-plan TER from Monitor's `Ratio` column — DISTINCT from `ter_pct` (which appears to carry direct-plan TER from the Whitelisting Excel). Both are preserved on the record per Designed-for-Change rule; Fund Detail displays `monitor_ter_pct`. See ISSUE-0013 for the discrepancy. (Fund Detail Fix-List 5 §A, additive)

**`analytics_pending: true` flags** appear on every Screener fund record for fields sourced from the Analytics pipeline (top-10 holdings, sector allocation, full stocks, manager-change history, category history). The dashboard renders these as placeholders ("Holdings data integration pending — coming in v1.1") until the Analytics converter ships.

**Schema-change protocol:** Any structural change in any Excel bumps that source's contract version (e.g., `screener-v1` → `screener-v2`) and the schema-check Action rejects mismatches. Old cycles continue to render against their original contract version (Archive integrity). See `Skills/mf-dashboard-build/SKILL.md` §8.

---

## 4.1 Source Pipeline Map — 4 product families × 3 source types (locked v1)

The dashboard's data architecture spans **four product families** (MF Equity & Hybrid, MF Debt, PMS, AIF), each with up to **three source types** (Screener / Analytics / Monitor). Each family has its own primary key, its own scoring methodology, and its own JSON contract. The dashboard MUST NEVER merge cycles across families.

| Family | Screener | Analytics | Monitor | Primary key |
|---|---|---|---|---|
| **MF Equity & Hybrid** | `screener-v1` ✅ shipped Step 2 | `analytics-v1` (v1.x) | `monitor-v1` (v1.x) | AMFI scheme code (int) |
| **MF Debt** | `debt-v1` (v1.x) | `debt-analytics-v1` (v1.x) | `debt-monitor-v1` (v1.x) | AMFI scheme code (int) |
| **PMS** | `pms-v1` (v2+) | `pms-analytics-v1` (v2+) | n/a — quarterly | SEBI PMS reg no. (string) |
| **AIF** | `aif-v1` (v2+) | `aif-analytics-v1` (v2+) | n/a — quarterly | SEBI AIF code (string) |

**Cross-family merge prohibition.** The dashboard's `js/data-loader.js` MUST NEVER merge cycles across families. Each family is its own universe with its own primary key, its own scoring methodology, and its own peer-pool definitions. Cross-family comparison (e.g., MF Equity vs PMS) is conceptually meaningless because methodologies differ — never offer a UI affordance that suggests it.

Every cycle JSON carries `cycle_meta.product_family` ∈ `{"MF_Equity_Hybrid", "MF_Debt", "PMS", "AIF"}` so the dashboard can refuse to load a JSON intended for a different family pipeline. v1's screener-v1 cycles emit `"MF_Equity_Hybrid"` (hardcoded by `excel_to_json_screener.py`).

### v1 file patterns (in `data/` — MF Equity & Hybrid only)

| Source | Cadence | File pattern in `data/` | v1 status |
|---|---|---|---|
| MF Eq+Hybrid Screener | Bi-monthly U1 (1st–5th) + U2 (15th–20th) | `MutualFund_Whitelisting_DDMonYYYY.xlsx` | ✅ Wired Step 2 |
| MF Eq+Hybrid NAV-series (per cycle) | Same cadence as Screener (emitted alongside) | n/a — derived in `excel_to_json_screener.py` from `📈 Fund NAV` + `📈 Benchmark NAV`. Output: `data/nav-series-YYYY-MM-DD.json` (monthly, capped 13y back). Lazy-loaded by `fund-detail.js` only. | ✅ Wired 2026-05-06 (Fund Detail Fix-List 1 §A.3) |
| MF Eq+Hybrid Analytics | Monthly month-end | Folder `Cent-Claude/Data/Analytics File/DD-MM-YYYY/` (`EQUITY MF.xlsx`, `HYBRID FUNDS.xlsx`, `Debt MF.xlsx`) | 🟡 Architecture wired Step 2; Equity + Hybrid converters built in v1.x |
| MF Eq+Hybrid Monitor | "As on date" — aligned to Screener cycles | `Daily_MF_monitor_DD_Month_YYYY.xlsx` | 🟡 Architecture wired Step 2; converter built in v1.x |

### Cadence-pairing rules

For any given Screener cycle date **C**:

1. **Analytics:** use the most recent month-end Analytics folder where folder-date **≤ C**. For C = 15-Apr-2026, that's `31-03-2026/` (April Analytics drops on 30-Apr, after the 15-Apr cycle). The converter looks up the right Analytics folder per cycle — **never hardcoded**.
2. **Monitor:** use the Monitor file dated exactly **C** if it exists, else the most recent file with date **≤ C**.
3. Each cycle JSON output bundles `source_dates: { screener, analytics, monitor }` so the UI can stamp Fund Detail with provenance like "Screener as on 15 Apr 2026 | Holdings as on 31 Mar 2026 | Returns as on 15 Apr 2026".

### Architectural rules (enforced by the build skill, not optional)

1. **One converter per source.** Files live in `Dashboard-Repo/scripts/`:
   - `excel_to_json_screener.py` — built in Step 2
   - `excel_to_json_analytics.py` — stub now (`TODO: v1.x`), built in follow-up session
   - `excel_to_json_monitor.py` — stub now (`TODO: v1.x`), built in follow-up session
   - `excel_to_json_debt.py` — **not even stubbed yet**; created when Debt Screener exists

2. **One JSON output per source per cycle**, all in `Dashboard-Repo/data/`:
   - `screener-YYYY-MM-DD.json`
   - `analytics-YYYY-MM-DD.json` (date = the month-end the Analytics folder represents)
   - `monitor-YYYY-MM-DD.json`
   - `debt-YYYY-MM-DD.json` (future)

3. **Dashboard merges by AMFI; for sources without AMFI in their Excel, the converter is responsible for the Scheme-Name → AMFI translation at build time.** The dashboard always reads JSONs keyed by AMFI scheme code and joins them at load time. When an upstream Excel lacks an AMFI column (e.g. the Analytics workbooks — confirmed in ISSUE-0008), the corresponding converter loads the Screener Excel for that cycle, builds a Scheme-Name → AMFI lookup from `📋 Data` cols B + D, and emits its JSON keyed by AMFI. The dashboard never sees the raw scheme-name join. If a fund has Screener data but no Analytics data, the Analytics fields render as "—" and the Holdings panel shows the placeholder. **Independent failure modes** — Analytics missing must never break Screener rendering, and vice versa.

4. **Each source has its own contract.** The schema-check Action validates each source's Excel against its own contract independently — a malformed Analytics push never blocks a valid Screener deploy.

5. **GitHub Action routes by file-name pattern.** Push patterns:
   - `data/MutualFund_Whitelisting_*.xlsx` → screener converter
   - `data/EQUITY_MF_*.xlsx` or `data/HYBRID_FUNDS_*.xlsx` → analytics converter
   - `data/Daily_MF_monitor_*.xlsx` → monitor converter

6. **Adding a new source** (Debt, AIF, PMS) = add one converter + one contract + one JSON shape. **Zero changes** to existing pipelines or to other dashboard screens.

---

## 5. Repo layout

```
Dashboard-Repo/
├── CLAUDE.md                              ← project memory (this file)
├── README.md                              ← short, generic, public-facing
├── .gitignore
├── .github/workflows/deploy.yml           ← file-pattern routing → schema-check + convert + redeploy
├── data-contract/
│   ├── screener-v1.json                   ← bi-monthly Screener contract (built Step 2)
│   ├── analytics-v1.json                  ← monthly Analytics contract (v1.x)
│   └── monitor-v1.json                    ← as-on-date Monitor contract (v1.x)
├── data/
│   ├── MutualFund_Whitelisting_DDMonYYYY.xlsx     ← Screener input
│   ├── EQUITY_MF_DD-MM-YYYY.xlsx                  ← Analytics input (Equity)
│   ├── HYBRID_FUNDS_DD-MM-YYYY.xlsx               ← Analytics input (Hybrid)
│   ├── Daily_MF_monitor_DD_Month_YYYY.xlsx        ← Monitor input
│   ├── screener-YYYY-MM-DD.json                   ← Screener output (auto)
│   ├── nav-series-YYYY-MM-DD.json                 ← Monthly NAV + benchmark series, capped 13y back; lazy-loaded by fund-detail.js for the "Growth of ₹ 1,00,000" chart. Emitted alongside the screener JSON by the same converter.
│   ├── analytics-YYYY-MM-DD.json                  ← Per-fund top-20 holdings + sector allocation + concentration metrics; built by scripts/excel_to_json_analytics.py (Equity + Hybrid; Debt deferred). Lazy-loaded by fund-detail.js. (Fix-List 5 §B)
│   ├── manager-profiles-template.csv              ← Manual-fill CSV (Manager / AMC / Funds / AUM auto-derived; Co-Manager / Bio / Source manually filled by Products Team). Replaces the auto-scrape JSON after quality issues. Built by scripts/build_manager_profiles.py. (Fix-List 5 §D)
│   ├── analytics-YYYY-MM-DD.json                  ← Analytics output (auto)
│   └── monitor-YYYY-MM-DD.json                    ← Monitor output (auto)
├── scripts/
│   ├── excel_to_json_screener.py          ← built Step 2; accepts optional Monitor xlsx (Fix-List 5 §A); emits screener JSON + nav-series file alongside (Fix-List 1 §A)
│   ├── excel_to_json_analytics.py         ← built Fix-List 5 §B (Equity + Hybrid); Debt holdings deferred until Debt Screener exists
│   ├── build_manager_profiles.py          ← built Fix-List 5 §D; emits manager-profiles-template.csv for manual enrichment (replaced the auto-scraper)
│   └── excel_to_json_monitor.py           ← stub (point-to-point Monitor returns are now overlaid by excel_to_json_screener.py via Fix-List 5 §A; this script may be retired in v1.x or repurposed for as-on-date Monitor outputs)
├── index.html                             ← Screen 1 — Home
├── screener.html                          ← Screen 2
├── fund-detail.html                       ← Screen 3
├── portfolio-builder.html                 ← Screen 4
├── compare.html                           ← Screen 5
├── alerts.html                            ← Screen 6 (placeholder shell, v1.1)
├── archive.html                           ← Screen 7
├── watchlist.html                         ← Screen 8 (placeholder shell, v1.1)
├── css/centricity.css                     ← brand standards as variables + utilities
├── js/
│   ├── data-loader.js                     ← fetches + caches each source JSON, merges by AMFI code
│   ├── state.js                           ← localStorage (Pattern A — views, weights, watchlist)
│   └── exports.js                         ← html2pdf.js + pptxgenjs wiring
└── assets/
    └── logo.png                           ← brand mark
```

---

## 6. v1 architectural decisions (referenced from `Skills/mf-dashboard-build/SKILL.md` §7)

1. **Public repo + Cloudflare Access** for v1. JSON is non-sensitive; auth gate is Cloudflare. Revisit in v2 if compliance prefers private. (2026-05-04)
2. **Universe = 647 funds across 26 sheets** including 5 hybrid categories. Caption strings render from `cycle_meta`, never hardcoded. (2026-05-04)
3. **Trailing returns derived in the converter**, not added to the Excel. Excel column layout stays locked. (2026-05-04)
4. **Holdings / movement marked `analytics_pending`** — v1.1 wires them when the Analytics file pipeline lands. (2026-05-04)
5. **6 wired screens + 2 placeholder shells** — Alerts and Watchlist deferred to v1.1 (no Claude Design mockups exist for them). (2026-05-04)
6. **Multi-data-source architecture** — four independent pipelines (Screener, Analytics, Monitor, future Debt Screener), each with its own converter + contract + JSON output. Dashboard merges by AMFI code at load time. Cadence-pairing rules locked in §4.1. (2026-05-04)
7. **Designed-for-Change principle** added as §9 — the dashboard is a living product, not a one-shot deliverable. (2026-05-04)

---

## 7. Pointers (the canonical sources)

| Topic | Where |
|---|---|
| Build operating manual + status table + changelog | `../../Skills/mf-dashboard-build/SKILL.md` |
| Issue forensic log | `../../Skills/mf-dashboard-build/ISSUES_LOG.md` |
| Upstream Excel build skill (NAV / AMFI conventions, locked column layout) | `../../Skills/mf-whitelisting/SKILL.md` |
| Master design brief (every screen, every interaction) | `../Dashboard_Design_Prompt_v1.md` + `../Claude Design Dashboard Data/04_Master_Design_Brief.md` |
| Brand standards | `../Claude Design Dashboard Data/02_Centricity_Brand_Standards.md` |
| Data schema reference (starting point for the contract) | `../Claude Design Dashboard Data/03_Data_Schema_Reference.md` |
| Approved mockups (Screens 1–5 + 7) | `../Claude Design Dashboard Data/Mockups/` |
| Logo source | `../Main Dashboard Link & Files/Logo.png` |
| Latest Screener Excel (canonical for Step 2) | `../../Monthly Equity Whitelisting File (MAIN FILE)/15th April 2026/MutualFund_Whitelisting_15Apr2026.xlsx` |
| Latest Analytics folder (for v1.x Analytics pipeline) | `../../../Data/Analytics File/31-03-2026/EQUITY MF.xlsx` + `HYBRID FUNDS.xlsx` + `Debt MF.xlsx` |
| Latest Monitor file (for v1.x Monitor pipeline) | `../../../Data/Daily Data/MF Monitor/Daily_MF_monitor_15_April_2026.xlsx` |
| Debt Screener Excel | _Does not yet exist; Debt Analytics underlyings are already in the Analytics folder above. Wire when Debt Screener is produced (post-v1)._ |

---

## 8. Operating principles for any future session

- **Schema drift is fatal.** Never patch the dashboard to "just make it work" with a mismatched Excel. Always update the contract first (`Skills/mf-dashboard-build/SKILL.md` §8).
- **Public-repo hygiene.** Keep code comments generic. No client / partner names anywhere. Repo description stays vague.
- **Centricity standards are locked.** Cambria, the documented palette, white background, negative-only Dark Red. Any deviation requires a new entry in `Skills/mf-dashboard-build/SKILL.md` §7.
- **Test before declaring done.** A working demo > "I wrote the code." Each numbered Step in the build plan needs verification.
- **Major architectural changes pause to Cowork.** Different framework, different host, adding a backend — flag, don't act.
- **Self-update at session end** — append a Changelog row to `Skills/mf-dashboard-build/SKILL.md` §10 and a forensic entry to `ISSUES_LOG.md` if anything surfaced.

---

## 9. Operating Principle — Designed for Change

The dashboard is a living product, not a one-shot deliverable. It must absorb continuous change without being rebuilt. Five rules:

1. **No hardcoded counts, names, or strings in UI code.** Every caption, count, category list, and label renders from data (`cycle_meta`, contract, or JSON). Adding a SEBI category, renaming an AMC, or changing the universe size requires zero UI edits.
2. **Each screen is its own HTML file.** Adding or removing a screen never affects any other screen. The 8 deployed pages in `Dashboard-Repo/` are independent leaves.
3. **Each data source is its own pipeline** (converter + contract + JSON output). Adding, removing, or replacing a source never affects other sources. The four-source map in §4.1 is the template — Debt, AIF, PMS slot in the same way.
4. **Versioned data contracts.** Schema changes bump versions (`screener-v1` → `screener-v2`). Old cycles continue rendering against their original contract for historical archive integrity. Never silently mutate a live contract.
5. **Every change is logged.** `ISSUES_LOG.md` entry + `SKILL.md` changelog row, no exceptions, even for trivial changes. The forensic trail is non-negotiable.

If a proposed change would violate any of these five rules, **stop and pause to Cowork** — that's the architectural-change escalation path from §8.
