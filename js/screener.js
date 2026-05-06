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
 * Cowork 2026-05-06 — Fix-List 1 changes (full list in SKILL.md §10):
 *   A. Cycle label uses cycle_meta.cycle_label_date ("15th Apr 2026")
 *   B. Export PDF + PPT wired via Exports.buildScreener{PDF,PPT}
 *   C. Edit Weights drawer redesigned: numeric inputs, OK/Cancel/Reset,
 *      OK disabled while sum ≠ 100 ± 0.01, modal overlay (works at 100% zoom)
 *   D. Copy Share Link button removed (URL state still updated for natural copy)
 *   E. Asset Class is selectable tiles; Category dropdown renamed (no "SEBI" prefix)
 *   F. AUM is a 2-handle range slider, 0 → 1L+ Cr, Indian comma grouping
 *   G. 14 additional 2-handle range filters across Returns / Risk / Others sections
 *      with min/max derived from current cycle data
 *   H. Table header restyled (black/white ALL CAPS, 1 step bigger), Rolling Returns
 *      + YTD columns added, TER column removed, non-Ranked funds visible
 *   I. 11-column order, centred-cell rule for numerics, horizontal scroll wrapper
 *
 * URL query-string state (so analysts can copy the address bar to share):
 *   ?ac=equity,hybrid                    → asset-class tile selection
 *   ?cat=Flexi+Cap,Multi+Cap             → category dropdown
 *   ?amc=ICICI+Pru,HDFC                  → AMC dropdown
 *   ?sort=score_desc                     → table sort key + direction
 *   ?rng_<key>=<min>~<max>               → range filter state, e.g. rng_aum_cr=5000~50000
 *   ?w_<param>=<value>                   → applied weight overrides
 *   ?q=quant                             → search box
 *
 * Persistence priority on load: URL params > AppState.* > cycle defaults.
 * Range filter state lives only in URL (ephemeral); custom weights persist
 * via AppState.setCustomWeights so analyst exploration survives page reloads.
 */
(function () {
  'use strict';

  /* ---------- module state ---------- */
  let _cycle = null;
  let _allFunds = [];
  let _filteredFunds = [];
  let _scoringWeights = [];
  let _customWeights = null;          // applied weights (committed via OK)
  let _draftWeights = null;           // currently being edited inside the drawer
  let _drawerOpen = false;
  let _sortKey = 'score';
  let _sortDir = 'desc';

  let _acTiles, _catMS, _amcMS;       // selector instances

  // Filter ranges in *display units*. AUM in ₹ Cr, returns/risk in %, score in %.
  // Domains (min/max derived from data) drive what counts as "full range".
  let _filterRanges  = {};            // {key: {min, max}}
  let _filterDomains = {};            // {key: {min, max, step, niceMin, niceMax}}

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
    { id: 'rngMgrTen',  key: 'manager_tenure_yrs',  label: 'Mgr Tenure',         accessor: f => f.manager_tenure_yrs,              kind: 'num',       suffix: ' yrs', step: 0.5 },
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

  /* ---------- table column config (drives both render + exports) ---------- */
  /**
   * 11 data columns per Cowork 2026-05-06. Order is left-to-right.
   * `align` controls header + body cells. Numerics are centred per the
   * Home v3 rule. `key` is the sort key. `sortValue` is what the
   * comparator pulls; `text` is what renders in the table cell;
   * `exportText` flattens to a single line for PDF / PPT.
   */
  const COLUMNS = [
    { key: 'rank',     label: 'Rank',           align: 'center',
      sortValue: f => f.centricity_rank_overall,
      text: f => `<span class="num">${f.centricity_score_status === 'Ranked' && f.centricity_rank_overall != null ? f.centricity_rank_overall : '—'}</span>`,
      exportText: f => f.centricity_score_status === 'Ranked' && f.centricity_rank_overall != null ? '#' + f.centricity_rank_overall : '—' },
    { key: 'name',     label: 'Fund / AMC',     align: 'left', cls: 'fund-cell',
      sortValue: f => (f.fund_name || '').toLowerCase(),
      text: f => `<div class="fund-name">${escapeHtml(f.fund_name)}</div><div class="fund-sub">${escapeHtml(f.amc || '—')} · #${f.scheme_code}</div>`,
      exportText: f => `${f.fund_name || '—'} (${f.amc || '—'})` },
    { key: 'category', label: 'Category',       align: 'left',
      sortValue: f => (f.category || '').toLowerCase(),
      text: f => escapeHtml(f.category || '—'),
      exportText: f => f.category || '—' },
    { key: 'aum',      label: 'AUM ₹ Cr',       align: 'center',
      sortValue: f => f.aum_cr,
      text: f => `₹ ${DataLoader.fmtINR(f.aum_cr)}`,
      exportText: f => f.aum_cr != null ? '₹ ' + DataLoader.fmtINR(f.aum_cr) : '—' },
    { key: 'rolling',  label: 'Rolling Returns', align: 'center', neg: true,
      sortValue: f => f.rolling_3y_avg_pct,
      pickRaw:   f => f.rolling_3y_avg_pct,
      text: f => fmtPctCell(f.rolling_3y_avg_pct),
      exportText: f => DataLoader.fmtPct(f.rolling_3y_avg_pct) },
    { key: 'ytd',      label: 'YTD',            align: 'center', neg: true,
      sortValue: f => f.cy_returns ? f.cy_returns.cy_ytd_pct : null,
      pickRaw:   f => f.cy_returns ? f.cy_returns.cy_ytd_pct : null,
      text: f => fmtPctCell(f.cy_returns ? f.cy_returns.cy_ytd_pct : null),
      exportText: f => DataLoader.fmtPct(f.cy_returns ? f.cy_returns.cy_ytd_pct : null) },
    { key: 'r1',       label: '1Y',             align: 'center', neg: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_1y_pct : null),
      exportText: f => DataLoader.fmtPct(f.trailing_returns ? f.trailing_returns.return_1y_pct : null) },
    { key: 'r3',       label: '3Y',             align: 'center', neg: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_3y_pct : null),
      exportText: f => DataLoader.fmtPct(f.trailing_returns ? f.trailing_returns.return_3y_pct : null) },
    { key: 'r5',       label: '5Y',             align: 'center', neg: true,
      sortValue: f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null,
      pickRaw:   f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null,
      text: f => fmtPctCell(f.trailing_returns ? f.trailing_returns.return_5y_pct : null),
      exportText: f => DataLoader.fmtPct(f.trailing_returns ? f.trailing_returns.return_5y_pct : null) },
    { key: 'sharpe',   label: 'Sharpe',         align: 'center',
      sortValue: f => f.risk_metrics ? f.risk_metrics.sharpe_3y : null,
      text: f => DataLoader.fmtNum(f.risk_metrics ? f.risk_metrics.sharpe_3y : null),
      exportText: f => DataLoader.fmtNum(f.risk_metrics ? f.risk_metrics.sharpe_3y : null) },
    { key: 'score',    label: 'Score',          align: 'center',
      sortValue: f => f._displayScore,
      text: f => renderScoreCell(f),
      exportText: f => f.centricity_score_status === 'Ranked'
        ? DataLoader.fmtScorePct(f._displayScore)
        : (f.centricity_score_status === '1-3yr Warning'
            ? `Warning ${f.centricity_score_warning_pct != null ? f.centricity_score_warning_pct.toFixed(2) + '%' : ''}`.trim()
            : 'New Fund — Monitoring') },
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
    initExports();
    parseUrlState();
    applyAndRender();
    initToasts();
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
      // AUM has hard caps so the "1L+" sentinel works
      if (cfg.hardCapMin != null && cfg.hardCapMax != null) {
        _filterDomains[cfg.key] = {
          min: cfg.hardCapMin, max: cfg.hardCapMax, step: cfg.step,
        };
        _filterRanges[cfg.key]  = { min: cfg.hardCapMin, max: cfg.hardCapMax };
        return;
      }

      // Score is stored 0..1 but slider works in 0..100
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
      // Snap niceLo / niceHi outward to the step boundary so initial display
      // and slider value (which always snaps to step) agree.
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
    if (cfg.kind === 'num') {
      if (v >= 0) return Math.floor(v * 10) / 10;
      return Math.floor(v * 10) / 10;
    }
    if (cfg.kind === 'pct') {
      // Round outward to nearest 5 for negatives, nearest 5 for positives
      if (v >= 0) return Math.floor(v / 5) * 5;
      return Math.floor(v / 5) * 5;
    }
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
    const m = _cycle.cycle_meta;

    // Asset Class — selectable tiles (Cowork 2026-05-06 Fix-List 1 §E.1)
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

    // Category — dropdown (renamed from "SEBI Category", §E.2)
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

    // AMC — dropdown (unchanged §E.3)
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

    // Per-section reset buttons
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
        if (lo > hi) { [lo, hi] = [hi, lo]; }
        _filterRanges[cfg.key] = { min: lo, max: hi };
        syncRangeUI(cfg);
        applyAndRender();
        writeUrlState();
      }
      minIn.addEventListener('input', () => {
        if (parseFloat(minIn.value) > parseFloat(maxIn.value)) {
          minIn.value = maxIn.value;
        }
        commit();
      });
      maxIn.addEventListener('input', () => {
        if (parseFloat(maxIn.value) < parseFloat(minIn.value)) {
          maxIn.value = minIn.value;
        }
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
      case 'inr':
        body = '₹' + DataLoader.fmtINR(v) + ' Cr';
        break;
      case 'pct':
        body = (isNeg ? '−' : (v > 0 ? '+' : '')) + Math.abs(v).toFixed(1) + '%';
        break;
      case 'pct-pos':
        body = v.toFixed(1) + '%';
        break;
      case 'score-pct':
        body = v.toFixed(0) + '%';
        break;
      case 'num':
        body = (isNeg ? '−' : '') + Math.abs(v).toFixed(2) + (cfg.suffix || '');
        break;
      case 'int':
        body = String(Math.round(v));
        break;
      default:
        body = String(v);
    }
    return `<span class="${cls}">${escapeHtml(body)}</span>`;
  }

  /* ---------- range filter predicate ---------- */
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
    if (v == null) return isRangeFullDomain(cfg.key);   // nulls only pass at full range
    if (cfg.kind === 'inr' && r.max >= d.max) {
      return v >= r.min;                                // 1L+ — no upper bound
    }
    if (cfg.kind === 'score-pct') {
      return (v * 100) >= r.min && (v * 100) <= r.max;
    }
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
      if (Math.abs(sum - 100) > 0.01) return;             // guard (button should already be disabled)
      // Apply: store as customWeights (or null if exactly default-equal)
      const isDefault = _scoringWeights.every(w =>
        Math.abs(_draftWeights[w.parameter] - w.weight_pct) < 0.0001);
      _customWeights = isDefault ? null : Object.assign({}, _draftWeights);
      if (_customWeights == null) AppState.resetWeights();
      else                        AppState.setCustomWeights(_customWeights);
      closeDrawer();
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

    // Highlight any zero-or-negative inputs in red so the user spots them
    document.querySelectorAll('#weightInputs input[type="number"]').forEach(input => {
      const v = parseFloat(input.value);
      input.classList.toggle('invalid', !ok && (isNaN(v) || v < 0));
    });
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

    // Recompute Score for Ranked funds against active weights
    funds = funds.map(f => {
      const cloned = Object.assign({}, f);
      if (f.centricity_score_status === 'Ranked') {
        cloned._displayScore = DataLoader.recomputeScore(f, activeWeights);
      } else {
        cloned._displayScore = null;
      }
      return cloned;
    });

    // Apply range filters last so they see the recomputed score
    RANGE_CONFIG.forEach(cfg => {
      // Build a temporary accessor-aware predicate that respects custom score
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
  }

  /**
   * Composite sort: (status priority asc, then user-chosen key/dir).
   * Status priority — Ranked first, then 1-3yr Warning, then New Fund Monitoring.
   */
  function rowComparator(key, dir) {
    const m = dir === 'asc' ? 1 : -1;
    const STATUS_RANK = { 'Ranked': 0, '1-3yr Warning': 1, 'New Fund Monitoring': 2 };
    const accessor = (f) => {
      const col = COLUMNS.find(c => c.key === key);
      return col ? col.sortValue(f) : null;
    };
    return (a, b) => {
      // Nullish coalescing — Ranked maps to 0, which is falsy under `||`. Use `??`.
      const sa = STATUS_RANK[a.centricity_score_status] ?? 99;
      const sb = STATUS_RANK[b.centricity_score_status] ?? 99;
      if (sa !== sb) return sa - sb;
      const av = accessor(a), bv = accessor(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * m;
      if (av > bv) return 1 * m;
      return 0;
    };
  }

  /* ============================================================
   * TABLE RENDER (11 columns; non-Ranked rows visible)
   * ============================================================ */
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

    const head = `
      <thead><tr>
        ${COLUMNS.map(c => {
          const sortedCls = _sortKey === c.key ? 'sorted' : '';
          const alignCls  = c.align === 'left' ? 'left' : '';
          return `<th data-key="${c.key}" class="${sortedCls} ${alignCls}">${escapeHtml(c.label)}<span class="arr">${_sortDir === 'asc' ? '▴' : '▾'}</span></th>`;
        }).join('')}
      </tr></thead>`;

    const rows = funds.map(f => {
      const tds = COLUMNS.map(c => {
        const cls = [
          c.align === 'left' ? 'left' : '',
          c.cls === 'fund-cell' ? 'fund-cell' : '',
          c.neg && c.pickRaw && typeof c.pickRaw(f) === 'number' && c.pickRaw(f) < 0 ? 'neg' : '',
        ].filter(Boolean).join(' ');
        return `<td class="${cls}">${c.text(f)}</td>`;
      }).join('');
      const rowCls = f.centricity_score_status === 'Ranked' ? '' : 'non-ranked';
      return `<tr data-scheme="${f.scheme_code}" class="${rowCls}">${tds}</tr>`;
    }).join('');

    wrap.innerHTML = `
      <div class="scroll-tbody">
        <table class="screener-tbl">
          ${head}
          <tbody>${rows}</tbody>
        </table>
      </div>`;

    wrap.querySelectorAll('thead th').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-key');
        if (_sortKey === k) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
        else { _sortKey = k; _sortDir = 'desc'; }
        applyAndRender();
        writeUrlState();
      });
    });

    // Row click — navigate to fund detail
    wrap.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const code = Number(tr.getAttribute('data-scheme'));
        if (code) window.location.href = `fund-detail.html?scheme=${code}`;
      });
    });
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
   * TOOLBAR / SEARCH
   * ============================================================ */
  function initToolbar() {
    document.getElementById('searchInput').addEventListener('input', () => {
      applyAndRender();
      writeUrlState();
    });
  }

  /* ============================================================
   * EXPORTS — Branded PDF + PPT (Cowork 2026-05-06)
   * ============================================================ */
  function initExports() {
    document.getElementById('exportPdfBtn').addEventListener('click', async () => {
      try {
        await Exports.buildScreenerPDF(buildExportPayload());
      } catch (err) {
        console.error('Export PDF failed:', err);
        showToast('Export PDF failed — check console.');
      }
    });
    document.getElementById('exportPptBtn').addEventListener('click', async () => {
      try {
        await Exports.buildScreenerPPT(buildExportPayload());
      } catch (err) {
        console.error('Export PPT failed:', err);
        showToast('Export PPT failed — check console.');
      }
    });
  }

  function buildExportPayload() {
    const cycleLabel = DataLoader.fmtCycleLabelDate(_cycle.cycle_meta);
    const fileSafe = cycleLabel.replace(/[^A-Za-z0-9]+/g, '-');
    return {
      funds: _filteredFunds,
      cycleLabel,
      filtersCaption: buildFiltersCaption(),
      fileBase: `Centricity-Screener-${fileSafe}`,
      columns: COLUMNS.map(c => ({
        label: c.label,
        align: c.align,
        neg: !!c.neg,
        key: f => c.exportText(f),
      })),
    };
  }

  function buildFiltersCaption() {
    const parts = [];
    const ac = _acTiles ? _acTiles.getSelected() : [];
    parts.push(ac.map(a => a.charAt(0).toUpperCase() + a.slice(1)).join(' + ') || 'No asset class');
    const cat = _catMS ? _catMS.getSelected() : [];
    parts.push(`${cat.length} categor${cat.length === 1 ? 'y' : 'ies'}`);
    const amc = _amcMS ? _amcMS.getSelected() : [];
    const allAmcCount = buildAmcItems().length;
    if (amc.length !== allAmcCount) parts.push(`${amc.length}/${allAmcCount} AMCs`);

    // Range filters that aren't at full domain
    RANGE_CONFIG.forEach(cfg => {
      if (isRangeFullDomain(cfg.key)) return;
      const r = _filterRanges[cfg.key], d = _filterDomains[cfg.key];
      const isMaxAtCap = cfg.kind === 'inr' && r.max >= d.max;
      const lo = exportRangeText(cfg, r.min);
      const hi = isMaxAtCap ? '1L+' : exportRangeText(cfg, r.max);
      parts.push(`${cfg.label} ${lo}–${hi}`);
    });

    const search = (document.getElementById('searchInput').value || '').trim();
    if (search) parts.push(`q: "${search}"`);
    return parts.join('  ·  ');
  }

  function exportRangeText(cfg, v) {
    if (v == null) return '—';
    switch (cfg.kind) {
      case 'inr':       return '₹' + DataLoader.fmtINR(v);
      case 'pct':       return (v < 0 ? '−' : (v > 0 ? '+' : '')) + Math.abs(v).toFixed(1) + '%';
      case 'pct-pos':   return v.toFixed(1) + '%';
      case 'score-pct': return v.toFixed(0) + '%';
      case 'num':       return (v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + (cfg.suffix || '');
      case 'int':       return String(Math.round(v));
      default:          return String(v);
    }
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
