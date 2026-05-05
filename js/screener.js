/*
 * Centricity MF Screener Dashboard — screener.html page logic
 *
 * ⚠️  Screener is the ONLY page where weight edits trigger recompute.
 * Other pages (Home, Fund Detail, Compare, Portfolio Builder) read the
 * Excel-locked centricity_score directly from the JSON.
 *
 * The right-drawer sliders enumerate from cycle.cycle_meta.scoring_weights[]
 * — never from a hardcoded list. When the Excel adds or removes a parameter
 * next cycle, this drawer auto-resizes (CLAUDE.md §9 rule 1).
 *
 * URL query-string state (so analysts can share filtered views):
 *   ?ac=equity,hybrid                  → asset-class checkboxes
 *   ?cat=Flexi+Cap,Multi+Cap           → SEBI category checkboxes
 *   ?amc=ICICI+Pru,HDFC                → AMC checkboxes
 *   ?sort=score_desc                   → table sort key + direction
 *   ?aum_min=1000&aum_max=50000        → numeric range filters
 *   ?sharpe_min=1.0&score_min=70       → ditto
 *   ?w_<param>=<value>                 → weight overrides (per parameter)
 *   ?q=quant                           → search box
 *
 * Persistence priority on load: URL params > AppState.getCustomWeights() >
 * cycle defaults. Filter state lives in URL (no localStorage); custom
 * weights are stored separately so they persist across sessions.
 */
(function () {
  'use strict';

  /* ---------- module state ---------- */
  let _cycle = null;
  let _allFunds = [];
  let _filteredFunds = [];
  let _scoringWeights = [];           // [{parameter, weight_pct, direction, unit}]
  let _customWeights = null;          // {paramName: weight_pct} or null = use defaults
  let _selected = new Set();          // schemeCodes selected for compare
  let _sortKey = 'score';
  let _sortDir = 'desc';
  let _drawerOpen = false;

  let _acMS, _catMS, _amcMS;          // MultiSelect instances

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

    // Title
    const m = cycle.cycle_meta;
    document.getElementById('screenerTitle').innerHTML =
      `Interactive <em>Screener</em> · ${escapeHtml(m.cycle_label)}`;
    document.getElementById('screenerSub').textContent =
      `${m.total_funds.toLocaleString('en-IN')} funds across ${m.category_count} SEBI categories. ` +
      `Filter, sort, edit weights — your changes update the Score column live.`;
    document.getElementById('totalCount').textContent = m.total_funds.toLocaleString('en-IN');
    document.getElementById('footUpdated').textContent = 'Last updated · ' + m.as_on_display;

    initFilters();
    initWeightDrawer();
    parseUrlState();
    applyAndRender();
    initToolbar();
    initToasts();
  }

  /* ---------- error shell ---------- */
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

  /* ---------- filter rail (3 MultiSelects + numeric ranges) ---------- */
  function initFilters() {
    const m = _cycle.cycle_meta;

    _acMS = MultiSelect.create(document.getElementById('acMS'), {
      items: [
        { value: 'equity', label: 'Equity' },
        { value: 'debt',   label: 'Debt'   },
        { value: 'hybrid', label: 'Hybrid' },
      ],
      selected: ['equity', 'debt', 'hybrid'],
      label: 'Asset class', allLabel: 'All asset classes',
      noneLabel: 'None selected',
      oneLabel: (i) => `${i.label} only`,
      manyLabel: (n) => `${n} selected`,
      searchPlaceholder: 'Search…',
      onChange: () => { rebuildCategoryItems(); applyAndRender(); writeUrlState(); },
    });

    _catMS = MultiSelect.create(document.getElementById('catMS'), {
      items: buildCategoryItems(['equity', 'debt', 'hybrid']),
      selected: buildCategoryItems(['equity', 'hybrid']).map(i => i.value),
      label: 'SEBI category', allLabel: 'All categories',
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

    // Range inputs
    ['aumMin', 'aumMax', 'sharpeMin', 'scoreMin'].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener('input', () => { applyAndRender(); writeUrlState(); });
    });

    document.getElementById('resetBtn').addEventListener('click', () => {
      _acMS.setSelected(['equity', 'debt', 'hybrid']);
      rebuildCategoryItems();
      _catMS.setSelected(buildCategoryItems(['equity', 'hybrid']).map(i => i.value));
      _amcMS.setSelected(buildAmcItems().map(i => i.value));
      ['aumMin', 'aumMax', 'sharpeMin', 'scoreMin'].forEach(id => {
        document.getElementById(id).value = '';
      });
      _sortKey = 'score'; _sortDir = 'desc';
      document.getElementById('searchInput').value = '';
      applyAndRender();
      writeUrlState();
    });
  }

  function buildCategoryItems(assetClasses) {
    const cats = _cycle.cycle_meta.categories || [];
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
    _catMS.refresh(buildCategoryItems(_acMS.getSelected()), { defaultCheckNew: true });
  }

  function buildAmcItems() {
    const seen = new Set();
    _allFunds.forEach(f => seen.add(f.amc));
    return Array.from(seen).sort().map(a => ({ value: a, label: a }));
  }

  /* ---------- weight drawer ---------- */
  function initWeightDrawer() {
    document.getElementById('weightsBtn').addEventListener('click', toggleDrawer);
    document.getElementById('closeDrawerBtn').addEventListener('click', () => setDrawer(false));
    document.getElementById('resetWeightsBtn').addEventListener('click', () => {
      _customWeights = null;
      AppState.resetWeights();
      renderWeightSliders();
      applyAndRender();
      writeUrlState();
      showToast('Weights reset to Excel-shipped values.');
    });
    renderWeightSliders();
  }

  function toggleDrawer() { setDrawer(!_drawerOpen); }
  function setDrawer(open) {
    _drawerOpen = !!open;
    document.getElementById('layout').classList.toggle('with-drawer', _drawerOpen);
    document.getElementById('weightDrawer').hidden = !_drawerOpen;
  }

  function getCurrentWeights() {
    // Returns scoring_weights with weight_pct possibly overridden by _customWeights
    return _scoringWeights.map(w => {
      const override = _customWeights && _customWeights[w.parameter];
      return Object.assign({}, w, override != null ? { weight_pct: override } : {});
    });
  }

  function renderWeightSliders() {
    const wrap = document.getElementById('weightSliders');
    const ws = getCurrentWeights();
    wrap.innerHTML = ws.map((w, idx) => `
      <div class="weight-row" data-param="${escapeHtml(w.parameter)}">
        <div class="top">
          <span class="name">${escapeHtml(w.parameter)} <span class="dir">${w.direction === 'Higher' ? '↑' : '↓'}</span></span>
          <span class="val"><span class="v">${(w.weight_pct).toFixed(1)}</span>%</span>
        </div>
        <input type="range" min="0" max="20" step="0.5" value="${w.weight_pct}" />
      </div>
    `).join('');
    updateWeightSum();

    wrap.querySelectorAll('.weight-row').forEach(row => {
      const param = row.getAttribute('data-param');
      const input = row.querySelector('input[type="range"]');
      const display = row.querySelector('.val .v');
      input.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        display.textContent = val.toFixed(1);
        if (!_customWeights) _customWeights = {};
        _customWeights[param] = val;
        AppState.setCustomWeights(_customWeights);
        updateWeightSum();
        applyAndRender();
        writeUrlState();
      });
    });
  }

  function updateWeightSum() {
    const ws = getCurrentWeights();
    const sum = ws.reduce((s, w) => s + (w.weight_pct || 0), 0);
    const el = document.getElementById('weightSum');
    el.textContent = `Σ ${sum.toFixed(1)}%`;
    el.classList.toggle('warn', Math.abs(sum - 100) > 0.5);
  }

  /* ---------- filter + render ---------- */
  function applyAndRender() {
    const acSel = _acMS ? _acMS.getSelected() : ['equity', 'debt', 'hybrid'];
    const catSel = _catMS ? _catMS.getSelected() : [];
    const amcSel = _amcMS ? _amcMS.getSelected() : [];
    const subClassMap = { equity: 'Equity', debt: 'Debt', hybrid: 'Hybrid' };
    const subClasses = acSel.map(a => subClassMap[a]);

    const aumMin = numOrNull('aumMin');
    const aumMax = numOrNull('aumMax');
    const sharpeMin = numOrNull('sharpeMin');
    const scoreMinPct = numOrNull('scoreMin');
    const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();

    const ws = getCurrentWeights();

    let funds = _allFunds.filter(f => f.centricity_score_status === 'Ranked');
    funds = funds.filter(f => subClasses.includes(f.sub_category_class));
    if (catSel.length > 0) funds = funds.filter(f => catSel.includes(f.category));
    if (amcSel.length > 0) funds = funds.filter(f => amcSel.includes(f.amc));
    if (aumMin != null) funds = funds.filter(f => (f.aum_cr || 0) >= aumMin);
    if (aumMax != null) funds = funds.filter(f => (f.aum_cr || 0) <= aumMax);
    if (sharpeMin != null) funds = funds.filter(f => (f.risk_metrics?.sharpe_3y ?? -Infinity) >= sharpeMin);
    if (search) {
      funds = funds.filter(f =>
        (f.fund_name || '').toLowerCase().includes(search) ||
        (f.amc || '').toLowerCase().includes(search) ||
        String(f.scheme_code || '').includes(search)
      );
    }

    // Recompute score per fund using current weights (Excel-locked OR analyst-edited)
    funds = funds.map(f => {
      const recScore = DataLoader.recomputeScore(f, ws);
      return Object.assign({}, f, { _recScore: recScore });
    });
    if (scoreMinPct != null) funds = funds.filter(f => (f._recScore == null ? -1 : f._recScore * 100) >= scoreMinPct);

    funds.sort(comparator(_sortKey, _sortDir));

    _filteredFunds = funds;
    document.getElementById('resultCount').textContent = funds.length.toLocaleString('en-IN');
    renderTable(funds);
    document.getElementById('compareBtn').disabled = _selected.size < 2;
    document.getElementById('compareCount').textContent = String(_selected.size);
  }

  function comparator(key, dir) {
    const m = dir === 'asc' ? 1 : -1;
    const access = (f) => {
      switch (key) {
        case 'rank':     return f.centricity_rank_overall;
        case 'name':     return (f.fund_name || '').toLowerCase();
        case 'category': return (f.category || '').toLowerCase();
        case 'amc':      return (f.amc || '').toLowerCase();
        case 'aum':      return f.aum_cr;
        case 'r1':       return f.trailing_returns?.return_1y_pct;
        case 'r3':       return f.trailing_returns?.return_3y_pct;
        case 'r5':       return f.trailing_returns?.return_5y_pct;
        case 'sharpe':   return f.risk_metrics?.sharpe_3y;
        case 'beta':     return f.risk_metrics?.beta_3y;
        case 'ter':      return f.ter_pct;
        case 'score':    return f._recScore;
        default: return null;
      }
    };
    return (a, b) => {
      const av = access(a), bv = access(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * m;
      if (av > bv) return 1 * m;
      return 0;
    };
  }

  function numOrNull(id) {
    const v = document.getElementById(id).value;
    if (v === '' || v == null) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  function renderTable(funds) {
    const wrap = document.getElementById('tableWrap');
    if (funds.length === 0) {
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="ring-motif"></div>
          <h3>No funds match the current filters</h3>
          <p>Try widening the AUM range, lowering the Score / Sharpe minimums, or adding more
             categories / AMCs to the multi-selects.</p>
        </div>`;
      return;
    }

    const headers = [
      { key: '_check',    label: '',         sortable: false },
      { key: 'rank',      label: 'Rank',     sortable: true  },
      { key: 'name',      label: 'Fund / AMC', sortable: true, leftAlign: true },
      { key: 'category',  label: 'Category', sortable: true  },
      { key: 'aum',       label: 'AUM ₹ Cr', sortable: true  },
      { key: 'r1',        label: '1Y',       sortable: true  },
      { key: 'r3',        label: '3Y',       sortable: true  },
      { key: 'r5',        label: '5Y',       sortable: true  },
      { key: 'sharpe',    label: 'Sharpe',   sortable: true  },
      { key: 'beta',      label: 'Beta',     sortable: true  },
      { key: 'ter',       label: 'TER',      sortable: true  },
      { key: 'score',     label: 'Score',    sortable: true  },
    ];

    const head = `
      <thead><tr>
        ${headers.map(h => `<th data-key="${h.key}" class="${_sortKey === h.key ? 'sorted' : ''}">${escapeHtml(h.label)}<span class="arr">${_sortDir === 'asc' ? '▴' : '▾'}</span></th>`).join('')}
      </tr></thead>`;

    const rows = funds.map(f => {
      const r1 = f.trailing_returns?.return_1y_pct;
      const r3 = f.trailing_returns?.return_3y_pct;
      const r5 = f.trailing_returns?.return_5y_pct;
      const sharpe = f.risk_metrics?.sharpe_3y;
      const beta = f.risk_metrics?.beta_3y;
      const ter = f.ter_pct;
      const score = f._recScore;
      const checked = _selected.has(f.scheme_code);
      return `
        <tr data-scheme="${f.scheme_code}" class="${checked ? 'selected' : ''}">
          <td><span class="check ${checked ? 'checked' : ''}" data-toggle></span></td>
          <td><span class="num">${f.centricity_rank_overall ?? '—'}</span></td>
          <td class="fund-cell">
            <div class="fund-name">${escapeHtml(f.fund_name)}</div>
            <div class="fund-sub">${escapeHtml(f.amc)} · #${f.scheme_code}</div>
          </td>
          <td>${escapeHtml(f.category)}</td>
          <td class="num">₹ ${DataLoader.fmtINR(f.aum_cr)}</td>
          <td class="${DataLoader.pctClass(r1)}">${DataLoader.fmtPct(r1)}</td>
          <td class="${DataLoader.pctClass(r3)}">${DataLoader.fmtPct(r3)}</td>
          <td class="${DataLoader.pctClass(r5)}">${DataLoader.fmtPct(r5)}</td>
          <td class="num">${DataLoader.fmtNum(sharpe)}</td>
          <td class="num">${DataLoader.fmtNum(beta)}</td>
          <td class="num">${DataLoader.fmtNum(ter)}</td>
          <td class="num">
            <span class="score-cell">
              <span class="score-bar"><i style="width:${score != null ? Math.max(0, Math.min(1, score)) * 100 : 0}%"></i></span>
              <b>${DataLoader.fmtScorePct(score)}</b>
            </span>
          </td>
        </tr>`;
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
      if (k === '_check') return;
      th.addEventListener('click', () => {
        if (_sortKey === k) _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
        else { _sortKey = k; _sortDir = 'desc'; }
        applyAndRender();
        writeUrlState();
      });
    });

    // Row click — toggle compare-select on checkbox; else navigate to fund detail
    wrap.querySelectorAll('tbody tr').forEach(tr => {
      tr.addEventListener('click', (e) => {
        const code = Number(tr.getAttribute('data-scheme'));
        if (e.target.closest('[data-toggle]') || e.target.classList.contains('check')) {
          if (_selected.has(code)) _selected.delete(code);
          else _selected.add(code);
          applyAndRender();
        } else {
          window.location.href = `fund-detail.html?scheme=${code}`;
        }
      });
    });
  }

  /* ---------- toolbar ---------- */
  function initToolbar() {
    document.getElementById('searchInput').addEventListener('input', () => {
      applyAndRender();
      writeUrlState();
    });

    document.getElementById('compareBtn').addEventListener('click', () => {
      if (_selected.size < 2) return;
      const codes = Array.from(_selected).join(',');
      window.location.href = `compare.html?funds=${codes}`;
    });

    document.getElementById('copyLinkBtn').addEventListener('click', () => {
      const url = window.location.href;
      try {
        navigator.clipboard.writeText(url).then(() => showToast('Link copied to clipboard.'));
      } catch (e) {
        showToast('Copy failed — copy URL from address bar.');
      }
    });
  }

  /* ---------- URL state ---------- */
  function writeUrlState() {
    const p = new URLSearchParams();
    const ac = _acMS.getSelected();
    if (ac.length < 3) p.set('ac', ac.join(','));
    const cat = _catMS.getSelected();
    const fullCats = buildCategoryItems(ac).filter(i => !i.disabled).map(i => i.value);
    if (cat.length !== fullCats.length) p.set('cat', cat.join(','));
    const amc = _amcMS.getSelected();
    if (amc.length !== buildAmcItems().length) p.set('amc', amc.join(','));
    if (_sortKey !== 'score' || _sortDir !== 'desc') p.set('sort', _sortKey + '_' + _sortDir);
    ['aumMin', 'aumMax', 'sharpeMin', 'scoreMin'].forEach(id => {
      const v = document.getElementById(id).value;
      if (v) p.set(id, v);
    });
    const q = (document.getElementById('searchInput').value || '').trim();
    if (q) p.set('q', q);
    if (_customWeights) {
      Object.entries(_customWeights).forEach(([k, v]) => {
        p.set('w_' + k.toLowerCase().replace(/[^a-z0-9]+/g, '_'), v);
      });
    }
    const newUrl = p.toString() ? '?' + p.toString() : window.location.pathname;
    window.history.replaceState({}, '', newUrl);
  }

  function parseUrlState() {
    const p = new URLSearchParams(window.location.search);
    if (p.has('ac')) {
      const v = p.get('ac').split(',').filter(Boolean);
      _acMS.setSelected(v);
      rebuildCategoryItems();
    }
    if (p.has('cat')) {
      _catMS.setSelected(p.get('cat').split(',').filter(Boolean));
    }
    if (p.has('amc')) {
      _amcMS.setSelected(p.get('amc').split(',').filter(Boolean));
    }
    if (p.has('sort')) {
      const [k, d] = p.get('sort').split('_');
      _sortKey = k;
      _sortDir = (d === 'asc' || d === 'desc') ? d : 'desc';
    }
    ['aumMin', 'aumMax', 'sharpeMin', 'scoreMin'].forEach(id => {
      if (p.has(id)) document.getElementById(id).value = p.get(id);
    });
    if (p.has('q')) document.getElementById('searchInput').value = p.get('q');
    // Weight overrides — w_<param> with snake-case lower
    const weightLookup = new Map(_scoringWeights.map(w => [w.parameter.toLowerCase().replace(/[^a-z0-9]+/g, '_'), w.parameter]));
    p.forEach((value, key) => {
      if (key.startsWith('w_')) {
        const slug = key.slice(2);
        const param = weightLookup.get(slug);
        if (param) {
          if (!_customWeights) _customWeights = {};
          _customWeights[param] = parseFloat(value);
        }
      }
    });
    if (_customWeights) {
      AppState.setCustomWeights(_customWeights);
      renderWeightSliders();
    }
  }

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
