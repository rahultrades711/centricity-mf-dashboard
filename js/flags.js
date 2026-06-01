/* ============================================================
 *  flags.js — Stage B 'E' round (E2) · Active Flags v2
 *  Full Active Flags list (every fund matching the shared rule in
 *  js/active-flags.js). Columns: Fund | Category | Current AUM | Last-month
 *  AUM | Δ AUM ₹Cr | Δ AUM % | Flag(s). Default order = AF.compare; also
 *  sortable by Current AUM and Δ AUM %. Cycle dropdown re-renders via ?cycle=.
 * ============================================================ */
(function () {
  'use strict';
  let _cycle = null, _manifest = null, _sort = 'severity';

  document.addEventListener('DOMContentLoaded', () => {
    Promise.all([
      fetch('data/manifest.json', { cache: 'default' }).then(r => r.ok ? r.json() : null).catch(() => null),
      Cycle.getActiveCycle(),
    ])
      .then(([manifest, activeDate]) => {
        _manifest = manifest;
        if (!activeDate) throw new Error('no cycles in manifest');
        return DataLoader.loadCycle(activeDate);
      })
      .then(cycle => {
        _cycle = cycle;
        _populateCycleSel();
        _wireControls();
        _render();
        const fu = document.getElementById('footUpdated');
        if (fu) fu.textContent = `Last updated · ${cycle.cycle_meta.as_on_display}`;
      })
      .catch(err => {
        document.getElementById('flagsMount').innerHTML =
          `<div class="flags-empty"><h2>Could not load flags</h2><p>${esc((err && err.message) || String(err))}</p></div>`;
      });
  });

  function _flagged() {
    const AF = window.ActiveFlags;
    const rows = (_cycle.funds || []).filter(f => AF.matches(f.cycle_flags));
    if (_sort === 'current_aum') {
      rows.sort((a, b) =>
        (AF.aumCurrent(b.cycle_flags) ?? b.aum_cr ?? 0) - (AF.aumCurrent(a.cycle_flags) ?? a.aum_cr ?? 0));
    } else if (_sort === 'aum_pct') {
      const p = f => { const v = AF.aumChangePct(f.cycle_flags); return v == null ? -Infinity : v; };
      rows.sort((a, b) => p(b) - p(a));
    } else {
      // 'severity' (default) — the shared manager-first / AUM-growth ordering.
      rows.sort(AF.compare);
    }
    return rows;
  }

  function _aumCell(v) {
    return v != null ? '₹ ' + DataLoader.fmtINR(v) : '—';
  }
  function _pctCell(v) {
    if (v == null) return '—';
    const neg = v < 0;
    return `<span class="${neg ? 'neg' : ''}">${neg ? '−' : '+'}${Math.abs(v).toFixed(1)}%</span>`;
  }

  function _render() {
    const AF = window.ActiveFlags;
    const rows = _flagged();
    const cd = _cycle.cycle_meta.cycle_date;
    const count = document.getElementById('flagsCount');
    const mount = document.getElementById('flagsMount');
    if (rows.length === 0) {
      count.textContent = '';
      mount.innerHTML = `<div class="flags-empty"><h2>No active flags this cycle</h2>
        <p>No funds tripped the active-flags rule this cycle.</p></div>`;
      return;
    }
    count.innerHTML = `<b>${rows.length}</b> funds tripped the active-flags rule this cycle (manager change or ±20% AUM swing).`;
    const body = rows.map(f => {
      const cf = f.cycle_flags || {};
      const tags = AF.tags(cf);
      const kinds = tags.map(t => t.kind === 'mgr' ? 'Manager change' : 'AUM swing').join(', ');
      const flagHtml = tags.map(AF.tagHtml).join(' ');
      const curAum = AF.aumCurrent(cf) != null ? AF.aumCurrent(cf) : f.aum_cr;
      const priAum = AF.aumPrior(cf);
      const chgCr  = AF.aumChangeCr(cf);
      const chgPct = AF.aumChangePct(cf);
      const chgNeg = (chgCr != null && chgCr < 0);
      const href = `fund-detail.html?scheme=${encodeURIComponent(f.scheme_code)}&cycle=${encodeURIComponent(cd)}`;
      return `<tr>
        <td><a class="fund-link" href="${href}">${esc(f.fund_name)}</a></td>
        <td>${esc(f.category || '—')}</td>
        <td class="num">${_aumCell(curAum)}</td>
        <td class="num">${_aumCell(priAum)}</td>
        <td class="num">${chgCr != null ? (chgNeg ? '<span class="neg">−₹ ' + DataLoader.fmtINR(Math.abs(chgCr)) + '</span>' : '+₹ ' + DataLoader.fmtINR(chgCr)) : '—'}</td>
        <td class="num">${_pctCell(chgPct)}</td>
        <td class="delta-cell">${flagHtml || esc(kinds)}</td>
      </tr>`;
    }).join('');
    mount.innerHTML = `<table class="flags-tbl">
      <thead><tr>
        <th>Fund</th><th>Category</th>
        <th class="num">Current AUM ₹ Cr</th><th class="num">Last-month AUM ₹ Cr</th>
        <th class="num">Δ AUM ₹ Cr</th><th class="num">Δ AUM %</th><th>Flag(s)</th>
      </tr></thead>
      <tbody>${body}</tbody></table>`;
  }

  function _populateCycleSel() {
    const sel = document.getElementById('flagsCycleSel');
    if (!sel || !_manifest || !_manifest.cycles) return;
    sel.innerHTML = _manifest.cycles.map(c =>
      `<option value="${esc(c.date)}"${c.date === _cycle.cycle_meta.cycle_date ? ' selected' : ''}>` +
      `${esc(c.label_date || c.label || c.date)}</option>`).join('');
  }

  function _wireControls() {
    const cyc = document.getElementById('flagsCycleSel');
    if (cyc) cyc.addEventListener('change', async (e) => {
      const d = e.target.value;
      try { await Cycle.setActiveCycle(d); } catch (_) {}
      const url = new URL(location.href);
      url.searchParams.set('cycle', d);
      location.href = url.toString();
    });
    const sort = document.getElementById('flagsSortSel');
    if (sort) sort.addEventListener('change', (e) => { _sort = e.target.value; _render(); });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
