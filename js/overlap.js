/* ============================================================
 *  overlap.js — Portfolio Overlap page (Fix-List 8 Feature 2)
 *
 *  Architecture:
 *    • Reads ONLY data/analytics-2026-03-31.json (already shipped by the
 *      Fix-List 5 §B converter). No new converter, no new contract.
 *    • Reads the screener cycle JSON for fund_name + category metadata
 *      (Designed-for-Change §1: dashboard merges by AMFI at load time).
 *    • Overlap is computed in the browser as
 *           Σ min(weight_A, weight_B)   for stocks in both top-20 lists
 *      Disclaimer surfaced prominently — full-portfolio overlap may differ.
 *
 *  Inputs / outputs:
 *    • Input  data/analytics-YYYY-MM-DD.json  (read on page load)
 *    • Input  data/screener-YYYY-MM-DD.json   (joins to fund_name / category)
 *    • Input  ?schemes=A,B,C,…                (URL-driven pre-selection)
 *    • Output an interactive heatmap matrix + per-cell tooltip
 *
 *  No persistence (Pattern A): selections live only in the URL hash —
 *  refresh-stable, copy-paste-shareable, but not saved to localStorage.
 * ============================================================ */
(function () {
  'use strict';

  const MAX_FUNDS = 40;
  const TRUNC_NAME = 25;          // Y-axis label truncation char count
  const TRUNC_NAME_MAX = 36;      // overlay row labels can wrap a bit longer

  let _cycle = null;             // screener cycle JSON
  let _analytics = null;         // analytics doc {analytics_date, funds:{...}}
  // Fix-List 9 Feature A — full equity-only holdings (per-fund up to 200
  // positions). Primary source for the overlap matrix; the page falls back
  // to analytics top-20 only if the fetch 404s.
  let _holdingsFull = null;      // {holdings_date, funds:{code:[holdings]}}
  let _holdingsSource = 'top20'; // 'full' once holdings-full lands
  let _allFunds = [];            // [{code, name, cat, holdings, hasHoldings}, …] sorted
  let _categories = [];          // sorted unique categories
  let _selected = new Set();     // scheme_code strings (only those with holdings)
  let _filterText = '';
  let _filterCats = new Set();   // empty = all
  let _threshold = 0;            // %, 0–80
  let _matrix = null;            // [{a, b, value, common: [{stock,wA,wB}]}]

  /* -------------------------------------------------------- *
   *  Bootstrap
   * -------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', () => {
    Cycle.getActiveCycle()
      .then(activeDate => {
        if (!activeDate) throw new Error('no cycles in manifest');
        return Promise.all([
          DataLoader.loadCycle(activeDate),
          _loadAnalytics(),
          _loadHoldingsFull(),     // Fix-List 9 Feature A — primary source
        ]);
      })
      .then(([cycle, analytics, holdingsFull]) => {
        _cycle = cycle;
        _analytics = analytics;
        _holdingsFull = holdingsFull;        // null if 404 / parse error
        _holdingsSource = holdingsFull ? 'full' : 'top20';
        _composeFundList();
        _renderEyebrow();
        _renderFundList();
        _renderCategoryFilter();
        _wireToolbar();
        _wirePicker();
        _readSelectionFromURL();
        _refreshAll();
      })
      .catch(err => {
      console.error('[overlap] bootstrap failed', err);
      document.getElementById('overlapMain').innerHTML =
        `<p style="padding:48px 32px;color:#666;font-style:italic">
          Could not load the overlap data file (${err && err.message ? err.message : 'fetch error'}).
          Check the console for details.
        </p>`;
    });
  });

  /* -------------------------------------------------------- *
   *  Data load + compose
   * -------------------------------------------------------- */
  async function _loadAnalytics() {
    // Same file the fund-detail page reads. v1 ships a single file; when
    // the analytics pipeline goes monthly, latest-by-name wins.
    const url = 'data/analytics-2026-03-31.json';
    const res = await fetch(url, { cache: 'default' });
    if (!res.ok) throw new Error('analytics HTTP ' + res.status);
    return res.json();
  }

  /** Fix-List 9 Feature A — full equity holdings per fund (up to 200).
   *  Same date + source folder as the analytics file. Resolves to null
   *  on 404 / parse error so the page can fall back to top-20. */
  async function _loadHoldingsFull() {
    const url = 'data/holdings-full-2026-03-31.json';
    try {
      const res = await fetch(url, { cache: 'default' });
      if (!res.ok) throw new Error('holdings-full HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      console.warn('[overlap] holdings-full unavailable, falling back to top-20', e);
      return null;
    }
  }

  function _composeFundList() {
    // Outer-join: take every screener fund as the universe, attach holdings
    // from the holdings-full file when present (preferred), or from the
    // analytics top-20 (fallback). Funds without holdings render as
    // disabled rows so the user sees "this exists but isn't in the overlap
    // data yet."
    const screenerFunds = (_cycle.funds || []);
    const aFunds = _analytics.funds || {};
    const fullFunds = (_holdingsFull && _holdingsFull.funds) || {};
    _allFunds = screenerFunds
      .map(f => {
        const code = String(f.scheme_code);
        // Prefer full holdings; fall back to analytics top_20 for any fund
        // missing from the full file (shouldn't happen in v1 — same source
        // — but defensive in case the two files drift).
        let holdings = fullFunds[code];
        if (!holdings || holdings.length === 0) {
          const aEntry = aFunds[code];
          holdings = (aEntry && aEntry.top_20_holdings) || [];
        }
        return {
          code,
          name: f.fund_name || `Scheme ${code}`,
          cat: f.category || '—',
          holdings,
          hasHoldings: holdings.length > 0,
        };
      })
      // Sort: funds with holdings first, then alphabetical by name
      .sort((a, b) => {
        if (a.hasHoldings !== b.hasHoldings) return a.hasHoldings ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    _categories = Array.from(new Set(_allFunds.map(f => f.cat))).sort();
  }

  /* -------------------------------------------------------- *
   *  Eyebrow (provenance)
   * -------------------------------------------------------- */
  function _renderEyebrow() {
    const el = document.getElementById('overlapEyebrow');
    const dateStr = _analytics.analytics_date ? DataLoader.fmtDate(_analytics.analytics_date) : '—';
    const sourceLabel = _holdingsSource === 'full'
      ? `Full equity holdings as on ${dateStr}`
      : `Top-20 holdings as on ${dateStr}`;
    el.textContent = `Portfolio Overlap · ${sourceLabel}`;
    document.getElementById('footUpdated').textContent =
      `Last updated · ${dateStr}`;
  }

  /* -------------------------------------------------------- *
   *  Picker (left pane)
   * -------------------------------------------------------- */
  function _wirePicker() {
    const search = document.getElementById('pickerSearch');
    search.addEventListener('input', () => {
      _filterText = search.value.trim().toLowerCase();
      _renderFundList();
    });

    const catBtn = document.getElementById('pickerCatBtn');
    const catPanel = document.getElementById('pickerCatPanel');
    catBtn.addEventListener('click', () => {
      catPanel.hidden = !catPanel.hidden;
    });
    document.addEventListener('click', (e) => {
      if (!catBtn.contains(e.target) && !catPanel.contains(e.target)) {
        catPanel.hidden = true;
      }
    });

    document.getElementById('pickerSelectVisible').addEventListener('click', () => {
      const visible = _visibleFunds();
      let added = 0;
      for (const f of visible) {
        if (!f.hasHoldings) continue;
        if (_selected.size >= MAX_FUNDS) break;
        if (!_selected.has(f.code)) { _selected.add(f.code); added += 1; }
      }
      if (added > 0) _refreshAll();
      else _flashCapNote();
    });

    document.getElementById('pickerClear').addEventListener('click', () => {
      _selected.clear();
      _refreshAll();
    });
  }

  function _renderCategoryFilter() {
    const panel = document.getElementById('pickerCatPanel');
    panel.innerHTML = _categories.map(c => `
      <label>
        <input type="checkbox" data-cat="${escapeHtml(c)}">
        ${escapeHtml(c)}
      </label>`).join('');
    panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const cat = cb.getAttribute('data-cat');
        if (cb.checked) _filterCats.add(cat);
        else _filterCats.delete(cat);
        _updateCatBtnLabel();
        _renderFundList();
      });
    });
  }

  function _updateCatBtnLabel() {
    const btn = document.getElementById('pickerCatBtn');
    if (_filterCats.size === 0) {
      btn.firstChild.nodeValue = 'All categories ';
    } else if (_filterCats.size === 1) {
      btn.firstChild.nodeValue = `${[..._filterCats][0]} `;
    } else {
      btn.firstChild.nodeValue = `${_filterCats.size} categories `;
    }
  }

  function _visibleFunds() {
    return _allFunds.filter(f => {
      if (_filterText && !f.name.toLowerCase().includes(_filterText)) return false;
      if (_filterCats.size > 0 && !_filterCats.has(f.cat)) return false;
      return true;
    });
  }

  function _renderFundList() {
    const list = document.getElementById('pickerList');
    const visible = _visibleFunds();
    if (visible.length === 0) {
      list.innerHTML = `<p class="picker-pending">No funds match the current filters.</p>`;
      _updateCounter();
      return;
    }
    list.innerHTML = visible.map(f => {
      const checked = _selected.has(f.code) ? 'checked' : '';
      const disabled = !f.hasHoldings ? 'disabled' : '';
      const cls = [
        'picker-row',
        _selected.has(f.code) ? 'selected' : '',
        !f.hasHoldings ? 'disabled' : '',
      ].filter(Boolean).join(' ');
      const titleAttr = !f.hasHoldings
        ? 'title="Holdings data not available for this fund"' : '';
      return `
        <label class="${cls}" data-code="${escapeHtml(f.code)}" ${titleAttr}>
          <input type="checkbox" ${checked} ${disabled}>
          <span>
            <span class="pr-name">${escapeHtml(f.name)}</span>
            <span class="pr-cat">${escapeHtml(f.cat)}</span>
          </span>
        </label>`;
    }).join('');
    list.querySelectorAll('label.picker-row').forEach(row => {
      row.addEventListener('click', (e) => {
        if (row.classList.contains('disabled')) {
          e.preventDefault();
          return;
        }
        const code = row.getAttribute('data-code');
        if (e.target.tagName !== 'INPUT') {
          // Toggle by row click (label default is fine for the input click)
          e.preventDefault();
        }
        _toggleFund(code);
      });
    });
    _updateCounter();
  }

  function _toggleFund(code) {
    if (_selected.has(code)) {
      _selected.delete(code);
    } else {
      if (_selected.size >= MAX_FUNDS) {
        _flashCapNote();
        return;
      }
      _selected.add(code);
    }
    _refreshAll();
  }

  function _flashCapNote() {
    const el = document.getElementById('pickerCapNote');
    el.hidden = false;
    clearTimeout(_flashCapNote._t);
    _flashCapNote._t = setTimeout(() => { el.hidden = true; }, 3500);
  }

  function _updateCounter() {
    document.getElementById('pickerCounter').textContent = `Selected: ${_selected.size}`;
  }

  /* -------------------------------------------------------- *
   *  Toolbar (threshold + download)
   * -------------------------------------------------------- */
  function _wireToolbar() {
    const slider = document.getElementById('thresholdSlider');
    const value  = document.getElementById('thresholdValue');
    slider.addEventListener('input', () => {
      _threshold = Number(slider.value);
      value.textContent = `${_threshold}%`;
      _renderMatrix();
    });

    // Download disabled in v1 (deferred per Fix-List 2 export deferral).
    // Wire the deferred-caption pattern so the button looks consistent
    // with Screener's PDF / PPT buttons.
    const dl = document.getElementById('downloadPngBtn');
    dl.addEventListener('click', () => {
      if (dl.disabled) return;
      // Future: wrap matrixMount in html2canvas + saveAs.
      // No-op in v1 — leave the disabled state on.
    });
  }

  /* -------------------------------------------------------- *
   *  URL-driven pre-selection (?schemes=A,B,C)
   * -------------------------------------------------------- */
  function _readSelectionFromURL() {
    const sp = new URLSearchParams(window.location.search);
    const raw = sp.get('schemes') || sp.get('funds') || '';
    if (!raw) return;
    const codes = raw.split(',').map(s => s.trim()).filter(Boolean);
    const validHoldings = new Set(
      _allFunds.filter(f => f.hasHoldings).map(f => f.code)
    );
    for (const c of codes) {
      if (_selected.size >= MAX_FUNDS) break;
      if (validHoldings.has(c)) _selected.add(c);
    }
  }

  function _writeSelectionToURL() {
    const codes = [..._selected].join(',');
    const url = new URL(window.location.href);
    if (codes) url.searchParams.set('schemes', codes);
    else url.searchParams.delete('schemes');
    history.replaceState(null, '', url);
  }

  /* -------------------------------------------------------- *
   *  Matrix
   * -------------------------------------------------------- */
  function _refreshAll() {
    _renderFundList();
    _writeSelectionToURL();
    _computeMatrix();
    _renderMatrix();
    const dl = document.getElementById('downloadPngBtn');
    if (dl) dl.disabled = _selected.size < 2;
  }

  function _computeMatrix() {
    const codes = [..._selected];
    const list = codes.map(c => _allFunds.find(f => f.code === c)).filter(Boolean);
    if (list.length < 2) { _matrix = null; return; }
    const rows = list.map(a => {
      const aMap = new Map(a.holdings.map(h => [h.company, Number(h.holding_pct) || 0]));
      return list.map(b => {
        if (a.code === b.code) {
          return { a: a.code, b: b.code, value: 100, self: true, common: [] };
        }
        let total = 0;
        const common = [];
        for (const h of b.holdings) {
          const w1 = aMap.get(h.company);
          if (w1 !== undefined) {
            const wB = Number(h.holding_pct) || 0;
            const minW = Math.min(w1, wB);
            total += minW;
            common.push({ stock: h.company, wA: w1, wB, contrib: minW });
          }
        }
        common.sort((x, y) => y.contrib - x.contrib);
        return {
          a: a.code, b: b.code,
          value: Math.round(total * 100) / 100,
          self: false, common: common.slice(0, 5),
        };
      });
    });
    _matrix = { funds: list, rows };
  }

  function _binClass(value, isSelf) {
    if (isSelf) return 'bin-self';
    if (value < 20) return 'bin-0';
    if (value < 40) return 'bin-20';
    if (value < 60) return 'bin-40';
    if (value < 80) return 'bin-60';
    return 'bin-80';
  }

  function _renderMatrix() {
    const empty = document.getElementById('matrixEmpty');
    const area  = document.getElementById('matrixArea');
    const mount = document.getElementById('matrixMount');
    const foot  = document.getElementById('matrixFoot');
    if (!_matrix) {
      empty.style.display = '';
      area.hidden = true;
      return;
    }
    empty.style.display = 'none';
    area.hidden = false;

    const { funds, rows } = _matrix;
    const headers = funds.map((f, i) =>
      `<th title="${escapeHtml(f.name)}">${i + 1}</th>`
    ).join('');

    const bodyRows = funds.map((f, i) => {
      const cells = rows[i].map((cell, j) => {
        const bin = _binClass(cell.value, cell.self);
        const dim = (!cell.self && cell.value < _threshold) ? ' below-threshold' : '';
        const display = cell.self ? '—' : DataLoader.fmtNum(cell.value, 1);
        return `<td class="cell ${bin}${dim}"
                    data-row="${i}" data-col="${j}">${display}</td>`;
      }).join('');
      const truncatedName = _truncate(f.name, TRUNC_NAME_MAX);
      return `
        <tr>
          <th class="row-label" title="${escapeHtml(f.name)}">
            <span class="rl-num">${i + 1}.</span>${escapeHtml(truncatedName)}
          </th>
          ${cells}
        </tr>`;
    }).join('');

    mount.innerHTML = `
      <table class="overlap-matrix" id="overlapMatrixTable">
        <thead>
          <tr>
            <th class="row-label-corner"></th>
            ${headers}
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>`;

    const dateStr = _analytics.analytics_date ? DataLoader.fmtDate(_analytics.analytics_date) : '—';
    const disclaimer = _holdingsSource === 'full'
      ? `<b>Full equity holdings only</b> (debt / cash / derivatives excluded). Capped at 200 lines per fund.`
      : `<b>Overlap on top-20 holdings only;</b> full-portfolio overlap may differ.`;
    foot.innerHTML =
      `${funds.length} funds · ${(funds.length * (funds.length - 1)) / 2} unique pairs · ` +
      `Holdings as on ${escapeHtml(dateStr)}. ` + disclaimer;

    _wireCellHover(funds, rows);
  }

  function _wireCellHover(funds, rows) {
    const tooltip = document.getElementById('cellTooltip');
    document.querySelectorAll('#overlapMatrixTable td.cell').forEach(td => {
      td.addEventListener('mouseenter', (e) => {
        const i = Number(td.getAttribute('data-row'));
        const j = Number(td.getAttribute('data-col'));
        const cell = rows[i][j];
        if (cell.self) {
          tooltip.hidden = true;
          return;
        }
        const aF = funds[i];
        const bF = funds[j];
        const rowsHtml = cell.common.length
          ? cell.common.map(c =>
              `<tr><td>${escapeHtml(c.stock)}</td>
                   <td>${DataLoader.fmtNum(c.wA, 2)}%</td>
                   <td>${DataLoader.fmtNum(c.wB, 2)}%</td></tr>`
            ).join('')
          : `<tr><td colspan="3" style="font-style:italic;color:rgba(255,255,255,.6)">No common stocks in top-20</td></tr>`;
        tooltip.innerHTML = `
          <div class="ct-h">${escapeHtml(_truncate(aF.name, 36))} × ${escapeHtml(_truncate(bF.name, 36))}</div>
          <div style="font-size:11px;color:#fff;margin-bottom:6px">
            Overlap: <b>${DataLoader.fmtNum(cell.value, 2)}%</b>
          </div>
          <table>
            <thead><tr><th>Stock</th><th style="text-align:right">A</th><th style="text-align:right">B</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>`;
        tooltip.hidden = false;
        _positionTooltip(tooltip, e);
      });
      td.addEventListener('mousemove', (e) => _positionTooltip(tooltip, e));
      td.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    });
  }

  function _positionTooltip(tooltip, evt) {
    const pad = 14;
    const tw = tooltip.offsetWidth;
    const th = tooltip.offsetHeight;
    let left = evt.clientX + pad;
    let top  = evt.clientY + pad;
    if (left + tw + pad > window.innerWidth)  left = evt.clientX - tw - pad;
    if (top + th + pad > window.innerHeight)  top  = evt.clientY - th - pad;
    tooltip.style.left = `${left}px`;
    tooltip.style.top  = `${top}px`;
  }

  /* -------------------------------------------------------- *
   *  Helpers
   * -------------------------------------------------------- */
  function _truncate(s, n) {
    if (!s) return '';
    if (s.length <= n) return s;
    return s.slice(0, n - 1).trimEnd() + '…';
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
})();
