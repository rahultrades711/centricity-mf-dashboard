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
    renderVerdict(fund, cycle);
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
      // Now that bench monthly series is in memory, fill in YTD / 1M / 10Y
      // bench cells in the returns table + redraw the bar chart.
      updateBenchCellsAfterNavLoad();
    }).catch((e) => {
      console.warn('[fund-detail] nav-series unavailable', e);
      showNavEmpty();
      showDdEmpty();
      // Returns table still renders with bench YTD/1M/10Y as em-dash, and
      // the bar chart still draws (those datasets just have null values).
      _renderReturnsBarChartWhenReady();
    });
    // Analytics JSON for the Portfolio section (Fix-List 5 §C9)
    loadAnalyticsForFund(fund.scheme_code).then(entry => {
      renderAnalyticsHoldings(entry);
    }).catch((e) => {
      console.warn('[fund-detail] analytics JSON unavailable', e);
      // Leave the placeholder visible (already rendered as default markup)
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
    // Fix-List 5 §C5 — Recommended pill + Conviction label removed; the
    // score card now shows only the big score + delta line + 4-cell mini
    // grid. Verdict copy lives in section 07's strengths/concerns insights.
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
   * Fix-List 5 §C6+§C7 — 6-column returns table sourced from Monitor
   * (point-to-point) for Fund + Cat Avg; benchmark cells from Monitor's
   * benchmark_returns where available + nav-series-derived YTD/1M/10Y.
   * Plus a grouped bar chart Fund/Bench/Cat-avg across the 6 periods.
   * ============================================================ */
  // Cached per-page state so updateBenchCellsAfterNavLoad() can re-render
  // the same table once nav-series resolves (YTD / 1M / 10Y bench cells
  // need the index NAV series, which loads asynchronously).
  let _perfState = null;

  const PERF_FIELDS = [
    { col: 'YTD', monitorKey: 'ytd_pct',        period: 'ytd' },
    { col: '1M',  monitorKey: 'return_1m_pct',  period: '1m'  },
    { col: '1Y',  monitorKey: 'return_1y_pct',  period: '1y'  },
    { col: '3Y',  monitorKey: 'return_3y_pct',  period: '3y'  },
    { col: '5Y',  monitorKey: 'return_5y_pct',  period: '5y'  },
    { col: '10Y', monitorKey: 'return_10y_pct', period: '10y' },
  ];

  function renderPerformance(fund, cycle) {
    const peers = (cycle.funds || []).filter(f => f.category === fund.category);
    const peerCount = peers.length;
    const benchmarkName = fund.benchmark || '—';
    const cycleLabel = DataLoader.fmtCycleLabelDate(cycle.cycle_meta);
    document.getElementById('perfSubtitle').textContent =
      `Point-to-point returns as on ${cycleLabel}. Benchmark from index NAV series. ` +
      `Category average from ${peerCount} fund${peerCount === 1 ? '' : 's'} in ${fund.category}.`;

    // Fund row from Monitor (point-to-point); 10Y suppressed when fund_tenure < 10y
    const m = fund.monitor_returns || {};
    const fundVals = PERF_FIELDS.map(f => m[f.monitorKey]);
    if (fund.fund_tenure_yrs != null && fund.fund_tenure_yrs < 10) {
      fundVals[5] = null;
    }

    // Benchmark — 1Y/3Y/5Y from screener-converter benchmark_returns;
    // YTD/1M/10Y from nav-series (lazy, populated by updateBenchCellsAfterNavLoad)
    const br = fund.benchmark_returns || {};
    const benchVals = [
      null,                         // YTD — populated when nav-series loads
      null,                         // 1M
      br.return_1y_pct,
      br.return_3y_pct,
      br.return_5y_pct,
      null,                         // 10Y
    ];

    // Category avg from peers' monitor_returns — needs ≥ 3 peers with the field
    function catAvg(key) {
      const vals = peers
        .map(p => (p.monitor_returns || {})[key])
        .filter(v => v != null && !isNaN(v));
      if (vals.length < 3) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    }
    const catVals = PERF_FIELDS.map(f => catAvg(f.monitorKey));

    _perfState = { fund, cycle, benchmarkName, peerCount, fundVals, benchVals, catVals };
    _renderReturnsTable();
    _renderReturnsBarChartWhenReady();
  }

  /**
   * Invoked after `_navSeries` resolves — fills in benchmark YTD / 1M / 10Y
   * from the monthly index series and re-renders both the returns table
   * and the grouped bar chart.
   */
  function updateBenchCellsAfterNavLoad() {
    if (!_perfState || !_navSeries || !Array.isArray(_navSeries.bench)) return;
    const cycleDate = _cycle.cycle_meta.cycle_date;
    const bench = _navSeries.bench;
    _perfState.benchVals[0] = _benchYtdPctFromMonthly(bench, cycleDate);
    _perfState.benchVals[1] = _benchOneMonthPctFromMonthly(bench, cycleDate);
    _perfState.benchVals[5] = _benchTenYearCagrFromMonthly(bench, cycleDate);
    _renderReturnsTable();
    _renderReturnsBarChartWhenReady();
  }

  function _renderReturnsTable() {
    if (!_perfState) return;
    const { fund, benchmarkName, fundVals, benchVals, catVals } = _perfState;
    const fmt = (v) => fmtPctOnePlace(v);
    const cell = (v) => (v == null || isNaN(v))
      ? '<td>—</td>'
      : `<td class="${v < 0 ? 'neg' : ''}">${fmt(v)}</td>`;

    document.getElementById('perfTbody').innerHTML = `
      <tr class="row-fund">
        <td>${escapeHtml(fund.fund_name)}</td>
        ${fundVals.map(cell).join('')}
      </tr>
      <tr class="row-bench">
        <td>${escapeHtml(benchmarkName)}</td>
        ${benchVals.map(cell).join('')}
      </tr>
      <tr class="row-cat">
        <td>${escapeHtml(fund.category)} · Category Avg</td>
        ${catVals.map(cell).join('')}
      </tr>`;
  }

  function _renderReturnsBarChartWhenReady() {
    ensureChartJs().then(() => _renderReturnsBarChart()).catch(() => {/* silent */});
  }

  let _returnsBarChartInstance = null;
  function _renderReturnsBarChart() {
    if (!_perfState) return;
    const { fundVals, benchVals, catVals } = _perfState;
    const labels = PERF_FIELDS.map(f => f.col);
    const ctx = document.getElementById('returnsBarChart').getContext('2d');
    if (_returnsBarChartInstance) {
      _returnsBarChartInstance.destroy();
      _returnsBarChartInstance = null;
    }

    // Per-bar colour: red for negatives regardless of dataset, brand colour otherwise
    const colourBars = (vals, brandColor) => vals.map(v =>
      (v != null && v < 0) ? '#931621' : brandColor
    );

    _returnsBarChartInstance = new window.Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Fund',
            data: fundVals.map(v => v == null ? null : v),
            backgroundColor: colourBars(fundVals, '#6B3F1A'),
            borderColor: '#6B3F1A', borderWidth: 0,
          },
          {
            label: 'Benchmark',
            data: benchVals.map(v => v == null ? null : v),
            backgroundColor: colourBars(benchVals, '#BFBFBF'),
            borderColor: '#BFBFBF', borderWidth: 0,
          },
          {
            label: 'Category Avg',
            data: catVals.map(v => v == null ? null : v),
            backgroundColor: colourBars(catVals, '#BD9568'),
            borderColor: '#BD9568', borderWidth: 0,
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 200 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#000', titleColor: '#BD9568', bodyColor: '#fff',
            borderColor: '#6B3F1A', borderWidth: 1,
            callbacks: {
              label: (ctx) => `${ctx.dataset.label}: ${ctx.raw == null ? '—' : fmtPctOnePlace(ctx.raw)}`,
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { family: "'Cambria', Georgia, serif", size: 11 }, color: '#000' } },
          y: {
            grid: { color: 'rgba(217, 217, 217, .55)', drawBorder: false },
            ticks: {
              font: { family: "'Cambria', Georgia, serif", size: 10 },
              color: '#666',
              callback: (v) => `${v}%`,
            },
          },
        },
      },
    });
  }

  /* Bench computations from the monthly nav-series.
   * `bench` is an ascending array of {d:"YYYY-MM", v: <index value>}.
   * Cycle date is "YYYY-MM-DD"; we pin to the year/month-of-cycle for matching. */
  function _findMonthlyByYM(bench, ym) {
    // Last point with d <= ym (handles missing months gracefully)
    let pick = null;
    for (const p of bench) { if (p.d <= ym) pick = p; else break; }
    return pick;
  }
  function _benchYtdPctFromMonthly(bench, cycleDate) {
    if (!bench || bench.length < 2) return null;
    const cycleYear = parseInt(cycleDate.slice(0, 4), 10);
    const cycleYM = cycleDate.slice(0, 7);
    // YTD anchor = last month of (cycleYear - 1) (Dec close), e.g. "2025-12"
    const anchorYM = `${cycleYear - 1}-12`;
    const anchor = _findMonthlyByYM(bench, anchorYM);
    const cur = _findMonthlyByYM(bench, cycleYM);
    if (!anchor || !cur || !anchor.v || anchor.v <= 0) return null;
    return Math.round(((cur.v / anchor.v - 1) * 100) * 10000) / 10000;
  }
  function _benchOneMonthPctFromMonthly(bench, cycleDate) {
    if (!bench || bench.length < 2) return null;
    const cycleYM = cycleDate.slice(0, 7);
    const cur = _findMonthlyByYM(bench, cycleYM);
    if (!cur) return null;
    // Find the prior calendar month — point with d strictly < cycleYM, max
    let prior = null;
    for (const p of bench) { if (p.d < cycleYM) prior = p; else break; }
    if (!prior || !prior.v || prior.v <= 0) return null;
    return Math.round(((cur.v / prior.v - 1) * 100) * 10000) / 10000;
  }
  function _benchTenYearCagrFromMonthly(bench, cycleDate) {
    if (!bench || bench.length < 12) return null;
    const cycleYear = parseInt(cycleDate.slice(0, 4), 10);
    const cycleMonth = cycleDate.slice(5, 7);
    const tenYearYM = `${cycleYear - 10}-${cycleMonth}`;
    const start = _findMonthlyByYM(bench, tenYearYM);
    const cur = _findMonthlyByYM(bench, cycleDate.slice(0, 7));
    if (!start || !cur || !start.v || start.v <= 0) return null;
    // Require the start point to be within ~3 months of the 10y target
    const startDate = new Date(Date.UTC(parseInt(start.d.slice(0, 4), 10), parseInt(start.d.slice(5, 7), 10) - 1, 1));
    const targetDate = new Date(Date.UTC(cycleYear - 10, parseInt(cycleMonth, 10) - 1, 1));
    if (Math.abs(targetDate - startDate) > 1000 * 60 * 60 * 24 * 100) return null;
    const cagr = Math.pow(cur.v / start.v, 1 / 10) - 1;
    return Math.round(cagr * 100 * 10000) / 10000;
  }

  function fmtPctOnePlace(v) {
    if (v == null || isNaN(v)) return '—';
    const sign = v < 0 ? '−' : '';
    return sign + Math.abs(v).toFixed(1) + '%';
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
    // Bio uses the §D placeholder caption directly — no async load
    renderManagerBio(null, name);

    // Lead Manager table (single row in v1; we don't have co-managers in JSON)
    const tenureStr = fund.manager_tenure_yrs != null
      ? `${DataLoader.fmtNum(fund.manager_tenure_yrs, 1)} yrs` : '—';
    document.getElementById('mgrLeadTbody').innerHTML = `
      <tr>
        <td>${escapeHtml(name)} · Lead Manager</td>
        <td>${escapeHtml(tenureStr)}</td>
      </tr>`;

    // Stats grid — Fix-List 5 §C12 dropped 'Active Share' (no data source)
    const cells = [
      ['Tenure',         fund.manager_tenure_yrs != null ? `${DataLoader.fmtNum(fund.manager_tenure_yrs, 1)} yrs` : '—'],
      ['Fund AUM',       fund.aum_cr != null ? `₹ ${DataLoader.fmtINR(fund.aum_cr)} Cr` : '—'],
      ['No. of Stocks',  fund.no_of_stocks != null ? fund.no_of_stocks : '—'],
      ['AMC Score',      fund.amc_score != null ? `${fund.amc_score} / 10` : '—'],
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
  /**
   * Fix-List 5 §C8 — segments < 6% put their label OUTSIDE the bar
   * (anchored to the segment via `.seg-out` overlay) so the colour band
   * is always visible even on a 1-2% slice. A `min-width: 4px` floor
   * keeps the colour visible on near-zero allocations.
   */
  function renderBars(segs) {
    const visible = segs.map(s => ({
      cls: s.cls,
      label: s.label,
      pct: s.pct != null ? Math.max(0, Number(s.pct)) : 0,
    })).filter(s => s.pct > 0.01);
    return visible.map(s => {
      const inside = s.pct > 6;
      const labelHtml = inside
        ? `${escapeHtml(s.label)} ${DataLoader.fmtNum(s.pct, 1)}%`
        : `<span class="seg-out">${escapeHtml(s.label)} ${DataLoader.fmtNum(s.pct, 1)}%</span>`;
      return `<div class="seg ${s.cls} ${inside ? 'inside' : 'outside'}" style="width:${s.pct.toFixed(2)}%">${labelHtml}</div>`;
    }).join('');
  }

  /* ============================================================
   * 05 — COST
   * ============================================================ */
  function renderCost(fund, cycle) {
    // Fix-List 5 §C10 — cost section overhaul:
    //   • TER renamed to "TER (Regular Plan)" and sourced from Monitor's
    //     Ratio column (`monitor_ter_pct`). The Whitelisting Excel ter_pct
    //     looks like direct-plan TER and stays on the record but isn't
    //     surfaced here. See ISSUE-0013 data-quality note.
    //   • Exit Load now populated from `fund.exit_load` (Monitor file).
    //   • Min SIP / Lumpsum row dropped — no data source.
    //   • Taxation row added — derived from category mapping.
    const peers = (cycle.funds || []).filter(f => f.category === fund.category);
    function median(picker) {
      const vals = peers.map(picker).filter(v => v != null && !isNaN(v)).sort((a, b) => a - b);
      if (vals.length === 0) return null;
      const m = Math.floor(vals.length / 2);
      return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
    }
    const ter = fund.monitor_ter_pct;
    const catTer = median(f => f.monitor_ter_pct);
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

    const taxation = getTaxation(fund);
    const cards = [
      {
        lbl: 'TER (Regular Plan)',
        v: ter != null ? `${DataLoader.fmtNum(ter, 2)}%` : '—',
        sub: terSub,
      },
      {
        lbl: 'Exit Load',
        v: fund.exit_load || '—',
        sub: fund.exit_load
          ? 'From the latest MF Monitor.'
          : 'Exit-load data missing — check the offer document.',
      },
      {
        lbl: 'Portfolio Turnover',
        v: fund.turnover_pct != null ? `${DataLoader.fmtNum(fund.turnover_pct, 1)}%` : '—',
        sub: 'Lower = longer holding period.',
      },
      {
        lbl: 'Taxation',
        v: taxation.regime,
        sub: taxation.detail + ' <span class="footnote">Surcharge & cess applicable. Consult your tax advisor.</span>',
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
   * 07 — VERDICT (Fix-List 5 §C11)
   *
   * Client-side strengths/concerns generated from the fund's own data.
   * No BUY/SELL/HOLD calls — only factual observations driven by
   * trigger thresholds. Replaces the gold-ring-motif placeholder.
   * ============================================================ */
  function renderVerdict(fund, cycle) {
    document.getElementById('verdictSubtitle').textContent =
      `Updated ${cycle.cycle_meta.as_on_display} · Auto-derived from this cycle's data`;
    const insights = generateInsights(fund, cycle);
    const grid = document.getElementById('verdictGrid');
    if (insights.strengths.length === 0 && insights.concerns.length === 0) {
      grid.innerHTML = `
        <div class="verdict-empty" style="grid-column:1/-1">
          <div class="ring-motif gold" aria-hidden="true"></div>
          <p>Insights activate once enough data is in (sub-1y or sub-3y funds typically lack the metrics to drive observations). Check back next cycle.</p>
        </div>`;
      return;
    }
    const concernsBody = insights.concerns.length
      ? `<ul>${insights.concerns.map(s => `<li>${s}</li>`).join('')}</ul>`
      : `<p class="v-empty">No material concerns identified in this cycle's data.</p>`;
    const strengthsBody = insights.strengths.length
      ? `<ul>${insights.strengths.map(s => `<li>${s}</li>`).join('')}</ul>`
      : `<p class="v-empty">No standout strengths above thresholds in this cycle's data.</p>`;
    grid.innerHTML = `
      <div class="v-col">
        <h4>Strengths</h4>
        ${strengthsBody}
      </div>
      <div class="v-col cons">
        <h4>Areas to Watch</h4>
        ${concernsBody}
      </div>`;
    document.getElementById('verdictFoot').textContent =
      'Auto-generated from fund-side metrics. Centricity Investment Committee narrative arrives in Phase 5.';
  }

  function generateInsights(fund, cycle) {
    const strengths = [];
    const concerns = [];
    const peers = (cycle.funds || []).filter(f => f.category === fund.category);

    function pct1(v) { return DataLoader.fmtNum(v, 1) + '%'; }
    function escape(s) { return escapeHtml(String(s)); }

    // ---- Strengths ----
    if (fund.centricity_score != null && fund.centricity_score >= 0.80) {
      const ofN = (cycle.cycle_meta.total_funds || '—').toLocaleString('en-IN');
      const inCat = fund.centricity_rank_in_category != null ? `#${fund.centricity_rank_in_category} in ${escape(fund.category)}` : null;
      const overall = fund.centricity_rank_overall != null ? `#${fund.centricity_rank_overall} overall (of ${ofN})` : null;
      const rankPart = [inCat, overall].filter(Boolean).join(' / ');
      strengths.push(`Centricity Score <b>${(fund.centricity_score * 10).toFixed(2)}/10</b>${rankPart ? ' · ' + rankPart : ''}.`);
    }
    const rs = fund.rolling_3y_stats;
    if (rs && rs.pct_beat_benchmark != null && rs.pct_beat_benchmark >= 90) {
      strengths.push(`Beats benchmark in <b>${pct1(rs.pct_beat_benchmark)}</b> of all 3-year rolling windows.`);
    }
    if (rs && rs.pct_above_12 != null && rs.pct_above_12 >= 80) {
      strengths.push(`<b>${pct1(rs.pct_above_12)}</b> of rolling 3Y windows delivered &gt; 12% CAGR.`);
    }
    const maxDd = fund.risk_metrics ? fund.risk_metrics.max_drawdown_3y_pct : null;
    if (maxDd != null && maxDd > -15) {
      // Compute category avg drawdown (3-peer floor)
      const catDdVals = peers.map(p => p.risk_metrics ? p.risk_metrics.max_drawdown_3y_pct : null)
        .filter(v => v != null);
      const catDdAvg = catDdVals.length >= 3
        ? catDdVals.reduce((s, v) => s + v, 0) / catDdVals.length : null;
      if (catDdAvg != null && maxDd > catDdAvg) {
        strengths.push(`Max 3Y drawdown limited to <b>${pct1(maxDd)}</b> — shallower than category average <b>${pct1(catDdAvg)}</b>.`);
      } else {
        strengths.push(`Max 3Y drawdown limited to <b>${pct1(maxDd)}</b>.`);
      }
    }
    const a3 = fund.alpha ? fund.alpha.alpha_3y_pct : null;
    if (a3 != null && a3 > 5) {
      strengths.push(`3Y alpha of <b>+${DataLoader.fmtNum(a3, 1)}%</b> vs benchmark — consistent excess return.`);
    }
    if (fund.fund_tenure_yrs != null && fund.fund_tenure_yrs > 10) {
      strengths.push(`Fund track record spans <b>${DataLoader.fmtNum(fund.fund_tenure_yrs, 1)} years</b> across multiple market cycles.`);
    }
    if (fund.manager_name && fund.manager_tenure_yrs != null && fund.manager_tenure_yrs > 5) {
      strengths.push(`Manager <b>${escape(fund.manager_name)}</b> has <b>${DataLoader.fmtNum(fund.manager_tenure_yrs, 1)} years</b> at the helm — above-average continuity.`);
    }
    if (fund.consistency_pct != null && fund.consistency_pct >= 95) {
      strengths.push(`Consistency score of <b>${pct1(fund.consistency_pct)}</b> — rare in this category.`);
    }

    // ---- Concerns ----
    const m = fund.monitor_returns || {};
    const br = fund.benchmark_returns || {};
    if (m.return_1y_pct != null && br.return_1y_pct != null && m.return_1y_pct < br.return_1y_pct) {
      concerns.push(`1Y return <b>${pct1(m.return_1y_pct)}</b> trails benchmark <b>${pct1(br.return_1y_pct)}</b> — recent underperformance worth monitoring.`);
    }
    if (m.ytd_pct != null && m.ytd_pct < -5) {
      concerns.push(`YTD return of <b>${pct1(m.ytd_pct)}</b> — short-term drawdown in progress.`);
    }
    const sd = fund.risk_metrics ? fund.risk_metrics.std_dev_3y_pct : null;
    if (sd != null && sd > 15) {
      concerns.push(`Volatility (Std Dev <b>${pct1(sd)}</b>) above typical for this category — expect swings.`);
    }
    if (fund.manager_name && fund.manager_tenure_yrs != null && fund.manager_tenure_yrs < 2) {
      concerns.push(`Manager <b>${escape(fund.manager_name)}</b> has &lt; 2 years running this fund — track record limited.`);
    }
    if (fund.aum_cr != null && fund.aum_cr > 30000) {
      concerns.push(`AUM of <b>₹${DataLoader.fmtINR(fund.aum_cr)} Cr</b> — large corpus may constrain agility in mid/small-cap exposure.`);
    }
    if (fund.no_of_stocks != null && fund.no_of_stocks < 20) {
      concerns.push(`Concentrated portfolio of <b>${fund.no_of_stocks}</b> stocks — higher single-stock risk.`);
    }

    return { strengths, concerns };
  }

  /**
   * Derive equity-vs-slab taxation from the fund's SEBI category.
   * Equity-taxed: every Equity sub-class fund + the Hybrid categories
   * listed below (which have ≥ 65% equity exposure to qualify under
   * Sec 112A's equity-fund rule).
   * Slab-taxed: Conservative Hybrid + any Hybrid not in the equity list
   * (Hybrid debt-tilt funds taxed as debt under post-Apr-2023 rules).
   */
  function getTaxation(fund) {
    const EQUITY_TAXED_HYBRID = new Set([
      'Aggressive Hybrid', 'Balanced Advantage', 'Dynamic Asset Allocation',
      'Multi Asset Allocation', 'Equity Savings', 'Arbitrage',
    ]);
    const isEquityClass = fund.sub_category_class === 'Equity';
    const isEquityHybrid = fund.sub_category_class === 'Hybrid' &&
      EQUITY_TAXED_HYBRID.has(fund.category);
    if (isEquityClass || isEquityHybrid) {
      return {
        regime: 'Equity (LTCG / STCG)',
        detail: 'LTCG: 12.5% (>1 yr, above ₹1.25L exemption) · STCG: 20% (<1 yr).',
      };
    }
    return {
      regime: 'Slab rate',
      detail: 'Taxed at slab rate (any holding period, post Apr 2023 rules).',
    };
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
   * ANALYTICS LOADER (Fund Detail Fix-List 5 §C9)
   *
   * data/analytics-YYYY-MM-DD.json carries the top-20 holdings + sector
   * allocation per scheme_code. The file's `analytics_date` field drives
   * the "Holdings as on …" caption, so the date the dashboard reads is
   * data-driven (not hardcoded).
   * ============================================================ */
  let _analyticsDate = null;

  async function loadAnalyticsForFund(schemeCode) {
    // Discover the latest analytics file in data/. Right now there's
    // exactly one (analytics-2026-03-31.json); when v1.x ships monthly,
    // pick the latest by filename sort.
    const url = `data/analytics-2026-03-31.json`;
    const res = await fetch(url, { cache: 'default' });
    if (!res.ok) throw new Error('analytics HTTP ' + res.status);
    const doc = await res.json();
    _analyticsDate = doc.analytics_date || null;
    const entry = doc.funds && doc.funds[String(schemeCode)];
    if (!entry) throw new Error('scheme not in analytics');
    return entry;
  }

  function renderAnalyticsHoldings(entry) {
    const wrap = document.querySelector('.holdings-placeholder');
    if (!wrap || !entry) return;
    const sectors = entry.sector_allocation || [];
    const topHoldings = entry.top_20_holdings || [];
    const top10Concentration = entry.top_10_concentration_pct;
    const dateStr = _analyticsDate ? DataLoader.fmtDate(_analyticsDate) : '—';

    // Cap sector list at 10; if more, fold the rest into "Others"
    let sectorRows = sectors;
    if (sectorRows.length > 10) {
      const head = sectorRows.slice(0, 10);
      const tail = sectorRows.slice(10);
      const tailSum = tail.reduce((s, x) => s + (x.holding_pct || 0), 0);
      sectorRows = head.concat([{ sector: `Others (${tail.length})`, holding_pct: Math.round(tailSum * 100) / 100 }]);
    }
    const maxSectorPct = Math.max(...sectorRows.map(s => s.holding_pct || 0), 1);

    const sectorBars = sectorRows.map(s => {
      const widthPct = ((s.holding_pct || 0) / maxSectorPct) * 100;
      return `
        <div class="sector-row">
          <span class="sector-label">${escapeHtml(s.sector || '—')}</span>
          <span class="sector-bar"><i style="width:${widthPct.toFixed(2)}%"></i></span>
          <span class="sector-pct"><b>${DataLoader.fmtNum(s.holding_pct, 1)}%</b></span>
        </div>`;
    }).join('');

    const holdingsRows = topHoldings.map(h => `
      <tr>
        <td class="num">${h.rank}</td>
        <td><b>${escapeHtml(h.company || '—')}</b></td>
        <td>${escapeHtml(h.sector || '—')}</td>
        <td>${escapeHtml(h.mcap_type || '—')}</td>
        <td class="num"><b>${DataLoader.fmtNum(h.holding_pct, 2)}%</b></td>
      </tr>`).join('');

    wrap.innerHTML = `
      <div class="block-sub-h" style="margin-bottom:8px">Sector Allocation</div>
      <div class="sector-list">${sectorBars}</div>
      <div class="block-sub-h" style="margin:24px 0 8px">Top ${topHoldings.length} Holdings</div>
      <div class="holdings-table-wrap">
        <table class="holdings-tbl">
          <thead><tr><th>#</th><th>Company</th><th>Sector</th><th>M-Cap</th><th class="num">Weight</th></tr></thead>
          <tbody>${holdingsRows}</tbody>
        </table>
      </div>
      <div class="holdings-callout">
        Top 10 holdings = <b>${DataLoader.fmtNum(top10Concentration, 1)}%</b> of portfolio
        ${entry.cash_and_equiv_pct != null && entry.cash_and_equiv_pct > 0
          ? ` · Cash &amp; equiv (TREPS / Repo / G-Sec): <b>${DataLoader.fmtNum(entry.cash_and_equiv_pct, 1)}%</b>` : ''}
      </div>
      <div class="holdings-asof">Holdings as on ${escapeHtml(dateStr)}</div>`;
  }

  /* ============================================================
   * MANAGER PROFILE — Fix-List 5 §D retired the auto-scrape JSON in
   * favour of a CSV the Products Team manually enriches. The page
   * carries the data we DO have on every fund (manager_name, AMC,
   * tenure) inline — no async load needed. The bio paragraph shows a
   * placeholder caption directing the analyst to the human-curated CSV.
   * ============================================================ */

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
