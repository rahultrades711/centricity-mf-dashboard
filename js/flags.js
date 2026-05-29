/* ============================================================
 *  flags.js — Stage B Partner-Review D7
 *  Full Active Flags list (every fund matching the shared rule in
 *  js/active-flags.js). Columns: Fund | Category | AUM ₹ Cr | Flag(s) | Δ value.
 *  Sortable by severity / AUM; cycle dropdown re-renders via ?cycle=.
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
    if (_sort === 'aum') {
      rows.sort((a, b) => (b.aum_cr || 0) - (a.aum_cr || 0));
    } else {
      rows.sort((a, b) =>
        AF.severity(b.cycle_flags) - AF.severity(a.cycle_flags) || (b.aum_cr || 0) - (a.aum_cr || 0));
    }
    return rows;
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
    count.innerHTML = `<b>${rows.length}</b> funds tripped the active-flags rule this cycle.`;
    const body = rows.map(f => {
      const tags = AF.tags(f.cycle_flags);
      const kinds = tags.map(t =>
        t.kind === 'mgr' ? 'Manager change' : t.kind === 'aum' ? 'AUM swing' : '1M return swing').join(', ');
      const deltas = tags.map(AF.tagHtml).join(' ');
      const href = `fund-detail.html?scheme=${encodeURIComponent(f.scheme_code)}&cycle=${encodeURIComponent(cd)}`;
      return `<tr>
        <td><a class="fund-link" href="${href}">${esc(f.fund_name)}</a></td>
        <td>${esc(f.category || '—')}</td>
        <td class="num">${f.aum_cr != null ? '₹ ' + DataLoader.fmtINR(f.aum_cr) : '—'}</td>
        <td>${esc(kinds)}</td>
        <td class="delta-cell">${deltas}</td>
      </tr>`;
    }).join('');
    mount.innerHTML = `<table class="flags-tbl">
      <thead><tr><th>Fund</th><th>Category</th><th class="num">AUM ₹ Cr</th><th>Flag(s)</th><th>Δ value</th></tr></thead>
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
