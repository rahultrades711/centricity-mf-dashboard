/*
 * Centricity MF Screener Dashboard — state.js
 *
 * localStorage helpers for Pattern A (personal customisation, no shared
 * edits). Versioned key namespace: 'centricity.v1.*' so a future migration
 * to v2 can run alongside without overwriting v1 state.
 *
 * Stored shapes (all JSON-serialisable):
 *
 *   centricity.v1.savedViews        : Array<{name, filters, customWeights, createdAt}>
 *   centricity.v1.customWeights     : Object<paramName, weightPct>  (null = use cycle defaults)
 *   centricity.v1.watchlist         : Array<schemeCode>
 *   centricity.v1.savedPortfolios   : Array<{name, constraints, funds, createdAt}>
 *   centricity.v1.preferredFilters  : Object  (default filter chain)
 *   centricity.v1.lastVisitedCycle  : string  ('YYYY-MM-DD')
 *   centricity.v1.dismissedAlerts   : Array<alertId>
 *
 * No PII written. Per Brand Standards public-repo discipline, no fund
 * metadata or partner names ever enter localStorage — only AMFI scheme
 * codes (which are public).
 *
 * Exposes window.AppState.
 */
(function () {
  'use strict';

  const NS = 'centricity.v1.';

  function _get(key, fallback) {
    try {
      const raw = window.localStorage.getItem(NS + key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      // localStorage unavailable (private mode on some browsers) or corrupt JSON
      return fallback;
    }
  }

  function _set(key, value) {
    try {
      window.localStorage.setItem(NS + key, JSON.stringify(value));
      return true;
    } catch (e) {
      // Quota exceeded or storage disabled — silent fail; UI may detect via .saved presence
      console.warn('AppState: failed to persist ' + key, e);
      return false;
    }
  }

  function _remove(key) {
    try { window.localStorage.removeItem(NS + key); return true; }
    catch (e) { return false; }
  }

  /* -------------------------------------------------------- *
   *  Saved views (Screener filter+weight combinations)
   * -------------------------------------------------------- */
  function getSavedViews() {
    return _get('savedViews', []);
  }
  function saveView(name, filters, customWeights) {
    if (!name) return false;
    const views = getSavedViews().filter(v => v.name !== name);
    views.push({
      name: String(name),
      filters: filters || {},
      customWeights: customWeights || null,
      createdAt: new Date().toISOString(),
    });
    return _set('savedViews', views);
  }
  function deleteView(name) {
    return _set('savedViews', getSavedViews().filter(v => v.name !== name));
  }

  /* -------------------------------------------------------- *
   *  Custom weights (Edit-weights drawer)
   *  When null, the UI uses cycle_meta.scoring_weights as defaults.
   * -------------------------------------------------------- */
  function getCustomWeights() {
    return _get('customWeights', null);
  }
  function setCustomWeights(weightsObj) {
    return _set('customWeights', weightsObj);
  }
  function resetWeights() {
    return _remove('customWeights');
  }

  /* -------------------------------------------------------- *
   *  Watchlist
   * -------------------------------------------------------- */
  function getWatchlist() {
    return _get('watchlist', []);
  }
  function addToWatchlist(schemeCode) {
    if (schemeCode == null) return false;
    const code = Number(schemeCode);
    const list = getWatchlist();
    if (list.includes(code)) return true;
    list.push(code);
    return _set('watchlist', list);
  }
  function removeFromWatchlist(schemeCode) {
    if (schemeCode == null) return false;
    const code = Number(schemeCode);
    return _set('watchlist', getWatchlist().filter(c => c !== code));
  }
  function isWatched(schemeCode) {
    if (schemeCode == null) return false;
    const code = Number(schemeCode);
    return getWatchlist().includes(code);
  }

  /* -------------------------------------------------------- *
   *  Saved portfolios (Portfolio Builder output)
   * -------------------------------------------------------- */
  function getSavedPortfolios() {
    return _get('savedPortfolios', []);
  }
  function savePortfolio(name, constraints, funds) {
    if (!name) return false;
    const list = getSavedPortfolios().filter(p => p.name !== name);
    list.push({
      name: String(name),
      constraints: constraints || {},
      funds: funds || [],
      createdAt: new Date().toISOString(),
    });
    return _set('savedPortfolios', list);
  }
  function deletePortfolio(name) {
    return _set('savedPortfolios', getSavedPortfolios().filter(p => p.name !== name));
  }

  /* -------------------------------------------------------- *
   *  Preferred filters (default filter chain for Screener)
   * -------------------------------------------------------- */
  function getPreferredFilters() {
    return _get('preferredFilters', {});
  }
  function setPreferredFilters(filters) {
    return _set('preferredFilters', filters || {});
  }

  /* -------------------------------------------------------- *
   *  Last visited cycle (defaults the date dropdown across screens)
   * -------------------------------------------------------- */
  function getLastVisitedCycle() {
    return _get('lastVisitedCycle', null);
  }
  function setLastVisitedCycle(cycleDate) {
    return _set('lastVisitedCycle', cycleDate || null);
  }

  /* -------------------------------------------------------- *
   *  Dismissed alerts (used by Flags/Alerts panel — v1.1)
   * -------------------------------------------------------- */
  function getDismissedAlerts() {
    return _get('dismissedAlerts', []);
  }
  function dismissAlert(alertId) {
    if (alertId == null) return false;
    const list = getDismissedAlerts();
    if (list.includes(alertId)) return true;
    list.push(alertId);
    return _set('dismissedAlerts', list);
  }
  function clearDismissedAlerts() {
    return _remove('dismissedAlerts');
  }

  /* -------------------------------------------------------- *
   *  Per-page UI persistence — Home Top-10 filter panels
   *
   *  Asset-class panel:
   *    'home.top10_assetclasses' (array<string>; subset of {equity, debt, hybrid})
   *    Default = ['equity', 'debt', 'hybrid'] (all checked) on first load.
   *
   *  SEBI category panel:
   *    'home.top10_categories' (array<string>; subset of cycle.cycle_meta.categories[].name)
   *    Default = whatever the current asset-class selection produces (caller fills in).
   *
   *  Migration from v3 single-string scheme:
   *    Old key 'home.top10_assetclass' (string in {equity, debt, hybrid, combined})
   *    is read once on first call; mapped to the new array; old key deleted.
   * -------------------------------------------------------- */
  const ASSET_CLASS_VALID = new Set(['equity', 'debt', 'hybrid']);

  function _migrateLegacyAssetClass() {
    // Returns { migrated: bool, value: array|null }
    const legacy = _get('home.top10_assetclass', null);
    if (legacy == null) return { migrated: false, value: null };
    let mapped;
    if (legacy === 'combined') {
      mapped = ['equity', 'debt', 'hybrid'];
    } else if (ASSET_CLASS_VALID.has(legacy)) {
      mapped = [legacy];
    } else {
      mapped = ['equity', 'debt', 'hybrid'];
    }
    _set('home.top10_assetclasses', mapped);
    _remove('home.top10_assetclass');
    return { migrated: true, value: mapped };
  }

  function getTop10AssetClasses() {
    let cur = _get('home.top10_assetclasses', null);
    if (cur == null) {
      const m = _migrateLegacyAssetClass();
      cur = m.value;
    }
    if (!Array.isArray(cur)) {
      // Cold-load (no persisted state, no legacy key): NOTHING selected, and
      // do NOT write — localStorage is written only on a user gesture (D6 /
      // Stage A rule). The Top-10 opens on the empty-state CTA.
      return [];
    }
    // Sanitise: keep only valid values and drop 'debt' — Debt is removed from
    // the Top-10 asset-class chooser universe-wide (D6); debt funds live in
    // the separate debt screener, not the scored Top-10.
    return cur.filter(v => ASSET_CLASS_VALID.has(v) && v !== 'debt');
  }

  function setTop10AssetClasses(arr) {
    if (!Array.isArray(arr)) return false;
    const clean = arr.filter(v => ASSET_CLASS_VALID.has(v));
    return _set('home.top10_assetclasses', clean);
  }

  function getTop10Categories() {
    return _get('home.top10_categories', null);  // null = "use defaults"
  }

  function setTop10Categories(arr) {
    if (!Array.isArray(arr)) return false;
    return _set('home.top10_categories', arr);
  }

  /* -------------------------------------------------------- *
   *  Per-page UI persistence — Screener "Add columns" picker
   *  (Cowork 2026-05-06 — Fix-List 2 §D)
   *
   *  'screener.extra_columns' (array<string>): dotted-path keys for
   *  extra columns the analyst has enabled beyond the 11 default
   *  Screener columns. Default = empty (no extras).
   * -------------------------------------------------------- */
  function getScreenerExtraColumns() {
    const v = _get('screener.extra_columns', []);
    return Array.isArray(v) ? v : [];
  }
  function setScreenerExtraColumns(arr) {
    if (!Array.isArray(arr)) return false;
    return _set('screener.extra_columns', arr);
  }

  /* -------------------------------------------------------- *
   *  Reset everything (Settings → "clear my saved views, weights, watchlist")
   * -------------------------------------------------------- */
  function resetAll() {
    [
      'savedViews', 'customWeights', 'watchlist', 'savedPortfolios',
      'preferredFilters', 'lastVisitedCycle', 'dismissedAlerts',
      'home.top10_assetclass',     // legacy single-string
      'home.top10_assetclasses',   // current array
      'home.top10_categories',
      'screener.extra_columns',
    ].forEach(_remove);
    return true;
  }

  window.AppState = {
    // Saved views
    getSavedViews, saveView, deleteView,
    // Weights
    getCustomWeights, setCustomWeights, resetWeights,
    // Watchlist
    getWatchlist, addToWatchlist, removeFromWatchlist, isWatched,
    // Portfolios
    getSavedPortfolios, savePortfolio, deletePortfolio,
    // Filters
    getPreferredFilters, setPreferredFilters,
    // Cycle
    getLastVisitedCycle, setLastVisitedCycle,
    // Alerts
    getDismissedAlerts, dismissAlert, clearDismissedAlerts,
    // Per-page UI — Home Top-10 filters
    getTop10AssetClasses, setTop10AssetClasses,
    getTop10Categories, setTop10Categories,
    // Per-page UI — Screener extra-columns picker
    getScreenerExtraColumns, setScreenerExtraColumns,
    // Reset
    resetAll,
    // Namespace exposed for diagnostics
    _NS: NS,
  };
})();
