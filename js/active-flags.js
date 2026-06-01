/* ============================================================
 *  active-flags.js — Stage B 'E' round (E2) · Active Flags rule v2
 *
 *  THE single Active Flags rule, shared by the Home panel (index.html /
 *  js/home.js) and the full-list page (flags.html / js/flags.js) so the two
 *  consumers can never drift. A fund trips the rule when ANY of:
 *    • manager_change != null               (a real manager move), OR
 *    • |aum_change_pct| >= 20               (AUM moved ±20% vs last cycle)
 *
 *  E2 changes vs D7: AUM gate 10% -> 20%; the 1-month return swing was
 *  DROPPED from the panel (it stays in cycle_flags as an informational field
 *  only). aum_change_pct is always-on in the JSON (full precision); the ±20%
 *  threshold lives HERE so there is one source of truth.
 *
 *  Default ordering (compare): manager-change funds first, ranked by current
 *  AUM (desc); then AUM-swing-only funds by AUM %-growth (desc).
 * ============================================================ */
(function () {
  'use strict';

  const RULE = {
    AUM_SWING_PCT: 20,
    MANAGER_CHANGE: true,
  };

  function aumChangePct(cf) { return cf && cf.aum_change_pct != null ? cf.aum_change_pct : null; }
  function aumCurrent(cf)   { return cf && cf.aum_cr_current != null ? cf.aum_cr_current : null; }
  function aumPrior(cf)     { return cf && cf.aum_cr_prior   != null ? cf.aum_cr_prior   : null; }
  function aumChangeCr(cf)  { return cf && cf.aum_change_cr  != null ? cf.aum_change_cr  : null; }

  function _aumTrips(cf) {
    const p = aumChangePct(cf);
    return p != null && Math.abs(p) >= RULE.AUM_SWING_PCT;
  }
  function _mgrTrips(cf) {
    return !!(RULE.MANAGER_CHANGE && cf && cf.manager_change != null);
  }

  /** True when the fund's cycle_flags trip the Active Flags rule. */
  function matches(cf) {
    return _mgrTrips(cf) || _aumTrips(cf);
  }

  /** Severity score for sorting (desc). Manager change dominates, then AUM
   *  magnitude breaks ties. */
  function severity(cf) {
    if (!cf) return 0;
    let s = 0;
    if (_mgrTrips(cf)) s += 1000;
    if (_aumTrips(cf)) s += 100 + Math.min(Math.abs(aumChangePct(cf)), 99);
    return s;
  }

  /** Default ordering used by BOTH consumers: manager-change funds first
   *  (by current AUM desc), then AUM-swing-only funds by AUM %-growth desc. */
  function _curAum(fund, cf) {
    const v = aumCurrent(cf);
    return v != null ? v : (fund && fund.aum_cr != null ? fund.aum_cr : 0);
  }
  function compare(a, b) {
    const ca = a && a.cycle_flags, cb = b && b.cycle_flags;
    const am = _mgrTrips(ca), bm = _mgrTrips(cb);
    if (am !== bm) return am ? -1 : 1;              // manager-change funds first
    if (am && bm) {                                  // both manager: current AUM desc
      return _curAum(b, cb) - _curAum(a, ca);
    }
    // both AUM-swing-only: AUM %-growth desc (biggest positive first)
    const ap = aumChangePct(ca), bp = aumChangePct(cb);
    return (bp == null ? -Infinity : bp) - (ap == null ? -Infinity : ap);
  }

  /** Structured tags for the rule fields (for rendering). */
  function tags(cf) {
    const out = [];
    if (!cf) return out;
    if (_mgrTrips(cf)) {
      out.push({ kind: 'mgr', prior: cf.manager_change.prior, current: cf.manager_change.current });
    }
    if (_aumTrips(cf)) {
      out.push({ kind: 'aum', value: aumChangePct(cf) });
    }
    return out;
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** One tag rendered to HTML (shared by the Home panel + flags.html). */
  function tagHtml(t) {
    if (!t) return '';
    if (t.kind === 'mgr') {
      return `<span class="flag-tag flag-mgr">Manager change · <b>${_esc(t.prior)}</b> → <b>${_esc(t.current)}</b></span>`;
    }
    if (t.kind === 'aum') {
      const neg = t.value < 0;
      return `<span class="flag-tag${neg ? ' neg' : ''}">AUM swing · <b>${neg ? '−' : '+'}${Math.abs(t.value).toFixed(1)}%</b></span>`;
    }
    return '';
  }

  window.ActiveFlags = {
    RULE, matches, severity, compare, tags, tagHtml,
    aumCurrent, aumPrior, aumChangeCr, aumChangePct,
  };
})();
