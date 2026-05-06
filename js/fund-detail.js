/*
 * Centricity MF Screener Dashboard — fund-detail.html page logic
 *
 * ⚠️  Excel-locked weights. Reads fund.centricity_score directly from the
 * cycle JSON. Do NOT call DataLoader.recomputeScore() here — that's the
 * Screener page's right-drawer behaviour only. See SKILL.md §7.
 *
 * Reads ?scheme=<AMFI_code> from URL. If absent, shows a fund picker.
 *
 * Sections rendered:
 *   • Hero band: name + subtitle + meta-strip + 3-source provenance line
 *   • KPI strip: 4 trailing returns + 9 risk metrics
 *   • Score breakdown: parameter_scores × weights table
 *   • Peer comparison: top 5 in same category by Centricity rank
 *   • Fund facts: inception, manager, manager-tenure, AMC, TER, turnover, mcap, etc.
 *   • Holdings + Movement panels: analytics_pending placeholder per ISSUE-0003
 *   • Active Flags: cycle_flags (empty state when null per ISSUE-0009)
 *   • Analyst Note: Phase 5 placeholder
 */
(function () {
  'use strict';

  let _cycle = null;
  let _fund = null;

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

    const params = new URLSearchParams(window.location.search);
    const scheme = Number(params.get('scheme') || '');
    if (!scheme) {
      renderPicker(cycle);
      return;
    }

    const fund = DataLoader.getFund(cycle, scheme);
    if (!fund) {
      renderError(`No fund with scheme code ${scheme} in cycle ${DataLoader.fmtCycleLabelDate(cycle.cycle_meta)}.`);
      return;
    }
    _fund = fund;

    renderHeader(fund);
    renderProvenance(cycle);
    renderKPIs(fund);
    renderScoreBreakdown(fund, cycle);
    renderPeers(fund, cycle);
    renderFacts(fund);
    renderFlags(fund);
    document.getElementById('footUpdated').textContent = 'Last updated · ' + cycle.cycle_meta.as_on_display;

    // Watchlist toggle
    const watchBtn = document.getElementById('watchBtn');
    syncWatchBtn(watchBtn);
    watchBtn.addEventListener('click', () => {
      if (AppState.isWatched(scheme)) AppState.removeFromWatchlist(scheme);
      else AppState.addToWatchlist(scheme);
      syncWatchBtn(watchBtn);
    });

    initToasts();
  }

  function syncWatchBtn(btn) {
    if (!_fund) return;
    const watched = AppState.isWatched(_fund.scheme_code);
    btn.textContent = watched ? '★ Watched' : '☆ Add to Watchlist';
    btn.classList.toggle('primary', watched);
  }

  function renderLoadError(err) {
    const main = document.getElementById('mainArea');
    main.innerHTML = `
      <div class="empty-state" style="margin:48px 56px;">
        <div class="ring-motif"></div>
        <h3>Could not load cycle data</h3>
        <p><span style="color:var(--red)">${(err && err.message) || err}</span></p>
      </div>`;
  }

  function renderError(msg) {
    document.getElementById('fdFundName').textContent = msg;
    document.getElementById('fdSubtitle').textContent = '';
  }

  function renderPicker(cycle) {
    const m = cycle.cycle_meta;
    document.getElementById('fdFundName').textContent = 'Pick a fund';
    document.getElementById('fdSubtitle').textContent =
      `${m.total_funds.toLocaleString('en-IN')} funds across ${m.category_count} categories. Click to open the one-pager.`;

    const sections = document.querySelector('.fd-sections');
    sections.style.gridTemplateColumns = '1fr';
    sections.innerHTML = `
      <div class="fd-card full">
        <h2>Top 25 by Centricity Rank</h2>
        <div class="body">
          <table class="peer-tbl"><thead><tr>
            <th>Rank</th><th>Fund / AMC</th><th>Category</th><th>1Y</th><th>3Y</th><th>Sharpe</th><th>Score</th>
          </tr></thead><tbody>
          ${cycle.funds
            .filter(f => f.centricity_score_status === 'Ranked')
            .sort((a,b) => (a.centricity_rank_overall||9999)-(b.centricity_rank_overall||9999))
            .slice(0, 25)
            .map(f => `
              <tr style="cursor:pointer" onclick="window.location.href='fund-detail.html?scheme=${f.scheme_code}'">
                <td>${f.centricity_rank_overall ?? '—'}</td>
                <td class="fund-name">${escapeHtml(f.fund_name)}<div style="font-size:11px;color:var(--text-mid);font-weight:400;">${escapeHtml(f.amc)} · #${f.scheme_code}</div></td>
                <td>${escapeHtml(f.category)}</td>
                <td class="${DataLoader.pctClass(f.trailing_returns?.return_1y_pct)}">${DataLoader.fmtPct(f.trailing_returns?.return_1y_pct)}</td>
                <td class="${DataLoader.pctClass(f.trailing_returns?.return_3y_pct)}">${DataLoader.fmtPct(f.trailing_returns?.return_3y_pct)}</td>
                <td>${DataLoader.fmtNum(f.risk_metrics?.sharpe_3y)}</td>
                <td><b>${DataLoader.fmtScorePct(f.centricity_score)}</b></td>
              </tr>`).join('')}
          </tbody></table>
        </div>
      </div>`;
  }

  function renderHeader(fund) {
    document.getElementById('fdFundName').textContent = fund.fund_name;
    document.getElementById('fdSubtitle').innerHTML =
      `<b>${escapeHtml(fund.amc)}</b> · ${escapeHtml(fund.category)} · Benchmark: ${escapeHtml(fund.benchmark || '—')}`;

    const meta = document.getElementById('fdMetaStrip');
    const cells = [
      { lbl: 'Centricity Rank',  v: fund.centricity_rank_overall != null ? '#' + fund.centricity_rank_overall : '—' },
      { lbl: 'Score',            v: DataLoader.fmtScorePct(fund.centricity_score) },
      { lbl: 'AUM',              v: '₹ ' + DataLoader.fmtINR(fund.aum_cr) + ' Cr' },
      { lbl: 'TER',              v: DataLoader.fmtNum(fund.ter_pct) + '%' },
      { lbl: 'Manager',          v: fund.manager_name || '—' },
      { lbl: 'Mgr Tenure',       v: DataLoader.fmtNum(fund.manager_tenure_yrs, 1) + ' yrs' },
      { lbl: 'Inception',        v: DataLoader.fmtDate(fund.inception_date) },
      { lbl: 'Fund Tenure',      v: DataLoader.fmtNum(fund.fund_tenure_yrs, 1) + ' yrs' },
    ];
    meta.innerHTML = cells.map(c =>
      `<div class="cell"><span class="lbl">${escapeHtml(c.lbl)}</span><span class="v">${escapeHtml(c.v)}</span></div>`
    ).join('');
  }

  function renderProvenance(cycle) {
    // 3-source provenance per CLAUDE.md §4.1
    const sd = cycle.cycle_meta.source_dates || {};
    const fmt = (iso) => iso ? DataLoader.fmtDate(iso) : '—';
    document.getElementById('fdProvenance').innerHTML = `
      <div class="pv"><span class="lbl">Screener as on</span><b>${fmt(sd.screener)}</b></div>
      <div class="pv"><span class="lbl">Holdings as on</span><b>${fmt(sd.analytics)}</b></div>
      <div class="pv"><span class="lbl">Returns as on</span><b>${fmt(sd.monitor)}</b></div>
    `;
  }

  function renderKPIs(fund) {
    const r = fund.trailing_returns || {};
    const b = fund.benchmark_returns || {};
    const a = fund.alpha || {};
    const rm = fund.risk_metrics || {};
    // 4 returns + 9 risk = 13 cells
    const cells = [
      { lbl: '1Y Return', v: DataLoader.fmtPct(r.return_1y_pct), neg: (r.return_1y_pct ?? 0) < 0,
        delta: 'BM ' + DataLoader.fmtPct(b.return_1y_pct) },
      { lbl: '3Y CAGR',   v: DataLoader.fmtPct(r.return_3y_pct), neg: (r.return_3y_pct ?? 0) < 0,
        delta: 'α ' + DataLoader.fmtPct(a.alpha_3y_pct) },
      { lbl: '5Y CAGR',   v: DataLoader.fmtPct(r.return_5y_pct), neg: (r.return_5y_pct ?? 0) < 0,
        delta: 'α ' + DataLoader.fmtPct(a.alpha_5y_pct) },
      { lbl: 'SI CAGR',   v: DataLoader.fmtPct(r.return_si_pct), neg: (r.return_si_pct ?? 0) < 0 },
      { lbl: 'Sharpe',    v: DataLoader.fmtNum(rm.sharpe_3y) },
      { lbl: 'Sortino',   v: DataLoader.fmtNum(rm.sortino_3y) },
      { lbl: 'Std Dev',   v: DataLoader.fmtNum(rm.std_dev_3y_pct) + '%' },
      { lbl: 'Max DD',    v: DataLoader.fmtNum(rm.max_drawdown_3y_pct) + '%', neg: (rm.max_drawdown_3y_pct ?? 0) < 0 },
      { lbl: 'Beta',      v: DataLoader.fmtNum(rm.beta_3y) },
      { lbl: 'Treynor',   v: DataLoader.fmtNum(rm.treynor_3y) },
      { lbl: 'Up Capture',   v: DataLoader.fmtNum(rm.up_capture_3y_pct) + '%' },
      { lbl: 'Down Capture', v: DataLoader.fmtNum(rm.down_capture_3y_pct) + '%' },
      { lbl: 'Overall Cap.', v: DataLoader.fmtNum(rm.overall_capture_3y_pct) + '%' },
    ];
    document.getElementById('kpiStrip').innerHTML = cells.map(c => `
      <div class="kpi-cell">
        <span class="lbl">${escapeHtml(c.lbl)}</span>
        <span class="v ${c.neg ? 'neg' : ''}">${escapeHtml(c.v)}</span>
        ${c.delta ? `<span class="delta">${escapeHtml(c.delta)}</span>` : ''}
      </div>`).join('');
  }

  function renderScoreBreakdown(fund, cycle) {
    const wrap = document.getElementById('fdScoreBreakdown');
    if (fund.centricity_score_status !== 'Ranked' || !fund.parameter_scores) {
      wrap.innerHTML = `<p style="color:var(--text-mid);">Score breakdown is only available for Ranked funds.
        This fund's status is <b>${escapeHtml(fund.centricity_score_status)}</b>${fund.centricity_score_warning_pct != null
          ? ` (preview: ${fund.centricity_score_warning_pct.toFixed(2)}%)` : ''}.</p>`;
      return;
    }
    const ws = cycle.cycle_meta.scoring_weights;
    const rows = ws.map(w => {
      const ps = fund.parameter_scores[w.parameter];
      const contrib = ps != null ? ps * w.weight_pct : 0;
      return `
        <tr>
          <td style="text-align:left;">${escapeHtml(w.parameter)} <span style="color:var(--gold);font-size:10px;">${w.direction === 'Higher' ? '↑' : '↓'}</span></td>
          <td>${ps != null ? (ps * 100).toFixed(2) + '%' : '—'}</td>
          <td>${w.weight_pct.toFixed(1)}%</td>
          <td><b>${contrib.toFixed(3)}</b></td>
        </tr>`;
    }).join('');
    const total = ws.reduce((s, w) => s + ((fund.parameter_scores[w.parameter] || 0) * w.weight_pct), 0) / 100;
    wrap.innerHTML = `
      <table class="peer-tbl">
        <thead><tr><th>Parameter</th><th>Percentile</th><th>Weight</th><th>Contribution</th></tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="background:rgba(189,149,104,.12);font-weight:700;"><td colspan="3" style="text-align:right;padding-right:18px;">Total Score</td><td>${(total * 100).toFixed(2)}% (${total.toFixed(4)})</td></tr></tfoot>
      </table>
      <p style="font-size:11.5px;color:var(--text-mid);margin-top:10px;">
        Reproduces the Excel category-sheet scoring formula. Stored
        <code>centricity_score</code> = ${DataLoader.fmtScorePct(fund.centricity_score)}.
      </p>`;
  }

  function renderPeers(fund, cycle) {
    const wrap = document.getElementById('fdPeers');
    const peers = cycle.funds
      .filter(f => f.category === fund.category && f.centricity_score_status === 'Ranked')
      .sort((a, b) => (a.centricity_rank_overall || 9999) - (b.centricity_rank_overall || 9999))
      .slice(0, 5);
    if (peers.length === 0) {
      wrap.innerHTML = `<p style="color:var(--text-mid);">No ranked peers in this category.</p>`;
      return;
    }
    wrap.innerHTML = `
      <table class="peer-tbl">
        <thead><tr><th>Rank</th><th>Fund</th><th>3Y</th><th>Sharpe</th><th>Score</th></tr></thead>
        <tbody>${peers.map(p => `
          <tr ${p.scheme_code === fund.scheme_code ? 'class="this-fund"' : ''}
              style="cursor:pointer" onclick="window.location.href='fund-detail.html?scheme=${p.scheme_code}'">
            <td>${p.centricity_rank_overall ?? '—'}</td>
            <td class="fund-name">${escapeHtml(p.fund_name.length > 32 ? p.fund_name.slice(0, 30) + '…' : p.fund_name)}</td>
            <td class="${DataLoader.pctClass(p.trailing_returns?.return_3y_pct)}">${DataLoader.fmtPct(p.trailing_returns?.return_3y_pct)}</td>
            <td>${DataLoader.fmtNum(p.risk_metrics?.sharpe_3y)}</td>
            <td><b>${DataLoader.fmtScorePct(p.centricity_score)}</b></td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function renderFacts(fund) {
    const wrap = document.getElementById('fdFacts');
    const m = fund.mcap_split || {};
    const h = fund.hybrid_extension || {};
    const facts = [
      ['Plan',           'Regular Growth'],
      ['No. of Stocks',  fund.no_of_stocks ?? '—'],
      ['Turnover',       DataLoader.fmtNum(fund.turnover_pct) + '%'],
      ['Large Cap %',    DataLoader.fmtNum(m.large_pct) + '%'],
      ['Mid Cap %',      DataLoader.fmtNum(m.mid_pct) + '%'],
      ['Small Cap %',    DataLoader.fmtNum(m.small_pct) + '%'],
      ['Others %',       DataLoader.fmtNum(m.others_pct) + '%'],
      ['AMC Score',      fund.amc_score != null ? fund.amc_score + ' / 10' : '—'],
    ];
    if (fund.sub_category_class === 'Hybrid') {
      facts.push(
        ['Equity %',   DataLoader.fmtNum(h.equity_pct) + '%'],
        ['Debt %',     DataLoader.fmtNum(h.debt_pct) + '%'],
        ['YTM',        DataLoader.fmtNum(h.ytm) + '%'],
        ['Mod Duration', DataLoader.fmtNum(h.mod_duration_yrs, 1) + ' yrs'],
      );
    }
    wrap.innerHTML = facts.map(([k, v]) =>
      `<div class="fact"><span class="lbl">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`
    ).join('');
  }

  function renderFlags(fund) {
    const wrap = document.getElementById('fdFlags');
    if (!fund.cycle_flags || fund.cycle_flags.length === 0) {
      wrap.innerHTML = `
        <div style="display:flex;align-items:center;gap:14px;color:var(--text-mid);font-size:13px;">
          <div class="ring-motif" style="width:60px;height:60px;flex:none;"></div>
          <p style="margin:0;">No flags this cycle. Cycle-to-cycle deltas (Source A) require a prior cycle to diff against — first auto-flags populate from the next cycle (30 April 2026) onwards.</p>
        </div>`;
      return;
    }
    wrap.innerHTML = fund.cycle_flags.map(fl => `
      <div class="alert ${escapeHtml(fl.severity)}" style="margin-bottom:10px;">
        <span class="sev"></span>
        <div class="body">
          <div class="lbl">${escapeHtml(fl.severity)} severity · ${escapeHtml(fl.kind)}</div>
          <div class="ttl">${escapeHtml(fl.message || fl.kind)}</div>
        </div>
      </div>`).join('');
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
