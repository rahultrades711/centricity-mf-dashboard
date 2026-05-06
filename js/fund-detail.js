/*
 * Centricity MF Screener Dashboard — fund-detail.html page logic
 *
 * ⚠️  Excel-locked weights. Reads fund.centricity_score directly from the
 * cycle JSON. Do NOT call DataLoader.recomputeScore() here — that's the
 * Screener page's right-drawer behaviour only. See SKILL.md §7.
 *
 * Cowork 2026-05-06 — full rebuild matching the mockup at
 * Dashboard/Claude Design Dashboard Data/Mockups/Screen_03_Fund_Report.html
 *
 * Data sources (all lazy-loaded except the cycle JSON, which DataLoader
 * caches anyway):
 *   1. data/screener-YYYY-MM-DD.json         (the fund + the universe)
 *   2. data/nav-series-YYYY-MM-DD.json       (monthly NAV series for charts)
 *   3. data/manager-profiles.json            (scraped manager bios)
 *   4. https://cdn.jsdelivr.net/.../chart.js  (Chart.js, lazy-loaded once)
 *
 * URL contract (Fund Detail Fix-List 1 §D):
 *   ?scheme=<AMFI>     ← canonical
 *   ?scheme_code=<AMFI> ← backward-compat alias
 *   ?name=<text>        ← legacy, falls through to the fund picker
 *
 * Failure modes that DON'T crash the page:
 *   • nav-series file missing or fund's scheme code absent → empty-state chart
 *   • manager-profiles missing or manager name absent → placeholder caption
 *   • Chart.js CDN unreachable → empty-state chart
 *   • invalid scheme code → not-found shell with Back-to-Screener button
 */
(function () {
  'use strict';

  /* ---------- module state ---------- */
  let _cycle = null;
  let _fund = null;
  let _navSeries = null;          // entry from nav-series.json for THIS fund
  let _navWindow = '5Y';
  let _navChartInstance = null;
  let _ddChartInstance = null;
  let _chartJsLoadPromise = null;

  const CHART_JS_CDN = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
  const RF_RATE_DISPLAY = '4.5% p.a.'; // synced with cycle_meta.rf_rate_display

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

    // Resolve scheme from URL (canonical, backward-compat, legacy)
    const params = new URLSearchParams(window.location.search);
    const schemeStr = params.get('scheme') || params.get('scheme_code') || '';
    const schemeCode = parseInt(schemeStr, 10);
    if (!schemeCode || isNaN(schemeCode)) {
      renderPicker(cycle);
      // Wire raw-json link even on the picker
      wireRawJsonLink();
      return;
    }
    const fund = (cycle.funds || []).find(f => f.scheme_code === schemeCode);
    if (!fund) {
      renderNotFound(schemeCode);
      return;
    }
    _fund = fund;

    renderHero(fund, cycle);
    renderScoreCard(fund);
    renderPerformance(fund, cycle);
    renderRolling(fund);
    renderRisk(fund, cycle);
    renderManager(fund);
    renderPortfolio(fund);
    renderCost(fund, cycle);
    renderFooter(cycle);
    wireBreadcrumb(fund);
    wireActionButtons(fund);
    wireToc();
    wireRawJsonLink();

    // Lazy-load extras in parallel
    loadNavSeries(fund.scheme_code).then(entry => {
      _navSeries = entry;
      renderNavChart();
      renderDrawdownChart();
    }).catch((e) => {
      console.warn('[fund-detail] nav-series unavailable', e);
      showNavEmpty();
      showDdEmpty();
    });
    loadManagerProfile(fund.manager_name).then(profile => {
      renderManagerBio(profile, fund.manager_name);
    }).catch((e) => {
      console.warn('[fund-detail] manager-profiles unavailable', e);
      renderManagerBio(null, fund.manager_name);
    });
  }

  /* ============================================================
   * HERO + SCORE CARD
   * ============================================================ */
  function renderHero(fund, cycle) {
    const m = cycle.cycle_meta;
    const cycleLabel = DataLoader.fmtCycleLabelDate(m);

    // Eyebrow
    document.getElementById('heroEyebrow').innerHTML =
      `Fund Report Card · As on ${escapeHtml(cycleLabel)}`;

    // Title — italicise the LAST word of the fund name (mockup pattern)
    const name = fund.fund_name || 'Fund';
    const parts = name.trim().split(/\s+/);
    let titleHtml;
    if (parts.length > 1) {
      const last = parts.pop();
      titleHtml = `${escapeHtml(parts.join(' '))} <em>${escapeHtml(last)}</em>`;
    } else {
      titleHtml = escapeHtml(name);
    }
    document.getElementById('fundTitle').innerHTML = titleHtml;
    document.getElementById('crumbName').textContent = name;

    // Meta strip
    const navStr = (fund.nav_latest_value != null)
      ? `₹ ${DataLoader.fmtNum(fund.nav_latest_value)}` : '—';
    const aumStr = (fund.aum_cr != null)
      ? `₹ ${DataLoader.fmtINR(fund.aum_cr)} Cr` : '—';
    const incepStr = fund.inception_date ? DataLoader.fmtDate(fund.inception_date) : '—';
    const cells = [
      ['',          fund.amc || '—'],
      ['Category',  fund.category || '—'],
      ['Scheme',    fund.scheme_code || '—'],
      ['NAV',       navStr],
      ['AUM',       aumStr],
      ['Inception', incepStr],
    ];
    document.getElementById('heroMeta').innerHTML = cells
      .map(([k, v]) => k
        ? `<span>${escapeHtml(k)} · <b>${escapeHtml(String(v))}</b></span>`
        : `<span><b>${escapeHtml(String(v))}</b></span>`)
      .join('');
  }

  function renderScoreCard(fund) {
    const status = fund.centricity_score_status;
    const scoreOutOf10 = (fund.centricity_score != null)
      ? (fund.centricity_score * 10) : null;

    document.getElementById('scoreBig').innerHTML = scoreOutOf10 != null
      ? `${scoreOutOf10.toFixed(2)}<em>/ 10</em>`
      : `—<em>/ 10</em>`;

    // No prior cycle in archive yet — show em-dash for delta (Fund Detail spec)
    const rankLine = fund.centricity_rank_overall != null
      ? `Ranked <b>#${fund.centricity_rank_overall}</b> of ${(_cycle.cycle_meta.total_funds || '—').toLocaleString('en-IN')}`
      : '';
    document.getElementById('scoreDelta').innerHTML =
      `Cycle change · — (no prior cycle in archive). ${rankLine}`;

    // Verdict pill
    const pill = document.getElementById('verdictPill');
    pill.classList.remove('recommended', 'watch', 'exit', 'new');
    if (status === 'Ranked') {
      pill.classList.add('recommended');
      pill.textContent = 'Recommended';
      document.getElementById('convictionLabel').textContent = 'Conviction · Excel-locked';
    } else if (status === '1-3yr Warning') {
      pill.classList.add('watch');
      pill.textContent = 'Under Watch';
      const w = fund.centricity_score_warning_pct;
      document.getElementById('convictionLabel').textContent =
        w != null ? `Tenure < 3y · provisional ${w.toFixed(2)}%` : 'Tenure < 3y · provisional';
    } else {
      pill.classList.add('new');
      pill.textContent = 'New Fund';
      document.getElementById('convictionLabel').textContent = 'Tenure < 1y · monitoring';
    }

    // Mini grid (4 cells per Fund Detail Fix-List spec)
    const grid = document.getElementById('scoreMiniGrid');
    const rolling = fund.rolling_3y_avg_pct;
    const stocks = fund.no_of_stocks;
    const mgrTen = fund.manager_tenure_yrs;
    const aum = fund.aum_cr;
    grid.innerHTML = [
      ['Rolling Returns', rolling != null ? `${DataLoader.fmtNum(rolling, 2)}%` : '—'],
      ['No. of Stocks',   stocks != null ? stocks : '—'],
      ['Manager Tenure',  mgrTen != null ? `${DataLoader.fmtNum(mgrTen, 1)} yrs` : '—'],
      ['Fund AUM',        aum != null ? `₹ ${DataLoader.fmtINR(aum)} Cr` : '—'],
    ].map(([k, v]) => `<div class="cell"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`).join('');
  }

  /* ============================================================
   * 01 — PERFORMANCE
   * ============================================================ */
  function renderPerformance(fund, cycle) {
    // Cat avg / median row (computed client-side)
    const peers = (cycle.funds || []).filter(f => f.category === fund.category);
    const peerCount = peers.length;
    const benchmarkName = fund.benchmark || '—';
    document.getElementById('perfSubtitle').textContent =
      `Annualised CAGR. Benchmark · ${benchmarkName}. Category · ${fund.category} (${peerCount} fund${peerCount === 1 ? '' : 's'}). All values net of TER.`;

    // Pull values
    const f_ytd = fund.cy_returns ? fund.cy_returns.cy_ytd_pct : null;
    const f_1y  = fund.trailing_returns ? fund.trailing_returns.return_1y_pct : null;
    const f_3y  = fund.trailing_returns ? fund.trailing_returns.return_3y_pct : null;
    const f_5y  = fund.trailing_returns ? fund.trailing_returns.return_5y_pct : null;
    const f_si  = fund.trailing_returns ? fund.trailing_returns.return_si_pct : null;
    // Benchmark — only 1Y/3Y/5Y in contract; YTD + SI shown as em-dash
    const b_1y  = fund.benchmark_returns ? fund.benchmark_returns.return_1y_pct : null;
    const b_3y  = fund.benchmark_returns ? fund.benchmark_returns.return_3y_pct : null;
    const b_5y  = fund.benchmark_returns ? fund.benchmark_returns.return_5y_pct : null;

    // Category averages (only computed when peerCount >= 3)
    function catAvg(picker) {
      if (peerCount < 3) return null;
      const vals = peers.map(picker).filter(v => v != null && !isNaN(v));
      if (vals.length === 0) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    }
    const c_ytd = catAvg(f => f.cy_returns ? f.cy_returns.cy_ytd_pct : null);
    const c_1y  = catAvg(f => f.trailing_returns ? f.trailing_returns.return_1y_pct : null);
    const c_3y  = catAvg(f => f.trailing_returns ? f.trailing_returns.return_3y_pct : null);
    const c_5y  = catAvg(f => f.trailing_returns ? f.trailing_returns.return_5y_pct : null);
    const c_si  = catAvg(f => f.trailing_returns ? f.trailing_returns.return_si_pct : null);

    // Excess vs benchmark — fund - benchmark when both exist
    const excess = (a, b) => (a != null && b != null) ? (a - b) : null;
    const e_ytd = null;             // no benchmark YTD in contract
    const e_1y  = excess(f_1y, b_1y);
    const e_3y  = excess(f_3y, b_3y);
    const e_5y  = excess(f_5y, b_5y);
    const e_si  = null;             // no benchmark SI in contract

    const tbody = document.getElementById('perfTbody');
    tbody.innerHTML = `
      <tr class="row-fund">
        <td>${escapeHtml(fund.fund_name)}</td>
        <td class="${pctCls(f_ytd)}">${DataLoader.fmtPct(f_ytd)}</td>
        <td class="${pctCls(f_1y)}">${DataLoader.fmtPct(f_1y)}</td>
        <td class="${pctCls(f_3y)}">${DataLoader.fmtPct(f_3y)}</td>
        <td class="${pctCls(f_5y)}">${DataLoader.fmtPct(f_5y)}</td>
        <td class="${pctCls(f_si)}">${DataLoader.fmtPct(f_si)}</td>
      </tr>
      <tr class="row-bench">
        <td>${escapeHtml(benchmarkName)}</td>
        <td>—</td>
        <td class="${pctCls(b_1y)}">${DataLoader.fmtPct(b_1y)}</td>
        <td class="${pctCls(b_3y)}">${DataLoader.fmtPct(b_3y)}</td>
        <td class="${pctCls(b_5y)}">${DataLoader.fmtPct(b_5y)}</td>
        <td>—</td>
      </tr>
      <tr class="row-cat">
        <td>${escapeHtml(fund.category)} · Category Avg</td>
        <td class="${pctCls(c_ytd)}">${DataLoader.fmtPct(c_ytd)}</td>
        <td class="${pctCls(c_1y)}">${DataLoader.fmtPct(c_1y)}</td>
        <td class="${pctCls(c_3y)}">${DataLoader.fmtPct(c_3y)}</td>
        <td class="${pctCls(c_5y)}">${DataLoader.fmtPct(c_5y)}</td>
        <td class="${pctCls(c_si)}">${DataLoader.fmtPct(c_si)}</td>
      </tr>
      <tr class="row-excess">
        <td><b>Excess vs Benchmark</b></td>
        <td>${deltaCell(e_ytd)}</td>
        <td>${deltaCell(e_1y)}</td>
        <td>${deltaCell(e_3y)}</td>
        <td>${deltaCell(e_5y)}</td>
        <td>${deltaCell(e_si)}</td>
      </tr>`;
  }

  function deltaCell(v) {
    if (v == null || isNaN(v)) return '—';
    const cls = v > 0 ? 'delta-pos' : (v < 0 ? 'delta-neg' : '');
    return `<span class="${cls}">${DataLoader.fmtPct(v)}</span>`;
  }
  function pctCls(v) {
    return (v != null && !isNaN(v) && v < 0) ? 'neg' : '';
  }

  /* ---------- Rolling Returns 6-card grid ---------- */
  function renderRolling(fund) {
    const stats = fund.rolling_3y_stats;
    const grid = document.getElementById('rollGrid');
    if (!stats) {
      // 6 placeholder cards — explicit em-dash so the layout still grids
      grid.innerHTML = Array.from({ length: 6 }).map((_, i) => `
        <div class="roll-card">
          <span class="lbl">${escapeHtml(_rollLabel(i))}</span>
          <div class="v">—</div>
          <div class="sub">Less than 1 year of NAV history — rolling stats activate at 3y tenure.</div>
          <div class="roll-bar"><i style="width:0%"></i></div>
        </div>`).join('');
      return;
    }
    const cards = [
      {
        lbl: 'Average', v: stats.avg_pct, sub: `Across ${stats.observation_count.toLocaleString('en-IN')} observations · daily roll`,
        max: 35, fmt: pctFmt,
      },
      {
        lbl: 'Median', v: stats.median_pct, sub: 'Distribution centre · half above, half below',
        max: 35, fmt: pctFmt,
      },
      {
        lbl: '% Periods > 12%', v: stats.pct_above_12,
        sub: 'Frequency of 3Y CAGR exceeding 12% — realistic India equity floor',
        max: 100, fmt: pctPosFmt,
      },
      {
        lbl: 'Best 3Y', v: stats.best_pct,
        sub: `Window starting ${escapeHtml(DataLoader.fmtDate(stats.best_window_start))}`,
        max: 35, fmt: pctFmt,
      },
      {
        lbl: 'Worst 3Y', v: stats.worst_pct,
        sub: `Window starting ${escapeHtml(DataLoader.fmtDate(stats.worst_window_start))}`,
        max: 35, fmt: pctFmt,
      },
      {
        lbl: '% Beat Benchmark',
        v: stats.pct_beat_benchmark,
        sub: stats.pct_beat_benchmark != null ? '3Y rolling, vs fund benchmark' : 'Benchmark series unavailable',
        max: 100, fmt: pctPosFmt,
      },
    ];

    grid.innerHTML = cards.map(c => {
      const v = c.v;
      const display = v != null ? c.fmt(v) : '—';
      const negCls = (v != null && v < 0) ? 'neg' : '';
      const barWidth = v != null ? Math.max(0, Math.min(100, (Math.abs(v) / c.max) * 100)) : 0;
      const barNegCls = (v != null && v < 0) ? 'neg' : '';
      return `
        <div class="roll-card">
          <span class="lbl">${escapeHtml(c.lbl)}</span>
          <div class="v ${negCls}">${escapeHtml(display)}</div>
          <div class="sub">${c.sub}</div>
          <div class="roll-bar"><i class="${barNegCls}" style="width:${barWidth.toFixed(1)}%"></i></div>
        </div>`;
    }).join('');
  }
  function _rollLabel(i) {
    return ['Average', 'Median', '% Periods > 12%', 'Best 3Y', 'Worst 3Y', '% Beat Benchmark'][i] || '';
  }
  function pctFmt(v)    { return DataLoader.fmtPct(v); }                 // signed
  function pctPosFmt(v) { return `${DataLoader.fmtNum(v, 1)}%`; }         // unsigned

  /* ============================================================
   * 02 — RISK
   * ============================================================ */
  function renderRisk(fund, cycle) {
    const peers = (cycle.funds || []).filter(f => f.category === fund.category);
    function catAvg(picker) {
      if (peers.length < 3) return null;
      const vals = peers.map(picker).filter(v => v != null && !isNaN(v));
      if (vals.length === 0) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    }
    const rm = fund.risk_metrics || {};
    const sharpe   = rm.sharpe_3y;
    const downCap  = rm.down_capture_3y_pct;
    const upCap    = rm.up_capture_3y_pct;
    const captureRatio = (upCap != null && downCap != null && downCap !== 0)
      ? (upCap / downCap) : null;
    const maxDD    = rm.max_drawdown_3y_pct;
    const beta     = rm.beta_3y;

    const catSharpe   = catAvg(f => f.risk_metrics ? f.risk_metrics.sharpe_3y : null);
    const catDownCap  = catAvg(f => f.risk_metrics ? f.risk_metrics.down_capture_3y_pct : null);
    const catUpCap    = catAvg(f => f.risk_metrics ? f.risk_metrics.up_capture_3y_pct : null);
    const catBeta     = catAvg(f => f.risk_metrics ? f.risk_metrics.beta_3y : null);
    const catMaxDD    = catAvg(f => f.risk_metrics ? f.risk_metrics.max_drawdown_3y_pct : null);
    const catCapture  = (catUpCap != null && catDownCap != null && catDownCap !== 0)
      ? (catUpCap / catDownCap) : null;

    const cards = [
      {
        lbl: 'Sharpe', v: sharpe, fmt: v => DataLoader.fmtNum(v, 2),
        cmp: `3Y trailing · Rf ${RF_RATE_DISPLAY}<br>Cat avg · <b>${nullOrNum(catSharpe, 2)}</b>`,
      },
      {
        lbl: 'Down Capture', v: downCap, fmt: v => `${DataLoader.fmtNum(v, 1)}%`,
        cmp: `Benchmark · <b>100.0%</b><br>Cat avg · <b>${nullOrPct(catDownCap, 1)}</b>`,
      },
      {
        lbl: 'Up Capture', v: upCap, fmt: v => `${DataLoader.fmtNum(v, 1)}%`,
        cmp: `Benchmark · <b>100.0%</b><br>Cat avg · <b>${nullOrPct(catUpCap, 1)}</b>`,
      },
      {
        lbl: 'Capture Ratio', v: captureRatio, fmt: v => DataLoader.fmtNum(v, 2),
        cmp: `Up ÷ Down · &gt;1 favourable<br>Cat avg · <b>${nullOrNum(catCapture, 2)}</b>`,
      },
      {
        lbl: 'Max Drawdown', v: maxDD, fmt: v => `${DataLoader.fmtNum(v, 2)}%`, neg: true,
        cmp: `3Y trailing window<br>Cat avg · <b>${nullOrPct(catMaxDD, 2)}</b>`,
      },
      {
        lbl: 'Beta', v: beta, fmt: v => DataLoader.fmtNum(v, 2),
        cmp: `Vs benchmark · 3Y daily<br>Cat avg · <b>${nullOrNum(catBeta, 2)}</b>`,
      },
    ];
    document.getElementById('riskGrid').innerHTML = cards.map(c => {
      const display = c.v != null ? c.fmt(c.v) : '—';
      const negCls = c.neg && c.v != null && c.v < 0 ? 'neg' : '';
      return `
        <div class="risk-card">
          <span class="lbl">${escapeHtml(c.lbl)}</span>
          <div class="v ${negCls}">${escapeHtml(display)}</div>
          <div class="bench-cmp">${c.cmp}</div>
        </div>`;
    }).join('');
  }
  function nullOrNum(v, dp) { return v != null ? DataLoader.fmtNum(v, dp) : '—'; }
  function nullOrPct(v, dp) { return v != null ? `${DataLoader.fmtNum(v, dp)}%` : '—'; }

  /* ============================================================
   * 03 — MANAGER
   * ============================================================ */
  function renderManager(fund) {
    const name = fund.manager_name || '—';
    document.getElementById('mgrName').textContent = name;
    document.getElementById('mgrTitle').textContent =
      `${fund.amc || '—'} · Lead Manager · Tenure ${fund.manager_tenure_yrs != null ? DataLoader.fmtNum(fund.manager_tenure_yrs, 1) + ' yrs' : '—'}`;
    document.getElementById('mgrAvatar').textContent = managerInitials(name);
    document.getElementById('mgrBio').textContent =
      `Loading manager profile for ${name}…`;
    document.getElementById('mgrBio').classList.add('placeholder');

    // Lead Manager table (single row in v1; we don't have co-managers in JSON)
    const tenureStr = fund.manager_tenure_yrs != null
      ? `${DataLoader.fmtNum(fund.manager_tenure_yrs, 1)} yrs` : '—';
    document.getElementById('mgrLeadTbody').innerHTML = `
      <tr>
        <td>${escapeHtml(name)} · Lead Manager</td>
        <td>${escapeHtml(tenureStr)}</td>
      </tr>`;

    // Stats grid
    const cells = [
      ['Tenure',         fund.manager_tenure_yrs != null ? `${DataLoader.fmtNum(fund.manager_tenure_yrs, 1)} yrs` : '—'],
      ['Fund AUM',       fund.aum_cr != null ? `₹ ${DataLoader.fmtINR(fund.aum_cr)} Cr` : '—'],
      ['No. of Stocks',  fund.no_of_stocks != null ? fund.no_of_stocks : '—'],
      ['AMC Score',      fund.amc_score != null ? `${fund.amc_score} / 10` : '—'],
      ['Active Share',   '—'],
      ['Fund Tenure',    fund.fund_tenure_yrs != null ? `${DataLoader.fmtNum(fund.fund_tenure_yrs, 1)} yrs` : '—'],
    ];
    document.getElementById('mgrStats').innerHTML = cells
      .map(([k, v]) => `<div class="cell"><span class="k">${escapeHtml(k)}</span><div class="v">${escapeHtml(String(v))}</div></div>`)
      .join('');
  }

  function renderManagerBio(profile, name) {
    const el = document.getElementById('mgrBio');
    if (profile && profile.bio) {
      el.classList.remove('placeholder');
      el.textContent = profile.bio;
    } else {
      el.classList.add('placeholder');
      el.textContent = `Manager profile for ${name || 'this manager'} is being compiled. Check back after the next cycle update.`;
    }
  }

  function managerInitials(name) {
    if (!name) return '—';
    const cleaned = String(name).replace(/[^A-Za-z\s]/g, '').trim();
    if (!cleaned) return '—';
    const parts = cleaned.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  /* ============================================================
   * 04 — PORTFOLIO
   * ============================================================ */
  function renderPortfolio(fund) {
    const m = fund.mcap_split || {};
    const segs = [
      { cls: 'large', label: 'Large',  pct: m.large_pct },
      { cls: 'mid',   label: 'Mid',    pct: m.mid_pct   },
      { cls: 'small', label: 'Small',  pct: m.small_pct },
      { cls: 'cash',  label: 'Others/Cash', pct: m.others_pct },
    ];
    document.getElementById('mcapBars').innerHTML = renderBars(segs);

    // Hybrid extension — only show when sub_class === 'Hybrid' AND data present
    const h = fund.hybrid_extension || {};
    const wrap = document.getElementById('hybridMixWrap');
    if (fund.sub_category_class === 'Hybrid' &&
        (h.equity_pct != null || h.debt_pct != null || h.others_pct_hybrid != null)) {
      wrap.hidden = false;
      const hSegs = [
        { cls: 'equity',   label: 'Equity', pct: h.equity_pct },
        { cls: 'debt',     label: 'Debt',   pct: h.debt_pct   },
        { cls: 'others-h', label: 'Others', pct: h.others_pct_hybrid },
      ];
      document.getElementById('hybridBars').innerHTML = renderBars(hSegs);
    } else {
      wrap.hidden = true;
    }
  }
  function renderBars(segs) {
    return segs.map(s => {
      const pct = s.pct != null ? Math.max(0, Number(s.pct)) : 0;
      if (pct < 0.01) return '';
      const showLabel = pct > 8;
      const text = showLabel ? `${escapeHtml(s.label)} ${DataLoader.fmtNum(pct, 1)}%` : '';
      return `<div class="seg ${s.cls}" style="width:${pct.toFixed(2)}%">${text}</div>`;
    }).join('');
  }

  /* ============================================================
   * 05 — COST
   * ============================================================ */
  function renderCost(fund, cycle) {
    const peers = (cycle.funds || []).filter(f => f.category === fund.category);
    function median(picker) {
      const vals = peers.map(picker).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
      if (vals.length === 0) return null;
      const m = Math.floor(vals.length / 2);
      return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
    }
    const ter = fund.ter_pct;
    const catTer = median(f => f.ter_pct);
    let terSub;
    if (ter != null && catTer != null) {
      const bps = Math.round((ter - catTer) * 100);
      const cls = bps < 0 ? 'pos' : (bps > 0 ? 'neg' : '');
      const word = bps === 0 ? 'aligned with category median' :
        bps < 0 ? `${Math.abs(bps)} bps cheaper` : `${bps} bps pricier`;
      terSub = `Cat median ${DataLoader.fmtNum(catTer, 2)}% — <b class="${cls}">${escapeHtml(word)}</b>`;
    } else {
      terSub = 'Category median unavailable.';
    }

    const cards = [
      {
        lbl: 'Total Expense Ratio',
        v: ter != null ? `${DataLoader.fmtNum(ter, 2)}%` : '—',
        sub: terSub,
      },
      {
        lbl: 'Exit Load',
        v: '—',
        sub: 'Exit-load data not yet in pipeline — check the offer document for the most recent rule.',
      },
      {
        lbl: 'Portfolio Turnover',
        v: fund.turnover_pct != null ? `${DataLoader.fmtNum(fund.turnover_pct, 1)}%` : '—',
        sub: 'Lower = longer holding period.',
      },
      {
        lbl: 'Min SIP / Lumpsum',
        v: '—',
        sub: 'SIP / lumpsum minimums not yet in pipeline — check the offer document.',
      },
    ];
    document.getElementById('costGrid').innerHTML = cards.map(c => `
      <div class="cost-card">
        <span class="lbl">${escapeHtml(c.lbl)}</span>
        <div class="v">${escapeHtml(c.v)}</div>
        <div class="sub">${c.sub}</div>
      </div>`).join('');
  }

  /* ============================================================
   * NAV CHART (Performance)
   * ============================================================ */
  async function loadNavSeries(schemeCode) {
    const cycleDate = _cycle.cycle_meta.cycle_date;
    const url = `data/nav-series-${cycleDate}.json`;
    const res = await fetch(url, { cache: 'default' });
    if (!res.ok) throw new Error('nav-series HTTP ' + res.status);
    const doc = await res.json();
    const entry = doc.series && doc.series[String(schemeCode)];
    if (!entry) throw new Error('scheme not in nav-series');
    return entry;
  }

  function ensureChartJs() {
    if (typeof window.Chart !== 'undefined') return Promise.resolve();
    if (_chartJsLoadPromise) return _chartJsLoadPromise;
    _chartJsLoadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CHART_JS_CDN;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Chart.js failed to load'));
      document.head.appendChild(s);
    });
    return _chartJsLoadPromise;
  }

  function renderNavChart() {
    if (!_navSeries || !_navSeries.fund || _navSeries.fund.length === 0) {
      showNavEmpty();
      return;
    }
    ensureChartJs().then(() => {
      doRenderNavChart();
      // Wire toggles
      document.querySelectorAll('#navToggles button').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('#navToggles button').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          _navWindow = btn.getAttribute('data-window');
          doRenderNavChart();
        });
      });
    }).catch(showNavEmpty);
  }

  function doRenderNavChart() {
    const s = _navSeries;
    const fund = s.fund || [];
    const bench = s.bench || [];
    if (fund.length < 2) { showNavEmpty(); return; }

    // Determine window start
    const lastDate = parseYM(fund[fund.length - 1].d);
    const windowStart = computeWindowStart(_navWindow, lastDate, parseYM(fund[0].d));
    const slicedFund  = fund.filter(p => parseYM(p.d) >= windowStart);
    const slicedBench = bench.filter(p => parseYM(p.d) >= windowStart);

    if (slicedFund.length < 2) { showNavEmpty(); return; }

    // Normalise both series to ₹1,00,000 at the start of the window
    const baseFund = slicedFund[0].v;
    const baseBench = slicedBench.length ? slicedBench[0].v : null;
    const normalisedFund  = slicedFund.map(p => ({ d: p.d, v: (p.v / baseFund) * 100000 }));
    const normalisedBench = baseBench
      ? slicedBench.map(p => ({ d: p.d, v: (p.v / baseBench) * 100000 }))
      : [];

    const labels = normalisedFund.map(p => p.d);
    const fundData = normalisedFund.map(p => p.v);
    // Align bench data to fund's labels by date key (so missing bench months render gaps)
    const benchByMonth = new Map(normalisedBench.map(p => [p.d, p.v]));
    const benchData = labels.map(d => benchByMonth.has(d) ? benchByMonth.get(d) : null);

    const cap = document.getElementById('navChartCaption');
    const startStr  = formatYMShort(slicedFund[0].d);
    const endStr    = formatYMShort(slicedFund[slicedFund.length - 1].d);
    cap.textContent = `${startStr} → ${endStr} · normalised at window start to ₹ 1,00,000`;

    const ctx = document.getElementById('navChart').getContext('2d');
    if (_navChartInstance) { _navChartInstance.destroy(); _navChartInstance = null; }

    _navChartInstance = new window.Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Fund',
            data: fundData,
            borderColor: '#6B3F1A', backgroundColor: 'rgba(107,63,26,.10)',
            fill: true, tension: .25, pointRadius: 0, borderWidth: 2.4,
          },
          {
            label: 'Benchmark',
            data: benchData,
            borderColor: '#BFBFBF', backgroundColor: 'transparent',
            fill: false, tension: .25, pointRadius: 0, borderWidth: 1.8, borderDash: [],
            spanGaps: true,
          },
        ],
      },
      options: chartOpts({
        yTickCallback: (v) => '₹ ' + DataLoader.fmtINR(v),
        xMaxTicks: 6,
      }),
    });
    document.getElementById('navChartEmpty').hidden = true;
    document.getElementById('navChart').style.display = '';
  }

  function showNavEmpty() {
    document.getElementById('navChart').style.display = 'none';
    document.getElementById('navChartEmpty').hidden = false;
    document.getElementById('navChartCaption').textContent = '—';
  }
  function showDdEmpty() {
    document.getElementById('ddChart').style.display = 'none';
    document.getElementById('ddChartEmpty').hidden = false;
  }

  /* ============================================================
   * DRAWDOWN CHART (Risk)
   * ============================================================ */
  function renderDrawdownChart() {
    if (!_navSeries || !_navSeries.fund || _navSeries.fund.length < 2) {
      showDdEmpty(); return;
    }
    ensureChartJs().then(doRenderDdChart).catch(showDdEmpty);
  }

  function doRenderDdChart() {
    const fund = _navSeries.fund || [];
    if (fund.length < 12) { showDdEmpty(); return; }
    // 5Y window
    const lastDate = parseYM(fund[fund.length - 1].d);
    const windowStart = computeWindowStart('5Y', lastDate, parseYM(fund[0].d));
    const sliced = fund.filter(p => parseYM(p.d) >= windowStart);
    if (sliced.length < 12) { showDdEmpty(); return; }

    // Compute drawdown series: dd[t] = (nav[t] / running_peak) - 1
    let peak = sliced[0].v;
    const dd = sliced.map(p => {
      if (p.v > peak) peak = p.v;
      const d = peak > 0 ? (p.v / peak - 1) : 0;
      return { d: p.d, dd: d * 100 };
    });

    const labels = dd.map(p => p.d);
    const ddData = dd.map(p => p.dd);

    const ctx = document.getElementById('ddChart').getContext('2d');
    if (_ddChartInstance) { _ddChartInstance.destroy(); _ddChartInstance = null; }
    _ddChartInstance = new window.Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'Drawdown',
          data: ddData,
          borderColor: '#931621', backgroundColor: 'rgba(147,22,33,.15)',
          fill: true, tension: .15, pointRadius: 0, borderWidth: 1.8,
        }],
      },
      options: chartOpts({
        yMax: 0,
        yTickCallback: (v) => `${DataLoader.fmtNum(v, 0)}%`,
        xMaxTicks: 6,
      }),
    });
    document.getElementById('ddChartEmpty').hidden = true;
    document.getElementById('ddChart').style.display = '';
  }

  /* ---------- Chart.js shared options ---------- */
  function chartOpts(extra) {
    extra = extra || {};
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#000', titleColor: '#BD9568', bodyColor: '#fff',
          borderColor: '#6B3F1A', borderWidth: 1,
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw == null ? '—' :
              (extra.yTickCallback ? extra.yTickCallback(ctx.raw) :
                DataLoader.fmtNum(ctx.raw, 2))}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            font: { family: "'Cambria', Georgia, serif", size: 10 },
            color: '#666',
            maxTicksLimit: extra.xMaxTicks || 8,
            callback: function (val) {
              const lbl = this.getLabelForValue(val);
              return formatYMShort(lbl);
            },
          },
        },
        y: {
          grid: { color: 'rgba(217, 217, 217, .55)', drawBorder: false },
          ticks: {
            font: { family: "'Cambria', Georgia, serif", size: 10 },
            color: '#666',
            callback: function (v) {
              return extra.yTickCallback ? extra.yTickCallback(v) : DataLoader.fmtNum(v, 2);
            },
          },
          max: extra.yMax,
        },
      },
    };
  }

  /* ---------- date helpers (YYYY-MM keys) ---------- */
  function parseYM(ym) {
    const [y, m] = String(ym).split('-').map(Number);
    return new Date(Date.UTC(y, (m || 1) - 1, 1));
  }
  function formatYMShort(ym) {
    const d = parseYM(ym);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  }
  function computeWindowStart(win, lastDate, seriesStart) {
    const out = new Date(lastDate);
    if (win === 'SI') return seriesStart;
    if (win === '1Y') out.setUTCFullYear(out.getUTCFullYear() - 1);
    if (win === '3Y') out.setUTCFullYear(out.getUTCFullYear() - 3);
    if (win === '5Y') out.setUTCFullYear(out.getUTCFullYear() - 5);
    return out < seriesStart ? seriesStart : out;
  }

  /* ============================================================
   * MANAGER PROFILE LOADER
   * ============================================================ */
  async function loadManagerProfile(name) {
    if (!name) return null;
    try {
      const res = await fetch('data/manager-profiles.json', { cache: 'default' });
      if (!res.ok) return null;
      const doc = await res.json();
      return (doc.profiles && doc.profiles[name]) || null;
    } catch (_) {
      return null;
    }
  }

  /* ============================================================
   * BUTTONS / INTERACTIONS
   * ============================================================ */
  function wireBreadcrumb(fund) {
    document.getElementById('crumbName').textContent = fund.fund_name || 'Fund Detail';
  }
  function wireActionButtons(fund) {
    document.getElementById('addToCompareBtn').addEventListener('click', () => {
      window.location.href = `compare.html?schemes=${fund.scheme_code}`;
    });
    const watchBtn = document.getElementById('watchlistBtn');
    function syncWatch() {
      const on = AppState.isWatched(fund.scheme_code);
      watchBtn.textContent = on ? '★ Watched' : '☆ Add to Watchlist';
      watchBtn.classList.toggle('primary', on);
    }
    syncWatch();
    watchBtn.addEventListener('click', () => {
      if (AppState.isWatched(fund.scheme_code)) AppState.removeFromWatchlist(fund.scheme_code);
      else AppState.addToWatchlist(fund.scheme_code);
      syncWatch();
      showToast(AppState.isWatched(fund.scheme_code) ? 'Added to watchlist.' : 'Removed from watchlist.');
    });
    document.getElementById('shareLinkBtn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        showToast('Link copied to clipboard.');
      } catch (_) {
        showToast('Copy failed — paste from address bar.');
      }
    });
  }
  function wireToc() {
    document.querySelectorAll('aside.toc a').forEach(a => {
      a.addEventListener('click', (e) => {
        const id = a.getAttribute('href').slice(1);
        const el = document.getElementById(id);
        if (el) {
          e.preventDefault();
          window.scrollTo({
            top: el.getBoundingClientRect().top + window.scrollY - 96,
            behavior: 'smooth',
          });
        }
      });
    });
  }
  function wireRawJsonLink() {
    const link = document.getElementById('rawJsonLink');
    if (!link || !_cycle) return;
    link.href = `data/screener-${_cycle.cycle_meta.cycle_date}.json`;
  }
  function renderFooter(cycle) {
    document.getElementById('footUpdated').textContent =
      `Last updated · ${cycle.cycle_meta.as_on_display}`;
    document.getElementById('verdictSubtitle').textContent =
      `Updated ${cycle.cycle_meta.as_on_display} · Authored by the Centricity Investment Committee`;
  }

  /* ============================================================
   * ERROR / FALLBACK SHELLS
   * ============================================================ */
  function renderLoadError(err) {
    document.getElementById('mainArea').innerHTML = `
      <div class="not-found">
        <div class="ring-motif" aria-hidden="true"></div>
        <h3>Could not load cycle data</h3>
        <p>Serve via <code>python -m http.server</code> rather than opening the file directly.<br><span style="color:var(--red)">${escapeHtml((err && err.message) || String(err))}</span></p>
        <p><a class="btn primary" href="screener.html">Back to Screener</a></p>
      </div>`;
  }

  function renderNotFound(scheme) {
    // Hide hero / report; show the not-found shell
    document.getElementById('heroSection').style.display = 'none';
    document.querySelector('.report').style.display = 'none';
    const nf = document.getElementById('notFound');
    nf.hidden = false;
    document.getElementById('notFoundHeading').textContent = 'Fund not found';
    document.getElementById('notFoundBody').textContent =
      `Scheme code ${scheme} isn't in the ${DataLoader.fmtCycleLabelDate(_cycle.cycle_meta)} cycle. It may have been wound up or re-categorised.`;
  }

  function renderPicker(cycle) {
    const m = cycle.cycle_meta;
    document.getElementById('heroEyebrow').textContent =
      `Fund Report Card · As on ${DataLoader.fmtCycleLabelDate(m)}`;
    document.getElementById('fundTitle').textContent = 'Pick a fund';
    document.getElementById('crumbName').textContent = 'Fund Detail';
    document.getElementById('heroMeta').innerHTML = '';
    // Hide the score card and the report sections; show a top-25 picker
    document.getElementById('scoreCard').style.display = 'none';
    document.querySelector('.hero-actions').style.display = 'none';
    const reportContent = document.querySelector('.report-content');
    reportContent.innerHTML = `
      <section class="block">
        <h2>Top 25 by <em>Centricity Rank</em></h2>
        <p class="h-sub">Click a row to open the fund's report card.</p>
        <div class="perf-table-wrap">
          <table class="perf">
            <thead>
              <tr><th>#</th><th>Fund</th><th>Category</th><th>1Y</th><th>3Y</th><th>5Y</th><th>Score</th></tr>
            </thead>
            <tbody>
              ${(cycle.funds || [])
                .filter(f => f.centricity_score_status === 'Ranked')
                .sort((a, b) => (a.centricity_rank_overall || 9999) - (b.centricity_rank_overall || 9999))
                .slice(0, 25)
                .map(f => `
                  <tr style="cursor:pointer" onclick="window.location.href='fund-detail.html?scheme=${f.scheme_code}'">
                    <td>${f.centricity_rank_overall ?? '—'}</td>
                    <td class="row-fund-cell"><b>${escapeHtml(f.fund_name)}</b><div style="font-size:11px;color:var(--text-mid);">${escapeHtml(f.amc || '')} · #${f.scheme_code}</div></td>
                    <td>${escapeHtml(f.category)}</td>
                    <td class="${pctCls(f.trailing_returns?.return_1y_pct)}">${DataLoader.fmtPct(f.trailing_returns?.return_1y_pct)}</td>
                    <td class="${pctCls(f.trailing_returns?.return_3y_pct)}">${DataLoader.fmtPct(f.trailing_returns?.return_3y_pct)}</td>
                    <td class="${pctCls(f.trailing_returns?.return_5y_pct)}">${DataLoader.fmtPct(f.trailing_returns?.return_5y_pct)}</td>
                    <td><b>${DataLoader.fmtScorePct(f.centricity_score)}</b></td>
                  </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </section>`;
    renderFooter(cycle);
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

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
})();
