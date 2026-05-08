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
    instMin: 8,
    instMax: 15,
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
    }));
    const minIn = document.getElementById('instMin');
    const maxIn = document.getElementById('instMax');
    function syncCounts() {
      let mn = Math.max(3, Math.min(30, parseInt(minIn.value, 10) || 3));
      let mx = Math.max(3, Math.min(30, parseInt(maxIn.value, 10) || 3));
      const validRange = mx >= mn;
      minIn.classList.toggle('err', !validRange || mn > mx);
      maxIn.classList.toggle('err', !validRange);
      _state.instMin = mn;
      _state.instMax = mx;
      updateStep1Next();
    }
    minIn.addEventListener('input',  syncCounts);
    minIn.addEventListener('change', () => { minIn.value = _state.instMin; });
    maxIn.addEventListener('input',  syncCounts);
    maxIn.addEventListener('change', () => { maxIn.value = _state.instMax; });
    document.getElementById('optimiseFunds').addEventListener('change', (e) => {
      _state.optimiseFunds = e.target.checked;
    });
    document.getElementById('step1Next').addEventListener('click', () => goToStep(2));
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
    /* Global MF placeholder (disabled — Coming Soon; checkbox state still tracked) */
    const globalMfEl = document.getElementById('includeGlobalMF');
    if (globalMfEl) globalMfEl.addEventListener('change', (e) => {
      _state.includeGlobalMF = e.target.checked;
    });
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

  /* Renders into the active mode's container. Auto mode has no list. */
  function renderSectorList() {
    if (_state.sectorMode === 'auto') return;
    const isPartial = _state.sectorMode === 'manual_partial';
    const wrapId = isPartial ? 'pbSectorListPartial' : 'pbSectorListFull';
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
    document.querySelector('[data-back="5"]').addEventListener('click', () => goToStep(4));
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
    updateGenerateBtn();
    /* Auto-scroll wizard panel to top */
    document.getElementById('pbWizard').scrollTop = 0;
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
      if (!_portfolio.funds.length) {
        document.getElementById('pbOutEmpty').hidden = false;
        document.getElementById('pbOutEmpty').querySelector('h3').textContent = 'No funds matched your criteria';
        document.getElementById('pbOutEmpty').querySelector('p').textContent = 'No Ranked or Focused funds found for your selected m-cap and product mix. Try broadening the m-cap allocation, adding more product types, or reducing the instrument count target.';
        showToast('No eligible funds — broaden criteria');
      } else {
        renderOutput();
        showToast('Portfolio generated · ' + _portfolio.funds.length + ' funds');
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

    /* Step 2 — tier classification */
    const focusedSet = new Set(_focusedSchemes);
    universe.forEach(f => {
      f._tier = (focusedSet.has(f.scheme_code))                ? 'FOCUSED'
              : (f.centricity_score_status === 'Ranked')       ? 'RANKED'
              : (f.verdict === 'REVIEW')                       ? 'REVIEW'
              :                                                  'UNRANKED';
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

    /* Step 7 — group by m-cap bucket */
    const buckets = { large: [], mid: [], small: [], flexi: [] };
    universe.forEach(f => {
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
        f._sectorBonus = bonus;  // small numeric add to score
      });
    } else {
      universe.forEach(f => { f._sectorBonus = 0; });
    }

    const TIER_RANK = { FOCUSED: 0, RANKED: 1, REVIEW: 2, UNRANKED: 3 };
    function sortFn(a, b) {
      const ta = TIER_RANK[a._tier] ?? 9;
      const tb = TIER_RANK[b._tier] ?? 9;
      if (ta !== tb) return ta - tb;
      const sa = (a.centricity_score ?? 0) + (a._sectorBonus || 0);
      const sb = (b.centricity_score ?? 0) + (b._sectorBonus || 0);
      if (sb !== sa) return sb - sa;
      return ((b.risk_metrics?.sharpe_3y || 0) - (a.risk_metrics?.sharpe_3y || 0));
    }

    /* Step 10 — handle force-include first (deduct from buckets) */
    const forced = [];
    const forcedSchemes = new Set();
    _state.forceFunds.forEach(ff => {
      const f = _allFunds.find(x => x.scheme_code === ff.scheme_code);
      if (!f) return;
      forced.push(f);
      forcedSchemes.add(f.scheme_code);
    });

    /* Step 9 + 11 — per-bucket selection with overlap dedup + 2-per-category cap.
       Engine targets up to instMax fund slots distributed by m-cap weights.
       Hard rule: at most 2 funds per SEBI category (across all buckets). */
    const targetMax = Math.max(_state.instMin, _state.instMax);
    const targetMin = _state.instMin;
    const selected = [];
    const catCount = {};                 // SEBI category → count of funds selected
    const bucketShortfalls = [];         // {bucket, requested, achieved}

    function tryPick(cand, b, pickedHere) {
      if ((catCount[cand.category] || 0) >= 2) return false;     // 2-per-category cap
      for (const exist of pickedHere.concat(selected)) {
        if (computeOverlap(cand.scheme_code, exist.scheme_code) > 50) return false;
      }
      cand._bucket = b;
      cand._alternates = [];                                     // filled below
      pickedHere.push(cand);
      catCount[cand.category] = (catCount[cand.category] || 0) + 1;
      return true;
    }

    Object.keys(buckets).forEach(b => {
      const target = targetMC[b] || 0;
      if (target <= 0) return;
      const eligibles = buckets[b].filter(f => !forcedSchemes.has(f.scheme_code));
      eligibles.sort(sortFn);
      const nBucket = Math.max(1, Math.round(targetMax * (target / 100)));
      const pickedHere = [];
      const alternates = eligibles.slice();
      while (pickedHere.length < nBucket && alternates.length) {
        const cand = alternates.shift();
        if (!tryPick(cand, b, pickedHere)) continue;
      }
      /* Pre-load up to 5 alternates per fund for the swap popover */
      pickedHere.forEach(p => { p._alternates = alternates.slice(0, 5); });
      /* Equal-split bucket weight across actual picks */
      pickedHere.forEach(p => {
        p._weight = target / Math.max(1, pickedHere.length);
        selected.push(p);
      });
      if (pickedHere.length < nBucket) {
        bucketShortfalls.push({ bucket: b, requested: nBucket, achieved: pickedHere.length });
      }
    });

    /* Phase 2: if total < instMin and !optimiseFunds, top up from any bucket
       (still respecting 2-per-cat + overlap). Pulls from REVIEW / UNRANKED tiers. */
    if (selected.length < targetMin && !_state.optimiseFunds) {
      const allEligibles = universe
        .filter(f => !forcedSchemes.has(f.scheme_code))
        .filter(f => !selected.find(s => s.scheme_code === f.scheme_code))
        .sort(sortFn);
      for (const cand of allEligibles) {
        if (selected.length >= targetMin) break;
        const b = CATEGORY_MCAP_BUCKET[cand.category] || 'flexi';
        const proxy = [];
        if (tryPick(cand, b, proxy)) {
          /* Give it a small fixed weight from the largest existing bucket */
          cand._weight = Math.max(2, 100 / (selected.length + 1));
          selected.push(proxy[0]);
        }
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
      f._tier = (focusedSet.has(f.scheme_code)) ? 'FOCUSED'
              : (f.centricity_score_status === 'Ranked') ? 'RANKED'
              : 'REVIEW';
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
    const TIER_RANK = { FOCUSED: 0, RANKED: 1, REVIEW: 2, UNRANKED: 3 };
    const candidates = _allFunds.filter(x => {
      if (inSet.has(x.scheme_code)) return false;
      if (CATEGORY_MCAP_BUCKET[x.category] !== f._bucket) return false;
      /* Same product family (Equity / Hybrid) */
      if (x.sub_category_class !== f.sub_category_class) return false;
      return true;
    }).map(x => Object.assign({}, x, {
      _tier: (_focusedSchemes.includes(x.scheme_code)) ? 'FOCUSED'
           : (x.centricity_score_status === 'Ranked') ? 'RANKED'
           : (x.verdict === 'REVIEW') ? 'REVIEW' : 'UNRANKED',
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
        _tier: (_focusedSchemes.includes(cand.scheme_code)) ? 'FOCUSED'
             : (cand.centricity_score_status === 'Ranked') ? 'RANKED'
             : (cand.verdict === 'REVIEW') ? 'REVIEW' : 'UNRANKED',
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
        plugins: { legend: { position: 'bottom', labels: { font: { family: 'Cambria', size: 12 } } } },
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
    /* AMCs — bar width = absolute allocation %, not relative-to-max (ISSUE-0019 rule) */
    const amcMix = getAmcMix();
    document.getElementById('anlyAmcs').innerHTML = amcMix.map(a => {
      const warn = a.pct > 35 ? ' warn' : '';
      return '<div class="amc-row' + warn + '"><span class="nm">' + escapeHtml(a.name) + '</span>' +
             '<span class="bar-wrap"><span class="bar" style="width:' + a.pct.toFixed(1) + '%"></span></span>' +
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
      const totalW = f.reduce((s, x) => s + x._weight, 0);
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
        rows.push('<tr><td>Sector: ' + escapeHtml(sec) + '</td>' +
                  '<td>' + t.toFixed(0) + '%</td>' +
                  '<td>' + a.toFixed(1) + '%</td>' +
                  '<td' + (cls ? ' class="' + cls + '"' : '') + '>' +
                  (d > 0 ? '+' : '') + d.toFixed(1) + '%</td></tr>');
      });
    }

    document.getElementById('planTbl').innerHTML =
      '<thead><tr><th>Parameter</th><th>Target</th><th>Actual</th><th>Δ</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody>';

    /* Auto-flags */
    const flags = [];
    if (_portfolio.comingSoonNote) {
      flags.push('Debt MF, Bonds, AIF, PMS, Direct Equity, Commodities, and REITs/InvITs are not yet available in this version. Your portfolio is built entirely from Equity and Hybrid MF. The non-equity allocation has been redistributed proportionally to Equity. They will be incorporated automatically once the relevant data pipelines are live.');
    }
    if (!inRange) {
      flags.push('You requested ' + _state.instMin + '–' + _state.instMax + ' instruments; the engine selected ' + actualN + '. Difference reflects the 2-fund-per-category cap, bucket-level rounding to integer fund counts, and overlap dedup that prevented near-duplicate selections.');
    }
    /* Sector misses — manual_full + manual_partial typed targets */
    let activeSecForFlags = {};
    if (_state.sectorMode === 'manual_full') {
      activeSecForFlags = _state.sectorTargets;
    } else if (_state.sectorMode === 'manual_partial') {
      Object.keys(_state.sectorTargets).forEach(s => {
        if (!_state.sectorAutoFlags[s]) activeSecForFlags[s] = _state.sectorTargets[s];
      });
    }
    if (Object.keys(activeSecForFlags).length) {
      const totalW = f.reduce((s, x) => s + x._weight, 0);
      const actualSec = {};
      f.forEach(x => {
        const aFund = (_analytics && _analytics.funds[String(x.scheme_code)]);
        if (!aFund) return;
        (aFund.sector_allocation || []).forEach(s => {
          actualSec[s.sector] = (actualSec[s.sector] || 0) + (x._weight / totalW) * s.holding_pct;
        });
      });
      Object.keys(activeSecForFlags).forEach(sec => {
        const t = activeSecForFlags[sec], a = actualSec[sec] || 0;
        if (Math.abs(a - t) > 5) {
          flags.push('Sector "' + sec + '" target was ' + t + '%; achieved ' + a.toFixed(1) +
                     '%. Constrained by limited Ranked / Focused funds with high ' + sec + ' weight in the eligible m-cap buckets.');
        }
      });
    }
    /* M-Cap misses */
    ['large', 'mid', 'small', 'flexi'].forEach(b => {
      const t = targetMC[b] || 0; const a = actualMC[b] || 0;
      if (t > 0 && Math.abs(a - t) > 8) {
        flags.push(MC_LABEL[b] + ' target was ' + t.toFixed(0) + '%; achieved ' + a.toFixed(0) +
                   '%. Bucket-level fund-count rounding + overlap dedup contribute to the gap.');
      }
    });

    /* Banner */
    const banner = document.getElementById('planBanner');
    if (flags.length === 0) {
      banner.className = 'pb-plan-status ok';
      banner.textContent = '✓ Portfolio closely matches your plan. No material deviations.';
    } else if (flags.length <= 2) {
      banner.className = 'pb-plan-status warn';
      banner.textContent = '⚠ Minor deviations from your plan — see flags below.';
    } else {
      banner.className = 'pb-plan-status err';
      banner.textContent = '✗ Several constraints could not be fully satisfied. See flags.';
    }

    document.getElementById('planFlags').innerHTML = flags.map(t =>
      '<div class="pb-plan-flag">' + escapeHtml(t) + '</div>').join('');
  }

  /* -- FUND PERFORMANCES — grouped table -- */
  function renderFundsTab() {
    const body = document.getElementById('pbFundsPerfBody');
    if (!body) return;
    const totalAmt = _state.totalAmount;

    function vcell(v) {
      if (v == null) return '<td>—</td>';
      const cls = v < 0 ? 'v-neg' : 'v-pos';
      return '<td class="' + cls + '">' + (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%</td>';
    }
    function vcellOnly(v) {
      if (v == null) return '—';
      const cls = v < 0 ? 'v-neg' : 'v-pos';
      return '<span class="' + cls + '">' + (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%</span>';
    }

    /* Group funds by sub_category_class then category, ordered per CATEGORY_ORDER. */
    const equity = _portfolio.funds.filter(f => f.sub_category_class === 'Equity');
    const hybrid = _portfolio.funds.filter(f => f.sub_category_class === 'Hybrid');

    function buildGroupedRows(funds) {
      const byCat = {};
      funds.forEach(f => {
        if (!byCat[f.category]) byCat[f.category] = [];
        byCat[f.category].push(f);
      });
      const orderedCats = CATEGORY_ORDER.filter(c => byCat[c]);
      Object.keys(byCat).forEach(c => { if (!orderedCats.includes(c)) orderedCats.push(c); });
      let html = '';
      orderedCats.forEach(cat => {
        const inGroup = byCat[cat].slice().sort((a, b) => (b._weight || 0) - (a._weight || 0));
        html += '<tr class="pb-cat-group-hdr"><td colspan="11">' + escapeHtml(cat) + '</td></tr>';
        const benchesSeen = new Set();
        inGroup.forEach(f => {
          const r  = f.monitor_returns || {};
          const incep = formatInception(f.inception_date);
          const aum   = (f.aum_cr != null) ? formatINR(Math.round(f.aum_cr * 1e7)) : '—';
          const aumShort = (f.aum_cr != null) ? DataLoader.fmtINR(f.aum_cr) : '—';
          const w = f._weight || 0;
          const rsAmt = w * totalAmt / 100;
          const mc = f.mcap_split || {};
          const mcMini = (Object.keys(mc).length === 0)
            ? '—'
            : 'L:<b>' + Math.round(mc.large_pct || 0) + '</b> M:<b>' +
              Math.round(mc.mid_pct || 0) + '</b> S:<b>' +
              Math.round(mc.small_pct || 0) + '</b> O:<b>' +
              Math.round(mc.others_pct || 0) + '</b>';
          html += '<tr class="fund-row">' +
                  '<td><a class="fund-link" href="fund-detail.html?scheme=' + f.scheme_code + '" target="_blank" rel="noopener">' +
                    escapeHtml(f.fund_name) + '</a></td>' +
                  '<td>' + incep + '</td>' +
                  '<td>' + aumShort + '</td>' +
                  '<td class="pb-alloc-cell">' +
                    '<span class="alloc-pct">' + w.toFixed(0) + '%</span>' +
                    '<span class="alloc-amt">' + formatINR(rsAmt) + '</span></td>' +
                  vcell(r.return_1m_pct) + vcell(r.return_1y_pct) + vcell(r.return_3y_pct) +
                  vcell(r.return_5y_pct) + vcell(r.return_10y_pct) +
                  '<td>' + ((f.rolling_3y_avg_pct != null) ? vcellOnly(f.rolling_3y_avg_pct) : '—') + '</td>' +
                  '<td><span class="mcap-mini">' + mcMini + '</span></td>' +
                  '</tr>';
        });
        /* One benchmark row per group (skip if all funds share same benchmark already shown) */
        const firstWithBench = inGroup.find(x => x.benchmark);
        if (firstWithBench && !benchesSeen.has(firstWithBench.benchmark)) {
          benchesSeen.add(firstWithBench.benchmark);
          const b = firstWithBench.benchmark_monitor_returns || {};
          html += '<tr class="pb-bench-row">' +
                  '<td class="bench-lbl">Benchmark: <em>' + escapeHtml(firstWithBench.benchmark) + '</em></td>' +
                  '<td>—</td><td>—</td><td>—</td>' +
                  vcell(b.return_1m_pct) + vcell(b.return_1y_pct) + vcell(b.return_3y_pct) +
                  vcell(b.return_5y_pct) + vcell(b.return_10y_pct) +
                  '<td>—</td><td>—</td></tr>';
        }
      });
      return html;
    }

    let bodyHtml = '';
    if (equity.length) {
      bodyHtml += '<tr class="pb-subclass-hdr"><td colspan="11">Equity Funds</td></tr>';
      bodyHtml += buildGroupedRows(equity);
    }
    if (hybrid.length) {
      bodyHtml += '<tr class="pb-subclass-hdr"><td colspan="11">Hybrid Funds</td></tr>';
      bodyHtml += buildGroupedRows(hybrid);
    }
    body.innerHTML = bodyHtml;
  }

  function formatInception(iso) {
    if (!iso) return '—';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
    if (!m) return '—';
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return months[+m[2] - 1] + ' ' + m[1];
  }

  function fmtV(v) {
    if (v == null) return '—';
    const cls = v < 0 ? ' class="neg"' : '';
    return '<span' + cls + '>' + (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%</span>';
  }

  /* ============================================================
     MIX HELPERS (asset class / m-cap / sector / stock / amc)
     ============================================================ */
  function getAssetClassMix() {
    const m = { Equity: 0, Hybrid: 0 };
    _portfolio.funds.forEach(f => { m[f.sub_category_class] = (m[f.sub_category_class] || 0) + (f._weight || 0); });
    return Object.keys(m).filter(k => m[k] > 0).map(k => ({ name: k, pct: m[k] }));
  }
  function getMcapMix() {
    const m = { Large: 0, Mid: 0, Small: 0, Others: 0 };
    _portfolio.funds.forEach(f => {
      const sp = f.mcap_split || {};
      const w = f._weight || 0;
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
        datasets: [{ data: data.map(d => d.pct), backgroundColor: data.map((_, i) => DONUT_PALETTE[i % DONUT_PALETTE.length]), borderColor: '#fff', borderWidth: 1.5 }]
      },
      options: {
        responsive: false,
        cutout: '60%',
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ctx.label + ': ' + ctx.parsed.toFixed(1) + '%' } }
        }
      }
    });
    /* Custom legend */
    if (legendId) {
      const lg = document.getElementById(legendId);
      lg.innerHTML = data.map((d, i) =>
        '<span class="lg-item"><span class="lg-swatch" style="background:' +
        DONUT_PALETTE[i % DONUT_PALETTE.length] + '"></span>' +
        escapeHtml(d.name) + ' · ' + d.pct.toFixed(1) + '%</span>'
      ).join('');
    }
  }

  /* ============================================================
     UTILITIES
     ============================================================ */
  function weightedAvg(arr, valFn, wFn) {
    let num = 0, denom = 0;
    arr.forEach(x => {
      const v = valFn(x); const w = wFn(x);
      if (v == null || w == null || isNaN(v)) return;
      num += v * w; denom += w;
    });
    return denom > 0 ? num / denom : null;
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  function formatINR(rupees) {
    if (rupees == null || isNaN(rupees)) return '—';
    if (rupees >= 1e7) return '₹' + (rupees / 1e7).toFixed(2) + ' Cr';
    if (rupees >= 1e5) return '₹' + (rupees / 1e5).toFixed(2) + ' L';
    return '₹' + DataLoader.fmtINR(rupees);
  }

  /* Indian-comma full integer rupee format. ₹5,00,000 / ₹2,50,00,000. */
  function formatINRFull(rupees) {
    if (rupees == null || isNaN(rupees)) return '—';
    try {
      return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(rupees));
    } catch (e) {
      return '₹' + DataLoader.fmtINR(rupees);
    }
  }

  /* Indian numeric → words. Returns "Fifty Lakhs", "One Crore Twenty Lakhs", etc.
     Uses Lakh / Crore (no Million / Billion). */
  function rupeeWords(n) {
    if (n == null || isNaN(n) || n < 0) return '';
    n = Math.round(n);
    if (n === 0) return 'Zero';
    const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
      'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    function below100(x) {
      if (x < 20) return ONES[x];
      const t = Math.floor(x / 10), o = x % 10;
      return TENS[t] + (o ? ' ' + ONES[o] : '');
    }
    function below1000(x) {
      if (x < 100) return below100(x);
      const h = Math.floor(x / 100), rest = x % 100;
      return ONES[h] + ' Hundred' + (rest ? ' ' + below100(rest) : '');
    }
    /* Crore = 1e7, Lakh = 1e5, Thousand = 1e3 */
    const cr = Math.floor(n / 1e7);
    const lk = Math.floor((n % 1e7) / 1e5);
    const th = Math.floor((n % 1e5) / 1e3);
    const rest = n % 1e3;
    const parts = [];
    if (cr) parts.push(below1000(cr) + ' Crore' + (cr > 1 ? '' : ''));
    if (lk) parts.push(below1000(lk) + ' Lakh' + (lk > 1 ? 's' : ''));
    if (th) parts.push(below100(th) + ' Thousand');
    if (rest) parts.push(below1000(rest));
    return parts.join(' ');
  }

  function updateAmountWords() {
    const el = document.getElementById('totalAmtWords');
    if (!el) return;
    const amt = _state.totalAmount;
    if (!amt || amt <= 0) { el.textContent = '—'; return; }
    el.textContent = formatINRFull(amt) + ' — ' + rupeeWords(amt);
  }

  function shiftYM(ym, deltaMonths) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  }

  function enumerateMonths(startYM, endYM) {
    const out = [];
    let cur = startYM;
    while (cur <= endYM) {
      out.push(cur);
      cur = shiftYM(cur, 1);
    }
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
     TOAST + SAVE/LOAD
     ============================================================ */
  let _toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t || !msg) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function getWizardSnapshot() {
    return {
      risk: _state.risk, horizon: _state.horizon,
      instMin: _state.instMin, instMax: _state.instMax,
      optimiseFunds: _state.optimiseFunds,
      allocMode: _state.allocMode,
      allocManual:       Object.assign({}, _state.allocManual),
      allocPartialFlags: Object.assign({}, _state.allocPartialFlags),
      includeGlobalMF: _state.includeGlobalMF,
      selectedProducts: Object.assign({}, _state.selectedProducts),
      openClosedTypes:  Object.assign({}, _state.openClosedTypes),
      mcapMode: _state.mcapMode,
      mcapManual:    Object.assign({}, _state.mcapManual),
      mcapAutoFlags: Object.assign({}, _state.mcapAutoFlags),
      sectorMode: _state.sectorMode,
      sectorTargets:   Object.assign({}, _state.sectorTargets),
      sectorAutoFlags: Object.assign({}, _state.sectorAutoFlags),
      forceFunds: _state.forceFunds.slice(),
      totalAmount: _state.totalAmount,
    };
  }

  function loadWizardSnapshot(snap) {
    if (!snap) return;
    /* Migrate v1 saved snapshots that used `instrumentCount` */
    if (snap.instrumentCount && !snap.instMin) {
      snap.instMin = Math.max(3, Math.min(30, snap.instrumentCount - 2));
      snap.instMax = Math.max(snap.instMin, Math.min(30, snap.instrumentCount + 5));
      delete snap.instrumentCount;
    }
    if (snap.sectorMode === 'custom') snap.sectorMode = 'manual_full';
    Object.assign(_state, snap);
    /* Step 1 */
    if (snap.risk) {
      document.querySelectorAll('#riskPills .pill').forEach(p =>
        p.classList.toggle('active', p.dataset.risk === snap.risk));
    }
    if (snap.horizon) {
      document.querySelectorAll('#horizonPills .pill').forEach(p =>
        p.classList.toggle('active', p.dataset.h === snap.horizon));
    }
    document.getElementById('instMin').value = snap.instMin || 8;
    document.getElementById('instMax').value = snap.instMax || 15;
    const opt = document.getElementById('optimiseFunds');
    if (opt) opt.checked = snap.optimiseFunds !== false;
    /* Step 2 */
    document.querySelectorAll('[data-alloc-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.allocMode === snap.allocMode));
    document.getElementById('allocAutoView').hidden    = (snap.allocMode !== 'auto');
    document.getElementById('allocManualView').hidden  = (snap.allocMode !== 'manual');
    document.getElementById('allocPartialView').hidden = (snap.allocMode !== 'partial');
    Object.keys(snap.allocManual || {}).forEach(b => {
      const inp1 = document.querySelector('.alloc-in[data-bucket="' + b + '"]');
      if (inp1) inp1.value = snap.allocManual[b];
      const inp2 = document.querySelector('.alloc-pin[data-bucket="' + b + '"]');
      if (inp2) inp2.value = snap.allocManual[b];
    });
    Object.keys(snap.allocPartialFlags || {}).forEach(b => {
      const c = document.querySelector('.alloc-pauto[data-bucket="' + b + '"]');
      if (c) c.checked = !!snap.allocPartialFlags[b];
    });
    refreshAutoTables(); refreshAllocPartialMode(); validateAllocSum();
    /* Step 3 */
    document.querySelectorAll('[data-mcap-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.mcapMode === snap.mcapMode));
    document.getElementById('mcapAutoView').hidden = (snap.mcapMode !== 'auto');
    document.getElementById('mcapManualView').hidden = !(snap.mcapMode === 'manual_full' || snap.mcapMode === 'manual_partial');
    Object.keys(snap.mcapManual || {}).forEach(b => {
      const inp = document.querySelector('.mcap-in[data-bucket="' + b + '"]');
      if (inp) inp.value = snap.mcapManual[b];
    });
    Object.keys(snap.mcapAutoFlags || {}).forEach(b => {
      const c = document.querySelector('.mcap-auto[data-bucket="' + b + '"]');
      if (c) c.checked = !!snap.mcapAutoFlags[b];
    });
    refreshMcapManualMode(); validateMcapSum();
    /* Step 4 */
    document.querySelectorAll('[data-sector-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.sectorMode === snap.sectorMode));
    document.getElementById('sectorAutoView').hidden    = (snap.sectorMode !== 'auto');
    document.getElementById('sectorFullView').hidden    = (snap.sectorMode !== 'manual_full');
    document.getElementById('sectorPartialView').hidden = (snap.sectorMode !== 'manual_partial');
    renderSectorList(); validateSectorSum();
    /* Step 5 */
    renderForceChips();
    /* Snap to step 1 */
    goToStep(1);
    updateStep1Next();
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
    params.set('risk', _state.risk || '');
    params.set('horizon', _state.horizon || '');
    params.set('min', _state.instMin);
    params.set('max', _state.instMax);
    params.set('amt', _state.totalAmount);
    if (_state.forceFunds.length) {
      params.set('force', _state.forceFunds.map(f => f.scheme_code).join(','));
    }
    const url = location.origin + location.pathname + '?' + params.toString();
    navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard'))
      .catch(() => showToast('Could not copy link'));
  }
})();
