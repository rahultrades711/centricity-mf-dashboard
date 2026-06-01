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
  let _debtMeta = { count: 0, categoryCount: 0 };   // D7 — debt universe (separate debt-*.json)
  let _otherMeta = { count: 0, byAsset: {} };       // E1 — Other universe (Commodity/FoF/Solution)

  // D7 Active Flags rule — single named block. Canonical source is
  // js/active-flags.js (window.ActiveFlags.RULE), shared with flags.html so the
  // Home panel and the full-list page can never drift; literal fallback below.
  const ACTIVE_FLAGS_RULE = (window.ActiveFlags && window.ActiveFlags.RULE) || {
    AUM_SWING_PCT: 20,
    MANAGER_CHANGE: true,
  };

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
    await loadDebtMeta(cycle.cycle_meta.cycle_date);   // D7 — debt count for hero + Explore
    await loadOtherMeta(cycle.cycle_meta.cycle_date);  // E1 — Other count for hero + Explore

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
        await loadDebtMeta(newDate);
        await loadOtherMeta(newDate);
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

  /* --------- debt universe (D7) — separate debt-<cycle>.json, not scored --------- */
  async function loadDebtMeta(cycleDate) {
    try {
      const res = await fetch(`data/debt-${cycleDate}.json`, { cache: 'default' });
      if (!res.ok) { _debtMeta = { count: 0, categoryCount: 0 }; return; }
      const doc = await res.json();
      const cm = doc.cycle_meta || {};
      _debtMeta = {
        count: Array.isArray(doc.funds) ? doc.funds.length : (cm.total_funds || 0),
        categoryCount: cm.category_count || 0,
      };
    } catch (e) {
      _debtMeta = { count: 0, categoryCount: 0 };
    }
  }

  /* --------- Other universe (E1) — Commodity/FoF/Solution, Not Scored --------- */
  async function loadOtherMeta(cycleDate) {
    try {
      const res = await fetch(`data/other-${cycleDate}.json`, { cache: 'default' });
      if (!res.ok) { _otherMeta = { count: 0, byAsset: {} }; return; }
      const doc = await res.json();
      const cm = doc.cycle_meta || {};
      _otherMeta = {
        count: Array.isArray(doc.funds) ? doc.funds.length : (cm.total_funds || 0),
        byAsset: cm.by_asset_class || {},
      };
    } catch (e) {
      _otherMeta = { count: 0, byAsset: {} };
    }
  }

  /* --------- hero --------- */
  function renderHero(cycle) {
    const m = cycle.cycle_meta;
    const debtN = _debtMeta.count || 0;
    const otherN = _otherMeta.count || 0;                   // E1 — incl. Other
    const totalUniverse = (m.total_funds || 0) + debtN + otherN;
    const totalCats = (m.category_count || 0) + (_debtMeta.categoryCount || 0);
    document.getElementById('heroEyebrow').innerHTML =
      `<span class="bar"></span><b>Update as on ${m.as_on_display}</b>`;
    document.getElementById('heroTitle').innerHTML =
      `Centricity Mutual Fund Screener<span class="sep">·</span><span class="cycle-tag">${escapeHtml(DataLoader.fmtCycleLabelDate(m))}</span>`;
    document.getElementById('heroLede').textContent =
      `${totalUniverse.toLocaleString('en-IN')} funds — ` +
      `${m.total_funds.toLocaleString('en-IN')} equity & hybrid scored` +
      `${debtN > 0 ? ` + ${debtN.toLocaleString('en-IN')} debt` : ''}` +
      `${otherN > 0 ? ` + ${otherN.toLocaleString('en-IN')} commodity / FoF / solution (not scored)` : ''}. ` +
      `Scored on the Products Team framework. As on ${m.as_on_display}.`;
    document.getElementById('heroFunds').textContent = totalUniverse.toLocaleString('en-IN');
    document.getElementById('heroCats').textContent = totalCats;
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
      setReRankNote([]);
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
      setReRankNote([]);
      return;
    }
    setReRankNote(top);

    // F1 — combined re-rank ACTUALLY applied to the Rank column. When the pool
    // spans ≥2 sub-categories the in-category rank repeats (1,1,2,2,…) and is
    // meaningless across categories, so assign a fresh combined rank 1..N by
    // descending Centricity score (`top` is already score-desc here) and show
    // THAT in the Rank column. Single sub-category → keep the in-category rank.
    const _combined = new Set(top.map(f => f.category)).size >= 2;
    top.forEach((f, i) => { f._displayRank = _combined ? (i + 1) : f.centricity_rank_in_category; });

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
      const rankBadge = f._displayRank;  // F1 — combined rank when ≥2 categories, else in-category
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

  /** E4 — when the Top-10 pools ≥2 categories, the list order is by combined
   *  Centricity Score (a cross-category-comparable percentile) but the Rank
   *  badge is each fund's rank WITHIN its own category — so multiple "#1"s can
   *  appear. Spell that out; hide the note for a single-category pool. */
  function setReRankNote(top) {
    const el = document.getElementById('top10ReRankNote');
    if (!el) return;
    const distinctCats = new Set((top || []).map(f => f.category));
    if (distinctCats.size >= 2) {
      el.hidden = false;
      el.innerHTML = `Pooled across the <b>${distinctCats.size}</b> selected categories and re-ranked <b>1–10 by combined Centricity Score</b> — a per-category percentile, so it is comparable across categories. The <b>Category</b> column shows each fund's own peer group.`;
    } else {
      el.hidden = true;
      el.innerHTML = '';
    }
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
        case 'centricity_rank_in_category': return f._displayRank != null ? f._displayRank : f.centricity_rank_in_category;
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

  /* --------- Active Flags (E2 — shared cycle_flags rule v2, top 6) --------- */
  function renderActiveFlags(cycle) {
    const row = document.getElementById('alertsRow');
    const cycles = _currentManifest && _currentManifest.cycles;
    if (!cycles || cycles.length < 2) {
      row.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="ring-motif" aria-hidden="true"></div>
          <h3>No prior cycle to compare against</h3>
          <p>Active flags populate from the next cycle onwards — cycle-over-cycle
             deltas need a prior cycle to diff against.</p>
        </div>`;
      return;
    }

    // E2 rule v2: manager_change OR |AUM change| ≥ 20%. (1-month return swing
    // dropped from the panel.) Default order = AF.compare (manager-change
    // funds first by current AUM desc, then AUM-swing-only by %-growth desc).
    // Top 6 on the panel; the full list is on flags.html ("View all flags →").
    const AF = window.ActiveFlags;
    const flagged = (cycle.funds || [])
      .filter(f => AF.matches(f.cycle_flags))
      .sort(AF.compare)
      .slice(0, 6)
      .map(fund => ({ fund }));

    if (flagged.length === 0) {
      row.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1;">
          <div class="ring-motif" aria-hidden="true"></div>
          <h3>No active flags this cycle</h3>
          <p>No funds tripped the active-flags rule this cycle.</p>
        </div>`;
      return;
    }

    row.innerHTML = flagged.map(({ fund }) => {
      const tagsHtml = AF.tags(fund.cycle_flags).map(AF.tagHtml).join('');
      return `
        <a class="alert-card" href="fund-detail.html?scheme=${fund.scheme_code}">
          <div class="alert-hd">
            <h3>${escapeHtml(fund.fund_name)}</h3>
            <span class="alert-aum num">₹ ${DataLoader.fmtINR(fund.aum_cr)} Cr</span>
          </div>
          <div class="alert-cat">${escapeHtml(fund.amc || '')} · ${escapeHtml(fund.category || '')}</div>
          <div class="alert-tags">${tagsHtml}</div>
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
    const byAum = (a, b) => (b.aum_cr || 0) - (a.aum_cr || 0);
    // E3 — category size = # of Ranked funds in each category (the rank
    // denominator), so "▲8 ranks" reads in context (▲8 of 12 ≠ ▲8 of 120).
    const catSize = {};
    funds.forEach(f => {
      if (f.centricity_score_status === 'Ranked' && f.category) {
        catSize[f.category] = (catSize[f.category] || 0) + 1;
      }
    });
    const newEntrants = funds.filter(f => (f.cycle_flags || {}).is_new_in_cycle).slice().sort(byAum);
    const reclassified = funds.filter(f => (f.cycle_flags || {}).category_changed).slice().sort(byAum);
    // Manager exits — display-side _fl fold guards against same-person spelling
    // drift (D9). cycle_flags already folds in D2; this is belt-and-suspenders.
    const managerExits = funds.filter(f => {
      const mc = (f.cycle_flags || {}).manager_change;
      return mc && _fl(mc.prior) !== _fl(mc.current);
    });
    // Ranking gainers/losers — EXCLUDE category-reclassified funds: their
    // in-category rank delta is meaningless across a redefined category (D9).
    const rankChanged = funds
      .filter(f => !(f.cycle_flags || {}).category_changed)
      .map(f => ({ fund: f, delta: (f.cycle_flags || {}).rank_change_in_category }))
      .filter(x => typeof x.delta === 'number');
    // E3 — universe-wide top movers (delta<0 = rank improved). Full lists for
    // the counts; top 3 shown on the panel, top 10 on what-changed.html.
    const allGainers = rankChanged.filter(x => x.delta < 0).sort((a, b) => a.delta - b.delta);
    const allLosers  = rankChanged.filter(x => x.delta > 0).sort((a, b) => b.delta - a.delta);

    const renderTopList = (xs, fmt) => xs.slice(0, 5).map(fmt).join('') || '<em>—</em>';
    const fundRow = f => `<div><a href="fund-detail.html?scheme=${f.scheme_code}">${escapeHtml(f.fund_name)}</a> · <span class="ch-muted">₹ ${DataLoader.fmtINR(f.aum_cr)} Cr</span></div>`;
    // E3 mover row: Fund · ▲/▼N ranks · # funds in category (the denominator).
    const moverRow = x => {
      const n = catSize[x.fund.category];
      return `<div><a href="fund-detail.html?scheme=${x.fund.scheme_code}">${escapeHtml(x.fund.fund_name)}</a> ${rankArrow(x.delta)} <span class="ch-muted">of ${n != null ? n : '—'} · ${escapeHtml(x.fund.category || '—')}</span></div>`;
    };
    const countLink = (n, type) =>
      `<a class="count num count-link" href="what-changed.html?type=${type}">${n}</a>`;

    grid.innerHTML = `
      <div class="change-card">
        <div class="hd"><span class="lbl">New entrants</span>${countLink(newEntrants.length, 'new')}</div>
        <div class="body">${renderTopList(newEntrants, fundRow)}</div>
        <div class="foot"><span>Top 5 by AUM · click the count for the full list</span></div>
      </div>
      <div class="change-card" id="changeDropped">
        <div class="hd"><span class="lbl">Funds dropped</span><span class="count num">—</span></div>
        <div class="body"><em>Loading…</em></div>
        <div class="foot"><span>vs ${priorEntry ? escapeHtml(DataLoader.fmtCycleLabelDate(priorEntry.date)) : '—'}</span></div>
      </div>
      <div class="change-card">
        <div class="hd"><span class="lbl">Category reclassified</span>${countLink(reclassified.length, 'reclassified')}</div>
        <div class="body">${renderTopList(reclassified, f => `<div><a href="fund-detail.html?scheme=${f.scheme_code}">${escapeHtml(f.fund_name)}</a> · <span class="ch-muted">${escapeHtml(f.category)}</span></div>`)}</div>
        <div class="foot"><span>Ranking category redefined between cycles</span></div>
      </div>
      <div class="change-card">
        <div class="hd"><span class="lbl">Top ranking gainers</span>${allGainers.length ? countLink(allGainers.length, 'gainers') : '<span class="count num count-disabled">0</span>'}</div>
        <div class="body">${allGainers.slice(0, 3).map(moverRow).join('') || '<em>—</em>'}</div>
        <div class="foot"><span>In-category rank improved · top 3 · click for top 10. Excludes reclassified.</span></div>
      </div>
      <div class="change-card">
        <div class="hd"><span class="lbl">Top ranking losers</span>${allLosers.length ? countLink(allLosers.length, 'losers') : '<span class="count num count-disabled">0</span>'}</div>
        <div class="body">${allLosers.slice(0, 3).map(moverRow).join('') || '<em>—</em>'}</div>
        <div class="foot"><span>In-category rank dropped · top 3 · click for top 10. Excludes reclassified.</span></div>
      </div>
      <div class="change-card">
        <div class="hd"><span class="lbl">Manager exits</span><span class="count num">${managerExits.length}</span></div>
        <div class="body">${renderTopList(managerExits.slice(0, 5), f => `<div><a href="fund-detail.html?scheme=${f.scheme_code}">${escapeHtml(f.fund_name)}</a> · ${escapeHtml(f.cycle_flags.manager_change.prior)} → ${escapeHtml(f.cycle_flags.manager_change.current)}</div>`)}</div>
        <div class="foot"><span>Lead manager change (spelling-drift folded out)</span></div>
      </div>`;

    // Lazy-load prior cycle for dropped funds (present in prior, absent now).
    if (priorEntry) {
      DataLoader.loadCycle(priorEntry.date).then(priorCycle => {
        const activeAmfis = new Set(funds.map(f => f.scheme_code));
        const droppedFunds = (priorCycle.funds || []).filter(f => !activeAmfis.has(f.scheme_code)).slice().sort(byAum);
        const card = document.getElementById('changeDropped');
        if (!card) return;
        const countEl = card.querySelector('.count');
        const body = card.querySelector('.body');
        if (droppedFunds.length > 0) {
          countEl.outerHTML = `<a class="count num count-link" href="what-changed.html?type=dropped">${droppedFunds.length}</a>`;
          body.innerHTML = droppedFunds.slice(0, 5).map(fundRow).join('');
        } else {
          countEl.outerHTML = `<span class="count num count-disabled" title="No funds dropped this cycle.">0</span>`;
          body.innerHTML = '<em>No funds dropped this cycle.</em>';
        }
      }).catch(() => {
        const card = document.getElementById('changeDropped');
        if (card) card.querySelector('.body').textContent = 'Could not load prior cycle.';
      });
    }
  }

  /** D9 — ranking direction arrow: rank improved (delta<0, number decreased) →
   *  green ▲; rank dropped (delta>0) → red ▼. */
  function rankArrow(delta) {
    if (delta < 0) return `<b class="rank-up">▲${Math.abs(delta)}</b>`;
    if (delta > 0) return `<b class="rank-down">▼${delta}</b>`;
    return '';
  }

  /** First+last name fold (mirrors the converter / cycle-flags) for the
   *  manager-exit display-side dedupe (D9). */
  function _fl(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '';
    const s = p => p.toLowerCase().replace(/[.,]/g, '').trim();
    return parts.length === 1 ? s(parts[0]) : `${s(parts[0])} ${s(parts[parts.length - 1])}`;
  }

  /* --------- Explore section (Stage B B3 — asset-class + Active/Passive split) --------- */
  function renderExplore(cycle) {
    const wrap = document.getElementById('exploreWrap');
    if (!wrap) return;
    const funds = cycle.funds || [];
    const byClass = { Equity: 0, Hybrid: 0 };
    let activeCount = 0, passiveCount = 0;
    for (const f of funds) {
      const c = f.sub_category_class;
      if (c === 'Equity' || c === 'Hybrid') byClass[c]++;
      if (f.centricity_score_status === 'Index — Not Scored') passiveCount++;
      else activeCount++;
    }
    // E1 — fold the Other-Funds universe (Commodity/FoF/Solution) into each
    // asset class; Commodity is a new asset class.
    const other = _otherMeta.byAsset || {};
    const equityN = byClass.Equity + (other.Equity || 0);
    const hybridN = byClass.Hybrid + (other.Hybrid || 0);
    const debtN = (_debtMeta.count || 0) + (other.Debt || 0);  // debt screener + Other debt FoFs
    const commodityN = other.Commodity || 0;                   // new asset class
    const acTotal = equityN + hybridN + debtN + commodityN;    // full universe
    const scoredTotal = funds.length;                          // equity + hybrid (Active/Passive base)
    const pct = (n, t) => t > 0 ? ((n / t) * 100).toFixed(1) : '0.0';
    const acRow = (label, n, ac) =>
      `<a class="explore-row explore-link" href="screener.html?ac=${ac}"><span>${label}</span><b class="num">${n.toLocaleString('en-IN')}</b><span class="pct">${pct(n, acTotal)}%</span></a>`;
    wrap.innerHTML = `
      <div class="explore-grid">
        <div class="explore-card">
          <h3>By asset class</h3>
          ${acRow('Equity', equityN, 'equity')}
          ${acRow('Hybrid', hybridN, 'hybrid')}
          ${acRow('Debt', debtN, 'debt')}
          ${commodityN > 0 ? acRow('Commodity', commodityN, 'commodity') : ''}
          <p class="explore-foot">Total ${acTotal.toLocaleString('en-IN')} funds${_otherMeta.count ? ` incl. ${_otherMeta.count.toLocaleString('en-IN')} commodity / FoF / solution (not scored)` : ''}. Click a class → Screener.</p>
        </div>
        <div class="explore-card">
          <h3>Active vs Passive</h3>
          <div class="explore-row"><span>Active (Ranked / Warning / New)</span><b class="num">${activeCount.toLocaleString('en-IN')}</b><span class="pct">${pct(activeCount, scoredTotal)}%</span></div>
          <div class="explore-row"><span>Passive (Index — Not Scored)</span><b class="num">${passiveCount.toLocaleString('en-IN')}</b><span class="pct">${pct(passiveCount, scoredTotal)}%</span></div>
          <p class="explore-foot">Of ${scoredTotal.toLocaleString('en-IN')} scored equity &amp; hybrid funds. Debt, commodity &amp; Other funds are not scored.</p>
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
