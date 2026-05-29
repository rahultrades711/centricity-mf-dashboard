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
  let _profiles = {};            // { managerName: {main_managed, co_managed, ...} }
  let _aliases = {};             // { alt-spelling: canonical } from manager-profiles.json

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
    Cycle.getActiveCycle()
      .then(activeDate => {
        if (!activeDate) throw new Error('no cycles in manifest');
        return Promise.all([
          DataLoader.loadCycle(activeDate),
          _loadManagerHistory(),
          _loadProfiles(),
        ]);
      })
      .then(([cycle, history, profiles]) => {
        _cycle = cycle;
        _history = history;
        const pdoc = profiles || {};
        _profiles = (pdoc.managers && typeof pdoc.managers === 'object') ? pdoc.managers : pdoc;
        _aliases = (pdoc.aliases && typeof pdoc.aliases === 'object') ? pdoc.aliases : {};
        _composeManagers();
        _renderEyebrow();
        initCyclePicker(cycle);   // Stage B B2 — Stage A cycle dropdown wiring
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
      // Return the WHOLE doc; the bootstrap splits managers + aliases.
      return (doc && typeof doc === 'object') ? doc : {};
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
    //
    // Cowork patch 2026-05-28 — profiles are keyed by the SCREENER's Monitor
    // spelling (A1 canonical) whenever a Morningstar entry can be matched to
    // a Monitor co-manager on the same fund (exact-name first, then surname).
    // This matches the rebuilt data/manager-profiles.json keying so the
    // URL `?manager=` param works for both the Monitor lead spelling and any
    // Morningstar long-form. Falls back to Morningstar's own spelling only
    // when no Monitor canon can be inferred (rare — fully historical names).
    const screenerByCode = new Map(
      (_cycle.funds || []).map(f => [String(f.scheme_code), f])
    );
    const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase().replace(/\s+/g, " "));
    const surname = (s) => {
      if (s == null) return "";
      const parts = String(s).trim().split(/\s+/);
      return parts.length ? parts[parts.length - 1].toLowerCase() : "";
    };

    // Universe-wide Monitor name pools for past-manager fold-in
    const monitorByNorm = new Map();      // norm -> canonical Monitor spelling
    const monitorBySurname = new Map();   // surname -> canonical Monitor spelling
    for (const f of (_cycle.funds || [])) {
      for (const nm of (f.manager_co_managers || [])) {
        if (!nm) continue;
        const k = norm(nm);
        if (!monitorByNorm.has(k)) monitorByNorm.set(k, nm);
        const sk = surname(nm);
        if (sk && !monitorBySurname.has(sk)) monitorBySurname.set(sk, nm);
      }
    }

    const byName = new Map();
    const akaSeen = new Map();   // alt-spelling -> canonical
    const _ensure = (canonical) => {
      let row = byName.get(canonical);
      if (!row) {
        row = {
          name: canonical,
          currentFunds: [],
          prevFunds: [],
          amcs: new Set(),
          aka: new Set(),
        };
        byName.set(canonical, row);
      }
      return row;
    };

    for (const code in _history.funds) {
      const entry = _history.funds[code];
      if (!entry || !entry.managers) continue;
      const screenerFund = screenerByCode.get(String(code));
      if (!screenerFund) continue;
      const cos = Array.isArray(screenerFund.manager_co_managers)
        ? screenerFund.manager_co_managers : [];
      const coByNorm = new Map(cos.filter(Boolean).map(n => [norm(n), n]));
      const coBySurname = new Map();
      for (const n of cos) {
        const sk = surname(n);
        if (sk && !coBySurname.has(sk)) coBySurname.set(sk, n);
      }

      for (const m of entry.managers) {
        if (!m.name) continue;
        const msNorm = norm(m.name);
        const msSurname = surname(m.name);
        const isCurrent = m.is_current === true || m.end == null;

        // Resolve canonical (Monitor) spelling. Same priority as the data-
        // layer builder: exact → surname → universe fold-in → Morningstar.
        let canonical = m.name;
        let inCoManagers = false;
        if (coByNorm.has(msNorm)) {
          canonical = coByNorm.get(msNorm);
          inCoManagers = true;
        } else if (isCurrent && msSurname && coBySurname.has(msSurname)) {
          canonical = coBySurname.get(msSurname);
          inCoManagers = true;
        } else if (monitorByNorm.has(msNorm)) {
          canonical = monitorByNorm.get(msNorm);
        } else if (!isCurrent && msSurname && monitorBySurname.has(msSurname)) {
          canonical = monitorBySurname.get(msSurname);
        }

        if (m.name !== canonical) {
          akaSeen.set(m.name, canonical);
        }

        const row = _ensure(canonical);
        if (m.name !== canonical) row.aka.add(m.name);
        const item = { code, fund: screenerFund, m };

        if (isCurrent && inCoManagers) {
          row.currentFunds.push(item);
          if (screenerFund.amc) row.amcs.add(screenerFund.amc);
        } else if (!isCurrent) {
          row.prevFunds.push(item);
        }
        // else: Morningstar-current but no Monitor co-manager match on this
        // fund → ambiguous / stale, skipped per kickoff rule.
      }

      // Cowork patch — Monitor leads on this fund that have NO matching
      // Morningstar entry get an entry with empty tenure data so the click
      // through still resolves. Typical case: brand-new launches where the
      // Monitor sheet has the manager but Morningstar's bi-monthly export
      // hasn't yet caught up.
      const msNormsOnFund = new Set(
        entry.managers.filter(m => m.name).map(m => norm(m.name))
      );
      const msSurnamesOnFund = new Set(
        entry.managers.filter(m => m.name).map(m => surname(m.name)).filter(Boolean)
      );
      for (const mn of cos) {
        if (!mn) continue;
        const mnNorm = norm(mn);
        const mnSurname = surname(mn);
        if (msNormsOnFund.has(mnNorm)) continue;
        if (mnSurname && msSurnamesOnFund.has(mnSurname)) continue;
        const row = _ensure(mn);
        row.currentFunds.push({
          code,
          fund: screenerFund,
          m: { name: mn, start: null, end: null, is_current: true, tenure_years: null },
        });
        if (screenerFund.amc) row.amcs.add(screenerFund.amc);
      }
    }

    _allManagers = [];
    for (const [name, row] of byName.entries()) {
      _byName.set(name, _enrichRow(row));
      if (row.currentFunds.length > 0) {
        _allManagers.push(_byName.get(name));
      }
    }
    // Add alias entries so `?manager=<Morningstar long-form>` ALSO resolves to
    // the Monitor-canonical row. This is the flat lookup table Cowork asked
    // for; it keeps `_byName.has(fromUrl)` a one-liner in `_selectManager`.
    for (const [alt, canon] of akaSeen.entries()) {
      if (!_byName.has(alt) && _byName.has(canon)) {
        _byName.set(alt, _byName.get(canon));
      }
    }
    // Also fold in the data-layer aliases map (manager-profiles.json) so
    // override-only spellings resolve too — e.g. "Sharmila D'Mello" -> the
    // "Sharmila D'Silva" profile (D3). No regression: the akaSeen pass above
    // already covers the 6f448d1 Morningstar long-forms.
    for (const alt in _aliases) {
      const canon = _aliases[alt];
      if (!_byName.has(alt) && _byName.has(canon)) {
        _byName.set(alt, _byName.get(canon));
      }
    }

    _amcs = Array.from(
      new Set(_allManagers.flatMap(r => Array.from(r.amcs)))
    ).sort();
  }

  function _enrichRow(row) {
    const recomputeAum = row.currentFunds.reduce(
      (s, x) => s + (Number(x.fund && x.fund.aum_cr) || 0), 0
    );
    const longestTenure = row.currentFunds.reduce(
      (mx, x) => Math.max(mx, Number(x.m.tenure_years) || 0), 0
    );
    const primaryAmc = row.currentFunds.length > 0
      ? (row.currentFunds[0].fund.amc || '—')
      : '—';
    // Prefer the rebuilt profile's counts/AUM so the picker matches the card
    // (and respects any D3 override prune). Falls back to the recompute.
    const prof = (_profiles && _profiles[row.name]) || null;
    return {
      ...row,
      aum: prof ? (Number(prof.total_aum_cr) || recomputeAum) : recomputeAum,
      longestTenure,
      primaryAmc,
      currentCount: prof
        ? ((prof.main_count || 0) + (prof.co_count || 0))
        : row.currentFunds.length,
      prevCount: prof ? (prof.previously_count || 0) : row.prevFunds.length,
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

    // ---- D5: two AUM pills (Total = Main + Co; Main = lead-only) ----
    const totalAum = Number(profile.total_aum_cr) || 0;
    const mainAum = Number(profile.main_aum_cr) || 0;
    document.getElementById('mpStatTotalAum').textContent =
      totalAum > 0 ? `₹ ${DataLoader.fmtINR(totalAum)} Cr` : '—';
    document.getElementById('mpStatMainAum').textContent = `₹ ${DataLoader.fmtINR(mainAum)} Cr`;
    document.getElementById('mpStatTenure').textContent = _formatTenureYM(row.longestTenure);

    // ---- D5: three sections (Main / Co / Previously), each sorted by AUM ----
    const mainFunds = profile.main_managed || [];
    const coFunds = profile.co_managed || [];
    const prevFunds = profile.previously_managed || [];
    document.getElementById('mpMainCount').textContent = String(mainFunds.length);
    document.getElementById('mpCoCount').textContent = String(coFunds.length);
    document.getElementById('mpPrevCount').textContent = String(prevFunds.length);
    document.getElementById('mpMainMount').innerHTML = _renderProfileFunds(mainFunds, 'current');
    document.getElementById('mpCoMount').innerHTML = _renderProfileFunds(coFunds, 'current');
    document.getElementById('mpPrevMount').innerHTML = _renderProfileFunds(prevFunds, 'previous');

    // ---- D5: off-universe overseas funds (name + AUM only) — e.g. D'Silva ----
    const off = profile.off_universe_overseas || [];
    const offWrap = document.getElementById('mpOffUniverseWrap');
    if (offWrap) {
      if (off.length > 0) {
        offWrap.hidden = false;
        document.getElementById('mpOffCount').textContent = String(off.length);
        document.getElementById('mpOffUniverseMount').innerHTML = _renderOffUniverse(off);
      } else {
        offWrap.hidden = true;
      }
    }

    const dateStr = _history.as_of_date ? DataLoader.fmtDate(_history.as_of_date) : '—';
    let footMsg =
      `Main = lead manager (MF Monitor "Fund Manager"); Co = co-manager. ` +
      `Tenure + previous-fund history from Morningstar as of ${dateStr}.`;
    if (profile._needs_partner_prune) {
      footMsg += ` Co-managed list reflects the Morningstar attribution and awaits ` +
        `partner confirmation of the current book.`;
    }
    document.getElementById('mpFoot').textContent = footMsg;
  }

  /** D5 — render a funds table from the rebuilt manager-profiles schema
   *  (entries: {amfi, scheme_name, category, since|started, ended, tenure_yrs,
   *  aum_cr}). `kind` ∈ {'current','previous'}. Rows link to the one-pager
   *  carrying the active cycle so cross-cycle navigation stays in-cycle. */
  function _renderProfileFunds(items, kind) {
    if (!items || items.length === 0) {
      return `<table class="mp-funds"><tbody><tr class="mp-empty-row"><td>—</td></tr></tbody></table>`;
    }
    const isCurrent = kind === 'current';
    const cycleDate = (_cycle && _cycle.cycle_meta && _cycle.cycle_meta.cycle_date) || '';
    const headers = isCurrent
      ? `<tr><th>Fund</th><th>Category</th><th class="num">AUM ₹ Cr</th><th>Since</th><th class="num">Tenure</th></tr>`
      : `<tr><th>Fund</th><th>Category</th><th>Period</th><th class="num">Tenure</th></tr>`;
    const rows = items.map(it => {
      const href = `fund-detail.html?scheme=${encodeURIComponent(it.amfi)}`
        + (cycleDate ? `&cycle=${encodeURIComponent(cycleDate)}` : '');
      const fundCell = `<a class="fund-link" href="${href}">${escapeHtml(it.scheme_name || `Scheme ${it.amfi}`)}</a>`;
      const catCell = escapeHtml(it.category || '—');
      const tenureCell = escapeHtml(_formatTenureYM(it.tenure_yrs));
      if (isCurrent) {
        const aumCell = it.aum_cr != null ? `₹ ${DataLoader.fmtINR(it.aum_cr)}` : '—';
        const sinceCell = escapeHtml(_formatShortDate(it.since));
        return `<tr><td>${fundCell}</td><td>${catCell}</td><td class="num">${aumCell}</td><td>${sinceCell}</td><td class="num">${tenureCell}</td></tr>`;
      }
      const periodCell = `${_formatShortDate(it.started)} – ${it.ended ? _formatShortDate(it.ended) : 'Present'}`;
      return `<tr><td>${fundCell}</td><td>${catCell}</td><td>${escapeHtml(periodCell)}</td><td class="num">${tenureCell}</td></tr>`;
    }).join('');
    return `<table class="mp-funds"><thead>${headers}</thead><tbody>${rows}</tbody></table>`;
  }

  /** D5 — off-universe overseas funds: name + AUM only (no link; they're not
   *  in the screener universe). Used for ICICI's dedicated overseas FM. */
  function _renderOffUniverse(items) {
    const rows = items.map(it => {
      const role = it.role === 'lead' ? '<span class="mp-off-role">lead</span>' : '';
      const aumCell = it.aum_cr != null ? `₹ ${DataLoader.fmtINR(it.aum_cr)}` : '—';
      return `<tr><td>${escapeHtml(it.scheme_name || '—')} ${role}</td><td class="num">${aumCell}</td></tr>`;
    }).join('');
    return `<table class="mp-funds"><thead><tr><th>Fund (overseas, outside this universe)</th><th class="num">AUM ₹ Cr</th></tr></thead><tbody>${rows}</tbody></table>`;
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

  /* ============================================================
   * Stage B B2 — Cycle picker (mirror of fund-detail/compare)
   * ============================================================ */
  function initCyclePicker(cycle) {
    const sel = document.getElementById('mpCycleSel');
    if (!sel) return;
    const cur = (cycle && cycle.cycle_meta) ? cycle.cycle_meta.cycle_date : null;
    Cycle.getCycles().then(cycles => {
      sel.innerHTML = '';
      cycles.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).forEach(c => {
        const o = document.createElement('option');
        o.value = c.date;
        o.textContent = DataLoader.fmtCycleLabelDate(c.date);
        if (c.date === cur) o.selected = true;
        sel.appendChild(o);
      });
    });
    sel.addEventListener('change', onCycleChange);
  }

  async function onCycleChange(e) {
    const newDate = e.target.value;
    try {
      await Cycle.setActiveCycle(newDate);
    } catch (err) {
      console.warn('[manager-profiles] cycle change failed', err);
      return;
    }
    // Drop ?cycle= so localStorage drives the reloaded page; preserve every
    // other param (?manager= in particular must survive).
    const url = new URL(window.location);
    url.searchParams.delete('cycle');
    window.location.replace(url.toString());
  }
})();
