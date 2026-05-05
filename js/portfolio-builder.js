/*
 * Centricity MF Screener Dashboard — portfolio-builder.html page logic
 *
 * ⚠️  Excel-locked weights. Reads centricity_score from JSON. See SKILL.md §7.
 *
 * Mode A: manual fund pick + per-fund allocation %. Live weighted summary
 * (return, Sharpe, std dev, blended TER). Save / load named portfolios via
 * AppState.savePortfolio / getSavedPortfolios.
 *
 * Mode B: rule-based generator. v1 stub UI only — solver deferred to v1.x
 * per Skills/mf-dashboard-build/SKILL.md §11 Pending Decisions.
 */
(function () {
  'use strict';

  let _cycle = null;
  let _allFunds = [];
  let _picks = new Map();       // schemeCode -> {fund, alloc}
  let _fundPickerMS = null;

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
    _allFunds = cycle.funds;
    document.getElementById('footUpdated').textContent = 'Last updated · ' + cycle.cycle_meta.as_on_display;

    initModeTabs();
    initFundPicker();
    initActions();
    renderTable();
    renderSavedList();
    initToasts();
  }

  function renderLoadError(err) {
    document.getElementById('mainArea').innerHTML = `
      <div class="empty-state" style="margin:48px 56px;">
        <div class="ring-motif"></div>
        <h3>Could not load cycle data</h3>
        <p><span style="color:var(--red)">${(err && err.message) || err}</span></p>
      </div>`;
  }

  function initModeTabs() {
    document.querySelectorAll('.pb-mode-tab').forEach(t => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.pb-mode-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        const mode = t.getAttribute('data-mode');
        document.getElementById('modeA').hidden = mode !== 'a';
        document.getElementById('modeB').hidden = mode !== 'b';
      });
    });
  }

  function initFundPicker() {
    const items = _allFunds.map(f => ({
      value: String(f.scheme_code),
      label: `${f.fund_name} · ${f.amc}`,
      group: f.sub_category_class,
    }));
    _fundPickerMS = MultiSelect.create(document.getElementById('fundPicker'), {
      items,
      selected: Array.from(_picks.keys()).map(String),
      label: 'Add funds',
      allLabel: 'All funds in portfolio',
      noneLabel: 'No funds picked',
      oneLabel: (item) => `1 fund picked`,
      manyLabel: (n) => `${n} funds picked`,
      searchPlaceholder: 'Search by name, AMC, scheme code…',
      groups: true,
      onChange: (sel) => {
        // Rebuild _picks: keep existing alloc for funds that survive, default 0 for new
        const newPicks = new Map();
        sel.forEach(code => {
          const c = Number(code);
          const fund = DataLoader.getFund(_cycle, c);
          if (!fund) return;
          const existing = _picks.get(c);
          newPicks.set(c, existing || { fund, alloc: 0 });
        });
        _picks = newPicks;
        renderTable();
        recompute();
      },
    });
  }

  function initActions() {
    document.getElementById('clearAllBtn').addEventListener('click', () => {
      _picks.clear();
      _fundPickerMS.setSelected([]);
      renderTable();
      recompute();
    });
    document.getElementById('savePortfolioBtn').addEventListener('click', () => {
      if (_picks.size === 0) { showToast('Pick at least one fund first.'); return; }
      const name = (window.prompt('Name this portfolio:') || '').trim();
      if (!name) return;
      const funds = Array.from(_picks.values()).map(p => ({
        scheme_code: p.fund.scheme_code,
        fund_name: p.fund.fund_name,
        allocation_pct: p.alloc,
      }));
      AppState.savePortfolio(name, { mode: 'A' }, funds);
      renderSavedList();
      showToast(`Saved "${name}".`);
    });
  }

  function renderTable() {
    const wrap = document.getElementById('pbTableWrap');
    if (_picks.size === 0) {
      wrap.innerHTML = `
        <div class="empty-state" style="padding:48px 16px;">
          <div class="ring-motif" style="width:80px;height:80px;"></div>
          <h3>Pick at least one fund</h3>
          <p>Use the dropdown above to add funds, then enter an allocation percentage for each.</p>
        </div>`;
      return;
    }
    const rows = Array.from(_picks.values()).map(p => `
      <tr data-scheme="${p.fund.scheme_code}">
        <td class="fund-name">${escapeHtml(p.fund.fund_name)}<div style="font-size:11px;color:var(--text-mid);font-weight:400;">${escapeHtml(p.fund.amc)} · ${escapeHtml(p.fund.category)}</div></td>
        <td>${DataLoader.fmtScorePct(p.fund.centricity_score)}</td>
        <td class="${DataLoader.pctClass(p.fund.trailing_returns?.return_3y_pct)}">${DataLoader.fmtPct(p.fund.trailing_returns?.return_3y_pct)}</td>
        <td>${DataLoader.fmtNum(p.fund.risk_metrics?.sharpe_3y)}</td>
        <td>${DataLoader.fmtNum(p.fund.ter_pct)}%</td>
        <td><input type="number" class="alloc" min="0" max="100" step="0.5" value="${p.alloc}"></td>
        <td><button class="remove" title="Remove">×</button></td>
      </tr>`).join('');
    wrap.innerHTML = `
      <table class="pb-tbl">
        <thead><tr>
          <th>Fund / AMC / Category</th>
          <th>Score</th><th>3Y CAGR</th><th>Sharpe</th><th>TER</th>
          <th>Allocation %</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

    wrap.querySelectorAll('input.alloc').forEach(input => {
      input.addEventListener('input', (e) => {
        const code = Number(e.target.closest('tr').getAttribute('data-scheme'));
        const v = parseFloat(e.target.value);
        const p = _picks.get(code);
        if (p) { p.alloc = isNaN(v) ? 0 : v; }
        recompute();
      });
    });
    wrap.querySelectorAll('button.remove').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const code = Number(e.target.closest('tr').getAttribute('data-scheme'));
        _picks.delete(code);
        _fundPickerMS.setSelected(Array.from(_picks.keys()).map(String));
      });
    });
  }

  function recompute() {
    const picks = Array.from(_picks.values()).filter(p => p.alloc > 0);
    const total = picks.reduce((s, p) => s + p.alloc, 0);
    document.getElementById('sumCount').textContent = _picks.size;
    const totalEl = document.getElementById('sumTotal');
    totalEl.textContent = total.toFixed(1) + '%';
    totalEl.classList.toggle('warn', Math.abs(total - 100) > 0.5 && total > 0);
    totalEl.classList.toggle('ok',   Math.abs(total - 100) <= 0.5);

    if (total === 0) {
      ['sumR1','sumR3','sumR5','sumSharpe','sumStdDev','sumTer'].forEach(id => {
        document.getElementById(id).textContent = '—';
      });
      return;
    }

    function weighted(getter, fmt) {
      let num = 0, denom = 0;
      picks.forEach(p => {
        const v = getter(p.fund);
        if (v == null) return;
        num += v * p.alloc; denom += p.alloc;
      });
      return denom === 0 ? '—' : fmt(num / denom);
    }
    document.getElementById('sumR1').textContent     = weighted(f => f.trailing_returns?.return_1y_pct,   v => DataLoader.fmtPct(v));
    document.getElementById('sumR3').textContent     = weighted(f => f.trailing_returns?.return_3y_pct,   v => DataLoader.fmtPct(v));
    document.getElementById('sumR5').textContent     = weighted(f => f.trailing_returns?.return_5y_pct,   v => DataLoader.fmtPct(v));
    document.getElementById('sumSharpe').textContent = weighted(f => f.risk_metrics?.sharpe_3y,           v => DataLoader.fmtNum(v));
    document.getElementById('sumStdDev').textContent = weighted(f => f.risk_metrics?.std_dev_3y_pct,      v => DataLoader.fmtNum(v) + '%');
    document.getElementById('sumTer').textContent    = weighted(f => f.ter_pct,                          v => DataLoader.fmtNum(v) + '%');
  }

  function renderSavedList() {
    const wrap = document.getElementById('savedList');
    const list = AppState.getSavedPortfolios();
    if (list.length === 0) {
      wrap.innerHTML = `<p style="color:var(--text-mid);font-size:11.5px;margin:0;">No saved portfolios yet.</p>`;
      return;
    }
    wrap.innerHTML = list.map(p => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px dotted var(--grey-light);">
        <span><b>${escapeHtml(p.name)}</b><br><span style="color:var(--text-mid);font-size:10.5px;">${p.funds.length} funds · ${DataLoader.fmtDate(p.createdAt)}</span></span>
        <span>
          <button class="btn ghost" style="padding:4px 10px;font-size:10px;" data-load="${escapeHtml(p.name)}">Load</button>
          <button class="btn ghost" style="padding:4px 10px;font-size:10px;color:var(--red);border-color:var(--red);" data-delete="${escapeHtml(p.name)}">×</button>
        </span>
      </div>`).join('');
    wrap.querySelectorAll('[data-load]').forEach(b => b.addEventListener('click', (e) => {
      const name = e.target.getAttribute('data-load');
      const p = AppState.getSavedPortfolios().find(x => x.name === name);
      if (!p) return;
      _picks.clear();
      p.funds.forEach(pf => {
        const fund = DataLoader.getFund(_cycle, pf.scheme_code);
        if (fund) _picks.set(pf.scheme_code, { fund, alloc: pf.allocation_pct || 0 });
      });
      _fundPickerMS.setSelected(Array.from(_picks.keys()).map(String));
      renderTable(); recompute();
      showToast(`Loaded "${name}".`);
    }));
    wrap.querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', (e) => {
      const name = e.target.getAttribute('data-delete');
      AppState.deletePortfolio(name);
      renderSavedList();
    }));
  }

  let _toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t || !msg) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  function initToasts() {
    document.querySelectorAll('[data-toast]').forEach(el =>
      el.addEventListener('click', () => showToast(el.getAttribute('data-toast'))));
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
})();
