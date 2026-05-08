/*
 * Centricity MF Screener Dashboard — portfolio-builder.js (v2)
 *
 * 5-step wizard → tier-aware selection engine → real-time quants panel.
 *
 * EXCEL-LOCKED WEIGHTS (per CLAUDE.md §9 + SKILL.md §7): the engine reads
 * `centricity_score` directly from the cycle JSON. It NEVER calls
 * DataLoader.recomputeScore(). Score is the Excel-shipped percentile-rank
 * score, identical to what every other page displays.
 *
 * Architecture:
 *   - All state lives in `_state` (in-memory; mirrored to localStorage on Save)
 *   - Selection engine: 12 sub-steps documented inline in runSelectionEngine()
 *   - Each output tab re-renders from `_portfolio` (the engine result + edits)
 *   - localStorage via window.AppState.savePortfolio (existing API)
 *   - Lazy-loads Chart.js, focused-funds.json, analytics, holdings-full,
 *     nav-series — only fetched once per session.
 *
 * If reverting: revert this file via git checkout. Page-level only;
 * no shared modules touched.
 */
(function () {
  'use strict';

  /* ============================================================
     CONSTANTS
     ============================================================ */

  // Risk × Time horizon → Asset class allocation (E/D/C/R %).
  // Spec §7. Sums to 100 in every cell.
  const ALLOC_MATRIX_AC = {
    capital_preservation: {
      lt1:    { equity: 20, debt: 70, commodities: 5, reits: 5 },
      '1to3': { equity: 30, debt: 60, commodities: 5, reits: 5 },
      '3to5': { equity: 40, debt: 50, commodities: 5, reits: 5 },
      '5to10':{ equity: 50, debt: 40, commodities: 5, reits: 5 },
      '10plus':{equity: 60, debt: 30, commodities: 5, reits: 5 },
    },
    conservative: {
      lt1:    { equity: 30, debt: 60, commodities: 5, reits: 5 },
      '1to3': { equity: 40, debt: 50, commodities: 5, reits: 5 },
      '3to5': { equity: 55, debt: 35, commodities: 5, reits: 5 },
      '5to10':{ equity: 65, debt: 25, commodities: 5, reits: 5 },
      '10plus':{equity: 70, debt: 20, commodities: 5, reits: 5 },
    },
    balanced: {
      lt1:    { equity: 50, debt: 40, commodities: 5, reits: 5 },
      '1to3': { equity: 60, debt: 30, commodities: 5, reits: 5 },
      '3to5': { equity: 70, debt: 20, commodities: 5, reits: 5 },
      '5to10':{ equity: 80, debt: 10, commodities: 5, reits: 5 },
      '10plus':{equity: 85, debt:  5, commodities: 5, reits: 5 },
    },
    growth: {
      lt1:    { equity: 70, debt: 20, commodities: 5, reits: 5 },
      '1to3': { equity: 80, debt: 10, commodities: 5, reits: 5 },
      '3to5': { equity: 85, debt:  5, commodities: 5, reits: 5 },
      '5to10':{ equity: 90, debt:  5, commodities: 5, reits: 0 },
      '10plus':{equity: 95, debt:  5, commodities: 0, reits: 0 },
    },
    aggressive: {
      lt1:    { equity: 85, debt: 10, commodities: 5, reits: 0 },
      '1to3': { equity: 90, debt:  5, commodities: 5, reits: 0 },
      '3to5': { equity: 95, debt:  5, commodities: 0, reits: 0 },
      '5to10':{ equity:100, debt:  0, commodities: 0, reits: 0 },
      '10plus':{equity:100, debt:  0, commodities: 0, reits: 0 },
    },
  };

  // Risk × Time horizon → M-Cap allocation (Large/Mid/Small/Flexi %).
  const ALLOC_MATRIX_MC = {
    capital_preservation: {
      lt1:    { large: 70, mid: 15, small: 5,  flexi: 10 },
      '1to3': { large: 60, mid: 20, small: 5,  flexi: 15 },
      '3to5': { large: 55, mid: 25, small: 5,  flexi: 15 },
      '5to10':{ large: 50, mid: 25, small: 10, flexi: 15 },
      '10plus':{large: 45, mid: 30, small: 10, flexi: 15 },
    },
    conservative: {
      lt1:    { large: 60, mid: 20, small: 5,  flexi: 15 },
      '1to3': { large: 55, mid: 25, small: 5,  flexi: 15 },
      '3to5': { large: 50, mid: 25, small: 10, flexi: 15 },
      '5to10':{ large: 45, mid: 30, small: 15, flexi: 10 },
      '10plus':{large: 40, mid: 30, small: 15, flexi: 15 },
    },
    balanced: {
      lt1:    { large: 50, mid: 25, small: 10, flexi: 15 },
      '1to3': { large: 45, mid: 30, small: 10, flexi: 15 },
      '3to5': { large: 40, mid: 30, small: 15, flexi: 15 },
      '5to10':{ large: 35, mid: 30, small: 20, flexi: 15 },
      '10plus':{large: 30, mid: 35, small: 20, flexi: 15 },
    },
    growth: {
      lt1:    { large: 40, mid: 30, small: 15, flexi: 15 },
      '1to3': { large: 35, mid: 30, small: 20, flexi: 15 },
      '3to5': { large: 30, mid: 30, small: 25, flexi: 15 },
      '5to10':{ large: 25, mid: 35, small: 25, flexi: 15 },
      '10plus':{large: 20, mid: 35, small: 30, flexi: 15 },
    },
    aggressive: {
      lt1:    { large: 30, mid: 30, small: 25, flexi: 15 },
      '1to3': { large: 25, mid: 30, small: 30, flexi: 15 },
      '3to5': { large: 20, mid: 35, small: 30, flexi: 15 },
      '5to10':{ large: 15, mid: 35, small: 35, flexi: 15 },
      '10plus':{large: 10, mid: 35, small: 40, flexi: 15 },
    },
  };

  // SEBI category → m-cap bucket. Mapping built from actual category values
  // present in screener-2026-04-15.json (26 distinct categories).
  const CATEGORY_MCAP_BUCKET = {
    // Pure size buckets
    'Large Cap':                'large',
    'Large & Mid Cap':          'large',
    'Mid Cap':                  'mid',
    'Small Cap':                'small',
    // Diversified (treat as flexi)
    'Flexi Cap':                'flexi',
    'Multi Cap':                'flexi',
    'Focused':                  'flexi',
    'ELSS':                     'flexi',
    'Value-Contra':             'flexi',
    'Special-Opp':              'flexi',
    // Sectoral / Thematic — flexi (sector-specific risk, not m-cap-bound)
    'Sector-Thematic':          'flexi',
    'Banking-FinServ':          'flexi',
    'FMCG-Consumption':         'flexi',
    'Healthcare-Pharma':        'flexi',
    'Infrastructure':           'flexi',
    'Manufacturing':            'flexi',
    'Technology':               'flexi',
    'ESG':                      'flexi',
    'MNC':                      'flexi',
    'PSU':                      'flexi',
    'Defence':                  'flexi',
    // Hybrids (mostly large-cap-tilt equity sleeves)
    'Aggressive Hybrid':        'large',
    'BAF':                      'large',
    'Equity Savings':           'large',
    'Multi Asset Allocation':   'large',
    'DAF':                      'large',
  };

  // Product checkboxes → SEBI category groups + sub_category_class.
  // Groups by `id` (used in the wizard) → predicate function on a fund.
  const PRODUCT_GROUPS = [
    {
      id: 'equity', label: 'Equity', available: true,
      products: [
        { id: 'equity_mf',     label: 'Equity MF',               available: true,
          test: f => f.sub_category_class === 'Equity' },
        { id: 'hybrid_mf',     label: 'Hybrid MF',               available: true,
          test: f => f.sub_category_class === 'Hybrid' },
        { id: 'direct_equity', label: 'Direct Equity',           available: false },
        { id: 'aif_equity',    label: 'AIF (Equity)',            available: false },
        { id: 'pms',           label: 'PMS',                     available: false },
      ],
    },
    {
      id: 'debt', label: 'Debt', available: false,
      products: [
        { id: 'debt_mf',       label: 'Debt MF',                 available: false },
        { id: 'hybrid_debt',   label: 'Hybrid MF (debt portion)',available: false },
        { id: 'bonds',         label: 'Bonds',                   available: false },
        { id: 'debt_aif',      label: 'Debt AIF',                available: false },
        { id: 'debt_pms',      label: 'Debt PMS',                available: false },
      ],
    },
    {
      id: 'commodities', label: 'Commodities', available: false,
      products: [
        { id: 'comm_mfetf',    label: 'MF / ETF',                available: false },
      ],
    },
    {
      id: 'reits', label: 'REITs / InvITs', available: false,
      products: [
        { id: 'reits_p',       label: 'REITs',                   available: false },
        { id: 'invits',        label: 'InvITs',                  available: false },
      ],
    },
  ];

  // Donut palette — Centricity-ordered.
  const DONUT_PALETTE = ['#BD9568', '#DBC8B2', '#0E0E0E', '#BFBFBF', '#6B4F2A',
                          '#A07850', '#D4B896', '#8C7B6B', '#4A3728', '#E8D5C0'];

  /* ── v4 Precision Mode tunables ─────────────────────────────────────────
     Single source of truth for mode-specific deviation tolerance + the
     parameter / top-up share split for the two mixed modes. */
  const PB_DEVIATION_TOLERANCE = {
    userNeeds:  { assetClass: 2, mcap: 4, sector: 5  },
    screener:   { assetClass: 4, mcap: 8, sector: 12 },
    centricity: { assetClass: 4, mcap: 8, sector: 12 },
  };
  const PB_MIX = {
    screener:   { paramShare: 0.65, topUpShare: 0.35 },
    centricity: { paramShare: 0.60, topUpShare: 0.40 },
  };
  const MODE_LABEL = {
    userNeeds:  'User Needs Focused',
    screener:   'Screener Ranking Focused',
    centricity: 'Centricity Model Focused',
  };
  /* Migrate v3 mode keys to v4 keys for saved snapshots / URL state. */
  function migrateModeKey(m) {
    if (m === 'fit')     return 'userNeeds';
    if (m === 'focused') return 'centricity';
    if (m === 'ranked')  return 'screener';
    return m || 'userNeeds';
  }

  /* ── v4 Tenor-based sub-category exclusion rules ────────────────────────
     Engine pre-filters universe at the start of runSelectionEngine. User
     can override via `_state.tenorOverrides[subCategoryName] = true`.
     Sub-category strings are matched against fund.category (SEBI naming). */
  const PB_TENOR_RULES = {
    /* Sub-1 year: only liquid / overnight / arbitrage-style funds. v1 has
       no liquid/overnight/USD funds (Equity + Hybrid only), so this maps
       to "exclude almost everything". User override required to build
       any meaningful portfolio at this horizon — and the wizard surfaces
       a portfolio note. */
    'lt1': {
      excludeCategories: [
        'Large Cap', 'Mid Cap', 'Small Cap', 'Flexi Cap', 'Multi Cap', 'Focused', 'ELSS',
        'Value-Contra', 'Special-Opp', 'Sector-Thematic', 'Banking-FinServ',
        'FMCG-Consumption', 'Healthcare-Pharma', 'Infrastructure', 'Manufacturing',
        'Technology', 'ESG', 'MNC', 'PSU', 'Defence', 'Large & Mid Cap',
        'Aggressive Hybrid', 'Multi Asset Allocation', 'BAF', 'DAF',
      ],
    },
    '1to3': {
      excludeCategories: [
        'Sector-Thematic', 'Banking-FinServ', 'FMCG-Consumption', 'Healthcare-Pharma',
        'Infrastructure', 'Manufacturing', 'Technology', 'ESG', 'MNC', 'PSU', 'Defence',
        'Small Cap', 'Mid Cap', 'Focused', 'ELSS', 'Special-Opp',
      ],
    },
    '3to5': {
      excludeCategories: [
        'Sector-Thematic', 'Banking-FinServ', 'FMCG-Consumption', 'Healthcare-Pharma',
        'Infrastructure', 'Manufacturing', 'Technology', 'ESG', 'MNC', 'PSU', 'Defence',
      ],
    },
    '5to10': {
      excludeCategories: ['BAF', 'DAF', 'Equity Savings'],
    },
    '10plus': {
      excludeCategories: ['BAF', 'DAF', 'Equity Savings'],
    },
  };
  function tenorExcludeSet(horizonKey) {
    const rule = PB_TENOR_RULES[horizonKey];
    return rule ? new Set(rule.excludeCategories) : new Set();
  }

  /* v4 §E — Detect International / Global / Overseas funds.
     The current SEBI category list (26 categories) doesn't include a
     dedicated "International" category, so we match on fund_name patterns.
     When v1.x ships data with FoF Overseas / international SEBI sub-cats,
     extend INTL_CATEGORIES to short-circuit the name regex. */
  const INTL_CATEGORIES = new Set(['FoF Overseas', 'Fund of Funds Overseas', 'International Equity']);
  const INTL_NAME_RE = /\b(International|Global|Overseas|Worldwide|Asia\s|Europe|Emerging\s+Mkt|Greater\s+China|Japan|Nasdaq|S&P\s*500)\b/i;
  function isIntlFund(f) {
    if (!f) return false;
    if (INTL_CATEGORIES.has(f.category)) return true;
    return INTL_NAME_RE.test(f.fund_name || '');
  }

  const RISK_LABEL = {
    capital_preservation: 'Capital Preservation',
    conservative: 'Conservative', balanced: 'Balanced',
    growth: 'Growth', aggressive: 'Aggressive',
  };
  const HORIZON_LABEL = {
    lt1: '< 1 yr', '1to3': '1–3 yr', '3to5': '3–5 yr',
    '5to10': '5–10 yr', '10plus': '10 yr+',
  };
  const AC_LABEL = {
    equity: 'Equity', debt: 'Debt',
    commodities: 'Commodities', reits: 'REITs / InvITs',
  };
  const MC_LABEL = {
    large: 'Large Cap', mid: 'Mid Cap',
    small: 'Small Cap', flexi: 'Multi-Cap / Flexi',
    intl:  'Intl / Global',
  };

  /* Fund role descriptors (Funds table column) */
  const FUND_ROLE = {
    'Large Cap':              'Anchor',
    'Large & Mid Cap':        'Core',
    'Flexi Cap':              'Core',
    'Multi Cap':              'Core',
    'Focused':                'High-Conviction',
    'ELSS':                   'Tax & Growth',
    'Value-Contra':           'Contrarian',
    'Aggressive Hybrid':      'Balanced Growth',
    'BAF':                    'Dynamic',
    'DAF':                    'Dynamic',
    'Equity Savings':         'Conservative',
    'Multi Asset Allocation': 'Diversifier',
    'Mid Cap':                'Growth',
    'Small Cap':              'Aggressive',
    'Sector-Thematic':        'Tactical',
    'Banking-FinServ':        'Tactical',
    'Healthcare-Pharma':      'Tactical',
    'FMCG-Consumption':       'Tactical',
    'Infrastructure':         'Tactical',
    'Manufacturing':          'Tactical',
    'Technology':             'Tactical',
    'ESG':                    'Tactical',
    'MNC':                    'Tactical',
    'PSU':                    'Tactical',
    'Defence':                'Tactical',
    'Special-Opp':            'Satellite',
  };
  function getFundRole(f) {
    return FUND_ROLE[f.category] || (f.sub_category_class === 'Hybrid' ? 'Balanced' : 'Core');
  }

  /* Display order for grouped Fund Performances table */
  const CATEGORY_ORDER = [
    'Large Cap', 'Large & Mid Cap', 'Flexi Cap', 'Multi Cap', 'Focused',
    'Mid Cap', 'Small Cap', 'ELSS', 'Value-Contra', 'Special-Opp',
    'Sector-Thematic', 'Banking-FinServ', 'Healthcare-Pharma', 'FMCG-Consumption',
    'Infrastructure', 'Manufacturing', 'Technology', 'ESG', 'MNC', 'PSU', 'Defence',
    'Aggressive Hybrid', 'BAF', 'DAF', 'Multi Asset Allocation', 'Equity Savings',
  ];

  /* ============================================================
     STATE
     ============================================================ */
  const _state = {
    risk: null,
    horizon: null,
    instMin: 6,
    instMax: 12,
    optimiseFunds: true,
    allocMode: 'auto',                       // 'auto' | 'manual' | 'partial'
    allocManual:        { equity: 60, debt: 30, commodities: 5, reits: 5 },
    allocPartialFlags:  { equity: false, debt: false, commodities: false, reits: false },
    includeGlobalMF: false,
    selectedProducts: { equity_mf: true, hybrid_mf: true },
    openClosedTypes: { open: true, closed: false },
    mcapMode: 'auto',
    mcapManual:    { large: 40, mid: 25, small: 20, flexi: 15 },
    mcapAutoFlags: { large: false, mid: false, small: false, flexi: false },
    sectorMode: 'auto',                      // 'auto' | 'manual_full' | 'manual_partial'
    sectorTargets: {},                       // typed targets only
    sectorAutoFlags: {},                     // partial mode: {sectorName: true} when Auto
    forceFunds: [],
    totalAmount: 5000000,
    precisionMode: 'userNeeds',    // 'userNeeds' | 'screener' | 'centricity'
    tenorOverrides: {},            // { '<sub-cat>': true } — re-enable categories excluded by horizon
    intlEquityShare: 0,            // 0..100, % of equity bucket allocated to international/global funds
  };

  /* Output state set by the engine. */
  let _portfolio = null;       // { funds: [...], deviation: {...}, warnings: [...] }
  let _activeStep = 1;
  let _activeTab = 'overview';
  let _navWindow = 'max';
  let _sortCol = null;         // funds-table sort column key
  let _sortDir = 1;            // 1 asc, -1 desc

  /* Lazy-loaded data */
  let _cycle = null;
  let _allFunds = [];
  let _focusedSchemes = [];   // numeric AMFI codes
  let _analytics = null;      // {funds: {scheme_code: {...}}}
  let _holdingsFull = null;   // {funds: {scheme_code: [...]}}
  let _navSeries = null;      // {series: {scheme_code: {...}}}
  let _allSectors = [];

  /* Charts */
  const _chartInstances = {};

  /* ============================================================
     INIT
     ============================================================ */
  document.addEventListener('DOMContentLoaded', main);

  async function main() {
    let manifest;
    try {
      manifest = await DataLoader.listCycles();
      const last = AppState.getLastVisitedCycle();
      const initialDate = (last && manifest.cycles.find(c => c.date === last))
        ? last : (manifest.latest || manifest.cycles[0].date);
      _cycle = await DataLoader.loadCycle(initialDate);
      AppState.setLastVisitedCycle(initialDate);
    } catch (err) {
      renderLoadError(err); return;
    }
    _allFunds = _cycle.funds;
    document.getElementById('footUpdated').textContent =
      'Last updated · ' + (_cycle.cycle_meta.as_on_display || _cycle.cycle_meta.cycle_date);
    document.getElementById('pbEyebrow').textContent =
      'Portfolio Builder · As on ' + (_cycle.cycle_meta.cycle_label_date || _cycle.cycle_meta.cycle_date);

    /* Lazy-load focused funds list (small, fire-and-forget) */
    fetch('data/focused-funds.json').then(r => r.ok ? r.json() : null).then(d => {
      _focusedSchemes = (d && Array.isArray(d.focused_funds))
        ? d.focused_funds.map(Number).filter(n => !isNaN(n)) : [];
    }).catch(() => { _focusedSchemes = []; });

    /* Build sector universe from analytics file (lazy) */
    fetch('data/analytics-2026-03-31.json').then(r => r.ok ? r.json() : null).then(d => {
      if (!d) return;
      _analytics = d;
      const set = new Set();
      Object.values(d.funds || {}).forEach(f => {
        (f.sector_allocation || []).forEach(s => set.add(s.sector));
      });
      _allSectors = Array.from(set).sort();
      renderSectorList();
    }).catch(() => {});

    /* Load holdings-full lazily (large file — defer until generation) */

    initStep1();
    initStep2();
    initStep3();
    initStep4();
    initStep5();
    initOutputUI();
    renderSavedPortfoliosList();

    /* Restore last wizard state if present */
    restoreLastWizardState();
  }

  function renderLoadError(err) {
    document.getElementById('mainArea').innerHTML =
      '<div class="empty-state" style="margin:48px 56px;text-align:center;">' +
      '<h3>Could not load cycle data</h3>' +
      '<p style="color:var(--red)">' + escapeHtml((err && err.message) || err) + '</p></div>';
  }

  /* ============================================================
     STEP 1 — Profile
     ============================================================ */
  function initStep1() {
    document.querySelectorAll('#riskPills .pill').forEach(p => p.addEventListener('click', () => {
      _state.risk = p.dataset.risk;
      document.querySelectorAll('#riskPills .pill').forEach(x => x.classList.toggle('active', x === p));
      updateStep1Next();
      refreshAutoTables();
    }));
    document.querySelectorAll('#horizonPills .pill').forEach(p => p.addEventListener('click', () => {
      _state.horizon = p.dataset.h;
      document.querySelectorAll('#horizonPills .pill').forEach(x => x.classList.toggle('active', x === p));
      updateStep1Next();
      refreshAutoTables();
      renderTenorOverrideList();
    }));
    /* v4 — dual-handle range slider for instrument count.
       Two overlaid <input type="range"> elements; each thumb's pointer-events
       are managed by the .pb-range-slider input rule (only the thumbs are
       interactive — the rest of the input is transparent). On change we
       enforce min ≤ max by swapping values when the user drags one handle
       past the other. */
    const minIn = document.getElementById('instMin');
    const maxIn = document.getElementById('instMax');
    const minLbl = document.getElementById('instMinLabel');
    const maxLbl = document.getElementById('instMaxLabel');
    const fillEl = document.getElementById('pbRangeFill');
    function updateRangeUI() {
      const lo = +minIn.min;
      const hi = +minIn.max;
      const span = hi - lo;
      const a = +minIn.value;
      const b = +maxIn.value;
      const aPct = ((Math.min(a, b) - lo) / span) * 100;
      const bPct = ((Math.max(a, b) - lo) / span) * 100;
      fillEl.style.left = aPct + '%';
      fillEl.style.right = (100 - bPct) + '%';
      minLbl.textContent = Math.min(a, b);
      maxLbl.textContent = Math.max(a, b);
    }
    function syncCounts() {
      let mn = Math.min(+minIn.value, +maxIn.value);
      let mx = Math.max(+minIn.value, +maxIn.value);
      _state.instMin = mn;
      _state.instMax = mx;
      updateRangeUI();
      updateStep1Next();
    }
    minIn.addEventListener('input', syncCounts);
    maxIn.addEventListener('input', syncCounts);
    /* Initialise UI from current state (handles snapshot-restore on cold load). */
    minIn.value = _state.instMin || 6;
    maxIn.value = _state.instMax || 12;
    updateRangeUI();
    document.getElementById('optimiseFunds').addEventListener('change', (e) => {
      _state.optimiseFunds = e.target.checked;
    });
    document.getElementById('step1Next').addEventListener('click', () => goToStep(2));
  }
  /* v4 — render the advanced tenor-override list when horizon is set. */
  function renderTenorOverrideList() {
    const wrap = document.getElementById('pbTenorList');
    const summaryHint = document.getElementById('pbTenorSummaryHint');
    if (!wrap || !_state.horizon) return;
    const excludedSet = tenorExcludeSet(_state.horizon);
    const excludedList = Array.from(excludedSet).sort();
    if (!excludedList.length) {
      wrap.innerHTML = '<p class="pb-help" style="grid-column:1/-1;margin:0;">No sub-categories are excluded for this horizon.</p>';
      if (summaryHint) summaryHint.textContent = '— no exclusions for this horizon';
      return;
    }
    wrap.innerHTML = excludedList.map(cat => {
      const checked = !!(_state.tenorOverrides && _state.tenorOverrides[cat]);
      return '<label><input type="checkbox" data-tenor-cat="' + escapeHtml(cat) + '"' +
             (checked ? ' checked' : '') + '> ' + escapeHtml(cat) + '</label>';
    }).join('');
    wrap.querySelectorAll('input[data-tenor-cat]').forEach(inp => {
      inp.addEventListener('change', () => {
        if (!_state.tenorOverrides) _state.tenorOverrides = {};
        if (inp.checked) _state.tenorOverrides[inp.dataset.tenorCat] = true;
        else delete _state.tenorOverrides[inp.dataset.tenorCat];
        if (summaryHint) {
          const n = Object.keys(_state.tenorOverrides).filter(k => _state.tenorOverrides[k]).length;
          summaryHint.textContent = n ? '— ' + n + ' override' + (n > 1 ? 's' : '') : '— ' + excludedList.length + ' categories excluded';
        }
      });
    });
    if (summaryHint) {
      const n = Object.keys(_state.tenorOverrides || {}).filter(k => _state.tenorOverrides[k]).length;
      summaryHint.textContent = n
        ? '— ' + n + ' override' + (n > 1 ? 's' : '')
        : '— ' + excludedList.length + ' categor' + (excludedList.length > 1 ? 'ies' : 'y') + ' excluded';
    }
  }

  function updateStep1Next() {
    const valid = (_state.risk && _state.horizon &&
                   _state.instMin >= 3 && _state.instMax <= 30 &&
                   _state.instMax >= _state.instMin);
    document.getElementById('step1Next').disabled = !valid;
    updateGenerateBtn();
  }

  /* ============================================================
     STEP 2 — Allocation
     ============================================================ */
  function initStep2() {
    /* Mode toggle (auto / manual / partial) */
    document.querySelectorAll('[data-alloc-mode]').forEach(b => b.addEventListener('click', () => {
      _state.allocMode = b.dataset.allocMode;
      document.querySelectorAll('[data-alloc-mode]').forEach(x => x.classList.toggle('active', x === b));
      document.getElementById('allocAutoView').hidden    = _state.allocMode !== 'auto';
      document.getElementById('allocManualView').hidden  = _state.allocMode !== 'manual';
      document.getElementById('allocPartialView').hidden = _state.allocMode !== 'partial';
      refreshAllocPartialMode();
      validateAllocSum();
    }));
    /* Manual inputs */
    document.querySelectorAll('.alloc-in').forEach(inp => inp.addEventListener('input', () => {
      const b = inp.dataset.bucket;
      _state.allocManual[b] = +inp.value || 0;
      validateAllocSum();
    }));
    /* Partial inputs + Auto checkboxes */
    document.querySelectorAll('.alloc-pin').forEach(inp => inp.addEventListener('input', () => {
      const b = inp.dataset.bucket;
      _state.allocManual[b] = +inp.value || 0;
      validateAllocSum();
    }));
    document.querySelectorAll('.alloc-pauto').forEach(c => c.addEventListener('change', () => {
      _state.allocPartialFlags[c.dataset.bucket] = c.checked;
      refreshAllocPartialMode();
      validateAllocSum();
    }));
    /* v4 — International / Global MF as sub-slice of Equity (Item E) */
    const intlSlider = document.getElementById('intlEquityShare');
    const intlLbl    = document.getElementById('intlEquityShareLabel');
    const intlTotal  = document.getElementById('intlEquityOfTotal');
    function refreshIntlReadout() {
      const v = +intlSlider.value || 0;
      _state.intlEquityShare = v;
      if (intlLbl) intlLbl.textContent = v + ' %';
      const equityPct = _state.allocMode === 'auto'
        ? (ALLOC_MATRIX_AC[_state.risk]?.[_state.horizon]?.equity || 0)
        : (+_state.allocManual.equity || 0);
      const ofTotal = (equityPct * v) / 100;
      if (intlTotal) intlTotal.textContent = ofTotal.toFixed(1) + ' % of total';
    }
    if (intlSlider) {
      intlSlider.addEventListener('input', refreshIntlReadout);
      intlSlider.value = _state.intlEquityShare || 0;
      refreshIntlReadout();
    }
    /* Re-fire intl readout when AC mode / inputs change so the "of total"
       hint stays accurate. */
    document.querySelectorAll('.alloc-in[data-bucket="equity"], .alloc-pin[data-bucket="equity"]').forEach(el =>
      el.addEventListener('input', refreshIntlReadout));
    document.querySelectorAll('[data-alloc-mode]').forEach(b =>
      b.addEventListener('click', () => setTimeout(refreshIntlReadout, 0)));
    /* Products */
    renderProducts();
    /* Open/closed */
    document.querySelectorAll('#pbOpenClosed input').forEach(c => c.addEventListener('change', () => {
      _state.openClosedTypes[c.dataset.oc] = c.checked;
    }));
    /* Back & Next */
    document.querySelector('[data-back="2"]').addEventListener('click', () => goToStep(1));
    document.getElementById('step2Next').addEventListener('click', () => goToStep(3));
  }

  /* Sync the partial-mode inputs: Auto-flagged ones display computed values + disabled. */
  function refreshAllocPartialMode() {
    if (_state.allocMode !== 'partial') return;
    const computed = computePartialAutoAlloc();
    document.querySelectorAll('.alloc-pin').forEach(inp => {
      const b = inp.dataset.bucket;
      if (_state.allocPartialFlags[b]) {
        inp.value = computed[b];
        inp.disabled = true;
        inp.classList.add('is-auto');
      } else {
        inp.disabled = false;
        inp.classList.remove('is-auto');
      }
    });
  }

  /* Distribute (100 − sum of typed buckets) proportionally to profile defaults
     across Auto-flagged AC buckets. Mirrors computePartialAutoMcap(). */
  function computePartialAutoAlloc() {
    const profDef = (_state.risk && _state.horizon)
      ? ALLOC_MATRIX_AC[_state.risk][_state.horizon]
      : { equity: 25, debt: 25, commodities: 25, reits: 25 };
    const buckets = ['equity', 'debt', 'commodities', 'reits'];
    const manualSum = buckets
      .filter(b => !_state.allocPartialFlags[b])
      .reduce((s, b) => s + (+_state.allocManual[b] || 0), 0);
    const remaining = Math.max(0, 100 - manualSum);
    const autoBuckets = buckets.filter(b => _state.allocPartialFlags[b]);
    const profSum = autoBuckets.reduce((s, b) => s + profDef[b], 0);
    const out = { equity: 0, debt: 0, commodities: 0, reits: 0 };
    if (profSum > 0 && autoBuckets.length) {
      autoBuckets.forEach(b => { out[b] = Math.round((profDef[b] / profSum) * remaining); });
      const sumOut = autoBuckets.reduce((s, b) => s + out[b], 0);
      const diff = remaining - sumOut;
      if (diff !== 0) out[autoBuckets[0]] += diff;
    }
    return out;
  }

  function renderProducts() {
    const wrap = document.getElementById('pbProducts');
    wrap.innerHTML = PRODUCT_GROUPS.map(g => {
      const open = g.id === 'equity' ? ' open' : '';
      const items = g.products.map(p => {
        const checked = (_state.selectedProducts[p.id] !== false);
        const cls = p.available ? '' : ' class="coming-soon"';
        const dis = p.available ? '' : ' disabled';
        const badge = p.available ? '' : '<span class="badge">Coming Soon</span>';
        return '<label' + cls + '><input type="checkbox" data-prod="' + p.id + '"' +
               (checked ? ' checked' : '') + dis + '> ' + p.label + ' ' + badge + '</label>';
      }).join('');
      return '<details class="pb-product-group"' + open + '>' +
             '<summary class="pb-product-summary">' + g.label + '</summary>' +
             '<div class="pb-product-body">' + items + '</div></details>';
    }).join('');
    /* Initialise selectedProducts state for available items */
    PRODUCT_GROUPS.forEach(g => g.products.forEach(p => {
      if (p.available && _state.selectedProducts[p.id] === undefined) {
        _state.selectedProducts[p.id] = true;
      }
    }));
    wrap.querySelectorAll('input[data-prod]').forEach(inp => inp.addEventListener('change', () => {
      _state.selectedProducts[inp.dataset.prod] = inp.checked;
    }));
  }

  function validateAllocSum() {
    /* Manual mode — straight sum of typed inputs */
    if (_state.allocMode === 'manual') {
      const sum = Object.values(_state.allocManual).reduce((s, v) => s + (+v || 0), 0);
      const sumEl = document.getElementById('allocSum');
      const errEl = document.getElementById('allocSumErr');
      sumEl.textContent = sum + '%';
      sumEl.classList.toggle('ok',  sum === 100);
      sumEl.classList.toggle('bad', sum !== 100);
      document.getElementById('allocSumNum').textContent = sum;
      errEl.hidden = (sum === 100);
      document.getElementById('step2Next').disabled = (sum !== 100);
      return;
    }
    /* Partial mode — fold computed auto values, then assess true sum */
    if (_state.allocMode === 'partial') {
      const c = computePartialAutoAlloc();
      ['equity', 'debt', 'commodities', 'reits'].forEach(b => {
        if (_state.allocPartialFlags[b]) _state.allocManual[b] = c[b];
      });
      const sum = ['equity', 'debt', 'commodities', 'reits']
        .reduce((s, b) => s + (+_state.allocManual[b] || 0), 0);
      const sumEl = document.getElementById('allocPartialSum');
      const errEl = document.getElementById('allocPartialSumErr');
      sumEl.textContent = sum + '%';
      sumEl.classList.toggle('ok',  sum === 100);
      sumEl.classList.toggle('bad', sum !== 100);
      document.getElementById('allocPartialSumNum').textContent = sum;
      errEl.hidden = (sum === 100);
      document.getElementById('step2Next').disabled = (sum !== 100);
      return;
    }
    /* Auto mode — always valid */
    document.getElementById('step2Next').disabled = false;
  }

  /* ============================================================
     STEP 3 — M-Cap
     ============================================================ */
  function initStep3() {
    document.querySelectorAll('[data-mcap-mode]').forEach(b => b.addEventListener('click', () => {
      _state.mcapMode = b.dataset.mcapMode;
      document.querySelectorAll('[data-mcap-mode]').forEach(x => x.classList.toggle('active', x === b));
      document.getElementById('mcapAutoView').hidden = _state.mcapMode !== 'auto';
      document.getElementById('mcapManualView').hidden = !(_state.mcapMode === 'manual_full' || _state.mcapMode === 'manual_partial');
      refreshMcapManualMode();
      validateMcapSum();
    }));
    document.querySelectorAll('.mcap-in').forEach(inp => inp.addEventListener('input', () => {
      _state.mcapManual[inp.dataset.bucket] = +inp.value || 0;
      validateMcapSum();
    }));
    document.querySelectorAll('.mcap-auto').forEach(c => c.addEventListener('change', () => {
      _state.mcapAutoFlags[c.dataset.bucket] = c.checked;
      refreshMcapManualMode();
      validateMcapSum();
    }));
    document.querySelector('[data-back="3"]').addEventListener('click', () => goToStep(2));
    document.getElementById('step3Next').addEventListener('click', () => goToStep(4));
  }

  function refreshMcapManualMode() {
    const partial = _state.mcapMode === 'manual_partial';
    document.querySelectorAll('.mcap-auto-tog').forEach(l => l.style.display = partial ? '' : 'none');
    document.querySelectorAll('.mcap-in').forEach(inp => {
      const b = inp.dataset.bucket;
      if (partial && _state.mcapAutoFlags[b]) {
        const computed = computePartialAutoMcap();
        inp.value = computed[b];
        inp.classList.add('is-auto');
        inp.disabled = true;
      } else {
        inp.classList.remove('is-auto');
        inp.disabled = false;
      }
    });
  }

  function computePartialAutoMcap() {
    /* Distribute (100 − sum of manual buckets) proportionally to profile defaults
       across Auto-flagged buckets only. */
    const profDef = (_state.risk && _state.horizon)
      ? ALLOC_MATRIX_MC[_state.risk][_state.horizon]
      : { large: 25, mid: 25, small: 25, flexi: 25 };
    const manualSum = ['large', 'mid', 'small', 'flexi']
      .filter(b => !_state.mcapAutoFlags[b])
      .reduce((s, b) => s + (+_state.mcapManual[b] || 0), 0);
    const remaining = Math.max(0, 100 - manualSum);
    const autoBuckets = ['large', 'mid', 'small', 'flexi'].filter(b => _state.mcapAutoFlags[b]);
    const profSum = autoBuckets.reduce((s, b) => s + profDef[b], 0);
    const out = { large: 0, mid: 0, small: 0, flexi: 0 };
    if (profSum > 0 && autoBuckets.length) {
      autoBuckets.forEach(b => { out[b] = Math.round((profDef[b] / profSum) * remaining); });
    }
    /* Reconcile any rounding residual to first auto bucket */
    if (autoBuckets.length) {
      const sumOut = autoBuckets.reduce((s, b) => s + out[b], 0);
      const diff = remaining - sumOut;
      if (diff !== 0) out[autoBuckets[0]] += diff;
    }
    return out;
  }

  function validateMcapSum() {
    if (_state.mcapMode === 'auto') {
      document.getElementById('step3Next').disabled = false; return;
    }
    /* Re-fold auto values into _state.mcapManual so the engine reads the right thing.
       True-sum guard (PB v2 §1D): even when partial mode forces auto buckets to 0
       (because manual entries already exceed 100), we still compute the TRUE sum
       across all four buckets — manual + computed-auto. If that ≠ 100, block Next. */
    if (_state.mcapMode === 'manual_partial') {
      const c = computePartialAutoMcap();
      Object.keys(c).forEach(b => { if (_state.mcapAutoFlags[b]) _state.mcapManual[b] = c[b]; });
    }
    const trueSum = ['large', 'mid', 'small', 'flexi']
      .reduce((s, b) => s + (+_state.mcapManual[b] || 0), 0);
    const sumEl = document.getElementById('mcapSum');
    const errEl = document.getElementById('mcapSumErr');
    sumEl.textContent = trueSum + '%';
    sumEl.classList.toggle('ok',  trueSum === 100);
    sumEl.classList.toggle('bad', trueSum !== 100);
    document.getElementById('mcapSumNum').textContent = trueSum;
    errEl.hidden = (trueSum === 100);
    document.getElementById('step3Next').disabled = (trueSum !== 100);
  }

  /* ============================================================
     STEP 4 — Sectors
     ============================================================ */
  function initStep4() {
    document.querySelectorAll('[data-sector-mode]').forEach(b => b.addEventListener('click', () => {
      _state.sectorMode = b.dataset.sectorMode;
      document.querySelectorAll('[data-sector-mode]').forEach(x => x.classList.toggle('active', x === b));
      document.getElementById('sectorAutoView').hidden    = _state.sectorMode !== 'auto';
      document.getElementById('sectorFullView').hidden    = _state.sectorMode !== 'manual_full';
      document.getElementById('sectorPartialView').hidden = _state.sectorMode !== 'manual_partial';
      renderSectorList();
      validateSectorSum();
    }));
    document.querySelector('[data-back="4"]').addEventListener('click', () => goToStep(3));
    document.getElementById('step4Next').addEventListener('click', () => goToStep(5));
  }

  /* v4 §F — render BOTH the Full and Partial sector lists eagerly so the
     DOM scaffolding is constant. Mode toggle just swaps visibility — fixes
     the "Manual Partial empty until toggle" bug. */
  function renderSectorList() {
    renderSectorListInto('pbSectorListFull', false);
    renderSectorListInto('pbSectorListPartial', true);
  }
  function renderSectorListInto(wrapId, isPartial) {
    const wrap = document.getElementById(wrapId);
    if (!wrap) return;
    /* Count funds per sector for tooltip context */
    const counts = {};
    if (_analytics) {
      Object.values(_analytics.funds || {}).forEach(f => {
        (f.sector_allocation || []).forEach(s => { counts[s.sector] = (counts[s.sector] || 0) + 1; });
      });
    }
    /* Default Auto-flag = true on first render in partial mode */
    if (isPartial) {
      _allSectors.forEach(s => {
        if (_state.sectorAutoFlags[s] === undefined) _state.sectorAutoFlags[s] = true;
      });
    }
    wrap.innerHTML = _allSectors.map(s => {
      const cnt = counts[s] || 0;
      const cur = _state.sectorTargets[s];
      const curStr = (cur === undefined || cur === null) ? '' : cur;
      const isAuto = isPartial && !!_state.sectorAutoFlags[s];
      const lbl = '<div class="lbl">' + escapeHtml(s) +
                  '<span class="cnt">(' + cnt + ' funds)</span></div>';
      const inp = '<input type="number" min="0" max="100" step="1" placeholder="—" data-sec="' +
                  escapeHtml(s) + '" value="' + curStr + '"' +
                  (isAuto ? ' disabled' : '') + '>';
      const tog = isPartial
        ? '<label class="auto-tog"><input type="checkbox" data-sec-auto="' +
          escapeHtml(s) + '"' + (isAuto ? ' checked' : '') + '> Auto</label>'
        : '';
      return lbl + inp + tog;
    }).join('');
    wrap.querySelectorAll('input[data-sec]').forEach(inp => inp.addEventListener('input', () => {
      const v = inp.value === '' ? null : +inp.value;
      if (v == null) delete _state.sectorTargets[inp.dataset.sec];
      else _state.sectorTargets[inp.dataset.sec] = v;
      validateSectorSum();
    }));
    wrap.querySelectorAll('input[data-sec-auto]').forEach(c => c.addEventListener('change', () => {
      const sec = c.dataset.secAuto;
      _state.sectorAutoFlags[sec] = c.checked;
      if (c.checked) delete _state.sectorTargets[sec];
      renderSectorList();
      validateSectorSum();
    }));
  }

  function validateSectorSum() {
    if (_state.sectorMode === 'auto') {
      document.getElementById('step4Next').disabled = false;
      return;
    }
    /* In partial mode, only typed (non-Auto) targets count toward the sum */
    let activeTargets = _state.sectorTargets;
    if (_state.sectorMode === 'manual_partial') {
      activeTargets = {};
      Object.keys(_state.sectorTargets).forEach(s => {
        if (!_state.sectorAutoFlags[s]) activeTargets[s] = _state.sectorTargets[s];
      });
    }
    const sum = Object.values(activeTargets).reduce((s, v) => s + (+v || 0), 0);
    const sumElId = (_state.sectorMode === 'manual_partial') ? 'sectorPartialSum' : 'sectorFullSum';
    const errElId = (_state.sectorMode === 'manual_partial') ? 'sectorPartialSumErr' : 'sectorFullSumErr';
    const sumEl = document.getElementById(sumElId);
    const errEl = document.getElementById(errElId);
    if (sumEl) sumEl.textContent = sum + '%';
    if (errEl) errEl.hidden = (sum <= 100);
    document.getElementById('step4Next').disabled = (sum > 100);
  }

  /* ============================================================
     STEP 5 — Finalize (force-include + saved portfolios)
     ============================================================ */
  function initStep5() {
    /* Force-include search */
    const inp = document.getElementById('forceFundSearch');
    const dd = document.getElementById('forceFundDd');
    let searchTimer;
    inp.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runForceSearch(inp.value), 200);
    });
    inp.addEventListener('focus', () => { if (inp.value.trim()) runForceSearch(inp.value); });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.pb-force-row')) dd.hidden = true;
    });

    /* Save / Reset */
    const saveName = document.getElementById('savePortName');
    const saveBtn  = document.getElementById('savePortBtn');
    saveName.addEventListener('input', () => {
      saveBtn.disabled = !saveName.value.trim();
    });
    saveBtn.addEventListener('click', () => {
      const name = saveName.value.trim();
      if (!name) return;
      AppState.savePortfolio(name, getWizardSnapshot(), []);
      showToast('Saved "' + name + '"');
      saveName.value = ''; saveBtn.disabled = true;
      renderSavedPortfoliosList();
    });
    document.getElementById('pbResetBtn').addEventListener('click', () => {
      if (!confirm('Reset all wizard inputs?')) return;
      window.location.reload();
    });

    /* Generate */
    /* Step 5 — Precision Mode */
    document.querySelector('[data-back="5"]').addEventListener('click', () => goToStep(4));
    document.querySelectorAll('input[name="precisionMode"]').forEach(r => {
      r.addEventListener('change', () => { _state.precisionMode = r.value; });
    });
    document.getElementById('step5Next').addEventListener('click', () => goToStep(6));

    /* Step 6 — Finalize (back to precision) */
    document.querySelector('[data-back="6"]').addEventListener('click', () => goToStep(5));
    document.getElementById('generateBtn').addEventListener('click', () => generatePortfolio());

    /* Stepper navigation back to completed steps */
    document.querySelectorAll('#pbStepper .step').forEach(s => s.addEventListener('click', () => {
      const n = +s.dataset.step;
      if (s.classList.contains('done')) goToStep(n);
    }));
  }

  function runForceSearch(query) {
    const dd = document.getElementById('forceFundDd');
    const q = (query || '').toLowerCase().trim();
    if (!q) { dd.hidden = true; return; }
    if (_state.forceFunds.length >= 5) {
      dd.innerHTML = '<div class="empty">Maximum 5 force-includes reached.</div>';
      dd.hidden = false; return;
    }
    const isNum = /^\d+$/.test(q);
    const matches = [];
    for (const f of _allFunds) {
      if (_state.forceFunds.find(x => x.scheme_code === f.scheme_code)) continue;
      const name = (f.fund_name || '').toLowerCase();
      const amc  = (f.amc       || '').toLowerCase();
      const cat  = (f.category  || '').toLowerCase();
      const code = String(f.scheme_code || '');
      let bucket = -1;
      if (name.startsWith(q))                        bucket = 0;
      else if (name.includes(q) || amc.includes(q))  bucket = 1;
      else if (cat.includes(q))                      bucket = 2;
      else if (isNum && code.startsWith(q))          bucket = 2;
      if (bucket >= 0) matches.push({ f, bucket });
      if (matches.length >= 30) break;
    }
    matches.sort((a, b) => a.bucket - b.bucket || ((b.f.centricity_score ?? 0) - (a.f.centricity_score ?? 0)));
    if (!matches.length) {
      dd.innerHTML = '<div class="empty">No matches.</div>';
      dd.hidden = false; return;
    }
    dd.innerHTML = matches.slice(0, 8).map(m => {
      const f = m.f;
      return '<div class="row" data-sc="' + f.scheme_code + '">' +
             '<span class="nm">' + escapeHtml(f.fund_name) + '</span>' +
             '<span class="ct">' + escapeHtml(f.category) + '</span></div>';
    }).join('');
    dd.querySelectorAll('.row').forEach(r => r.addEventListener('click', () => {
      const sc = +r.dataset.sc;
      const f = _allFunds.find(x => x.scheme_code === sc);
      if (!f) return;
      _state.forceFunds.push({
        scheme_code: f.scheme_code, fund_name: f.fund_name,
        amc: f.amc, category: f.category,
      });
      renderForceChips();
      document.getElementById('forceFundSearch').value = '';
      dd.hidden = true;
    }));
    dd.hidden = false;
  }

  function renderForceChips() {
    const wrap = document.getElementById('forceFundChips');
    wrap.innerHTML = _state.forceFunds.map((f, i) =>
      '<span class="pb-force-chip">' + escapeHtml(f.fund_name) +
      '<span class="x" data-i="' + i + '">×</span></span>'
    ).join('');
    wrap.querySelectorAll('.x').forEach(x => x.addEventListener('click', () => {
      _state.forceFunds.splice(+x.dataset.i, 1);
      renderForceChips();
      const inp = document.getElementById('forceFundSearch');
      inp.disabled = false;
    }));
    document.getElementById('forceFundSearch').disabled = (_state.forceFunds.length >= 5);
  }

  function renderSavedPortfoliosList() {
    const wrap = document.getElementById('savedPortList');
    if (!wrap) return;
    const list = AppState.getSavedPortfolios();
    if (!list.length) {
      wrap.innerHTML = '<p style="color:var(--text-mid);font-size:11.5px;margin:0;">No saved portfolios yet.</p>';
      return;
    }
    wrap.innerHTML = list.map(p =>
      '<div class="pb-saved-row-item"><span><span class="nm">' + escapeHtml(p.name) + '</span>' +
      '<span class="meta">' + DataLoader.fmtDate(p.createdAt) + '</span></span>' +
      '<span class="acts"><button data-load="' + escapeHtml(p.name) + '">Load</button>' +
      '<button class="del" data-del="' + escapeHtml(p.name) + '">×</button></span></div>'
    ).join('');
    wrap.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', () => {
      const p = AppState.getSavedPortfolios().find(x => x.name === b.dataset.load);
      if (p) loadWizardSnapshot(p.constraints);
    }));
    wrap.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
      AppState.deletePortfolio(b.dataset.del);
      renderSavedPortfoliosList();
    }));
  }

  /* ============================================================
     STEPPER NAV
     ============================================================ */
  function goToStep(n) {
    _activeStep = n;
    document.querySelectorAll('#pbStepper .step').forEach(s => {
      const i = +s.dataset.step;
      s.classList.toggle('active', i === n);
      s.classList.toggle('done',   i < n);
    });
    document.querySelectorAll('.pb-step').forEach(p => {
      p.classList.toggle('is-open', +p.dataset.stepPane === n);
    });
    refreshAutoTables();
    if (n === 4) renderSectorList();
    if (n === 5) refreshPrecisionStep();
    updateGenerateBtn();
    /* Auto-scroll wizard panel to top */
    document.getElementById('pbWizard').scrollTop = 0;
  }

  function refreshPrecisionStep() {
    /* Sync radio to current state (e.g., after loadWizardSnapshot) */
    document.querySelectorAll('input[name="precisionMode"]').forEach(r => {
      r.checked = (r.value === _state.precisionMode);
    });
  }

  function updateGenerateBtn() {
    document.getElementById('generateBtn').disabled = !(_state.risk && _state.horizon);
  }

  function refreshAutoTables() {
    if (!_state.risk || !_state.horizon) return;
    /* Asset Class auto */
    const ac = ALLOC_MATRIX_AC[_state.risk][_state.horizon];
    const acTbl = document.getElementById('allocAutoTbl').querySelector('tbody');
    acTbl.innerHTML = ['equity','debt','commodities','reits'].map(b =>
      '<tr><td>' + AC_LABEL[b] + '</td><td>' + ac[b] + '%</td></tr>'
    ).join('');
    /* M-Cap auto */
    const mc = ALLOC_MATRIX_MC[_state.risk][_state.horizon];
    const mcTbl = document.getElementById('mcapAutoTbl').querySelector('tbody');
    mcTbl.innerHTML = ['large','mid','small','flexi'].map(b =>
      '<tr><td>' + MC_LABEL[b] + '</td><td>' + mc[b] + '%</td></tr>'
    ).join('');
  }

  /* ============================================================
     SELECTION ENGINE
     ============================================================ */
  async function generatePortfolio() {
    const btn = document.getElementById('generateBtn');
    const orig = btn.textContent; btn.textContent = 'GENERATING…'; btn.disabled = true;

    /* Lazy-load holdings + nav-series in parallel for downstream computations */
    if (!_holdingsFull) {
      try {
        const r = await fetch('data/holdings-full-2026-03-31.json');
        if (r.ok) _holdingsFull = await r.json();
      } catch (e) { _holdingsFull = { funds: {} }; }
    }

    try {
      _portfolio = runSelectionEngine();
      saveLastWizardState();

      /* v4 §4.2 — userNeeds mode no longer silently falls back to 'focused'
         (that v3 behaviour is removed). Instead: produce best-effort portfolio
         and surface a deviation-breach Portfolio Note when actual deviation
         exceeds the mode's tolerance budget. The note text is set inside
         runSelectionEngine when the breach is computed; we just toggle the
         element here. */
      const fallbackNoteEl = document.getElementById('pbParamFallbackNote');
      const showNote = !!_portfolio.deviationBreach;
      if (fallbackNoteEl) {
        fallbackNoteEl.hidden = !showNote;
        if (showNote && _portfolio.deviationBreachMessage) {
          fallbackNoteEl.textContent = _portfolio.deviationBreachMessage;
        }
      }

      if (!_portfolio.funds.length) {
        document.getElementById('pbOutEmpty').hidden = false;
        document.getElementById('pbOutEmpty').querySelector('h3').textContent = 'No funds matched your criteria';
        document.getElementById('pbOutEmpty').querySelector('p').textContent = 'No Ranked or Focused funds found for your selected m-cap and product mix. Try broadening the m-cap allocation, adding more product types, or reducing the instrument count target.';
        showToast('No eligible funds — broaden criteria');
      } else {
        renderOutput();
        showToast('Portfolio generated · ' + _portfolio.funds.length + ' funds' +
                  (showNote ? ' · ' + (MODE_LABEL[_portfolio.mode] || _portfolio.mode) + ' (deviation breached)' : ''));
      }
    } catch (e) {
      console.error('[pb] generation failed', e);
      showToast('Generation failed: ' + (e.message || e));
    } finally {
      btn.textContent = orig; btn.disabled = false;
    }
  }

  function runSelectionEngine() {
    const out = { funds: [], deviation: {}, warnings: [], comingSoonNote: false };

    /* Step 1 — universe */
    let universe = _allFunds.slice();

    /* v4 — Tenor-based pre-filter (Item C). Drops sub-categories that are
       inappropriate for the user's time horizon, unless the user has
       explicitly re-enabled them via the Step-1 advanced override. */
    const tenorExcl = tenorExcludeSet(_state.horizon);
    const overrideOn = _state.tenorOverrides || {};
    const tenorRemoved = [];
    universe = universe.filter(f => {
      if (!tenorExcl.has(f.category)) return true;
      if (overrideOn[f.category]) return true;
      tenorRemoved.push(f.category);
      return false;
    });
    /* Cache the rule set + which categories were actually removed so the
       Plan tab + Summary header can surface them. */
    out.tenorExcluded = Array.from(tenorExcl);
    out.tenorOverridden = Object.keys(overrideOn).filter(k => overrideOn[k]);
    out.tenorRemovedCount = tenorRemoved.length;

    /* Step 2 — tier classification
       Priority order (per Centricity spec):
         0 FOCUSED   — on the Focused Selling List (focused-funds.json)
         1 RANKED    — centricity_score_status === 'Ranked'
         2 UNRANKED  — all other statuses with > 1 yr track record
         3 NEW_FUND  — inception date within the last 12 months (least preferred)
    */
    const focusedSet = new Set(_focusedSchemes);
    const _oneYrAgo = new Date();
    _oneYrAgo.setFullYear(_oneYrAgo.getFullYear() - 1);
    universe.forEach(f => {
      const isNew = f.inception_date && (new Date(f.inception_date) > _oneYrAgo);
      f._tier = focusedSet.has(f.scheme_code)              ? 'FOCUSED'
              : f.centricity_score_status === 'Ranked'     ? 'RANKED'
              : isNew                                      ? 'NEW_FUND'
              :                                             'UNRANKED';
    });

    /* Step 3 — product filter */
    universe = universe.filter(f => {
      for (const g of PRODUCT_GROUPS) {
        for (const p of g.products) {
          if (!p.available) continue;
          if (_state.selectedProducts[p.id] && p.test && p.test(f)) return true;
        }
      }
      return false;
    });

    /* Step 4 — open/closed filter (graceful: field absent → treat as open) */
    if (!_state.openClosedTypes.open && _state.openClosedTypes.closed) {
      /* Only close-ended requested. Currently no funds have such markers — would empty universe. Leave as-is. */
    }

    /* Step 5 — resolve target asset allocation */
    let targetAC;
    if (_state.allocMode === 'auto') {
      targetAC = Object.assign({}, ALLOC_MATRIX_AC[_state.risk][_state.horizon]);
    } else if (_state.allocMode === 'manual') {
      targetAC = Object.assign({}, _state.allocManual);
    } else {
      /* partial: blend of typed + computed-auto */
      const c = computePartialAutoAlloc();
      targetAC = { equity: 0, debt: 0, commodities: 0, reits: 0 };
      ['equity', 'debt', 'commodities', 'reits'].forEach(b => {
        targetAC[b] = _state.allocPartialFlags[b] ? c[b] : (+_state.allocManual[b] || 0);
      });
    }
    /* Coming-soon redistribution: collapse all non-equity into equity (since debt/comm/reits aren't live) */
    const equityShareTarget = (targetAC.equity || 0) + (targetAC.debt || 0) +
                              (targetAC.commodities || 0) + (targetAC.reits || 0);
    const csNote = (targetAC.debt > 0 || targetAC.commodities > 0 || targetAC.reits > 0);
    out.comingSoonNote = csNote;
    out.deviation.targetAC = targetAC;

    /* Step 6 — resolve m-cap target */
    let targetMC;
    if (_state.mcapMode === 'auto') {
      targetMC = Object.assign({}, ALLOC_MATRIX_MC[_state.risk][_state.horizon]);
    } else if (_state.mcapMode === 'manual_full') {
      targetMC = Object.assign({}, _state.mcapManual);
    } else {
      /* manual_partial: blend of user inputs + auto-computed */
      const c = computePartialAutoMcap();
      targetMC = { large: 0, mid: 0, small: 0, flexi: 0 };
      Object.keys(targetMC).forEach(b => {
        targetMC[b] = _state.mcapAutoFlags[b] ? c[b] : (+_state.mcapManual[b] || 0);
      });
    }
    out.deviation.targetMC = targetMC;

    /* v4 §E — Carve out an `intl` slice from equity if user requested any
       international/global allocation. Domestic m-cap targets are scaled down
       proportionally so total still sums to 100. */
    const intlShare = +_state.intlEquityShare || 0;
    let intlTargetPct = 0;
    if (intlShare > 0) {
      const equityPctOfTotal = (targetAC.equity || 0) +
                               (targetAC.debt || 0) +
                               (targetAC.commodities || 0) +
                               (targetAC.reits || 0);
      intlTargetPct = (equityPctOfTotal * intlShare) / 100;
      const scale = (100 - intlTargetPct) / 100;
      ['large', 'mid', 'small', 'flexi'].forEach(b => {
        targetMC[b] = (targetMC[b] || 0) * scale;
      });
      targetMC.intl = intlTargetPct;
    }
    out.intlTargetPct = intlTargetPct;

    /* Step 7 — group by m-cap bucket. Equity funds matching INTL_PATTERN go
       to the `intl` bucket; everything else uses the existing CATEGORY_MCAP
       mapping with mcap_split fallback. */
    const buckets = { large: [], mid: [], small: [], flexi: [], intl: [] };
    universe.forEach(f => {
      if (intlShare > 0 && isIntlFund(f)) { buckets.intl.push(f); return; }
      let b = CATEGORY_MCAP_BUCKET[f.category];
      if (!b) {
        /* Fall back to mcap_split */
        const m = f.mcap_split || {};
        const top = Math.max(m.large_pct || 0, m.mid_pct || 0, m.small_pct || 0);
        if      (top === (m.large_pct || 0) && (m.large_pct || 0) > 50) b = 'large';
        else if (top === (m.small_pct || 0) && (m.small_pct || 0) > 35) b = 'small';
        else if (top === (m.mid_pct   || 0) && (m.mid_pct   || 0) > 35) b = 'mid';
        else                                                            b = 'flexi';
      }
      buckets[b].push(f);
    });

    /* Step 8 — sector alignment bonus (manual modes only) */
    let sectorTargets = {};
    if (_state.sectorMode === 'manual_full') {
      sectorTargets = _state.sectorTargets;
    } else if (_state.sectorMode === 'manual_partial') {
      Object.keys(_state.sectorTargets).forEach(s => {
        if (!_state.sectorAutoFlags[s]) sectorTargets[s] = _state.sectorTargets[s];
      });
    }
    if (_analytics && Object.keys(sectorTargets).length) {
      universe.forEach(f => {
        const aFund = _analytics.funds[String(f.scheme_code)];
        if (!aFund) { f._sectorBonus = 0; return; }
        let bonus = 0;
        (aFund.sector_allocation || []).forEach(s => {
          if (sectorTargets[s.sector] != null) {
            bonus += (sectorTargets[s.sector] / 100) * (s.holding_pct / 100);
          }
        });
        /* In Best Fit mode the bonus must outweigh tier differences in sortFn.
           We scale by 100 so values land in ~0–1 range (same ballpark as centricity_score). */
        f._sectorBonus = bonus * 100;
      });
    } else {
      universe.forEach(f => { f._sectorBonus = 0; });
    }

    /* v4 — three precision modes, all share a single TIER_RANK ordering
       (FOCUSED → RANKED → UNRANKED → NEW_FUND). Mode behaviour is driven
       by which sortFn variant the bucket-fill pass uses + whether a
       second top-up pass runs at all. */
    const TIER_RANK = { FOCUSED: 0, RANKED: 1, UNRANKED: 2, NEW_FUND: 3 };

    /* Parameter-fit sort: sectors win absolutely if user set targets;
       otherwise tier → score → sharpe. Used for User Needs mode + the
       parameter-fit pass of the two mixed modes. */
    function sortFnParam(a, b) {
      const hasSectors = Object.keys(sectorTargets).length > 0;
      if (hasSectors) {
        const bd = (b._sectorBonus || 0) - (a._sectorBonus || 0);
        if (Math.abs(bd) > 0.0005) return bd;
      }
      const ta = TIER_RANK[a._tier] ?? 9;
      const tb = TIER_RANK[b._tier] ?? 9;
      if (ta !== tb) return ta - tb;
      const sa = (a.centricity_score ?? 0) + (a._sectorBonus || 0);
      const sb = (b.centricity_score ?? 0) + (b._sectorBonus || 0);
      if (Math.abs(sb - sa) > 0.001) return sb - sa;
      return (b.risk_metrics?.sharpe_3y || 0) - (a.risk_metrics?.sharpe_3y || 0);
    }

    /* Top-up sort for `screener` mode: pure ranking play — best Ranked /
       Focused by centricity_score, sector-agnostic. */
    function sortFnTopUpRanked(a, b) {
      const ta = TIER_RANK[a._tier] ?? 9;
      const tb = TIER_RANK[b._tier] ?? 9;
      if (ta !== tb) return ta - tb;
      const sa = a.centricity_score ?? 0;
      const sb = b.centricity_score ?? 0;
      if (Math.abs(sb - sa) > 0.001) return sb - sa;
      return (b.risk_metrics?.sharpe_3y || 0) - (a.risk_metrics?.sharpe_3y || 0);
    }
    /* Top-up sort for `centricity` mode: highest centricity_score (used after
       buckets are pre-narrowed to FOCUSED-only with a fall-back to all). */
    function sortFnTopUpScore(a, b) {
      return (b.centricity_score ?? 0) - (a.centricity_score ?? 0);
    }

    /* Backward-compat alias retained for any older call sites in the file. */
    const sortFn = sortFnParam;

    /* Step 10 — handle force-include first (deduct from buckets) */
    const forced = [];
    const forcedSchemes = new Set();
    _state.forceFunds.forEach(ff => {
      const f = _allFunds.find(x => x.scheme_code === ff.scheme_code);
      if (!f) return;
      forced.push(f);
      forcedSchemes.add(f.scheme_code);
    });

    /* v4 — mode-aware bucket selection.
       userNeeds:  single pass at 100% bucket weight using sortFnParam.
       screener:   pass A at paramShare × bucketTarget using sortFnParam,
                   pass B at topUpShare × bucketTarget using sortFnTopUpRanked
                   (pure ranking play, sector-agnostic).
       centricity: pass A at paramShare × bucketTarget using sortFnParam,
                   pass B at topUpShare × bucketTarget using sortFnTopUpScore
                   over a Focused-only candidate pool per bucket; if a bucket
                   has no Focused funds, falls back to best-by-score across
                   the full bucket (excluding UNRANKED). */
    const targetMax = Math.max(_state.instMin, _state.instMax);
    const targetMin = _state.instMin;
    const selected  = [];
    const catCount  = {};                  // SEBI category → count of funds selected
    const bucketShortfalls = [];           // {bucket, requested, achieved, pass}
    const mode      = _state.precisionMode || 'userNeeds';

    function pickPass(passBuckets, passSortFn, passShare, passLabel, overlapThreshold) {
      const ovTh = (overlapThreshold == null) ? 50 : overlapThreshold;
      Object.keys(passBuckets).forEach(b => {
        const fullTarget = targetMC[b] || 0;
        const shareTarget = fullTarget * passShare;
        if (shareTarget <= 0) return;
        const eligibles = passBuckets[b]
          .filter(f => !forcedSchemes.has(f.scheme_code))
          .slice()
          .sort(passSortFn);
        const nBucket = Math.max(1, Math.round(targetMax * (shareTarget / 100)));
        const pickedHere = [];
        const alternates = eligibles.slice();
        while (pickedHere.length < nBucket && alternates.length) {
          const cand = alternates.shift();
          if ((catCount[cand.category] || 0) >= 2) continue;     // 2-per-cat cap (cross-pass)
          /* Same-fund guard: never re-pick an already-selected fund (whichever
             pass picked it first). Overlap dedup uses the per-pass threshold —
             Pass A enforces the standard 50% rule; Pass B (top-up) loosens to
             80% so the ranking-led half can still pick high-quality funds that
             happen to share holdings with the parameter-led picks (per v4 spec
             §4.7 acceptance — modes must produce visibly different portfolios). */
          let skip = false;
          for (const exist of pickedHere.concat(selected)) {
            if (exist.scheme_code === cand.scheme_code) { skip = true; break; }
            if (computeOverlap(cand.scheme_code, exist.scheme_code) > ovTh) {
              skip = true; break;
            }
          }
          if (skip) continue;
          cand._bucket = b;
          cand._alternates = alternates.slice(0, 5);
          pickedHere.push(cand);
          catCount[cand.category] = (catCount[cand.category] || 0) + 1;
        }
        /* Equal-split share weight across actual picks. If a fund is added in
           pass B and pass A also picked it (won't happen with the same-fund
           guard above, but kept defensively), increment weight rather than
           push duplicate. */
        pickedHere.forEach(p => {
          const share = shareTarget / Math.max(1, pickedHere.length);
          const existing = selected.find(s => s.scheme_code === p.scheme_code);
          if (existing) {
            existing._weight = (existing._weight || 0) + share;
          } else {
            p._weight = share;
            selected.push(p);
          }
        });
        if (pickedHere.length < nBucket) {
          bucketShortfalls.push({ bucket: b, requested: nBucket, achieved: pickedHere.length, pass: passLabel });
        }
      });
    }

    /* Pass A — parameter-fit (always runs) — strict 50% overlap dedup */
    const mix = PB_MIX[mode] || { paramShare: 1.0, topUpShare: 0 };
    pickPass(buckets, sortFnParam, mix.paramShare || 1.0, 'param', 50);

    /* Pass B — top-up for screener / centricity modes only — loosened 80%
       overlap threshold so Pass B can pick visibly different funds that share
       holdings with Pass A's picks. */
    if (mode === 'screener' && mix.topUpShare > 0) {
      pickPass(buckets, sortFnTopUpRanked, mix.topUpShare, 'topup-rank', 80);
    } else if (mode === 'centricity' && mix.topUpShare > 0) {
      /* Narrow each bucket to FOCUSED tier for the top-up pass; fall back to
         the full bucket (excl. UNRANKED) when a bucket has no Focused funds. */
      const focusedBuckets = {};
      Object.keys(buckets).forEach(b => {
        const focusedHere = buckets[b].filter(f => f._tier === 'FOCUSED');
        focusedBuckets[b] = focusedHere.length
          ? focusedHere
          : buckets[b].filter(f => f._tier === 'RANKED');     // best-by-score, never UNRANKED
      });
      pickPass(focusedBuckets, sortFnTopUpScore, mix.topUpShare, 'topup-focused', 80);
    }

    /* Cross-pass top-up: if total < instMin and !optimiseFunds, top up from any
       bucket (still respecting 2-per-cat + overlap). Pulls from any tier. */
    if (selected.length < targetMin && !_state.optimiseFunds) {
      const allEligibles = universe
        .filter(f => !forcedSchemes.has(f.scheme_code))
        .filter(f => !selected.find(s => s.scheme_code === f.scheme_code))
        .sort(sortFnParam);
      for (const cand of allEligibles) {
        if (selected.length >= targetMin) break;
        if ((catCount[cand.category] || 0) >= 2) continue;
        let highOverlap = false;
        for (const exist of selected) {
          if (computeOverlap(cand.scheme_code, exist.scheme_code) > 50) {
            highOverlap = true; break;
          }
        }
        if (highOverlap) continue;
        const b = CATEGORY_MCAP_BUCKET[cand.category] || 'flexi';
        cand._bucket = b;
        cand._alternates = [];
        cand._weight = Math.max(2, 100 / (selected.length + 1));
        selected.push(cand);
        catCount[cand.category] = (catCount[cand.category] || 0) + 1;
      }
    }

    /* fundCountNote — info banner explaining shortfall vs requested range */
    if (selected.length < targetMin) {
      let cause = bucketShortfalls.length
        ? bucketShortfalls.map(s => MC_LABEL[s.bucket] + ' (' + s.achieved + '/' + s.requested + ')').join(', ')
        : 'limited eligible funds in your selected categories';
      out.fundCountNote = 'Engine selected ' + selected.length + ' funds — fewer than your minimum of ' + targetMin + '. ' +
                          (_state.optimiseFunds
                            ? 'Optimise to minimum is ON, so the engine stopped at the achievable count rather than padding from lower tiers. '
                            : 'Even with Optimise OFF the engine couldn\'t reach the minimum. ') +
                          'Bottleneck: ' + cause + '. Cap of 2 funds per SEBI category may also be a contributing factor.';
    } else if (selected.length > _state.instMax) {
      /* Should never trigger because we cap at instMax, but keep the safety log */
      out.fundCountNote = 'Engine selected ' + selected.length + ' funds — capped at your maximum of ' + _state.instMax + '.';
    }

    /* Convert shortfalls to user-visible warnings (older format) */
    bucketShortfalls.forEach(s => {
      out.warnings.push({
        type: 'warn',
        msg: 'Bucket "' + MC_LABEL[s.bucket] + '": targeted ' + s.requested +
             ' funds, achieved ' + s.achieved + ' (overlap dedup + 2-per-category cap).',
      });
    });

    /* Add forced funds with weight from their bucket's allocation */
    forced.forEach(f => {
      let b = CATEGORY_MCAP_BUCKET[f.category];
      if (!b) b = 'flexi';
      f._bucket = b;
      const _fIsNew = f.inception_date && (new Date(f.inception_date) > _oneYrAgo);
      f._tier = focusedSet.has(f.scheme_code)          ? 'FOCUSED'
              : f.centricity_score_status === 'Ranked' ? 'RANKED'
              : _fIsNew                                ? 'NEW_FUND'
              :                                         'UNRANKED';
      f._isForced = true;
      f._alternates = [];
      /* Forced funds get average weight in their bucket */
      const peers = selected.filter(s => s._bucket === b);
      if (peers.length) {
        const avg = peers.reduce((s, p) => s + p._weight, 0) / peers.length;
        f._weight = avg;
        /* Reduce peer weights proportionally */
        const totalBucket = (targetMC[b] || 0);
        const peerNew = (totalBucket - avg) / peers.length;
        peers.forEach(p => p._weight = Math.max(0, peerNew));
      } else {
        f._weight = (targetMC[b] || 5);
      }
      selected.push(f);
    });

    /* Step 12 — normalise weights, apply 20% per-fund cap, ensure sum 100 */
    let weights = selected.map(s => s._weight || 0);
    const cap = 20;
    /* Apply cap */
    let excess = 0;
    weights = weights.map(w => { if (w > cap) { excess += w - cap; return cap; } return w; });
    /* Distribute excess to under-cap funds proportional to current weight */
    const underCapIdx = weights.map((w, i) => w < cap ? i : -1).filter(i => i >= 0);
    if (excess > 0 && underCapIdx.length) {
      const sumUnder = underCapIdx.reduce((s, i) => s + weights[i], 0) || 1;
      underCapIdx.forEach(i => { weights[i] += excess * (weights[i] / sumUnder); });
    }
    /* Round to 2% steps */
    weights = weights.map(w => Math.max(0, Math.round(w / 2) * 2));
    /* Normalise to 100 */
    let sumW = weights.reduce((s, w) => s + w, 0);
    if (sumW === 0) {
      const each = 100 / Math.max(1, selected.length);
      weights = selected.map(() => each);
    } else if (sumW !== 100) {
      const diff = 100 - sumW;
      /* Add diff to highest-weight fund */
      const maxIdx = weights.indexOf(Math.max(...weights));
      weights[maxIdx] += diff;
    }
    selected.forEach((s, i) => { s._weight = weights[i]; });

    /* Build output funds list */
    out.funds = selected.map(s => ({
      scheme_code: s.scheme_code,
      fund_name: s.fund_name,
      amc: s.amc,
      category: s.category,
      sub_category_class: s.sub_category_class,
      benchmark: s.benchmark,
      centricity_score: s.centricity_score,
      centricity_rank_overall: s.centricity_rank_overall,
      centricity_score_status: s.centricity_score_status,
      manager_name: s.manager_name,
      manager_tenure_yrs: s.manager_tenure_yrs,
      monitor_returns: s.monitor_returns,
      benchmark_monitor_returns: s.benchmark_monitor_returns,
      monitor_ter_pct: s.monitor_ter_pct,
      ter_pct: s.ter_pct,
      aum_cr: s.aum_cr,
      mcap_split: s.mcap_split,
      risk_metrics: s.risk_metrics,
      _tier: s._tier,
      _bucket: s._bucket,
      _isForced: !!s._isForced,
      _alternates: (s._alternates || []).slice(0, 5),
      _weight: s._weight,
    }));

    /* AMC concentration warning */
    const amcMap = {};
    out.funds.forEach(f => {
      amcMap[f.amc] = (amcMap[f.amc] || 0) + (f._weight || 0);
    });
    Object.keys(amcMap).forEach(amc => {
      if (amcMap[amc] > 35) {
        out.warnings.push({
          type: 'warn',
          msg: amc + ' holds ' + amcMap[amc].toFixed(0) + '% of the portfolio (>35%) — concentration risk.',
        });
      }
    });

    /* v4 — deviation-breach detection per mode tolerance budget. */
    out.mode = mode;
    out.modeMix = mix;
    out.tolerance = PB_DEVIATION_TOLERANCE[mode] || PB_DEVIATION_TOLERANCE.userNeeds;
    const actualMC = { large: 0, mid: 0, small: 0, flexi: 0 };
    out.funds.forEach(f => { actualMC[f._bucket || 'flexi'] += f._weight; });
    let mcapMaxDev = 0;
    ['large', 'mid', 'small', 'flexi'].forEach(b => {
      const dev = Math.abs((targetMC[b] || 0) - (actualMC[b] || 0));
      if (dev > mcapMaxDev) mcapMaxDev = dev;
    });
    let sectorMaxDev = 0;
    if (Object.keys(sectorTargets).length && _analytics) {
      const totalW = out.funds.reduce((s, f) => s + f._weight, 0) || 1;
      const actualSec = {};
      out.funds.forEach(f => {
        const aFund = _analytics.funds[String(f.scheme_code)];
        if (!aFund) return;
        (aFund.sector_allocation || []).forEach(s => {
          actualSec[s.sector] = (actualSec[s.sector] || 0) + (f._weight / totalW) * s.holding_pct;
        });
      });
      Object.keys(sectorTargets).forEach(sec => {
        const dev = Math.abs((sectorTargets[sec] || 0) - (actualSec[sec] || 0));
        if (dev > sectorMaxDev) sectorMaxDev = dev;
      });
    }
    out.deviationActual = { mcap: mcapMaxDev, sector: sectorMaxDev };
    const tol = out.tolerance;
    const breach = (mcapMaxDev > tol.mcap) || (sectorMaxDev > tol.sector);
    out.deviationBreach = breach;
    if (breach && mode === 'userNeeds') {
      out.deviationBreachMessage =
        '⚠ Your selected parameters cannot be matched within acceptable deviation from the available universe ' +
        '(M-cap deviation ' + mcapMaxDev.toFixed(1) + '%, sector deviation ' + sectorMaxDev.toFixed(1) + '%; ' +
        'budget ±' + tol.mcap + '% / ±' + tol.sector + '%). ' +
        'Consider rebalancing: relax sector targets, broaden the M-cap mix, or switch to ' +
        'Screener Ranking Focused / Centricity Model Focused mode.';
    } else if (breach) {
      out.deviationBreachMessage =
        '⚠ Achieved m-cap deviation ' + mcapMaxDev.toFixed(1) + '% / sector deviation ' + sectorMaxDev.toFixed(1) +
        '% exceeds this mode\'s tolerance budget (±' + tol.mcap + '% / ±' + tol.sector + '%). The portfolio is best-effort; review the Plan tab for the per-dimension deviations.';
    }

    return out;
  }

  function computeOverlap(scA, scB) {
    if (!_holdingsFull || !_holdingsFull.funds) return 0;
    const hA = _holdingsFull.funds[String(scA)];
    const hB = _holdingsFull.funds[String(scB)];
    if (!hA || !hB) return 0;
    const mapA = {};
    hA.forEach(h => { mapA[h.company] = (mapA[h.company] || 0) + h.holding_pct; });
    let overlap = 0;
    hB.forEach(h => {
      if (mapA[h.company] != null) overlap += Math.min(mapA[h.company], h.holding_pct);
    });
    return overlap;
  }

  /* ============================================================
     OUTPUT RENDER
     ============================================================ */
  function initOutputUI() {
    document.querySelectorAll('.pb-tab').forEach(t => t.addEventListener('click', () => {
      const which = t.dataset.tab;
      _activeTab = which;
      document.querySelectorAll('.pb-tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.pb-tab-pane').forEach(p => p.hidden = (p.dataset.tabPane !== which));
      renderActiveTab();
    }));
    document.getElementById('totalInvAmount').addEventListener('input', (e) => {
      _state.totalAmount = +e.target.value || 0;
      updateAmountWords();
      renderActiveTab();
    });
    /* Initial render of the words line */
    updateAmountWords();
    document.getElementById('regenBtn').addEventListener('click', () => generatePortfolio());
    document.getElementById('shareBtn').addEventListener('click', () => copyShareLink());
    document.querySelectorAll('#navWindowToggles .window-btn').forEach(b => b.addEventListener('click', () => {
      _navWindow = b.dataset.window;
      document.querySelectorAll('#navWindowToggles .window-btn').forEach(x => x.classList.toggle('active', x === b));
      renderReturnsTab();
    }));
  }

  function renderOutput() {
    if (!_portfolio || !_portfolio.funds.length) return;
    document.getElementById('pbOutEmpty').hidden = true;
    document.getElementById('pbOutSummary').hidden = false;
    document.getElementById('pbTabs').hidden = false;
    document.querySelectorAll('.pb-tab-pane').forEach(p => p.hidden = (p.dataset.tabPane !== _activeTab));
    /* Summary header */
    const fundsCount = _portfolio.funds.length;
    const cats = new Set(_portfolio.funds.map(f => f.category));
    const amcs = new Set(_portfolio.funds.map(f => f.amc));
    const blendScore = weightedAvg(_portfolio.funds, f => f.centricity_score, f => f._weight);
    document.getElementById('sumFundCount').textContent  = fundsCount;
    document.getElementById('sumCatCount').textContent   = cats.size;
    document.getElementById('sumBlendScore').textContent = (blendScore != null) ? (blendScore * 100).toFixed(1) : '—';
    document.getElementById('sumAmcCount').textContent   = amcs.size;
    document.getElementById('sumCycle').textContent      = _cycle.cycle_meta.cycle_label_date || _cycle.cycle_meta.cycle_date;
    renderActiveTab();
  }

  function renderActiveTab() {
    if (!_portfolio) return;
    if (_activeTab === 'overview')   renderOverviewTab();
    else if (_activeTab === 'returns') renderReturnsTab();
    else if (_activeTab === 'analytics') renderAnalyticsTab();
    else if (_activeTab === 'plan')      renderPlanTab();
    else if (_activeTab === 'funds')     renderFundsTab();
  }

  /* -- OVERVIEW -- */
  function renderOverviewTab() {
    const f = _portfolio.funds;
    const blendScore = weightedAvg(f, x => x.centricity_score, x => x._weight);
    const ter = weightedAvg(f, x => (x.monitor_ter_pct || x.ter_pct), x => x._weight);
    const tenure = weightedAvg(f, x => x.manager_tenure_yrs, x => x._weight);
    const aum = weightedAvg(f, x => x.aum_cr, x => x._weight);
    const kpis = [
      ['Blended Score', (blendScore != null ? (blendScore * 100).toFixed(1) + '%' : '—'), 'Excel-locked Centricity score, weighted by allocation'],
      ['Weighted Avg TER', (ter != null ? ter.toFixed(2) + '%' : '—'), 'Regular-plan TER from MF Monitor'],
      ['Weighted Mgr Tenure', (tenure != null ? tenure.toFixed(1) + ' yrs' : '—'), 'On the resolved current main manager'],
    ];
    document.getElementById('overviewKpiRow').innerHTML = kpis.map(k =>
      '<div class="pb-kpi"><div class="lbl">' + escapeHtml(k[0]) + '</div>' +
      '<div class="v">' + k[1] + '</div>' +
      '<div class="sub">' + escapeHtml(k[2]) + '</div></div>'
    ).join('');
    /* Donuts */
    drawDonut('acDonut', getAssetClassMix(), 'acLegend');
    drawDonut('mcDonut', getMcapMix(), 'mcLegend');
    /* Funds table */
    renderFundsTable();
    /* Warnings */
    renderWarnings();
  }

  function renderFundsTable() {
    const wrap = document.getElementById('pbFundsTblWrap');
    const totalAmt = _state.totalAmount;

    /* Apply current sort if set (defensive copy — engine order otherwise) */
    let funds = _portfolio.funds.slice();
    if (_sortCol) {
      funds.sort((a, b) => {
        let av, bv;
        switch (_sortCol) {
          case 'role':     av = getFundRole(a);             bv = getFundRole(b); break;
          case 'fund':     av = (a.fund_name || '').toLowerCase(); bv = (b.fund_name || '').toLowerCase(); break;
          case 'category': av = (a.category  || '').toLowerCase(); bv = (b.category  || '').toLowerCase(); break;
          case 'mcap':     av = MC_LABEL[a._bucket] || ''; bv = MC_LABEL[b._bucket] || ''; break;
          case 'alloc':    av = a._weight || 0;            bv = b._weight || 0;            break;
          case 'amount':   av = a._weight || 0;            bv = b._weight || 0;            break;
          default:         return 0;
        }
        if (av < bv) return -1 * _sortDir;
        if (av > bv) return  1 * _sortDir;
        return 0;
      });
    }
    /* Map back to original index for editAllocation/swap/remove (those operate on _portfolio.funds[i]) */
    const indexedFunds = funds.map(f => ({ f, origIdx: _portfolio.funds.indexOf(f) }));

    const totalW = _portfolio.funds.reduce((s, f) => s + (f._weight || 0), 0);
    const rows = indexedFunds.map(({ f, origIdx }) => {
      const rs = (f._weight || 0) * totalAmt / 100;
      const role = getFundRole(f);
      return '<tr data-i="' + origIdx + '">' +
             '<td><span class="role-pill">' + escapeHtml(role) + '</span></td>' +
             '<td class="col-nm"><a class="fund-link" href="fund-detail.html?scheme=' + f.scheme_code + '" target="_blank" rel="noopener">' +
               escapeHtml(f.fund_name) + '</a><div class="fund-meta">' + escapeHtml(f.amc) + '</div></td>' +
             '<td>' + escapeHtml(f.category) + '</td>' +
             '<td>' + escapeHtml(MC_LABEL[f._bucket] || '—') + '</td>' +
             '<td><input type="number" class="alloc-edit" min="0" max="100" step="2" value="' + (f._weight || 0).toFixed(0) + '" data-i="' + origIdx + '"></td>' +
             '<td>' + formatINR(rs) + '</td>' +
             '<td><button class="pb-act-btn swap" data-i="' + origIdx + '" title="Swap">⇄</button>' +
                 '<button class="pb-act-btn rm"   data-i="' + origIdx + '" title="Remove">✕</button></td>' +
             '</tr>';
    }).join('');

    function arrow(col) {
      if (_sortCol !== col) return '<span class="arr">▲▼</span>';
      return '<span class="arr">' + (_sortDir > 0 ? '▲' : '▼') + '</span>';
    }
    function thCls(col) { return _sortCol === col ? 'sorted' : ''; }
    const totSumCls = (Math.round(totalW) === 100) ? 'ok' : 'bad';
    wrap.innerHTML =
      '<table class="pb-tbl"><thead><tr>' +
      '<th data-sort="role"     class="' + thCls('role')     + '">Role '       + arrow('role')     + '</th>' +
      '<th data-sort="fund"     class="' + thCls('fund')     + '">Fund '       + arrow('fund')     + '</th>' +
      '<th data-sort="category" class="' + thCls('category') + '">Category '   + arrow('category') + '</th>' +
      '<th data-sort="mcap"     class="' + thCls('mcap')     + '">M-Cap '      + arrow('mcap')     + '</th>' +
      '<th data-sort="alloc"    class="' + thCls('alloc')    + '">Allocation % ' + arrow('alloc')  + '</th>' +
      '<th data-sort="amount"   class="' + thCls('amount')   + '">₹ Amount '   + arrow('amount')   + '</th>' +
      '<th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr><td colspan="4" class="col-nm">Total</td>' +
      '<td class="' + totSumCls + '">' + totalW.toFixed(0) + '%</td>' +
      '<td>' + formatINR(totalAmt) + '</td><td></td></tr></tfoot></table>';

    /* Allocation note below table when total != 100 */
    const noteEl = document.getElementById('pbAllocNote');
    if (Math.round(totalW) !== 100) {
      document.getElementById('pbAllocNoteVal').textContent = totalW.toFixed(0);
      noteEl.hidden = false;
    } else {
      noteEl.hidden = true;
    }

    /* Sort header clicks */
    wrap.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (_sortCol === col) { _sortDir = -_sortDir; }
      else { _sortCol = col; _sortDir = 1; }
      renderFundsTable();
    }));
    /* Wire allocation editing — clamp negatives, round 2% step on blur */
    wrap.querySelectorAll('input.alloc-edit').forEach(inp => {
      inp.addEventListener('change', () => {
        const i = +inp.dataset.i;
        let newW = +inp.value || 0;
        if (newW < 0) newW = 0;
        newW = Math.min(100, newW);
        editAllocation(i, newW);
      });
    });
    /* Wire swap */
    wrap.querySelectorAll('.pb-act-btn.swap').forEach(b => b.addEventListener('click', (e) => openSwapPopover(+b.dataset.i, b)));
    /* Wire remove */
    wrap.querySelectorAll('.pb-act-btn.rm').forEach(b => b.addEventListener('click', () => removeFund(+b.dataset.i)));
  }

  function renderWarnings() {
    const wrap = document.getElementById('pbWarnings');
    const hasAny = !!(_portfolio.warnings.length || _portfolio.comingSoonNote || _portfolio.fundCountNote);
    if (!hasAny) { wrap.innerHTML = ''; return; }
    let html = '';
    if (_portfolio.fundCountNote) {
      html += '<div class="pb-warn-row info"><span class="ic">🔵</span><span>' +
              escapeHtml(_portfolio.fundCountNote) + '</span></div>';
    }
    if (_portfolio.comingSoonNote) {
      html += '<div class="pb-warn-row warn"><span class="ic">🟡</span><span>Debt, Commodities, REITs/InvITs, AIF, PMS and Direct Equity are not live yet — the entire allocation goes to Equity / Hybrid MF for now. The deviation report shows what was redistributed.</span></div>';
    }
    _portfolio.warnings.forEach(w => {
      const ic = w.type === 'err' ? '🔴' : '🟡';
      html += '<div class="pb-warn-row ' + w.type + '"><span class="ic">' + ic + '</span><span>' + escapeHtml(w.msg) + '</span></div>';
    });
    wrap.innerHTML = html;
  }

  function editAllocation(idx, newW) {
    const oldW = _portfolio.funds[idx]._weight || 0;
    const diff = newW - oldW;
    _portfolio.funds[idx]._weight = newW;
    /* Redistribute -diff across other funds proportional to current weight */
    const others = _portfolio.funds.filter((_, i) => i !== idx);
    const sumOthers = others.reduce((s, f) => s + (f._weight || 0), 0);
    if (sumOthers > 0) {
      others.forEach(f => { f._weight = Math.max(0, (f._weight || 0) - diff * ((f._weight || 0) / sumOthers)); });
    }
    /* Round all weights to 2% steps + normalise to 100 so displayed inputs sum correctly */
    let ws = _portfolio.funds.map(f => Math.max(0, Math.round((f._weight || 0) / 2) * 2));
    const wsSum = ws.reduce((s, w) => s + w, 0);
    if (wsSum !== 100 && wsSum > 0) { const mi = ws.indexOf(Math.max(...ws)); ws[mi] += 100 - wsSum; }
    _portfolio.funds.forEach((f, i) => { f._weight = ws[i]; });
    /* Re-render */
    renderActiveTab();
  }

  function removeFund(idx) {
    const removed = _portfolio.funds.splice(idx, 1)[0];
    if (!removed) return;
    /* Redistribute removed weight proportionally */
    const remaining = _portfolio.funds;
    const sum = remaining.reduce((s, f) => s + (f._weight || 0), 0);
    if (sum > 0 && removed._weight > 0) {
      remaining.forEach(f => { f._weight += removed._weight * ((f._weight || 0) / sum); });
    } else if (remaining.length) {
      const each = (removed._weight || 0) / remaining.length;
      remaining.forEach(f => { f._weight += each; });
    }
    renderOutput();
  }

  function openSwapPopover(idx, anchorBtn) {
    document.querySelectorAll('.swap-popover').forEach(p => p.remove());
    const f = _portfolio.funds[idx];
    if (!f) return;

    /* Re-derive candidates: same bucket, ranked by tier+score, exclude already-in-portfolio */
    const inSet = new Set(_portfolio.funds.map(x => x.scheme_code));
    const TIER_RANK = { FOCUSED: 0, RANKED: 1, UNRANKED: 2, NEW_FUND: 3 };
    const candidates = _allFunds.filter(x => {
      if (inSet.has(x.scheme_code)) return false;
      if (CATEGORY_MCAP_BUCKET[x.category] !== f._bucket) return false;
      /* Same product family (Equity / Hybrid) */
      if (x.sub_category_class !== f.sub_category_class) return false;
      return true;
    }).map(x => Object.assign({}, x, {
      _tier: (_focusedSchemes.includes(x.scheme_code))      ? 'FOCUSED'
           : (x.centricity_score_status === 'Ranked')        ? 'RANKED'
           : (x.inception_date && new Date(x.inception_date) > _oneYrAgo) ? 'NEW_FUND'
           :                                                    'UNRANKED',
    }));
    candidates.sort((a, b) => {
      const ta = TIER_RANK[a._tier], tb = TIER_RANK[b._tier];
      if (ta !== tb) return ta - tb;
      return ((b.centricity_score || 0) - (a.centricity_score || 0));
    });

    const top = candidates.slice(0, 5);
    const pop = document.createElement('div');
    pop.className = 'swap-popover';
    pop.innerHTML = '<div class="swap-h">Swap with — top alternates in ' + escapeHtml(MC_LABEL[f._bucket] || '') + '</div>' +
      (top.length ? top.map(c => {
        const ov = computeOverlap(c.scheme_code, f.scheme_code);
        return '<div class="swap-row" data-sc="' + c.scheme_code + '">' +
               '<div><div class="nm">' + escapeHtml(c.fund_name) + '</div>' +
               '<div class="meta">' + escapeHtml(c.category) + ' · ' + escapeHtml(c._tier) + '</div></div>' +
               '<div class="scr">' + DataLoader.fmtScorePct(c.centricity_score) + '</div>' +
               '<div class="ovl">' + ov.toFixed(0) + '% ovl</div></div>';
      }).join('') : '<div class="swap-empty">No alternates in this bucket.</div>');

    document.body.appendChild(pop);
    const r = anchorBtn.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left - 320) + 'px';
    pop.style.top  = (r.bottom + 6 + window.scrollY) + 'px';

    pop.querySelectorAll('.swap-row').forEach(row => row.addEventListener('click', () => {
      const sc = +row.dataset.sc;
      const cand = _allFunds.find(x => x.scheme_code === sc);
      if (!cand) return;
      const w = _portfolio.funds[idx]._weight;
      const replaced = Object.assign({}, cand, {
        _tier: (_focusedSchemes.includes(cand.scheme_code))         ? 'FOCUSED'
             : (cand.centricity_score_status === 'Ranked')           ? 'RANKED'
             : (cand.inception_date && new Date(cand.inception_date) > _oneYrAgo) ? 'NEW_FUND'
             :                                                          'UNRANKED',
        _bucket: f._bucket, _weight: w, _alternates: [],
      });
      _portfolio.funds[idx] = replaced;
      pop.remove();
      renderOutput();
    }));
    /* Click-outside to close */
    setTimeout(() => {
      document.addEventListener('click', function close(e) {
        if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('click', close); }
      });
    }, 50);
  }

  /* -- RETURNS -- */
  function renderReturnsTab() {
    /* Returns summary table — weighted blended */
    const f = _portfolio.funds;
    function w(period) {
      return weightedAvg(f, x => x.monitor_returns?.[period], x => x._weight);
    }
    function wb(period) {
      return weightedAvg(f, x => x.benchmark_monitor_returns?.[period], x => x._weight);
    }
    const periods = [['return_1y_pct', '1Y'], ['return_3y_pct', '3Y'], ['return_5y_pct', '5Y']];
    let html = '<thead><tr><th></th>' + periods.map(p => '<th>' + p[1] + '</th>').join('') + '</tr></thead><tbody>';
    const tr = (lbl, vals, cls) => '<tr class="' + (cls || '') + '"><td>' + lbl + '</td>' +
      vals.map(v => v == null ? '<td>—</td>' : '<td class="' + (v < 0 ? 'neg' : 'pos') + '">' + (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%</td>').join('') + '</tr>';
    const fundVals = periods.map(p => w(p[0]));
    const benchVals = periods.map(p => wb(p[0]));
    const excessVals = fundVals.map((v, i) => (v != null && benchVals[i] != null) ? v - benchVals[i] : null);
    html += tr('Portfolio (blended)', fundVals);
    html += tr('Blended Benchmark', benchVals);
    html += tr('Excess Return', excessVals, 'row-excess');
    html += '</tbody>';
    document.getElementById('rtnsSummaryTbl').innerHTML = html;

    /* Growth chart */
    drawNavChart();
  }

  async function drawNavChart() {
    if (!_navSeries) {
      try {
        const r = await fetch('data/nav-series-2026-04-15.json');
        _navSeries = r.ok ? await r.json() : { series: {} };
      } catch (e) { _navSeries = { series: {} }; }
    }
    if (!_navSeries.series) { return; }
    const cap = document.getElementById('navChartCap');
    const canvas = document.getElementById('navChart');
    const ctx = canvas.getContext('2d');
    /* Destroy + clear before re-creating — fixes height-creep on re-render */
    if (_chartInstances.nav) { _chartInstances.nav.destroy(); delete _chartInstances.nav; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    /* Build per-fund series maps */
    const fundSeries = _portfolio.funds.map(f => {
      const s = _navSeries.series[String(f.scheme_code)];
      if (!s || !s.fund || !s.fund.length) return null;
      return { f, s };
    }).filter(Boolean);

    if (!fundSeries.length) {
      cap.textContent = 'NAV series unavailable for the selected funds.';
      if (_chartInstances.nav) { _chartInstances.nav.destroy(); delete _chartInstances.nav; }
      return;
    }

    /* Find latest common start month and earliest common end month */
    const starts = fundSeries.map(x => x.s.fund[0].d);
    const ends   = fundSeries.map(x => x.s.fund[x.s.fund.length - 1].d);
    let startYM = starts.reduce((a, b) => a > b ? a : b);
    const endYM   = ends.reduce((a, b)   => a < b ? a : b);

    /* Apply nav window */
    if (_navWindow !== 'max') {
      const yrs = _navWindow === '1y' ? 1 : 3;
      const want = shiftYM(endYM, -12 * yrs);
      if (want > startYM) startYM = want;
    }

    /* Disable buttons that exceed history */
    document.querySelectorAll('#navWindowToggles .window-btn').forEach(b => {
      const wnd = b.dataset.window;
      if (wnd === 'max') { b.disabled = false; return; }
      const yrs = wnd === '1y' ? 1 : 3;
      const want = shiftYM(endYM, -12 * yrs);
      b.disabled = (want < starts.reduce((a, b) => a > b ? a : b));
    });

    const labels = enumerateMonths(startYM, endYM);
    /* Build per-fund normalised arrays */
    const fundNormSeries = fundSeries.map(x => {
      const map = mapByDate(x.s.fund);
      const benchMap = mapByDate(x.s.bench);
      const startNAV = map[startYM] || x.s.fund[0].v;
      const startBench = benchMap[startYM] || (x.s.bench[0] && x.s.bench[0].v) || null;
      const norm = labels.map(l => {
        if (map[l] != null && startNAV) return (map[l] / startNAV);
        return null;
      });
      const benchNorm = labels.map(l => {
        if (benchMap[l] != null && startBench) return (benchMap[l] / startBench);
        return null;
      });
      return { f: x.f, norm, benchNorm };
    });

    /* Blend portfolio: at each t, sum (weight_i × norm_i[t]) when defined */
    const portfolioVals = labels.map((_, t) => {
      let totalW = 0, sumW = 0;
      fundNormSeries.forEach(fn => {
        const w = fn.f._weight || 0;
        if (fn.norm[t] != null && w > 0) { totalW += w; sumW += fn.norm[t] * w; }
      });
      return totalW > 0 ? (sumW / totalW) * 100000 : null;
    });
    const benchVals = labels.map((_, t) => {
      let totalW = 0, sumW = 0;
      fundNormSeries.forEach(fn => {
        const w = fn.f._weight || 0;
        if (fn.benchNorm[t] != null && w > 0) { totalW += w; sumW += fn.benchNorm[t] * w; }
      });
      return totalW > 0 ? (sumW / totalW) * 100000 : null;
    });

    const lastP = lastNonNull(portfolioVals);
    const lastB = lastNonNull(benchVals);
    cap.innerHTML = '₹1,00,000 invested on <b>' + formatYM(startYM) + '</b> → Portfolio: <b>₹' +
                    DataLoader.fmtINR(lastP) + '</b> · Blended Benchmark: <b>₹' +
                    DataLoader.fmtINR(lastB) + '</b> · ' + labels.length + ' months tracked.';

    _chartInstances.nav = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Portfolio', data: portfolioVals, borderColor: '#BD9568', backgroundColor: 'rgba(189,149,104,.08)',
          borderWidth: 3, pointRadius: 0, tension: 0.18 },
        { label: 'Blended Benchmark', data: benchVals, borderColor: '#5B8DB8', backgroundColor: 'transparent',
          borderWidth: 1.5, pointRadius: 0, tension: 0.18 },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { font: { family: 'Cambria', size: 12 } } },
          tooltip: {
            mode: 'index', intersect: false,
            backgroundColor: 'rgba(255, 255, 255, 0.96)',
            borderColor: 'rgba(189, 149, 104, 0.4)', borderWidth: 1,
            titleColor: '#000', bodyColor: '#333',
            titleFont: { family: 'Cambria', size: 12, weight: 'bold' },
            bodyFont:  { family: 'Cambria', size: 12 },
            padding: 10,
            callbacks: {
              title: function (items) {
                return (items && items[0]) ? formatYMShort(items[0].label) : '';
              },
              label: function (ctx) {
                const v = ctx.parsed.y;
                if (v == null) return null;
                return ctx.dataset.label + ': ₹' + DataLoader.fmtINR(Math.round(v));
              },
            },
          },
        },
        scales: {
          x: { ticks: { maxRotation: 0, font: { family: 'Cambria', size: 10 },
              callback: function (v, i) {
                const lab = labels[i]; const isFinal = i === labels.length - 1;
                if (!lab) return '';
                const m = lab.split('-')[1];
                if (isFinal || m === '01' || (labels.length > 36 && (m === '04' || m === '07' || m === '10'))) {
                  return formatYMShort(lab);
                }
                return '';
              }}},
          y: { ticks: { font: { family: 'Cambria', size: 11 },
                        callback: v => '₹' + DataLoader.fmtINR(v) } }
        }
      }
    });
  }

  /* -- ANALYTICS -- */
  function renderAnalyticsTab() {
    drawDonut('anlyAcDonut', getAssetClassMix(), 'anlyAcLegend');
    drawDonut('anlyMcDonut', getMcapMix(), 'anlyMcLegend');
    /* Sectors */
    const sectorMix = getSectorMix();
    const top10 = sectorMix.slice(0, 10);
    document.getElementById('anlySectors').innerHTML = top10.map((s, i) =>
      '<div class="sector-row"><span class="rk">' + (i + 1) + '</span>' +
      '<span class="nm">' + escapeHtml(s.name) + '</span>' +
      '<span class="pct">' + s.pct.toFixed(2) + '%</span></div>'
    ).join('') || '<div class="pb-cs-empty">Sector data unavailable for selected funds.</div>';
    /* Stocks */
    const stockMix = getStockMix();
    const top10s = stockMix.slice(0, 10);
    document.getElementById('anlyStocks').innerHTML = top10s.map((s, i) => {
      const warn = s.pct > 8 ? ' warn' : '';
      return '<div class="stock-row' + warn + '"><span class="rk">' + (i + 1) + '</span>' +
             '<span class="nm">' + escapeHtml(s.name) + '</span>' +
             '<span class="sct">' + escapeHtml(s.sector || '') + '</span>' +
             '<span class="pct">' + s.pct.toFixed(2) + '%</span></div>';
    }).join('') || '<div class="pb-cs-empty">Stock-level data unavailable.</div>';
    /* AMCs — bar width scaled relative to the largest AMC's pct so the visual
       fill is always meaningful. The .pct label still shows the actual
       allocation %; only the bar width is rescaled. (PB v3 §5.) */
    const amcMix = getAmcMix();
    const maxAmcPct = amcMix.length ? Math.max(...amcMix.map(a => a.pct)) : 1;
    document.getElementById('anlyAmcs').innerHTML = amcMix.map(a => {
      const warn = a.pct > 35 ? ' warn' : '';
      const barW = ((a.pct / maxAmcPct) * 100).toFixed(1);
      return '<div class="amc-row' + warn + '"><span class="nm">' + escapeHtml(a.name) + '</span>' +
             '<span class="bar-wrap"><span class="bar" style="width:' + barW + '%"></span></span>' +
             '<span class="pct">' + a.pct.toFixed(1) + '%</span></div>';
    }).join('');
    /* Unique-counts summary line below sector list */
    const secCntEl = document.getElementById('anlySecCount');
    const stkCntEl = document.getElementById('anlyStockCount');
    if (secCntEl) secCntEl.textContent = sectorMix.length;
    if (stkCntEl) stkCntEl.textContent = stockMix.length;
  }

  /* -- PLAN VS PORTFOLIO -- */
  function renderPlanTab() {
    const dev = _portfolio.deviation || {};
    const f = _portfolio.funds;

    /* Compute actual mix */
    const actualMC = { large: 0, mid: 0, small: 0, flexi: 0 };
    f.forEach(x => { actualMC[x._bucket || 'flexi'] += x._weight; });
    const actualEqHy = f.reduce((s, x) => s + x._weight, 0);  /* always 100 since live = equity+hybrid */

    const targetMC = dev.targetMC || {};
    const targetAC = dev.targetAC || {};

    let rows = [];
    /* Cell class for the Δ column. Status icons removed per PB v2 §2G —
       colour on the Δ cell now communicates magnitude. */
    const deltaClass = (delta) => {
      const ad = Math.abs(delta || 0);
      if (ad <= 5) return '';
      if (ad <= 15) return 'warn';
      return 'bad';
    };

    /* AC rows */
    [['Equity + Hybrid (live)', 100, actualEqHy], ['Debt', targetAC.debt || 0, 0], ['Commodities', targetAC.commodities || 0, 0], ['REITs / InvITs', targetAC.reits || 0, 0]]
      .forEach(([lbl, t, a]) => {
        const d = a - t;
        const cls = (lbl === 'Equity + Hybrid (live)' || t === 0) ? '' : deltaClass(d);
        rows.push('<tr><td>' + escapeHtml(lbl) + '</td>' +
                  '<td>' + (t || 0).toFixed(0) + '%</td>' +
                  '<td>' + (a || 0).toFixed(0) + '%</td>' +
                  '<td' + (cls ? ' class="' + cls + '"' : '') + '>' +
                  (d > 0 ? '+' : '') + d.toFixed(0) + '%</td></tr>');
      });

    /* Instrument count — target shown as Min–Max range */
    const actualN = f.length;
    const inRange = (actualN >= _state.instMin && actualN <= _state.instMax);
    const dN = inRange ? 0 : (actualN < _state.instMin ? actualN - _state.instMin : actualN - _state.instMax);
    const cN = inRange ? '' : (Math.abs(dN) <= 2 ? 'warn' : 'bad');
    rows.push('<tr><td>Number of instruments</td>' +
              '<td>' + _state.instMin + '–' + _state.instMax + '</td>' +
              '<td>' + actualN + '</td>' +
              '<td' + (cN ? ' class="' + cN + '"' : '') + '>' +
              (inRange ? '✓ in range' : (dN > 0 ? '+' : '') + dN) + '</td></tr>');

    /* M-Cap rows */
    ['large', 'mid', 'small', 'flexi'].forEach(b => {
      const t = targetMC[b] || 0;
      const a = actualMC[b] || 0;
      const d = a - t;
      const cls = deltaClass(d);
      rows.push('<tr><td>' + MC_LABEL[b] + '</td>' +
                '<td>' + t.toFixed(0) + '%</td>' +
                '<td>' + a.toFixed(0) + '%</td>' +
                '<td' + (cls ? ' class="' + cls + '"' : '') + '>' +
                (d > 0 ? '+' : '') + d.toFixed(0) + '%</td></tr>');
    });

    /* Sector rows — manual_full or manual_partial active typed targets only */
    let activeSecTargets = {};
    if (_state.sectorMode === 'manual_full') {
      activeSecTargets = _state.sectorTargets;
    } else if (_state.sectorMode === 'manual_partial') {
      Object.keys(_state.sectorTargets).forEach(s => {
        if (!_state.sectorAutoFlags[s]) activeSecTargets[s] = _state.sectorTargets[s];
      });
    }
    if (Object.keys(activeSecTargets).length) {
      const actualSec = {};
      const totalW = f.reduce((s, x) => s + x._weight, 0) || 1;
      f.forEach(x => {
        const aFund = (_analytics && _analytics.funds[String(x.scheme_code)]);
        if (!aFund) return;
        (aFund.sector_allocation || []).forEach(s => {
          actualSec[s.sector] = (actualSec[s.sector] || 0) + (x._weight / totalW) * s.holding_pct;
        });
      });
      Object.keys(activeSecTargets).forEach(sec => {
        const t = activeSecTargets[sec];
        const a = actualSec[sec] || 0;
        const d = a - t;
        const cls = deltaClass(d);
        rows.push('<tr><td>' + escapeHtml(sec) + '</td>' +
                  '<td>' + t.toFixed(0) + '%</td>' +
                  '<td>' + a.toFixed(1) + '%</td>' +
                  '<td' + (cls ? ' class="' + cls + '"' : '') + '>' +
                  (d > 0 ? '+' : '') + d.toFixed(1) + '%</td></tr>');
      });
    }

    document.getElementById('planTbl').innerHTML =
      '<thead><tr><th>Metric</th><th>Target</th><th>Actual</th><th>Δ</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody>';

    /* Flags */
    const flags = [];
    if (_portfolio.comingSoonNote) {
      flags.push('Debt MF, Bonds, AIF, PMS, Direct Equity, Commodities, and REITs/InvITs are not yet available. Your portfolio is built entirely from Equity and Hybrid MF. Non-equity allocation has been redistributed proportionally to Equity.');
    }
    const actualN2 = f.length;
    if (actualN2 < _state.instMin || actualN2 > _state.instMax) {
      flags.push('Engine selected ' + actualN2 + ' funds (target range ' + _state.instMin + '–' + _state.instMax + '). Difference reflects bucket rounding and overlap dedup constraints.');
    }
    if (Object.keys(activeSecTargets).length) {
      const totalW3 = f.reduce((s, x) => s + x._weight, 0) || 1;
      const actualSec3 = {};
      f.forEach(x => {
        const aFund = (_analytics && _analytics.funds[String(x.scheme_code)]);
        if (!aFund) return;
        (aFund.sector_allocation || []).forEach(s => {
          actualSec3[s.sector] = (actualSec3[s.sector] || 0) + (x._weight / totalW3) * s.holding_pct;
        });
      });
      Object.keys(activeSecTargets).forEach(sec => {
        const t = activeSecTargets[sec], a = actualSec3[sec] || 0;
        if (Math.abs(a - t) > 5) {
          flags.push('Sector "' + sec + '" target ' + t + '%; achieved ' + a.toFixed(1) + '%. Constrained by limited Ranked/Focused funds with high ' + sec + ' weight in eligible m-cap buckets.');
        }
      });
    }
    ['large', 'mid', 'small', 'flexi'].forEach(b => {
      const t = targetMC[b] || 0, a = actualMC[b] || 0;
      if (t > 0 && Math.abs(a - t) > 8) {
        flags.push(MC_LABEL[b] + ' target ' + t.toFixed(0) + '%; achieved ' + a.toFixed(0) + '%. Bucket-level rounding and overlap dedup contribute to the gap.');
      }
    });

    /* Banner */
    const badRows  = rows.filter(r => r.includes('class="bad"')).length;
    const warnRows = rows.filter(r => r.includes('class="warn"')).length;
    const banner = document.getElementById('planBanner');
    if (flags.length === 0 && badRows === 0) {
      banner.className = 'pb-plan-status ok';
      banner.innerHTML = '✓ Portfolio closely matches your plan — no material deviations.';
    } else if (badRows > 0) {
      banner.className = 'pb-plan-status bad';
      banner.innerHTML = '⚠ ' + badRows + ' metric' + (badRows > 1 ? 's' : '') + ' materially off-target — see flags below.';
    } else {
      banner.className = 'pb-plan-status warn';
      banner.innerHTML = '⚡ Minor deviations from plan — see flags below.';
    }
    document.getElementById('planFlags').innerHTML = flags.length
      ? flags.map(t => '<div class="pb-plan-flag">' + escapeHtml(t) + '</div>').join('')
      : '<div class="pb-plan-flag ok">✓ No policy breaches detected.</div>';
  }

  /* ============================================================
     FUND PERFORMANCES — grouped table (v2)
     ============================================================ */
  function renderFundsTab() {
    const f = _portfolio.funds;
    const totalW = f.reduce((s, x) => s + x._weight, 0) || 1;

    const byCat = {};
    f.forEach(x => { (byCat[x.category] = byCat[x.category] || []).push(x); });
    const orderedCats = CATEGORY_ORDER.filter(c => byCat[c]);
    Object.keys(byCat).forEach(c => { if (!orderedCats.includes(c)) orderedCats.push(c); });

    function catSubClass(cat) {
      return (byCat[cat][0] || {}).sub_category_class || 'Equity';
    }

    let html = '<thead><tr>' +
      '<th class="col-name">Fund</th>' +
      '<th class="col-date">Inception</th>' +
      '<th class="col-aum">AUM (Cr)</th>' +
      '<th class="col-alloc">Alloc%</th>' +
      '<th class="col-ret">1M%</th>' +
      '<th class="col-ret">1Y%</th>' +
      '<th class="col-ret">3Y%</th>' +
      '<th class="col-ret">5Y%</th>' +
      '<th class="col-ret">10Y%</th>' +
      '<th class="col-roll">3Y Roll%</th>' +
      '<th class="col-mcap">M-Cap</th>' +
      '</tr></thead><tbody>';

    let lastSubClass = null;
    orderedCats.forEach(cat => {
      const funds = byCat[cat];
      const sc = catSubClass(cat);
      if (sc !== lastSubClass) {
        html += '<tr class="pb-subclass-hdr"><td colspan="11">' + escapeHtml(sc) + '</td></tr>';
        lastSubClass = sc;
      }
      html += '<tr class="pb-cat-group-hdr"><td colspan="11">' + escapeHtml(cat) + '</td></tr>';

      funds.forEach(x => {
        const mr  = x.monitor_returns || {};
        const sp  = x.mcap_split || {};
        const mcapStr = [
          sp.large_pct > 0 ? 'L' + sp.large_pct.toFixed(0) : '',
          sp.mid_pct   > 0 ? 'M' + sp.mid_pct.toFixed(0)   : '',
          sp.small_pct > 0 ? 'S' + sp.small_pct.toFixed(0) : '',
        ].filter(Boolean).join('/') || '—';

        const inceptionFmt = x.inception_date
          ? (function (d) {
              const dt = new Date(d);
              return isNaN(dt) ? d : dt.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
            })(x.inception_date)
          : '—';

        const aumFmt = x.aum_cr != null
          ? Number(x.aum_cr).toLocaleString('en-IN', { maximumFractionDigits: 0 })
          : '—';

        const nameCell = x.scheme_code
          ? '<a href="fund-detail.html?scheme=' + x.scheme_code + '" target="_blank" rel="noopener">' + escapeHtml(x.fund_name) + '</a>'
          : escapeHtml(x.fund_name);

        html += '<tr class="pb-fund-row">' +
          '<td class="col-name">'  + nameCell + '</td>' +
          '<td class="col-date">'  + inceptionFmt + '</td>' +
          '<td class="col-aum">'   + aumFmt + '</td>' +
          '<td class="col-alloc">' + x._weight + '%</td>' +
          '<td class="col-ret">'   + fmtV(mr.return_1m_pct)  + '</td>' +
          '<td class="col-ret">'   + fmtV(mr.return_1y_pct)  + '</td>' +
          '<td class="col-ret">'   + fmtV(mr.return_3y_pct)  + '</td>' +
          '<td class="col-ret">'   + fmtV(mr.return_5y_pct)  + '</td>' +
          '<td class="col-ret">'   + fmtV(mr.return_10y_pct) + '</td>' +
          '<td class="col-roll">'  + fmtV(x.rolling_3y_avg_pct) + '</td>' +
          '<td class="col-mcap">'  + mcapStr + '</td>' +
          '</tr>';

        if (x.benchmark) {
          const bmr = x.benchmark_monitor_returns || {};
          html += '<tr class="pb-bench-row">' +
            '<td class="col-name bench-lbl" colspan="4">' + escapeHtml(x.benchmark) + '</td>' +
            '<td class="col-ret">' + fmtV(bmr.return_1m_pct)  + '</td>' +
            '<td class="col-ret">' + fmtV(bmr.return_1y_pct)  + '</td>' +
            '<td class="col-ret">' + fmtV(bmr.return_3y_pct)  + '</td>' +
            '<td class="col-ret">' + fmtV(bmr.return_5y_pct)  + '</td>' +
            '<td class="col-ret">' + fmtV(bmr.return_10y_pct) + '</td>' +
            '<td class="col-roll">—</td>' +
            '<td class="col-mcap">—</td>' +
            '</tr>';
        }
      });
    });

    html += '</tbody>';
    document.getElementById('pbFundsPerfTbl').innerHTML = html;
    /* Benchmark Coverage table removed in v3 — benchmarks now appear inline
       below each fund row via .pb-bench-row. */
  }

  function fmtV(v) {
    if (v == null) return '—';
    const cls = v < 0 ? ' class="neg"' : '';
    return '<span' + cls + '>' + (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%</span>';
  }

  /* ============================================================
     INDIAN NUMBER WORDS
     ============================================================ */
  function rupeeWords(n) {
    if (!n || isNaN(n)) return '';
    n = Math.round(n);
    const cr   = Math.floor(n / 1e7);
    const rem  = n % 1e7;
    const lakh = Math.floor(rem / 1e5);
    const thou = Math.floor((rem % 1e5) / 1e3);
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
                  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
                  'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    function twoDigit(num) {
      if (num < 20) return ones[num] || '';
      return (tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '')).trim();
    }
    const parts = [];
    if (cr   > 0) parts.push(twoDigit(cr)   + ' Crore' + (cr   > 1 ? 's' : ''));
    if (lakh > 0) parts.push(twoDigit(lakh) + ' Lakh'  + (lakh > 1 ? 's' : ''));
    if (thou > 0) parts.push(twoDigit(thou) + ' Thousand');
    return parts.join(', ') || 'Zero';
  }

  function updateAmountWords() {
    const el = document.getElementById('totalAmtWords');
    if (!el) return;
    const v = parseFloat(document.getElementById('totalInvAmount').value) || 0;
    el.textContent = v > 0 ? rupeeWords(v) : '';
    _state.totalAmount = v;
  }

  /* ============================================================
     MIX HELPERS
     ============================================================ */
  function getAssetClassMix() {
    const m = {};
    _portfolio.funds.forEach(f => { m[f.sub_category_class] = (m[f.sub_category_class] || 0) + (f._weight || 0); });
    return Object.keys(m).filter(k => m[k] > 0).map(k => ({ name: k, pct: m[k] }));
  }
  function getMcapMix() {
    const m = { Large: 0, Mid: 0, Small: 0, Others: 0 };
    _portfolio.funds.forEach(f => {
      const sp = f.mcap_split || {};
      const w  = f._weight || 0;
      m.Large  += (sp.large_pct  || 0) * w / 100;
      m.Mid    += (sp.mid_pct    || 0) * w / 100;
      m.Small  += (sp.small_pct  || 0) * w / 100;
      m.Others += (sp.others_pct || 0) * w / 100;
    });
    return Object.keys(m).map(k => ({ name: k, pct: m[k] })).filter(x => x.pct > 0.1);
  }
  function getSectorMix() {
    if (!_analytics) return [];
    const m = {};
    const totalW = _portfolio.funds.reduce((s, f) => s + f._weight, 0) || 1;
    _portfolio.funds.forEach(f => {
      const aFund = _analytics.funds[String(f.scheme_code)];
      if (!aFund) return;
      (aFund.sector_allocation || []).forEach(s => {
        m[s.sector] = (m[s.sector] || 0) + (f._weight / totalW) * s.holding_pct;
      });
    });
    return Object.keys(m).map(k => ({ name: k, pct: m[k] })).sort((a, b) => b.pct - a.pct);
  }
  function getStockMix() {
    if (!_analytics) return [];
    const m = {};
    const totalW = _portfolio.funds.reduce((s, f) => s + f._weight, 0) || 1;
    _portfolio.funds.forEach(f => {
      const aFund = _analytics.funds[String(f.scheme_code)];
      if (!aFund || !aFund.top_20_holdings) return;
      aFund.top_20_holdings.forEach(h => {
        const k = h.company;
        if (!m[k]) m[k] = { sector: h.sector, pct: 0 };
        m[k].pct += (f._weight / totalW) * h.holding_pct;
      });
    });
    return Object.keys(m).map(k => ({ name: k, sector: m[k].sector, pct: m[k].pct }))
      .sort((a, b) => b.pct - a.pct);
  }
  function getAmcMix() {
    const m = {};
    _portfolio.funds.forEach(f => { m[f.amc] = (m[f.amc] || 0) + (f._weight || 0); });
    return Object.keys(m).map(k => ({ name: k, pct: m[k] })).sort((a, b) => b.pct - a.pct);
  }

  /* ============================================================
     CHART HELPERS
     ============================================================ */
  function drawDonut(canvasId, data, legendId) {
    if (typeof Chart === 'undefined') return;
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (_chartInstances[canvasId]) _chartInstances[canvasId].destroy();
    _chartInstances[canvasId] = new Chart(canvas.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: data.map(d => d.name),
        datasets: [{
          data: data.map(d => d.pct),
          backgroundColor: data.map((_, i) => DONUT_PALETTE[i % DONUT_PALETTE.length]),
          borderColor: '#fff',
          borderWidth: 1.5,
        }],
      },
      options: {
        responsive: false,
        cutout: '60%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ctx.label + ': ' + ctx.parsed.toFixed(1) + '%' } },
        },
      },
    });
    if (legendId) {
      const lg = document.getElementById(legendId);
      if (lg) {
        lg.innerHTML = data.map((d, i) =>
          '<span class="lg-item"><span class="lg-swatch" style="background:' +
          DONUT_PALETTE[i % DONUT_PALETTE.length] + '"></span>' +
          escapeHtml(d.name) + ' · ' + d.pct.toFixed(1) + '%</span>'
        ).join('');
      }
    }
  }

  /* ============================================================
     UTILITIES
     ============================================================ */
  function weightedAvg(arr, valFn, wFn) {
    let num = 0, denom = 0;
    arr.forEach(x => {
      const v = valFn(x), w = wFn(x);
      if (v == null || w == null || isNaN(v)) return;
      num += v * w; denom += w;
    });
    return denom > 0 ? num / denom : null;
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function formatINR(rupees) {
    if (rupees == null || isNaN(rupees)) return '—';
    if (rupees >= 1e7) return '₹' + (rupees / 1e7).toFixed(2) + ' Cr';
    if (rupees >= 1e5) return '₹' + (rupees / 1e5).toFixed(2) + ' L';
    return '₹' + DataLoader.fmtINR(rupees);
  }
  function shiftYM(ym, deltaMonths) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }
  function enumerateMonths(startYM, endYM) {
    const out = [];
    let cur = startYM;
    while (cur <= endYM) { out.push(cur); cur = shiftYM(cur, 1); }
    return out;
  }
  function mapByDate(arr) {
    const m = {};
    if (Array.isArray(arr)) arr.forEach(p => { m[p.d] = p.v; });
    return m;
  }
  function lastNonNull(arr) {
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i];
    return null;
  }
  function formatYM(ym) {
    if (!ym) return '—';
    const [y, m] = ym.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[+m - 1] + ' ' + y;
  }
  function formatYMShort(ym) {
    if (!ym) return '';
    const [y, m] = ym.split('-');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[+m - 1] + " '" + y.slice(2);
  }

  /* ============================================================
     TOAST + SAVE / LOAD / SHARE
     ============================================================ */
  let _toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t || !msg) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function getWizardSnapshot() {
    return {
      risk:              _state.risk,
      horizon:           _state.horizon,
      instMin:           _state.instMin,
      instMax:           _state.instMax,
      optimiseFunds:     _state.optimiseFunds,
      allocMode:         _state.allocMode,
      allocManual:       Object.assign({}, _state.allocManual),
      allocPartialFlags: Object.assign({}, _state.allocPartialFlags),
      includeGlobalMF:   _state.includeGlobalMF,
      selectedProducts:  Object.assign({}, _state.selectedProducts),
      openClosedTypes:   Object.assign({}, _state.openClosedTypes),
      mcapMode:          _state.mcapMode,
      mcapManual:        Object.assign({}, _state.mcapManual),
      mcapAutoFlags:     Object.assign({}, _state.mcapAutoFlags),
      sectorMode:        _state.sectorMode,
      sectorTargets:     Object.assign({}, _state.sectorTargets),
      sectorAutoFlags:   Object.assign({}, _state.sectorAutoFlags),
      forceFunds:        _state.forceFunds.slice(),
      totalAmount:       _state.totalAmount,
      precisionMode:     _state.precisionMode,
    };
  }

  function loadWizardSnapshot(snap) {
    if (!snap) return;
    Object.assign(_state, snap);
    if (snap.risk) {
      document.querySelectorAll('#riskPills .pill').forEach(p =>
        p.classList.toggle('active', p.dataset.risk === snap.risk));
    }
    if (snap.horizon) {
      document.querySelectorAll('#horizonPills .pill').forEach(p =>
        p.classList.toggle('active', p.dataset.h === snap.horizon));
    }
    const minEl = document.getElementById('instMin');       if (minEl) minEl.value = snap.instMin || 6;
    const maxEl = document.getElementById('instMax');       if (maxEl) maxEl.value = snap.instMax || 12;
    /* Re-fire input event so the slider visual fill + readout sync. */
    if (minEl) minEl.dispatchEvent(new Event('input', { bubbles: true }));
    const optEl = document.getElementById('optimiseFunds'); if (optEl) optEl.checked = !!snap.optimiseFunds;
    document.querySelectorAll('[data-alloc-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.allocMode === snap.allocMode));
    document.getElementById('allocAutoView').hidden   = (snap.allocMode !== 'auto');
    document.getElementById('allocManualView').hidden = (snap.allocMode !== 'manual' && snap.allocMode !== 'partial');
    Object.keys(snap.allocManual || {}).forEach(b => {
      const inp = document.querySelector('.alloc-in[data-bucket="' + b + '"]');
      if (inp) inp.value = snap.allocManual[b];
    });
    refreshAutoTables(); validateAllocSum();
    document.querySelectorAll('[data-mcap-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.mcapMode === snap.mcapMode));
    document.getElementById('mcapAutoView').hidden   = (snap.mcapMode !== 'auto');
    document.getElementById('mcapManualView').hidden = !(snap.mcapMode === 'manual_full' || snap.mcapMode === 'manual_partial');
    Object.keys(snap.mcapManual || {}).forEach(b => {
      const inp = document.querySelector('.mcap-in[data-bucket="' + b + '"]');
      if (inp) inp.value = snap.mcapManual[b];
    });
    refreshMcapManualMode(); validateMcapSum();
    document.querySelectorAll('[data-sector-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.sectorMode === snap.sectorMode));
    document.getElementById('sectorAutoView').hidden   = (snap.sectorMode !== 'auto');
    document.getElementById('sectorCustomView').hidden = (snap.sectorMode === 'auto');
    renderSectorList(); validateSectorSum();
    renderForceChips();
    if (snap.precisionMode) _state.precisionMode = migrateModeKey(snap.precisionMode);
    refreshPrecisionStep();
    goToStep(1);
    showToast('Loaded saved portfolio');
  }

  function saveLastWizardState() {
    try {
      window.localStorage.setItem(AppState._NS + 'pb.lastWizard', JSON.stringify(getWizardSnapshot()));
    } catch (e) {}
  }

  function restoreLastWizardState() {
    try {
      const raw = window.localStorage.getItem(AppState._NS + 'pb.lastWizard');
      if (raw) {
        const snap = JSON.parse(raw);
        if (snap && snap.risk && snap.horizon) loadWizardSnapshot(snap);
      }
    } catch (e) {}
  }

  function copyShareLink() {
    const params = new URLSearchParams();
    params.set('risk',    _state.risk    || '');
    params.set('horizon', _state.horizon || '');
    params.set('n',       _state.instMax);
    params.set('amt',     _state.totalAmount);
    if (_state.forceFunds.length) {
      params.set('force', _state.forceFunds.map(f => f.scheme_code).join(','));
    }
    const url = location.origin + location.pathname + '?' + params.toString();
    navigator.clipboard.writeText(url)
      .then(() => showToast('Link copied to clipboard'))
      .catch(() => showToast('Could not copy link'));
  }

})();