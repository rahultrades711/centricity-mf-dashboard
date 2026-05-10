/*
 * Centricity MF Screener Dashboard — transitions.js
 *
 * Companion to css/transitions.css. Adds .cx-reveal to common section
 * selectors with a staggered animation-delay so the CSS animation in §2
 * of transitions.css plays once on entry. Animation-based (not
 * transition-based) so it's robust to compositor quirks that occasionally
 * pin opacity/transform on certain block-level elements in some
 * embedded preview environments.
 *
 * If reverting: delete this file + remove the <script> tag from every
 * HTML page + delete css/transitions.css + remove its <link>.
 */
(function () {
  'use strict';

  if (matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var REVEAL_TARGETS = [
    '.section',
    '.hero',
    '.pb-band',
    '.pb-card',
    '.pre-foot',
    '.crumb',
    '.changes-grid',
    '.changes',
    '.alerts',
    '.quick',
    '.empty-state',
    '.fund-detail-main > *',
    '.overlap-main > *',
    '.portfolio-grid-v2',
    '.score-card',
    '.kpi-strip',
    '.meta-strip',
    '.profile-card',
    '.archive-grid',
    '.compare-tabs',
    '.matrix-grid',
    '.shell-band',
    '.shell-body'
  ].join(', ');

  var STAGGER_MS = 60;
  var STAGGER_CAP = 8;
  var seen = new WeakSet();

  function applyReveal(scope) {
    var root = scope || document;
    var nodes = root.querySelectorAll(REVEAL_TARGETS);
    if (!nodes.length) return;
    var localIndex = 0;
    nodes.forEach(function (n) {
      if (seen.has(n)) return;
      seen.add(n);
      var delay = Math.min(localIndex, STAGGER_CAP) * STAGGER_MS;
      n.style.animationDelay = delay + 'ms';
      n.classList.add('cx-reveal');
      localIndex += 1;
    });
  }

  /* Public refresh hook — pages that inject sections after bootstrap
     (e.g. fund-detail's lazy-loaded blocks) can call this to opt new
     nodes into the same animation. */
  window.cxRevealRefresh = function (scope) {
    applyReveal(scope || document);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { applyReveal(); });
  } else {
    applyReveal();
  }

  /* Safety net: re-scan once after a delay so async-rendered content
     gets revealed even if the page never calls cxRevealRefresh. */
  setTimeout(function () { applyReveal(); }, 700);
  setTimeout(function () { applyReveal(); }, 1800);
})();
