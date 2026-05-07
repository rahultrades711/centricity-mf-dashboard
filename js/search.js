/*
 * Centricity MF Screener Dashboard — search.js
 *
 * Wires the global header search bar (every page's `<label class="search">`)
 * to a live, debounced fund lookup against the latest screener cycle JSON.
 *
 * Fields searched (case-insensitive substring, except scheme_code which is
 * a numeric-prefix match):
 *   fund_name · amc · category · manager_name · scheme_code
 *
 * The cycle is lazy-loaded once per session (single-flight) so a page that
 * doesn't otherwise need the screener (overlap.html, watchlist.html stub,
 * alerts.html stub) only fetches it when the user starts typing.
 *
 * Spec ref: Fix-List 12 (search bar) — single shared module included on all
 * 10 production pages. Locked to fund-detail navigation: every result row
 * routes to fund-detail.html?scheme=<AMFI>.
 */
(function () {
  'use strict';

  const DEBOUNCE_MS = 250;
  const MAX_RESULTS = 8;
  const FUND_NAME_TRUNC = 40;

  /* Single shared cycle across every wired input on the page. */
  let _cycle = null;
  let _loadPromise = null;

  async function loadLatestCycle() {
    if (_cycle) return _cycle;
    if (_loadPromise) return _loadPromise;
    if (!window.DataLoader) {
      throw new Error('DataLoader not available — js/data-loader.js missing on this page');
    }
    _loadPromise = (async () => {
      const manifest = await window.DataLoader.listCycles();
      const cycle = await window.DataLoader.loadCycle(manifest.latest);
      _cycle = cycle;
      return cycle;
    })();
    return _loadPromise;
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /**
   * Filter the cycle's funds against a query.
   * Ranking: name-startswith > name-contains > field-match (others).
   * Tiebreak: centricity_score desc, then fund_name asc.
   */
  function search(cycle, query) {
    if (!cycle || !Array.isArray(cycle.funds) || !query) return [];
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const isNumericPrefix = /^\d+$/.test(q);

    const matches = [];
    for (const f of cycle.funds) {
      const name = (f.fund_name || '').toLowerCase();
      const amc  = (f.amc || '').toLowerCase();
      const cat  = (f.category || '').toLowerCase();
      const mgr  = (f.manager_name || '').toLowerCase();
      const code = String(f.scheme_code || '');

      let bucket = -1;
      if (name.startsWith(q))                       bucket = 0;
      else if (name.includes(q))                    bucket = 1;
      else if (amc.includes(q))                     bucket = 2;
      else if (cat.includes(q))                     bucket = 2;
      else if (mgr.includes(q))                     bucket = 2;
      else if (isNumericPrefix && code.startsWith(q)) bucket = 2;

      if (bucket >= 0) matches.push({ f, bucket });
    }

    matches.sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      const as = a.f.centricity_score ?? -1;
      const bs = b.f.centricity_score ?? -1;
      if (as !== bs) return bs - as;
      return (a.f.fund_name || '').localeCompare(b.f.fund_name || '');
    });

    return matches.slice(0, MAX_RESULTS).map(x => x.f);
  }

  function renderResults(dd, results, selectedIdx) {
    if (!results.length) {
      dd.innerHTML = '<div class="search-empty">No funds match.</div>';
      return;
    }
    let html = '';
    for (let i = 0; i < results.length; i++) {
      const f = results[i];
      const score = (f.centricity_score != null && !isNaN(f.centricity_score))
        ? (f.centricity_score * 100).toFixed(1) + '%'
        : '—';
      const name = truncate(f.fund_name || '—', FUND_NAME_TRUNC);
      const cat  = f.category || '';
      const cls  = (i === selectedIdx) ? 'search-row active' : 'search-row';
      html += '<a class="' + cls + '" role="option"'
            +   ' data-scheme="' + escapeHtml(f.scheme_code) + '"'
            +   ' href="fund-detail.html?scheme=' + encodeURIComponent(f.scheme_code) + '">'
            +   '<span class="sr-name">' + escapeHtml(name) + '</span>'
            +   '<span class="sr-cat">' + escapeHtml(cat) + '</span>'
            +   '<span class="sr-score">' + escapeHtml(score) + '</span>'
            + '</a>';
    }
    dd.innerHTML = html;
  }

  function buildDropdown() {
    const dd = document.createElement('div');
    dd.className = 'search-dropdown';
    dd.setAttribute('role', 'listbox');
    dd.hidden = true;
    return dd;
  }

  function wireOne(input) {
    if (!input || input.dataset._searchWired === '1') return;
    input.dataset._searchWired = '1';

    const label = input.closest('label.search');
    if (!label) return;
    if (getComputedStyle(label).position === 'static') {
      label.style.position = 'relative';
    }

    const dd = buildDropdown();
    label.appendChild(dd);

    let debounceTimer = null;
    let currentResults = [];
    let selectedIdx = -1;

    function close() {
      dd.hidden = true;
      selectedIdx = -1;
    }

    function refresh(query) {
      const q = (query || '').trim();
      if (!q) { close(); return; }
      loadLatestCycle().then(cycle => {
        if (input.value.trim() !== q) return;  // stale callback (user kept typing)
        currentResults = search(cycle, q);
        selectedIdx = currentResults.length ? 0 : -1;
        renderResults(dd, currentResults, selectedIdx);
        dd.hidden = false;
      }).catch(err => {
        console.error('[search] cycle load failed', err);
        dd.innerHTML = '<div class="search-empty">Search unavailable — cycle not loaded.</div>';
        dd.hidden = false;
      });
    }

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      const q = input.value;
      debounceTimer = setTimeout(() => refresh(q), DEBOUNCE_MS);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!dd.hidden) {
          close();
          e.preventDefault();
          input.blur();
        }
        return;
      }
      if (dd.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        if (input.value.trim()) {
          refresh(input.value);
          e.preventDefault();
        }
        return;
      }
      if (e.key === 'ArrowDown') {
        if (!currentResults.length) return;
        selectedIdx = (selectedIdx + 1) % currentResults.length;
        renderResults(dd, currentResults, selectedIdx);
        e.preventDefault();
        return;
      }
      if (e.key === 'ArrowUp') {
        if (!currentResults.length) return;
        selectedIdx = (selectedIdx - 1 + currentResults.length) % currentResults.length;
        renderResults(dd, currentResults, selectedIdx);
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') {
        if (selectedIdx >= 0 && currentResults[selectedIdx]) {
          window.location.href = 'fund-detail.html?scheme='
            + encodeURIComponent(currentResults[selectedIdx].scheme_code);
          e.preventDefault();
        }
      }
    });

    input.addEventListener('focus', () => {
      if (input.value.trim()) refresh(input.value);
    });

    /* Hover row → highlight (also covers mouse-driven selection). */
    dd.addEventListener('mouseover', (e) => {
      const row = e.target.closest('.search-row');
      if (!row) return;
      const code = row.dataset.scheme;
      const idx = currentResults.findIndex(r => String(r.scheme_code) === code);
      if (idx >= 0 && idx !== selectedIdx) {
        selectedIdx = idx;
        const rows = dd.querySelectorAll('.search-row');
        rows.forEach((r, i) => r.classList.toggle('active', i === selectedIdx));
      }
    });

    /* Click-outside to close — registered once per input but cheap. */
    document.addEventListener('click', (e) => {
      if (!label.contains(e.target)) close();
    });
  }

  function init() {
    document.querySelectorAll('header.appbar .search input').forEach(wireOne);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
