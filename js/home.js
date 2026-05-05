/*
 * Centricity MF Screener Dashboard — index.html (Home) page logic
 *
 * ⚠️  EXCEL-LOCKED WEIGHTS — DO NOT CALL DataLoader.recomputeScore() HERE.
 *
 * Home reads `fund.centricity_score` and `fund.centricity_rank_overall`
 * directly from the cycle JSON. Those values were computed by the Excel
 * using Master Table 2 weights at cycle build time, locked by the Products
 * Team. Home is the canonical "what the team recommends right now" view —
 * and that view stays anchored to the Products Team's locked weights, NOT
 * any one analyst's slider exploration.
 *
 * The Screener page's right-drawer weight-edit feature is the ONLY place
 * `DataLoader.recomputeScore(fund, weights)` is invoked. Personal tweaks
 * never propagate to Home / Compare / Fund Detail / Portfolio Builder.
 *
 * When the next cycle's Excel ships with revised Master Table 2 weights,
 * the new `centricity_score` in the JSON reflects those, and Home picks
 * them up automatically — no UI change.
 *
 * See Skills/mf-dashboard-build/SKILL.md §7 — "Excel-locked weights" decision (2026-05-05).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * Sections wired:
 *   - Hero heading + subtitle      ← cycle_meta.{cycle_label, total_funds, ...}
 *   - Hero meta-strip              ← same
 *   - Hero cycle picker            ← listCycles()
 *   - Top-10 Centricity Rank       ← MultiSelect Asset Class (Equity / Debt / Hybrid)
 *                                    × MultiSelect SEBI Category (cascades from Asset Class)
 *                                    Persistence: home.top10_assetclasses + home.top10_categories
 *   - Active Flags                 ← cycle_meta.flag_summary; empty state when null/0
 *   - "What changed" cards         ← v1: empty state per card (no previous cycle yet)
 *   - Footer "Last updated"        ← cycle_meta.cycle_date
 */
(function () {
  'use strict';

  let _currentCycle = null;
  let _currentManifest = null;
  let _assetClassMS = null;
  let _categoryMS = null;
  let _topSortState = { key: 'centricity_rank_overall', dir: 'asc' };

  document.addEventListener('DOMContentLoaded', main);

  async function main() {
    let manifest, cycle;
    try {
      manifest = await DataLoader.listCycles();
      const lastVisited = AppState.getLastVisitedCycle();
      const initialDate = (lastVisited && manifest.cycles.find(c => c.date === lastVisited))
        ? lastVisited
        : (manifest.latest || manifest.cycles[0].date);
      cycle = await DataLoader.loadCycle(initialDate);
      AppState.setLastVisitedCycle(initialDate);
    } catch (err) {
      renderLoadError(err);
      return;
    }

    _currentManifest = manifest;
    _currentCycle = cycle;

    populateCyclePicker(manifest, cycle.cycle_meta.cycle_date);
    renderHero(cycle);
    renderQuickTiles(cycle);
    initFilters(cycle);             // creates the two MultiSelects
    renderActiveFlags(cycle);
    renderChanges(cycle);
    renderFooter(cycle);
    initToasts();

    document.getElementById('cycleSel').addEventListener('change', async (e) => {
      const newDate = e.target.value;
      try {
        const newCycle = await DataLoader.loadCycle(newDate);
        AppState.setLastVisitedCycle(newDate);
        _currentCycle = newCycle;
        renderHero(newCycle);
        renderQuickTiles(newCycle);
        // Refresh the category MS items in case the new cycle has a different
        // category list (universe drift handled by Designed-for-Change rule 1).
        rebuildCategoryItems();
        renderTopTable();
        renderActiveFlags(newCycle);
        renderChanges(newCycle);
        renderFooter(newCycle);
      } catch (err) {
        showToast('Could not load cycle ' + newDate);
      }
    });
  }

  /* --------- error shell --------- */
  function renderLoadError(err) {
    const main = document.getElementById('mainArea') || document.body;
    main.innerHTML = `
      <div class="empty-state" style="margin:48px 56px;">
        <div class="ring-motif" aria-hidden="true"></div>
        <h3>Could not load cycle data</h3>
        <p>The cycle JSON could not be fetched. If you're viewing the dashboard
           locally, serve it via a static HTTP server (e.g. <code>python -m http.server 8000</code>)
           rather than opening the file directly.<br><br>
           <span style="color:var(--red)">${(err && err.message) || err}</span></p>
      </div>`;
  }

  /* --------- hero --------- */
  function renderHero(cycle) {
    const m = cycle.cycle_meta;
    document.getElementById('heroEyebrow').innerHTML =
      `<span class="bar"></span><b>Update as on ${m.as_on_display}</b>`;
    document.getElementById('heroTitle').innerHTML =
      `Centricity Mutual Fund Screener<span class="sep">·</span><span class="cycle-tag">${escapeHtml(m.cycle_label)}</span>`;
    document.getElementById('heroLede').textContent =
      `${m.total_funds.toLocaleString('en-IN')} funds across ${m.category_count} SEBI categories, ` +
      `ranked on Products Team framework. As on ${m.as_on_display}.`;
    document.getElementById('heroFunds').textContent = m.total_funds.toLocaleString('en-IN');
    document.getElementById('heroCats').textContent = m.category_count;
    document.getElementById('heroDate').textContent = m.as_on_display;
  }

  function populateCyclePicker(manifest, currentDate) {
    const sel = document.getElementById('cycleSel');
    sel.innerHTML = '';
    const cycles = (manifest && manifest.cycles) || [];
    if (cycles.length === 0) {
      const o = document.createElement('option');
      o.value = currentDate; o.textContent = currentDate; o.selected = true;
      sel.appendChild(o); return;
    }
    [...cycles].sort((a, b) => (a.date < b.date ? 1 : -1)).forEach(c => {
      const o = document.createElement('option');
      o.value = c.date;
      o.textContent = c.label || DataLoader.fmtDate(c.date);
      if (c.date === currentDate) o.selected = true;
      sel.appendChild(o);
    });
  }

  /* --------- quick-action tiles ---------
     Tile-footer .meta strips removed per Cowork direction 2026-05-05 —
     no AppState bindings here for tile captions. The state getters
     (getWatchlist, getSavedPortfolios) remain in AppState for use elsewhere
     (Watchlist / Portfolio Builder pages). */
  function renderQuickTiles(cycle) {
    const m = cycle.cycle_meta;
    const screenerCopy = document.getElementById('qScreenerCopy');
    if (screenerCopy) {
      screenerCopy.textContent =
        `${m.total_funds.toLocaleString('en-IN')} funds, ${(m.scoring_weights || []).length} scoring parameters, ` +
        `every column sortable, weights live-editable.`;
    }
  }

  /* --------- filters (two cascading MultiSelects) --------- */
  function initFilters(cycle) {
    const m = cycle.cycle_meta;

    // Asset Class items — locked v1 set; future PMS / AIF land as additional
    // top-level options (per CLAUDE.md §4.1 4×3 grid). Order is Cowork-locked:
    // Equity, Debt, Hybrid.
    const assetClassItems = [
      { value: 'equity', label: 'Equity' },
      { value: 'debt',   label: 'Debt'   },
      { value: 'hybrid', label: 'Hybrid' },
    ];

    const initialAC = AppState.getTop10AssetClasses();

    _assetClassMS = MultiSelect.create(document.getElementById('assetClassMS'), {
      items: assetClassItems,
      selected: initialAC,
      label: 'Asset class',
      allLabel: 'All asset classes',
      noneLabel: 'None selected',
      oneLabel: (item) => `${item.label} only`,
      manyLabel: (n) => `${n} selected`,
      searchPlaceholder: 'Search asset class…',
      groups: false,
      onChange: (sel) => {
        AppState.setTop10AssetClasses(sel);
        rebuildCategoryItems();
        renderTopTable();
      },
    });

    _categoryMS = MultiSelect.create(document.getElementById('categoryMS'), {
      items: buildCategoryItems(initialAC, cycle),
      selected: resolveInitialCategorySelection(initialAC, cycle),
      label: 'SEBI category',
      allLabel: 'All categories',
      noneLabel: 'None selected',
      oneLabel: (item) => `${item.label} only`,
      manyLabel: (n) => `${n} selected`,
      searchPlaceholder: 'Search category…',
      groups: true,
      onChange: (sel) => {
        AppState.setTop10Categories(sel);
        renderTopTable();
      },
    });

    renderTopTable();
  }

  /**
   * Build the SEBI category MultiSelect's items array based on which asset
   * classes are checked. Equity → 21 equity categories; Hybrid → 5 hybrid;
   * Debt → single greyed-out "pending v1.x" placeholder row.
   */
  function buildCategoryItems(assetClasses, cycle) {
    if (!cycle) cycle = _currentCycle;
    const cats = (cycle.cycle_meta.categories || []);
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
        value: '__debt_pending__',
        label: 'Debt categories — pending v1.x',
        group: 'Debt',
        disabled: true,
      });
    }
    return items;
  }

  function resolveInitialCategorySelection(assetClasses, cycle) {
    const persisted = AppState.getTop10Categories();
    const items = buildCategoryItems(assetClasses, cycle);
    const enabledNames = items.filter(i => !i.disabled).map(i => i.value);
    if (Array.isArray(persisted) && persisted.length > 0) {
      // intersect persisted with currently visible (rebuild dropped some)
      return persisted.filter(n => enabledNames.includes(n));
    }
    // First-load default: all visible categories checked
    return enabledNames;
  }

  function rebuildCategoryItems() {
    const ac = _assetClassMS.getSelected();
    const newItems = buildCategoryItems(ac, _currentCycle);
    _categoryMS.refresh(newItems, { defaultCheckNew: true });
  }

  /* --------- top-10 table (asset-class × category aware) --------- */
  function renderTopTable() {
    const cycle = _currentCycle;
    const wrap = document.getElementById('top10Wrap');
    const selectedAssetClasses = _assetClassMS ? _assetClassMS.getSelected() : ['equity', 'debt', 'hybrid'];
    const selectedCategories = _categoryMS ? _categoryMS.getSelected() : [];

    // Empty states — order matters
    if (selectedAssetClasses.length === 0) {
      wrap.innerHTML = emptyState('Select at least one asset class', 'Use the Asset Class filter above to choose Equity, Debt, and/or Hybrid.');
      return;
    }
    if (selectedAssetClasses.length === 1 && selectedAssetClasses[0] === 'debt') {
      wrap.innerHTML = emptyState(
        'Debt MF Screener pipeline pending — coming in v1.x',
        'Debt Analytics underlyings already exist; rankings will be wired when the upstream Debt Whitelisting skill ships its first cycle Excel.'
      );
      return;
    }
    if (selectedCategories.length === 0) {
      wrap.innerHTML = emptyState('Select at least one category', 'Use the SEBI Category filter above to pick at least one category from the asset classes you\'ve selected.');
      return;
    }

    const subClassMap = { equity: 'Equity', hybrid: 'Hybrid', debt: 'Debt' };
    const selectedSubClasses = selectedAssetClasses.map(s => subClassMap[s]);

    const top = cycle.funds
      .filter(f => f.centricity_score_status === 'Ranked')
      .filter(f => selectedSubClasses.includes(f.sub_category_class))
      .filter(f => selectedCategories.includes(f.category))
      .sort((a, b) => (a.centricity_rank_overall || 9999) - (b.centricity_rank_overall || 9999))
      .slice(0, 10);

    if (top.length === 0) {
      wrap.innerHTML = emptyState(
        'No funds match the current filter',
        'Try selecting more categories or asset classes.'
      );
      return;
    }

    // Restore the table shell if we just came from an empty state
    if (!wrap.querySelector('table.fund-tbl')) {
      wrap.innerHTML = `
        <table class="fund-tbl" id="topTbl">
          <thead>
            <tr>
              <th data-key="centricity_rank_overall" class="sorted">Rank<span class="arr">▴</span></th>
              <th data-key="fund_name">Fund / AMC<span class="arr">▾</span></th>
              <th data-key="category">Category<span class="arr">▾</span></th>
              <th data-key="aum_cr">AUM ₹ Cr<span class="arr">▾</span></th>
              <th data-key="r1">1Y %<span class="arr">▾</span></th>
              <th data-key="r3">3Y %<span class="arr">▾</span></th>
              <th data-key="r5">5Y %<span class="arr">▾</span></th>
              <th data-key="sharpe">Sharpe<span class="arr">▾</span></th>
              <th data-key="score">Score<span class="arr">▾</span></th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>`;
    }

    const sorted = sortTop(top, _topSortState);
    const tbody = wrap.querySelector('tbody');
    tbody.innerHTML = sorted.map(f => {
      const r1 = f.trailing_returns?.return_1y_pct;
      const r3 = f.trailing_returns?.return_3y_pct;
      const r5 = f.trailing_returns?.return_5y_pct;
      const sharpe = f.risk_metrics?.sharpe_3y;
      const score = f.centricity_score;  // ← from JSON, NOT recomputed
      const rankBadge = f.centricity_rank_overall;
      const subline = `${escapeHtml(f.amc)} · #${f.scheme_code}`;
      return `
        <tr tabindex="0" data-scheme="${f.scheme_code}">
          <td><span class="rank num">${rankBadge != null ? rankBadge : '—'}</span></td>
          <td><div class="fund-name">${escapeHtml(f.fund_name)}</div><div class="fund-sub">${subline}</div></td>
          <td>${escapeHtml(f.category)}</td>
          <td class="num">₹ ${DataLoader.fmtINR(f.aum_cr)}</td>
          <td class="${DataLoader.pctClass(r1)}">${DataLoader.fmtPct(r1)}</td>
          <td class="${DataLoader.pctClass(r3)}">${DataLoader.fmtPct(r3)}</td>
          <td class="${DataLoader.pctClass(r5)}">${DataLoader.fmtPct(r5)}</td>
          <td class="num">${DataLoader.fmtNum(sharpe)}</td>
          <td class="num">
            <span class="score-cell">
              <span class="score-bar"><i style="width:${score != null ? Math.max(0, Math.min(1, score)) * 100 : 0}%"></i></span>
              <b>${DataLoader.fmtScorePct(score)}</b>
            </span>
          </td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('tr').forEach(tr => {
      tr.addEventListener('click', () => {
        const code = tr.getAttribute('data-scheme');
        window.location.href = `fund-detail.html?scheme=${code}`;
      });
    });

    wrap.querySelectorAll('thead th').forEach(th => {
      const k = th.getAttribute('data-key');
      th.classList.toggle('sorted', k === _topSortState.key);
      const arr = th.querySelector('.arr');
      if (arr) arr.textContent = _topSortState.dir === 'asc' ? '▴' : '▾';
      th.onclick = () => {
        if (_topSortState.key === k) _topSortState.dir = _topSortState.dir === 'asc' ? 'desc' : 'asc';
        else { _topSortState.key = k; _topSortState.dir = 'desc'; }
        renderTopTable();
      };
    });
  }

  function emptyState(title, body) {
    return `
      <div class="empty-state">
        <div class="ring-motif" aria-hidden="true"></div>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(body)}</p>
      </div>`;
  }

  function sortTop(funds, state) {
    const dir = state.dir === 'asc' ? 1 : -1;
    const key = state.key;
    const access = (f) => {
      switch (key) {
        case 'centricity_rank_overall': return f.centricity_rank_overall;
        case 'fund_name': return (f.fund_name || '').toLowerCase();
        case 'category':  return (f.category || '').toLowerCase();
        case 'aum_cr':    return f.aum_cr;
        case 'r1':        return f.trailing_returns?.return_1y_pct;
        case 'r3':        return f.trailing_returns?.return_3y_pct;
        case 'r5':        return f.trailing_returns?.return_5y_pct;
        case 'sharpe':    return f.risk_metrics?.sharpe_3y;
        case 'score':     return f.centricity_score;
        default: return null;
      }
    };
    return [...funds].sort((a, b) => {
      const av = access(a), bv = access(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }

  /* --------- Active Flags (v1: empty state when flag_summary null/0) --------- */
  function renderActiveFlags(cycle) {
    const row = document.getElementById('alertsRow');
    const summary = cycle.cycle_meta.flag_summary;
    const total = summary ? Number(summary.total_flags || 0) : null;
    if (summary == null || total === 0) {
      row.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="ring-motif" aria-hidden="true"></div>
          <h3>No flags this cycle</h3>
          <p>First auto-flags will populate from the next cycle (30 April 2026) onwards.
             Cycle-to-cycle deltas require a prior cycle to diff against.</p>
        </div>`;
      return;
    }
    row.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <div class="ring-motif" aria-hidden="true"></div>
        <h3>${total} flag${total === 1 ? '' : 's'} this cycle</h3>
        <p>Flag rendering ships with v1.x compute_cycle_flags.py post-processor —
           summary present in this JSON but per-flag UI not yet wired here. View full panel:
           <a href="alerts.html">Alerts</a>.</p>
      </div>`;
  }

  /* --------- "what changed" --------- */
  function renderChanges(cycle) {
    const grid = document.getElementById('changesGrid');
    const labels = ['New entrants', 'Funds dropped', 'Top 5 ranking gainers', 'Top 5 ranking losers', 'Manager exits'];
    grid.innerHTML = labels.map(label => `
      <div class="change-card empty" aria-disabled="true">
        <div class="hd"><span class="lbl">${label}</span><span class="count num">—</span></div>
        <div class="body">No previous cycle to compare against — this card will populate from the next cycle onwards.</div>
        <div class="foot"><span>Awaiting next cycle</span></div>
      </div>`).join('');
    const sub = document.getElementById('changesSub');
    if (sub) {
      sub.textContent = `Cycle-over-cycle deltas. With only one cycle (${cycle.cycle_meta.cycle_label}) ` +
        `currently in the archive, comparison cards are empty until the next refresh.`;
    }
  }

  function renderFooter(cycle) {
    const m = cycle.cycle_meta;
    const updated = document.getElementById('footUpdated');
    if (updated) updated.textContent = `Last updated · ${m.as_on_display}`;
  }

  function initToasts() {
    document.querySelectorAll('[data-toast]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (el.tagName === 'A') e.preventDefault();
        showToast(el.getAttribute('data-toast'));
      });
    });
  }
  let toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t || !msg) return;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
