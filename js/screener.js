/*
 * Centricity MF Screener Dashboard — screener.html page logic
 *
 * Two product families share this page (cycle U2 May 2026 onwards):
 *   • MF_Equity_Hybrid  — Centricity Score + Rank, weight drawer, returns/
 *                         risk/cost filters (the original universe).
 *   • MF_Debt           — Screening tool only. No score, no rank, no weight
 *                         drawer. Filters and columns swap to YTM / Avg
 *                         Maturity / Mod Duration + Credit Quality buckets.
 *
 * The Asset-Class tiles are the family switch. Selecting Equity and/or
 * Hybrid loads the screener-v1 cycle JSON; selecting Debt loads the
 * MF_Debt cycle JSON. The two families are NEVER concatenated in one
 * table (CLAUDE.md §4.1 cross-family prohibition); the tile group enforces
 * mutual exclusion between {equity, hybrid} and {debt}.
 *
 * Equity/Hybrid mode notes (unchanged from Fix-List 1+2):
 *   • Screener is the ONLY page where weight edits trigger recompute.
 *     Other pages read the Excel-locked centricity_score directly.
 *   • The drawer enumerates parameters from cycle_meta.scoring_weights[]
 *     — never hardcoded. (CLAUDE.md §9 rule 1)
 *
 * Debt mode notes (Phase 1):
 *   • is_ranked = false; no parameter_scores; no Score / Rank columns.
 *   • Default sort = AUM desc.
 *   • Cash bucket may be NEGATIVE for 24 liquid/MM funds (signed value
 *     in Dark Red #931621).
 *   • Asset-split debt may exceed 100 when cash is negative — render
 *     the literal values, never clamp.
 *
 * URL query-string state (so analysts can copy the address bar to share):
 *   ?ac=equity,hybrid                    → asset-class tile selection
 *                                          (ac=debt → MF_Debt family)
 *   ?cat=...                             → category dropdown
 *   ?amc=...                             → AMC dropdown
 *   ?sort=key_dir                        → table sort key + direction
 *   ?rng_<key>=<min>~<max>               → range filter state
 *   ?w_<param>=<value>                   → applied weight overrides (eqh only)
 *   ?xcol=...                            → enabled extra columns
 *   ?q=...                               → search box
 */
(function () {
  'use strict';

  /* ---------- module state ---------- */
  let _cycle = null;             // current cycle JSON for whichever family is active
  let _eqhCycle = null;          // cached MF_Equity_Hybrid cycle
  let _debtCycle = null;         // cached MF_Debt cycle (lazy-loaded on first switch)
  let _commodityCycle = null;    // synthesized Commodity family (from MF_Other, lazy)
  let _otherCycle = null;        // cached MF_Other JSON (Commodity/FoF/Solution — Not Scored)
  let _family = 'eqh';           // 'eqh' | 'debt' | 'commodity'

  let _allFunds = [];
  let _filteredFunds = [];
  let _scoringWeights = [];      // eqh only

  // Fix-List 10 §8 — Morningstar manager-history overlay. Lazy-loaded
  // alongside the cycle JSON; null until the fetch resolves. Built
  // once into _mgrByScheme: { scheme_code: {name, tenure_years} } from
  // resolved-main-manager (longest-tenure current per fund). Equity/
  // Hybrid family only — debt funds don't get an overlay.
  let _mgrHistoryCache = null;
  let _mgrByScheme = null;

  let _customWeights = null;     // applied weights (committed via OK) — eqh only
  let _draftWeights = null;      // currently being edited inside the drawer
  let _drawerOpen = false;

  let _sortKey = 'score';
  let _sortDir = 'desc';
  const MAX_COMPARE = 5;
  let _selected = new Set();     // AMFI codes ticked for Compare

  let _acTiles, _catMS, _amcMS, _addColMS, _sectorMS;   // selector instances
  /* v4 §H — sector filter (max 5; each adds a sortable column) — eqh only */
  const SECTOR_FILTER_MAX = 5;
  let _activeSectors = [];
  let _sectorLookup  = null;
  let _allSectors    = [];

  // Filter ranges in *display units*. Domain bounds derived from data.
  let _filterRanges  = {};       // {key: {min, max}}
  let _filterDomains = {};       // {key: {min, max, step}}

  let _activeExtras = [];        // dotted-path values for extra columns
  let _capWarnTimer = null;

  /* ============================================================
   * RANGE / COLUMN / EXTRA-COLUMN CONFIG — split per family
   * ============================================================ */
  /**
   * AUM slider is shared — it lives outside the dynamic section block in
   * the HTML and applies to both families. The dynamic sections (Returns
   * / Risk / Credit Quality / Debt Profile / Others) get rebuilt when the
   * family switches.
   *
   *   kind = 'inr' | 'pct' | 'pct-pos' | 'num' | 'int' | 'score-pct'
   *     (see formatRangeValue below for formatter behaviour)
   */
  const AUM_RANGE = {
    id: 'rngAum', key: 'aum_cr', label: 'AUM',
    accessor: f => f.aum_cr,
    kind: 'inr', hardCapMin: 0, hardCapMax: 100000, step: 1000,
  };

  // ----- Equity/Hybrid family -----
  const RANGE_CONFIG_EQH = [
    AUM_RANGE,
    { id: 'rngRolling', key: 'rolling_3y_avg_pct',  label: 'Rolling 3Y Avg',     accessor: f => f.rolling_3y_avg_pct,              kind: 'pct',       step: 0.5 },
    { id: 'rngYtd',     key: 'cy_ytd_pct',          label: 'YTD',                accessor: f => f.cy_returns ? f.cy_returns.cy_ytd_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngR1',      key: 'return_1y_pct',       label: '1Y',                 accessor: f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngR3',      key: 'return_3y_pct',       label: '3Y',                 accessor: f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngR5',      key: 'return_5y_pct',       label: '5Y',                 accessor: f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngSharpe',  key: 'sharpe_3y',           label: 'Sharpe',             accessor: f => f.risk_metrics ? f.risk_metrics.sharpe_3y : null, kind: 'num', step: 0.05 },
    { id: 'rngSortino', key: 'sortino_3y',          label: 'Sortino',            accessor: f => f.risk_metrics ? f.risk_metrics.sortino_3y : null, kind: 'num', step: 0.05 },
    { id: 'rngStdDev',  key: 'std_dev_3y_pct',      label: 'Std Dev',            accessor: f => f.risk_metrics ? f.risk_metrics.std_dev_3y_pct : null, kind: 'pct-pos', step: 0.5 },
    { id: 'rngDownCap', key: 'down_capture_3y_pct', label: 'Down Capture',       accessor: f => f.risk_metrics ? f.risk_metrics.down_capture_3y_pct : null, kind: 'pct-pos', step: 1 },
    { id: 'rngUpCap',   key: 'up_capture_3y_pct',   label: 'Up Capture',         accessor: f => f.risk_metrics ? f.risk_metrics.up_capture_3y_pct : null, kind: 'pct-pos', step: 1 },
    { id: 'rngTurn',    key: 'turnover_pct',        label: 'Portfolio Turnover', accessor: f => f.turnover_pct,                    kind: 'pct-pos',   step: 1 },
    { id: 'rngMgrTen',  key: 'manager_tenure_yrs',  label: 'Mgr Tenure',         accessor: f => pluck(f, 'manager_tenure_yrs'),    kind: 'num',       suffix: ' yrs', step: 0.5 },
    { id: 'rngFundTen', key: 'fund_tenure_yrs',     label: 'Fund Tenure',        accessor: f => f.fund_tenure_yrs,                 kind: 'num',       suffix: ' yrs', step: 0.5 },
    { id: 'rngStocks',  key: 'no_of_stocks',        label: 'No. of Stocks',      accessor: f => f.no_of_stocks,                    kind: 'int',       step: 1 },
    { id: 'rngTer',     key: 'ter_pct',             label: 'TER',                accessor: f => f.ter_pct,                         kind: 'pct-pos',   step: 0.05 },
    { id: 'rngScore',   key: 'centricity_score',    label: 'Score',              accessor: f => f.centricity_score,                kind: 'score-pct', step: 1 },
  ];
  const SECTIONS_EQH = [
    {
      key: 'returns', title: 'Returns Filters',
      slider_keys: ['rolling_3y_avg_pct', 'cy_ytd_pct', 'return_1y_pct', 'return_3y_pct', 'return_5y_pct'],
    },
    {
      key: 'risk', title: 'Risk Ratios',
      slider_keys: ['sharpe_3y', 'sortino_3y', 'std_dev_3y_pct', 'down_capture_3y_pct', 'up_capture_3y_pct', 'turnover_pct'],
    },
    {
      key: 'others', title: 'Others',
      slider_keys: ['manager_tenure_yrs', 'fund_tenure_yrs', 'no_of_stocks', 'ter_pct', 'centricity_score'],
    },
  ];

  // ----- MF_Debt family -----
  const RANGE_CONFIG_DEBT = [
    AUM_RANGE,
    { id: 'rngYtm',     key: 'ytm_pct',           label: 'YTM',           accessor: f => f.debt_profile ? f.debt_profile.ytm_pct : null,           kind: 'pct-pos', suffix: '%',   step: 0.05 },
    { id: 'rngAvgMat',  key: 'avg_maturity_yrs',  label: 'Avg Maturity',  accessor: f => f.debt_profile ? f.debt_profile.avg_maturity_yrs : null,  kind: 'num',     suffix: ' yrs', step: 0.25 },
    { id: 'rngModDur',  key: 'mod_duration_yrs',  label: 'Mod Duration',  accessor: f => f.debt_profile ? f.debt_profile.mod_duration_yrs : null,  kind: 'num',     suffix: ' yrs', step: 0.25 },
    { id: 'rngHiGrade', key: 'cq_high_grade_pct', label: 'SOV + AAA/A1+', accessor: f => debtHighGradePct(f),                                        kind: 'pct-pos', step: 1 },
    { id: 'rngAblw',    key: 'cq_a_below_pct',    label: 'A & Below',     accessor: f => f.credit_quality ? f.credit_quality.a_below : null,        kind: 'pct-pos', step: 1 },
    { id: 'rngTerDebt', key: 'ter_pct',           label: 'TER',           accessor: f => f.ter_pct,                                                  kind: 'pct-pos', step: 0.05 },
  ];
  const SECTIONS_DEBT = [
    {
      key: 'debt_profile', title: 'Debt Profile',
      slider_keys: ['ytm_pct', 'avg_maturity_yrs', 'mod_duration_yrs'],
    },
    {
      key: 'credit_quality', title: 'Credit Quality',
      // Two slider screens — "Min %SOV+AAA" and "Max %A&Below" — share the
      // standard two-handle range UI; analysts move whichever handle they
      // care about.
      slider_keys: ['cq_high_grade_pct', 'cq_a_below_pct'],
    },
    {
      key: 'cost', title: 'Cost',
      slider_keys: ['ter_pct'],
    },
  ];

  // ----- Commodity family (MF_Other → Commodity, Not Scored) -----
  // Commodity funds carry only AUM / TER / trailing returns / NAV — no risk
  // ratios, no centricity score, no sectors. Minimal screen-only config.
  const RANGE_CONFIG_COMMODITY = [
    AUM_RANGE,
    { id: 'rngR1', key: 'return_1y_pct', label: '1Y', accessor: f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngR3', key: 'return_3y_pct', label: '3Y', accessor: f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngR5', key: 'return_5y_pct', label: '5Y', accessor: f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngTer', key: 'ter_pct', label: 'TER', accessor: f => f.ter_pct, kind: 'pct-pos', step: 0.05 },
  ];
  const SECTIONS_COMMODITY = [
    { key: 'returns', title: 'Returns Filters', slider_keys: ['return_1y_pct', 'return_3y_pct', 'return_5y_pct'] },
    { key: 'cost', title: 'Cost', slider_keys: ['ter_pct'] },
  ];

  function debtHighGradePct(f) {
    if (!f || !f.credit_quality) return null;
    const sov = f.credit_quality.sov;
    const aaa = f.credit_quality.aaa_a1;
    if (sov == null && aaa == null) return null;
    return (sov || 0) + (aaa || 0);
  }

  /* ---------- nested-path resolver (used by sort + extra columns) ---------- */
  function pluck(obj, path) {
    if (obj == null) return null;
    // Phase 2.2 Patch (mgr attribution) — the prior Fix-List 10 §8
    // `_mgrByScheme` overlay re-derived the "main manager" from the
    // separate manager-history JSON via a fuzzy-match against the
    // screener's manager_name. With the converter now writing the SINGLE
    // lead into `manager_name` (catalogue §7.8), the overlay is both
    // redundant and forbidden ("UI MUST NOT re-derive"). The screener
    // reads `manager_name` + `manager_tenure_yrs` straight from the cycle
    // JSON. `_mgrByScheme` / `_loadMgrHistoryOverlay` are left in place
    // for now (no harm; could be deleted in a follow-up housekeeping pass).
    return String(path).split('.').reduce((o, k) => (o == null ? null : o[k]), obj);
  }

  /* ---------- table column config — Equity/Hybrid (default) ---------- */
  const DEFAULT_COLUMNS_EQH = [
    { key: '_check',   label: '',               align: 'center', cls: 'col-check',
      sortable: false,
      sortValue: () => null,
      text: f => `<input type="checkbox" class="row-check" data-scheme="${f.scheme_code}"${_selected.has(f.scheme_code) ? ' checked' : ''} aria-label="Select for compare">` },
    { key: 'rank',     label: 'Rank',           align: 'center', cls: 'col-rank',
      sortable: true,
      sortValue: f => f._displayRank,
      text: f => `<span class="num">${f._displayRank != null ? f._displayRank : '—'}</span>`,
      titleHelp: 'Rank by Centricity score across the current selection.' },
    { key: 'name',     label: 'Fund Name',      align: 'left',   cls: 'col-name',
      sortable: true,
      sortValue: f => (f.fund_name || '').toLowerCase(),
      text: f => `<a class="fund-name-link" href="fund-detail.html?scheme=${f.scheme_code}">${escapeHtml(f.fund_name)}</a>` },
    { key: 'category', label: 'Category',       align: 'center', sortable: true,
      sortValue: f => (f.category || '').toLowerCase(),
      text: f => escapeHtml(f.category || '—') },
    { key: 'aum',      label: 'AUM ₹ Cr',       align: 'center', sortable: true,
      sortValue: f => f.aum_cr,
      text: f => `₹ ${DataLoader.fmtINR(f.aum_cr)}` },
    { key: 'rolling',  label: 'Rolling Returns', align: 'center', neg: true, sortable: true,
      sortValue: f => f.rolling_3y_avg_pct,
      pickRaw:   f => f.rolling_3y_avg_pct,
      text: f => fmtPctCell(f.rolling_3y_avg_pct) },
    { key: 'ytd',      label: 'YTD',            align: 'center', neg: true, sortable: true,
      sortValue: f => f.cy_returns ? f.cy_returns.cy_ytd_pct : null,
      pickRaw:   f => f.cy_returns ? f.cy_returns.cy_ytd_pct : null,
      text: f => fmtPctCell(f.cy_returns ? f.cy_returns.cy_ytd_pct : null) },
    { key: 'r1',       label: '1Y',             align: 'center', neg: true, sortable: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_1y_pct : null) },
    { key: 'r3',       label: '3Y',             align: 'center', neg: true, sortable: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_3y_pct : null) },
    { key: 'r5',       label: '5Y',             align: 'center', neg: true, sortable: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_5y_pct : null) },
    { key: 'sharpe',   label: 'Sharpe',         align: 'center', sortable: true,
      sortValue: f => f.risk_metrics ? f.risk_metrics.sharpe_3y : null,
      text: f => DataLoader.fmtNum(f.risk_metrics ? f.risk_metrics.sharpe_3y : null) },
    { key: 'score',    label: 'Score',          align: 'center', sortable: true,
      sortValue: f => f._displayScore,
      text: f => renderScoreCell(f) },
  ];

  /* ---------- table column config — MF_Debt ---------- */
  const DEFAULT_COLUMNS_DEBT = [
    { key: '_check',   label: '',               align: 'center', cls: 'col-check',
      sortable: false,
      sortValue: () => null,
      text: f => `<input type="checkbox" class="row-check" data-scheme="${f.scheme_code}"${_selected.has(f.scheme_code) ? ' checked' : ''} aria-label="Select for compare">` },
    { key: 'name',     label: 'Fund Name',      align: 'left',   cls: 'col-name',
      sortable: true,
      sortValue: f => (f.fund_name || '').toLowerCase(),
      text: f => `<a class="fund-name-link" href="fund-detail.html?scheme=${f.scheme_code}">${escapeHtml(f.fund_name)}</a>` },
    { key: 'category', label: 'Category',       align: 'center', sortable: true,
      sortValue: f => (f.category || '').toLowerCase(),
      text: f => escapeHtml(f.category || '—') },
    { key: 'aum',      label: 'AUM ₹ Cr',       align: 'center', sortable: true,
      sortValue: f => f.aum_cr,
      text: f => `₹ ${DataLoader.fmtINR(f.aum_cr)}` },
    { key: 'ter',      label: 'TER',            align: 'center', sortable: true,
      sortValue: f => f.ter_pct,
      text: f => f.ter_pct != null ? `${DataLoader.fmtNum(f.ter_pct, 2)}%` : '—' },
    { key: 'ytm',      label: 'YTM',            align: 'center', sortable: true,
      sortValue: f => f.debt_profile ? f.debt_profile.ytm_pct : null,
      text: f => fmtPctPos(f.debt_profile ? f.debt_profile.ytm_pct : null) },
    { key: 'avgmat',   label: 'Avg Maturity',   align: 'center', sortable: true,
      sortValue: f => f.debt_profile ? f.debt_profile.avg_maturity_yrs : null,
      text: f => fmtYrs(f.debt_profile ? f.debt_profile.avg_maturity_yrs : null) },
    { key: 'moddur',   label: 'Mod Duration',   align: 'center', sortable: true,
      sortValue: f => f.debt_profile ? f.debt_profile.mod_duration_yrs : null,
      text: f => fmtYrs(f.debt_profile ? f.debt_profile.mod_duration_yrs : null) },
    { key: 'r1',       label: '1Y',             align: 'center', neg: true, sortable: true,
      sortValue: f => f.returns ? f.returns.y1_pct : null,
      pickRaw:   f => f.returns ? f.returns.y1_pct : null,
      text: f => fmtPctCell(f.returns ? f.returns.y1_pct : null) },
    { key: 'r3',       label: '3Y',             align: 'center', neg: true, sortable: true,
      sortValue: f => f.returns ? f.returns.y3_pct : null,
      pickRaw:   f => f.returns ? f.returns.y3_pct : null,
      text: f => fmtPctCell(f.returns ? f.returns.y3_pct : null) },
    { key: 'r5',       label: '5Y',             align: 'center', neg: true, sortable: true,
      sortValue: f => f.returns ? f.returns.y5_pct : null,
      pickRaw:   f => f.returns ? f.returns.y5_pct : null,
      text: f => fmtPctCell(f.returns ? f.returns.y5_pct : null) },
    { key: 'si',       label: 'SI',             align: 'center', neg: true, sortable: true,
      sortValue: f => f.returns ? f.returns.si_pct : null,
      pickRaw:   f => f.returns ? f.returns.si_pct : null,
      text: f => fmtPctCell(f.returns ? f.returns.si_pct : null) },
  ];

  /* ---------- "Add columns" library — Equity/Hybrid (default) ---------- */
  const EXTRA_COLS_EQH = [
    // Holdings (m-cap split)
    { value: 'mcap_split.large_pct',   label: 'Large Cap %',   group: 'Holdings',         kind: 'pct-pos' },
    { value: 'mcap_split.mid_pct',     label: 'Mid Cap %',     group: 'Holdings',         kind: 'pct-pos' },
    { value: 'mcap_split.small_pct',   label: 'Small Cap %',   group: 'Holdings',         kind: 'pct-pos' },
    { value: 'mcap_split.others_pct',  label: 'Others %',      group: 'Holdings',         kind: 'pct-pos' },
    { value: 'no_of_stocks',           label: 'No. of Stocks', group: 'Holdings',         kind: 'int' },
    // v2 — Avg Mkt Cap, Fund PE, Active Share (added 2026-05-24, Phase 2)
    { value: 'avg_mcap_cr',            label: 'Avg Market Cap (₹ Cr)', group: 'Holdings',  kind: 'inr' },
    { value: 'fund_pe',                label: 'Fund PE',       group: 'Holdings',         kind: 'num' },
    { value: 'active_share_pct',       label: 'Active Share %', group: 'Holdings',        kind: 'pct-pos' },
    // v2 — universal asset split (was hybrid-only in v1)
    { value: 'asset_split.equity_pct', label: 'Equity %',       group: 'Asset split',     kind: 'pct-pos' },
    { value: 'asset_split.debt_pct',   label: 'Debt %',         group: 'Asset split',     kind: 'pct-pos' },
    { value: 'asset_split.others_pct', label: 'Others %',       group: 'Asset split',     kind: 'pct-pos' },
    // Hybrid extension — debt-side fields kept for hybrid funds (YTM, durations)
    { value: 'hybrid_extension.ytm',              label: 'YTM',               group: 'Hybrid extension', kind: 'pct-pos' },
    { value: 'hybrid_extension.mod_duration_yrs', label: 'Mod Duration',      group: 'Hybrid extension', kind: 'num', suffix: ' yrs' },
    { value: 'hybrid_extension.avg_maturity_yrs', label: 'Avg Maturity',      group: 'Hybrid extension', kind: 'num', suffix: ' yrs' },
    // Risk metrics
    { value: 'risk_metrics.sortino_3y',           label: 'Sortino',         group: 'Risk metrics', kind: 'num' },
    { value: 'risk_metrics.std_dev_3y_pct',       label: 'Std Dev (3Y)',    group: 'Risk metrics', kind: 'pct-pos' },
    { value: 'risk_metrics.max_drawdown_3y_pct',  label: 'Max DD (3Y)',     group: 'Risk metrics', kind: 'pct', neg: true },
    { value: 'risk_metrics.beta_3y',              label: 'Beta',            group: 'Risk metrics', kind: 'num' },
    { value: 'risk_metrics.treynor_3y',           label: 'Treynor',         group: 'Risk metrics', kind: 'num' },
    { value: 'risk_metrics.up_capture_3y_pct',    label: 'Up Capture',      group: 'Risk metrics', kind: 'pct-pos' },
    { value: 'risk_metrics.down_capture_3y_pct',  label: 'Down Capture',    group: 'Risk metrics', kind: 'pct-pos' },
    { value: 'risk_metrics.overall_capture_3y_pct',label:'Overall Capture', group: 'Risk metrics', kind: 'pct-pos' },
    // Cost & turnover
    { value: 'ter_pct',                           label: 'TER %',           group: 'Cost & turnover', kind: 'pct-pos' },
    { value: 'turnover_pct',                      label: 'Turnover %',      group: 'Cost & turnover', kind: 'pct-pos' },
    // Tenure
    { value: 'manager_tenure_yrs',                label: 'Manager Tenure',  group: 'Tenure', kind: 'num', suffix: ' yrs' },
    { value: 'fund_tenure_yrs',                   label: 'Fund Tenure',     group: 'Tenure', kind: 'num', suffix: ' yrs' },
    // Identification
    { value: 'amc',                               label: 'AMC',             group: 'Identification', kind: 'string' },
    { value: 'amc_score',                         label: 'AMC Score',       group: 'Identification', kind: 'score-int' },
    { value: 'benchmark',                         label: 'Benchmark',       group: 'Identification', kind: 'string' },
    { value: 'inception_date',                    label: 'Inception Date',  group: 'Identification', kind: 'date' },
    { value: 'manager_name',                      label: 'Manager Name',    group: 'Identification', kind: 'string' },
    // Calendar returns
    { value: 'cy_returns.cy2022_pct',             label: 'CY2022 %',        group: 'Calendar returns', kind: 'pct', neg: true },
    { value: 'cy_returns.cy2023_pct',             label: 'CY2023 %',        group: 'Calendar returns', kind: 'pct', neg: true },
    { value: 'cy_returns.cy2024_pct',             label: 'CY2024 %',        group: 'Calendar returns', kind: 'pct', neg: true },
    { value: 'cy_returns.cy2025_pct',             label: 'CY2025 %',        group: 'Calendar returns', kind: 'pct', neg: true },
    // Other
    { value: 'consistency_pct',                   label: 'Consistency %',   group: 'Other', kind: 'pct-pos' },
  ];

  /* ---------- "Add columns" library — MF_Debt ---------- */
  const EXTRA_COLS_DEBT = [
    // Credit quality buckets (signed — cash may be negative)
    { value: 'credit_quality.sov',     label: 'SOV %',          group: 'Credit quality', kind: 'pct-pos' },
    { value: 'credit_quality.aaa_a1',  label: 'AAA / A1+ %',    group: 'Credit quality', kind: 'pct-pos' },
    { value: 'credit_quality.aa',      label: 'AA %',           group: 'Credit quality', kind: 'pct-pos' },
    { value: 'credit_quality.a_below', label: 'A & Below %',    group: 'Credit quality', kind: 'pct-pos' },
    { value: 'credit_quality.unrated', label: 'Unrated %',      group: 'Credit quality', kind: 'pct-pos' },
    { value: 'credit_quality.cash',    label: 'Cash & Equiv %', group: 'Credit quality', kind: 'pct-signed' },
    { value: 'credit_quality.others',  label: 'Others %',       group: 'Credit quality', kind: 'pct-pos' },
    // Asset split (debt-share may exceed 100 when cash is negative — render literal)
    { value: 'asset_split.debt',       label: 'Debt %',         group: 'Asset split',    kind: 'pct-pos' },
    { value: 'asset_split.cash',       label: 'Cash %',         group: 'Asset split',    kind: 'pct-signed' },
    { value: 'asset_split.equity',     label: 'Equity %',       group: 'Asset split',    kind: 'pct-pos' },
    { value: 'asset_split.others',     label: 'Others %',       group: 'Asset split',    kind: 'pct-pos' },
    // Returns — periods not in the default debt column set
    { value: 'returns.mtd_pct',        label: 'MTD %',          group: 'Returns',        kind: 'pct', neg: true },
    { value: 'returns.ytd_pct',        label: 'YTD %',          group: 'Returns',        kind: 'pct', neg: true },
    { value: 'returns.m3_pct',         label: '3M %',           group: 'Returns',        kind: 'pct', neg: true },
    { value: 'returns.m6_pct',         label: '6M %',           group: 'Returns',        kind: 'pct', neg: true },
    { value: 'returns.y10_pct',        label: '10Y %',          group: 'Returns',        kind: 'pct', neg: true },
    // Risk flags
    { value: 'pct_in_default',         label: '% in Default',   group: 'Other',          kind: 'pct-pos' },
    // Identification
    { value: 'amc',                    label: 'AMC',            group: 'Identification', kind: 'string' },
    { value: 'benchmark',              label: 'Benchmark',      group: 'Identification', kind: 'string' },
    { value: 'inception_date',         label: 'Inception Date', group: 'Identification', kind: 'date-str' },
    { value: 'manager_name',           label: 'Manager Name',   group: 'Identification', kind: 'string' },
    { value: 'manager_tenure_yrs',     label: 'Manager Tenure', group: 'Identification', kind: 'num', suffix: ' yrs' },
  ];

  /* ---------- table column config — Commodity (Not Scored) ---------- */
  const DEFAULT_COLUMNS_COMMODITY = [
    { key: '_check',   label: '',          align: 'center', cls: 'col-check', sortable: false,
      sortValue: () => null,
      text: f => `<input type="checkbox" class="row-check" data-scheme="${f.scheme_code}"${_selected.has(f.scheme_code) ? ' checked' : ''} aria-label="Select for compare">` },
    { key: 'name',     label: 'Fund Name', align: 'left', cls: 'col-name', sortable: true,
      sortValue: f => (f.fund_name || '').toLowerCase(),
      text: f => `<a class="fund-name-link" href="fund-detail.html?scheme=${f.scheme_code}">${escapeHtml(f.fund_name)}</a>` },
    { key: 'category', label: 'Category',   align: 'center', sortable: true,
      sortValue: f => (f.category || '').toLowerCase(),
      text: f => escapeHtml(f.category || '—') },
    { key: 'aum',      label: 'AUM ₹ Cr',   align: 'center', sortable: true,
      sortValue: f => f.aum_cr,
      text: f => `₹ ${DataLoader.fmtINR(f.aum_cr)}` },
    { key: 'ter',      label: 'TER',        align: 'center', sortable: true,
      sortValue: f => f.ter_pct,
      text: f => f.ter_pct != null ? `${DataLoader.fmtNum(f.ter_pct, 2)}%` : '—' },
    { key: 'r1',       label: '1Y',         align: 'center', neg: true, sortable: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_1y_pct : null) },
    { key: 'r3',       label: '3Y',         align: 'center', neg: true, sortable: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_3y_pct : null) },
    { key: 'r5',       label: '5Y',         align: 'center', neg: true, sortable: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_5y_pct : null) },
    { key: 'si',       label: 'SI',         align: 'center', neg: true, sortable: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_si_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_si_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_si_pct : null) },
  ];
  const EXTRA_COLS_COMMODITY = [
    { value: 'underlying_metal',    label: 'Underlying Metal', group: 'Commodity',      kind: 'string' },
    { value: 'nav_latest_value',    label: 'NAV',              group: 'Commodity',      kind: 'num' },
    { value: 'trailing_returns.return_si_pct', label: 'SI %',  group: 'Returns',        kind: 'pct', neg: true },
    { value: 'amc',                 label: 'AMC',              group: 'Identification', kind: 'string' },
    { value: 'manager_name',        label: 'Manager Name',     group: 'Identification', kind: 'string' },
    { value: 'inception_date',      label: 'Inception Date',   group: 'Identification', kind: 'date-str' },
  ];

  /* ---------- family-aware config accessors ---------- */
  function rangeConfig()  { return _family === 'debt' ? RANGE_CONFIG_DEBT : _family === 'commodity' ? RANGE_CONFIG_COMMODITY : RANGE_CONFIG_EQH; }
  function sections()     { return _family === 'debt' ? SECTIONS_DEBT    : _family === 'commodity' ? SECTIONS_COMMODITY    : SECTIONS_EQH; }
  function defaultCols()  { return _family === 'debt' ? DEFAULT_COLUMNS_DEBT : _family === 'commodity' ? DEFAULT_COLUMNS_COMMODITY : DEFAULT_COLUMNS_EQH; }
  function extraColsLib() { return _family === 'debt' ? EXTRA_COLS_DEBT  : _family === 'commodity' ? EXTRA_COLS_COMMODITY  : EXTRA_COLS_EQH; }

  /* ---------- bootstrap ---------- */
  document.addEventListener('DOMContentLoaded', main);

  async function main() {
    // Asset-class tile selection drives the family. URL ?ac=debt opens debt,
    // ?ac=commodity opens the Commodity family; otherwise the eqh universe.
    const urlAc = readAssetClassFromUrl();
    const initialFamily = (urlAc === 'debt' || urlAc === 'commodity') ? urlAc : 'eqh';

    try {
      if (initialFamily === 'eqh')            await ensureEqhCycle();
      else if (initialFamily === 'debt')      await ensureDebtCycle();
      else if (initialFamily === 'commodity') await ensureCommodityCycle();
    } catch (err) {
      renderLoadError(err);
      return;
    }

    setActiveFamily(initialFamily, /* initial */ true);
    initFilters();
    initWeightDrawer();
    initToolbar();
    initSectorFilter();
    initCompareButton();
    parseUrlState();
    applyAndRender();
    initToasts();

    if (_family === 'eqh') _loadMgrHistoryOverlay();
  }

  function readAssetClassFromUrl() {
    const p = new URLSearchParams(window.location.search);
    if (!p.has('ac')) return null;
    const vals = p.get('ac').split(',').map(s => s.trim().toLowerCase());
    if (vals.includes('debt')) return 'debt';
    if (vals.includes('commodity')) return 'commodity';
    return null;
  }

  async function ensureEqhCycle() {
    if (_eqhCycle) return _eqhCycle;
    const initialDate = await Cycle.getActiveCycle();
    _eqhCycle = await DataLoader.loadCycle(initialDate);
    await ensureOther();   // so eq/hybrid Other funds merge + tile counts populate
    return _eqhCycle;
  }

  async function ensureDebtCycle() {
    if (_debtCycle) return _debtCycle;
    _debtCycle = await DataLoader.loadDebtCycle();   // picks latest
    await ensureOther();
    return _debtCycle;
  }

  async function ensureCommodityCycle() {
    if (_commodityCycle) return _commodityCycle;
    await ensureOther();
    const funds = otherByClass('Commodity');
    const meta = (_otherCycle && _otherCycle.cycle_meta) || {};
    _commodityCycle = {
      cycle_meta: {
        product_family: 'MF_Other',
        cycle_date: meta.cycle_date || '2026-05-15',
        total_funds: funds.length,
        category_count: new Set(funds.map(f => f.category).filter(Boolean)).size,
        as_on_display: meta.as_on_display || '15 May 2026',
      },
      funds,
    };
    return _commodityCycle;
  }

  /**
   * Load + cache the MF_Other universe (Commodity / FoF / Solution / Other
   * Misc — Not Scored). Merged into the asset-class families by
   * `sub_category_class`. Best-effort: a load failure leaves the scored
   * universes intact (Other funds simply don't appear).
   */
  async function ensureOther() {
    if (_otherCycle) return _otherCycle;
    try {
      _otherCycle = await DataLoader.loadOther();
    } catch (e) {
      console.warn('[screener] Other funds unavailable — scored universe only', e);
      _otherCycle = { cycle_meta: {}, funds: [] };
      return _otherCycle;
    }
    // The Debt grid reads f.returns.y{1,3,5}_pct + si_pct; Other funds carry
    // trailing_returns.return_{1y,3y,5y,si}_pct. Mirror them so a merged
    // Other-Debt fund still shows its trailing returns in the debt columns.
    (_otherCycle.funds || []).forEach(f => {
      if (!f.returns) {
        const tr = f.trailing_returns || {};
        f.returns = {
          y1_pct: tr.return_1y_pct != null ? tr.return_1y_pct : null,
          y3_pct: tr.return_3y_pct != null ? tr.return_3y_pct : null,
          y5_pct: tr.return_5y_pct != null ? tr.return_5y_pct : null,
          si_pct: tr.return_si_pct != null ? tr.return_si_pct : null,
        };
      }
    });
    return _otherCycle;
  }

  function otherByClass(cls) {
    return ((_otherCycle && _otherCycle.funds) || []).filter(f => f.sub_category_class === cls);
  }

  /**
   * The active universe for a family = its scored cycle funds + any merged
   * Not-Scored Other funds of that asset class. Commodity is wholly Other.
   */
  function familyFunds(family) {
    if (family === 'debt') return (_debtCycle.funds || []).concat(otherByClass('Debt'));
    if (family === 'commodity') return (_commodityCycle.funds || []).slice();
    return (_eqhCycle.funds || []).concat(otherByClass('Equity'), otherByClass('Hybrid'));
  }

  /**
   * Activate a family — swap _cycle, _allFunds, re-init slider domains and
   * dynamic filter sections. Called once on bootstrap, then on every
   * Asset-Class tile switch between families.
   */
  function setActiveFamily(family, isInitial) {
    _family = family;
    _cycle = (family === 'debt') ? _debtCycle
           : (family === 'commodity') ? _commodityCycle
           : _eqhCycle;
    _allFunds = familyFunds(family);
    _scoringWeights = (family === 'eqh')
      ? (_cycle.cycle_meta.scoring_weights || []).slice()
      : [];
    _customWeights = (family === 'eqh') ? AppState.getCustomWeights() : null;
    // Rehydrate Eq/Hybrid extras from localStorage on initial load only;
    // a tile-driven family switch resets extras so the new family's
    // picker starts clean.
    if (family === 'eqh' && isInitial) {
      _activeExtras = AppState.getScreenerExtraColumns() || [];
    } else {
      _activeExtras = [];
    }

    _sortKey = (family === 'eqh') ? 'score' : 'aum';
    _sortDir = 'desc';
    _selected.clear();
    _activeSectors = [];

    renderTitleAndSub();
    renderDynamicFilterSections();
    initFilterDomains();
    initRangeSliders();
    rebuildAddColumnsPicker();
    applyDebtModeChrome();

    if (!isInitial) {
      // tile tap → re-derive category dropdown + AMC list against the
      // new universe, redraw the table
      rebuildCategoryItems();
      rebuildAmcItems();
      applyAndRender();
      writeUrlState();
    }
  }

  function renderTitleAndSub() {
    const m = _cycle.cycle_meta;
    const titleEl = document.getElementById('screenerTitle');
    const subEl   = document.getElementById('screenerSub');
    const totalEl = document.getElementById('totalCount');
    const footEl  = document.getElementById('footUpdated');

    // Counts reflect the merged universe actually shown (scored cycle funds +
    // any Not-Scored Other funds of this asset class).
    const shownN = _allFunds.length;
    const shownCats = new Set(_allFunds.map(f => f.category).filter(Boolean)).size;
    const otherN = _allFunds.filter(f => f.centricity_score_status === 'Not Scored').length;
    const notScoredNote = otherN > 0
      ? ` Incl. ${otherN.toLocaleString('en-IN')} not-scored (commodity / FoF / solution).`
      : '';

    if (_family === 'debt') {
      titleEl.innerHTML =
        `Interactive <em>Screener</em> · Debt · 15th May 2026`;
      subEl.textContent =
        `${shownN.toLocaleString('en-IN')} debt funds across ${shownCats} categories. ` +
        `Screening tool only — no Centricity Score; sort by any column. ` +
        `NAV as on 15 May 2026 · Holdings as on 30 Apr 2026.` + notScoredNote;
      totalEl.textContent = shownN.toLocaleString('en-IN');
      footEl.textContent = 'Last updated · 15 May 2026';
    } else if (_family === 'commodity') {
      titleEl.innerHTML =
        `Interactive <em>Screener</em> · Commodity · 15th May 2026`;
      subEl.textContent =
        `${shownN.toLocaleString('en-IN')} commodity funds (gold / silver / multi-metal) across ${shownCats} groups. ` +
        `Screening tool only — Not Scored; sort by any column. NAV as on 15 May 2026.`;
      totalEl.textContent = shownN.toLocaleString('en-IN');
      footEl.textContent = 'Last updated · 15 May 2026';
    } else {
      const cycleLabel = DataLoader.fmtCycleLabelDate(m);
      titleEl.innerHTML =
        `Interactive <em>Screener</em> · ${escapeHtml(cycleLabel)}`;
      subEl.textContent =
        `${shownN.toLocaleString('en-IN')} funds across ${shownCats} categories. ` +
        `Filter, sort, edit weights — your changes update the Score column live.` + notScoredNote;
      totalEl.textContent = shownN.toLocaleString('en-IN');
      footEl.textContent = 'Last updated · ' + m.as_on_display;
    }
  }

  /**
   * Inject the family-specific filter sections (Returns/Risk/Others for
   * Eq+Hybrid; Debt Profile/Credit Quality/Cost for Debt) into the rail's
   * #dynamicFilterSections mount.
   */
  function renderDynamicFilterSections() {
    const mount = document.getElementById('dynamicFilterSections');
    if (!mount) return;
    const html = sections().map(s => `
      <div class="filter-group filter-section">
        <div class="section-head">
          <h3 class="section-title">${escapeHtml(s.title)}</h3>
          <button type="button" class="reset-mini" data-section="${escapeHtml(s.key)}">Reset</button>
        </div>
        ${s.slider_keys.map(k => {
          const cfg = rangeConfig().find(r => r.key === k);
          if (!cfg) return '';
          return `<div class="rng" id="${cfg.id}" data-rng="${cfg.key}"></div>`;
        }).join('')}
      </div>`).join('');
    mount.innerHTML = html;

    // Wire each section's mini-reset
    mount.querySelectorAll('.reset-mini').forEach(btn => {
      btn.addEventListener('click', () => {
        const sectionKey = btn.getAttribute('data-section');
        const sec = sections().find(s => s.key === sectionKey);
        if (!sec) return;
        sec.slider_keys.forEach(key => {
          const cfg = rangeConfig().find(c => c.key === key);
          if (!cfg) return;
          const d = _filterDomains[key];
          if (!d) return;
          _filterRanges[key] = { min: d.min, max: d.max };
          syncRangeUI(cfg);
        });
        applyAndRender();
        writeUrlState();
      });
    });
  }

  /**
   * Hide Equity/Hybrid-specific chrome (Edit Weights button, score legend,
   * Sectors picker) in debt mode. Restore in eqh.
   */
  function applyDebtModeChrome() {
    // Edit Weights / score legend / sectors are Equity-Hybrid-only. Both Debt
    // and Commodity are screening-only (no Centricity Score), so hide that
    // chrome and use the no-Rank-column sticky layout for both.
    const isEqh = _family === 'eqh';

    const weightsBtn = document.getElementById('weightsBtn');
    if (weightsBtn) weightsBtn.style.display = isEqh ? '' : 'none';

    const legend = document.getElementById('screenerLegend');
    if (legend) legend.style.display = isEqh ? '' : 'none';

    // Sectors picker is Analytics-driven (Equity/Hybrid); hide otherwise
    const sectorsWrap = document.getElementById('sectorsWrap');
    if (sectorsWrap) sectorsWrap.style.display = isEqh ? '' : 'none';

    // Table-wrap gets the no-rank-column ("debt-mode") sticky offsets for any
    // non-eqh family (debt + commodity tables omit the Rank column).
    const tableWrap = document.getElementById('tableWrap');
    if (tableWrap) tableWrap.classList.toggle('debt-mode', !isEqh);
  }

  async function _loadMgrHistoryOverlay() {
    try {
      const res = await fetch('data/manager-history-2026-04-30.json', { cache: 'default' });
      if (!res.ok) return;
      _mgrHistoryCache = await res.json();
      const idx = Object.create(null);
      const screenerByCode = new Map();
      if (_allFunds && _allFunds.length) {
        for (const f of _allFunds) screenerByCode.set(String(f.scheme_code), f);
      }
      for (const code in _mgrHistoryCache.funds) {
        const entry = _mgrHistoryCache.funds[code];
        if (!entry || !entry.managers) continue;
        const current = entry.managers.filter(m => m.is_current);
        if (current.length === 0) continue;
        let main;
        if (current.length === 1) {
          main = current[0];
        } else {
          const screenerFund = screenerByCode.get(String(code));
          const screenerName = (screenerFund && screenerFund.manager_name || '')
            .toLowerCase().trim();
          let matched = null;
          if (screenerName) {
            matched = current.find(m => {
              const nl = m.name.toLowerCase();
              if (nl.includes(screenerName)) return true;
              const surname = screenerName.split(/\s+/).pop();
              return surname && surname.length > 2 && nl.includes(surname);
            });
          }
          main = matched || current.reduce((a, b) =>
            (Number(a.tenure_years) || 0) > (Number(b.tenure_years) || 0) ? a : b);
        }
        idx[String(code)] = { name: main.name, tenure_years: main.tenure_years };
      }
      _mgrByScheme = idx;
      // Re-render so any visible manager-name / manager-tenure cells +
      // the slider-domain bounds pick up the overlay values.
      if (_family === 'eqh') {
        initFilterDomains();
        applyAndRender();
      }
    } catch (e) {
      console.warn('[screener] manager-history overlay unavailable', e);
    }
  }

  function renderLoadError(err) {
    const main = document.getElementById('mainArea');
    main.innerHTML = `
      <div class="empty-state" style="margin:48px 56px;">
        <div class="ring-motif"></div>
        <h3>Could not load cycle data</h3>
        <p>Serve via <code>python -m http.server</code> rather than opening the file directly.<br>
           <span style="color:var(--red)">${(err && err.message) || err}</span></p>
      </div>`;
  }

  /* ============================================================
   * FILTER DOMAINS — derive min/max per slider from current cycle
   * ============================================================ */
  function initFilterDomains() {
    // Drop existing entries that don't belong to the current family
    const validKeys = new Set(rangeConfig().map(c => c.key));
    Object.keys(_filterDomains).forEach(k => { if (!validKeys.has(k)) delete _filterDomains[k]; });
    Object.keys(_filterRanges ).forEach(k => { if (!validKeys.has(k)) delete _filterRanges[k]; });

    rangeConfig().forEach(cfg => {
      if (cfg.hardCapMin != null && cfg.hardCapMax != null) {
        _filterDomains[cfg.key] = { min: cfg.hardCapMin, max: cfg.hardCapMax, step: cfg.step };
        _filterRanges[cfg.key]  = { min: cfg.hardCapMin, max: cfg.hardCapMax };
        return;
      }
      if (cfg.kind === 'score-pct') {
        _filterDomains[cfg.key] = { min: 0, max: 100, step: cfg.step };
        _filterRanges[cfg.key]  = { min: 0, max: 100 };
        return;
      }

      const vals = _allFunds.map(cfg.accessor).filter(v => v != null && !isNaN(v));
      if (vals.length === 0) {
        _filterDomains[cfg.key] = { min: 0, max: 100, step: cfg.step || 1 };
        _filterRanges[cfg.key]  = { min: 0, max: 100 };
        return;
      }
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const step = cfg.step;
      const niceLo = Math.floor(niceMin(lo, cfg) / step) * step;
      const niceHi = Math.ceil(niceMax(hi, cfg)  / step) * step;
      _filterDomains[cfg.key] = { min: niceLo, max: niceHi, step };
      _filterRanges[cfg.key]  = { min: niceLo, max: niceHi };
    });
  }

  function niceMin(v, cfg) {
    if (cfg.kind === 'int') return Math.max(0, Math.floor(v));
    if (cfg.kind === 'pct-pos') {
      // v2 — some "pct-pos" metrics (Up/Down Capture) can swing negative
      // for international/hybrid funds (e.g. ICICI Pru US Bluechip Down
      // Capture = -4.68%). When the observed minimum is below zero, drop
      // the floor to round down (in 5pt buckets) so those funds aren't
      // silently filtered out by the slider's default lower bound.
      if (v < 0) return Math.floor(v / 5) * 5;
      return 0;
    }
    if (cfg.kind === 'num') return Math.floor(v * 10) / 10;
    if (cfg.kind === 'pct') return Math.floor(v / 5) * 5;
    return v;
  }
  function niceMax(v, cfg) {
    if (cfg.kind === 'int') return Math.ceil(v);
    if (cfg.kind === 'pct-pos') return Math.ceil(v / 5) * 5;
    if (cfg.kind === 'num') return Math.ceil(v * 10) / 10;
    if (cfg.kind === 'pct') return Math.ceil(v / 5) * 5;
    return v;
  }

  /* ============================================================
   * FILTERS — Asset Class tiles + Category dropdown + AMC dropdown
   * ============================================================ */
  // The tile(s) that represent a family in its default state.
  function defaultTilesFor(family) {
    if (family === 'debt') return ['debt'];
    if (family === 'commodity') return ['commodity'];
    return ['equity', 'hybrid'];
  }
  // Which family a single tile value belongs to.
  function tileFamily(v) {
    return v === 'debt' ? 'debt' : v === 'commodity' ? 'commodity' : 'eqh';
  }

  function initFilters() {
    const acItems = buildAssetClassItems();
    const acInitial = defaultTilesFor(_family);

    // Asset-class tiles: standard multi-select for equity/hybrid combos,
    // but `debt` and `commodity` are exclusive (family-mode switches).
    _acTiles = MultiSelect.createTiles(document.getElementById('acTiles'), {
      items: acItems,
      selected: acInitial,
      label: 'Asset class',
      keepAtLeastOne: true,
      onChange: handleAssetClassChange,
    });

    _catMS = MultiSelect.create(document.getElementById('catMS'), {
      items: buildCategoryItems(),
      selected: buildCategoryItems().map(i => i.value),
      label: 'Category', allLabel: 'All categories',
      noneLabel: 'None selected',
      oneLabel: (i) => `${i.label} only`,
      manyLabel: (n) => `${n} selected`,
      searchPlaceholder: 'Search category…',
      groups: true,
      onChange: () => { applyAndRender(); writeUrlState(); },
    });

    _amcMS = MultiSelect.create(document.getElementById('amcMS'), {
      items: buildAmcItems(),
      selected: buildAmcItems().map(i => i.value),
      label: 'AMC', allLabel: 'All AMCs',
      noneLabel: 'None selected',
      oneLabel: (i) => `${i.label} only`,
      manyLabel: (n) => `${n} selected`,
      searchPlaceholder: 'Search AMC…',
      onChange: () => { applyAndRender(); writeUrlState(); },
    });

    document.getElementById('resetBtn').addEventListener('click', () => {
      _acTiles.setSelected(defaultTilesFor(_family));
      rebuildCategoryItems();
      _catMS.setSelected(buildCategoryItems().map(i => i.value));
      _amcMS.setSelected(buildAmcItems().map(i => i.value));
      rangeConfig().forEach(cfg => {
        const d = _filterDomains[cfg.key];
        if (!d) return;
        _filterRanges[cfg.key] = { min: d.min, max: d.max };
        syncRangeUI(cfg);
      });
      _sortKey = _family === 'eqh' ? 'score' : 'aum';
      _sortDir = 'desc';
      document.getElementById('searchInput').value = '';
      applyAndRender();
      writeUrlState();
    });
  }

  /**
   * AC tile handler — enforces cross-family mutual exclusion across the three
   * families: eqh (equity and/or hybrid, multi-select), debt (exclusive) and
   * commodity (exclusive). The MultiSelect tile component lets the user toggle
   * freely; we project the raw selection onto a single family and reset to a
   * valid shape if they mixed families.
   *
   * Rules:
   *   • Mixed families → the family the user JUST added wins (i.e. the one
   *     that isn't the current family). debt/commodity collapse to that one
   *     tile; eqh keeps whatever equity/hybrid tiles were chosen.
   *   • Empty selection is impossible (keepAtLeastOne).
   */
  function handleAssetClassChange(selected) {
    const fams = new Set(selected.map(tileFamily));

    if (fams.size > 1) {
      // User mixed families — honour the one they just added (≠ current).
      const added = selected.map(tileFamily).find(fam => fam !== _family) || _family;
      if (added === 'eqh') {
        _acTiles.setSelected(selected.filter(v => tileFamily(v) === 'eqh'));
      } else {
        _acTiles.setSelected([added]);   // 'debt' or 'commodity' — exclusive
      }
      return;   // setSelected re-fires onChange with a clean single-family shape
    }

    const target = [...fams][0] || 'eqh';
    if (target !== _family) {
      switchFamily(target);
      return;
    }
    // Same-family toggle (e.g. eqh user enabling/disabling hybrid)
    rebuildCategoryItems();
    applyAndRender();
    writeUrlState();
  }

  async function switchFamily(family) {
    try {
      if (family === 'debt')           await ensureDebtCycle();
      else if (family === 'commodity') await ensureCommodityCycle();
      else                             await ensureEqhCycle();
    } catch (err) {
      showToast('Could not load ' + family + ' funds.');
      _acTiles.setSelected(defaultTilesFor(_family));   // revert
      console.warn('[screener] family switch failed', err);
      return;
    }
    setActiveFamily(family, /* initial */ false);
  }

  function buildAssetClassItems() {
    // Tile counts fold the Not-Scored Other funds into each asset class so the
    // tile total matches what the table actually shows. eqh counts come from
    // the loaded cycle; debt shows "click to load" until the family lands;
    // commodity is wholly Other (available as soon as the Other JSON loads).
    const eqhCount = _eqhCycle
      ? _eqhCycle.funds.filter(f => f.sub_category_class === 'Equity').length + otherByClass('Equity').length
      : null;
    const hybCount = _eqhCycle
      ? _eqhCycle.funds.filter(f => f.sub_category_class === 'Hybrid').length + otherByClass('Hybrid').length
      : null;
    const debtCount = _debtCycle
      ? _debtCycle.funds.length + otherByClass('Debt').length
      : null;
    const commodityCount = _otherCycle ? otherByClass('Commodity').length : null;
    const fmt = n => n != null ? n.toLocaleString('en-IN') + ' funds' : '';
    return [
      { value: 'equity',    label: 'Equity',    sub: fmt(eqhCount) },
      { value: 'debt',      label: 'Debt',      sub: debtCount != null ? fmt(debtCount) : 'click to load' },
      { value: 'hybrid',    label: 'Hybrid',    sub: fmt(hybCount) },
      { value: 'commodity', label: 'Commodity', sub: commodityCount != null ? fmt(commodityCount) : 'click to load' },
    ];
  }

  function buildCategoryItems() {
    if (_family === 'commodity') {
      const seen = new Set(); const items = [];
      _allFunds.forEach(f => {
        if (f.category && !seen.has(f.category)) {
          seen.add(f.category);
          items.push({ value: f.category, label: f.category, group: 'Commodity' });
        }
      });
      return items;
    }
    if (_family === 'debt') {
      // Ladder order: Overnight → Liquid → … → Index Funds → ETFs (passive last)
      const LADDER = [
        'Overnight Fund', 'Liquid', 'Ultra Short Duration', 'Money Market',
        'Low Duration', 'Short Duration', 'Corporate Bond', 'Banking and PSU',
        'Floating Rate', 'Medium Duration', 'Medium to Long', 'Credit Risk',
        'Dynamic Bond', 'Long Duration', 'Gilt', 'Index Funds', 'ETFs',
      ];
      const available = new Set(_allFunds.map(f => f.category).filter(Boolean));
      const items = LADDER.filter(c => available.has(c)).map(c => ({
        value: c, label: c, group: 'Debt',
      }));
      // Other-fund debt sub-categories (Debt FoF, FoF, …) aren't on the ladder.
      const seen = new Set(items.map(i => i.value));
      Array.from(available).sort().forEach(c => {
        if (!seen.has(c)) { seen.add(c); items.push({ value: c, label: c, group: 'Debt' }); }
      });
      return items;
    }
    const acSel = _acTiles ? _acTiles.getSelected() : ['equity', 'hybrid'];
    const cats = (_cycle.cycle_meta.categories || []);
    const want = [];
    if (acSel.includes('equity')) want.push('Equity');
    if (acSel.includes('hybrid')) want.push('Hybrid');
    const items = [];
    const seen = new Set();
    cats.forEach(c => {
      if (want.includes(c.sub_class) && !seen.has(c.name)) {
        seen.add(c.name);
        items.push({ value: c.name, label: c.name, group: c.sub_class });
      }
    });
    // Append NEW sub-categories carried only by merged Other funds (Global,
    // Equity FoF, Hybrid FoF, Solution - Retirement, …) so they're filterable
    // and default-selected — otherwise the "all categories" default would
    // silently exclude every merged Other fund.
    _allFunds.forEach(f => {
      if (want.includes(f.sub_category_class) && f.category && !seen.has(f.category)) {
        seen.add(f.category);
        items.push({ value: f.category, label: f.category, group: f.sub_category_class });
      }
    });
    return items;
  }
  function rebuildCategoryItems() {
    if (!_catMS) return;
    _catMS.refresh(buildCategoryItems(), { defaultCheckNew: true });
  }
  function rebuildAmcItems() {
    if (!_amcMS) return;
    _amcMS.refresh(buildAmcItems(), { defaultCheckNew: true });
    _amcMS.setSelected(buildAmcItems().map(i => i.value));
  }
  function buildAmcItems() {
    const seen = new Set();
    _allFunds.forEach(f => seen.add(f.amc || '—'));
    return Array.from(seen).filter(Boolean).sort().map(a => ({ value: a, label: a }));
  }

  /* ============================================================
   * RANGE SLIDERS — two-handle, dynamic domains, live filter
   * ============================================================ */
  function initRangeSliders() {
    rangeConfig().forEach(cfg => {
      const root = document.getElementById(cfg.id);
      if (!root) return;
      const d = _filterDomains[cfg.key];
      if (!d) return;
      root.innerHTML = `
        <div class="rng-head">
          <span class="rng-label">${escapeHtml(cfg.label)}</span>
          <span class="rng-value" data-rng-display></span>
        </div>
        <div class="rng-track-wrap">
          <div class="rng-track"></div>
          <div class="rng-fill" data-rng-fill></div>
          <input type="range" class="rng-input rng-min-input" min="${d.min}" max="${d.max}" step="${d.step}" value="${d.min}">
          <input type="range" class="rng-input rng-max-input" min="${d.min}" max="${d.max}" step="${d.step}" value="${d.max}">
        </div>`;

      const minIn = root.querySelector('.rng-min-input');
      const maxIn = root.querySelector('.rng-max-input');

      function commit() {
        let lo = parseFloat(minIn.value);
        let hi = parseFloat(maxIn.value);
        if (lo > hi) [lo, hi] = [hi, lo];
        _filterRanges[cfg.key] = { min: lo, max: hi };
        syncRangeUI(cfg);
        applyAndRender();
        writeUrlState();
      }
      minIn.addEventListener('input', () => {
        if (parseFloat(minIn.value) > parseFloat(maxIn.value)) minIn.value = maxIn.value;
        commit();
      });
      maxIn.addEventListener('input', () => {
        if (parseFloat(maxIn.value) < parseFloat(minIn.value)) maxIn.value = minIn.value;
        commit();
      });

      syncRangeUI(cfg);
    });
  }

  function syncRangeUI(cfg) {
    const root = document.getElementById(cfg.id);
    if (!root) return;
    const d = _filterDomains[cfg.key];
    const r = _filterRanges[cfg.key];
    if (!d || !r) return;
    const minIn = root.querySelector('.rng-min-input');
    const maxIn = root.querySelector('.rng-max-input');
    if (minIn && parseFloat(minIn.value) !== r.min) minIn.value = String(r.min);
    if (maxIn && parseFloat(maxIn.value) !== r.max) maxIn.value = String(r.max);

    const fill = root.querySelector('[data-rng-fill]');
    if (fill && d.max > d.min) {
      const lpct = ((r.min - d.min) / (d.max - d.min)) * 100;
      const rpct = ((r.max - d.min) / (d.max - d.min)) * 100;
      fill.style.left  = `${lpct}%`;
      fill.style.width = `${Math.max(0, rpct - lpct)}%`;
    }
    const display = root.querySelector('[data-rng-display]');
    if (display) display.innerHTML = formatRangeDisplay(cfg, r, d);
  }

  function formatRangeDisplay(cfg, r, d) {
    const isMaxAtCap = (cfg.kind === 'inr') && (r.max >= d.max);
    const lo = formatRangeValue(cfg, r.min);
    const hi = isMaxAtCap ? '<span class="rng-max">₹1L+ Cr</span>' : formatRangeValue(cfg, r.max);
    return `<span class="rng-min">${lo}</span> – ${hi}`;
  }
  function formatRangeValue(cfg, v) {
    if (v == null || isNaN(v)) return '—';
    const isNeg = v < 0;
    const cls = isNeg ? 'rng-max rng-neg' : 'rng-max';
    let body;
    switch (cfg.kind) {
      case 'inr':       body = '₹' + DataLoader.fmtINR(v) + ' Cr'; break;
      case 'pct':       body = (isNeg ? '−' : (v > 0 ? '+' : '')) + Math.abs(v).toFixed(1) + '%'; break;
      case 'pct-pos':   body = v.toFixed(1) + '%'; break;
      case 'score-pct': body = v.toFixed(0) + '%'; break;
      case 'num':       body = (isNeg ? '−' : '') + Math.abs(v).toFixed(2) + (cfg.suffix || ''); break;
      case 'int':       body = String(Math.round(v)); break;
      default:          body = String(v);
    }
    return `<span class="${cls}">${escapeHtml(body)}</span>`;
  }

  function isRangeFullDomain(key) {
    const r = _filterRanges[key], d = _filterDomains[key];
    if (!r || !d) return true;
    return r.min === d.min && r.max === d.max;
  }
  function rangePass(f, cfg) {
    const v = cfg.accessor(f);
    const r = _filterRanges[cfg.key];
    const d = _filterDomains[cfg.key];
    if (!r || !d) return true;
    if (v == null) return isRangeFullDomain(cfg.key);
    if (cfg.kind === 'inr' && r.max >= d.max) return v >= r.min;
    if (cfg.kind === 'score-pct') return (v * 100) >= r.min && (v * 100) <= r.max;
    return v >= r.min && v <= r.max;
  }

  /* ============================================================
   * EDIT WEIGHTS DRAWER (modal overlay) — Equity/Hybrid only
   * ============================================================ */
  function initWeightDrawer() {
    document.getElementById('weightsBtn').addEventListener('click', () => {
      if (_family === 'debt') return;
      openDrawer();
    });
    document.getElementById('cancelWeightsBtn').addEventListener('click', closeDrawer);
    document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
    document.getElementById('resetWeightsBtn').addEventListener('click', () => {
      _draftWeights = defaultWeightsObject();
      renderDrawerInputs();
    });
    document.getElementById('okWeightsBtn').addEventListener('click', () => {
      const sum = sumDraft();
      if (Math.abs(sum - 100) > 0.01) return;
      const isDefault = _scoringWeights.every(w =>
        Math.abs(_draftWeights[w.parameter] - w.weight_pct) < 0.0001);
      _customWeights = isDefault ? null : Object.assign({}, _draftWeights);
      if (_customWeights == null) AppState.resetWeights();
      else                        AppState.setCustomWeights(_customWeights);
      closeDrawer();
      _sortKey = 'score'; _sortDir = 'desc';
      applyAndRender();
      writeUrlState();
      showToast(isDefault ? 'Weights reset to Excel-shipped values.' : 'Weights applied.');
    });

    document.addEventListener('keydown', (e) => {
      if (_drawerOpen && e.key === 'Escape') closeDrawer();
    });
  }

  function openDrawer() {
    _drawerOpen = true;
    _draftWeights = currentWeightsAsObject();
    document.getElementById('drawerBackdrop').hidden = false;
    document.getElementById('weightDrawer').hidden = false;
    renderDrawerInputs();
  }
  function closeDrawer() {
    _drawerOpen = false;
    _draftWeights = null;
    document.getElementById('drawerBackdrop').hidden = true;
    document.getElementById('weightDrawer').hidden = true;
  }

  function defaultWeightsObject() {
    const out = {};
    _scoringWeights.forEach(w => { out[w.parameter] = w.weight_pct; });
    return out;
  }
  function currentWeightsAsObject() {
    const out = defaultWeightsObject();
    if (_customWeights) {
      Object.keys(_customWeights).forEach(k => {
        if (k in out) out[k] = _customWeights[k];
      });
    }
    return out;
  }
  function sumDraft() {
    if (!_draftWeights) return 0;
    return _scoringWeights.reduce((s, w) => s + (Number(_draftWeights[w.parameter]) || 0), 0);
  }

  function renderDrawerInputs() {
    const wrap = document.getElementById('weightInputs');
    wrap.innerHTML = _scoringWeights.map(w => {
      const v = (_draftWeights && _draftWeights[w.parameter] != null) ? _draftWeights[w.parameter] : w.weight_pct;
      // v2 introduces a third direction, 'Tent' — closer to category centre = best
      // (Avg Market Cap, Fund PE). Render with a ⊙ marker (centre-target glyph)
      // and a tooltip explaining the scoring intent.
      const dirArrow = w.direction === 'Higher' ? '↑'
                     : w.direction === 'Tent'   ? '⊙'
                     : '↓';
      const dirTitle = w.direction === 'Tent'
        ? ' title="Tent — closer to category centre = best"'
        : '';
      return `
        <div class="weight-row" data-param="${escapeHtml(w.parameter)}">
          <span class="name">${escapeHtml(w.parameter)} <span class="dir"${dirTitle}>${dirArrow}</span></span>
          <span style="display:inline-flex;align-items:center;">
            <input type="number" min="0" max="100" step="0.01" value="${Number(v).toFixed(2)}">
            <span class="pct-suffix">%</span>
          </span>
        </div>`;
    }).join('');
    wrap.querySelectorAll('.weight-row').forEach(row => {
      const param = row.getAttribute('data-param');
      const input = row.querySelector('input[type="number"]');
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        _draftWeights[param] = isNaN(v) ? 0 : v;
        updateDrawerSum();
      });
      input.addEventListener('blur', () => {
        const v = parseFloat(input.value);
        if (isNaN(v)) { input.value = '0.00'; _draftWeights[param] = 0; }
        else          { input.value = v.toFixed(2); _draftWeights[param] = v; }
        updateDrawerSum();
      });
    });
    updateDrawerSum();
  }

  function updateDrawerSum() {
    const sum = sumDraft();
    const ok = Math.abs(sum - 100) <= 0.01;
    const el = document.getElementById('weightSum');
    el.textContent = `Total ${sum.toFixed(2)}% ${ok ? '✓' : ''}`.trim();
    el.classList.toggle('warn', !ok);
    el.classList.toggle('ok', ok);
    document.getElementById('okWeightsBtn').disabled = !ok;
  }

  function getActiveWeights() {
    return _scoringWeights.map(w => {
      const ov = _customWeights ? _customWeights[w.parameter] : null;
      return Object.assign({}, w, ov != null ? { weight_pct: ov } : {});
    });
  }

  /* ============================================================
   * APPLY + RENDER
   * ============================================================ */
  function applyAndRender() {
    const catSel = _catMS ? _catMS.getSelected() : [];
    const amcSel = _amcMS ? _amcMS.getSelected() : [];
    const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();

    let funds = _allFunds.slice();

    if (_family === 'eqh') {
      const acSel = _acTiles ? _acTiles.getSelected() : ['equity', 'hybrid'];
      const subClassMap = { equity: 'Equity', hybrid: 'Hybrid' };
      const subClasses = acSel.map(a => subClassMap[a]).filter(Boolean);
      funds = funds.filter(f => subClasses.includes(f.sub_category_class));
    }

    if (catSel.length > 0) funds = funds.filter(f => catSel.includes(f.category));
    if (amcSel.length > 0) funds = funds.filter(f => amcSel.includes(f.amc));
    if (search) {
      funds = funds.filter(f =>
        (f.fund_name || '').toLowerCase().includes(search) ||
        (f.amc || '').toLowerCase().includes(search) ||
        String(f.scheme_code || '').includes(search)
      );
    }

    if (_family === 'eqh') {
      const activeWeights = getActiveWeights();
      funds = funds.map(f => {
        const cloned = Object.assign({}, f);
        cloned._displayScore = (f.centricity_score_status === 'Ranked')
          ? DataLoader.recomputeScore(f, activeWeights)
          : null;
        cloned._displayRank = null;   // F5 — assigned after ALL filters (below)
        return cloned;
      });
    }

    // Apply range filters
    rangeConfig().forEach(cfg => {
      if (cfg.key === 'centricity_score') {
        funds = funds.filter(f => {
          const r = _filterRanges[cfg.key], d = _filterDomains[cfg.key];
          if (!r || !d) return true;
          if (isRangeFullDomain(cfg.key)) return true;
          if (f._displayScore == null) return false;
          const v = f._displayScore * 100;
          return v >= r.min && v <= r.max;
        });
      } else {
        funds = funds.filter(f => rangePass(f, cfg));
      }
    });

    // F5 — Rank by Centricity score ACROSS THE CURRENT SELECTION (not per
    // category). Over the final post-filter set, every Ranked fund with a live
    // score gets a single 1..N rank by _displayScore desc; Non-Ranked (Warning /
    // New / Index — Not Scored) stay null → "—". This re-runs on every weight or
    // filter change (it's inside applyAndRender), so a weight edit re-ranks.
    if (_family === 'eqh') {
      funds
        .filter(f => f.centricity_score_status === 'Ranked' && f._displayScore != null)
        .sort((a, b) => (b._displayScore || 0) - (a._displayScore || 0))
        .forEach((f, idx) => { f._displayRank = idx + 1; });
    }

    funds.sort(rowComparator(_sortKey, _sortDir));

    _filteredFunds = funds;
    document.getElementById('resultCount').textContent = funds.length.toLocaleString('en-IN');
    renderTable(funds);
    syncCompareButton();
  }

  function rowComparator(key, dir) {
    const m = dir === 'asc' ? 1 : -1;
    const col = activeColumns().find(c => c.key === key);
    const accessor = col && col.sortValue ? col.sortValue : () => null;
    return (a, b) => {
      const av = accessor(a), bv = accessor(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;        // null always last
      if (bv == null) return -1;
      if (av < bv) return -1 * m;
      if (av > bv) return 1 * m;
      return 0;
    };
  }

  /* ============================================================
   * TABLE RENDER (default cols + 0..N extras; sticky left columns)
   * ============================================================ */
  function activeColumns() {
    const extras = _activeExtras.map(path => makeExtraColumn(path)).filter(Boolean);
    const sectorCols = (_family === 'debt') ? [] : _activeSectors.map(s => makeSectorColumn(s));
    return defaultCols().concat(extras).concat(sectorCols);
  }
  function makeSectorColumn(sectorName) {
    return {
      key: 's_' + sectorName.replace(/\W+/g, '_'),
      label: sectorName + ' %',
      align: 'center',
      neg: false,
      sortable: true,
      sortValue: f => {
        const m = _sectorLookup && _sectorLookup[String(f.scheme_code)];
        return (m && m[sectorName] != null) ? m[sectorName] : null;
      },
      pickRaw: f => {
        const m = _sectorLookup && _sectorLookup[String(f.scheme_code)];
        return (m && m[sectorName] != null) ? m[sectorName] : null;
      },
      text: f => {
        const m = _sectorLookup && _sectorLookup[String(f.scheme_code)];
        const v = (m && m[sectorName] != null) ? m[sectorName] : null;
        return (v == null) ? '–' : `${DataLoader.fmtNum(v)}%`;
      },
    };
  }
  function makeExtraColumn(path) {
    const lib = extraColsLib().find(x => x.value === path);
    if (!lib) return null;
    return {
      key: 'x_' + path.replace(/\W+/g, '_'),
      label: lib.label,
      align: 'center',
      neg: lib.kind === 'pct-signed' || !!lib.neg,
      sortable: true,
      sortValue: f => extraSortValue(pluck(f, path), lib),
      pickRaw:   f => pluck(f, path),
      text:      f => formatExtraCell(pluck(f, path), lib),
    };
  }
  function extraSortValue(v, lib) {
    if (v == null) return null;
    if (lib.kind === 'string' || lib.kind === 'date' || lib.kind === 'date-str') return String(v).toLowerCase();
    return v;
  }
  function formatExtraCell(v, lib) {
    if (v == null) return '—';
    switch (lib.kind) {
      case 'pct':        return `<span class="num">${DataLoader.fmtPct(v)}</span>`;
      case 'pct-pos':    return `${DataLoader.fmtNum(v)}%`;
      case 'pct-signed': {
        // Cash & equiv may be negative for liquid/MM funds (CLAUDE.md note).
        // Render signed; cell-level `neg` class (set in renderTable when
        // col.neg is true) drives the dark red colour.
        const abs = Math.abs(Number(v));
        const txt = (v < 0 ? '−' : '') + abs.toFixed(2) + '%';
        return txt;
      }
      case 'num':        return `${DataLoader.fmtNum(v)}${lib.suffix || ''}`;
      case 'int':        return String(Math.round(v));
      case 'inr':        return `₹ ${DataLoader.fmtINR(v)}`;
      case 'date':       return DataLoader.fmtDate(v);
      case 'date-str':   return escapeHtml(String(v));  // debt JSON ships pre-formatted "DD-Mon-YYYY"
      case 'string':     return escapeHtml(String(v));
      case 'score-int':  return `${v} / 10`;
      default:           return escapeHtml(String(v));
    }
  }

  function renderTable(funds) {
    const wrap = document.getElementById('tableWrap');
    if (funds.length === 0) {
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="ring-motif"></div>
          <h3>No funds match the current filters</h3>
          <p>Try widening a range slider, adding categories or AMCs back in,
             or clearing the search box.</p>
        </div>`;
      return;
    }

    const cols = activeColumns();

    const head = `
      <thead><tr>
        ${cols.map(c => {
          const sortedCls = (_sortKey === c.key) ? 'sorted' : '';
          const noSort = c.sortable === false ? 'no-sort' : '';
          const cls = [c.cls || '', sortedCls, noSort].filter(Boolean).join(' ');
          if (c.key === '_check') {
            const checkedCount = funds.filter(f => _selected.has(f.scheme_code)).length;
            const visibleSelectable = Math.min(funds.length, MAX_COMPARE);
            const allChecked = checkedCount > 0 && checkedCount >= visibleSelectable;
            return `<th class="${cls}"><input type="checkbox" class="header-check"${allChecked ? ' checked' : ''} aria-label="Select all visible (top 5)"></th>`;
          }
          const arrow = c.sortable === false
            ? ''
            : `<span class="arr">${_sortDir === 'asc' ? '▴' : '▾'}</span>`;
          const title = c.titleHelp ? ` title="${escapeHtml(c.titleHelp)}"` : '';
          return `<th data-key="${c.key}" class="${cls}"${title}>${escapeHtml(c.label)}${arrow}</th>`;
        }).join('')}
      </tr></thead>`;

    const rows = funds.map(f => {
      const tds = cols.map(c => {
        const rawValue = c.pickRaw ? c.pickRaw(f) : null;
        const isNeg = c.neg && typeof rawValue === 'number' && rawValue < 0;
        const cls = [
          c.cls || '',
          c.align === 'left' ? 'left' : '',
          isNeg ? 'neg' : '',
        ].filter(Boolean).join(' ');
        return `<td class="${cls}">${c.text(f)}</td>`;
      }).join('');
      const rowCls = [
        (_family === 'eqh' && f.centricity_score_status !== 'Ranked') ? 'non-ranked' : '',
        _selected.has(f.scheme_code) ? 'selected' : '',
      ].filter(Boolean).join(' ');
      return `<tr data-scheme="${f.scheme_code}" class="${rowCls}">${tds}</tr>`;
    }).join('');

    wrap.innerHTML = `
      <div class="scroll-tbody">
        <table class="screener-tbl">
          ${head}
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    // Header sort
    wrap.querySelectorAll('thead th').forEach(th => {
      const k = th.getAttribute('data-key');
      if (!k) return;
      const col = cols.find(c => c.key === k);
      if (!col || col.sortable === false) return;
      th.addEventListener('click', () => {
        if (_sortKey === k) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
        else { _sortKey = k; _sortDir = 'desc'; }
        applyAndRender();
        writeUrlState();
      });
    });

    // Row checkbox toggles + header tri-state
    wrap.querySelectorAll('tbody .row-check').forEach(cb => {
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        const code = Number(cb.getAttribute('data-scheme'));
        if (cb.checked) {
          if (_selected.size >= MAX_COMPARE) {
            cb.checked = false;
            flashCapWarn();
            return;
          }
          _selected.add(code);
        } else {
          _selected.delete(code);
        }
        markRowSelected(cb, _selected.has(code));
        syncCompareButton();
      });
    });
    const headerCheck = wrap.querySelector('thead .header-check');
    if (headerCheck) {
      headerCheck.addEventListener('click', (e) => {
        e.stopPropagation();
        const top = funds.slice(0, MAX_COMPARE);
        const allOn = top.every(f => _selected.has(f.scheme_code));
        if (allOn) {
          top.forEach(f => _selected.delete(f.scheme_code));
        } else {
          _selected.clear();
          top.forEach(f => _selected.add(f.scheme_code));
        }
        applyAndRender();
      });
    }
  }
  function markRowSelected(cb, selected) {
    const tr = cb.closest('tr');
    if (!tr) return;
    tr.classList.toggle('selected', selected);
  }

  function flashCapWarn() {
    const el = document.getElementById('capWarn');
    if (!el) return;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(_capWarnTimer);
    _capWarnTimer = setTimeout(() => { el.hidden = true; }, 2400);
  }

  function renderScoreCell(f) {
    const status = f.centricity_score_status;
    const v = f._displayScore;
    if (status === 'Ranked' && v != null) {
      const widthPct = Math.max(0, Math.min(1, v)) * 100;
      return `
        <span class="score-cell">
          <span class="score-bar"><i style="width:${widthPct}%"></i></span>
          <b>${DataLoader.fmtScorePct(v)}</b>
        </span>`;
    }
    if (status === '1-3yr Warning') {
      const w = f.centricity_score_warning_pct;
      return `<span class="badge warning-13">Warning${w != null ? ' ' + w.toFixed(2) + '%' : ''}</span>`;
    }
    // Phase 2.1 — passive funds carry no score; render a subtle "Not scored"
    // chip rather than the New-Fund-Monitoring badge or a misleading "0.00".
    // These funds still sort by AUM / returns / TER / mcap-split etc.; only
    // the Score cell is suppressed.
    // Passive index funds AND the merged Other universe (Commodity / FoF /
    // Solution — centricity_score_status === "Not Scored") carry no score.
    if (status === 'Index — Not Scored' || status === 'Not Scored') {
      return `<span class="badge not-scored">Not scored</span>`;
    }
    return `<span class="badge new-fund">New Fund — Monitoring</span>`;
  }
  function fmtPctCell(v) {
    return `<span class="num">${DataLoader.fmtPct(v)}</span>`;
  }
  function fmtPctPos(v) {
    if (v == null || isNaN(v)) return '—';
    return `${DataLoader.fmtNum(v, 2)}%`;
  }
  function fmtYrs(v) {
    if (v == null || isNaN(v)) return '—';
    return `${DataLoader.fmtNum(v, 2)} yrs`;
  }

  /* ============================================================
   * COMPARE BUTTON
   * ============================================================ */
  function initCompareButton() {
    const btn = document.getElementById('compareBtn');
    btn.addEventListener('click', () => {
      if (_selected.size < 2) return;
      const codes = Array.from(_selected).join(',');
      window.location.href = `compare.html?schemes=${codes}`;
    });
  }
  function syncCompareButton() {
    const btn = document.getElementById('compareBtn');
    const count = _selected.size;
    btn.disabled = count < 2;
    document.getElementById('compareCount').textContent = String(count);
  }

  /* ============================================================
   * TOOLBAR / SEARCH
   * ============================================================ */
  function initToolbar() {
    document.getElementById('searchInput').addEventListener('input', () => {
      applyAndRender();
      writeUrlState();
    });
  }

  /* ============================================================
   * "ADD COLUMNS" MULTI-SELECT (Eq/Hybrid) + Sectors picker
   * ============================================================ */
  function initSectorFilter() {
    if (_family !== 'eqh') return;
    fetch('data/analytics-2026-03-31.json').then(r => r.ok ? r.json() : null).then(d => {
      if (!d || !d.funds) return;
      _sectorLookup = {};
      const sectorSet = new Set();
      Object.keys(d.funds).forEach(sc => {
        const fund = d.funds[sc];
        const m = {};
        (fund.sector_allocation || []).forEach(s => {
          if (s && s.sector && s.holding_pct != null) {
            m[s.sector] = s.holding_pct;
            sectorSet.add(s.sector);
          }
        });
        _sectorLookup[sc] = m;
      });
      _allSectors = Array.from(sectorSet).sort();
      buildSectorMS();
    }).catch(() => {});
  }

  function buildSectorMS() {
    const items = _allSectors.map(s => ({ value: s, label: s, group: 'Sectors' }));
    _sectorMS = MultiSelect.create(document.getElementById('sectorMS'), {
      items,
      selected: _activeSectors.slice(),
      label: 'Sectors',
      allLabel: 'All sectors',
      noneLabel: 'Filter by sector',
      oneLabel:  (i) => `Sector: ${i.label}`,
      manyLabel: (n) => `${n} sectors`,
      searchPlaceholder: 'Search sector…',
      groups: false,
      onChange: (sel) => {
        if (sel.length > SECTOR_FILTER_MAX) {
          _sectorMS.setSelected(_activeSectors);
          showToast('Max ' + SECTOR_FILTER_MAX + ' sectors at once');
          return;
        }
        _activeSectors = sel.slice();
        applyAndRender();
        writeUrlState();
      },
    });
  }

  function rebuildAddColumnsPicker() {
    const mount = document.getElementById('addColMS');
    if (!mount) return;
    if (_addColMS && typeof _addColMS.destroy === 'function') {
      // MultiSelect.create doesn't expose destroy in v1 — re-create against
      // the same mount, which clears innerHTML internally.
    }
    _addColMS = MultiSelect.create(mount, {
      items: extraColsLib().map(x => ({ value: x.value, label: x.label, group: x.group })),
      selected: _activeExtras,
      label: 'Add columns',
      allLabel: 'All extras',
      noneLabel: 'None added',
      oneLabel: (i) => `+ ${i.label}`,
      manyLabel: (n) => `+ ${n} columns`,
      searchPlaceholder: 'Search field…',
      groups: true,
      onChange: (sel) => {
        _activeExtras = sel.slice();
        // Persist per-family — eqh extras survive reloads, debt extras
        // are stored under a distinct key to avoid cross-family bleed.
        if (_family === 'eqh') AppState.setScreenerExtraColumns(_activeExtras);
        applyAndRender();
        writeUrlState();
      },
    });
  }

  /* ============================================================
   * URL STATE — read on load, write on every interaction
   * ============================================================ */
  function writeUrlState() {
    const p = new URLSearchParams();
    const ac = _acTiles ? _acTiles.getSelected() : [];
    if (_family === 'debt') {
      p.set('ac', 'debt');
    } else if (_family === 'commodity') {
      p.set('ac', 'commodity');
    } else if (ac.length < 2 || ac.join(',') !== 'equity,hybrid') {
      p.set('ac', ac.join(','));
    }
    const cat = _catMS ? _catMS.getSelected() : [];
    const fullCats = buildCategoryItems().filter(i => !i.disabled).map(i => i.value);
    if (cat.length !== fullCats.length) p.set('cat', cat.join(','));
    const amc = _amcMS ? _amcMS.getSelected() : [];
    if (amc.length !== buildAmcItems().length) p.set('amc', amc.join(','));
    const defaultSortKey = _family === 'eqh' ? 'score' : 'aum';
    if (_sortKey !== defaultSortKey || _sortDir !== 'desc') p.set('sort', _sortKey + '_' + _sortDir);
    rangeConfig().forEach(cfg => {
      if (isRangeFullDomain(cfg.key)) return;
      const r = _filterRanges[cfg.key];
      p.set('rng_' + cfg.key, `${r.min}~${r.max}`);
    });
    const q = (document.getElementById('searchInput').value || '').trim();
    if (q) p.set('q', q);
    if (_family === 'eqh' && _customWeights) {
      Object.entries(_customWeights).forEach(([k, v]) => {
        p.set('w_' + slugify(k), v);
      });
    }
    if (_activeExtras.length > 0) p.set('xcol', _activeExtras.join(','));
    const newUrl = p.toString() ? '?' + p.toString() : window.location.pathname;
    window.history.replaceState({}, '', newUrl);
  }

  function parseUrlState() {
    const p = new URLSearchParams(window.location.search);
    if (p.has('ac') && _family === 'eqh') {
      // Only equity/hybrid sub-selections matter here; debt/commodity are
      // handled at bootstrap (main) by switching family before this runs.
      const v = p.get('ac').split(',').filter(Boolean)
        .filter(x => x !== 'debt' && x !== 'commodity');
      if (v.length) {
        _acTiles.setSelected(v);
        rebuildCategoryItems();
      }
    }
    if (p.has('cat')) _catMS.setSelected(p.get('cat').split(',').filter(Boolean));
    if (p.has('amc')) _amcMS.setSelected(p.get('amc').split(',').filter(Boolean));
    if (p.has('sort')) {
      const [k, d] = p.get('sort').split('_');
      _sortKey = k;
      _sortDir = (d === 'asc' || d === 'desc') ? d : 'desc';
    }
    rangeConfig().forEach(cfg => {
      const k = 'rng_' + cfg.key;
      if (!p.has(k)) return;
      const parts = p.get(k).split('~');
      if (parts.length !== 2) return;
      const lo = parseFloat(parts[0]);
      const hi = parseFloat(parts[1]);
      if (isNaN(lo) || isNaN(hi)) return;
      const d = _filterDomains[cfg.key];
      if (!d) return;
      _filterRanges[cfg.key] = {
        min: Math.max(d.min, Math.min(d.max, lo)),
        max: Math.max(d.min, Math.min(d.max, hi)),
      };
      syncRangeUI(cfg);
    });
    if (p.has('q')) document.getElementById('searchInput').value = p.get('q');

    if (_family === 'eqh') {
      const weightLookup = new Map(_scoringWeights.map(w => [slugify(w.parameter), w.parameter]));
      p.forEach((value, key) => {
        if (!key.startsWith('w_')) return;
        const param = weightLookup.get(key.slice(2));
        if (!param) return;
        if (!_customWeights) _customWeights = {};
        _customWeights[param] = parseFloat(value);
      });
      if (_customWeights) AppState.setCustomWeights(_customWeights);
    }

    if (p.has('xcol')) {
      const xcols = p.get('xcol').split(',').filter(Boolean)
        .filter(v => extraColsLib().find(x => x.value === v));
      if (xcols.length) {
        _activeExtras = xcols;
        if (_family === 'eqh') AppState.setScreenerExtraColumns(_activeExtras);
        if (_addColMS) _addColMS.setSelected(_activeExtras);
      }
    }
  }

  function slugify(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_'); }

  /* ---------- toast ---------- */
  let _toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t || !msg) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function initToasts() {
    document.querySelectorAll('[data-toast]').forEach(el => {
      el.addEventListener('click', () => showToast(el.getAttribute('data-toast')));
    });
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
