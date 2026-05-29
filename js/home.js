/*
 * Centricity MF Screener Dashboard — index.html (Home) page logic
 *
 * ⚠️  EXCEL-LOCKED WEIGHTS — DO NOT CALL DataLoader.recomputeScore() HERE.
 *
 * Home reads `fund.centricity_score` and `fund.centricity_rank_in_category`
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
 *   - Hero heading + subtitle      ← cycle_meta.{cycle_label_date, total_funds, ...}
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
  let _topSortState = { key: 'centricity_rank_in_category', dir: 'asc' };

  document.addEventListener('DOMContentLoaded', main);

  async function main() {
    let manifest, cycle;
    try {
      manifest = await Cycle.getManifest();
      const initialDate = await Cycle.getActiveCycle();
      cycle = await DataLoader.loadCycle(initialDate);
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
    renderExplore(cycle);
    renderChanges(cycle);
    renderFooter(cycle);
    initToasts();

    document.getElementById('cycleSel').addEventListener('change', async (e) => {
      const newDate = e.target.value;
      try {
        const newCycle = await DataLoader.loadCycle(newDate);
        await Cycle.setActiveCycle(newDate);
        _currentCycle = newCycle;
        renderHero(newCycle);
        renderQuickTiles(newCycle);
        // Refresh the category MS items in case the new cycle has a different
        // category list (universe drift handled by Designed-for-Change rule 1).
        rebuildCategoryItems();
        renderTopTable();
        renderActiveFlags(newCycle);
        renderExplore(newCycle);
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
      `Centricity Mutual Fund Screener<span class="sep">·</span><span class="cycle-tag">${escapeHtml(DataLoader.fmtCycleLabelDate(m))}</span>`;
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
      o.textContent = DataLoader.fmtCycleLabelDate(c.date);
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

    // Asset Class items — Debt removed from the Top-10 chooser universe-wide
    // (D6): debt funds aren't scored (no centricity_score), so they can't
    // compete for ranked Top-10 slots. They remain in the Explore counts and
    // the screener. Only the two scored asset classes are offered here.
    const assetClassItems = [
      { value: 'equity', label: 'Equity' },
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
    const selectedAssetClasses = _assetClassMS ? _assetClassMS.getSelected() : [];
    const selectedCategories = _categoryMS ? _categoryMS.getSelected() : [];

    // Empty state (D6) — cold-load opens with NOTHING selected, so the Top-10
    // shows a single CTA (gold accent on "Select") rather than auto-selecting
    // every category. Same copy when the user unchecks all categories.
    if (selectedAssetClasses.length === 0 || selectedCategories.length === 0) {
      wrap.innerHTML = emptyStateCTA();
      return;
    }

    const subClassMap = { equity: 'Equity', hybrid: 'Hybrid', debt: 'Debt' };
    const selectedSubClasses = selectedAssetClasses.map(s => subClassMap[s]);

    // Stage B B3 — pooled Top-10 across the selected category set, sorted by
    // centricity_score desc. category-rank sort would tie every category #1
    // (one per category) which is meaningless across categories per §7.3.
    const top = cycle.funds
      .filter(f => f.centricity_score_status === 'Ranked')
      .filter(f => selectedSubClasses.includes(f.sub_category_class))
      .filter(f => selectedCategories.includes(f.category))
      .sort((a, b) => (b.centricity_score || 0) - (a.centricity_score || 0))
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
              <th data-key="centricity_rank_in_category" class="sorted">Rank<span class="arr">▴</span></th>
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
      const rankBadge = f.centricity_rank_in_category;
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

  /** D6 — cold-load / nothing-selected CTA for the Top-10 leaderboard.
   *  Gold accent on "Select"; Cambria inherited from the brand foundation. */
  function emptyStateCTA() {
    return `
      <div class="empty-state">
        <div class="ring-motif" aria-hidden="true"></div>
        <h3><span style="color:var(--gold,#BD9568)">Select</span> at least one category to see the leaderboard.</h3>
        <p>Pick an asset class — Equity or Hybrid — and its categories load automatically; then refine by SEBI category.</p>
      </div>`;
  }

  function sortTop(funds, state) {
    const dir = state.dir === 'asc' ? 1 : -1;
    const key = state.key;
    const access = (f) => {
      switch (key) {
        case 'centricity_rank_in_category': return f.centricity_rank_in_category;
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

  /* --------- Active Flags (Stage B B3 — cycle_flags driven) --------- */
  const ACTIVE_FLAG_AUM_CR = 50000;   // AUM threshold per spec

  function renderActiveFlags(cycle) {
    const row = document.getElementById('alertsRow');
    const cycles = _currentManifest && _currentManifest.cycles;
    if (!cycles || cycles.length < 2) {
      row.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="ring-motif" aria-hidden="true"></div>
          <h3>No prior cycle to compare against</h3>
          <p>First auto-flags will populate from the next cycle onwards.
             Cycle-over-cycle deltas require a prior cycle to diff against.</p>
        </div>`;
      return;
    }

    // Severity order (kickoff): manager_change > big AUM swing > rank change
    //                          > return swing > status change.
    const severityScore = (cf) => {
      if (!cf) return 0;
      let s = 0;
      if (cf.manager_change)              s += 10;
      if (cf.aum_swing_pct != null)       s += 8;
      if (cf.rank_change_in_category != null) s += 6;
      if (cf.return_1y_swing_pct != null) s += 4;
      if (cf.status_change)               s += 5;
      return s;
    };

    const flagged = (cycle.funds || [])
      .filter(f => (f.aum_cr || 0) >= ACTIVE_FLAG_AUM_CR)
      .map(f => ({ fund: f, score: severityScore(f.cycle_flags) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.fund.aum_cr || 0) - (a.fund.aum_cr || 0))
      .slice(0, 3);

    if (flagged.length === 0) {
      row.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="ring-motif" aria-hidden="true"></div>
          <h3>No active flags this cycle</h3>
          <p>No funds with AUM ≥ ₹${DataLoader.fmtINR(ACTIVE_FLAG_AUM_CR)} Cr crossed the cycle-over-cycle thresholds.</p>
        </div>`;
      return;
    }

    row.innerHTML = flagged.map(({ fund, score }) => {
      const cf = fund.cycle_flags || {};
      const tags = [];
      if (cf.manager_change) {
        tags.push(`<span class="flag-tag flag-mgr">Manager change · <b>${escapeHtml(cf.manager_change.prior)}</b> → <b>${escapeHtml(cf.manager_change.current)}</b></span>`);
      }
      if (cf.aum_swing_pct != null) {
        const dir = cf.aum_swing_pct >= 0 ? '+' : '−';
        const cls = cf.aum_swing_pct >= 0 ? '' : ' neg';
        tags.push(`<span class="flag-tag${cls}">AUM swing · <b>${dir}${Math.abs(cf.aum_swing_pct).toFixed(1)}%</b></span>`);
      }
      if (cf.rank_change_in_category != null) {
        const delta = cf.rank_change_in_category;
        const cls = delta < 0 ? '' : ' neg';
        tags.push(`<span class="flag-tag${cls}">Category-rank shift · <b>${delta > 0 ? '+' : ''}${delta}</b></span>`);
      }
      if (cf.return_1y_swing_pct != null) {
        const v = cf.return_1y_swing_pct;
        const cls = v < 0 ? ' neg' : '';
        const sign = v >= 0 ? '+' : '−';
        tags.push(`<span class="flag-tag${cls}">1Y return swing · <b>${sign}${Math.abs(v).toFixed(2)}pp</b></span>`);
      }
      if (cf.status_change) {
        tags.push(`<span class="flag-tag">Status change · <b>${escapeHtml(cf.status_change.prior)}</b> → <b>${escapeHtml(cf.status_change.current)}</b></span>`);
      }
      return `
        <a class="alert-card" href="fund-detail.html?scheme=${fund.scheme_code}">
          <div class="alert-hd">
            <h3>${escapeHtml(fund.fund_name)}</h3>
            <span class="alert-aum num">₹ ${DataLoader.fmtINR(fund.aum_cr)} Cr</span>
          </div>
          <div class="alert-cat">${escapeHtml(fund.amc || '')} · ${escapeHtml(fund.category || '')}</div>
          <div class="alert-tags">${tags.join('')}</div>
        </a>`;
    }).join('');
  }

  /* --------- "what changed" (Stage B B3 — cycle_flags + universe diff) --------- */
  function renderChanges(cycle) {
    const grid = document.getElementById('changesGrid');
    const sub = document.getElementById('changesSub');
    const cycles = _currentManifest && _currentManifest.cycles;
    if (!cycles || cycles.length < 2) {
      const labels = ['New entrants', 'Funds dropped', 'Top 5 ranking gainers', 'Top 5 ranking losers', 'Manager exits'];
      grid.innerHTML = labels.map(label => `
        <div class="change-card empty" aria-disabled="true">
          <div class="hd"><span class="lbl">${label}</span><span class="count num">—</span></div>
          <div class="body">No prior cycle to compare against — this card will populate from the next cycle onwards.</div>
          <div class="foot"><span>Awaiting next cycle</span></div>
        </div>`).join('');
      if (sub) {
        sub.textContent = `Cycle-over-cycle deltas. With only one cycle (${DataLoader.fmtCycleLabelDate(cycle.cycle_meta)}) ` +
          `currently in the archive, comparison cards are empty until the next refresh.`;
      }
      return;
    }
    // Identify the prior cycle (next-most-recent before active) for the "dropped" diff.
    const sorted = cycles.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const activeIdx = sorted.findIndex(c => c.date === cycle.cycle_meta.cycle_date);
    const priorEntry = activeIdx >= 0 && activeIdx < sorted.length - 1 ? sorted[activeIdx + 1] : sorted[1] || null;
    if (sub) {
      sub.textContent = priorEntry
        ? `Cycle-over-cycle deltas vs ${DataLoader.fmtCycleLabelDate(priorEntry.date)}.`
        : `Cycle-over-cycle deltas.`;
    }

    // Source funds with cycle_flags
    const funds = cycle.funds || [];
    const newEntrants = funds.filter(f => (f.cycle_flags || {}).is_new_in_cycle);
    const managerExits = funds.filter(f => (f.cycle_flags || {}).manager_change != null);
    const rankChanged = funds
      .map(f => ({ fund: f, delta: (f.cycle_flags || {}).rank_change_in_category }))
      .filter(x => typeof x.delta === 'number');
    const gainers = rankChanged.slice().filter(x => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5);
    const losers  = rankChanged.slice().filter(x => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5);

    // Render the 5 cards. "Funds dropped" requires loading the prior cycle.
    const renderTopList = (xs, fmt) => xs.slice(0, 5).map(fmt).join('') || '<em>—</em>';

    grid.innerHTML = `
      <div class="change-card">
        <div class="hd"><span class="lbl">New entrants</span><span class="count num">${newEntrants.length}</span></div>
        <div class="body">${renderTopList(newEntrants.slice(0, 5), f => `<div><a href="fund-detail.html?scheme=${f.scheme_code}">${escapeHtml(f.fund_name)}</a></div>`)}</div>
        <div class="foot"><span>Top 5 by appearance</span></div>
      </div>
      <div class="change-card" id="changeDropped">
        <div class="hd"><span class="lbl">Funds dropped</span><span class="count num">—</span></div>
        <div class="body"><em>Loading…</em></div>
        <div class="foot"><span>vs ${priorEntry ? escapeHtml(DataLoader.fmtCycleLabelDate(priorEntry.date)) : '—'}</span></div>
      </div>
      <div class="change-card">
        <div class="hd"><span class="lbl">Top 5 ranking gainers</span><span class="count num">${gainers.length}</span></div>
        <div class="body">${renderTopList(gainers, x => `<div><a href="fund-detail.html?scheme=${x.fund.scheme_code}">${escapeHtml(x.fund.fund_name)}</a> <b>(${x.delta})</b></div>`)}</div>
        <div class="foot"><span>Δ rank in category (negative = up)</span></div>
      </div>
      <div class="change-card">
        <div class="hd"><span class="lbl">Top 5 ranking losers</span><span class="count num">${losers.length}</span></div>
        <div class="body">${renderTopList(losers, x => `<div><a href="fund-detail.html?scheme=${x.fund.scheme_code}">${escapeHtml(x.fund.fund_name)}</a> <b>(+${x.delta})</b></div>`)}</div>
        <div class="foot"><span>Δ rank in category (positive = down)</span></div>
      </div>
      <div class="change-card">
        <div class="hd"><span class="lbl">Manager exits</span><span class="count num">${managerExits.length}</span></div>
        <div class="body">${renderTopList(managerExits.slice(0, 5), f => `<div><a href="fund-detail.html?scheme=${f.scheme_code}">${escapeHtml(f.fund_name)}</a> · ${escapeHtml(f.cycle_flags.manager_change.prior)} → ${escapeHtml(f.cycle_flags.manager_change.current)}</div>`)}</div>
        <div class="foot"><span>Lead manager change</span></div>
      </div>`;

    // Lazy-load prior cycle to compute dropped funds (funds present in prior, absent in active).
    if (priorEntry) {
      DataLoader.loadCycle(priorEntry.date).then(priorCycle => {
        const activeAmfis = new Set((funds).map(f => f.scheme_code));
        const droppedFunds = (priorCycle.funds || []).filter(f => !activeAmfis.has(f.scheme_code));
        const card = document.getElementById('changeDropped');
        if (!card) return;
        card.querySelector('.count').textContent = droppedFunds.length;
        const body = card.querySelector('.body');
        if (droppedFunds.length === 0) {
          body.innerHTML = '<em>None this cycle.</em>';
        } else {
          body.innerHTML = droppedFunds.slice(0, 5).map(f =>
            `<div>${escapeHtml(f.fund_name)}</div>`
          ).join('');
        }
      }).catch(() => {
        const card = document.getElementById('changeDropped');
        if (card) card.querySelector('.body').textContent = 'Could not load prior cycle.';
      });
    }
  }

  /* --------- Explore section (Stage B B3 — asset-class + Active/Passive split) --------- */
  function renderExplore(cycle) {
    const wrap = document.getElementById('exploreWrap');
    if (!wrap) return;
    const funds = cycle.funds || [];
    const byClass = { Equity: 0, Hybrid: 0, Debt: 0, Other: 0 };
    let activeCount = 0, passiveCount = 0;
    for (const f of funds) {
      const c = f.sub_category_class || 'Other';
      byClass[c] = (byClass[c] || 0) + 1;
      if (f.centricity_score_status === 'Index — Not Scored') passiveCount++;
      else activeCount++;
    }
    const total = funds.length;
    const pct = (n) => total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
    wrap.innerHTML = `
      <div class="explore-grid">
        <div class="explore-card">
          <h3>By asset class</h3>
          <div class="explore-row"><span>Equity</span><b class="num">${byClass.Equity}</b><span class="pct">${pct(byClass.Equity)}%</span></div>
          <div class="explore-row"><span>Hybrid</span><b class="num">${byClass.Hybrid}</b><span class="pct">${pct(byClass.Hybrid)}%</span></div>
          <div class="explore-row"><span>Debt</span><b class="num">${byClass.Debt}</b><span class="pct">${pct(byClass.Debt)}%</span></div>
          <p class="explore-foot">Total ${total} funds. Click → Screener.</p>
        </div>
        <div class="explore-card">
          <h3>Active vs Passive</h3>
          <div class="explore-row"><span>Active (Ranked / Warning / New)</span><b class="num">${activeCount}</b><span class="pct">${pct(activeCount)}%</span></div>
          <div class="explore-row"><span>Passive (Index — Not Scored)</span><b class="num">${passiveCount}</b><span class="pct">${pct(passiveCount)}%</span></div>
          <p class="explore-foot">Pie visualization — v1.x.</p>
        </div>
      </div>`;
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
