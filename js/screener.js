/*
 * Centricity MF Screener Dashboard — screener.html page logic
 *
 * ⚠️  Screener is the ONLY page where weight edits trigger recompute.
 * Other pages (Home, Fund Detail, Compare, Portfolio Builder) read the
 * Excel-locked centricity_score directly from the JSON.
 *
 * The drawer's parameter list is enumerated from cycle.cycle_meta.scoring_weights[]
 * — never hardcoded. Adding/removing a parameter in the next Excel cycle
 * auto-resizes the drawer (CLAUDE.md §9 rule 1).
 *
 * Cowork 2026-05-06 (Fix-List 1) — initial overhaul.
 * Cowork 2026-05-06 (Fix-List 2) — incremental polish:
 *   §A. 12th utility column (checkbox) at left edge; Compare button
 *       restored in title-band actions; cap at 5 selections; selection
 *       persists across filter / sort but resets on hard reload.
 *   §B. Table layout — horizontal scroll wrapper, sticky checkbox + Rank
 *       + Fund-Name columns, multi-line centred headers, centred Category
 *       body cells, Fund Name as a Warm Gold link with hover underline,
 *       click navigation isolated to the link itself.
 *   §C. Sort comparator audit — composite Ranked-first priority dropped;
 *       null-last sorting (existing) handles the default-load case
 *       (score desc puts Ranked first because non-Ranked have null
 *       _displayScore). Per-column sort behaves as the user expects:
 *       click YTD desc → HDFC Defence Fund-Reg(G) at row 1. See
 *       ISSUE-0011 for the root-cause writeup.
 *   §D. "Add columns" multi-select dropdown — per-fund extras (m-cap
 *       split, hybrid extension, all 9 risk metrics, calendar returns,
 *       cost/turnover, tenure, identification). Persisted to
 *       centricity.v1.screener.extra_columns.
 *   §E. Weight drawer — OK forces sort to score desc, recomputes ranks,
 *       and re-sorts the table; numeric inputs reformat to 2dp on blur.
 *   §F. All range sliders share the AUM slider's full-rail width.
 *   §G. Footer note slimmed (returns-annualised sentence dropped).
 *   §H. Section-number eyebrow removed from titleband.
 *   §I. PDF + PPT export buttons disabled with "Coming after web design
 *       lock-in" caption (library code retained for v1.x).
 *
 * URL query-string state (so analysts can copy the address bar to share):
 *   ?ac=equity,hybrid                    → asset-class tile selection
 *   ?cat=Flexi+Cap,Multi+Cap             → category dropdown
 *   ?amc=ICICI+Pru,HDFC                  → AMC dropdown
 *   ?sort=score_desc                     → table sort key + direction
 *   ?rng_<key>=<min>~<max>               → range filter state, e.g. rng_aum_cr=5000~50000
 *   ?w_<param>=<value>                   → applied weight overrides
 *   ?xcol=risk_metrics.sortino_3y,...    → enabled extra columns
 *   ?q=quant                             → search box
 *
 * Persistence priority on load: URL params > AppState.* > cycle defaults.
 * Range filter + extra-column selections persist via URL only (ephemeral);
 * extra columns ALSO persist to AppState so the picker survives reloads.
 * Custom weights persist via AppState.setCustomWeights so analyst
 * exploration survives page reloads.
 *
 * In-row Compare selection state (`_selected`) lives in module memory only
 * and resets on hard reload (per spec).
 */
(function () {
  'use strict';

  /* ---------- module state ---------- */
  let _cycle = null;
  let _allFunds = [];
  let _filteredFunds = [];
  let _scoringWeights = [];
  // Fix-List 10 §8 — Morningstar manager-history overlay. Lazy-loaded
  // alongside the cycle JSON; null until the fetch resolves. Built
  // once into _mgrByScheme: { scheme_code: {name, tenure_years} } from
  // resolved-main-manager (longest-tenure current per fund).
  let _mgrHistoryCache = null;
  let _mgrByScheme = null;
  let _customWeights = null;          // applied weights (committed via OK)
  let _draftWeights = null;           // currently being edited inside the drawer
  let _drawerOpen = false;
  let _sortKey = 'score';
  let _sortDir = 'desc';
  const MAX_COMPARE = 5;
  let _selected = new Set();          // AMFI codes ticked for Compare

  let _acTiles, _catMS, _amcMS, _addColMS;       // selector instances

  // Filter ranges in *display units*. AUM in ₹ Cr, returns/risk in %, score in %.
  // Domains (min/max derived from data) drive what counts as "full range".
  let _filterRanges  = {};            // {key: {min, max}}
  let _filterDomains = {};            // {key: {min, max, step, niceMin, niceMax}}

  let _activeExtras = [];             // array of dotted-path values (extra columns)
  let _capWarnTimer = null;

  /* ---------- range filter config (drives both UI and predicate) ---------- */
  /**
   * Each entry says how to read the value, format the display, and which
   * physical domain to round outward to. `kind` selects the formatter.
   *
   *   kind = 'inr'         AUM in ₹ Cr — Indian comma grouping; max position
   *                        means "1L+" (no upper cap when filtering).
   *          'pct'         Signed percent (returns) — supports negatives,
   *                        Unicode minus, Dark Red colour.
   *          'pct-pos'     Always-positive percent (capture, turnover, TER).
   *          'num'         Plain number (Sharpe, tenure in years).
   *          'int'         Integer count (no. of stocks).
   *          'score-pct'   centricity_score is stored 0–1; slider works in
   *                        0–100% units, predicate divides by 100.
   */
  const RANGE_CONFIG = [
    { id: 'rngAum',     key: 'aum_cr',              label: 'AUM',                accessor: f => f.aum_cr,                          kind: 'inr',       hardCapMin: 0, hardCapMax: 100000, step: 1000 },
    { id: 'rngRolling', key: 'rolling_3y_avg_pct',  label: 'Rolling 3Y Avg',     accessor: f => f.rolling_3y_avg_pct,              kind: 'pct',       step: 0.5 },
    { id: 'rngYtd',     key: 'cy_ytd_pct',          label: 'YTD',                accessor: f => f.cy_returns ? f.cy_returns.cy_ytd_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngR1',      key: 'return_1y_pct',       label: '1Y',                 accessor: f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngR3',      key: 'return_3y_pct',       label: '3Y',                 accessor: f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngR5',      key: 'return_5y_pct',       label: '5Y',                 accessor: f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null, kind: 'pct', step: 0.5 },
    { id: 'rngSharpe',  key: 'sharpe_3y',           label: 'Sharpe',             accessor: f => f.risk_metrics ? f.risk_metrics.sharpe_3y : null, kind: 'num', step: 0.05 },
    { id: 'rngDownCap', key: 'down_capture_3y_pct', label: 'Down Capture',       accessor: f => f.risk_metrics ? f.risk_metrics.down_capture_3y_pct : null, kind: 'pct-pos', step: 1 },
    { id: 'rngUpCap',   key: 'up_capture_3y_pct',   label: 'Up Capture',         accessor: f => f.risk_metrics ? f.risk_metrics.up_capture_3y_pct : null, kind: 'pct-pos', step: 1 },
    { id: 'rngTurn',    key: 'turnover_pct',        label: 'Portfolio Turnover', accessor: f => f.turnover_pct,                    kind: 'pct-pos',   step: 1 },
    { id: 'rngMgrTen',  key: 'manager_tenure_yrs',  label: 'Mgr Tenure',         accessor: f => pluck(f, 'manager_tenure_yrs'),    kind: 'num',       suffix: ' yrs', step: 0.5 },
    { id: 'rngFundTen', key: 'fund_tenure_yrs',     label: 'Fund Tenure',        accessor: f => f.fund_tenure_yrs,                 kind: 'num',       suffix: ' yrs', step: 0.5 },
    { id: 'rngStocks',  key: 'no_of_stocks',        label: 'No. of Stocks',      accessor: f => f.no_of_stocks,                    kind: 'int',       step: 1 },
    { id: 'rngTer',     key: 'ter_pct',             label: 'TER',                accessor: f => f.ter_pct,                         kind: 'pct-pos',   step: 0.05 },
    { id: 'rngScore',   key: 'centricity_score',    label: 'Score',              accessor: f => f.centricity_score,                kind: 'score-pct', step: 1 },
  ];
  const SECTIONS = {
    returns: ['rolling_3y_avg_pct', 'cy_ytd_pct', 'return_1y_pct', 'return_3y_pct', 'return_5y_pct'],
    risk:    ['sharpe_3y', 'down_capture_3y_pct', 'up_capture_3y_pct', 'turnover_pct'],
    others:  ['manager_tenure_yrs', 'fund_tenure_yrs', 'no_of_stocks', 'ter_pct', 'centricity_score'],
  };

  /* ---------- nested-path resolver (used by sort + extra columns) ---------- */
  function pluck(obj, path) {
    if (obj == null) return null;
    // Fix-List 10 §8 — Morningstar overlay: when a row's manager_name
    // or manager_tenure_yrs is requested, prefer the resolved-main-
    // manager value from manager-history-*.json (loaded lazily). Falls
    // back to screener JSON when the index isn't built yet OR the fund
    // has no manager-history entry — so first paint and degraded fetch
    // both render cleanly.
    if (_mgrByScheme && obj && obj.scheme_code != null) {
      const overlay = _mgrByScheme[String(obj.scheme_code)];
      if (overlay) {
        if (path === 'manager_name')        return overlay.name;
        if (path === 'manager_tenure_yrs')  return overlay.tenure_years;
      }
    }
    return String(path).split('.').reduce((o, k) => (o == null ? null : o[k]), obj);
  }

  /* ---------- table column config (drives both render + sort) ----------
   * Fix-List 2 §A — `_check` column is the new index 0, then `_rank`
   * column displays IN-TABLE positional rank (under current weights / sort)
   * rather than the JSON's centricity_rank_overall directly.
   * Fix-List 2 §B — `name` column drops the AMC subline; only the fund-
   * name text is the click target (rendered as a gold link).
   * Fix-List 2 §C — composite Ranked-first sort dropped; null-last
   * sorting handles the default. */
  const DEFAULT_COLUMNS = [
    { key: '_check',   label: '',               align: 'center', cls: 'col-check',
      sortable: false,
      sortValue: () => null,
      text: f => `<input type="checkbox" class="row-check" data-scheme="${f.scheme_code}"${_selected.has(f.scheme_code) ? ' checked' : ''} aria-label="Select for compare">` },
    { key: 'rank',     label: 'Rank',           align: 'center', cls: 'col-rank',
      sortable: true,
      sortValue: f => f._displayRank,
      text: f => `<span class="num">${f._displayRank != null ? f._displayRank : '—'}</span>`,
      titleHelp: 'Rank under current weights. Reset weights to see Excel-locked Centricity rank.' },
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

  /* ---------- "Add columns" library — Fix-List 2 §D ----------
   * Each entry:
   *   value:  dotted JSON path used as both the lookup key and the column key
   *   label:  display text in the picker AND the table header
   *   group:  picker section (Holdings / Hybrid / Risk / Cost / Tenure / Id / Calendar / Other)
   *   kind:   format selector — 'pct' (signed), 'pct-pos', 'num', 'int',
   *           'inr', 'date', 'string', 'score-int' (AMC score /10)
   *   neg:    only meaningful for 'pct' — true to apply Dark Red on negatives
   * No parameter_scores fields; those are scoring intermediates and would
   * clutter the picker (per §D). They stay surfaced on Fund Detail's
   * parameter-score breakdown table.
   */
  const EXTRA_COLS = [
    // Holdings (m-cap split)
    { value: 'mcap_split.large_pct',   label: 'Large Cap %',   group: 'Holdings',         kind: 'pct-pos' },
    { value: 'mcap_split.mid_pct',     label: 'Mid Cap %',     group: 'Holdings',         kind: 'pct-pos' },
    { value: 'mcap_split.small_pct',   label: 'Small Cap %',   group: 'Holdings',         kind: 'pct-pos' },
    { value: 'mcap_split.others_pct',  label: 'Others %',      group: 'Holdings',         kind: 'pct-pos' },
    { value: 'no_of_stocks',           label: 'No. of Stocks', group: 'Holdings',         kind: 'int' },
    // Hybrid extension
    { value: 'hybrid_extension.equity_pct',       label: 'Equity %',          group: 'Hybrid extension', kind: 'pct-pos' },
    { value: 'hybrid_extension.debt_pct',         label: 'Debt %',            group: 'Hybrid extension', kind: 'pct-pos' },
    { value: 'hybrid_extension.others_pct_hybrid',label: 'Others % (Hybrid)', group: 'Hybrid extension', kind: 'pct-pos' },
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

  /* ---------- bootstrap ---------- */
  document.addEventListener('DOMContentLoaded', main);

  async function main() {
    let manifest, cycle;
    try {
      manifest = await DataLoader.listCycles();
      const last = AppState.getLastVisitedCycle();
      const initialDate = (last && manifest.cycles.find(c => c.date === last))
        ? last : (manifest.latest || manifest.cycles[0].date);
      cycle = await DataLoader.loadCycle(initialDate);
      AppState.setLastVisitedCycle(initialDate);
    } catch (err) {
      renderLoadError(err);
      return;
    }
    _cycle = cycle;
    _allFunds = cycle.funds.slice();
    _scoringWeights = cycle.cycle_meta.scoring_weights.slice();
    _customWeights = AppState.getCustomWeights();
    _activeExtras = AppState.getScreenerExtraColumns() || [];

    // Title + sub
    const m = cycle.cycle_meta;
    const cycleLabel = DataLoader.fmtCycleLabelDate(m);
    document.getElementById('screenerTitle').innerHTML =
      `Interactive <em>Screener</em> · ${escapeHtml(cycleLabel)}`;
    document.getElementById('screenerSub').textContent =
      `${m.total_funds.toLocaleString('en-IN')} funds across ${m.category_count} categories. ` +
      `Filter, sort, edit weights — your changes update the Score column live.`;
    document.getElementById('totalCount').textContent = m.total_funds.toLocaleString('en-IN');
    document.getElementById('footUpdated').textContent = 'Last updated · ' + m.as_on_display;

    initFilterDomains();
    initFilters();
    initRangeSliders();
    initWeightDrawer();
    initToolbar();
    initAddColumns();
    initCompareButton();
    parseUrlState();
    applyAndRender();
    initToasts();

    // Fix-List 10 §8 — fire-and-forget fetch of manager-history.
    // When it resolves, build the overlay index + re-render so manager
    // name + tenure cells / sliders pick up the Morningstar values.
    _loadMgrHistoryOverlay();
  }

  async function _loadMgrHistoryOverlay() {
    try {
      const res = await fetch('data/manager-history-2026-04-30.json', { cache: 'default' });
      if (!res.ok) return;
      _mgrHistoryCache = await res.json();
      const idx = Object.create(null);
      // Fix-List 11 §4 — resolve the MAIN manager via the same logic
      // fund-detail uses (resolveMainManager): cross-reference each
      // fund's screener `manager_name` and fuzzy-match against the
      // current managers in manager-history. Falls back to longest-
      // tenure-current only when no name match exists. Picks
      // Sankaran Naren over Manish Banthia for ICICI Pru E&D, etc.
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
      initFilterDomains();
      applyAndRender();
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
    RANGE_CONFIG.forEach(cfg => {
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
    if (cfg.kind === 'pct-pos') return 0;
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
  function initFilters() {
    const acItems = [
      { value: 'equity', label: 'Equity', sub: countOf('Equity') + ' funds' },
      { value: 'debt',   label: 'Debt',   sub: 'pending v1.x', disabled: true },
      { value: 'hybrid', label: 'Hybrid', sub: countOf('Hybrid') + ' funds' },
    ];
    _acTiles = MultiSelect.createTiles(document.getElementById('acTiles'), {
      items: acItems,
      selected: ['equity', 'hybrid'],
      label: 'Asset class',
      keepAtLeastOne: true,
      onChange: () => { rebuildCategoryItems(); applyAndRender(); writeUrlState(); },
    });

    _catMS = MultiSelect.create(document.getElementById('catMS'), {
      items: buildCategoryItems(_acTiles.getSelected()),
      selected: buildCategoryItems(['equity', 'hybrid']).map(i => i.value),
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
      _acTiles.setSelected(['equity', 'hybrid']);
      rebuildCategoryItems();
      _catMS.setSelected(buildCategoryItems(['equity', 'hybrid']).map(i => i.value));
      _amcMS.setSelected(buildAmcItems().map(i => i.value));
      RANGE_CONFIG.forEach(cfg => {
        const d = _filterDomains[cfg.key];
        _filterRanges[cfg.key] = { min: d.min, max: d.max };
        syncRangeUI(cfg);
      });
      _sortKey = 'score'; _sortDir = 'desc';
      document.getElementById('searchInput').value = '';
      applyAndRender();
      writeUrlState();
    });

    document.querySelectorAll('.reset-mini').forEach(btn => {
      btn.addEventListener('click', () => {
        const sectionKey = btn.getAttribute('data-section');
        const keys = SECTIONS[sectionKey] || [];
        keys.forEach(key => {
          const cfg = RANGE_CONFIG.find(c => c.key === key);
          if (!cfg) return;
          const d = _filterDomains[key];
          _filterRanges[key] = { min: d.min, max: d.max };
          syncRangeUI(cfg);
        });
        applyAndRender();
        writeUrlState();
      });
    });
  }

  function countOf(subClass) {
    return _allFunds.filter(f => f.sub_category_class === subClass).length.toLocaleString('en-IN');
  }
  function buildCategoryItems(assetClasses) {
    const cats = (_cycle.cycle_meta.categories || []);
    const items = [];
    if (assetClasses.includes('equity')) {
      cats.filter(c => c.sub_class === 'Equity').forEach(c => {
        items.push({ value: c.name, label: c.name, group: 'Equity' });
      });
    }
    if (assetClasses.includes('hybrid')) {
      cats.filter(c => c.sub_class === 'Hybrid').forEach(c => {
        items.push({ value: c.name, label: c.name, group: 'Hybrid' });
      });
    }
    if (assetClasses.includes('debt')) {
      items.push({
        value: '__debt_pending__', label: 'Debt — pending v1.x',
        group: 'Debt', disabled: true,
      });
    }
    return items;
  }
  function rebuildCategoryItems() {
    _catMS.refresh(buildCategoryItems(_acTiles.getSelected()), { defaultCheckNew: true });
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
    RANGE_CONFIG.forEach(cfg => {
      const root = document.getElementById(cfg.id);
      if (!root) return;
      const d = _filterDomains[cfg.key];
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
   * EDIT WEIGHTS DRAWER (modal overlay)
   * ============================================================ */
  function initWeightDrawer() {
    document.getElementById('weightsBtn').addEventListener('click', openDrawer);
    document.getElementById('cancelWeightsBtn').addEventListener('click', closeDrawer);
    document.getElementById('drawerBackdrop').addEventListener('click', closeDrawer);
    document.getElementById('resetWeightsBtn').addEventListener('click', () => {
      _draftWeights = defaultWeightsObject();
      renderDrawerInputs();
    });
    document.getElementById('okWeightsBtn').addEventListener('click', () => {
      const sum = sumDraft();
      if (Math.abs(sum - 100) > 0.01) return;             // guard
      const isDefault = _scoringWeights.every(w =>
        Math.abs(_draftWeights[w.parameter] - w.weight_pct) < 0.0001);
      _customWeights = isDefault ? null : Object.assign({}, _draftWeights);
      if (_customWeights == null) AppState.resetWeights();
      else                        AppState.setCustomWeights(_customWeights);
      closeDrawer();

      // Fix-List 2 §E.1 — force a re-sort by score desc on weight apply.
      // This makes the in-table positional rank reflect the new weighted
      // ranking, regardless of whatever column the user previously sorted by.
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
      const dirArrow = w.direction === 'Higher' ? '↑' : '↓';
      // Fix-List 2 §E.2 — initial display always 2dp, blur reformats too.
      return `
        <div class="weight-row" data-param="${escapeHtml(w.parameter)}">
          <span class="name">${escapeHtml(w.parameter)} <span class="dir">${dirArrow}</span></span>
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
      // Fix-List 2 §E.2 — reformat to 2dp on blur so '5' becomes '5.00',
      // '5.1' becomes '5.10'. Native <input type=number> strips trailing
      // zeros otherwise.
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
    const acSel  = _acTiles ? _acTiles.getSelected() : ['equity', 'hybrid'];
    const catSel = _catMS   ? _catMS.getSelected()   : [];
    const amcSel = _amcMS   ? _amcMS.getSelected()   : [];
    const subClassMap = { equity: 'Equity', hybrid: 'Hybrid' };
    const subClasses = acSel.map(a => subClassMap[a]).filter(Boolean);
    const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();

    const activeWeights = getActiveWeights();

    let funds = _allFunds.filter(f => subClasses.includes(f.sub_category_class));
    if (catSel.length > 0) funds = funds.filter(f => catSel.includes(f.category));
    if (amcSel.length > 0) funds = funds.filter(f => amcSel.includes(f.amc));
    if (search) {
      funds = funds.filter(f =>
        (f.fund_name || '').toLowerCase().includes(search) ||
        (f.amc || '').toLowerCase().includes(search) ||
        String(f.scheme_code || '').includes(search)
      );
    }

    // Recompute Score for Ranked funds against active weights, and assign
    // _displayRank by sorting Ranked-only by score desc — Fix-List 2 §E.1.
    funds = funds.map(f => {
      const cloned = Object.assign({}, f);
      cloned._displayScore = (f.centricity_score_status === 'Ranked')
        ? DataLoader.recomputeScore(f, activeWeights)
        : null;
      return cloned;
    });
    const rankedFunds = funds.filter(f => f.centricity_score_status === 'Ranked' && f._displayScore != null);
    rankedFunds.sort((a, b) => (b._displayScore || 0) - (a._displayScore || 0));
    rankedFunds.forEach((f, idx) => { f._displayRank = idx + 1; });
    funds.forEach(f => {
      if (f.centricity_score_status !== 'Ranked' || f._displayScore == null) f._displayRank = null;
    });

    // Apply range filters
    RANGE_CONFIG.forEach(cfg => {
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

    funds.sort(rowComparator(_sortKey, _sortDir));

    _filteredFunds = funds;
    document.getElementById('resultCount').textContent = funds.length.toLocaleString('en-IN');
    renderTable(funds);
    syncCompareButton();
  }

  /**
   * Per-column sort, no composite Ranked-first override (Fix-List 2 §C
   * audit findings — see ISSUE-0011). Null values sort last in either
   * direction (consistent UX). Ranked-first behaviour on the default
   * load (score desc) emerges naturally because non-Ranked funds have
   * null _displayScore and null sorts last.
   */
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
   * TABLE RENDER (12 default + 0..N extras; sticky left columns)
   * ============================================================ */
  function activeColumns() {
    const extras = _activeExtras.map(path => makeExtraColumn(path)).filter(Boolean);
    return DEFAULT_COLUMNS.concat(extras);
  }
  function makeExtraColumn(path) {
    const lib = EXTRA_COLS.find(x => x.value === path);
    if (!lib) return null;
    return {
      key: 'x_' + path.replace(/\W+/g, '_'),
      label: lib.label,
      align: 'center',
      neg: !!lib.neg,
      sortable: true,
      sortValue: f => extraSortValue(pluck(f, path), lib),
      pickRaw:   f => pluck(f, path),
      text:      f => formatExtraCell(pluck(f, path), lib),
    };
  }
  function extraSortValue(v, lib) {
    if (v == null) return null;
    if (lib.kind === 'string' || lib.kind === 'date') return String(v).toLowerCase();
    return v;
  }
  function formatExtraCell(v, lib) {
    if (v == null) return '—';
    switch (lib.kind) {
      case 'pct':       return `<span class="num">${DataLoader.fmtPct(v)}</span>`;
      case 'pct-pos':   return `${DataLoader.fmtNum(v)}%`;
      case 'num':       return `${DataLoader.fmtNum(v)}${lib.suffix || ''}`;
      case 'int':       return String(Math.round(v));
      case 'inr':       return `₹ ${DataLoader.fmtINR(v)}`;
      case 'date':      return DataLoader.fmtDate(v);
      case 'string':    return escapeHtml(String(v));
      case 'score-int': return `${v} / 10`;
      default:          return escapeHtml(String(v));
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
          // Header-cell content: label + sort arrow. Checkbox header has the
          // tri-state "select all visible" checkbox instead of the column name.
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
        const cls = [
          c.cls || '',
          c.align === 'left' ? 'left' : '',
          c.neg && c.pickRaw && typeof c.pickRaw(f) === 'number' && c.pickRaw(f) < 0 ? 'neg' : '',
        ].filter(Boolean).join(' ');
        return `<td class="${cls}">${c.text(f)}</td>`;
      }).join('');
      const rowCls = [
        f.centricity_score_status === 'Ranked' ? '' : 'non-ranked',
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
      if (!k) return;                                  // checkbox header
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
        // Toggle: if any visible row in the top-MAX_COMPARE is selected,
        // clear it; else select the top MAX_COMPARE.
        const top = funds.slice(0, MAX_COMPARE);
        const allOn = top.every(f => _selected.has(f.scheme_code));
        if (allOn) {
          top.forEach(f => _selected.delete(f.scheme_code));
        } else {
          _selected.clear();
          top.forEach(f => _selected.add(f.scheme_code));
        }
        applyAndRender();   // re-renders all checkbox states + row-selected classes
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
    // Restart the CSS animation
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
    return `<span class="badge new-fund">New Fund — Monitoring</span>`;
  }
  function fmtPctCell(v) {
    return `<span class="num">${DataLoader.fmtPct(v)}</span>`;
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
   * "ADD COLUMNS" MULTI-SELECT — Fix-List 2 §D
   * ============================================================ */
  function initAddColumns() {
    _addColMS = MultiSelect.create(document.getElementById('addColMS'), {
      items: EXTRA_COLS.map(x => ({ value: x.value, label: x.label, group: x.group })),
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
        AppState.setScreenerExtraColumns(_activeExtras);
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
    if (ac.length < 2 || ac.join(',') !== 'equity,hybrid') p.set('ac', ac.join(','));
    const cat = _catMS ? _catMS.getSelected() : [];
    const fullCats = buildCategoryItems(ac).filter(i => !i.disabled).map(i => i.value);
    if (cat.length !== fullCats.length) p.set('cat', cat.join(','));
    const amc = _amcMS ? _amcMS.getSelected() : [];
    if (amc.length !== buildAmcItems().length) p.set('amc', amc.join(','));
    if (_sortKey !== 'score' || _sortDir !== 'desc') p.set('sort', _sortKey + '_' + _sortDir);
    RANGE_CONFIG.forEach(cfg => {
      if (isRangeFullDomain(cfg.key)) return;
      const r = _filterRanges[cfg.key];
      p.set('rng_' + cfg.key, `${r.min}~${r.max}`);
    });
    const q = (document.getElementById('searchInput').value || '').trim();
    if (q) p.set('q', q);
    if (_customWeights) {
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
    if (p.has('ac')) {
      const v = p.get('ac').split(',').filter(Boolean);
      _acTiles.setSelected(v);
      rebuildCategoryItems();
    }
    if (p.has('cat')) _catMS.setSelected(p.get('cat').split(',').filter(Boolean));
    if (p.has('amc')) _amcMS.setSelected(p.get('amc').split(',').filter(Boolean));
    if (p.has('sort')) {
      const [k, d] = p.get('sort').split('_');
      _sortKey = k;
      _sortDir = (d === 'asc' || d === 'desc') ? d : 'desc';
    }
    RANGE_CONFIG.forEach(cfg => {
      const k = 'rng_' + cfg.key;
      if (!p.has(k)) return;
      const parts = p.get(k).split('~');
      if (parts.length !== 2) return;
      const lo = parseFloat(parts[0]);
      const hi = parseFloat(parts[1]);
      if (isNaN(lo) || isNaN(hi)) return;
      const d = _filterDomains[cfg.key];
      _filterRanges[cfg.key] = {
        min: Math.max(d.min, Math.min(d.max, lo)),
        max: Math.max(d.min, Math.min(d.max, hi)),
      };
      syncRangeUI(cfg);
    });
    if (p.has('q')) document.getElementById('searchInput').value = p.get('q');

    const weightLookup = new Map(_scoringWeights.map(w => [slugify(w.parameter), w.parameter]));
    p.forEach((value, key) => {
      if (!key.startsWith('w_')) return;
      const param = weightLookup.get(key.slice(2));
      if (!param) return;
      if (!_customWeights) _customWeights = {};
      _customWeights[param] = parseFloat(value);
    });
    if (_customWeights) AppState.setCustomWeights(_customWeights);

    if (p.has('xcol')) {
      const xcols = p.get('xcol').split(',').filter(Boolean)
        .filter(v => EXTRA_COLS.find(x => x.value === v));
      if (xcols.length) {
        _activeExtras = xcols;
        AppState.setScreenerExtraColumns(_activeExtras);
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
