/*
 * Centricity MF Screener Dashboard — cycle.js
 *
 * Central resolver for the "which cycle is the user looking at?" question.
 * Every page that loads a cycle JSON reads through this module instead of
 * duplicating the lookup. Exposes window.Cycle.
 *
 * Resolution priority (highest first):
 *   1. URL query param ?cycle=YYYY-MM-DD
 *   2. localStorage[centricity.activeCycle]
 *   3. manifest.latest
 *
 * All three are validated against manifest.cycles[].date — anything not in
 * that list silently falls through to the next priority. A bogus
 * ?cycle=2026-12-31 therefore renders the latest cycle, never a broken page.
 *
 * The localStorage key is the BARE `centricity.activeCycle` — outside the
 * `centricity.v1.*` AppState namespace. This is intentional: it gives a
 * clean break from the prior `lastVisitedCycle` semantics, which wrote on
 * every page load (the bug — returning users got stuck on whatever cycle
 * they last saw, even after a newer cycle shipped). Here we ONLY write on
 * an explicit `Cycle.setActiveCycle(date)` call — never on auto-resolve.
 *
 * Manifest fetch is memoised (one fetch per page session).
 */
(function () {
  'use strict';

  const LS_KEY = 'centricity.activeCycle';

  /** @type {Promise<object>|null}  cached manifest fetch */
  let _manifestPromise = null;

  function _getQueryCycle() {
    try {
      const params = new URLSearchParams(window.location.search);
      return params.get('cycle');
    } catch (e) {
      return null;
    }
  }

  function _readLocalStorage() {
    try {
      return window.localStorage.getItem(LS_KEY);
    } catch (e) {
      return null;
    }
  }

  function _writeLocalStorage(date) {
    try {
      window.localStorage.setItem(LS_KEY, date);
      return true;
    } catch (e) {
      console.warn('Cycle: failed to persist activeCycle', e);
      return false;
    }
  }

  function _isValid(manifest, date) {
    if (!date || !manifest || !Array.isArray(manifest.cycles)) return false;
    return manifest.cycles.some(c => c.date === date);
  }

  async function _getManifest() {
    if (_manifestPromise) {
      try {
        return await _manifestPromise;
      } catch (e) {
        _manifestPromise = null;  // allow retry on next call
        throw e;
      }
    }
    if (!window.DataLoader || typeof window.DataLoader.listCycles !== 'function') {
      throw new Error('Cycle: DataLoader.listCycles unavailable — load data-loader.js first');
    }
    _manifestPromise = window.DataLoader.listCycles();
    return _manifestPromise;
  }

  /**
   * Resolve the active cycle date for this page.
   * Async because the manifest may not be loaded yet.
   * @returns {Promise<string>}  'YYYY-MM-DD'
   */
  async function getActiveCycle() {
    const manifest = await _getManifest();
    const fromQuery = _getQueryCycle();
    if (_isValid(manifest, fromQuery)) return fromQuery;
    const fromStorage = _readLocalStorage();
    if (_isValid(manifest, fromStorage)) return fromStorage;
    return manifest.latest || (manifest.cycles[0] && manifest.cycles[0].date) || null;
  }

  /**
   * Persist the user's deliberate cycle choice. Throws on invalid date.
   * Callers should only call this on an explicit user gesture (dropdown
   * change), NEVER on auto-resolution — otherwise the "default to latest"
   * behaviour stops working when a newer cycle ships.
   *
   * @param {string} date 'YYYY-MM-DD'
   * @returns {Promise<string>}  the persisted date
   */
  async function setActiveCycle(date) {
    const manifest = await _getManifest();
    if (!_isValid(manifest, date)) {
      throw new Error('Cycle.setActiveCycle: invalid cycle ' + date);
    }
    _writeLocalStorage(date);
    return date;
  }

  /**
   * Return the manifest's cycles array (defensive copy).
   * @returns {Promise<Array<{date:string,label:string,label_date:string,schema_version:string}>>}
   */
  async function getCycles() {
    const manifest = await _getManifest();
    return Array.isArray(manifest.cycles) ? manifest.cycles.slice() : [];
  }

  /**
   * Return the full manifest object. Use sparingly — most callers want
   * getActiveCycle() / getCycles().
   * @returns {Promise<object>}
   */
  async function getManifest() {
    return _getManifest();
  }

  window.Cycle = {
    getActiveCycle,
    setActiveCycle,
    getCycles,
    getManifest,
    _LS_KEY: LS_KEY,
  };
})();
