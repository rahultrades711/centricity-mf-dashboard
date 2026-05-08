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

  /* ============================================================
     STATE
     ============================================================ */
  const _state = {
    risk: null,
    horizon: null,
    instrumentCount: 10,
    allocMode: 'auto',
    allocManual: { equity: 60, debt: 30, commodities: 5, reits: 5 },
    selectedProducts: { equity_mf: true, hybrid_mf: true },  // available + checked by default
    openClosedTypes: { open: true, closed: false, interval: false },
    mcapMode: 'auto',
    mcapManual: { large: 40, mid: 25, small: 20, flexi: 15 },
    mcapAutoFlags: { large: false, mid: false, small: false, flexi: false },  // partial-mode
    sectorMode: 'auto',
    sectorTargets: {},  // {sectorName: pct}
    forceFunds: [],     // [{scheme_code, fund_name, amc, category}]
    totalAmount: 5000000,
  };

  /* Output state set by the engine. */
  let _portfolio = null;       // { funds: [...], deviation: {...}, warnings: [...] }
  let _activeStep = 1;
  let _activeTab = 'overview';
  let _navWindow = 'max';

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
    const slider = document.getElementById('instCount');
    const badge = document.getElementById('instCountVal');
    slider.addEventListener('input', () => {
      _state.instrumentCount = +slider.value;
      badge.textContent = slider.value;
    });
    document.getElementById('step1Next').addEventListener('click', () => goToStep(2));
  }
  function updateStep1Next() {
    document.getElementById('step1Next').disabled = !(_state.risk && _state.horizon);
    updateGenerateBtn();
  }

  /* ============================================================
     STEP 2 — Allocation
     ============================================================ */
  function initStep2() {
    /* Mode toggle */
    document.querySelectorAll('[data-alloc-mode]').forEach(b => b.addEventListener('click', () => {
      _state.allocMode = b.dataset.allocMode;
      document.querySelectorAll('[data-alloc-mode]').forEach(x => x.classList.toggle('active', x === b));
      document.getElementById('allocAutoView').hidden = _state.allocMode !== 'auto';
      document.getElementById('allocManualView').hidden = _state.allocMode !== 'manual';
      validateAllocSum();
    }));
    /* Manual inputs */
    document.querySelectorAll('.alloc-in').forEach(inp => inp.addEventListener('input', () => {
      const b = inp.dataset.bucket;
      _state.allocManual[b] = +inp.value || 0;
      validateAllocSum();
    }));
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
    const sum = Object.values(_state.allocManual).reduce((s, v) => s + (+v || 0), 0);
    const sumEl = document.getElementById('allocSum');
    const errEl = document.getElementById('allocSumErr');
    sumEl.textContent = sum + '%';
    sumEl.classList.toggle('ok',  sum === 100);
    sumEl.classList.toggle('bad', sum !== 100);
    document.getElementById('allocSumNum').textContent = sum;
    errEl.hidden = (sum === 100);
    document.getElementById('step2Next').disabled = (_state.allocMode === 'manual' && sum !== 100);
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
    /* Re-fold auto values into _state.mcapManual so engine reads the right thing */
    if (_state.mcapMode === 'manual_partial') {
      const c = computePartialAutoMcap();
      Object.keys(c).forEach(b => { if (_state.mcapAutoFlags[b]) _state.mcapManual[b] = c[b]; });
    }
    const sum = Object.values(_state.mcapManual).reduce((s, v) => s + (+v || 0), 0);
    const sumEl = document.getElementById('mcapSum');
    const errEl = document.getElementById('mcapSumErr');
    sumEl.textContent = sum + '%';
    sumEl.classList.toggle('ok',  sum === 100);
    sumEl.classList.toggle('bad', sum !== 100);
    document.getElementById('mcapSumNum').textContent = sum;
    errEl.hidden = (sum === 100);
    document.getElementById('step3Next').disabled = (sum !== 100);
  }

  /* ============================================================
     STEP 4 — Sectors
     ============================================================ */
  function initStep4() {
    document.querySelectorAll('[data-sector-mode]').forEach(b => b.addEventListener('click', () => {
      _state.sectorMode = b.dataset.sectorMode;
      document.querySelectorAll('[data-sector-mode]').forEach(x => x.classList.toggle('active', x === b));
      document.getElementById('sectorAutoView').hidden = _state.sectorMode !== 'auto';
      document.getElementById('sectorCustomView').hidden = _state.sectorMode !== 'custom';
    }));
    document.querySelector('[data-back="4"]').addEventListener('click', () => goToStep(3));
    document.getElementById('step4Next').addEventListener('click', () => goToStep(5));
  }

  function renderSectorList() {
    const wrap = document.getElementById('pbSectorList');
    if (!wrap) return;
    /* Count funds per sector for tooltip context */
    const counts = {};
    if (_analytics) {
      Object.values(_analytics.funds || {}).forEach(f => {
        (f.sector_allocation || []).forEach(s => { counts[s.sector] = (counts[s.sector] || 0) + 1; });
      });
    }
    wrap.innerHTML = _allSectors.map(s => {
      const cnt = counts[s] || 0;
      const cur = _state.sectorTargets[s] || '';
      return '<div class="lbl">' + escapeHtml(s) +
             '<span class="cnt">(' + cnt + ' funds)</span></div>' +
             '<input type="number" min="0" max="100" step="1" placeholder="—" data-sec="' +
             escapeHtml(s) + '" value="' + (cur === '' ? '' : cur) + '">';
    }).join('');
    wrap.querySelectorAll('input[data-sec]').forEach(inp => inp.addEventListener('input', () => {
      const v = inp.value === '' ? null : +inp.value;
      if (v == null) delete _state.sectorTargets[inp.dataset.sec];
      else _state.sectorTargets[inp.dataset.sec] = v;
      validateSectorSum();
    }));
  }

  function validateSectorSum() {
    const sum = Object.values(_state.sectorTargets).reduce((s, v) => s + (+v || 0), 0);
    document.getElementById('sectorSum').textContent = sum + '%';
    const err = document.getElementById('sectorSumErr');
    err.hidden = (sum <= 100);
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
      renderOutput();
      showToast('Portfolio generated · ' + _portfolio.funds.length + ' funds');
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
    if (!_state.openClosedTypes.open && (_state.openClosedTypes.closed || _state.openClosedTypes.interval)) {
      /* Only close-ended/interval requested. Currently no funds have such markers — would empty universe. Leave as-is. */
    }

    /* Step 5 — resolve target asset allocation */
    const targetAC = (_state.allocMode === 'auto')
      ? Object.assign({}, ALLOC_MATRIX_AC[_state.risk][_state.horizon])
      : Object.assign({}, _state.allocManual);
    /* Coming-soon redistribution: collapse all non-equity into equity (since debt/comm/reits aren't live) */
    const equityShareTarget = (targetAC.equity || 0) + (targetAC.debt || 0) +
                              (targetAC.commodities || 0) + (targetAC.reits || 0);
    const liveTargetEquity = 100;  // entire 100% goes through Equity bucket for now
    const csNote = (targetAC.debt > 0 || targetAC.commodities > 0 || targetAC.reits > 0);
    out.comingSoonNote = csNote;
    out.deviation.targetAC = targetAC;
    out.deviation.actualLiveBucketShare = liveTargetEquity;

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

    /* Step 8 — sector alignment bonus (if custom mode) */
    const sectorTargets = (_state.sectorMode === 'custom') ? _state.sectorTargets : {};
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

    /* Step 9 + 11 — per-bucket selection with overlap dedup */
    const totalCount = _state.instrumentCount;
    const selected = [];

    Object.keys(buckets).forEach(b => {
      const target = targetMC[b] || 0;
      if (target <= 0) return;
      const eligibles = buckets[b].filter(f => !forcedSchemes.has(f.scheme_code));
      eligibles.sort(sortFn);
      let nBucket = Math.max(1, Math.round(totalCount * (target / 100)));
      /* Try to pick nBucket funds, swapping high-overlap pairs */
      const pickedHere = [];
      const alternates = eligibles.slice();
      while (pickedHere.length < nBucket && alternates.length) {
        const cand = alternates.shift();
        /* Overlap dedup vs already-selected (in this bucket + globally) */
        let highOverlap = false;
        for (const exist of pickedHere.concat(selected)) {
          const ov = computeOverlap(cand.scheme_code, exist.scheme_code);
          if (ov > 50) { highOverlap = true; break; }
        }
        if (highOverlap) continue;
        cand._bucket = b;
        cand._alternates = alternates.slice(0, 5);
        pickedHere.push(cand);
      }
      pickedHere.forEach(p => {
        const w = target / Math.max(1, pickedHere.length);
        p._weight = w;
        selected.push(p);
      });
      /* Track shortfall */
      if (pickedHere.length < nBucket) {
        out.warnings.push({
          type: 'warn',
          msg: 'Bucket "' + MC_LABEL[b] + '": requested ' + nBucket +
               ' funds, only ' + pickedHere.length + ' satisfied (after overlap dedup + tier).',
        });
      }
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
      renderActiveTab();
    });
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
      ['Weighted Avg AUM', (aum != null ? '₹' + DataLoader.fmtINR(aum) + ' Cr' : '—'), 'Indian comma grouping'],
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
    const totalW = _portfolio.funds.reduce((s, f) => s + (f._weight || 0), 0);
    const rows = _portfolio.funds.map((f, i) => {
      const rs = (f._weight || 0) * totalAmt / 100;
      const tier = f._tier || 'UNRANKED';
      return '<tr data-i="' + i + '">' +
             '<td><span class="tier-pill tier-' + tier + '">' + tier + '</span></td>' +
             '<td class="col-nm"><a class="fund-link" href="fund-detail.html?scheme=' + f.scheme_code + '">' +
               escapeHtml(f.fund_name) + '</a><div class="fund-meta">' + escapeHtml(f.amc) + '</div></td>' +
             '<td>' + escapeHtml(f.category) + '</td>' +
             '<td>' + escapeHtml(MC_LABEL[f._bucket] || '—') + '</td>' +
             '<td><input type="number" class="alloc-edit" min="0" max="100" step="2" value="' + (f._weight || 0).toFixed(0) + '" data-i="' + i + '"></td>' +
             '<td>' + formatINR(rs) + '</td>' +
             '<td>' + DataLoader.fmtScorePct(f.centricity_score) + '</td>' +
             '<td><button class="pb-act-btn swap" data-i="' + i + '" title="Swap">⇄</button>' +
                 '<button class="pb-act-btn rm"   data-i="' + i + '" title="Remove">✕</button></td>' +
             '</tr>';
    }).join('');
    const totSumCls = (Math.round(totalW) === 100) ? 'ok' : 'bad';
    wrap.innerHTML =
      '<table class="pb-tbl"><thead><tr>' +
      '<th>Tier</th><th>Fund</th><th>Category</th><th>M-Cap</th>' +
      '<th>Allocation %</th><th>₹ Amount</th><th>Score</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '<tfoot><tr><td colspan="4" class="col-nm">Total</td>' +
      '<td class="' + totSumCls + '">' + totalW.toFixed(0) + '%</td>' +
      '<td>' + formatINR(totalAmt) + '</td><td colspan="2"></td></tr></tfoot></table>';

    /* Wire allocation editing */
    wrap.querySelectorAll('input.alloc-edit').forEach(inp => {
      inp.addEventListener('change', () => {
        const i = +inp.dataset.i;
        const newW = Math.max(0, Math.min(100, +inp.value || 0));
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
    if (!_portfolio.warnings.length && !_portfolio.comingSoonNote) {
      wrap.innerHTML = ''; return;
    }
    let html = '';
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
    const ctx = document.getElementById('navChart').getContext('2d');

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

    if (_chartInstances.nav) { _chartInstances.nav.destroy(); }
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
    /* AMCs */
    const amcMix = getAmcMix();
    const maxA = amcMix[0] ? amcMix[0].pct : 1;
    document.getElementById('anlyAmcs').innerHTML = amcMix.map(a => {
      const warn = a.pct > 35 ? ' warn' : '';
      const w = (a.pct / maxA * 100).toFixed(0) + '%';
      return '<div class="amc-row' + warn + '"><span class="nm">' + escapeHtml(a.name) + '</span>' +
             '<span class="bar-wrap"><span class="bar" style="width:' + w + '"></span></span>' +
             '<span class="pct">' + a.pct.toFixed(1) + '%</span></div>';
    }).join('');
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
    const status = (delta) => {
      const ad = Math.abs(delta || 0);
      if (ad <= 5) return ['✓', 'ok'];
      if (ad <= 15) return ['!', 'warn'];
      return ['✗', 'err'];
    };

    /* AC rows */
    [['Equity + Hybrid (live)', 100, actualEqHy], ['Debt', targetAC.debt || 0, 0], ['Commodities', targetAC.commodities || 0, 0], ['REITs / InvITs', targetAC.reits || 0, 0]]
      .forEach(([lbl, t, a]) => {
        const d = a - t;
        const [icn, cls] = (lbl === 'Equity + Hybrid (live)') ? ['✓', 'ok'] : (t === 0) ? ['—', 'ok'] : status(d);
        rows.push('<tr><td>' + escapeHtml(lbl) + '</td><td>' + (t || 0).toFixed(0) + '%</td>' +
                  '<td>' + (a || 0).toFixed(0) + '%</td>' +
                  '<td' + (cls === 'err' ? ' class="bad"' : '') + '>' + (d > 0 ? '+' : '') + d.toFixed(0) + '%</td>' +
                  '<td class="status">' + icn + '</td></tr>');
      });

    /* Instrument count */
    const targetN = _state.instrumentCount;
    const actualN = f.length;
    const dN = actualN - targetN;
    const [iN, cN] = (Math.abs(dN) <= 1) ? ['✓', 'ok'] : (Math.abs(dN) <= 3) ? ['!', 'warn'] : ['✗', 'err'];
    rows.push('<tr><td>Number of instruments</td><td>' + targetN + '</td><td>' + actualN + '</td><td>' + (dN > 0 ? '+' : '') + dN + '</td><td class="status">' + iN + '</td></tr>');

    /* M-Cap rows */
    ['large', 'mid', 'small', 'flexi'].forEach(b => {
      const t = targetMC[b] || 0;
      const a = actualMC[b] || 0;
      const d = a - t;
      const [icn, cls] = status(d);
      rows.push('<tr><td>' + MC_LABEL[b] + '</td><td>' + t.toFixed(0) + '%</td>' +
                '<td>' + a.toFixed(0) + '%</td>' +
                '<td' + (cls === 'err' ? ' class="bad"' : '') + '>' + (d > 0 ? '+' : '') + d.toFixed(0) + '%</td>' +
                '<td class="status">' + icn + '</td></tr>');
    });

    /* Sector rows (only for custom-mode targets) */
    if (_state.sectorMode === 'custom' && Object.keys(_state.sectorTargets).length) {
      const actualSec = {};
      const totalW = f.reduce((s, x) => s + x._weight, 0);
      f.forEach(x => {
        const aFund = (_analytics && _analytics.funds[String(x.scheme_code)]);
        if (!aFund) return;
        (aFund.sector_allocation || []).forEach(s => {
          actualSec[s.sector] = (actualSec[s.sector] || 0) + (x._weight / totalW) * s.holding_pct;
        });
      });
      Object.keys(_state.sectorTargets).forEach(sec => {
        const t = _state.sectorTargets[sec];
        const a = actualSec[sec] || 0;
        const d = a - t;
        const [icn, cls] = status(d);
        rows.push('<tr><td>Sector: ' + escapeHtml(sec) + '</td><td>' + t.toFixed(0) + '%</td>' +
                  '<td>' + a.toFixed(1) + '%</td>' +
                  '<td' + (cls === 'err' ? ' class="bad"' : '') + '>' + (d > 0 ? '+' : '') + d.toFixed(1) + '%</td>' +
                  '<td class="status">' + icn + '</td></tr>');
      });
    }

    document.getElementById('planTbl').innerHTML =
      '<thead><tr><th>Parameter</th><th>Target</th><th>Actual</th><th>Δ</th><th>Status</th></tr></thead>' +
      '<tbody>' + rows.join('') + '</tbody>';

    /* Auto-flags */
    const flags = [];
    if (_portfolio.comingSoonNote) {
      flags.push('Debt MF, Bonds, AIF, PMS, Direct Equity, Commodities, and REITs/InvITs are not yet available in this version. Your portfolio is built entirely from Equity and Hybrid MF. The non-equity allocation has been redistributed proportionally to Equity. They will be incorporated automatically once the relevant data pipelines are live.');
    }
    if (Math.abs(dN) > 1) {
      flags.push('You requested ' + targetN + ' instruments; the engine selected ' + actualN + '. Difference reflects bucket-level rounding to integer fund counts and overlap dedup that prevented near-duplicate selections.');
    }
    /* Sector misses */
    if (_state.sectorMode === 'custom') {
      const totalW = f.reduce((s, x) => s + x._weight, 0);
      const actualSec = {};
      f.forEach(x => {
        const aFund = (_analytics && _analytics.funds[String(x.scheme_code)]);
        if (!aFund) return;
        (aFund.sector_allocation || []).forEach(s => {
          actualSec[s.sector] = (actualSec[s.sector] || 0) + (x._weight / totalW) * s.holding_pct;
        });
      });
      Object.keys(_state.sectorTargets).forEach(sec => {
        const t = _state.sectorTargets[sec], a = actualSec[sec] || 0;
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

  /* -- FUND PERFORMANCES -- */
  function renderFundsTab() {
    const wrap = document.getElementById('pbFundsPerf');
    const periods = ['ytd_pct', 'return_1m_pct', 'return_1y_pct', 'return_3y_pct', 'return_5y_pct', 'return_10y_pct'];
    const labels  = ['YTD', '1M', '1Y', '3Y', '5Y', '10Y'];

    wrap.innerHTML = _portfolio.funds.map(f => {
      const r = f.monitor_returns || {};
      const b = f.benchmark_monitor_returns || {};
      const valCells = periods.map(p => {
        const v = r[p];
        if (v == null) return '<div class="v">—</div>';
        const cls = v < 0 ? 'neg' : 'pos';
        return '<div class="v ' + cls + '">' + (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%</div>';
      }).join('');
      const headers = labels.map(l => '<div class="hd">' + l + '</div>').join('');
      const benchLine = (f.benchmark)
        ? 'Benchmark: ' + escapeHtml(f.benchmark) + ' · 1Y: ' + fmtV(b.return_1y_pct) +
          ' · 3Y: ' + fmtV(b.return_3y_pct) + ' · 5Y: ' + fmtV(b.return_5y_pct)
        : 'Benchmark: —';
      return '<div class="pb-fund-card">' +
             '<div class="pb-fund-card-h">' +
               '<span class="nm">' + escapeHtml(f.fund_name) + '</span>' +
               '<span class="meta">' + escapeHtml(f.category) + ' · <span class="tier-pill tier-' + f._tier + '">' + f._tier + '</span></span>' +
               '<span class="alloc">' + (f._weight || 0).toFixed(0) + '%</span>' +
             '</div>' +
             '<div class="pb-fund-rtns">' +
               '<div class="hd">Period</div>' + headers +
               '<div class="row-lbl">' + escapeHtml(f.fund_name.split(' ').slice(0, 2).join(' ')) + '</div>' +
               valCells +
             '</div>' +
             '<div class="pb-fund-bench">' + benchLine + '</div>' +
             '</div>';
    }).join('');

    /* Benchmark coverage table */
    const bencheSet = {};
    _portfolio.funds.forEach(f => {
      if (!f.benchmark) return;
      if (bencheSet[f.benchmark]) return;
      const b = f.benchmark_monitor_returns || {};
      bencheSet[f.benchmark] = b;
    });
    const benches = Object.keys(bencheSet);
    if (benches.length === 0) {
      document.getElementById('pbBenchTbl').innerHTML = '<tbody><tr><td>—</td></tr></tbody>';
      return;
    }
    document.getElementById('pbBenchTbl').innerHTML =
      '<thead><tr><th>Benchmark</th><th>1Y</th><th>3Y</th><th>5Y</th><th>10Y</th></tr></thead><tbody>' +
      benches.map(bn => {
        const b = bencheSet[bn];
        return '<tr><td>' + escapeHtml(bn) + '</td>' +
               '<td>' + fmtV(b.return_1y_pct) + '</td>' +
               '<td>' + fmtV(b.return_3y_pct) + '</td>' +
               '<td>' + fmtV(b.return_5y_pct) + '</td>' +
               '<td>' + fmtV(b.return_10y_pct) + '</td></tr>';
      }).join('') + '</tbody>';
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
      instrumentCount: _state.instrumentCount,
      allocMode: _state.allocMode, allocManual: Object.assign({}, _state.allocManual),
      selectedProducts: Object.assign({}, _state.selectedProducts),
      openClosedTypes: Object.assign({}, _state.openClosedTypes),
      mcapMode: _state.mcapMode, mcapManual: Object.assign({}, _state.mcapManual),
      mcapAutoFlags: Object.assign({}, _state.mcapAutoFlags),
      sectorMode: _state.sectorMode, sectorTargets: Object.assign({}, _state.sectorTargets),
      forceFunds: _state.forceFunds.slice(),
      totalAmount: _state.totalAmount,
    };
  }

  function loadWizardSnapshot(snap) {
    if (!snap) return;
    Object.assign(_state, snap);
    /* Re-render UI */
    if (snap.risk) {
      document.querySelectorAll('#riskPills .pill').forEach(p =>
        p.classList.toggle('active', p.dataset.risk === snap.risk));
    }
    if (snap.horizon) {
      document.querySelectorAll('#horizonPills .pill').forEach(p =>
        p.classList.toggle('active', p.dataset.h === snap.horizon));
    }
    document.getElementById('instCount').value = snap.instrumentCount || 10;
    document.getElementById('instCountVal').textContent = snap.instrumentCount || 10;
    document.querySelectorAll('[data-alloc-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.allocMode === snap.allocMode));
    document.getElementById('allocAutoView').hidden = (snap.allocMode !== 'auto');
    document.getElementById('allocManualView').hidden = (snap.allocMode !== 'manual');
    Object.keys(snap.allocManual || {}).forEach(b => {
      const inp = document.querySelector('.alloc-in[data-bucket="' + b + '"]');
      if (inp) inp.value = snap.allocManual[b];
    });
    refreshAutoTables(); validateAllocSum();
    /* Step 3 */
    document.querySelectorAll('[data-mcap-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.mcapMode === snap.mcapMode));
    document.getElementById('mcapAutoView').hidden = (snap.mcapMode !== 'auto');
    document.getElementById('mcapManualView').hidden = !(snap.mcapMode === 'manual_full' || snap.mcapMode === 'manual_partial');
    Object.keys(snap.mcapManual || {}).forEach(b => {
      const inp = document.querySelector('.mcap-in[data-bucket="' + b + '"]');
      if (inp) inp.value = snap.mcapManual[b];
    });
    refreshMcapManualMode(); validateMcapSum();
    /* Step 4 */
    document.querySelectorAll('[data-sector-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.sectorMode === snap.sectorMode));
    document.getElementById('sectorAutoView').hidden = (snap.sectorMode !== 'auto');
    document.getElementById('sectorCustomView').hidden = (snap.sectorMode !== 'custom');
    renderSectorList(); validateSectorSum();
    /* Step 5 */
    renderForceChips();
    /* Snap to step 1 */
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
    params.set('risk', _state.risk || '');
    params.set('horizon', _state.horizon || '');
    params.set('n', _state.instrumentCount);
    params.set('amt', _state.totalAmount);
    if (_state.forceFunds.length) {
      params.set('force', _state.forceFunds.map(f => f.scheme_code).join(','));
    }
    const url = location.origin + location.pathname + '?' + params.toString();
    navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard'))
      .catch(() => showToast('Could not copy link'));
  }
})();
