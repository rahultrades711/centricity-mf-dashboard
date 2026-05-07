/* ============================================================
 *  manager-profiles.js — Manager Profiles page (Fix-List 9 Feature B)
 *
 *  Architecture:
 *    • Reads data/manager-history-YYYY-MM-DD.json (Morningstar — every
 *      manager × every fund, with start / end / is_current / tenure).
 *    • Reads the screener cycle JSON for fund_name / category / aum_cr
 *      metadata — no new contract.
 *    • Reads data/manager-profiles.json (optional) — Feature C scrape
 *      output. Carries bio, experience_years, education, source URL,
 *      photo URL. Page degrades gracefully when the file is missing or
 *      a manager has no entry yet.
 *
 *  URL contract: ?manager=ENCODED_NAME pre-selects a manager on load.
 *  This is the URL the fund-detail page links to from the manager card
 *  and the co-manager strip.
 *
 *  No persistence (Pattern A): selection only lives in the URL hash —
 *  refresh-stable, copy-paste-shareable.
 * ============================================================ */
(function () {
  'use strict';

  let _cycle = null;             // screener cycle JSON
  let _history = null;           // manager-history doc
  let _profiles = {};            // { managerName: {bio, experience_years, ...} }

  // Inverted index built from history: each unique manager name (any
  // is_current OR past) → array of {code, manager_entry, fund_name, etc}
  let _allManagers = [];         // sorted manager-list rows
  let _byName = new Map();       // managerName → {row, currentFunds, prevFunds}
  let _amcs = [];                // sorted unique AMC names
  let _selectedName = null;
  let _filterText = '';
  let _filterAmcs = new Set();
  let _sortBy = 'aum';           // aum / name / tenure / funds

  /* -------------------------------------------------------- *
   *  Bootstrap
   * -------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', () => {
    DataLoader.listCycles()
      .then(manifest => {
        const latest = manifest.latest;
        if (!latest) throw new Error('no cycles in manifest');
        return Promise.all([
          DataLoader.loadCycle(latest),
          _loadManagerHistory(),
          _loadProfiles(),
        ]);
      })
      .then(([cycle, history, profiles]) => {
        _cycle = cycle;
        _history = history;
        _profiles = profiles || {};
        _composeManagers();
        _renderEyebrow();
        _renderAmcFilter();
        _wirePicker();
        _renderManagerList();
        // URL pre-selection
        const sp = new URLSearchParams(window.location.search);
        const fromUrl = sp.get('manager');
        if (fromUrl && _byName.has(fromUrl)) {
          _selectManager(fromUrl);
        } else {
          _showEmpty();
        }
      })
      .catch(err => {
        console.error('[manager-profiles] bootstrap failed', err);
        document.getElementById('mpMain').innerHTML =
          `<p style="padding:48px 32px;color:#666;font-style:italic">
            Could not load the manager-profiles data files
            (${err && err.message ? err.message : 'fetch error'}).
          </p>`;
      });
  });

  /* -------------------------------------------------------- *
   *  Data loaders
   * -------------------------------------------------------- */
  async function _loadManagerHistory() {
    // Same file the fund-detail page reads. v1 ships
    // manager-history-2026-04-30.json; future cycles bump the date.
    const url = 'data/manager-history-2026-04-30.json';
    const res = await fetch(url, { cache: 'default' });
    if (!res.ok) throw new Error('manager-history HTTP ' + res.status);
    return res.json();
  }

  /** Scrape output is optional — Feature C may have produced an empty
   *  shell or never run at all. Resolve to an empty object on 404. */
  async function _loadProfiles() {
    try {
      const res = await fetch('data/manager-profiles.json', { cache: 'default' });
      if (!res.ok) return {};
      const doc = await res.json();
      // Two possible shapes: { managers: {…} } or just {…} keyed by name.
      if (doc && typeof doc === 'object') {
        if (doc.managers && typeof doc.managers === 'object') return doc.managers;
        return doc;
      }
      return {};
    } catch (e) {
      return {};
    }
  }

  /* -------------------------------------------------------- *
   *  Compose
   * -------------------------------------------------------- */
  function _composeManagers() {
    // Per-manager rollups: which funds they ran, AMC fingerprint, total AUM
    // managed today, longest tenure.
    const screenerByCode = new Map(
      (_cycle.funds || []).map(f => [String(f.scheme_code), f])
    );
    const byName = new Map();

    for (const code in _history.funds) {
      const entry = _history.funds[code];
      if (!entry || !entry.managers) continue;
      const screenerFund = screenerByCode.get(String(code));
      // Skip funds we don't have screener metadata for (typically
      // analytics-only funds — out of universe for v1)
      if (!screenerFund) continue;
      for (const m of entry.managers) {
        if (!m.name) continue;
        let row = byName.get(m.name);
        if (!row) {
          row = {
            name: m.name,
            currentFunds: [],   // [{code, fund, manager_entry}]
            prevFunds: [],      // same shape
            amcs: new Set(),
          };
          byName.set(m.name, row);
        }
        const item = { code, fund: screenerFund, m };
        if (m.is_current) {
          row.currentFunds.push(item);
          if (screenerFund.amc) row.amcs.add(screenerFund.amc);
        } else {
          row.prevFunds.push(item);
        }
      }
    }

    // Drop managers with NO current funds (purely historical names from
    // funds whose lineup has churned). Keep them on prevFunds for the
    // selected-manager view, but don't surface them in the list.
    _allManagers = [];
    for (const [name, row] of byName.entries()) {
      if (row.currentFunds.length === 0) {
        // Still index them so URL ?manager=Name from a co-manager link
        // can find them — but they won't be in the visible list.
        _byName.set(name, _enrichRow(row));
        continue;
      }
      _byName.set(name, _enrichRow(row));
      _allManagers.push(_byName.get(name));
    }

    _amcs = Array.from(
      new Set(_allManagers.flatMap(r => Array.from(r.amcs)))
    ).sort();
  }

  function _enrichRow(row) {
    const aum = row.currentFunds.reduce(
      (s, x) => s + (Number(x.fund && x.fund.aum_cr) || 0), 0
    );
    const longestTenure = row.currentFunds.reduce(
      (mx, x) => Math.max(mx, Number(x.m.tenure_years) || 0), 0
    );
    const primaryAmc = row.currentFunds.length > 0
      ? (row.currentFunds[0].fund.amc || '—')
      : '—';
    return {
      ...row,
      aum,
      longestTenure,
      primaryAmc,
      currentCount: row.currentFunds.length,
      prevCount: row.prevFunds.length,
    };
  }

  /* -------------------------------------------------------- *
   *  Eyebrow
   * -------------------------------------------------------- */
  function _renderEyebrow() {
    const el = document.getElementById('mpEyebrow');
    const dateStr = _history.as_of_date ? DataLoader.fmtDate(_history.as_of_date) : '—';
    el.textContent = `Manager Profiles · Morningstar records as of ${dateStr}`;
    document.getElementById('footUpdated').textContent = `Last updated · ${dateStr}`;
  }

  /* -------------------------------------------------------- *
   *  Picker
   * -------------------------------------------------------- */
  function _renderAmcFilter() {
    const panel = document.getElementById('mpAmcPanel');
    panel.innerHTML = _amcs.map(a => `
      <label>
        <input type="checkbox" data-amc="${escapeHtml(a)}">
        ${escapeHtml(a)}
      </label>`).join('');
    panel.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        const amc = cb.getAttribute('data-amc');
        if (cb.checked) _filterAmcs.add(amc);
        else _filterAmcs.delete(amc);
        _updateAmcBtnLabel();
        _renderManagerList();
      });
    });
  }
  function _updateAmcBtnLabel() {
    const btn = document.getElementById('mpAmcBtn');
    if (_filterAmcs.size === 0)        btn.firstChild.nodeValue = 'All AMCs ';
    else if (_filterAmcs.size === 1)   btn.firstChild.nodeValue = `${[..._filterAmcs][0]} `;
    else                               btn.firstChild.nodeValue = `${_filterAmcs.size} AMCs `;
  }

  function _wirePicker() {
    const search = document.getElementById('mpSearch');
    search.addEventListener('input', () => {
      _filterText = search.value.trim().toLowerCase();
      _renderManagerList();
    });
    const amcBtn = document.getElementById('mpAmcBtn');
    const amcPanel = document.getElementById('mpAmcPanel');
    amcBtn.addEventListener('click', () => { amcPanel.hidden = !amcPanel.hidden; });
    document.addEventListener('click', (e) => {
      if (!amcBtn.contains(e.target) && !amcPanel.contains(e.target)) amcPanel.hidden = true;
    });
    document.getElementById('mpSortBy').addEventListener('change', (e) => {
      _sortBy = e.target.value;
      _renderManagerList();
    });
  }

  function _filteredManagers() {
    return _allManagers.filter(r => {
      if (_filterText) {
        const hay = (r.name + ' ' + r.primaryAmc).toLowerCase();
        if (!hay.includes(_filterText)) return false;
      }
      if (_filterAmcs.size > 0) {
        let hit = false;
        for (const a of r.amcs) if (_filterAmcs.has(a)) { hit = true; break; }
        if (!hit) return false;
      }
      return true;
    });
  }

  function _sortedManagers(rows) {
    const sorted = rows.slice();
    if (_sortBy === 'name') {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (_sortBy === 'tenure') {
      sorted.sort((a, b) => b.longestTenure - a.longestTenure);
    } else if (_sortBy === 'funds') {
      sorted.sort((a, b) => b.currentCount - a.currentCount || a.name.localeCompare(b.name));
    } else {
      // aum (default)
      sorted.sort((a, b) => b.aum - a.aum);
    }
    return sorted;
  }

  function _renderManagerList() {
    const list = document.getElementById('mpManagerList');
    const counter = document.getElementById('mpPickerCounter');
    const visible = _sortedManagers(_filteredManagers());
    counter.textContent = String(visible.length);
    if (visible.length === 0) {
      list.innerHTML = `<p class="picker-pending">No managers match the current filters.</p>`;
      return;
    }
    list.innerHTML = visible.map(r => `
      <div class="mp-row${r.name === _selectedName ? ' selected' : ''}"
           data-name="${escapeHtml(r.name)}">
        <div class="pr-name">
          <b>${escapeHtml(r.name)}</b>
          <span class="pr-count">${r.currentCount} fund${r.currentCount === 1 ? '' : 's'}</span>
        </div>
        <span class="pr-amc">${escapeHtml(r.primaryAmc)}${r.aum > 0 ? ' · ₹ ' + DataLoader.fmtINR(r.aum) + ' Cr' : ''}</span>
      </div>`).join('');
    list.querySelectorAll('.mp-row').forEach(el => {
      el.addEventListener('click', () => {
        const name = el.getAttribute('data-name');
        _selectManager(name);
      });
    });
  }

  /* -------------------------------------------------------- *
   *  Card render
   * -------------------------------------------------------- */
  function _showEmpty() {
    document.getElementById('mpCardEmpty').style.display = '';
    document.getElementById('mpCard').hidden = true;
  }

  function _selectManager(name) {
    if (!_byName.has(name)) {
      _showEmpty();
      return;
    }
    _selectedName = name;
    document.getElementById('mpCardEmpty').style.display = 'none';
    document.getElementById('mpCard').hidden = false;
    _renderManagerList();    // re-render to update .selected highlight
    _renderCard(_byName.get(name));
    // Mirror to URL so the card is shareable
    const url = new URL(window.location.href);
    url.searchParams.set('manager', name);
    history.replaceState(null, '', url);
  }

  function _renderCard(row) {
    document.getElementById('mpAvatar').textContent = _initials(row.name);
    document.getElementById('mpName').textContent = row.name;
    document.getElementById('mpAmc').textContent = row.primaryAmc;

    const profile = _profiles[row.name] || _findProfileFuzzy(row.name) || {};

    const expEl = document.getElementById('mpExperience');
    expEl.textContent = profile.experience_years
      ? `Experience: ${profile.experience_years} years`
      : '';

    const sourceEl = document.getElementById('mpSource');
    if (profile.source_url) {
      sourceEl.innerHTML =
        `Source: <a href="${escapeHtml(profile.source_url)}" target="_blank" rel="noopener">${escapeHtml(profile.source_name || 'View')}</a>`;
    } else {
      sourceEl.innerHTML = `<span style="opacity:.6">Source: scrape pending</span>`;
    }

    const bioEl = document.getElementById('mpBio');
    if (profile.bio) {
      bioEl.hidden = false;
      bioEl.textContent = profile.bio;
    } else {
      bioEl.hidden = true;
      bioEl.textContent = '';
    }

    document.getElementById('mpStatCurrent').textContent = String(row.currentCount);
    document.getElementById('mpStatAum').textContent =
      row.aum > 0 ? `₹ ${DataLoader.fmtINR(row.aum)} Cr` : '—';
    document.getElementById('mpStatTenure').textContent = _formatTenureYM(row.longestTenure);
    document.getElementById('mpStatPrev').textContent = String(row.prevCount);

    document.getElementById('mpCurrentMount').innerHTML = _renderFundsTable(row.currentFunds, true);
    document.getElementById('mpPrevMount').innerHTML = _renderFundsTable(row.prevFunds, false);

    const dateStr = _history.as_of_date ? DataLoader.fmtDate(_history.as_of_date) : '—';
    document.getElementById('mpFoot').textContent =
      `Manager records sourced from Morningstar as of ${dateStr}. ` +
      `Bio + source URL where available are scraped from public AMC / VRO pages by ` +
      `scripts/scrape_manager_profiles.py.`;
  }

  function _renderFundsTable(items, isCurrent) {
    if (items.length === 0) {
      return `
        <table class="mp-funds">
          <tbody><tr class="mp-empty-row"><td>—</td></tr></tbody>
        </table>`;
    }
    const sorted = items.slice().sort((a, b) =>
      // Current: AUM desc; Previous: end-date desc
      isCurrent
        ? (Number(b.fund.aum_cr) || 0) - (Number(a.fund.aum_cr) || 0)
        : (b.m.end || '').localeCompare(a.m.end || '')
    );
    const headers = isCurrent
      ? `<tr><th>Fund</th><th>Category</th><th class="num">AUM ₹ Cr</th><th>Since</th><th class="num">Tenure</th></tr>`
      : `<tr><th>Fund</th><th>Category</th><th>Period</th><th class="num">Tenure</th></tr>`;
    const rows = sorted.map(it => {
      const f = it.fund || {};
      const m = it.m;
      const href = `fund-detail.html?scheme=${encodeURIComponent(it.code)}`;
      const fundCell = `<a class="fund-link" href="${href}">${escapeHtml(f.fund_name || `Scheme ${it.code}`)}</a>`;
      const catCell = escapeHtml(f.category || '—');
      const tenureCell = _formatTenureYM(m.tenure_years);
      if (isCurrent) {
        const aumCell = f.aum_cr != null ? `₹ ${DataLoader.fmtINR(f.aum_cr)}` : '—';
        const sinceCell = _formatShortDate(m.start);
        return `<tr><td>${fundCell}</td><td>${catCell}</td><td class="num">${aumCell}</td><td>${escapeHtml(sinceCell)}</td><td class="num">${escapeHtml(tenureCell)}</td></tr>`;
      } else {
        const periodCell = `${_formatShortDate(m.start)} – ${m.end ? _formatShortDate(m.end) : 'Present'}`;
        return `<tr><td>${fundCell}</td><td>${catCell}</td><td>${escapeHtml(periodCell)}</td><td class="num">${escapeHtml(tenureCell)}</td></tr>`;
      }
    }).join('');
    return `
      <table class="mp-funds">
        <thead>${headers}</thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /* -------------------------------------------------------- *
   *  Helpers
   * -------------------------------------------------------- */
  function _initials(name) {
    if (!name) return '—';
    const cleaned = String(name).replace(/[^A-Za-z\s]/g, '').trim();
    if (!cleaned) return '—';
    const parts = cleaned.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
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

  function _formatShortDate(iso) {
    if (!iso) return '—';
    const [y, m] = iso.split('-').map(Number);
    if (!y || !m) return iso;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[m - 1]} ${y}`;
  }

  /** Loose name match for the scrape file — handles "Mr." prefixes, dots,
   *  middle initials. Returns the matched profile dict or null. */
  function _findProfileFuzzy(name) {
    const target = _normalizeName(name);
    for (const k in _profiles) {
      if (_normalizeName(k) === target) return _profiles[k];
    }
    return null;
  }
  function _normalizeName(s) {
    return String(s)
      .toLowerCase()
      .replace(/\b(mr|mrs|ms|dr|prof)\.?\b/g, '')
      .replace(/[^a-z\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
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
