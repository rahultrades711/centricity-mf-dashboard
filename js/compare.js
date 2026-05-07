/*
 * Centricity MF Screener Dashboard — compare.html page logic
 *
 * ⚠️  Excel-locked weights. Reads centricity_score directly. See SKILL.md §7.
 *
 * v1: cycle axis collapses to one column (only one cycle in archive).
 * Tabs: Returns / Risk / Holdings / Sectors / M-cap / Manager / Expense / Rank.
 * Holdings / Sectors / M-cap tabs render analytics_pending placeholders until v1.1.
 *
 * Initial fund selection comes from URL ?funds=<csv-of-AMFI-codes> (set by
 * Screener page's Compare button) or from the multi-select picker.
 */
(function () {
  'use strict';

  let _cycle = null;
  let _selected = [];          // fund objects, in order chosen
  let _activeTab = 'returns';
  let _fundMS = null;
  // Fix-List 10 §8 — Morningstar manager-history overlay. Same pattern
  // as screener.js: lazy fetch, build _mgrByScheme on resolve, re-render
  // the manager tab.
  let _mgrByScheme = null;

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
    document.getElementById('cmpCycle').textContent = DataLoader.fmtCycleLabelDate(cycle.cycle_meta);
    document.getElementById('footUpdated').textContent = 'Last updated · ' + cycle.cycle_meta.as_on_display;

    initFundPicker();
    initTabs();

    // Accept ?schemes= (canonical, Fix-List 2 §A) or ?funds= (backward compat)
    const params = new URLSearchParams(window.location.search);
    const rawCsv = params.get('schemes') || params.get('funds') || '';
    const initial = rawCsv.split(',').map(Number).filter(Boolean);
    if (initial.length > 0) {
      _fundMS.setSelected(initial.map(String));
    }

    initToasts();

    // Fix-List 10 §8 — fire-and-forget manager-history overlay fetch.
    // When it lands, rebuild the index and re-render the active tab so
    // manager name + tenure cells pick up the Morningstar values.
    _loadMgrHistoryOverlay();
  }

  async function _loadMgrHistoryOverlay() {
    try {
      const res = await fetch('data/manager-history-2026-04-30.json', { cache: 'default' });
      if (!res.ok) return;
      const doc = await res.json();
      const idx = Object.create(null);
      for (const code in doc.funds) {
        const entry = doc.funds[code];
        if (!entry || !entry.managers) continue;
        const current = entry.managers.filter(m => m.is_current);
        if (current.length === 0) continue;
        const main = current.reduce((a, b) =>
          (Number(a.tenure_years) || 0) > (Number(b.tenure_years) || 0) ? a : b);
        idx[String(code)] = { name: main.name, tenure_years: main.tenure_years };
      }
      _mgrByScheme = idx;
      // Re-render whichever tab is active. Manager tab gets the most
      // benefit; others share the same _selected[] and rebuild cleanly.
      renderActiveTab();
    } catch (e) {
      console.warn('[compare] manager-history overlay unavailable', e);
    }
  }

  /** Read manager_name / manager_tenure_yrs preferring the Morningstar
   *  overlay when the fund has an entry; fall back to screener fields. */
  function _mgrField(fund, key) {
    if (_mgrByScheme && fund && fund.scheme_code != null) {
      const overlay = _mgrByScheme[String(fund.scheme_code)];
      if (overlay) {
        if (key === 'manager_name')       return overlay.name;
        if (key === 'manager_tenure_yrs') return overlay.tenure_years;
      }
    }
    if (key === 'manager_name')       return fund.manager_name;
    if (key === 'manager_tenure_yrs') return fund.manager_tenure_yrs;
    return null;
  }

  function renderLoadError(err) {
    document.getElementById('mainArea').innerHTML = `
      <div class="empty-state" style="margin:48px 56px;">
        <div class="ring-motif"></div>
        <h3>Could not load cycle data</h3>
        <p><span style="color:var(--red)">${(err && err.message) || err}</span></p>
      </div>`;
  }

  function initFundPicker() {
    // Items: every Ranked fund. Group by sub_class. Disabled non-Ranked excluded.
    const items = _cycle.funds.map(f => ({
      value: String(f.scheme_code),
      label: `${f.fund_name} · ${f.amc}`,
      group: f.sub_category_class,
    }));
    _fundMS = MultiSelect.create(document.getElementById('fundMS'), {
      items,
      selected: [],
      label: 'Funds',
      allLabel: 'All funds',
      noneLabel: 'No funds picked yet',
      oneLabel: (item) => `${item.label.split(' · ')[0]} only`,
      manyLabel: (n) => `${n} funds picked`,
      searchPlaceholder: 'Search by name, AMC, scheme code…',
      groups: true,
      onChange: (sel) => {
        if (sel.length > 5) {
          // cap at 5 — drop the latest pick
          const trimmed = sel.slice(0, 5);
          _fundMS.setSelected(trimmed);
          showToast('Compare supports up to 5 funds. Trimmed to first 5.');
          return;
        }
        _selected = sel.map(code => DataLoader.getFund(_cycle, Number(code))).filter(Boolean);
        renderTab(_activeTab);
        // keep URL in sync — canonical key is ?schemes= per Fix-List 2 §A
        const url = sel.length > 0 ? '?schemes=' + sel.join(',') : window.location.pathname;
        window.history.replaceState({}, '', url);
      },
    });
  }

  function initTabs() {
    document.querySelectorAll('.cmp-tab').forEach(t => {
      t.addEventListener('click', () => {
        document.querySelectorAll('.cmp-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        _activeTab = t.getAttribute('data-tab');
        renderTab(_activeTab);
      });
    });
    renderTab(_activeTab);
  }

  function renderTab(tab) {
    const wrap = document.getElementById('cmpTableWrap');
    if (_selected.length === 0) {
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="ring-motif"></div>
          <h3>Pick up to 5 funds to compare</h3>
          <p>Use the dropdown above. Funds are grouped by Equity / Hybrid for quick scanning.</p>
        </div>`;
      return;
    }
    switch (tab) {
      case 'returns':  return renderReturns(wrap);
      case 'risk':     return renderRisk(wrap);
      case 'holdings': return renderAnalyticsPending(wrap, 'Top-10 holdings, sector allocation, full stock list');
      case 'sectors':  return renderAnalyticsPending(wrap, 'Sector allocation table');
      case 'mcap':     return renderAnalyticsPending(wrap, 'Market-cap split (Large / Mid / Small / Cash)');
      case 'manager':  return renderManager(wrap);
      case 'expense':  return renderExpense(wrap);
      case 'rank':     return renderRank(wrap);
    }
  }

  function renderReturns(wrap) {
    const rows = [
      { label: '1Y',  pick: f => f.trailing_returns?.return_1y_pct,  fmt: DataLoader.fmtPct },
      { label: '3Y CAGR', pick: f => f.trailing_returns?.return_3y_pct, fmt: DataLoader.fmtPct },
      { label: '5Y CAGR', pick: f => f.trailing_returns?.return_5y_pct, fmt: DataLoader.fmtPct },
      { label: 'SI CAGR', pick: f => f.trailing_returns?.return_si_pct, fmt: DataLoader.fmtPct },
      { label: 'CY 2025', pick: f => f.cy_returns?.cy2025_pct, fmt: DataLoader.fmtPct },
      { label: 'CY 2024', pick: f => f.cy_returns?.cy2024_pct, fmt: DataLoader.fmtPct },
      { label: 'CY 2023', pick: f => f.cy_returns?.cy2023_pct, fmt: DataLoader.fmtPct },
      { label: 'CY 2022', pick: f => f.cy_returns?.cy2022_pct, fmt: DataLoader.fmtPct },
      { label: 'Alpha 3Y', pick: f => f.alpha?.alpha_3y_pct, fmt: DataLoader.fmtPct },
      { label: 'Alpha 5Y', pick: f => f.alpha?.alpha_5y_pct, fmt: DataLoader.fmtPct },
    ];
    renderMetricTable(wrap, rows);
  }

  function renderRisk(wrap) {
    const rows = [
      { label: 'Sharpe 3Y',     pick: f => f.risk_metrics?.sharpe_3y, fmt: v => DataLoader.fmtNum(v) },
      { label: 'Sortino 3Y',    pick: f => f.risk_metrics?.sortino_3y, fmt: v => DataLoader.fmtNum(v) },
      { label: 'Std Dev 3Y',    pick: f => f.risk_metrics?.std_dev_3y_pct, fmt: v => DataLoader.fmtNum(v) + '%' },
      { label: 'Max Drawdown 3Y', pick: f => f.risk_metrics?.max_drawdown_3y_pct, fmt: v => DataLoader.fmtNum(v) + '%' },
      { label: 'Beta 3Y',       pick: f => f.risk_metrics?.beta_3y, fmt: v => DataLoader.fmtNum(v) },
      { label: 'Treynor 3Y',    pick: f => f.risk_metrics?.treynor_3y, fmt: v => DataLoader.fmtNum(v) },
      { label: 'Up Capture',    pick: f => f.risk_metrics?.up_capture_3y_pct, fmt: v => DataLoader.fmtNum(v) + '%' },
      { label: 'Down Capture',  pick: f => f.risk_metrics?.down_capture_3y_pct, fmt: v => DataLoader.fmtNum(v) + '%' },
      { label: 'Overall Capture', pick: f => f.risk_metrics?.overall_capture_3y_pct, fmt: v => DataLoader.fmtNum(v) + '%' },
    ];
    renderMetricTable(wrap, rows);
  }

  function renderManager(wrap) {
    const rows = [
      { label: 'Manager', pick: f => _mgrField(f, 'manager_name') || '—', fmt: v => v },
      { label: 'Mgr Tenure (yrs)', pick: f => _mgrField(f, 'manager_tenure_yrs'), fmt: v => DataLoader.fmtNum(v, 1) },
      { label: 'Inception', pick: f => f.inception_date, fmt: DataLoader.fmtDate },
      { label: 'Fund Tenure (yrs)', pick: f => f.fund_tenure_yrs, fmt: v => DataLoader.fmtNum(v, 1) },
      { label: 'AMC', pick: f => f.amc || '—', fmt: v => v },
      { label: 'AMC Score', pick: f => f.amc_score, fmt: v => v != null ? v + ' / 10' : '—' },
    ];
    renderMetricTable(wrap, rows);
  }

  function renderExpense(wrap) {
    const rows = [
      { label: 'TER (%)', pick: f => f.ter_pct, fmt: v => DataLoader.fmtNum(v) + '%' },
      { label: 'Turnover (%)', pick: f => f.turnover_pct, fmt: v => DataLoader.fmtNum(v) + '%' },
      { label: 'AUM (₹ Cr)', pick: f => f.aum_cr, fmt: v => '₹ ' + DataLoader.fmtINR(v) },
      { label: 'No. of Stocks', pick: f => f.no_of_stocks, fmt: v => v ?? '—' },
    ];
    renderMetricTable(wrap, rows);
  }

  function renderRank(wrap) {
    const rows = [
      { label: 'Centricity Rank (Overall)', pick: f => f.centricity_rank_overall, fmt: v => v != null ? '#' + v : '—' },
      { label: 'Centricity Rank (in Cat.)', pick: f => f.centricity_rank_in_category, fmt: v => v != null ? '#' + v : '—' },
      { label: 'Centricity Score',          pick: f => f.centricity_score, fmt: DataLoader.fmtScorePct },
      { label: 'Status',                     pick: f => f.centricity_score_status, fmt: v => v },
      { label: 'Category',                   pick: f => f.category, fmt: v => v },
      { label: 'Sub-class',                  pick: f => f.sub_category_class, fmt: v => v },
    ];
    renderMetricTable(wrap, rows);
  }

  function renderAnalyticsPending(wrap, what) {
    wrap.innerHTML = `
      <div class="empty-state">
        <div class="ring-motif"></div>
        <h3>${escapeHtml(what)} — pending v1.1</h3>
        <p>This tab populates when the Analytics pipeline (<code>scripts/excel_to_json_analytics.py</code>) ships.
           Holdings, sector allocation, and m-cap split source from the monthly Analytics file (Equity, Hybrid,
           Debt underlyings) and are joined to Screener funds via Scheme-Name → AMFI translation per ISSUE-0008.</p>
      </div>`;
  }

  function renderMetricTable(wrap, rows) {
    const head = `
      <thead><tr>
        <th>Metric</th>
        ${_selected.map(f => `<th>${escapeHtml(shortName(f.fund_name))}<div style="font-weight:400;font-size:10px;letter-spacing:0;text-transform:none;color:var(--text-mid);">${escapeHtml(f.amc)}</div></th>`).join('')}
      </tr></thead>`;
    const body = rows.map(r => {
      const values = _selected.map(f => r.pick(f));
      // For numeric rows, highlight the best value (max for returns/score; treat negatives in returns appropriately)
      const numeric = values.every(v => typeof v === 'number' && isFinite(v));
      let bestIdx = -1;
      if (numeric) {
        // For "Beta" / "Std Dev" / "Down Capture" / "Max Drawdown" / "TER" / "Turnover" — lower is better
        const lowerIsBetter = /Beta|Std Dev|Down Capture|Max Drawdown|TER|Turnover/i.test(r.label);
        // Max DD is negative — closer to 0 is better → lower-magnitude / higher numeric value
        if (/Max Drawdown/i.test(r.label)) {
          bestIdx = values.reduce((best, v, i) => v > values[best] ? i : best, 0);
        } else if (lowerIsBetter) {
          bestIdx = values.reduce((best, v, i) => v < values[best] ? i : best, 0);
        } else {
          bestIdx = values.reduce((best, v, i) => v > values[best] ? i : best, 0);
        }
      }
      const cells = values.map((v, i) => {
        const cls = (typeof v === 'number' && v < 0) ? 'num neg' :
                    (i === bestIdx ? 'highlight num' : 'num');
        return `<td class="${cls}">${escapeHtml(r.fmt(v))}</td>`;
      }).join('');
      return `<tr><td class="row-label">${escapeHtml(r.label)}</td>${cells}</tr>`;
    }).join('');
    wrap.innerHTML = `<table class="cmp-tbl">${head}<tbody>${body}</tbody></table>`;
  }

  function shortName(s) {
    if (!s) return '';
    return s.length > 32 ? s.slice(0, 30) + '…' : s;
  }

  let _toastTimer;
  function showToast(msg) {
    const t = document.getElementById('toast');
    if (!t || !msg) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
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
