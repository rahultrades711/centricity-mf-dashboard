/* ============================================================
 *  what-changed.js — Stage B Partner-Review D9 + 'E' round E3
 *  Full lists behind the Home "What Changed" cards:
 *    ?type=new           — new entrants this cycle (AUM desc)
 *    ?type=dropped       — funds in the prior cycle, absent now (AUM desc)
 *    ?type=reclassified  — funds whose ranking category was redefined (AUM desc)
 *    ?type=gainers       — top 10 universe-wide in-category rank gainers (E3)
 *    ?type=losers        — top 10 universe-wide in-category rank losers (E3)
 *  Columns: new/dropped/reclassified → Fund | Category | AUM ₹ Cr;
 *           gainers/losers → Fund | Category | Ranks moved | # funds in category.
 * ============================================================ */
(function () {
  'use strict';
  const MOVERS_LIMIT = 10;   // E3 — "click → top 10"
  const TYPES = {
    new:          { title: 'New Entrants',          sub: 'Funds that appear in this cycle but not the prior cycle, sorted by AUM (high → low).' },
    dropped:      { title: 'Funds Dropped',         sub: 'Funds present in the prior cycle but absent this cycle, sorted by AUM (high → low).' },
    reclassified: { title: 'Category Reclassified', sub: 'Funds whose ranking category was redefined between cycles, sorted by AUM (high → low).' },
    gainers:      { title: 'Ranking Gainers',       sub: 'Biggest in-category rank improvements vs the prior cycle (top 10). Excludes funds whose category was reclassified — their rank delta is not comparable.' },
    losers:       { title: 'Ranking Losers',        sub: 'Biggest in-category rank declines vs the prior cycle (top 10). Excludes funds whose category was reclassified — their rank delta is not comparable.' },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const type = (new URLSearchParams(location.search).get('type') || 'new').toLowerCase();
    const meta = TYPES[type] || TYPES.new;
    document.getElementById('wcTitle').innerHTML = meta.title.replace(/(\S+)\s*$/, '<em>$1</em>');
    document.getElementById('wcSub').textContent = meta.sub;
    document.querySelectorAll('.wc-tabs a').forEach(a => {
      if (a.dataset.type === (TYPES[type] ? type : 'new')) a.classList.add('active');
    });

    Promise.all([
      fetch('data/manifest.json', { cache: 'default' }).then(r => r.ok ? r.json() : null).catch(() => null),
      Cycle.getActiveCycle(),
    ])
      .then(([manifest, activeDate]) => DataLoader.loadCycle(activeDate).then(cycle => ({ manifest, cycle })))
      .then(({ manifest, cycle }) => {
        const fu = document.getElementById('footUpdated');
        if (fu) fu.textContent = `Last updated · ${cycle.cycle_meta.as_on_display}`;
        if (type === 'dropped') return _renderDropped(manifest, cycle);
        if (type === 'gainers' || type === 'losers') return _renderMovers(cycle, type);
        const funds = (cycle.funds || []).filter(f => {
          const cf = f.cycle_flags || {};
          return type === 'reclassified' ? cf.category_changed : cf.is_new_in_cycle;
        }).slice().sort(byAum);
        _renderTable(funds, cycle, type);
      })
      .catch(err => {
        document.getElementById('wcMount').innerHTML =
          `<div class="wc-empty"><h2>Could not load</h2><p>${esc((err && err.message) || String(err))}</p></div>`;
      });
  });

  function byAum(a, b) { return (b.aum_cr || 0) - (a.aum_cr || 0); }

  function _renderDropped(manifest, cycle) {
    const cycles = (manifest && manifest.cycles) || [];
    const sorted = cycles.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const idx = sorted.findIndex(c => c.date === cycle.cycle_meta.cycle_date);
    const prior = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : sorted[1];
    if (!prior) { _renderTable([], cycle, 'dropped'); return; }
    DataLoader.loadCycle(prior.date).then(pc => {
      const activeAmfis = new Set((cycle.funds || []).map(f => f.scheme_code));
      const dropped = (pc.funds || []).filter(f => !activeAmfis.has(f.scheme_code)).slice().sort(byAum);
      _renderTable(dropped, cycle, 'dropped');
    }).catch(() => _renderTable([], cycle, 'dropped'));
  }

  function _renderTable(funds, cycle, type) {
    const cd = cycle.cycle_meta.cycle_date;
    const count = document.getElementById('wcCount');
    const mount = document.getElementById('wcMount');
    if (!funds.length) {
      count.textContent = '';
      const msg = type === 'dropped' ? 'No funds dropped this cycle.'
        : type === 'reclassified' ? 'No funds were reclassified this cycle.'
        : 'No new entrants this cycle.';
      mount.innerHTML = `<div class="wc-empty"><h2>Nothing to show</h2><p>${msg}</p></div>`;
      return;
    }
    count.innerHTML = `<b>${funds.length}</b> funds.`;
    const rows = funds.map(f => {
      // Dropped funds aren't in the current cycle → render the name as plain
      // text (no dead one-pager link). New / reclassified link with &cycle.
      const nameCell = type === 'dropped'
        ? esc(f.fund_name)
        : `<a class="fund-link" href="fund-detail.html?scheme=${encodeURIComponent(f.scheme_code)}&cycle=${encodeURIComponent(cd)}">${esc(f.fund_name)}</a>`;
      return `<tr>
        <td>${nameCell}</td>
        <td>${esc(f.category || '—')}</td>
        <td class="num">${f.aum_cr != null ? '₹ ' + DataLoader.fmtINR(f.aum_cr) : '—'}</td>
      </tr>`;
    }).join('');
    mount.innerHTML = `<table class="wc-tbl">
      <thead><tr><th>Fund</th><th>Category</th><th class="num">AUM ₹ Cr</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  /* E3 — universe-wide top in-category rank movers (gainers/losers). */
  function _renderMovers(cycle, type) {
    const cd = cycle.cycle_meta.cycle_date;
    const funds = cycle.funds || [];
    // Category size = # of Ranked funds per category (the rank denominator).
    const catSize = {};
    funds.forEach(f => {
      if (f.centricity_score_status === 'Ranked' && f.category) {
        catSize[f.category] = (catSize[f.category] || 0) + 1;
      }
    });
    const moved = funds
      .filter(f => !(f.cycle_flags || {}).category_changed)
      .map(f => ({ fund: f, delta: (f.cycle_flags || {}).rank_change_in_category }))
      .filter(x => typeof x.delta === 'number' && (type === 'gainers' ? x.delta < 0 : x.delta > 0));
    moved.sort((a, b) => type === 'gainers' ? a.delta - b.delta : b.delta - a.delta);
    const total = moved.length;
    const shown = moved.slice(0, MOVERS_LIMIT);

    const count = document.getElementById('wcCount');
    const mount = document.getElementById('wcMount');
    if (!shown.length) {
      count.textContent = '';
      mount.innerHTML = `<div class="wc-empty"><h2>Nothing to show</h2>
        <p>No in-category rank ${type === 'gainers' ? 'gainers' : 'losers'} this cycle.</p></div>`;
      return;
    }
    count.innerHTML = total > MOVERS_LIMIT
      ? `Showing the <b>top ${MOVERS_LIMIT}</b> of <b>${total}</b> ${type}.`
      : `<b>${total}</b> ${type}.`;
    const rows = shown.map(x => {
      const f = x.fund;
      const n = catSize[f.category];
      return `<tr>
        <td><a class="fund-link" href="fund-detail.html?scheme=${encodeURIComponent(f.scheme_code)}&cycle=${encodeURIComponent(cd)}">${esc(f.fund_name)}</a></td>
        <td>${esc(f.category || '—')}</td>
        <td class="num">${_arrow(x.delta)}</td>
        <td class="num">${n != null ? n : '—'}</td>
      </tr>`;
    }).join('');
    mount.innerHTML = `<table class="wc-tbl">
      <thead><tr><th>Fund</th><th>Category</th><th class="num">Ranks moved</th><th class="num"># funds in category</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  /* rank improved (delta<0) → green ▲N ; rank dropped (delta>0) → red ▼N. */
  function _arrow(delta) {
    if (delta < 0) return `<b class="rank-up">▲${Math.abs(delta)}</b>`;
    if (delta > 0) return `<b class="rank-down">▼${delta}</b>`;
    return '—';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
