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
    /* v4.1 Item L — Competition Analysis between Portfolio (04) and Cost (06) */
    renderCompetitionAnalysis(fund, cycle);
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
    // Analytics JSON for the Portfolio section (Fix-List 5 §C9 + Fix-List 6 §3)
    loadAnalyticsForFund(fund.scheme_code).then(entry => {
      renderAnalyticsHoldings(entry);
      // Fix-List 8 Feature 3 — once we know our top-20 holdings, compute
      // top-5 most-similar funds across the analytics file and render the
      // "Similar Funds by Holdings" widget at the bottom of Portfolio.
      renderSimilarFunds(fund, entry);
      /* v4.1 Item L — overlap matrix in the Competition section needs the
         current fund's holdings, which only land after this callback. */
      renderCompetitionOverlap(fund, cycle, entry);
    }).catch((e) => {
      console.warn('[fund-detail] analytics JSON unavailable', e);
      showSectorDonutEmpty();
      renderSimilarFunds(fund, null);
      renderCompetitionOverlap(fund, cycle, null);
      // Compact holdings table mount stays at "Holdings data pending."
    });
    // Fix-List 8 Feature 1 — manager-history JSON for the timeline + main
    // manager resolution.  Independent failure mode: if this 404s, the
    // manager section degrades to screener-only data (as before).
    loadManagerHistory(fund.scheme_code).then(entry => {
      renderManagerTimeline(fund, entry);
    }).catch((e) => {
      console.warn('[fund-detail] manager-history JSON unavailable', e);
      // Timeline div stays hidden (default state); manager card already
      // rendered from screener data by renderManager() above.
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

    /* v4.1 Item M — header rank is category-only, not universe rank.
       Compute the current fund's rank within funds sharing the same SEBI
       sub-category (cycle.funds is the universe; filter by category, sort
       by centricity_score desc, find this fund's position). */
    const peerSubCat = (_cycle.funds || []).filter(f => f.category === fund.category);
    let rankLine = '';
    if (fund.centricity_score != null && peerSubCat.length) {
      const sorted = peerSubCat.slice().sort((a, b) =>
        (b.centricity_score || 0) - (a.centricity_score || 0)
      );
      const idx = sorted.findIndex(f => f.scheme_code === fund.scheme_code);
      if (idx >= 0) {
        const x = idx + 1;
        const n = peerSubCat.length;
        rankLine = `Ranked <b>#${x}</b> of ${n} in ${escapeHtml(fund.category)} category`;
      }
    }
    document.getElementById('scoreDelta').innerHTML =
      `Cycle change · — (no prior cycle in archive). ${rankLine}`;

    // Mini grid (4 cells per Fund Detail Fix-List spec)
    const grid = document.getElementById('scoreMiniGrid');
    const rolling = fund.rolling_3y_avg_pct;
    const stocks = fund.no_of_stocks;
    const mgrTen = fund.manager_tenure_yrs;
    const aum = fund.aum_cr;
    // Fix-List 9 §3 — score card's Manager Tenure cell is given an id so
    // renderManagerTimeline() can swap in the resolved-main-manager tenure
    // once manager-history loads. Falls back to screener tenure if we
    // never get there (independent failure mode).
    grid.innerHTML = [
      ['Rolling Returns', rolling != null ? `${DataLoader.fmtNum(rolling, 2)}%` : '—', null],
      ['No. of Stocks',   stocks != null ? stocks : '—', null],
      ['Manager Tenure',  mgrTen != null ? `${DataLoader.fmtNum(mgrTen, 1)} yrs` : '—', 'statManagerTenure'],
      ['Fund AUM',        aum != null ? `₹ ${DataLoader.fmtINR(aum)} Cr` : '—', null],
    ].map(([k, v, id]) =>
      `<div class="cell"><span class="k">${escapeHtml(k)}</span>` +
      `<span class="v"${id ? ` id="${id}"` : ''}>${escapeHtml(String(v))}</span></div>`
    ).join('');
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

    // Benchmark row — Fix-List 6 §1D: prefer benchmark_monitor_returns
    // (Monitor's index row at the bottom of each category sheet — full
    // 6-period set). Fall back to converter's benchmark_returns for 1Y/3Y/5Y
    // when Monitor benchmark match is missing (and to nav-series-derived
    // YTD/1M/10Y after _navSeries resolves).
    const bmm = fund.benchmark_monitor_returns || {};
    const br = fund.benchmark_returns || {};
    const benchVals = [
      bmm.ytd_pct        != null ? bmm.ytd_pct        : null,
      bmm.return_1m_pct  != null ? bmm.return_1m_pct  : null,
      bmm.return_1y_pct  != null ? bmm.return_1y_pct  : br.return_1y_pct,
      bmm.return_3y_pct  != null ? bmm.return_3y_pct  : br.return_3y_pct,
      bmm.return_5y_pct  != null ? bmm.return_5y_pct  : br.return_5y_pct,
      bmm.return_10y_pct != null ? bmm.return_10y_pct : null,
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

    // Excess Return row — Fix-List 6 §2A: Fund − Benchmark per period.
    // Em-dash when either is null.
    const excessVals = fundVals.map((fv, i) => {
      const bv = benchVals[i];
      if (fv == null || bv == null) return null;
      return fv - bv;
    });

    _perfState = { fund, cycle, benchmarkName, peerCount, fundVals, benchVals, catVals, excessVals };
    _renderReturnsTable();
    _renderReturnsBarChartWhenReady();
  }

  /**
   * Invoked after `_navSeries` resolves. Now that the benchmark row uses
   * Monitor index rows (Fix-List 6 §1D), nav-series is the LAST-RESORT
   * fallback for YTD/1M/10Y — only fills cells that are still null.
   */
  function updateBenchCellsAfterNavLoad() {
    if (!_perfState || !_navSeries || !Array.isArray(_navSeries.bench)) return;
    const cycleDate = _cycle.cycle_meta.cycle_date;
    const bench = _navSeries.bench;
    if (_perfState.benchVals[0] == null) _perfState.benchVals[0] = _benchYtdPctFromMonthly(bench, cycleDate);
    if (_perfState.benchVals[1] == null) _perfState.benchVals[1] = _benchOneMonthPctFromMonthly(bench, cycleDate);
    if (_perfState.benchVals[5] == null) _perfState.benchVals[5] = _benchTenYearCagrFromMonthly(bench, cycleDate);
    // Recompute excess after the bench fill
    _perfState.excessVals = _perfState.fundVals.map((fv, i) => {
      const bv = _perfState.benchVals[i];
      if (fv == null || bv == null) return null;
      return fv - bv;
    });
    _renderReturnsTable();
    _renderReturnsBarChartWhenReady();
  }

  function _renderReturnsTable() {
    if (!_perfState) return;
    const { fund, benchmarkName, fundVals, benchVals, catVals, excessVals } = _perfState;
    const cell = (v) => (v == null || isNaN(v))
      ? '<td>—</td>'
      : `<td class="${v < 0 ? 'neg' : ''}">${fmtPct(v, 2)}</td>`;
    // Excess row uses explicit colour: positive Deep Green (#0F5132),
    // negative Dark Red (#931621), zero default. Sign always explicit
    // via fmtPctSigned. Fix-List 7 §1A.
    const excessCell = (v) => {
      if (v == null || isNaN(v)) return '<td>—</td>';
      const cls = v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
      return `<td class="${cls}">${fmtPctSigned(v, 2)}</td>`;
    };

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
      </tr>
      <tr class="row-excess">
        <td><b>Excess Return</b></td>
        ${excessVals.map(excessCell).join('')}
      </tr>`;

    // Fix-List 7 §1B — footnote below the returns table
    const foot = document.getElementById('perfTableFoot');
    if (foot) {
      const dateStr = DataLoader.fmtDate(_cycle.cycle_meta.cycle_date);
      foot.innerHTML =
        `Excess Return = Fund return − Benchmark return (point-to-point, as on ${escapeHtml(dateStr)}).`;
    }
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

    // Fix-List 7 §2 — Chart.js plugin that draws value labels above each
    // bar (positive) or below it (negative). No external plugin dep —
    // afterDatasetsDraw fires after Chart.js renders every dataset.
    const barLabelsPlugin = {
      id: 'barLabels',
      afterDatasetsDraw(chart) {
        const c = chart.ctx;
        chart.data.datasets.forEach((ds, i) => {
          const meta = chart.getDatasetMeta(i);
          meta.data.forEach((bar, j) => {
            const val = ds.data[j];
            if (val == null) return;
            c.save();
            c.font = "bold 9px 'Cambria', Georgia, serif";
            c.fillStyle = '#000';
            c.textAlign = 'center';
            c.textBaseline = val >= 0 ? 'bottom' : 'top';
            const yOffset = val >= 0 ? -2 : 2;
            c.fillText(fmtPct(val, 2), bar.x, bar.y + yOffset);
            c.restore();
          });
        });
      },
    };

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
      plugins: [barLabelsPlugin],
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
              label: (ctx) => `${ctx.dataset.label}: ${ctx.raw == null ? '—' : fmtPct(ctx.raw, 2)}`,
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

  /**
   * Page-wide percentage formatter — Fix-List 6 §2B switched ALL return
   * displays from 1dp to 2dp. Negatives use the Unicode minus (U+2212),
   * which the .neg CSS class colours red.
   *   fmtPct(12.345)        -> "12.35%"
   *   fmtPct(-3.456)        -> "−3.46%"
   *   fmtPct(null)          -> "—"
   *   fmtPct(7.5, 1)        -> "7.5%"   (override decimals if needed)
   */
  function fmtPct(v, dp) {
    if (v == null || isNaN(v)) return '—';
    if (dp == null) dp = 2;
    const sign = v < 0 ? '−' : '';
    return sign + Math.abs(v).toFixed(dp) + '%';
  }
  /**
   * Always-signed variant for Excess Return cells where +/− is the point.
   *   fmtPctSigned(2.84)   -> "+2.84%"
   *   fmtPctSigned(-1.07)  -> "−1.07%"
   *   fmtPctSigned(0)      -> "0.00%"
   */
  function fmtPctSigned(v, dp) {
    if (v == null || isNaN(v)) return '—';
    if (dp == null) dp = 2;
    if (v === 0) return (0).toFixed(dp) + '%';
    const sign = v < 0 ? '−' : '+';
    return sign + Math.abs(v).toFixed(dp) + '%';
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
  // Fix-List 6 §2B: rolling-return + capture cards display 2dp.
  function pctFmt(v)    { return DataLoader.fmtPct(v, 2); }                 // signed
  function pctPosFmt(v) { return `${DataLoader.fmtNum(v, 2)}%`; }            // unsigned

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
    // Fix-List 7 §7A — Portfolio Turnover joins the Risk grid as a behavioural
    // proxy for manager activity. Sourced from the same Excel column as before.
    const turnover    = fund.turnover_pct;
    const catTurnover = catAvg(f => f.turnover_pct);

    const cards = [
      {
        lbl: 'Sharpe', v: sharpe, fmt: v => DataLoader.fmtNum(v, 2),
        cmp: `3Y trailing · Rf ${RF_RATE_DISPLAY}<br>Cat avg · <b>${nullOrNum(catSharpe, 2)}</b>`,
      },
      {
        // Fix-List 6 §2B — capture ratios in 2dp
        lbl: 'Down Capture', v: downCap, fmt: v => `${DataLoader.fmtNum(v, 2)}%`,
        cmp: `Benchmark · <b>100.00%</b><br>Cat avg · <b>${nullOrPct(catDownCap, 2)}</b>`,
      },
      {
        lbl: 'Up Capture', v: upCap, fmt: v => `${DataLoader.fmtNum(v, 2)}%`,
        cmp: `Benchmark · <b>100.00%</b><br>Cat avg · <b>${nullOrPct(catUpCap, 2)}</b>`,
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
      {
        lbl: 'Portfolio Turnover', v: turnover, fmt: v => `${DataLoader.fmtNum(v, 1)}%`,
        cmp: `Lower = longer holding period<br>Cat avg · <b>${nullOrPct(catTurnover, 1)}</b>`,
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

    // Fix-List 10 §2 — the old "Lead Manager" sub-table (mgrLeadTbody)
    // was reading screener `manager_tenure_yrs` (= longest-ever, often
    // wrong for current managers). Mount removed from HTML; the new
    // .mgr-history-table renders from manager-history JSON inside
    // renderManagerTimeline() instead.

    // Stats grid — Fix-List 5 §C12 dropped 'Active Share' (no data source).
    // Fix-List 7 §6 dropped 'AMC Score' from this grid (kept on the fund
    // record for ranking, but not surfaced here — the score-card already
    // carries the fund-level read).
    const cells = [
      ['Tenure',         fund.manager_tenure_yrs != null ? `${DataLoader.fmtNum(fund.manager_tenure_yrs, 1)} yrs` : '—'],
      ['Fund AUM',       fund.aum_cr != null ? `₹ ${DataLoader.fmtINR(fund.aum_cr)} Cr` : '—'],
      ['No. of Stocks',  fund.no_of_stocks != null ? fund.no_of_stocks : '—'],
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

  /* ============================================================
   * Fix-List 8 Feature 1 — Manager history (Morningstar)
   *
   * Lazy-loaded once per page from data/manager-history-YYYY-MM-DD.json.
   * Cached at module level so any future per-fund render reads the same
   * document.  The JSON is keyed by AMFI scheme code (string).
   * ============================================================ */
  let _managerHistoryCache = null;
  let _managerHistoryFile = null;
  // Fix-List 9 §5 — inverted index { managerName: [scheme_codes] } built
  // once when manager-history-cache lands. Powers the "Also Managing"
  // row + Manager Profiles page cross-references.
  let _managerFundsIndex = null;

  function _resolveManagerHistoryUrl() {
    // Match the screener cycle date for now — Products will refresh both
    // pipelines on the same cadence in v1.x.
    const cycleDate = _cycle && _cycle.cycle_meta ? _cycle.cycle_meta.cycle_date : null;
    if (!cycleDate) return null;
    // Manager history is monthly month-end aligned (Morningstar cadence).
    // Dashboard ships with manager-history-YYYY-MM-DD.json — file picks
    // the most recent month-end ≤ cycle_date by glob; for v1 we hard-pin
    // the filename until a manifest exists.
    return 'data/manager-history-2026-04-30.json';
  }

  async function loadManagerHistory(schemeCode) {
    if (!_managerHistoryCache) {
      const url = _resolveManagerHistoryUrl();
      if (!url) throw new Error('manager-history url unresolved');
      _managerHistoryFile = url;
      const res = await fetch(url, { cache: 'default' });
      if (!res.ok) throw new Error('manager-history HTTP ' + res.status);
      _managerHistoryCache = await res.json();
      _buildManagerFundsIndex();
    }
    const entry = _managerHistoryCache.funds && _managerHistoryCache.funds[String(schemeCode)];
    if (!entry) throw new Error('scheme not in manager-history');
    return entry;
  }

  /**
   * Fix-List 9 §5 — build an inverted index { managerName: [scheme_codes] }
   * keyed by exact manager name string. Includes only `is_current: true`
   * records so the index reflects "who actively manages what right now."
   * Built once per page load when the manager-history cache resolves.
   */
  function _buildManagerFundsIndex() {
    if (_managerFundsIndex || !_managerHistoryCache || !_managerHistoryCache.funds) return;
    const idx = Object.create(null);
    for (const code in _managerHistoryCache.funds) {
      const entry = _managerHistoryCache.funds[code];
      if (!entry || !entry.managers) continue;
      for (const m of entry.managers) {
        if (!m.is_current) continue;
        if (!idx[m.name]) idx[m.name] = [];
        idx[m.name].push(code);
      }
    }
    _managerFundsIndex = idx;
  }

  /**
   * Pick the "main" manager when multiple records carry is_current=true.
   *
   * Resolution order:
   *   1. If only one current → that's it.
   *   2. If multiple current → fuzzy-match against the screener's
   *      manager_name (case-insensitive substring either way) so we
   *      surface whoever the upstream Whitelisting Excel chose.
   *   3. Fallback when no match → longest tenure among current managers.
   *   4. No current at all → last entry by start date (covers the rare
   *      case where Morningstar's history ends before today).
   */
  function resolveMainManager(managers, screenerManagerName) {
    if (!managers || managers.length === 0) return null;
    const current = managers.filter(m => m.is_current);
    if (current.length === 0) return managers[managers.length - 1];
    if (current.length === 1) return current[0];
    const screener = (screenerManagerName || '').toLowerCase();
    if (screener) {
      const match = current.find(m => {
        const nameLower = m.name.toLowerCase();
        if (nameLower.includes(screener)) return true;
        // Try last-name match too (Whitelisting often shortens to last name)
        const screenerSurname = screener.split(/\s+/).pop();
        return screenerSurname && nameLower.includes(screenerSurname);
      });
      if (match) return match;
    }
    // Fallback: longest tenure
    return current.reduce((a, b) => (a.tenure_years > b.tenure_years ? a : b));
  }

  function _formatTenureYM(years) {
    if (years == null || isNaN(years)) return '—';
    const totalMonths = Math.max(0, Math.round(years * 12));
    const yrs = Math.floor(totalMonths / 12);
    const mos = totalMonths % 12;
    if (yrs === 0) return `${mos} mo`;
    if (mos === 0) return `${yrs} yr`;
    return `${yrs} yr ${mos} mo`;
  }

  function _formatLongDate(iso) {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (!y || !m || !d) return iso;
    return `${String(d).padStart(2, '0')} ${months[m - 1]} ${y}`;
  }

  /**
   * Render the manager card overrides + co-managers strip + Also Managing
   * row + the redesigned timeline (Fix-List 9 §1, §2, §3, §5).
   *
   * Called only when the manager-history JSON has an entry for this
   * scheme. If it doesn't, every override is skipped and the page
   * remains in its renderManager()-from-screener state (the timeline
   * div stays hidden by default).
   */
  function renderManagerTimeline(fund, entry) {
    // Fix-List 11 §2 — the timeline DOM mount is gone, so the early-
    // return guard now only checks entry. The function still owns the
    // tenure/co-managers/also-managing/history-table renders.
    if (!entry || !entry.managers || entry.managers.length === 0) {
      return;
    }
    const managers = entry.managers;
    const main = resolveMainManager(managers, fund.manager_name);

    // ---- Card overrides (name + title + avatar) ----
    if (main) {
      const nameEl  = document.getElementById('mgrName');
      const titleEl = document.getElementById('mgrTitle');
      const avatar  = document.getElementById('mgrAvatar');
      // Fix-List 9 Feature B — name is an anchor to the manager-profiles
      // page so partners can drill into a manager's full universe.
      if (nameEl) {
        const href = `manager-profiles.html?manager=${encodeURIComponent(main.name)}`;
        nameEl.innerHTML = `<a class="manager-link" href="${href}">${escapeHtml(main.name)}</a>`;
      }
      if (avatar)  avatar.textContent = managerInitials(main.name);
      if (titleEl) {
        const tenureStr = _formatTenureYM(main.tenure_years);
        const startStr  = _formatLongDate(main.start);
        // Fix-List 9 §3 — only ONE tenure number visible in the manager
        // section: the resolved main manager's. The "Tenure" word that
        // used to appear here is dropped; we just say the value.
        titleEl.textContent =
          `${fund.amc || '—'} · Lead Manager · ${tenureStr} · Since ${startStr}`;
      }
    }

    // ---- Fix-List 9 §3 — score-card "Manager Tenure" cell override ----
    // Source of truth: resolved main manager's tenure_years from
    // Morningstar. Falls back to screener's manager_tenure_yrs when
    // manager-history is unavailable (the cell already shows that on
    // first render).
    const scoreCell = document.getElementById('statManagerTenure');
    if (scoreCell && main) {
      // Match the score-card formatting convention: "X.X yrs" for >= 5
      // years (we trust the year count); "X yr Y mo" for shorter runs
      // where months matter.
      const display = main.tenure_years >= 5
        ? `${DataLoader.fmtNum(main.tenure_years, 1)} yrs`
        : _formatTenureYM(main.tenure_years);
      scoreCell.textContent = display;
    }

    // ---- Fix-List 9 §3 — manager-stats Tenure cell override ----
    // Replace the single "Tenure" cell with the resolved main manager's
    // value (formatted same way as the score card).
    if (main) {
      const cells = document.querySelectorAll('#mgrStats .cell');
      cells.forEach(c => {
        const k = c.querySelector('.k');
        if (k && k.textContent === 'Tenure') {
          const v = c.querySelector('.v');
          if (v) {
            v.textContent = main.tenure_years >= 5
              ? `${DataLoader.fmtNum(main.tenure_years, 1)} yrs`
              : _formatTenureYM(main.tenure_years);
          }
        }
      });
    }

    // ---- Fix-List 9 §2 — Co-managers strip (prominent, with tenure) ----
    const coManagers = managers.filter(m => m.is_current && (!main || m.name !== main.name));
    const coEl = document.getElementById('mgrCoManagers');
    if (coEl) {
      if (coManagers.length > 0) {
        coEl.hidden = false;
        const list = coManagers.map(m => {
          const href = `manager-profiles.html?manager=${encodeURIComponent(m.name)}`;
          const tenureStr = _formatTenureYM(m.tenure_years);
          return `<a class="manager-link" href="${href}">${escapeHtml(m.name)}</a> · ${escapeHtml(tenureStr)}`;
        }).join('<br>');
        coEl.innerHTML =
          `<span class="co-label">Co-managed with</span>` +
          `<span class="co-body">${list}</span>`;
      } else {
        coEl.hidden = true;
        coEl.innerHTML = '';
      }
    }

    // ---- Fix-List 9 §5 — "Also Managing" row ----
    _renderAlsoManaging(fund, main);

    // ---- Fix-List 10 §3 + Fix-List 11 §1 — All-managers history table.
    // Newest first. Lead badge on the resolved main; Co badge on every
    // other current; bare row for past. Tenure column reads
    // _formatTenureYM (matches every other tenure surface on the page).
    // Fix-List 11 §1 — the table is wrapped in <details>; we also write
    // a "(N)" count badge into the summary so partners can see the
    // record count without expanding.
    const tbody = document.querySelector('#mgrHistoryTable tbody');
    if (tbody) {
      const rows = managers.slice().sort(
        (a, b) => new Date(b.start) - new Date(a.start)
      );
      tbody.innerHTML = rows.map(m => {
        const isMain = main && m.name === main.name;
        const isCurr = m.is_current;
        const cls = isMain ? 'row-main' : (isCurr ? 'row-curr' : '');
        const badge = isMain ? ' <span class="badge-lead">Lead</span>'
                    : isCurr ? ' <span class="badge-co">Co</span>'
                    : '';
        const toCell = m.end
          ? _formatLongDate(m.end)
          : '<span class="curr-tag">Present</span>';
        return `<tr class="${cls}">
          <td>${escapeHtml(m.name)}${badge}</td>
          <td>${escapeHtml(_formatLongDate(m.start))}</td>
          <td>${toCell}</td>
          <td>${escapeHtml(_formatTenureYM(m.tenure_years))}</td>
        </tr>`;
      }).join('');
      const countEl = document.getElementById('mgrHistoryCount');
      if (countEl) countEl.textContent = `(${rows.length})`;
    }

    // ---- Fix-List 11 §2 — manager timeline removed. The collapsible
    // Manager History table above now carries every record the
    // single-line annotated timeline (and earlier two-row bar layout)
    // surfaced. Removed: _drawManagerTimelineV9 call + wrap.hidden flip.
  }

  /**
   * Fix-List 9 §5 — render the "Also Managing" row in the manager block.
   * Reads `_managerFundsIndex` (built on first manager-history load) for
   * fellow funds the resolved main manager runs in our universe.
   *   • cap at 5 surfaced fund links; surplus collapses to "+ N more"
   *   • em-dash if the manager runs nothing else
   *   • row hidden entirely if `_managerFundsIndex` isn't built yet
   *     (manager-history unavailable)
   */
  function _renderAlsoManaging(fund, main) {
    const row = document.getElementById('mgrAlsoManaging');
    if (!row) return;
    if (!_managerFundsIndex || !main) {
      row.hidden = true;
      row.innerHTML = '';
      return;
    }
    const codes = (_managerFundsIndex[main.name] || []).filter(c => String(c) !== String(fund.scheme_code));
    if (codes.length === 0) {
      row.hidden = false;
      row.innerHTML =
        `<span class="co-label">Also managing</span>` +
        `<span class="co-body">—</span>`;
      return;
    }
    const screenerByCode = new Map((_cycle.funds || []).map(f => [String(f.scheme_code), f]));
    const SHOW = 5;
    const visible = codes.slice(0, SHOW);
    const overflow = Math.max(0, codes.length - SHOW);
    // Fix-List 11 §3 — funds stacked one per line (<br> separator)
    // instead of comma-joined; same pattern as the co-managers strip.
    const linksHtml = visible.map(c => {
      const sf = screenerByCode.get(String(c));
      const name = sf ? sf.fund_name : `Scheme ${c}`;
      const href = `fund-detail.html?scheme=${encodeURIComponent(c)}`;
      return `<a class="manager-link" href="${href}">${escapeHtml(name)}</a>`;
    }).join('<br>');
    const overflowHtml = overflow > 0
      ? `<br><span class="also-overflow">+ ${overflow} more</span>`
      : '';
    row.hidden = false;
    row.innerHTML =
      `<span class="co-label">Also managing</span>` +
      `<span class="co-body">${linksHtml}${overflowHtml}</span>`;
  }

  // Fix-List 11 §2 — _drawManagerTimelineV9 removed entirely. The
  // single-line annotated timeline (Fix-List 10 §4) and its earlier
  // dual-row 10-year-window bar layout (Fix-List 9 §1) are both gone;
  // every record they surfaced is now in the collapsible Manager
  // History table populated by renderManagerTimeline().

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
   * Fix-List 8 §3 rebuild: m-cap donut + (hybrid donut) on the left
   * with a sector ranked-bar list (was a donut + 2-column legend in
   * Fix-List 7); compact top-holdings table on the right.
   * ============================================================ */
  // M-cap mix palette — fixed assignment (Large = black; Mid = gold;
  // Small = light tan; Others = mid grey)
  const MCAP_PALETTE = ['#0E0E0E', '#BD9568', '#DBC8B2', '#BFBFBF'];
  // Hybrid (Equity / Debt / Others) palette
  const HYBRID_PALETTE = ['#6B3F1A', '#0E0E0E', '#BFBFBF'];

  let _mcapDonutInstance = null;
  let _hybridDonutInstance = null;

  function renderPortfolio(fund) {
    const m = fund.mcap_split || {};
    const mcapData = [
      { label: 'Large-cap', value: m.large_pct },
      { label: 'Mid-cap',   value: m.mid_pct   },
      { label: 'Small-cap', value: m.small_pct },
      { label: 'Others',    value: m.others_pct },
    ];
    _renderDonutWhenReady('mcapDonut', mcapData, MCAP_PALETTE, 'mcapLegend', 'mcap');

    // Hybrid card visibility
    const h = fund.hybrid_extension || {};
    const hybridCard = document.getElementById('hybridMixCard');
    if (fund.sub_category_class === 'Hybrid' &&
        (h.equity_pct != null || h.debt_pct != null || h.others_pct_hybrid != null)) {
      hybridCard.hidden = false;
      const hData = [
        { label: 'Equity', value: h.equity_pct },
        { label: 'Debt',   value: h.debt_pct },
        { label: 'Others', value: h.others_pct_hybrid },
      ];
      _renderDonutWhenReady('hybridDonut', hData, HYBRID_PALETTE, 'hybridLegend', 'hybrid');
    } else {
      hybridCard.hidden = true;
    }
    // Sector + holdings filled in renderAnalyticsHoldings() once the
    // analytics file loads — initial state is the empty placeholder.
  }

  function _renderDonutWhenReady(canvasId, dataPoints, palette, legendId, key) {
    ensureChartJs().then(() => _renderDonutChart(canvasId, dataPoints, palette, legendId, key)).catch(() => {/* silent */});
  }

  function _renderDonutChart(canvasId, dataPoints, palette, legendId, key) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const filtered = dataPoints.filter(d => d.value != null && d.value > 0);
    if (filtered.length === 0) {
      // Hide canvas, show empty state if a sibling element exists for this card
      canvas.style.display = 'none';
      return;
    }
    canvas.style.display = '';
    const labels = filtered.map(d => d.label);
    const values = filtered.map(d => Number(d.value));
    const colours = filtered.map((_, i) => palette[i % palette.length]);

    const ctx = canvas.getContext('2d');
    const oldInstance = key === 'mcap'   ? _mcapDonutInstance
                      : key === 'hybrid' ? _hybridDonutInstance
                      : null;
    if (oldInstance) oldInstance.destroy();

    const config = {
      type: 'doughnut',
      data: {
        labels, datasets: [{
          data: values, backgroundColor: colours, borderColor: '#fff',
          borderWidth: 2, hoverOffset: 6,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '62%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#000', titleColor: '#BD9568', bodyColor: '#fff',
            borderColor: '#6B3F1A', borderWidth: 1,
            callbacks: {
              label: (ctx) => `${ctx.label}  ${DataLoader.fmtNum(ctx.raw, 2)}%`,
            },
          },
        },
      },
    };
    const inst = new window.Chart(ctx, config);
    if (key === 'mcap')   _mcapDonutInstance   = inst;
    if (key === 'hybrid') _hybridDonutInstance = inst;

    // Custom legend for m-cap / hybrid (sector chart uses tooltip-only)
    if (legendId) {
      const legendEl = document.getElementById(legendId);
      if (legendEl) {
        legendEl.innerHTML = filtered.map((d, i) => `
          <div class="dlegend-row">
            <span class="dlegend-sw" style="background:${colours[i]}"></span>
            <span class="dlegend-lbl">${escapeHtml(d.label)}</span>
            <b class="dlegend-pct">${DataLoader.fmtNum(d.value, 2)}%</b>
          </div>`).join('');
      }
    }
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

    // Fix-List 7 §7B — Cost section grid:
    //   • Portfolio Turnover MOVED to the Risk grid (§7A).
    //   • Taxation row split into separate LTCG and STCG cards so each
    //     headline rate sits in its own card. Equity-taxed funds: LTCG
    //     12.5% (>1 yr, above ₹1.25L), STCG 20% (≤1 yr). Slab-taxed
    //     funds: both cards show "Slab rate (any holding period)".
    const taxation = getTaxation(fund);
    const isEquityTaxed = taxation.regime === 'Equity (LTCG / STCG)';
    const ltcg = isEquityTaxed
      ? { v: '12.5%', sub: 'On gains above ₹1.25 L (holding &gt; 1 yr).' }
      : { v: 'Slab rate', sub: 'Taxed at slab rate (any holding period).' };
    const stcg = isEquityTaxed
      ? { v: '20%', sub: 'Holding ≤ 1 yr.' }
      : { v: 'Slab rate', sub: 'Taxed at slab rate (any holding period).' };
    const taxFootnote = '<span class="footnote">Surcharge &amp; cess applicable additionally. Consult your tax advisor.</span>';

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
        lbl: 'LTCG (Long-Term Capital Gains)',
        v: ltcg.v,
        sub: ltcg.sub + ' ' + taxFootnote,
      },
      {
        lbl: 'STCG (Short-Term Capital Gains)',
        v: stcg.v,
        sub: stcg.sub + ' ' + taxFootnote,
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
    // Fix-List 6 §4B — Strengths always renders. "Areas to Watch" is
    // OMITTED entirely when concerns is empty (no heading, no list).
    const strengthsBody = insights.strengths.length
      ? `<ul>${insights.strengths.map(s => `<li>${s}</li>`).join('')}</ul>`
      : `<p class="v-empty">No standout strengths above thresholds in this cycle's data.</p>`;

    const strengthsCol = `
      <div class="v-col">
        <h4>Strengths</h4>
        ${strengthsBody}
      </div>`;

    const concernsCol = insights.concerns.length
      ? `<div class="v-col cons">
           <h4>Areas to Watch</h4>
           <ul>${insights.concerns.map(s => `<li>${s}</li>`).join('')}</ul>
         </div>`
      : '';

    // When concerns is empty, the strengths column spans the full grid
    grid.style.gridTemplateColumns = insights.concerns.length ? '1fr 1fr' : '1fr';
    grid.innerHTML = strengthsCol + concernsCol;

    document.getElementById('verdictFoot').textContent =
      'Auto-generated from fund-side metrics. Centricity Investment Committee narrative arrives in Phase 5.';
  }

  function generateInsights(fund, cycle) {
    const strengths = [];
    const concerns = [];
    const peers = (cycle.funds || []).filter(f => f.category === fund.category);

    /* v4.1 Item N — coalesce internal whitespace and trim per bullet so any
       residual double-spaces from variable interpolation render cleanly.
       Keeps the spec's recommended single-line templates and protects
       against future template edits that re-introduce stray spaces. */
    function nrm(s) { return s.replace(/\s+/g, ' ').trim(); }
    function pct1(v) { return DataLoader.fmtNum(v, 2) + '%'; }
    function escape(s) { return escapeHtml(String(s)); }
    const benchmark = fund.benchmark ? escape(fund.benchmark) : 'benchmark';

    // ---- Strengths ----
    if (fund.centricity_score != null && fund.centricity_score >= 0.80) {
      const ofN = (cycle.cycle_meta.total_funds || '—').toLocaleString('en-IN');
      const inCat = fund.centricity_rank_in_category != null ? `#${fund.centricity_rank_in_category} in ${escape(fund.category)}` : null;
      const overall = fund.centricity_rank_overall != null ? `#${fund.centricity_rank_overall} overall (of ${ofN})` : null;
      const rankPart = [inCat, overall].filter(Boolean).join(' / ');
      strengths.push(nrm(`Centricity Score <b>${(fund.centricity_score * 10).toFixed(2)}/10</b>${rankPart ? ' · ' + rankPart : ''}.`));
    }
    const rs = fund.rolling_3y_stats;
    if (rs && rs.pct_beat_benchmark != null && rs.pct_beat_benchmark >= 90) {
      strengths.push(nrm(`Beats benchmark <b>${pct1(rs.pct_beat_benchmark)}</b> of all 3-year rolling windows vs <b>${benchmark}</b>.`));
    }
    if (rs && rs.pct_above_12 != null && rs.pct_above_12 >= 80) {
      strengths.push(nrm(`<b>${pct1(rs.pct_above_12)}</b> of rolling 3Y windows delivered &gt; 12% CAGR.`));
    }
    const maxDd = fund.risk_metrics ? fund.risk_metrics.max_drawdown_3y_pct : null;
    if (maxDd != null && maxDd > -15) {
      // Compute category avg drawdown (3-peer floor)
      const catDdVals = peers.map(p => p.risk_metrics ? p.risk_metrics.max_drawdown_3y_pct : null)
        .filter(v => v != null);
      const catDdAvg = catDdVals.length >= 3
        ? catDdVals.reduce((s, v) => s + v, 0) / catDdVals.length : null;
      if (catDdAvg != null && maxDd > catDdAvg) {
        strengths.push(nrm(`Max 3Y drawdown limited to <b>${pct1(maxDd)}</b> — shallower than category average <b>${pct1(catDdAvg)}</b>.`));
      } else {
        strengths.push(nrm(`Max 3Y drawdown limited to <b>${pct1(maxDd)}</b>.`));
      }
    }
    const a3 = fund.alpha ? fund.alpha.alpha_3y_pct : null;
    if (a3 != null && a3 > 5) {
      strengths.push(nrm(`3Y alpha of <b>+${DataLoader.fmtNum(a3, 1)}%</b> vs benchmark — consistent excess return.`));
    }
    if (fund.fund_tenure_yrs != null && fund.fund_tenure_yrs > 10) {
      strengths.push(nrm(`Fund track record <b>${DataLoader.fmtNum(fund.fund_tenure_yrs, 1)} years</b> across multiple market cycles.`));
    }
    if (fund.manager_name && fund.manager_tenure_yrs != null && fund.manager_tenure_yrs > 5) {
      strengths.push(nrm(`Manager <b>${escape(fund.manager_name)}</b> has <b>${DataLoader.fmtNum(fund.manager_tenure_yrs, 1)} years</b> at the helm — above-average continuity.`));
    }
    if (fund.consistency_pct != null && fund.consistency_pct >= 95) {
      strengths.push(nrm(`Consistency score of <b>${pct1(fund.consistency_pct)}</b> — rare in this category.`));
    }

    // ---- Concerns ----
    const m = fund.monitor_returns || {};
    const br = fund.benchmark_returns || {};
    if (m.return_1y_pct != null && br.return_1y_pct != null && m.return_1y_pct < br.return_1y_pct) {
      concerns.push(nrm(`1Y return <b>${pct1(m.return_1y_pct)}</b> trails benchmark <b>${pct1(br.return_1y_pct)}</b> — recent underperformance worth monitoring.`));
    }
    if (m.ytd_pct != null && m.ytd_pct < -5) {
      concerns.push(nrm(`YTD return of <b>${pct1(m.ytd_pct)}</b> — short-term drawdown in progress.`));
    }
    const sd = fund.risk_metrics ? fund.risk_metrics.std_dev_3y_pct : null;
    if (sd != null && sd > 15) {
      concerns.push(nrm(`Volatility (Std Dev <b>${pct1(sd)}</b>) above typical for this category — expect swings.`));
    }
    if (fund.manager_name && fund.manager_tenure_yrs != null && fund.manager_tenure_yrs < 2) {
      concerns.push(nrm(`Manager <b>${escape(fund.manager_name)}</b> has &lt; 2 years running this fund — track record limited.`));
    }
    if (fund.aum_cr != null && fund.aum_cr > 30000) {
      concerns.push(nrm(`AUM of <b>₹${DataLoader.fmtINR(fund.aum_cr)} Cr</b> — large corpus may constrain agility in mid/small-cap exposure.`));
    }
    if (fund.no_of_stocks != null && fund.no_of_stocks < 20) {
      concerns.push(nrm(`Concentrated portfolio of <b>${fund.no_of_stocks}</b> stocks — higher single-stock risk.`));
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
   * NAV CHART + DRAWDOWN CHART (Performance + Risk)
   * Fix-List 7 — full reimplementation per spec.
   *
   * Module-level _navSeriesCache holds the FULL nav-series JSON document
   * after the first fetch, so `loadNavSeries` for the current fund AND
   * peer lookups for the Category Avg line all read from the same cache.
   * ============================================================ */
  let _navSeriesCache = null;          // full document {cycle_date, series}

  /**
   * Resolve the full nav-series document (fetched once per page load),
   * then return the entry for the requested scheme code or null.
   */
  async function loadNavSeries(schemeCode) {
    if (!_navSeriesCache) {
      const cycleDate = _cycle.cycle_meta.cycle_date;
      const url = `data/nav-series-${cycleDate}.json`;
      const res = await fetch(url, { cache: 'default' });
      if (!res.ok) throw new Error('nav-series HTTP ' + res.status);
      _navSeriesCache = await res.json();
    }
    const entry = _navSeriesCache.series && _navSeriesCache.series[String(schemeCode)];
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

  function showNavEmpty() {
    const el = document.getElementById('navChartEmpty');
    if (el) el.hidden = false;
    const canvas = document.getElementById('navChart');
    if (canvas) canvas.style.display = 'none';
    const cap = document.getElementById('navChartCaption');
    if (cap) cap.textContent = '—';
  }
  function showDdEmpty() {
    const el = document.getElementById('ddChartEmpty');
    if (el) el.hidden = false;
    const canvas = document.getElementById('ddChart');
    if (canvas) canvas.style.display = 'none';
  }

  /**
   * Build the "Growth of ₹ 1,00,000" chart. Pre-computes which window
   * toggles are available (3Y requires fund_tenure ≥ 3, 5Y requires ≥ 5),
   * picks the longest available default, wires toggle clicks, and draws.
   */
  function renderNavChart() {
    if (!_navSeries || !_navSeries.fund || _navSeries.fund.length === 0) {
      showNavEmpty();
      return;
    }
    ensureChartJs().then(() => {
      _setupNavToggles();
      _drawNavChart();
    }).catch(showNavEmpty);
  }

  function _setupNavToggles() {
    const tenure = _fund && _fund.fund_tenure_yrs != null ? _fund.fund_tenure_yrs : 0;
    const buttons = Array.from(document.querySelectorAll('#navToggles button'));
    let firstAvailable = null;
    let preferred = null;
    buttons.forEach(btn => {
      const w = btn.getAttribute('data-window');
      const minYrs = w === '5Y' ? 5 : (w === '3Y' ? 3 : 1);
      const enabled = w === '1Y' || tenure >= minYrs;
      btn.classList.toggle('disabled', !enabled);
      btn.style.pointerEvents = enabled ? 'auto' : 'none';
      btn.style.opacity = enabled ? '' : '0.4';
      if (enabled && firstAvailable == null) firstAvailable = w;
      if (enabled && (w === '5Y' || (w === '3Y' && preferred !== '5Y'))) preferred = w;
    });
    // Default selection: 5Y if available, else 3Y if available, else 1Y
    _navWindow = preferred || firstAvailable || '1Y';
    buttons.forEach(b => b.classList.toggle('active', b.getAttribute('data-window') === _navWindow));
    // Click handlers (re-wire on every render to handle re-init cases)
    buttons.forEach(btn => {
      btn.onclick = () => {
        if (btn.classList.contains('disabled')) return;
        buttons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        _navWindow = btn.getAttribute('data-window');
        _drawNavChart();
      };
    });
  }

  function _drawNavChart() {
    const fund = _navSeries.fund || [];
    const bench = _navSeries.bench || [];
    if (fund.length < 2) { showNavEmpty(); return; }

    // Window slicing
    const cycleDate = _cycle.cycle_meta.cycle_date;
    const cycleYM = cycleDate.slice(0, 7);
    const cycleYear = parseInt(cycleDate.slice(0, 4), 10);
    const yearsBack = _navWindow === '5Y' ? 5 : (_navWindow === '3Y' ? 3 : 1);
    const anchorYM = `${cycleYear - yearsBack}-${cycleDate.slice(5, 7)}`;
    const slicedFund  = fund.filter(p  => p.d >= anchorYM && p.d <= cycleYM);
    const slicedBench = bench.filter(p => p.d >= anchorYM && p.d <= cycleYM);
    if (slicedFund.length < 2) { showNavEmpty(); return; }

    // Normalise to ₹100,000 at window start
    const baseFund = slicedFund[0].v;
    const fundData = slicedFund.map(p => 100000 * (p.v / baseFund));
    const labels = slicedFund.map(p => p.d);

    let benchData = labels.map(_ => null);
    if (slicedBench.length >= 2) {
      const baseBench = slicedBench[0].v;
      const benchByMonth = new Map(slicedBench.map(p => [p.d, 100000 * (p.v / baseBench)]));
      benchData = labels.map(d => benchByMonth.has(d) ? benchByMonth.get(d) : null);
    }

    // Category Avg — peers' nav-series, normalised to anchor month, mean per date
    const catData = _computeCategoryAvgSeries(labels, anchorYM);

    const cap = document.getElementById('navChartCaption');
    if (cap) {
      const finalFund  = fundData[fundData.length - 1];
      const finalBench = benchData.filter(v => v != null).pop();
      const anchorLabel = formatYMLong(slicedFund[0].d);
      cap.innerHTML =
        `₹ 1,00,000 invested on <b>${escapeHtml(anchorLabel)}</b> → ` +
        `Fund: <b>₹ ${DataLoader.fmtINR(finalFund)}</b>` +
        (finalBench != null
          ? ` · Benchmark: <b>₹ ${DataLoader.fmtINR(finalBench)}</b>`
          : '');
    }

    const ctx = document.getElementById('navChart').getContext('2d');
    if (_navChartInstance) { _navChartInstance.destroy(); _navChartInstance = null; }

    // Fix-List 8 §2 — three solid colored lines, fund dominant.
    // No borderDash on any series; widths 3 / 1.5 / 1.5; matching legend
    // swatches in fund-detail.html.
    const datasets = [
      {
        label: 'Fund', data: fundData,
        borderColor: '#BD9568', backgroundColor: 'rgba(189,149,104,.10)',
        fill: false, tension: .25, pointRadius: 0, borderWidth: 3,
        spanGaps: true,
      },
      {
        label: 'Benchmark', data: benchData,
        borderColor: '#5B8DB8', backgroundColor: 'transparent',
        fill: false, tension: .25, pointRadius: 0, borderWidth: 1.5,
        spanGaps: true,
      },
    ];
    if (catData) {
      datasets.push({
        // Fix-List 9 §4 — Cat Avg switched from #7D7D7D grey to #2E7D32
        // deep green so the three nav-chart lines (gold / blue / green)
        // are clearly distinguishable at small sizes.
        label: 'Category Avg', data: catData,
        borderColor: '#2E7D32', backgroundColor: 'transparent',
        fill: false, tension: .25, pointRadius: 0, borderWidth: 1.5,
        spanGaps: true,
      });
    }

    _navChartInstance = new window.Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: _navChartOptions(_navWindow),
    });
    const navEmpty = document.getElementById('navChartEmpty');
    if (navEmpty) navEmpty.hidden = true;
    document.getElementById('navChart').style.display = '';
  }

  /**
   * Returns an array (length = labels.length) of category-mean normalised
   * NAV values, or null if fewer than 3 peers had coverage at the anchor.
   * Implementation: walk every Ranked-or-otherwise peer in the same
   * SEBI category, look up their entry in _navSeriesCache, find the
   * normalisation anchor (first point with d >= anchorYM), forward-fill
   * missing months, then average across peers per date.
   */
  function _computeCategoryAvgSeries(labels, anchorYM) {
    if (!_navSeriesCache || !_navSeriesCache.series || !_fund) return null;
    const peers = (_cycle.funds || []).filter(f =>
      f.category === _fund.category && f.scheme_code !== _fund.scheme_code);
    const peerNormalised = [];
    for (const peer of peers) {
      const entry = _navSeriesCache.series[String(peer.scheme_code)];
      if (!entry || !entry.fund || entry.fund.length < 2) continue;
      const series = entry.fund;
      // Find the first point at or after anchorYM
      const anchor = series.find(p => p.d >= anchorYM);
      if (!anchor || anchor.d > anchorYM) {
        // Need exact-or-earlier coverage; allow up to 1 month tolerance
        if (!anchor || _monthsDiff(anchor.d, anchorYM) > 1) continue;
      }
      const baseV = anchor.v;
      if (!(baseV > 0)) continue;
      const byMonth = new Map();
      for (const p of series) {
        if (p.d < anchorYM) continue;
        byMonth.set(p.d, 100000 * (p.v / baseV));
      }
      // Forward-fill missing months along the fund's label backbone
      const filled = [];
      let last = null;
      for (const d of labels) {
        if (byMonth.has(d)) last = byMonth.get(d);
        filled.push(last);                         // null until first peer point
      }
      peerNormalised.push(filled);
      if (peerNormalised.length >= 50) break;       // cap per spec
    }
    if (peerNormalised.length < 3) return null;
    const out = labels.map((_, i) => {
      const vals = peerNormalised.map(arr => arr[i]).filter(v => v != null);
      if (vals.length === 0) return null;
      return vals.reduce((s, v) => s + v, 0) / vals.length;
    });
    return out;
  }

  function _monthsDiff(ymA, ymB) {
    const [aY, aM] = ymA.split('-').map(Number);
    const [bY, bM] = ymB.split('-').map(Number);
    return Math.abs((aY - bY) * 12 + (aM - bM));
  }

  /**
   * NAV chart options — Fix-List 8 §1: window-aware tick frequency.
   *   1Y → one label per month, format "Jan '26"
   *   3Y → one label per quarter (Jan / Apr / Jul / Oct)
   *   5Y → same quarterly cadence
   * Indian-comma ₹ y-ticks, three-series tooltip with date as "Mon YYYY".
   */
  function _navChartOptions(navWindow) {
    return {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 220 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#000', titleColor: '#BD9568', bodyColor: '#fff',
          borderColor: '#6B3F1A', borderWidth: 1,
          callbacks: {
            title: (items) => items.length ? formatYMLong(items[0].label) : '',
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw == null ? '—' : '₹ ' + DataLoader.fmtINR(ctx.raw)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            font: { family: "'Cambria', Georgia, serif", size: 10 },
            color: '#666',
            autoSkip: false,
            maxRotation: 0,
            callback: function (val, idx, all) {
              const lbl = this.getLabelForValue(val);
              return fmtAxisDate(lbl, navWindow, idx === all.length - 1);
            },
          },
        },
        y: {
          grid: { color: 'rgba(217, 217, 217, .55)', drawBorder: false },
          ticks: {
            font: { family: "'Cambria', Georgia, serif", size: 10 },
            color: '#666',
            callback: (v) => '₹ ' + DataLoader.fmtINR(v),
          },
        },
      },
    };
  }

  function formatYMLong(ym) {
    if (!ym) return '—';
    const d = parseYM(ym);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }

  /* ============================================================
   * DRAWDOWN CHART
   * ============================================================ */
  function renderDrawdownChart() {
    if (!_navSeries || !_navSeries.fund || _navSeries.fund.length < 2) {
      showDdEmpty(); return;
    }
    ensureChartJs().then(_drawDdChart).catch(showDdEmpty);
  }

  /* v4.1 Item K — drawdown series helper. Running-peak from any monthly
     NAV array. Returns { labels, dd } where dd is % drawdown vs peak. */
  function _seriesToDrawdown(arr) {
    if (!arr || !arr.length) return { labels: [], dd: [] };
    let peak = arr[0].v;
    const out = arr.map(p => {
      if (p.v > peak) peak = p.v;
      const d = peak > 0 ? (p.v / peak - 1) : 0;
      return { d: p.d, dd: d * 100 };
    });
    return { labels: out.map(p => p.d), dd: out.map(p => p.dd) };
  }

  /* v4.1 Item K — category-average drawdown across same-sub-category peers.
     Reads the cached nav-series document, computes per-peer drawdown,
     averages by month-key. Caps at 30 peers for perf. Returns null when
     too few peers have nav-series data. */
  function _computeCategoryAvgDrawdown(currentFund, fundLabels) {
    if (!_navSeriesCache || !_navSeriesCache.series) return null;
    if (!_cycle || !_cycle.funds || !currentFund) return null;
    const peerCodes = _cycle.funds
      .filter(p => p.category === currentFund.category && p.scheme_code !== currentFund.scheme_code)
      .map(p => String(p.scheme_code))
      .slice(0, 30);
    if (peerCodes.length < 3) return null;
    /* Aggregate by month-key — sum + count. Different peers have different
       inception dates so each month-key may have a different sample size. */
    const sum = {};
    const count = {};
    let included = 0;
    peerCodes.forEach(sc => {
      const entry = _navSeriesCache.series[sc];
      if (!entry || !entry.fund || entry.fund.length < 12) return;
      const dd = _seriesToDrawdown(entry.fund).dd;
      const labels = entry.fund.map(p => p.d);
      for (let i = 0; i < labels.length; i++) {
        const k = labels[i];
        if (sum[k] == null) { sum[k] = 0; count[k] = 0; }
        sum[k] += dd[i];
        count[k] += 1;
      }
      included += 1;
    });
    if (included < 3) return null;
    return fundLabels.map(k => count[k] ? (sum[k] / count[k]) : null);
  }

  function _drawDdChart() {
    /* Fix-List 7 — use ALL available history (not window-gated) so the
       running-peak drawdown captures the historical low, not just the
       5Y slice. */
    const fund = _navSeries.fund || [];
    if (fund.length < 12) { showDdEmpty(); return; }

    const fundDd = _seriesToDrawdown(fund);
    const labels = fundDd.labels;

    /* v4.1 Item K — benchmark drawdown overlay (silent skip if missing). */
    const benchArr = (_navSeries && Array.isArray(_navSeries.bench)) ? _navSeries.bench : null;
    let benchDd = null;
    if (benchArr && benchArr.length >= 12) {
      const benchByDate = Object.fromEntries(benchArr.map(p => [p.d, p.v]));
      const filtered = labels.map(k => benchByDate[k] != null ? { d: k, v: benchByDate[k] } : null)
                             .filter(Boolean);
      if (filtered.length >= 12) {
        const ddObj = _seriesToDrawdown(filtered);
        const m = Object.fromEntries(ddObj.labels.map((k, i) => [k, ddObj.dd[i]]));
        benchDd = labels.map(k => (k in m) ? m[k] : null);
      } else {
        console.warn('[fund-detail] benchmark nav-series too sparse for drawdown overlay');
      }
    }

    /* v4.1 Item K — category-average drawdown overlay (computed from peers). */
    const catAvgDd = _computeCategoryAvgDrawdown(_fund, labels);

    /* Bug-fix 2026-05-11 / ISSUE-0026 Bug 3 — drawdown is always negative,
       brand standards reserve #931621 Dark Red exclusively for negative-value
       data. The original gold #BD9568 misapplied the brand colour; switching
       to Dark Red puts the line in its rightful palette. */
    const datasets = [{
      label: 'Fund',
      data: fundDd.dd,
      borderColor: '#931621', backgroundColor: 'rgba(147,22,33,.12)',
      fill: true, tension: .15, pointRadius: 0, borderWidth: 2,
    }];
    if (benchDd) datasets.push({
      label: 'Benchmark',
      data: benchDd,
      borderColor: '#000000', backgroundColor: 'transparent',
      borderDash: [6, 4],
      fill: false, tension: .15, pointRadius: 0, borderWidth: 1.5,
      spanGaps: true,
    });
    if (catAvgDd) datasets.push({
      label: 'Category Avg',
      data: catAvgDd,
      borderColor: '#BFBFBF', backgroundColor: 'transparent',
      fill: false, tension: .15, pointRadius: 0, borderWidth: 1.5,
      spanGaps: true,
    });

    const ctx = document.getElementById('ddChart').getContext('2d');
    if (_ddChartInstance) { _ddChartInstance.destroy(); _ddChartInstance = null; }
    _ddChartInstance = new window.Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: 200 },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true, position: 'bottom', align: 'center',
            labels: {
              boxWidth: 22, boxHeight: 2, usePointStyle: false,
              font: { family: "'Cambria', Georgia, serif", size: 12 },
              color: '#0E0E0E',
            },
          },
          tooltip: {
            backgroundColor: '#000', titleColor: '#BD9568', bodyColor: '#fff',
            borderColor: '#6B3F1A', borderWidth: 1,
            callbacks: {
              label: (ctx) => {
                const v = ctx.raw == null ? '—' : fmtPctSigned(ctx.raw, 2);
                return `${ctx.dataset.label}: ${v}`;
              },
              title: (items) => items.length ? formatYMLong(items[0].label) : '',
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              font: { family: "'Cambria', Georgia, serif", size: 10 },
              color: '#666',
              autoSkip: false, maxRotation: 0,
              callback: function (val, idx, all) {
                const lbl = this.getLabelForValue(val);
                return fmtAxisDate(lbl, '3Y', idx === all.length - 1);
              },
            },
          },
          y: {
            max: 0,
            grid: { color: 'rgba(217, 217, 217, .55)', drawBorder: false },
            ticks: {
              font: { family: "'Cambria', Georgia, serif", size: 10 },
              /* v4.1 Item K — negative-value axis labels in Dark Red. */
              color: (ctx) => (ctx.tick && ctx.tick.value < 0) ? '#931621' : '#666',
              callback: (v) => `${DataLoader.fmtNum(v, 0)}%`,
            },
          },
        },
      },
    });
    const ddEmpty = document.getElementById('ddChartEmpty');
    if (ddEmpty) ddEmpty.hidden = true;
    document.getElementById('ddChart').style.display = '';
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

  /**
   * Fix-List 8 §1 — window-aware axis tick formatter.
   *   1Y → every month, "Jan '26"
   *   3Y / 5Y → only Jan / Apr / Jul / Oct, "Jan '24"
   * Returns '' for months that shouldn't carry a tick. The final-index
   * tick always renders so the right-edge anchor stays labelled.
   */
  function fmtAxisDate(ym, navWindow, isLast) {
    if (!ym) return '';
    const d = parseYM(ym);
    const month = d.getUTCMonth();             // 0-based
    const year2 = String(d.getUTCFullYear()).slice(2);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const label = `${months[month]} '${year2}`;
    if (navWindow === '1Y') {
      // Every month gets a label; final index also forced.
      return label;
    }
    // 3Y / 5Y → quarterly cadence (Jan / Apr / Jul / Oct = month 0/3/6/9)
    if (month % 3 === 0 || isLast) return label;
    return '';
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
  let _analyticsCache = null;          // full doc — Fix-List 8 Feature 3 reads peers from it
  // Fix-List 9 Feature A — full equity-only holdings (up to 200 lines per
  // fund). Lazy-loaded once when the Portfolio section asks for analytics.
  // When present, overrides the analytics top-20 for the Similar Funds
  // calculation. When absent (404), the calculation falls back to top-20.
  let _holdingsFullCache = null;
  let _holdingsFullSource = 'top20';   // 'full' once the full file lands

  async function loadAnalyticsForFund(schemeCode) {
    // Discover the latest analytics file in data/. Right now there's
    // exactly one (analytics-2026-03-31.json); when v1.x ships monthly,
    // pick the latest by filename sort.
    // Fix-List 9 Feature A — load both the analytics top-20 file (sector
    // donut + concentration metrics) and the full-equity-holdings file
    // (Similar Funds widget). Both fetches run in parallel; the full
    // file is best-effort — if it 404s, _holdingsFullCache stays null
    // and the widget falls back to top-20.
    if (!_analyticsCache || _holdingsFullCache === null) {
      const aPromise = _analyticsCache
        ? Promise.resolve(_analyticsCache)
        : fetch('data/analytics-2026-03-31.json', { cache: 'default' })
            .then(r => (r.ok ? r.json() : Promise.reject(new Error('analytics HTTP ' + r.status))));
      const fPromise = (_holdingsFullCache && typeof _holdingsFullCache === 'object')
        ? Promise.resolve(_holdingsFullCache)
        : fetch('data/holdings-full-2026-03-31.json', { cache: 'default' })
            .then(r => (r.ok ? r.json() : Promise.reject(new Error('holdings-full HTTP ' + r.status))))
            .catch(e => {
              console.warn('[fund-detail] holdings-full unavailable; falling back to top-20', e);
              return null;
            });
      const [aDoc, fDoc] = await Promise.all([aPromise, fPromise]);
      _analyticsCache = aDoc;
      _analyticsDate = aDoc.analytics_date || null;
      _holdingsFullCache = fDoc;
      _holdingsFullSource = fDoc ? 'full' : 'top20';
    }
    const entry = _analyticsCache.funds && _analyticsCache.funds[String(schemeCode)];
    if (!entry) throw new Error('scheme not in analytics');
    return entry;
  }

  /** Pull the per-fund holdings list, preferring the full file when it has
   *  resolved; falls back to the analytics top-20 otherwise. Returns
   *  `{holdings, source}` where source ∈ {'full','top20','none'}. */
  function _peerHoldings(code) {
    const codeStr = String(code);
    if (_holdingsFullCache && typeof _holdingsFullCache === 'object'
        && _holdingsFullCache.funds && _holdingsFullCache.funds[codeStr]) {
      return { holdings: _holdingsFullCache.funds[codeStr], source: 'full' };
    }
    const a = _analyticsCache && _analyticsCache.funds && _analyticsCache.funds[codeStr];
    if (a && a.top_20_holdings && a.top_20_holdings.length > 0) {
      return { holdings: a.top_20_holdings, source: 'top20' };
    }
    return { holdings: [], source: 'none' };
  }

  /**
   * Fix-List 6 §3 — sector data drives a donut chart (tooltip-only, no
   * inline labels) and the holdings table replaces the placeholder.
   */
  function renderAnalyticsHoldings(entry) {
    if (!entry) return;
    const sectors = entry.sector_allocation || [];
    const topHoldings = entry.top_20_holdings || [];
    const top10Concentration = entry.top_10_concentration_pct;
    const dateStr = _analyticsDate ? DataLoader.fmtDate(_analyticsDate) : '—';

    // ---- Sector ranked-bar list (Fix-List 8 §3) ----
    // Sectors arrive sorted desc by holding_pct. Take top 10 as positions
    // 1–10; sum the remainder into a single "Others (N sectors)" row that
    // is always rendered last regardless of its own value.
    const sectorTitle = document.getElementById('sectorDonutTitle');
    if (sectorTitle) sectorTitle.textContent = `Sector Allocation · as on ${dateStr}`;
    const sectorEmpty = document.getElementById('sectorDonutEmpty');
    if (sectorEmpty) sectorEmpty.hidden = true;
    renderSectorList(sectors);

    // ---- Compact holdings table (right column) ----
    const mount = document.getElementById('holdingsTableMount');
    const holdingsTitle = document.getElementById('holdingsTitle');
    if (holdingsTitle) holdingsTitle.textContent = `Top ${topHoldings.length} Holdings · as on ${dateStr}`;

    const holdingsRows = topHoldings.map(h => `
      <tr>
        <td class="num rank">${h.rank}</td>
        <td class="company"><b>${escapeHtml(h.company || '—')}</b></td>
        <td class="sector">${escapeHtml(h.sector || '—')}</td>
        <td class="mcap">${escapeHtml(h.mcap_type || '—')}</td>
        <td class="num weight"><b>${DataLoader.fmtNum(h.holding_pct, 2)}%</b></td>
      </tr>`).join('');

    mount.innerHTML = `
      <div class="holdings-table-wrap-v2">
        <table class="holdings-tbl-v2">
          <thead><tr><th>#</th><th>Company</th><th>Sector</th><th>M-Cap</th><th class="num">Weight</th></tr></thead>
          <tbody>${holdingsRows}</tbody>
        </table>
      </div>`;

    const callout = document.getElementById('holdingsCallout');
    if (callout) {
      callout.hidden = false;
      callout.innerHTML = `
        Top 10 concentration: <b>${DataLoader.fmtNum(top10Concentration, 2)}%</b>
        ${entry.cash_and_equiv_pct != null && entry.cash_and_equiv_pct > 0
          ? ` · Cash &amp; equiv (TREPS / Repo / G-Sec): <b>${DataLoader.fmtNum(entry.cash_and_equiv_pct, 2)}%</b>` : ''}`;
    }
  }

  /**
   * Fix-List 8 §3 — render the sector allocation as a ranked bar list.
   *   • Sectors are pre-sorted desc by holding_pct in the analytics file.
   *   • Top 10 occupy positions 1–10.
   *   • All remaining sectors collapse into a single "Others (N sectors)"
   *     row that is ALWAYS rendered last (position 11), regardless of
   *     its summed value (it might be larger than position 10's, but
   *     spec mandates Others-last for visual consistency).
   *   • Bar fill width is scaled against the maximum value within the
   *     top 10 (Others is excluded from the max calc so it doesn't
   *     dominate when N is large).
   */
  function renderSectorList(sectors) {
    // Fix-List 10 §6 — text-only rows, no proportional bars. The
    // numeric % column is itself the "magnitude" channel; the gold-on-tan
    // bars from Fix-List 9 are gone.
    const mount = document.getElementById('sectorList');
    if (!mount) return;
    if (!sectors || sectors.length === 0) {
      const rows = [];
      for (let i = 1; i <= 11; i++) {
        rows.push(`
          <div class="sector-row">
            <span class="sector-rank">${i}.</span>
            <span class="sector-name">—</span>
            <span class="sector-pct">—</span>
          </div>`);
      }
      mount.innerHTML = rows.join('');
      return;
    }
    const top10 = sectors.slice(0, 10);
    const tail  = sectors.slice(10);
    const rowsHtml = top10.map((s, i) => {
      const pct = Number(s.holding_pct) || 0;
      return `
        <div class="sector-row">
          <span class="sector-rank">${i + 1}.</span>
          <span class="sector-name">${escapeHtml(s.sector || '—')}</span>
          <span class="sector-pct">${DataLoader.fmtNum(pct, 2)}%</span>
        </div>`;
    });
    if (tail.length > 0) {
      const othersSum = tail.reduce((acc, s) => acc + (Number(s.holding_pct) || 0), 0);
      rowsHtml.push(`
        <div class="sector-row">
          <span class="sector-rank">${top10.length + 1}.</span>
          <span class="sector-name">Others (${tail.length} sectors)</span>
          <span class="sector-pct">${DataLoader.fmtNum(othersSum, 2)}%</span>
        </div>`);
    }
    mount.innerHTML = rowsHtml.join('');
  }

  /** When analytics-load fails we still want to mark the sector card as
   *  empty (ring-motif placeholder shown, list cleared). */
  function showSectorDonutEmpty() {
    const empty = document.getElementById('sectorDonutEmpty');
    if (empty) empty.hidden = false;
    const list = document.getElementById('sectorList');
    if (list) list.innerHTML = '';
  }

  /* ============================================================
   * Fix-List 8 Feature 3 — Similar Funds by Holdings
   *
   * Compute pairwise overlap between the current fund's top-20
   * holdings and every other fund in the analytics file. Surface
   * the top-5 by overlap%. Disclaimer: this is a top-20 sample, not
   * full-portfolio overlap.
   * ============================================================ */
  /** Walk every fund with holdings and compute overlap = Σ min(wA, wB).
   *  `peerHoldingsLookup(code)` returns {holdings, source} so callers can
   *  prefer the full-holdings file when it's loaded and fall back to the
   *  top-20 analytics list when it isn't. Returns top-N peers sorted desc.
   */
  function computeTopOverlapPeers(currentSchemeCode, peerCodes, currentFundHoldings,
                                  peerHoldingsLookup, topN) {
    if (!currentFundHoldings || currentFundHoldings.length === 0) return [];
    const results = [];
    const currentMap = new Map(
      currentFundHoldings.map(h => [h.company, Number(h.holding_pct) || 0])
    );
    for (const code of peerCodes) {
      if (String(code) === String(currentSchemeCode)) continue;
      const peer = peerHoldingsLookup(code);
      if (!peer.holdings || peer.holdings.length === 0) continue;
      let overlap = 0;
      for (const h of peer.holdings) {
        const w1 = currentMap.get(h.company);
        if (w1 !== undefined) overlap += Math.min(w1, Number(h.holding_pct) || 0);
      }
      if (overlap > 0) {
        results.push({ code: String(code), overlap: Math.round(overlap * 100) / 100 });
      }
    }
    results.sort((a, b) => b.overlap - a.overlap);
    return results.slice(0, topN || 5);
  }

  function renderSimilarFunds(fund, analyticsEntry) {
    const card  = document.getElementById('similarFundsCard');
    const mount = document.getElementById('similarFundsMount');
    const foot  = document.getElementById('similarFundsFoot');
    const link  = document.getElementById('similarFundsLink');
    if (!card || !mount) return;

    if (!analyticsEntry || !analyticsEntry.top_20_holdings || !_analyticsCache) {
      card.hidden = false;
      mount.innerHTML = `<p class="similar-funds-pending">Holdings data not available for overlap analysis.</p>`;
      if (foot) foot.textContent = '';
      if (link) link.style.display = 'none';
      return;
    }

    // Fix-List 9 Feature A — prefer this fund's full holdings (up to 200
    // lines) when available; fall back to its analytics top-20.
    const own = _peerHoldings(fund.scheme_code);
    const ownHoldings = own.holdings.length > 0
      ? own.holdings
      : analyticsEntry.top_20_holdings;
    // Universe of peer codes = union of analytics + holdings-full keys
    const peerCodeSet = new Set();
    if (_analyticsCache && _analyticsCache.funds) {
      for (const c in _analyticsCache.funds) peerCodeSet.add(c);
    }
    if (_holdingsFullCache && typeof _holdingsFullCache === 'object'
        && _holdingsFullCache.funds) {
      for (const c in _holdingsFullCache.funds) peerCodeSet.add(c);
    }
    const peers = computeTopOverlapPeers(
      fund.scheme_code, [...peerCodeSet], ownHoldings, _peerHoldings, 5
    );
    if (peers.length === 0) {
      card.hidden = false;
      mount.innerHTML = `<p class="similar-funds-pending">No overlapping funds found for this analysis.</p>`;
      if (foot) foot.textContent = '';
      if (link) link.style.display = 'none';
      return;
    }

    // Map analytics scheme codes back to the screener cycle to grab the
    // full fund name + category for display.
    const screenerByCode = new Map((_cycle.funds || []).map(f => [String(f.scheme_code), f]));
    const rowsHtml = peers.map(p => {
      const sf = screenerByCode.get(String(p.code));
      const fundName = sf ? sf.fund_name : (_analyticsCache.funds[p.code]?.fund_name || `Scheme ${p.code}`);
      const cat = sf ? sf.category : '—';
      // Fix-List 10 §7 — absolute scaling: bar width % = overlap %
      // directly. A 60 % overlap shows a 60 %-wide bar, 30 % shows 30 %.
      // Removes the Fix-List 8 relative scaling against the highest
      // peer (which made every fund's #1 peer look like 100 %).
      const barWidth = Math.max(0, Math.min(100, Math.abs(Number(p.overlap) || 0)));
      const href = `fund-detail.html?scheme=${encodeURIComponent(p.code)}`;
      return `
        <div class="similar-row">
          <a class="similar-name" href="${href}">${escapeHtml(fundName)}</a>
          <span class="similar-cat">${escapeHtml(cat)}</span>
          <span class="similar-pct">${DataLoader.fmtNum(p.overlap, 2)}%</span>
          <div class="similar-bar-wrap"><div class="similar-bar-fill" style="width:${barWidth}%"></div></div>
        </div>`;
    }).join('');
    mount.innerHTML = `<div class="similar-funds-list">${rowsHtml}</div>`;

    const dateStr = _analyticsDate ? DataLoader.fmtDate(_analyticsDate) : '—';
    if (foot) {
      const sourceLabel = _holdingsFullSource === 'full'
        ? 'full equity holdings'
        : 'top-20 holdings';
      foot.innerHTML =
        `Based on ${sourceLabel} as on ${escapeHtml(dateStr)}. ` +
        `Overlap = Σ min(weight<sub>A</sub>, weight<sub>B</sub>) for common stocks.`;
    }
    if (link) {
      link.style.display = '';
      const codes = [String(fund.scheme_code), ...peers.map(p => String(p.code))].join(',');
      link.href = `overlap.html?schemes=${encodeURIComponent(codes)}`;
    }

    card.hidden = false;
  }

  /* ============================================================
   * v4.1 Item L — COMPETITION ANALYSIS (Top-7 peers + 1×7 overlap)
   *
   * §14.2 Top-7 table:
   *   - 7 same-sub-category peers by centricity_score desc (excl. current).
   *   - Tie-break: Sharpe desc, then AUM desc (§19 Q6 default).
   *   - Row 8 = AVERAGE of those 7 (bold + light grey bg).
   *   - Row 9 = CURRENT fund (highlighted, very light gold bg). Always shown.
   *   - For tiny categories (<7 peers): show all peers + avg + current.
   *   - Columns: Fund (link) · 3Y Rolling · YTD · Sharpe · L/M/S split · # Stocks.
   *
   * §14.3 Overlap matrix:
   *   - 1×7 — current fund vs each peer.
   *   - Cell bg gradient: #FFFFFF (0%) → #BD9568 (100%).
   *   - Cell text: black on light, white on ≥50%.
   *   - Tooltip on hover: top-5 overlapping holdings.
   *   - Skip with note when current fund's holdings are unavailable.
   * ============================================================ */
  function renderCompetitionAnalysis(fund, cycle) {
    const wrap = document.getElementById('compPeerWrap');
    if (!wrap || !fund || !cycle || !cycle.funds) return;
    /* Bug-fix 2026-05-11 / ISSUE-0026 Bug 2 — sort the FULL same-sub-category
       list (including the current fund) so each fund's index is its true
       category rank. Excluding the current fund first off-by-ones every peer
       rank when the current fund sits above them in the score order
       (e.g. ICICI Pru E&D rank #1 in Aggressive Hybrid → top[0] is the
       category's rank #2, not rank #1). */
    const categoryAll = cycle.funds
      .filter(p => p.category === fund.category)
      .slice()
      .sort(_competitionSort);
    const rankOf = new Map();
    categoryAll.forEach((p, i) => rankOf.set(p.scheme_code, i + 1));
    const fundRank = rankOf.get(fund.scheme_code) || null;
    const peers = categoryAll.filter(p => p.scheme_code !== fund.scheme_code);
    /* Spec §19 Q4 — for sub-categories with <7 peers, show all available. */
    const top = peers.slice(0, 7);
    const avg = _avgPeerRow(top);
    const cols = [
      { k: 'fund',   l: 'Fund' },
      { k: 'r3',     l: '3Y Rolling' },
      { k: 'ytd',    l: 'YTD' },
      { k: 'sharpe', l: 'Sharpe' },
      { k: 'lms',    l: 'L / M / S' },
      { k: 'stocks', l: '# Stocks' },
    ];
    const headerHtml = '<thead><tr>' +
      cols.map(c => '<th>' + escapeHtml(c.l) + '</th>').join('') +
      '</tr></thead>';
    const rowsHtml = top.map(p => _competitionRow(p, rankOf.get(p.scheme_code), 'peer'))
      .concat([_competitionAvgRow(avg, top.length)])
      .concat([_competitionRow(fund, fundRank, 'current')])
      .join('');
    wrap.innerHTML = '<table class="comp-peer-tbl">' + headerHtml +
      '<tbody>' + rowsHtml + '</tbody></table>' +
      (top.length < 7
        ? '<p class="comp-peer-foot">Only ' + top.length + ' other fund' +
          (top.length === 1 ? '' : 's') + ' in this sub-category.</p>'
        : '');
  }

  function _competitionSort(a, b) {
    const sa = a.centricity_score || 0;
    const sb = b.centricity_score || 0;
    if (Math.abs(sb - sa) > 0.0001) return sb - sa;
    /* §19 Q6 tiebreak — Sharpe desc, then AUM desc. */
    const ha = a.risk_metrics?.sharpe_3y || 0;
    const hb = b.risk_metrics?.sharpe_3y || 0;
    if (Math.abs(hb - ha) > 0.0001) return hb - ha;
    return (b.aum_cr || 0) - (a.aum_cr || 0);
  }

  function _avgPeerRow(rows) {
    if (!rows.length) return null;
    const get = (f, path) => path.split('.').reduce((o, k) => o == null ? o : o[k], f);
    const meanOf = (path) => {
      const vs = rows.map(r => get(r, path)).filter(v => typeof v === 'number');
      return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null;
    };
    /* Bug-fix 2026-05-11 / ISSUE-0026 Bug 1 — rolling_3y_stats actual fields
       are avg_pct + median_pct (the *_3y_cagr_pct names never existed). Also
       fall back to the top-level rolling_3y_avg_pct on the fund record when
       the nested block is null. */
    return {
      r3:     meanOf('rolling_3y_stats.avg_pct')
           ?? meanOf('rolling_3y_stats.median_pct')
           ?? meanOf('rolling_3y_avg_pct'),
      ytd:    meanOf('monitor_returns.ytd_pct') ?? meanOf('cy_returns.cy_ytd_pct'),
      sharpe: meanOf('risk_metrics.sharpe_3y'),
      lg:     meanOf('mcap_split.large_pct'),
      md:     meanOf('mcap_split.mid_pct'),
      sm:     meanOf('mcap_split.small_pct'),
    };
  }

  function _competitionRow(f, label, cls) {
    const get = (path) => path.split('.').reduce((o, k) => o == null ? o : o[k], f);
    const fmtPct = v => (typeof v !== 'number') ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';
    const fmtNum = v => (typeof v !== 'number') ? '—' : v.toFixed(2);
    /* Bug-fix 2026-05-11 / ISSUE-0026 Bug 1 — see _avgPeerRow comment. */
    const r3  = get('rolling_3y_stats.avg_pct')
             ?? get('rolling_3y_stats.median_pct')
             ?? get('rolling_3y_avg_pct');
    const ytd = get('monitor_returns.ytd_pct') ?? get('cy_returns.cy_ytd_pct');
    const sh  = get('risk_metrics.sharpe_3y');
    const lg  = get('mcap_split.large_pct') || 0;
    const md  = get('mcap_split.mid_pct')   || 0;
    const sm  = get('mcap_split.small_pct') || 0;
    const stocks = get('no_of_stocks') ?? get('analytics.no_of_stocks');
    const lmsTxt = (lg || md || sm)
      ? Math.round(lg) + ' / ' + Math.round(md) + ' / ' + Math.round(sm)
      : '—';
    const sc = f.scheme_code;
    const linkOpen = sc ? '<a href="fund-detail.html?scheme=' + sc + '">' : '';
    const linkClose = sc ? '</a>' : '';
    /* Bug-fix 2026-05-11 / ISSUE-0026 Bug 2 — numeric labels render as #N
       category-rank (no trailing dot, no ★). String labels (the Σ summary
       row uses _competitionAvgRow, but defensive: any string still renders
       verbatim). */
    const rankLabel = (typeof label === 'number')
      ? '#' + label
      : escapeHtml(String(label || ''));
    return '<tr class="comp-row-' + cls + '">' +
      '<td class="comp-rank">' + rankLabel + '</td>' +
      '<td class="comp-fund-cell">' + linkOpen + escapeHtml(f.fund_name || '—') + linkClose + '</td>' +
      '<td>' + fmtPct(r3) + '</td>' +
      '<td>' + fmtPct(ytd) + '</td>' +
      '<td>' + fmtNum(sh) + '</td>' +
      '<td>' + lmsTxt + '</td>' +
      '<td>' + (stocks != null ? stocks : '—') + '</td>' +
      '</tr>';
  }

  function _competitionAvgRow(avg, n) {
    if (!avg) return '';
    const fmtPct = v => (typeof v !== 'number') ? '—' : (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2) + '%';
    const fmtNum = v => (typeof v !== 'number') ? '—' : v.toFixed(2);
    const lms = (avg.lg || avg.md || avg.sm)
      ? Math.round(avg.lg) + ' / ' + Math.round(avg.md) + ' / ' + Math.round(avg.sm)
      : '—';
    return '<tr class="comp-row-avg">' +
      '<td class="comp-rank">Σ</td>' +
      '<td class="comp-fund-cell"><b>Average of top ' + n + '</b></td>' +
      '<td>' + fmtPct(avg.r3) + '</td>' +
      '<td>' + fmtPct(avg.ytd) + '</td>' +
      '<td>' + fmtNum(avg.sharpe) + '</td>' +
      '<td>' + lms + '</td>' +
      '<td>—</td>' +
      '</tr>';
  }

  /* v4.1 Item L — overlap matrix renderer; called from the analytics
     callback once the current fund's holdings are in memory. */
  function renderCompetitionOverlap(fund, cycle, analyticsEntry) {
    const wrap = document.getElementById('compOverlapWrap');
    if (!wrap) return;
    if (!analyticsEntry || !analyticsEntry.top_20_holdings) {
      wrap.innerHTML = '<p class="comp-overlap-empty">Holdings data unavailable for this fund.</p>';
      return;
    }
    const peers = (cycle.funds || [])
      .filter(p => p.category === fund.category && p.scheme_code !== fund.scheme_code)
      .sort(_competitionSort)
      .slice(0, 7);
    if (!peers.length) {
      wrap.innerHTML = '<p class="comp-overlap-empty">No peers in this sub-category for overlap analysis.</p>';
      return;
    }
    /* Reuse the existing per-fund holdings lookup that prefers the full
       holdings file when loaded and falls back to the top-20 list. */
    const own = _peerHoldings(fund.scheme_code);
    const ownHoldings = own.holdings.length > 0 ? own.holdings : analyticsEntry.top_20_holdings;
    const ownMap = new Map(ownHoldings.map(h => [h.company, Number(h.holding_pct) || 0]));

    const cells = peers.map(p => {
      const peerH = _peerHoldings(p.scheme_code);
      if (!peerH.holdings || peerH.holdings.length === 0) {
        return { peer: p, overlap: null, top5: [] };
      }
      let overlap = 0;
      const contribs = [];
      for (const h of peerH.holdings) {
        const w1 = ownMap.get(h.company);
        if (w1 !== undefined) {
          const minW = Math.min(w1, Number(h.holding_pct) || 0);
          overlap += minW;
          contribs.push({ company: h.company, ownW: w1, peerW: Number(h.holding_pct) || 0, contribute: minW });
        }
      }
      contribs.sort((a, b) => b.contribute - a.contribute);
      return { peer: p, overlap, top5: contribs.slice(0, 5) };
    });

    /* Render table — header with peer names, single body row with this fund's
       overlap to each peer. Cells use a gold gradient by overlap %. */
    const head = '<thead><tr><th class="comp-overlap-corner"></th>' +
      cells.map(c =>
        '<th><a href="fund-detail.html?scheme=' + c.peer.scheme_code + '">' +
        escapeHtml(c.peer.fund_name) + '</a></th>'
      ).join('') + '</tr></thead>';
    const fundLabel = '<th class="comp-overlap-corner">' + escapeHtml(fund.fund_name) + '</th>';
    const cellHtml = cells.map(c => {
      if (c.overlap == null) {
        return '<td class="comp-overlap-cell" data-empty="1">—</td>';
      }
      const pct = Math.max(0, Math.min(100, c.overlap));
      const t = pct / 100;
      const r = Math.round(255 + (189 - 255) * t);
      const g = Math.round(255 + (149 - 255) * t);
      const b = Math.round(255 + (104 - 255) * t);
      const textCol = pct >= 50 ? '#fff' : '#000';
      const tipLines = c.top5.map(s =>
        escapeHtml(s.company) + ': ' +
        s.ownW.toFixed(2) + '% / ' + s.peerW.toFixed(2) + '%'
      ).join('\n');
      const title = 'Overlap ' + pct.toFixed(2) + '%\nTop 5 contributing stocks:\n' + tipLines;
      return '<td class="comp-overlap-cell" style="background:rgb(' + r + ',' + g + ',' + b + ');color:' + textCol + ';" title="' + escapeHtml(title) + '">' +
             pct.toFixed(1) + '%</td>';
    }).join('');
    wrap.innerHTML = '<table class="comp-overlap-tbl">' + head +
      '<tbody><tr>' + fundLabel + cellHtml + '</tr></tbody></table>';
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
      <section class="block top25-picker">
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
