/* ============================================================
 *  active-flags.js — Stage B Partner-Review D7
 *
 *  THE single Active Flags rule, shared by the Home panel (index.html /
 *  js/home.js) and the full-list page (flags.html / js/flags.js) so the two
 *  consumers can never drift. A fund trips the rule when ANY of:
 *    • manager_change != null              (a real manager move)
 *    • |return_1m_swing_pct| >= 10         (1-month return swing, pp)
 *    • |aum_swing_pct|        >= 10         (AUM swing, %)
 *  return_1y / rank_change / status_change stay in cycle_flags for the
 *  What-Changed cards but are NOT part of this panel rule.
 *
 *  Severity order (kickoff): manager_change > AUM swing > 1-month return swing.
 * ============================================================ */
(function () {
  'use strict';

  const RULE = {
    AUM_SWING_PCT: 10,
    RETURN_1M_SWING_PCT: 10,
    MANAGER_CHANGE: true,
  };

  function _aumTrips(cf) {
    return cf && cf.aum_swing_pct != null && Math.abs(cf.aum_swing_pct) >= RULE.AUM_SWING_PCT;
  }
  function _r1mTrips(cf) {
    return cf && cf.return_1m_swing_pct != null && Math.abs(cf.return_1m_swing_pct) >= RULE.RETURN_1M_SWING_PCT;
  }
  function _mgrTrips(cf) {
    return !!(RULE.MANAGER_CHANGE && cf && cf.manager_change != null);
  }

  /** True when the fund's cycle_flags trip the Active Flags rule. */
  function matches(cf) {
    return _mgrTrips(cf) || _r1mTrips(cf) || _aumTrips(cf);
  }

  /** Severity score for sorting (desc). Manager change dominates, then AUM,
   *  then 1-month return; magnitude breaks ties within a tier. */
  function severity(cf) {
    if (!cf) return 0;
    let s = 0;
    if (_mgrTrips(cf)) s += 1000;
    if (_aumTrips(cf)) s += 100 + Math.min(Math.abs(cf.aum_swing_pct), 99);
    if (_r1mTrips(cf)) s += 1 + Math.min(Math.abs(cf.return_1m_swing_pct), 99) / 100;
    return s;
  }

  /** Structured tags for the three rule fields (for rendering). */
  function tags(cf) {
    const out = [];
    if (!cf) return out;
    if (_mgrTrips(cf)) {
      out.push({ kind: 'mgr', prior: cf.manager_change.prior, current: cf.manager_change.current });
    }
    if (_aumTrips(cf)) {
      out.push({ kind: 'aum', value: cf.aum_swing_pct });
    }
    if (_r1mTrips(cf)) {
      out.push({ kind: 'r1m', value: cf.return_1m_swing_pct });
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
    if (t.kind === 'r1m') {
      const neg = t.value < 0;
      return `<span class="flag-tag${neg ? ' neg' : ''}">1M return swing · <b>${neg ? '−' : '+'}${Math.abs(t.value).toFixed(2)}pp</b></span>`;
    }
    return '';
  }

  window.ActiveFlags = { RULE, matches, severity, tags, tagHtml };
})();
